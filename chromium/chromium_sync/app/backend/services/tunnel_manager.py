import os
import json
import time
import sqlite3
import asyncio
import secrets
from typing import Dict, Optional, Set
from sshtunnel import SSHTunnelForwarder

from config import KEYS_DIR, logger
from core.database import get_db_connection, get_setting

# 缓存待审节点的首次发现时间戳与已告警记录，避免短时间内重复轰炸
_PENDING_FIRST_SEEN: Dict[str, float] = {}
_NOTIFIED_PENDING_NODES: Set[str] = set()

class ReverseTunnelSession:
    """
    生产级 NAT4 反向长连接会话管理器：
    1. 独占 WebSocket 读取，杜绝并发 receive_text 竞态报错
    2. 基于 req_id 挂载 Future，支持并发 CDP 指令分发
    3. 支持心跳自动回包，支持下发审批通过广播
    """
    def __init__(self, node_id: int, ws):
        self.node_id = node_id
        self.ws = ws
        self.pending_requests: Dict[int, asyncio.Future] = {}
        self.is_closed = False
        self._write_lock = asyncio.Lock()

    async def send_command(self, action: str, payload: dict = None, timeout: float = 10.0) -> dict:
        if self.is_closed:
            raise ConnectionError(f"节点 ID:{self.node_id} 反向隧道会话已断开")

        loop = asyncio.get_running_loop()
        req_id = secrets.randbelow(900000) + 100000
        future = loop.create_future()
        self.pending_requests[req_id] = future

        msg = {
            "req_id": req_id,
            "action": action,
            "payload": payload or {}
        }

        try:
            async with self._write_lock:
                await self.ws.send_text(json.dumps(msg))
            return await asyncio.wait_for(future, timeout=timeout)
        finally:
            self.pending_requests.pop(req_id, None)

    async def send_raw_json(self, data: dict):
        """向边缘节点推送非应答类通知 (如审批通过)"""
        if not self.is_closed:
            async with self._write_lock:
                await self.ws.send_text(json.dumps(data))

    def handle_incoming_text(self, text: str):
        """接收下行数据并派发给对应挂起的 Future"""
        try:
            data = json.loads(text)
            req_id = data.get("req_id")
            if req_id is not None and req_id in self.pending_requests:
                fut = self.pending_requests[req_id]
                if not fut.done():
                    fut.set_result(data)
        except Exception:
            pass

    def close(self):
        self.is_closed = True
        for fut in list(self.pending_requests.values()):
            if not fut.done():
                fut.set_exception(ConnectionResetError("反向长连接已断开"))
        self.pending_requests.clear()

class TunnelManager:
    def __init__(self):
        self.tunnels: Dict[int, SSHTunnelForwarder] = {}
        self.reverse_sessions: Dict[int, ReverseTunnelSession] = {}

    def register_reverse_tunnel(self, node_id: int, ws_client) -> ReverseTunnelSession:
        if node_id in self.reverse_sessions:
            self.reverse_sessions[node_id].close()
        session = ReverseTunnelSession(node_id, ws_client)
        self.reverse_sessions[node_id] = session
        logger.info(f"🔌 节点 ID:{node_id} 反向穿透隧道已接入安全连接池")
        return session

    def unregister_reverse_tunnel(self, node_id: int):
        if node_id in self.reverse_sessions:
            self.reverse_sessions[node_id].close()
            del self.reverse_sessions[node_id]
            logger.info(f"🔌 节点 ID:{node_id} 反向穿透隧道已移出安全连接池")

    def get_reverse_session(self, node_id: int) -> Optional[ReverseTunnelSession]:
        return self.reverse_sessions.get(node_id)

    async def start_tunnel(self, node: dict):
        from services.cdp_engine import probe_node_cookies
        node_id = node['id']
        self.stop_tunnel(node_id)

        # 1. 反向隧道节点
        if node.get('conn_type') == 'reverse':
            session = self.get_reverse_session(node_id)
            if session and not session.is_closed:
                count, msg = await probe_node_cookies(node['local_bind_port'], node_id=node_id)
                self._update_node_status(node_id, "connected" if msg == "OK" else "error: refused", count if msg == "OK" else 0)
                return True, f"反向隧道在线，探测到 {count} 条 Cookies"
            else:
                self._update_node_status(node_id, "stopped", 0)
                return False, "反向隧道未接入 (等待边缘容器启动连入)"

        # 2. 本地直连节点
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

        # 3. 远程 SSH 隧道
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
        conn = get_db_connection()
        cur = conn.cursor()
        if cookie_count is not None:
            cur.execute("UPDATE nodes SET status=?, cookie_count=? WHERE id=?", (status, cookie_count, node_id))
        else:
            cur.execute("UPDATE nodes SET status=? WHERE id=?", (status, node_id))
        conn.commit()
        conn.close()

tunnel_mgr = TunnelManager()
REVERSE_TUNNEL_POOL = tunnel_mgr.reverse_sessions

async def tunnel_watchdog_loop():
    """
    全量后台守护看门狗：
    1. TOFU 待审批挂起超时自动预警 (支持邮件与微信 Server酱推送)
    2. 直连、SSH 隧道与反向长连接健康探活
    """
    from services.cdp_engine import probe_node_cookies
    from services.notification import dispatch_notification

    logger.info("启动守护看门狗：巡检节点链路状态与待审批超时预警 (周期: 30秒)...")
    while True:
        try:
            conn = get_db_connection()
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()

            # ==================== 1. TOFU 待审批挂起超时预警闭环 ====================
            timeout_setting = get_setting('tofu_timeout_notify_minutes', '10')
            try:
                alert_timeout_mins = int(timeout_setting)
            except ValueError:
                alert_timeout_mins = 10

            now_ts = time.time()
            cur.execute("SELECT * FROM nodes WHERE approval_status=0")
            pending_nodes = [dict(r) for r in cur.fetchall()]

            current_pending_uuids = set()
            for p_node in pending_nodes:
                uuid_key = p_node.get("node_uuid") or str(p_node["id"])
                current_pending_uuids.add(uuid_key)

                # 记录首次发现挂起时间
                if uuid_key not in _PENDING_FIRST_SEEN:
                    _PENDING_FIRST_SEEN[uuid_key] = now_ts

                elapsed_seconds = now_ts - _PENDING_FIRST_SEEN[uuid_key]
                threshold_seconds = alert_timeout_mins * 60

                # 达到超时设定且尚未通知过，触发分发
                if alert_timeout_mins > 0 and elapsed_seconds >= threshold_seconds:
                    if uuid_key not in _NOTIFIED_PENDING_NODES:
                        _NOTIFIED_PENDING_NODES.add(uuid_key)
                        alert_title = f"待审批预警: 边缘节点 [{p_node['name']}] 等待认领超时"
                        alert_body = (
                            f"【CDP 集群安全提醒】\n"
                            f"检测到边缘新节点接入已处于 TOFU 隔离等待状态超过 {alert_timeout_mins} 分钟无人处理！\n\n"
                            f"• 节点名称: {p_node['name']}\n"
                            f"• 节点标识: {p_node.get('node_uuid', '---')}\n"
                            f"• 网络模式: {p_node.get('conn_type', 'reverse')}\n"
                            f"• 当前状态: 仅维持心跳隔离，业务未放行\n\n"
                            f"请尽快登录 CDP 集群管理后台进行「批准入网」或「拒绝清理」。"
                        )
                        asyncio.create_task(dispatch_notification(alert_title, alert_body))
                        logger.warning(f"⚠️ [待审批超时告警] 节点 [{p_node['name']}] 已挂起超过 {alert_timeout_mins} 分钟，已触发推送。")

            # 清除已脱离待审状态 (已审批/已删除) 的节点缓存
            for old_uuid in list(_PENDING_FIRST_SEEN.keys()):
                if old_uuid not in current_pending_uuids:
                    _PENDING_FIRST_SEEN.pop(old_uuid, None)
                    _NOTIFIED_PENDING_NODES.discard(old_uuid)

            # ==================== 2. 已认证节点链路在线巡检 ====================
            cur.execute("SELECT * FROM nodes WHERE enabled=1 AND approval_status=1")
            nodes = [dict(r) for r in cur.fetchall()]
            conn.close()

            for node in nodes:
                node_id = node['id']
                conn_type = node.get('conn_type', 'direct')

                if conn_type == 'reverse':
                    session = tunnel_mgr.get_reverse_session(node_id)
                    if session and not session.is_closed:
                        count, msg = await probe_node_cookies(node['local_bind_port'], node_id=node_id)
                        new_status = "connected" if msg == "OK" else "error: refused"
                        tunnel_mgr._update_node_status(node_id, new_status, count if msg == "OK" else 0)
                    else:
                        tunnel_mgr._update_node_status(node_id, "stopped", 0)

                elif node.get('is_local') == 1:
                    target_h = node.get('direct_host') or '127.0.0.1'
                    count, msg = await probe_node_cookies(node['local_bind_port'], target_host=target_h)
                    new_status = "connected" if msg == "OK" else "error: refused"
                    tunnel_mgr._update_node_status(node_id, new_status, count if msg == "OK" else 0)

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