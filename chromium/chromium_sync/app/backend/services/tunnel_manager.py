import os
import sqlite3
import asyncio
from typing import Dict, Optional
from sshtunnel import SSHTunnelForwarder
from config import DB_PATH, KEYS_DIR, logger
from services.cdp_engine import probe_node_cookies

class TunnelManager:
    def __init__(self):
        self.tunnels: Dict[int, SSHTunnelForwarder] = {}

    async def start_tunnel(self, node: dict):
        node_id = node['id']
        self.stop_tunnel(node_id)

        # 直连节点
        if node.get('is_local') == 1:
            direct_host = node.get('direct_host') or '127.0.0.1'
            try:
                count, msg = await probe_node_cookies(node['local_bind_port'], direct_host)
                if msg == "OK":
                    self._update_node_status(node_id, "connected", count)
                    return True, f"直连成功 ({direct_host}:{node['local_bind_port']})，捕获到 {count} 条 Cookies"
                else:
                    self._update_node_status(node_id, "error: refused", 0)
                    return False, f"CDP 未响应 ({direct_host}:{node['local_bind_port']}): {msg}"
            except Exception as e:
                self._update_node_status(node_id, "error: offline", 0)
                return False, f"连接异常: {e}"

        # 远程 SSH 节点
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
            count, _ = await probe_node_cookies(node['local_bind_port'], "127.0.0.1")
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

async def tunnel_watchdog_loop():
    logger.info("启动守护看门狗：维持直连与 SSH 隧道在线...")
    while True:
        try:
            conn = sqlite3.connect(DB_PATH)
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()
            cur.execute("SELECT * FROM nodes")
            nodes = [dict(r) for r in cur.fetchall()]
            conn.close()

            for node in nodes:
                if node.get('auto_tunnel', 1) == 1:
                    is_running = False
                    if node['is_local'] == 1:
                        target_h = node.get('direct_host') or '127.0.0.1'
                        c, msg = await probe_node_cookies(node['local_bind_port'], target_h)
                        is_running = (msg == "OK")
                    else:
                        is_running = (node['id'] in tunnel_mgr.tunnels and tunnel_mgr.tunnels[node['id']].is_active)

                    if not is_running:
                        await tunnel_mgr.start_tunnel(node)
        except Exception as e:
            logger.debug(f"看门狗巡检异常: {e}")
        await asyncio.sleep(30)