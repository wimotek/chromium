import json
import secrets
import time
from typing import Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query, Request, WebSocket, WebSocketDisconnect

from config import resolve_hub_access_info
from core.db import session_scope
from core.models import Node, NodeLease, Plan, User
from core.rate_limit import (
    API_KEY_BLOCK_SECONDS,
    API_KEY_FAIL_WINDOW_SEC,
    API_KEY_MAX_FAILURES,
    MAX_WS_CDP_PER_IP,
    RATE_LIMIT_CDP_PER_MIN,
    check_rate_limit,
    clear_auth_failures,
    enforce_rate_limit,
    get_block_ttl,
    get_client_ip,
    record_auth_failure,
    ws_guard,
)
from core.security import resolve_user_by_api_key, verify_agent_access
from modules.audit.service import write_audit_log
from modules.billing.service import (
    get_self_reverse_hub_gb_units,
    is_shareable_conn_type,
    normalize_billing_channel,
)
from modules.nodes.traffic_service import adjust_active_cdp_streams, record_cdp_traffic
from modules.nodes.tunnel_manager import tunnel_mgr

router = APIRouter(tags=["SaaS CDP 安全网关与租约计费旁路"])


def _payload_byte_len(msg) -> int:
    if isinstance(msg, bytes):
        return len(msg)
    if isinstance(msg, str):
        return len(msg.encode("utf-8"))
    return 0


def _resolve_channel_label(conn_type: Optional[str]) -> str:
    return normalize_billing_channel(conn_type)


def _authorize_cdp_actor(node_id: int, actor: dict) -> Tuple[dict, int]:
    uid = int(actor["id"])
    self_rev_rate = get_self_reverse_hub_gb_units()

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
        if not is_shareable_conn_type(row.conn_type):
            raise HTTPException(status_code=403, detail="SaaS 版仅支持公网 WSS 直连或 WSS 反向穿透节点")

        lease = (
            db.query(NodeLease)
            .filter(NodeLease.node_id == int(node_id), NodeLease.buyer_id == uid, NodeLease.status == "active")
            .order_by(NodeLease.id.desc())
            .first()
        )
        if int(row.owner_id) == uid:
            if int(row.active_lease_count or 0) > 0:
                raise HTTPException(status_code=409, detail="该节点正在市场出租中，为保障买家会话隔离，暂禁止所有者同时直连 CDP")
            if normalize_billing_channel(row.conn_type) == "reverse" and self_rev_rate > 0:
                if int(u.balance_units or 0) <= 0:
                    raise HTTPException(
                        status_code=402,
                        detail="自用 WSS 反向穿透需支付 Hub 中继流量费，当前钱包余额不足，请先充值或领取补贴",
                    )
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
        raise HTTPException(status_code=502, detail=f"无法从 WSS 节点拉取版本: {e}")


@router.get("/cdp/{node_id}/json/list")
@router.get("/cdp/{node_id}/json")
async def cdp_gateway_list(
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
    ws_url = f"{ws_scheme}://{domain}/cdp/{node_id}/ws?api_key={api_key}"

    session = tunnel_mgr.get_reverse_session(node_id)
    if not session or session.is_closed:
        raise HTTPException(status_code=502, detail="WSS 节点当前处于离线状态")

    targets = []
    if lease_id == 0:
        try:
            res = await session.send_command("get_list", timeout=4.0)
            raw_targets = res.get("targets") if isinstance(res, dict) else None
            if isinstance(raw_targets, list):
                for item in raw_targets:
                    if not isinstance(item, dict):
                        continue
                    t = dict(item)
                    t["webSocketDebuggerUrl"] = ws_url
                    t.pop("devtoolsFrontendUrl", None)
                    targets.append(t)
        except Exception:
            targets = []

    if not targets:
        targets = [
            {
                "description": "",
                "id": f"lease-{lease_id}-node-{node_id}" if lease_id else f"node-{node_id}",
                "title": f"Leased Node #{node_id}" if lease_id else (node.get("name") or f"Node #{node_id}"),
                "type": "page",
                "url": "about:blank",
                "webSocketDebuggerUrl": ws_url,
            }
        ]

    record_cdp_traffic(
        node_id,
        channel_type=channel,
        tx_bytes=_payload_byte_len(json.dumps(targets)),
        requests=1,
        lease_id=lease_id,
        owner_id=int(auth["id"]),
    )
    return targets


@router.websocket("/cdp/{node_id}/ws")
async def cdp_gateway_ws(
    websocket: WebSocket,
    node_id: int,
    api_key: Optional[str] = Query(None),
    token: Optional[str] = Query(None),
):
    client_ip = get_client_ip(websocket)
    if get_block_ttl("api_key", client_ip) > 0:
        await websocket.close(code=1008, reason="Temporarily blocked due to auth failures")
        return

    auth_hdr = websocket.headers.get("authorization") or ""
    bearer_key = auth_hdr[7:].strip() if auth_hdr.lower().startswith("bearer ") else None
    presented = api_key or token or websocket.headers.get("x-api-key") or bearer_key
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
                details={"detail": he.detail, "status_code": he.status_code},
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
