import asyncio
import json
import secrets
import ssl
from typing import Any, Dict, Optional, Tuple
import websockets

from config import logger
from core.db import session_scope
from core.models import Node
from modules.nodes.traffic_service import record_cdp_traffic, record_node_nic_metrics


class _OutboundWsAdapter:
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
    """支持租户/租约流量隔离及欠费强制切断的 WSS 多路复用会话"""

    def __init__(self, node_id: int, ws, owner_id: int = 1):
        self.node_id = node_id
        self.owner_id = owner_id
        self.ws = ws
        self.pending_requests: Dict[int, asyncio.Future] = {}
        self.cdp_ws_streams: Dict[str, Any] = {}
        self.cdp_ws_channels: Dict[str, str] = {}
        self.cdp_ws_leases: Dict[str, int] = {}
        self.cdp_ws_actors: Dict[str, int] = {}
        self.is_closed = False
        self._write_lock = asyncio.Lock()

    async def send_command(self, action: str, payload: dict = None, timeout: float = 10.0) -> dict:
        if self.is_closed:
            raise ConnectionError(f"节点 ID:{self.node_id} WSS 隧道会话已断开")

        loop = asyncio.get_running_loop()
        req_id = secrets.randbelow(900000) + 100000
        future = loop.create_future()
        self.pending_requests[req_id] = future

        msg = {"req_id": req_id, "action": action, "payload": payload or {}}
        try:
            async with self._write_lock:
                await self.ws.send_text(json.dumps(msg))
            return await asyncio.wait_for(future, timeout=timeout)
        finally:
            self.pending_requests.pop(req_id, None)

    async def send_raw_json(self, data: dict):
        if not self.is_closed:
            async with self._write_lock:
                await self.ws.send_text(json.dumps(data))

    async def close_lease_streams(self, lease_id: int):
        target_sids = [sid for sid, lid in list(self.cdp_ws_leases.items()) if lid == int(lease_id)]
        for sid in target_sids:
            self.cdp_ws_channels.pop(sid, None)
            self.cdp_ws_leases.pop(sid, None)
            self.cdp_ws_actors.pop(sid, None)
            client_ws = self.cdp_ws_streams.pop(sid, None)
            try:
                await self.send_raw_json({"type": "cdp_ws_close", "stream_id": sid})
            except Exception:
                pass
            if client_ws is not None:
                try:
                    await client_ws.close(code=1008, reason="Lease ended or exhausted")
                except Exception:
                    pass

    async def close_owner_streams(self, owner_id: int):
        target_sids = [
            sid
            for sid, lid in list(self.cdp_ws_leases.items())
            if lid == 0
            and self.cdp_ws_channels.get(sid) == "reverse"
            and int(self.cdp_ws_actors.get(sid, self.owner_id)) == int(owner_id)
        ]
        for sid in target_sids:
            self.cdp_ws_channels.pop(sid, None)
            self.cdp_ws_leases.pop(sid, None)
            self.cdp_ws_actors.pop(sid, None)
            client_ws = self.cdp_ws_streams.pop(sid, None)
            try:
                await self.send_raw_json({"type": "cdp_ws_close", "stream_id": sid})
            except Exception:
                pass
            if client_ws is not None:
                try:
                    await client_ws.close(code=1008, reason="Self-use reverse balance exhausted")
                except Exception:
                    pass

    def handle_incoming_text(self, text: str):
        try:
            data = json.loads(text)
            msg_type = data.get("type")
            if msg_type == "cdp_ws_frame":
                sid = data.get("stream_id")
                payload_text = data.get("data", "")
                channel = self.cdp_ws_channels.get(sid, "reverse")
                lease_id = self.cdp_ws_leases.get(sid, 0)
                actor_id = self.cdp_ws_actors.get(sid, self.owner_id)
                if payload_text:
                    record_cdp_traffic(
                        self.node_id,
                        channel_type=channel,
                        tx_bytes=len(str(payload_text).encode("utf-8")),
                        lease_id=lease_id,
                        owner_id=actor_id,
                    )
                client_ws = self.cdp_ws_streams.get(sid)
                if client_ws is not None:
                    asyncio.create_task(client_ws.send_text(payload_text))
                return
            if msg_type in {"cdp_ws_close", "cdp_ws_error"}:
                sid = data.get("stream_id")
                self.cdp_ws_channels.pop(sid, None)
                self.cdp_ws_leases.pop(sid, None)
                self.cdp_ws_actors.pop(sid, None)
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
                    owner_id=self.owner_id,
                )
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
        self.cdp_ws_leases.clear()
        self.cdp_ws_actors.clear()


class TunnelManager:
    def __init__(self):
        self.reverse_sessions: Dict[int, ReverseTunnelSession] = {}
        self.public_wss_tasks: Dict[int, asyncio.Task] = {}
        self.public_wss_targets: Dict[int, Tuple[str, str]] = {}

    async def disconnect_lease_streams(self, node_id: int, lease_id: int):
        sess = self.get_reverse_session(node_id)
        if sess is not None and not sess.is_closed:
            await sess.close_lease_streams(lease_id)

    async def disconnect_owner_reverse_streams(self, owner_id: int):
        for sess in list(self.reverse_sessions.values()):
            if sess is not None and not sess.is_closed:
                await sess.close_owner_streams(int(owner_id))

    def get_active_self_reverse_owner_ids(self) -> list[int]:
        owner_ids = set()
        for sess in list(self.reverse_sessions.values()):
            if sess is None or sess.is_closed:
                continue
            for sid, lid in list(sess.cdp_ws_leases.items()):
                if lid == 0 and sess.cdp_ws_channels.get(sid) == "reverse":
                    owner_ids.add(int(sess.cdp_ws_actors.get(sid, sess.owner_id)))
        return list(owner_ids)

    def register_reverse_tunnel(self, node_id: int, ws_client, owner_id: int = 1) -> ReverseTunnelSession:
        if node_id in self.reverse_sessions:
            self.reverse_sessions[node_id].close()
        session = ReverseTunnelSession(node_id, ws_client, owner_id=owner_id)
        self.reverse_sessions[node_id] = session
        logger.info(f"🔌 [Tenant:{owner_id}] 节点 ID:{node_id} 已接入 WSS 隧道连接池")
        return session

    def unregister_reverse_tunnel(self, node_id: int, expected_session: Optional[ReverseTunnelSession] = None):
        cur_session = self.reverse_sessions.get(node_id)
        if cur_session is None:
            return
        if expected_session is not None and cur_session is not expected_session:
            return
        cur_session.close()
        del self.reverse_sessions[node_id]

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
        node_id = node["id"]
        owner_id = int(node.get("owner_id") or 1)
        if node.get("enabled", 1) == 0:
            self.stop_public_wss_session(node_id)
            return

        endpoint = node.get("wss_endpoint") or node.get("recommended_endpoint")
        wss_url = _format_wss_url(endpoint, fallback_host=None, fallback_port=9443)
        if not wss_url:
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
            self._public_wss_client_loop(node_id, owner_id, wss_url, edge_secret)
        )

    async def _public_wss_client_loop(self, node_id: int, owner_id: int, wss_url: str, edge_secret: str):
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

                if not row or row["enabled"] == 0 or row["conn_type"] not in ("public_wss", "wss_direct"):
                    break

                ws = None
                session = None
                try:
                    try:
                        ws = await websockets.connect(wss_url, additional_headers=headers, **common_kwargs)
                    except TypeError:
                        ws = await websockets.connect(wss_url, extra_headers=headers, **common_kwargs)

                    adapter = _OutboundWsAdapter(ws)
                    session = self.register_reverse_tunnel(node_id, adapter, owner_id=int(row.get("owner_id") or owner_id))
                    backoff = 2
                    self._update_node_status(node_id, "connected")

                    from modules.nodes.cdp_engine import probe_node_with_latency
                    from modules.users.level_service import record_node_telemetry_sync

                    async def _refresh_probe(nid: int):
                        try:
                            await asyncio.sleep(0.6)
                            cnt, msg, lat_ms = await probe_node_with_latency(9222, target_host="public-wss", node_id=nid)
                            if msg == "OK":
                                self._update_node_status(nid, "connected", cnt)
                                record_node_telemetry_sync(nid, latency_ms=lat_ms, mark_online_tick=True)
                        except Exception:
                            pass

                    asyncio.create_task(_refresh_probe(node_id))

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
        from modules.nodes.cdp_engine import probe_node_cookies

        node_id = node["id"]
        conn_type = node.get("conn_type")

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
            return False, "正在向节点发起公网 WSS 直连"

        self.stop_tunnel(node_id)

        if conn_type == "reverse":
            session = self.get_reverse_session(node_id)
            if session and not session.is_closed:
                count, msg = await probe_node_cookies(node["local_bind_port"], target_host="reverse-nat4", node_id=node_id)
                self._update_node_status(node_id, "connected" if msg == "OK" else "error: refused", count if msg == "OK" else 0)
                return True, f"反向长连接在线，探测到 {count} 条 Cookies"
            self._update_node_status(node_id, "stopped", 0)
            return False, "反向隧道未接入 (等待节点携带 JOIN_TOKEN 连入)"

        self._update_node_status(node_id, "disabled_legacy", 0)
        return False, "SaaS 版仅支持公网 WSS 直连 (public_wss) 与 WSS 反向穿透 (reverse)"

    def stop_tunnel(self, node_id: int):
        if node_id in self.public_wss_tasks or node_id in self.public_wss_targets:
            self.stop_public_wss_session(node_id)
        self._update_node_status(node_id, "stopped")

    def _update_node_status(self, node_id: int, status: str, cookie_count: Optional[int] = None):
        with session_scope() as db:
            node = db.get(Node, node_id)
            if node is not None:
                node.status = "disabled" if node.enabled == 0 else status
                if cookie_count is not None:
                    node.cookie_count = cookie_count


tunnel_mgr = TunnelManager()
REVERSE_TUNNEL_POOL = tunnel_mgr.reverse_sessions


async def tunnel_watchdog_loop():
    from modules.nodes.cdp_engine import probe_node_with_latency
    from modules.users.level_service import record_node_telemetry_sync

    logger.info("启动 SaaS 节点链路看门狗 (仅 WSS 直连与 WSS 反向穿透，周期 30s)...")
    while True:
        try:
            with session_scope() as db:
                nodes = [n.to_dict() for n in db.query(Node).filter(Node.enabled == 1).all()]

            for node in nodes:
                node_id = node["id"]
                conn_type = node.get("conn_type", "reverse")
                if conn_type in ("public_wss", "wss_direct"):
                    session = tunnel_mgr.get_reverse_session(node_id)
                    if session and not session.is_closed:
                        count, msg, lat_ms = await probe_node_with_latency(node["local_bind_port"], target_host="public-wss", node_id=node_id)
                        tunnel_mgr._update_node_status(node_id, "connected" if msg == "OK" else "error: refused", count if msg == "OK" else 0)
                        record_node_telemetry_sync(node_id, latency_ms=lat_ms if msg == "OK" else None, mark_online_tick=(msg == "OK"), is_offline=(msg != "OK"))
                    else:
                        tunnel_mgr.ensure_public_wss_session(node)
                        tunnel_mgr._update_node_status(node_id, "stopped", 0)
                        record_node_telemetry_sync(node_id, is_offline=True)
                elif conn_type == "reverse":
                    session = tunnel_mgr.get_reverse_session(node_id)
                    if session and not session.is_closed:
                        count, msg, lat_ms = await probe_node_with_latency(node["local_bind_port"], target_host="reverse-nat4", node_id=node_id)
                        tunnel_mgr._update_node_status(node_id, "connected" if msg == "OK" else "error: refused", count if msg == "OK" else 0)
                        record_node_telemetry_sync(node_id, latency_ms=lat_ms if msg == "OK" else None, mark_online_tick=(msg == "OK"), is_offline=(msg != "OK"))
                    else:
                        tunnel_mgr._update_node_status(node_id, "stopped", 0)
                        record_node_telemetry_sync(node_id, is_offline=True)
        except Exception as e:
            logger.debug(f"看门狗巡检异常: {e}")
        await asyncio.sleep(30)
