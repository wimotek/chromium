import asyncio
import json
import secrets
import time
from typing import Optional, Tuple

import httpx
import websockets
from fastapi import APIRouter, Depends, HTTPException, Query, Request, WebSocket, WebSocketDisconnect

from config import resolve_hub_access_info, logger
from core.db import session_scope
from core.models import Node, NodeLease, Plan, User
from core.rate_limit import (
    API_KEY_BLOCK_SECONDS,
    API_KEY_FAIL_WINDOW_SEC,
    API_KEY_MAX_FAILURES,
    MAX_WS_CDP_PER_IP,
    RATE_LIMIT_CDP_PER_MIN,
    check_rate_limit,
    enforce_rate_limit,
    get_block_ttl,
    get_client_ip,
    record_auth_failure,
    ws_guard,
)
from core.security import resolve_user_by_api_key, verify_agent_access
from services.audit_service import write_audit_log
from services.cdp_engine import resolve_cdp_endpoint
from services.traffic_service import adjust_active_cdp_streams, record_cdp_traffic
from services.tunnel_manager import tunnel_mgr

router = APIRouter(tags=["SaaS CDP 安全网关与租约计费旁路"])


def _payload_byte_len(msg) -> int:
    if isinstance(msg, bytes):
        return len(msg)
    if isinstance(msg, str):
        return len(msg.encode("utf-8"))
    return 0


def _resolve_channel_label(conn_type: Optional[str]) -> str:
    ct = (conn_type or "direct").strip().lower()
    if ct in ("public_wss", "wss_direct"):
        return "public_wss"
    if ct == "reverse":
        return "reverse"
    if ct in ("ssh", "ssh_tunnel"):
        return "ssh"
    return "direct"


def _authorize_cdp_actor(node_id: int, actor: dict) -> Tuple[dict, int]:
    """
    核心鉴权矩阵：
    1. 租户本人自有节点且无外部买家租约 -> 放行 owner 模式 (lease_id = 0)
    2. 外部买家对节点持有有效 active 租约且余额/流量配额健康 -> 放行 lease 模式 (lease_id = lease.id)
    3. 严禁未授权租户接入，也严禁卖家在有买家租用独占期间抢占会话。
    """
    uid = int(actor["id"])
    with session_scope() as db:
        u = db.get(User, uid)
        if u is None or u.status != "active":
            raise HTTPException(status_code=403, detail="账户不存在或已停用")
        plan = db.get(Plan, u.plan_id)
        if plan and int(plan.max_monthly_traffic_bytes or 0) > 0:
            if int(u.monthly_traffic_bytes or 0) >= int(plan.max_monthly_traffic_bytes):
                raise HTTPException(status_code=403, detail="本月套餐流量配额已耗尽，请升级套餐或下月重试")

        row = db.get(Node, int(node_id))
        if row is None or row.enabled == 0:
            raise HTTPException(status_code=404, detail="目标节点不存在或已停用")
        if row.api_enabled == 0 or (row.client_type or "").lower() == "android":
            raise HTTPException(status_code=403, detail="该节点已禁用第三方 CDP 网关接入")

        lease = (
            db.query(NodeLease)
            .filter(NodeLease.node_id == int(node_id), NodeLease.buyer_id == uid, NodeLease.status == "active")
            .order_by(NodeLease.id.desc())
            .first()
        )
        if int(row.owner_id) == uid:
            if int(row.active_lease_count or 0) > 0:
                raise HTTPException(status_code=409, detail="该节点正在市场出租中，为保障买家会话隔离，暂禁止所有者同时直连 CDP")
            return row.to_dict(), 0

        if lease is not None:
            if int(u.balance_units or 0) <= 0 and (int(lease.buyer_hour_units or 0) > 0 or int(lease.buyer_gb_units or 0) > 0):
                raise HTTPException(status_code=402, detail="租户钱包余额已耗尽，无法继续使用该租约")
            return row.to_dict(), int(lease.id)

    raise HTTPException(status_code=403, detail="无权接入该节点：既非节点所有者，也无有效进行中的租赁订单")


@router.get("/cdp/{node_id}/json/version")
async def cdp_gateway_version(
    request: Request,
    node_id: int,
    auth: dict = Depends(verify_agent_access),
):
    client_ip = get_client_ip(request)
    enforce_rate_limit("cdp_http", client_ip, RATE_LIMIT_CDP_PER_MIN, 60, "CDP 接口请求过于频繁")

    node, lease_id = _authorize_cdp_actor(node_id, auth)
    api_key = auth.get("api_key", "")
    hub_info = resolve_hub_access_info(request)
    ws_scheme = hub_info["ws_scheme"]
    domain = hub_info["public_netloc"]
    channel = _resolve_channel_label(node.get("conn_type"))

    if node.get("conn_type") in ("reverse", "public_wss", "wss_direct"):
        session = tunnel_mgr.get_reverse_session(node_id)
        if not session or session.is_closed:
            raise HTTPException(status_code=502, detail="WSS 节点当前处于离线状态")
        try:
            res = await session.send_command("get_version", timeout=4.0)
            data = res.get("version", {}) or {
                "Browser": "Chrome/128.0.0.0",
                "Protocol-Version": "1.3",
                "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
            }
            data["webSocketDebuggerUrl"] = f"{ws_scheme}://{domain}/cdp/{node_id}/ws?api_key={api_key}"
            record_cdp_traffic(
                node_id,
                channel_type=channel,
                tx_bytes=_payload_byte_len(json.dumps(data)),
                requests=1,
                lease_id=lease_id,
                owner_id=int(auth["id"]),
            )
            return data
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"无法从反向节点拉取版本: {e}")

    target_h = node.get("direct_host", "127.0.0.1") if node["is_local"] else "127.0.0.1"
    try:
        host, _ = await resolve_cdp_endpoint(node["local_bind_port"], target_h)
        clean_h = host.strip("[]")
        netloc = f"[{clean_h}]:{node['local_bind_port']}" if ":" in clean_h else f"{clean_h}:{node['local_bind_port']}"
        async with httpx.AsyncClient(timeout=3.0) as client:
            res = await client.get(f"http://{netloc}/json/version")
            data = res.json()
            data["webSocketDebuggerUrl"] = f"{ws_scheme}://{domain}/cdp/{node_id}/ws?api_key={api_key}"
            record_cdp_traffic(
                node_id,
                channel_type=channel,
                tx_bytes=_payload_byte_len(json.dumps(data)),
                requests=1,
                lease_id=lease_id,
                owner_id=int(auth["id"]),
            )
            return data
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"无法连通该节点的 CDP 服务: {e}")


@router.websocket("/cdp/{node_id}/ws")
async def cdp_gateway_ws(
    websocket: WebSocket,
    node_id: int,
    api_key: Optional[str] = Query(None),
):
    client_ip = get_client_ip(websocket)
    if get_block_ttl("api_key", client_ip) > 0:
        await websocket.close(code=1008, reason="Temporarily blocked due to auth failures")
        return

    presented = api_key or websocket.headers.get("x-api-key")
    actor = resolve_user_by_api_key(presented)
    if actor is None:
        record_auth_failure(
            "api_key",
            client_ip,
            max_failures=API_KEY_MAX_FAILURES,
            fail_window_sec=API_KEY_FAIL_WINDOW_SEC,
            block_sec=API_KEY_BLOCK_SECONDS,
        )
        await websocket.close(code=1008, reason="Unauthorized: Invalid Tenant API-Key")
        return

    clear_fail = actor is not None
    if clear_fail:
        from core.rate_limit import clear_auth_failures
        clear_auth_failures("api_key", client_ip)

    allowed_ws, _, _ = check_rate_limit("cdp_ws", client_ip, RATE_LIMIT_CDP_PER_MIN, 60)
    if not allowed_ws:
        await websocket.close(code=1008, reason="CDP WebSocket rate limit exceeded")
        return

    if not ws_guard.acquire("cdp", client_ip, MAX_WS_CDP_PER_IP):
        await websocket.close(code=1008, reason="Too many concurrent CDP sessions from IP")
        return

    try:
        try:
            node, lease_id = _authorize_cdp_actor(node_id, actor)
        except HTTPException as he:
            write_audit_log(
                action="cdp_ws_denied",
                actor_id=actor["id"],
                actor_username=actor["username"],
                target_type="node",
                target_id=node_id,
                ip=client_ip,
                status="deny",
                details={"detail": he.detail},
            )
            await websocket.close(code=1008, reason=str(he.detail)[:120])
            return

        write_audit_log(
            action="cdp_ws_connect",
            actor_id=actor["id"],
            actor_username=actor["username"],
            target_type="node",
            target_id=node_id,
            ip=client_ip,
            status="ok",
            details={"lease_id": lease_id, "mode": "lease" if lease_id else "owner"},
        )
        await _run_cdp_gateway_ws(websocket, node, actor_id=int(actor["id"]), lease_id=lease_id)
    finally:
        ws_guard.release("cdp", client_ip)


async def _run_cdp_gateway_ws(websocket: WebSocket, node: dict, actor_id: int, lease_id: int):
    node_id = int(node["id"])
    channel = _resolve_channel_label(node.get("conn_type"))
    started_ts = time.monotonic()

    if node.get("conn_type") in ("reverse", "public_wss", "wss_direct"):
        session = tunnel_mgr.get_reverse_session(node_id)
        if not session or session.is_closed:
            await websocket.close(code=1011, reason="Target WSS Node Offline")
            return
        await websocket.accept()
        stream_id = secrets.token_hex(8)
        session.cdp_ws_streams[stream_id] = websocket
        session.cdp_ws_channels[stream_id] = channel
        session.cdp_ws_leases[stream_id] = lease_id
        session.cdp_ws_actors[stream_id] = actor_id
        adjust_active_cdp_streams(node_id, +1)
        record_cdp_traffic(node_id, channel_type=channel, requests=1, lease_id=lease_id, owner_id=actor_id)

        await session.send_raw_json({"type": "cdp_ws_open", "stream_id": stream_id, "lease_id": lease_id})
        try:
            while True:
                msg = await websocket.receive_text()
                record_cdp_traffic(
                    node_id,
                    channel_type=channel,
                    rx_bytes=_payload_byte_len(msg),
                    lease_id=lease_id,
                    owner_id=actor_id,
                )
                await session.send_raw_json({
                    "type": "cdp_ws_frame",
                    "stream_id": stream_id,
                    "data": msg,
                })
        except (WebSocketDisconnect, Exception):
            pass
        finally:
            session.cdp_ws_streams.pop(stream_id, None)
            session.cdp_ws_channels.pop(stream_id, None)
            session.cdp_ws_leases.pop(stream_id, None)
            session.cdp_ws_actors.pop(stream_id, None)
            adjust_active_cdp_streams(node_id, -1)
            dur = max(0, int(time.monotonic() - started_ts))
            if dur:
                record_cdp_traffic(node_id, channel_type=channel, duration_sec=dur, lease_id=lease_id, owner_id=actor_id)
            try:
                await session.send_raw_json({"type": "cdp_ws_close", "stream_id": stream_id})
            except Exception:
                pass
        return

    target_h = node.get("direct_host", "127.0.0.1") if node["is_local"] else "127.0.0.1"
    try:
        _, internal_ws_url = await resolve_cdp_endpoint(node["local_bind_port"], target_h)
    except Exception:
        await websocket.close(code=1011, reason="Target CDP Offline")
        return

    await websocket.accept()
    tunnel_mgr.register_direct_lease_ws(lease_id, websocket)
    adjust_active_cdp_streams(node_id, +1)
    record_cdp_traffic(node_id, channel_type=channel, requests=1, lease_id=lease_id, owner_id=actor_id)

    try:
        async with websockets.connect(internal_ws_url, max_size=100 * 1024 * 1024) as target_ws:
            async def forward_client_to_target():
                while True:
                    msg = await websocket.receive_text()
                    record_cdp_traffic(
                        node_id,
                        channel_type=channel,
                        rx_bytes=_payload_byte_len(msg),
                        lease_id=lease_id,
                        owner_id=actor_id,
                    )
                    await target_ws.send(msg)

            async def forward_target_to_client():
                while True:
                    msg = await target_ws.recv()
                    record_cdp_traffic(
                        node_id,
                        channel_type=channel,
                        tx_bytes=_payload_byte_len(msg),
                        lease_id=lease_id,
                        owner_id=actor_id,
                    )
                    await websocket.send_text(msg)

            _, pending = await asyncio.wait(
                [
                    asyncio.create_task(forward_client_to_target()),
                    asyncio.create_task(forward_target_to_client()),
                ],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
    except (WebSocketDisconnect, websockets.ConnectionClosed):
        pass
    except Exception as e:
        logger.debug(f"SaaS CDP 网关会话结束: {e}")
    finally:
        tunnel_mgr.unregister_direct_lease_ws(lease_id, websocket)
        adjust_active_cdp_streams(node_id, -1)
        dur = max(0, int(time.monotonic() - started_ts))
        if dur:
            record_cdp_traffic(node_id, channel_type=channel, duration_sec=dur, lease_id=lease_id, owner_id=actor_id)
        try:
            await websocket.close()
        except Exception:
            pass
