import asyncio
import json
import secrets
import time
from typing import Optional

import httpx
import websockets
from fastapi import APIRouter, Depends, HTTPException, Query, Request, WebSocket, WebSocketDisconnect

from config import HUB_PORT, logger, resolve_hub_access_info
from core.db import get_setting, session_scope
from core.models import Node
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
from core.security import verify_agent_access, verify_api_key_value
from services.cdp_engine import resolve_cdp_endpoint
from services.traffic_service import adjust_active_cdp_streams, record_cdp_traffic
from services.tunnel_manager import tunnel_mgr

router = APIRouter(tags=["CDP安全网关"])


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


@router.get("/cdp/{node_id}/json/version")
async def cdp_gateway_version(
    request: Request,
    node_id: int,
    auth: dict = Depends(verify_agent_access),
):
    enforce_rate_limit("cdp_http", get_client_ip(request), RATE_LIMIT_CDP_PER_MIN, 60, "CDP 接口请求过于频繁")
    with session_scope() as db:
        row = db.get(Node, node_id)
        node = row.to_dict() if row else None

    if not node:
        raise HTTPException(status_code=404, detail="目标节点不存在")
    if node.get("api_enabled", 1) == 0 or (node.get("client_type") or "").lower() == "android":
        raise HTTPException(status_code=403, detail="该节点已禁用第三方 API / CDP 网关接入")

    api_key = get_setting("api_key")
    hub_info = resolve_hub_access_info(request)
    ws_scheme = hub_info["ws_scheme"]
    domain = hub_info["public_netloc"]
    channel = _resolve_channel_label(node.get("conn_type"))

    # 分支 A：WSS 通道节点（NAT4 反向穿透或公网 WSS 直连）
    if node.get("conn_type") in ("reverse", "public_wss", "wss_direct"):
        session = tunnel_mgr.get_reverse_session(node_id)
        if not session or session.is_closed:
            raise HTTPException(status_code=502, detail="WSS 节点当前处于离线状态")
        try:
            res = await session.send_command("get_version", timeout=4.0)
            data = res.get("version", {})
            if not data:
                data = {
                    "Browser": "Chrome/128.0.0.0",
                    "Protocol-Version": "1.3",
                    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
                }
            data["webSocketDebuggerUrl"] = f"{ws_scheme}://{domain}/cdp/{node_id}/ws?api_key={api_key}"
            record_cdp_traffic(node_id, channel_type=channel, tx_bytes=_payload_byte_len(json.dumps(data)), requests=1)
            return data
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"无法从反向节点拉取版本: {e}")

    # 分支 B：常规直连 / SSH 隧道节点 (兼容 IPv6 RFC 2732)
    target_h = node.get("direct_host", "127.0.0.1") if node["is_local"] else "127.0.0.1"
    try:
        host, _ = await resolve_cdp_endpoint(node["local_bind_port"], target_h)
        clean_h = host.strip("[]")
        netloc = f"[{clean_h}]:{node['local_bind_port']}" if ":" in clean_h else f"{clean_h}:{node['local_bind_port']}"
        async with httpx.AsyncClient(timeout=3.0) as client:
            res = await client.get(f"http://{netloc}/json/version")
            data = res.json()
            data["webSocketDebuggerUrl"] = f"{ws_scheme}://{domain}/cdp/{node_id}/ws?api_key={api_key}"
            record_cdp_traffic(node_id, channel_type=channel, tx_bytes=_payload_byte_len(json.dumps(data)), requests=1)
            return data
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"无法连通该节点的 CDP 服务: {e}")


@router.get("/cdp/{node_id}/json/list")
@router.get("/cdp/{node_id}/json")
async def cdp_gateway_list(
    request: Request,
    node_id: int,
    auth: dict = Depends(verify_agent_access),
):
    enforce_rate_limit("cdp_http", get_client_ip(request), RATE_LIMIT_CDP_PER_MIN, 60, "CDP 接口请求过于频繁")
    with session_scope() as db:
        row = db.get(Node, node_id)
        node = row.to_dict() if row else None

    if not node:
        raise HTTPException(status_code=404, detail="目标节点不存在")
    if node.get("api_enabled", 1) == 0 or (node.get("client_type") or "").lower() == "android":
        raise HTTPException(status_code=403, detail="该节点已禁用第三方 API / CDP 网关接入")

    api_key = get_setting("api_key")
    hub_info = resolve_hub_access_info(request)
    ws_scheme = hub_info["ws_scheme"]
    domain = hub_info["public_netloc"]
    channel = _resolve_channel_label(node.get("conn_type"))
    ws_url = f"{ws_scheme}://{domain}/cdp/{node_id}/ws?api_key={api_key}"

    if node.get("conn_type") in ("reverse", "public_wss", "wss_direct"):
        session = tunnel_mgr.get_reverse_session(node_id)
        if not session or session.is_closed:
            raise HTTPException(status_code=502, detail="WSS 节点当前处于离线状态")
        targets = []
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
                    "id": f"node-{node_id}",
                    "title": node.get("name") or f"Node #{node_id}",
                    "type": "page",
                    "url": "about:blank",
                    "webSocketDebuggerUrl": ws_url,
                }
            ]
        record_cdp_traffic(node_id, channel_type=channel, tx_bytes=_payload_byte_len(json.dumps(targets)), requests=1)
        return targets

    target_h = node.get("direct_host", "127.0.0.1") if node["is_local"] else "127.0.0.1"
    try:
        host, _ = await resolve_cdp_endpoint(node["local_bind_port"], target_h)
        clean_h = host.strip("[]")
        netloc = f"[{clean_h}]:{node['local_bind_port']}" if ":" in clean_h else f"{clean_h}:{node['local_bind_port']}"
        async with httpx.AsyncClient(timeout=3.0) as client:
            res = await client.get(f"http://{netloc}/json/list")
            raw_targets = res.json() if isinstance(res.json(), list) else []
            targets = []
            for item in raw_targets:
                if not isinstance(item, dict):
                    continue
                t = dict(item)
                t["webSocketDebuggerUrl"] = ws_url
                t.pop("devtoolsFrontendUrl", None)
                targets.append(t)
            if not targets:
                targets = [
                    {
                        "description": "",
                        "id": f"node-{node_id}",
                        "title": node.get("name") or f"Node #{node_id}",
                        "type": "page",
                        "url": "about:blank",
                        "webSocketDebuggerUrl": ws_url,
                    }
                ]
            record_cdp_traffic(node_id, channel_type=channel, tx_bytes=_payload_byte_len(json.dumps(targets)), requests=1)
            return targets
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"无法连通该节点的 CDP 服务: {e}")


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

    valid_key = get_setting("api_key")
    header_key = websocket.headers.get("x-api-key")
    auth_hdr = websocket.headers.get("authorization") or ""
    bearer_key = auth_hdr[7:].strip() if auth_hdr.lower().startswith("bearer ") else None
    if not (
        verify_api_key_value(api_key, valid_key)
        or verify_api_key_value(token, valid_key)
        or verify_api_key_value(header_key, valid_key)
        or verify_api_key_value(bearer_key, valid_key)
    ):
        record_auth_failure(
            "api_key",
            client_ip,
            max_failures=API_KEY_MAX_FAILURES,
            fail_window_sec=API_KEY_FAIL_WINDOW_SEC,
            block_sec=API_KEY_BLOCK_SECONDS,
        )
        await websocket.close(code=1008, reason="Unauthorized: Invalid API-Key")
        return

    allowed_ws, _, _ = check_rate_limit("cdp_ws", client_ip, RATE_LIMIT_CDP_PER_MIN, 60)
    if not allowed_ws:
        await websocket.close(code=1008, reason="CDP WebSocket rate limit exceeded")
        return

    if not ws_guard.acquire("cdp", client_ip, MAX_WS_CDP_PER_IP):
        await websocket.close(code=1008, reason="Too many concurrent CDP sessions from IP")
        return

    try:
        await _run_cdp_gateway_ws(websocket, node_id)
    finally:
        ws_guard.release("cdp", client_ip)


async def _run_cdp_gateway_ws(websocket: WebSocket, node_id: int):
    with session_scope() as db:
        row = db.get(Node, node_id)
        node = row.to_dict() if row else None

    if not node:
        await websocket.close(code=1008, reason="Node Not Found")
        return
    if node.get("api_enabled", 1) == 0 or (node.get("client_type") or "").lower() == "android":
        await websocket.close(code=1008, reason="Third-party API disabled for this node")
        return

    channel = _resolve_channel_label(node.get("conn_type"))
    started_ts = time.monotonic()

    # 分支 A: WSS 通道节点 (NAT4 反向穿透或公网 WSS 直连，全双工 CDP WebSocket 多路复用转发)
    if node.get("conn_type") in ("reverse", "public_wss", "wss_direct"):
        session = tunnel_mgr.get_reverse_session(node_id)
        if not session or session.is_closed:
            await websocket.close(code=1011, reason="Target WSS Node Offline")
            return
        await websocket.accept()
        stream_id = secrets.token_hex(8)
        session.cdp_ws_streams[stream_id] = websocket
        session.cdp_ws_channels[stream_id] = channel
        adjust_active_cdp_streams(node_id, +1)
        record_cdp_traffic(node_id, channel_type=channel, requests=1)

        await session.send_raw_json({"type": "cdp_ws_open", "stream_id": stream_id})
        try:
            while True:
                msg = await websocket.receive_text()
                record_cdp_traffic(node_id, channel_type=channel, rx_bytes=_payload_byte_len(msg))
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
            adjust_active_cdp_streams(node_id, -1)
            dur = max(0, int(time.monotonic() - started_ts))
            if dur:
                record_cdp_traffic(node_id, channel_type=channel, duration_sec=dur)
            try:
                await session.send_raw_json({"type": "cdp_ws_close", "stream_id": stream_id})
            except Exception:
                pass
        return

    # 分支 B: 直连 / SSH 隧道节点双向中继
    target_h = node.get("direct_host", "127.0.0.1") if node["is_local"] else "127.0.0.1"
    try:
        host, internal_ws_url = await resolve_cdp_endpoint(node["local_bind_port"], target_h)
    except Exception:
        await websocket.close(code=1011, reason="Target CDP Offline")
        return

    await websocket.accept()
    adjust_active_cdp_streams(node_id, +1)
    record_cdp_traffic(node_id, channel_type=channel, requests=1)

    try:
        async with websockets.connect(internal_ws_url, max_size=100 * 1024 * 1024) as target_ws:
            async def forward_client_to_target():
                while True:
                    msg = await websocket.receive_text()
                    record_cdp_traffic(node_id, channel_type=channel, rx_bytes=_payload_byte_len(msg))
                    await target_ws.send(msg)

            async def forward_target_to_client():
                while True:
                    msg = await target_ws.recv()
                    record_cdp_traffic(node_id, channel_type=channel, tx_bytes=_payload_byte_len(msg))
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
        logger.debug(f"CDP 网关会话结束: {e}")
    finally:
        adjust_active_cdp_streams(node_id, -1)
        dur = max(0, int(time.monotonic() - started_ts))
        if dur:
            record_cdp_traffic(node_id, channel_type=channel, duration_sec=dur)
        try:
            await websocket.close()
        except Exception:
            pass