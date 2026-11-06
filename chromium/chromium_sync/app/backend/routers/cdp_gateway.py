import sqlite3
import asyncio
from typing import Optional
import httpx
import websockets
from fastapi import APIRouter, HTTPException, Depends, Request, Query, WebSocket, WebSocketDisconnect

from config import logger
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
    api_key = get_setting('api_key')
    domain = request.headers.get("host", "localhost:8443")

    # 分支 A：NAT4 反向穿透节点，向边缘代理获取真实浏览器版本
    if node.get('conn_type') == 'reverse':
        session = tunnel_mgr.get_reverse_session(node_id)
        if not session or session.is_closed:
            raise HTTPException(status_code=502, detail="NAT4 反向节点当前处于离线状态")
        try:
            res = await session.send_command("get_version", timeout=4.0)
            data = res.get("version", {})
            if not data:
                data = {
                    "Browser": "Chrome/128.0.0.0",
                    "Protocol-Version": "1.3",
                    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"
                }
            data["webSocketDebuggerUrl"] = f"wss://{domain}/cdp/{node_id}/ws?api_key={api_key}"
            return data
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"无法从反向节点拉取版本: {e}")

    # 分支 B：常规直连 / SSH 隧道节点
    target_h = node.get('direct_host', '127.0.0.1') if node['is_local'] else "127.0.0.1"
    try:
        host, _ = await resolve_cdp_endpoint(node['local_bind_port'], target_h)
        async with httpx.AsyncClient(timeout=3.0) as client:
            res = await client.get(f"http://{host}:{node['local_bind_port']}/json/version")
            data = res.json()
            data["webSocketDebuggerUrl"] = f"wss://{domain}/cdp/{node_id}/ws?api_key={api_key}"
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

    # 分支 A: 反向穿透节点
    if node.get('conn_type') == 'reverse':
        session = tunnel_mgr.get_reverse_session(node_id)
        if not session or session.is_closed:
            await websocket.close(code=1011, reason="Target Reverse Node Offline")
            return
        await websocket.accept()
        # 保持连接挂载
        try:
            while True:
                msg = await websocket.receive_text()
                # 转发心跳或调试命令
                if msg == "ping":
                    await websocket.send_text("pong")
        except (WebSocketDisconnect, Exception):
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