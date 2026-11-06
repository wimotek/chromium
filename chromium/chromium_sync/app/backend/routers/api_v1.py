import sqlite3
from typing import Optional
from fastapi import APIRouter, HTTPException, Depends, Request, Query
from config import DB_PATH
from core.database import get_setting, set_setting, get_db_connection
from core.security import verify_token, verify_agent_access
from services.cdp_engine import fetch_cookies_native
from services.sync_service import execute_sync_task

router = APIRouter(tags=["外部 Agent 开放 API"])

@router.get("/api/remote-access")
def get_remote_access_settings(user: dict = Depends(verify_token)):
    return {
        "direct_port_access_enabled": get_setting("direct_port_access_enabled", "1") == "1",
        "api_key": get_setting("api_key")
    }

@router.post("/api/remote-access")
def save_remote_access_settings(data: dict, user: dict = Depends(verify_token)):
    if "direct_port_access_enabled" in data:
        set_setting("direct_port_access_enabled", "1" if data["direct_port_access_enabled"] else "0")
    return {"message": "远程连接策略已更新"}

@router.get("/api/v1/nodes", summary="获取所有在线 CDP 节点列表 (支持双连接方式生成)")
def external_list_nodes(request: Request, auth: dict = Depends(verify_agent_access)):
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM nodes")
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()

    domain = request.headers.get("host", "localhost:8443")
    api_key = get_setting('api_key')
    direct_port_enabled = (get_setting("direct_port_access_enabled", "1") == "1")
    host_only = domain.split(":")[0]

    nodes_result = []
    for r in rows:
        direct_h = r.get("direct_host") or "127.0.0.1"
        is_loc = bool(r["is_local"])
        node_id = r["id"]
        bind_port = r["local_bind_port"]

        connection_methods = {
            "gateway": {
                "type": "wss_secure_gateway",
                "enabled": True,
                "description": "基于 API-Key 的加密反向中继网关 (推荐，防扫描，仅走 8443)",
                "ws_url": f"wss://{domain}/cdp/{node_id}/ws?api_key={api_key}",
                "http_version_url": f"https://{domain}/cdp/{node_id}/json/version?api_key={api_key}"
            },
            "direct": {
                "type": "direct_port_mapping",
                "enabled": direct_port_enabled,
                "description": "公网直接端口映射模式 (需防火墙放行该端口，无鉴权)",
                "port": bind_port,
                "http_endpoint": f"http://{host_only}:{bind_port}",
                "ws_endpoint_hint": f"http://{host_only}:{bind_port}/json/version"
            }
        }

        nodes_result.append({
            "id": node_id,
            "name": r["name"],
            "group_name": r.get("group_name") or "默认分组",
            "is_source": bool(r["is_source"]),
            "is_local": is_loc,
            "direct_host": direct_h if is_loc else None,
            "status": r["status"],
            "cookie_count": r["cookie_count"],
            "last_sync": r["last_sync"],
            "connection_methods": connection_methods,
            "cookies_export_url": f"/api/v1/nodes/{node_id}/cookies"
        })

    return {
        "code": 200,
        "total": len(rows),
        "online_count": len([n for n in rows if n["status"] == "connected"]),
        "direct_port_access_enabled": direct_port_enabled,
        "nodes": nodes_result
    }

@router.get("/api/v1/nodes/{node_id}/cookies", summary="提取目标节点全量 Cookies")
async def external_get_cookies(node_id: int, auth: dict = Depends(verify_agent_access)):
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM nodes WHERE id=?", (node_id,))
    row = cur.fetchone()
    conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="目标节点不存在")
    node = dict(row)

    try:
        target_h = node.get('direct_host', '127.0.0.1') if node['is_local'] else "127.0.0.1"
        cookies = await fetch_cookies_native(node['local_bind_port'], target_h)
        return {
            "code": 200,
            "node_id": node_id,
            "node_name": node["name"],
            "total_cookies": len(cookies),
            "cookies": cookies
        }
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"提取 Cookies 失败: {e}")

@router.post("/api/v1/sync", summary="外部自动化触发全网同步")
async def external_trigger_sync(
    policy_id: Optional[int] = Query(None, description="指定策略ID，留空则执行全部已启用策略"),
    auth: dict = Depends(verify_agent_access)
):
    await execute_sync_task(policy_id)
    return {"code": 200, "message": "Cookie 同步任务已成功触发"}