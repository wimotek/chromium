import asyncio
import json
import os
import secrets
import ssl
import time
from typing import Any, Dict, Optional, Set, Tuple
import websockets

from config import (
    HAS_WIMOTEK_TUNNEL,
    KEYS_DIR,
    SshTunnelSession,
    TunnelConfig,
    TunnelException,
    logger,
)
from core.db import get_setting, session_scope
from core.models import Node
from services.traffic_service import record_cdp_traffic, record_node_nic_metrics

# 缓存待审节点的首次发现时间戳与已告警记录，避免短时间内重复轰炸
_PENDING_FIRST_SEEN: Dict[str, float] = {}
_NOTIFIED_PENDING_NODES: Set[str] = set()


class _OutboundWsAdapter:
    """将 websockets 客户端连接适配为与 FastAPI WebSocket 一致的 send_text/close 接口"""

    def __init__(self, ws):
        self._ws = ws

    async def send_text(self, data: str):
        await self._ws.send(data)

    async def close(self):
        await self._ws.close()


def _format_wss_url(
    endpoint: Optional[str],
    fallback_host: Optional[str] = None,
    fallback_port: int = 9443,
) -> Optional[str]:
    ep = (endpoint or "").strip()
    if not ep:
        host = (fallback_host or "").strip().strip("[]")
        if not host or host in {"reverse-nat4", "public-wss", "wss-direct"}:
            return None
        ep = f"[{host}]:{fallback_port}" if ":" in host else f"{host}:{fallback_port}"

    if ep.startswith("wss://") or ep.startswith("ws://"):
        base = ep.rstrip("/")
        return base if base.endswith("/ws") else f"{base}/ws"

    if ep.startswith("[") and "]:" in ep:
        netloc = ep
    elif ep.count(":") > 1:
        netloc = f"[{ep.strip('[]')}]:{fallback_port}"
    elif ":" in ep:
        netloc = ep
    else:
        netloc = f"{ep}:{fallback_port}"
    return f"wss://{netloc}/ws"


class ReverseTunnelSession:
    """
    生产级 NAT4 / WSS 长连接会话管理器（同时承载入站反向穿透与出站公网 WSS 直连）：
    1. 独占 WebSocket 读取，杜绝并发 receive_text 竞态报错
    2. 基于 req_id 挂载 Future，支持并发 CDP 指令分发
    3. 支持心跳自动回包、下发审批通过广播、CDP WS 流量计量与边缘节点 NIC 上报消费
    """

    def __init__(self, node_id: int, ws):
        self.node_id = node_id
        self.ws = ws
        self.pending_requests: Dict[int, asyncio.Future] = {}
        self.cdp_ws_streams: Dict[str, Any] = {}
        self.cdp_ws_channels: Dict[str, str] = {}
        self.is_closed = False
        self._write_lock = asyncio.Lock()

    async def send_command(self, action: str, payload: dict = None, timeout: float = 10.0) -> dict:
        if self.is_closed:
            raise ConnectionError(f"节点 ID:{self.node_id} WSS 隧道会话已断开")

        loop = asyncio.get_running_loop()
        req_id = secrets.randbelow(900000) + 100000
        future = loop.create_future()
        self.pending_requests[req_id] = future

        msg = {
            "req_id": req_id,
            "action": action,
            "payload": payload or {},
        }

        try:
            async with self._write_lock:
                await self.ws.send_text(json.dumps(msg))
            return await asyncio.wait_for(future, timeout=timeout)
        finally:
            self.pending_requests.pop(req_id, None)

    async def send_raw_json(self, data: dict):
        """向边缘节点推送非应答类通知 (如审批通过 / CDP WS 帧)"""
        if not self.is_closed:
            async with self._write_lock:
                await self.ws.send_text(json.dumps(data))

    def handle_incoming_text(self, text: str):
        """接收下行数据并派发给对应挂起的 Future、CDP WebSocket 中继流或流量计量处理器"""
        try:
            data = json.loads(text)
            msg_type = data.get("type")
            if msg_type == "cdp_ws_frame":
                sid = data.get("stream_id")
                payload_text = data.get("data", "")
                channel = self.cdp_ws_channels.get(sid, "reverse")
                if payload_text:
                    record_cdp_traffic(
                        self.node_id,
                        channel_type=channel,
                        tx_bytes=len(str(payload_text).encode("utf-8")),
                    )
                client_ws = self.cdp_ws_streams.get(sid)
                if client_ws is not None:
                    asyncio.create_task(client_ws.send_text(payload_text))
                return
            if msg_type in {"cdp_ws_close", "cdp_ws_error"}:
                sid = data.get("stream_id")
                self.cdp_ws_channels.pop(sid, None)
                client_ws = self.cdp_ws_streams.pop(sid, None)
                if client_ws is not None:
                    asyncio.create_task(client_ws.close())
                return
            if msg_type == "metrics_report":
                record_node_nic_metrics(
                    self.node_id,
                    net_rx_delta=data.get("net_rx_delta", 0),
                    net_tx_delta=data.get("net_tx_delta", 0),
                    cdp_rx_delta=data.get("cdp_rx_delta", 0),
                    cdp_tx_delta=data.get("cdp_tx_delta", 0),
                    active_streams=data.get("active_streams"),
                )
                return
            if msg_type in {"bookmark_upsert", "bookmark_delete", "bookmarks_merge", "bookmarks_pull"} or data.get("action") == "pull_bookmarks":
                from services.bookmark_service import handle_client_bookmark_event

                asyncio.create_task(handle_client_bookmark_event(self.node_id, f"node-{self.node_id}", data))
                return

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
                fut.set_exception(ConnectionResetError("WSS 长连接已断开"))
        self.pending_requests.clear()
        for client_ws in list(self.cdp_ws_streams.values()):
            try:
                asyncio.create_task(client_ws.close())
            except Exception:
                pass
        self.cdp_ws_streams.clear()
        self.cdp_ws_channels.clear()


class TunnelManager:
    """
    CDP 集群统一隧道调度中心：
    - 模式 4 (SSH 穿透): 委托由专用的通用商业模块 wimotek-ssh-tunnel 管理
    - 模式 3 (NAT4 反穿 / 公网 WSS 直连): 统一由内置 ReverseTunnelSession 长连接池承载
    """

    def __init__(self):
        self.tunnels: Dict[int, Any] = {}
        self.reverse_sessions: Dict[int, ReverseTunnelSession] = {}
        self.public_wss_tasks: Dict[int, asyncio.Task] = {}
        self.public_wss_targets: Dict[int, Tuple[str, str]] = {}

    def register_reverse_tunnel(self, node_id: int, ws_client) -> ReverseTunnelSession:
        if node_id in self.reverse_sessions:
            self.reverse_sessions[node_id].close()
        session = ReverseTunnelSession(node_id, ws_client)
        self.reverse_sessions[node_id] = session
        logger.info(f"🔌 节点 ID:{node_id} WSS 长连接通道已接入安全连接池")
        return session

    def unregister_reverse_tunnel(self, node_id: int, expected_session: Optional[ReverseTunnelSession] = None):
        cur_session = self.reverse_sessions.get(node_id)
        if cur_session is None:
            return
        if expected_session is not None and cur_session is not expected_session:
            return
        cur_session.close()
        del self.reverse_sessions[node_id]
        logger.info(f"🔌 节点 ID:{node_id} WSS 长连接通道已移出安全连接池")

    def get_reverse_session(self, node_id: int) -> Optional[ReverseTunnelSession]:
        return self.reverse_sessions.get(node_id)

    def stop_public_wss_session(self, node_id: int):
        task = self.public_wss_tasks.pop(node_id, None)
        self.public_wss_targets.pop(node_id, None)
        if task and not task.done():
            task.cancel()
        if node_id in self.reverse_sessions:
            self.unregister_reverse_tunnel(node_id)

    def ensure_public_wss_session(self, node: dict):
        """确保对公网 WSS 直连节点存在 Hub -> 节点的加密长连接客户端任务"""
        node_id = node["id"]
        if node.get("enabled", 1) == 0 or node.get("approval_status", 1) == 0:
            self.stop_public_wss_session(node_id)
            return

        endpoint = node.get("wss_endpoint") or node.get("recommended_endpoint")
        wss_url = _format_wss_url(endpoint, fallback_host=node.get("direct_host"), fallback_port=9443)
        if not wss_url:
            logger.warning(f"⚠️ 节点 ID:{node_id} 缺少有效的 wss_endpoint，无法发起公网 WSS 直连")
            return

        edge_secret = (node.get("edge_wss_secret") or "").strip()
        target_sig = (wss_url, edge_secret)
        existing_task = self.public_wss_tasks.get(node_id)
        if existing_task and not existing_task.done() and self.public_wss_targets.get(node_id) == target_sig:
            return

        if existing_task and not existing_task.done():
            existing_task.cancel()

        self.public_wss_targets[node_id] = target_sig
        self.public_wss_tasks[node_id] = asyncio.create_task(
            self._public_wss_client_loop(node_id, wss_url, edge_secret)
        )

    async def _public_wss_client_loop(self, node_id: int, wss_url: str, edge_secret: str):
        from services.cdp_engine import probe_node_cookies

        ssl_ctx = ssl.create_default_context()
        ssl_ctx.check_hostname = False
        ssl_ctx.verify_mode = ssl.CERT_NONE

        headers: Dict[str, str] = {}
        if edge_secret:
            headers["X-Edge-Auth"] = edge_secret

        common_kwargs = {
            "ssl": ssl_ctx if wss_url.startswith("wss://") else None,
            "max_size": 100 * 1024 * 1024,
            "ping_interval": 20,
            "ping_timeout": 10,
            "open_timeout": 8,
        }

        backoff = 2
        try:
            while True:
                with session_scope() as db:
                    row_obj = db.get(Node, node_id)
                    row = row_obj.to_dict() if row_obj else None

                if (
                    not row
                    or row["enabled"] == 0
                    or row["approval_status"] == 0
                    or row["conn_type"] not in ("public_wss", "wss_direct")
                ):
                    break

                ws = None
                session = None
                try:
                    try:
                        ws = await websockets.connect(wss_url, additional_headers=headers, **common_kwargs)
                    except TypeError:
                        ws = await websockets.connect(wss_url, extra_headers=headers, **common_kwargs)

                    adapter = _OutboundWsAdapter(ws)
                    session = self.register_reverse_tunnel(node_id, adapter)
                    backoff = 2
                    self._update_node_status(node_id, "connected")
                    logger.info(f"🛡️ [Public-WSS] Hub 已主动连入节点 ID:{node_id} ({wss_url})")

                    async def _refresh_probe(nid: int):
                        try:
                            await asyncio.sleep(0.6)
                            cnt, msg = await probe_node_cookies(9222, target_host="public-wss", node_id=nid)
                            if msg == "OK":
                                self._update_node_status(nid, "connected", cnt)
                        except Exception:
                            pass

                    asyncio.create_task(_refresh_probe(node_id))
                    from services.bookmark_service import push_bookmarks_to_session

                    asyncio.create_task(push_bookmarks_to_session(session))

                    while True:
                        try:
                            raw = await asyncio.wait_for(ws.recv(), timeout=15.0)
                        except asyncio.TimeoutError:
                            await session.send_raw_json({"action": "ping"})
                            continue

                        if isinstance(raw, bytes):
                            raw = raw.decode("utf-8", errors="replace")
                        if raw in ("ping", "pong"):
                            continue
                        try:
                            parsed = json.loads(raw)
                            if isinstance(parsed, dict) and parsed.get("type") == "pong":
                                continue
                        except Exception:
                            pass
                        session.handle_incoming_text(raw)

                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    logger.warning(f"⚠️ [Public-WSS] 节点 ID:{node_id} 直连中断 ({type(e).__name__}: {e})，{backoff}s 后重连")
                    if self.reverse_sessions.get(node_id) in (None, session):
                        with session_scope() as db:
                            n = db.get(Node, node_id)
                            if n is not None and (n.enabled if n.enabled is not None else 1) == 1:
                                n.status = "stopped"
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 30)
                finally:
                    if session is not None:
                        self.unregister_reverse_tunnel(node_id, expected_session=session)
                    if ws is not None:
                        try:
                            await ws.close()
                        except Exception:
                            pass
        except asyncio.CancelledError:
            pass

    async def start_tunnel(self, node: dict):
        from services.cdp_engine import probe_node_cookies

        node_id = node["id"]
        conn_type = node.get("conn_type")

        # 1. 公网 WSS 直连节点
        if conn_type in ("public_wss", "wss_direct"):
            self.stop_tunnel(node_id)
            self.ensure_public_wss_session(node)
            for _ in range(12):
                session = self.get_reverse_session(node_id)
                if session and not session.is_closed:
                    count, msg = await probe_node_cookies(node["local_bind_port"], target_host="public-wss", node_id=node_id)
                    self._update_node_status(node_id, "connected" if msg == "OK" else "error: refused", count if msg == "OK" else 0)
                    return True, f"公网 WSS 直连在线，探测到 {count} 条 Cookies"
                await asyncio.sleep(0.25)
            return False, "正在向节点发起公网 WSS 直连 (等待边缘 WSS 端口就绪)"

        self.stop_tunnel(node_id)

        # 2. NAT4 反向长连节点
        if conn_type == "reverse":
            session = self.get_reverse_session(node_id)
            if session and not session.is_closed:
                count, msg = await probe_node_cookies(node["local_bind_port"], target_host="reverse-nat4", node_id=node_id)
                self._update_node_status(node_id, "connected" if msg == "OK" else "error: refused", count if msg == "OK" else 0)
                return True, f"反向长连接在线，探测到 {count} 条 Cookies"
            else:
                self._update_node_status(node_id, "stopped", 0)
                return False, "反向隧道未接入 (等待边缘容器启动连入)"

        # 3. 本地 / 局域网直连节点
        if node.get("is_local") == 1:
            direct_host = node.get("direct_host") or "127.0.0.1"
            try:
                count, msg = await probe_node_cookies(node["local_bind_port"], target_host=direct_host)
                if msg == "OK":
                    self._update_node_status(node_id, "connected", count)
                    return True, f"直连成功 ({direct_host}:{node['local_bind_port']})，捕获到 {count} 条 Cookies"
                else:
                    self._update_node_status(node_id, "error: refused", 0)
                    return False, f"CDP 未响应 ({direct_host}:{node['local_bind_port']}): {msg}"
            except Exception as e:
                self._update_node_status(node_id, "error: offline", 0)
                return False, f"连接异常: {e}"

        # 4. 远程 SSH 节点
        ssh_key_param = None
        if node.get("ssh_key_filename"):
            key_path = os.path.join(KEYS_DIR, node["ssh_key_filename"])
            if os.path.exists(key_path):
                ssh_key_param = key_path

        if HAS_WIMOTEK_TUNNEL and SshTunnelSession is not None:
            try:
                cfg = TunnelConfig(
                    id=f"node-{node_id}",
                    name=node.get("name") or f"Node-{node_id}",
                    ssh_host=node["ssh_host"],
                    ssh_port=int(node.get("ssh_port") or 22),
                    ssh_user=node.get("ssh_user") or "root",
                    remote_host="127.0.0.1",
                    remote_port=int(node.get("remote_cdp_port") or 9222),
                    local_port=int(node["local_bind_port"]),
                    ssh_key=ssh_key_param,
                    ssh_password=node.get("ssh_password") or None,
                    timeout_sec=6.0,
                )
                session = SshTunnelSession(cfg)
                bound_port = session.start()
                self.tunnels[node_id] = session
                self._update_node_status(node_id, "connected")
                logger.info(f"[+] 节点 [{node['name']}] SSH 隧道建立成功 (wimotek-ssh-tunnel) -> 监听端口 {bound_port}")

                await asyncio.sleep(0.8)
                count, _ = await probe_node_cookies(bound_port, target_host="127.0.0.1")
                self._update_node_status(node_id, "connected", count)
                return True, f"SSH 穿透成功，探测到 {count} 条 Cookies"
            except TunnelException as te:
                err_msg = f"{te.code}: {te.message}"
                self._update_node_status(node_id, f"error: {str(te.code)[:15]}")
                logger.warning(f"⚠️ [SKIP] 节点 [{node['name']}] SSH 穿透失败: {err_msg}")
                return False, err_msg
            except Exception as e:
                self._update_node_status(node_id, f"error: {str(e)[:25]}")
                return False, str(e)
        else:
            from sshtunnel import SSHTunnelForwarder

            ssh_kwargs = {
                "ssh_address_or_host": (node["ssh_host"], int(node.get("ssh_port") or 22)),
                "ssh_username": node.get("ssh_user") or "root",
                "remote_bind_address": ("127.0.0.1", int(node.get("remote_cdp_port") or 9222)),
                "local_bind_address": ("127.0.0.1", int(node["local_bind_port"])),
                "set_keepalive": 30.0,
            }
            if ssh_key_param:
                ssh_kwargs["ssh_pkey"] = ssh_key_param
            elif node.get("ssh_password"):
                ssh_kwargs["ssh_password"] = node["ssh_password"]

            try:
                tunnel = SSHTunnelForwarder(**ssh_kwargs)
                tunnel.start()
                self.tunnels[node_id] = tunnel
                self._update_node_status(node_id, "connected")
                await asyncio.sleep(1.0)
                count, _ = await probe_node_cookies(node["local_bind_port"], target_host="127.0.0.1")
                self._update_node_status(node_id, "connected", count)
                return True, f"穿透成功，探测到 {count} 条 Cookies"
            except Exception as e:
                self._update_node_status(node_id, f"error: {str(e)[:25]}")
                return False, str(e)

    def stop_tunnel(self, node_id: int):
        if node_id in self.tunnels:
            try:
                t = self.tunnels[node_id]
                if hasattr(t, "stop"):
                    try:
                        t.stop(force=True)
                    except TypeError:
                        t.stop()
            except Exception:
                pass
            del self.tunnels[node_id]
        if node_id in self.public_wss_tasks or node_id in self.public_wss_targets:
            self.stop_public_wss_session(node_id)
        self._update_node_status(node_id, "stopped")

    def _update_node_status(self, node_id: int, status: str, cookie_count: Optional[int] = None):
        with session_scope() as db:
            node = db.get(Node, node_id)
            if node is not None:
                node.status = status
                if cookie_count is not None:
                    node.cookie_count = cookie_count


tunnel_mgr = TunnelManager()
REVERSE_TUNNEL_POOL = tunnel_mgr.reverse_sessions


async def tunnel_watchdog_loop():
    """
    全量后台守护看门狗：
    1. TOFU 待审批挂起超时自动预警 (邮件与微信 Server酱推送)
    2. 直连、SSH 隧道、公网 WSS 直连与反向长连接健康巡检探活
    """
    from services.cdp_engine import probe_node_cookies
    from services.notification import dispatch_notification

    logger.info("启动守护看门狗：巡检节点链路状态与待审批超时预警 (周期: 30秒)...")
    while True:
        try:
            timeout_setting = get_setting("tofu_timeout_notify_minutes", "10")
            try:
                alert_timeout_mins = int(timeout_setting)
            except ValueError:
                alert_timeout_mins = 10

            now_ts = time.time()
            with session_scope() as db:
                pending_nodes = [n.to_dict() for n in db.query(Node).filter(Node.approval_status == 0).all()]
                nodes = [
                    n.to_dict()
                    for n in db.query(Node).filter(Node.enabled == 1, Node.approval_status == 1).all()
                ]

            current_pending_uuids = set()
            for p_node in pending_nodes:
                uuid_key = p_node.get("node_uuid") or str(p_node["id"])
                current_pending_uuids.add(uuid_key)

                if uuid_key not in _PENDING_FIRST_SEEN:
                    _PENDING_FIRST_SEEN[uuid_key] = now_ts

                elapsed_seconds = now_ts - _PENDING_FIRST_SEEN[uuid_key]
                threshold_seconds = alert_timeout_mins * 60

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

            for old_uuid in list(_PENDING_FIRST_SEEN.keys()):
                if old_uuid not in current_pending_uuids:
                    _PENDING_FIRST_SEEN.pop(old_uuid, None)
                    _NOTIFIED_PENDING_NODES.discard(old_uuid)

            for node in nodes:
                node_id = node["id"]
                conn_type = node.get("conn_type", "direct")

                if conn_type in ("public_wss", "wss_direct"):
                    session = tunnel_mgr.get_reverse_session(node_id)
                    if session and not session.is_closed:
                        count, msg = await probe_node_cookies(node["local_bind_port"], target_host="public-wss", node_id=node_id)
                        new_status = "connected" if msg == "OK" else "error: refused"
                        tunnel_mgr._update_node_status(node_id, new_status, count if msg == "OK" else 0)
                    else:
                        tunnel_mgr.ensure_public_wss_session(node)
                        tunnel_mgr._update_node_status(node_id, "stopped", 0)

                elif conn_type == "reverse":
                    session = tunnel_mgr.get_reverse_session(node_id)
                    if session and not session.is_closed:
                        count, msg = await probe_node_cookies(node["local_bind_port"], target_host="reverse-nat4", node_id=node_id)
                        new_status = "connected" if msg == "OK" else "error: refused"
                        tunnel_mgr._update_node_status(node_id, new_status, count if msg == "OK" else 0)
                    else:
                        tunnel_mgr._update_node_status(node_id, "stopped", 0)

                elif node.get("is_local") == 1:
                    target_h = node.get("direct_host") or "127.0.0.1"
                    count, msg = await probe_node_cookies(node["local_bind_port"], target_host=target_h)
                    new_status = "connected" if msg == "OK" else "error: refused"
                    tunnel_mgr._update_node_status(node_id, new_status, count if msg == "OK" else 0)

                else:
                    is_active = False
                    if node_id in tunnel_mgr.tunnels:
                        t = tunnel_mgr.tunnels[node_id]
                        if hasattr(t, "proc") and t.proc:
                            is_active = t.proc.poll() is None
                        elif hasattr(t, "is_active"):
                            is_active = t.is_active

                    if not is_active:
                        await tunnel_mgr.start_tunnel(node)
                    else:
                        count, msg = await probe_node_cookies(node["local_bind_port"], target_host="127.0.0.1")
                        new_status = "connected" if msg == "OK" else "error: refused"
                        tunnel_mgr._update_node_status(node_id, new_status, count if msg == "OK" else 0)
        except Exception as e:
            logger.debug(f"看门狗巡检异常: {e}")
        await asyncio.sleep(30)