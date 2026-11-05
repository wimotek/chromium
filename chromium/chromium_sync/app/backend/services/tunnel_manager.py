import os
import sqlite3
import asyncio
from typing import Dict, Optional
from sshtunnel import SSHTunnelForwarder
from config import DB_PATH, KEYS_DIR, logger

# ==================== NAT4 边缘反向长连接 WebSocket 隧道池 ====================
# 存放所有从内网/NAT4 内部主动连入管理端的 WebSocket 活跃连接
# 格式: { node_id: active_websocket }
REVERSE_TUNNEL_POOL: Dict[int, any] = {}

class TunnelManager:
    def __init__(self):
        self.tunnels: Dict[int, SSHTunnelForwarder] = {}

    def register_reverse_tunnel(self, node_id: int, ws_client):
        """登记一个来自 NAT4 内网的反向隧道长连接"""
        REVERSE_TUNNEL_POOL[node_id] = ws_client
        logger.info(f"🔌 节点 ID:{node_id} 反向穿透隧道已接入连接池")

    def unregister_reverse_tunnel(self, node_id: int):
        """注销反向隧道"""
        if node_id in REVERSE_TUNNEL_POOL:
            del REVERSE_TUNNEL_POOL[node_id]
            logger.info(f"🔌 节点 ID:{node_id} 反向穿透隧道已移出连接池")

    async def start_tunnel(self, node: dict):
        from services.cdp_engine import probe_node_cookies
        node_id = node['id']
        self.stop_tunnel(node_id)

        # 1. NAT4 反向长连接隧道节点
        if node.get('conn_type') == 'reverse':
            is_active = (node_id in REVERSE_TUNNEL_POOL)
            if is_active:
                count, msg = await probe_node_cookies(node['local_bind_port'], node_id=node_id)
                self._update_node_status(node_id, "connected" if msg == "OK" else "error: refused", count if msg == "OK" else 0)
                return True, f"反向隧道在线，探测到 {count} 条 Cookies"
            else:
                self._update_node_status(node_id, "stopped", 0)
                return False, "反向隧道未接入 (等待边缘容器启动连入)"

        # 2. 直连节点
        if node.get('is_local') == 1:
            direct_host = node.get('direct_host') or '127.0.0.1'
            try:
                count, msg = await probe_node_cookies(node['local_bind_port'], target_host=direct_host)
                if msg == "OK":
                    self._update_node_status(node_id, "connected", count)
                    return True, f"直连成功 ({direct_host}:{node['local_bind_port']})，捕获到 {count} 条 Cookies"
                else:
                    self._update_node_status(node_id, "error: refused", 0)
                    return False, f"CDP 未响应 ({direct_host}:{node['local_bind_port']}): {msg}"
            except Exception as e:
                self._update_node_status(node_id, "error: offline", 0)
                return False, f"连接异常: {e}"

        # 3. 远程 SSH 节点
        ssh_kwargs = {
            "ssh_address_or_host": (node['ssh_host'], int(node['ssh_port'])),
            "ssh_username": node['ssh_user'],
            "remote_bind_address": ('127.0.0.1', int(node['remote_cdp_port'])),
            "local_bind_address": ('0.0.0.0', int(node['local_bind_port'])),
            "set_keepalive": 30.0
        }

        if node.get('ssh_key_filename'):
            key_path = os.path.join(KEYS_DIR, node['ssh_key_filename'])
            if os.path.exists(key_path):
                ssh_kwargs["ssh_pkey"] = key_path
        elif node.get('ssh_password'):
            ssh_kwargs["ssh_password"] = node['ssh_password']

        try:
            tunnel = SSHTunnelForwarder(**ssh_kwargs)
            tunnel.start()
            self.tunnels[node_id] = tunnel
            self._update_node_status(node_id, "connected")
            logger.info(f"节点 [{node['name']}] SSH 隧道启动成功 -> 映射端口 {node['local_bind_port']}")

            await asyncio.sleep(1.0)
            count, _ = await probe_node_cookies(node['local_bind_port'], target_host="127.0.0.1")
            self._update_node_status(node_id, "connected", count)
            return True, f"穿透成功，探测到 {count} 条 Cookies"
        except Exception as e:
            self._update_node_status(node_id, f"error: {str(e)[:25]}")
            return False, str(e)

    def stop_tunnel(self, node_id: int):
        if node_id in self.tunnels:
            try:
                self.tunnels[node_id].stop()
            except Exception:
                pass
            del self.tunnels[node_id]
        self._update_node_status(node_id, "stopped")

    def _update_node_status(self, node_id: int, status: str, cookie_count: Optional[int] = None):
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()
        if cookie_count is not None:
            cur.execute("UPDATE nodes SET status=?, cookie_count=? WHERE id=?", (status, cookie_count, node_id))
        else:
            cur.execute("UPDATE nodes SET status=? WHERE id=?", (status, node_id))
        conn.commit()
        conn.close()

tunnel_mgr = TunnelManager()

# ==================== 看门狗：每 30 秒巡检探活 ====================
async def tunnel_watchdog_loop():
    from services.cdp_engine import probe_node_cookies
    logger.info("启动守护看门狗：维持直连、SSH 隧道与 NAT4 反向隧道在线 (周期: 30秒)...")
    while True:
        try:
            conn = sqlite3.connect(DB_PATH)
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()
            # 仅巡检已启用、已通过 TOFU 认领批准的节点
            cur.execute("SELECT * FROM nodes WHERE enabled=1 AND approval_status=1")
            nodes = [dict(r) for r in cur.fetchall()]
            conn.close()

            for node in nodes:
                node_id = node['id']
                conn_type = node.get('conn_type', 'direct')

                # 分支 A: NAT4 反向长连接隧道节点
                if conn_type == 'reverse':
                    if node_id in REVERSE_TUNNEL_POOL:
                        count, msg = await probe_node_cookies(node['local_bind_port'], node_id=node_id)
                        new_status = "connected" if msg == "OK" else "error: refused"
                        tunnel_mgr._update_node_status(node_id, new_status, count if msg == "OK" else 0)
                    else:
                        tunnel_mgr._update_node_status(node_id, "stopped", 0)

                # 分支 B: 免 SSH 直连节点
                elif node.get('is_local') == 1:
                    target_h = node.get('direct_host') or '127.0.0.1'
                    count, msg = await probe_node_cookies(node['local_bind_port'], target_host=target_h)
                    new_status = "connected" if msg == "OK" else "error: refused"
                    tunnel_mgr._update_node_status(node_id, new_status, count if msg == "OK" else 0)

                # 分支 C: 远程 SSH 节点
                else:
                    is_active = (node_id in tunnel_mgr.tunnels and tunnel_mgr.tunnels[node_id].is_active)
                    if not is_active:
                        await tunnel_mgr.start_tunnel(node)
                    else:
                        count, msg = await probe_node_cookies(node['local_bind_port'], target_host="127.0.0.1")
                        new_status = "connected" if msg == "OK" else "error: refused"
                        tunnel_mgr._update_node_status(node_id, new_status, count if msg == "OK" else 0)
        except Exception as e:
            logger.debug(f"看门狗巡检异常: {e}")
        await asyncio.sleep(30)