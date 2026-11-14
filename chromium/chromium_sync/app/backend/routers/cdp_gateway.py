import sqlite3
import asyncio
import secrets
from typing import Optional
import httpx
import websockets
from fastapi import APIRouter, HTTPException, Depends, Request, Query, WebSocket, WebSocketDisconnect

from config import logger, HUB_PORT, resolve_hub_access_info
from core.database import get_setting, get_db_connection
from core.security import verify_agent_access
from services.tunnel_manager import tunnel_mgr
from services.cdp_engine import resolve_cdp_endpoint

router = APIRouter(tags=["CDP安全网关"])

@router.get("/cdp/{node_id}/json/version")
async def cdp_gateway_version(
    request: Request,
    node_id: int,
    auth: dict = Depends(verify_agent_access)
):
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM nodes WHERE id=?", (node_id,))
    row = cur.fetchone()
    conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="目标节点不存在")
    node = dict(row)
    if node.get("api_enabled", 1) == 0 or (node.get("client_type") or "").lower() == "android":
        raise HTTPException(status_code=403, detail="该节点已禁用第三方 API / CDP 网关接入")
    api_key = get_setting('api_key')
    hub_info = resolve_hub_access_info(request)
    ws_scheme = hub_info["ws_scheme"]
    domain = hub_info["public_netloc"]

    # 分支 A：WSS 通道节点（NAT4 反向穿透或公网 WSS 直连），经 WSS 向节点本地 127.0.0.1:9222 获取真实浏览器版本
    if node.get('conn_type') in ('reverse', 'public_wss', 'wss_direct'):
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
                    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"
                }
            data["webSocketDebuggerUrl"] = f"{ws_scheme}://{domain}/cdp/{node_id}/ws?api_key={api_key}"
            return data
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"无法从反向节点拉取版本: {e}")

    # 分支 B：常规直连 / SSH 隧道节点 (兼容 IPv6 RFC 2732)
    target_h = node.get('direct_host', '127.0.0.1') if node['is_local'] else "127.0.0.1"
    try:
        host, _ = await resolve_cdp_endpoint(node['local_bind_port'], target_h)
        clean_h = host.strip("[]")
        netloc = f"[{clean_h}]:{node['local_bind_port']}" if ":" in clean_h else f"{clean_h}:{node['local_bind_port']}"
        async with httpx.AsyncClient(timeout=3.0) as client:
            res = await client.get(f"http://{netloc}/json/version")
            data = res.json()
            data["webSocketDebuggerUrl"] = f"{ws_scheme}://{domain}/cdp/{node_id}/ws?api_key={api_key}"
            return data
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"无法连通该节点的 CDP 服务: {e}")

@router.websocket("/cdp/{node_id}/ws")
async def cdp_gateway_ws(
    websocket: WebSocket,
    node_id: int,
    api_key: Optional[str] = Query(None)
):
    valid_key = get_setting('api_key')
    header_key = websocket.headers.get("x-api-key")
    if (api_key != valid_key) and (header_key != valid_key):
        await websocket.close(code=1008, reason="Unauthorized: Invalid API-Key")
        return

    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM nodes WHERE id=?", (node_id,))
    row = cur.fetchone()
    conn.close()

    if not row:
        await websocket.close(code=1008, reason="Node Not Found")
        return
    node = dict(row)
    if node.get("api_enabled", 1) == 0 or (node.get("client_type") or "").lower() == "android":
        await websocket.close(code=1008, reason="Third-party API disabled for this node")
        return

    # 分支 A: WSS 通道节点 (NAT4 反向穿透或公网 WSS 直连，全双工 CDP WebSocket 多路复用转发)
    if node.get('conn_type') in ('reverse', 'public_wss', 'wss_direct'):
        session = tunnel_mgr.get_reverse_session(node_id)
        if not session or session.is_closed:
            await websocket.close(code=1011, reason="Target WSS Node Offline")
            return
        await websocket.accept()
        stream_id = secrets.token_hex(8)
        session.cdp_ws_streams[stream_id] = websocket
        await session.send_raw_json({"type": "cdp_ws_open", "stream_id": stream_id})
        try:
            while True:
                msg = await websocket.receive_text()
                await session.send_raw_json({
                    "type": "cdp_ws_frame",
                    "stream_id": stream_id,
                    "data": msg,
                })
        except (WebSocketDisconnect, Exception):
            pass
        finally:
            session.cdp_ws_streams.pop(stream_id, None)
            try:
                await session.send_raw_json({"type": "cdp_ws_close", "stream_id": stream_id})
            except Exception:
                pass
        return

    # 分支 B: 直连 / SSH 隧道节点双向中继
    target_h = node.get('direct_host', '127.0.0.1') if node['is_local'] else "127.0.0.1"
    try:
        host, internal_ws_url = await resolve_cdp_endpoint(node['local_bind_port'], target_h)
    except Exception:
        await websocket.close(code=1011, reason="Target CDP Offline")
        return

    await websocket.accept()

    try:
        async with websockets.connect(internal_ws_url, max_size=100 * 1024 * 1024) as target_ws:
            async def forward_client_to_target():
                while True:
                    msg = await websocket.receive_text()
                    await target_ws.send(msg)

            async def forward_target_to_client():
                while True:
                    msg = await target_ws.recv()
                    await websocket.send_text(msg)

            done, pending = await asyncio.wait(
                [
                    asyncio.create_task(forward_client_to_target()),
                    asyncio.create_task(forward_target_to_client())
                ],
                return_when=asyncio.FIRST_COMPLETED
            )
            for task in pending:
                task.cancel()
    except (WebSocketDisconnect, websockets.ConnectionClosed):
        pass
    except Exception as e:
        logger.debug(f"CDP 网关会话结束: {e}")
    finally:
        try:
            await websocket.close()
        except Exception:
            pass