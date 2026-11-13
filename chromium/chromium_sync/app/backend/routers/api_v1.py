import sqlite3
import secrets
import ipaddress
from typing import Optional, List, Tuple
from fastapi import APIRouter, HTTPException, Depends, Request, Query

from config import DB_PATH, HUB_PORT, resolve_hub_access_info
from core.database import get_setting, set_setting, get_db_connection
from core.security import verify_token, verify_agent_access
from services.cdp_engine import fetch_cookies_native, inject_cookies_native
from services.sync_service import execute_sync_task
from services.tunnel_manager import tunnel_mgr

router = APIRouter(tags=["外部 Agent 开放 API"])

# ==================== IPv6 / IPv4 双栈标准化工具 (RFC 2732) ====================
def safe_format_host_port(host: str, port: int, scheme: str = "http") -> str:
    """智能识别 IPv4、IPv6 与域名，符合 RFC 2732 规范 (IPv6 自动加 [])"""
    clean_host = host.strip("[]")
    try:
        ip = ipaddress.ip_address(clean_host)
        if ip.version == 6:
            return f"{scheme}://[{clean_host}]:{port}"
    except ValueError:
        pass
    return f"{scheme}://{clean_host}:{port}"

def extract_host_from_domain(domain_header: str) -> str:
    """安全解析 Host 请求头，防止 IPv6 冒号被切碎"""
    if domain_header.startswith("["):
        # 形如 [2408:8207::1]:8443
        return domain_header.split("]")[0] + "]"
    elif ":" in domain_header:
        # 形如 1.2.3.4:8443 或 example.com:8443
        return domain_header.rsplit(":", 1)[0]
    return domain_header

# ==================== 1. 远程访问与入网通行码设置 ====================
@router.get("/api/remote-access")
def get_remote_access_settings(user: dict = Depends(verify_token)):
    token = get_setting("cluster_join_token")
    if not token:
        token = "hub_join_" + secrets.token_urlsafe(24)
        set_setting("cluster_join_token", token)

    return {
        "api_key": get_setting("api_key"),
        "cluster_join_token": token
    }

@router.post("/api/remote-access")
def save_remote_access_settings(data: dict, user: dict = Depends(verify_token)):
    if "cluster_join_token" in data and data["cluster_join_token"]:
        set_setting("cluster_join_token", data["cluster_join_token"].strip())
    return {"message": "远程凭据策略已更新"}

# ==================== 2. 对外 Agent 节点列表 (支持 IPv4/IPv6 双栈) ====================
@router.get("/api/v1/nodes", summary="获取在线 CDP 节点列表 (支持 IPv6 双栈与同机/异机双视图)")
def external_list_nodes(
    request: Request,
    online_only: bool = Query(False, description="仅返回当前处于在线连接状态的可用节点"),
    auth: dict = Depends(verify_agent_access)
):
    conn = get_db_connection()
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM nodes ORDER BY id ASC")
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()

    hub_info = resolve_hub_access_info(request)
    ws_scheme = hub_info["ws_scheme"]
    domain = hub_info["public_netloc"]
    same_host_port = hub_info["same_host_port"]
    api_key = get_setting('api_key')

    nodes_result = []
    for r in rows:
        node_id = r["id"]
        is_enabled = bool(r.get("enabled", 1))
        conn_type_raw = r.get("conn_type", "direct")
        is_loc = bool(r.get("is_local", 0))
        direct_h = r.get("direct_host") or "127.0.0.1"
        bind_port = r.get("local_bind_port", 9222)
        remote_port = r.get("remote_cdp_port", 9222)

        # 实时在线状态计算
        if not is_enabled:
            real_status = "disabled"
        elif r.get("approval_status", 1) == 0:
            real_status = "pending_approval"
        elif conn_type_raw in ["reverse", "public_wss", "wss_direct"]:
            session = tunnel_mgr.get_reverse_session(node_id)
            real_status = "connected" if (session and not session.is_closed) else "stopped"
        else:
            real_status = r.get("status", "stopped")

        if online_only and real_status != "connected":
            continue

        # 4 种拓扑精准打标
        if conn_type_raw in ["public_wss", "wss_direct"]:
            topology_type = "public_wss"
            topology_desc = "公网 WSS (有独立公网IP / 安全出站长连)"
        elif conn_type_raw == "reverse":
            if direct_h not in ["reverse-nat4", "127.0.0.1", "", None] and not is_loc:
                topology_type = "public_wss"
                topology_desc = "公网 WSS (有独立公网IP / 安全出站长连)"
            else:
                topology_type = "nat4_reverse"
                topology_desc = "NAT4 反向长连 (内网出站穿透 / 无入站端口)"
        elif conn_type_raw in ["ssh", "ssh_tunnel"]:
            topology_type = "ssh_tunnel"
            topology_desc = "SSH 端口映射穿透 (通过 SSH 隧道加密转发)"
        else:
            topology_type = "direct"
            topology_desc = "本地 / 局域网端口直连"

        # 异机标准连接端点 (支持 IPv4 / IPv6 域名及 -p 3000:8443 对外映射端口)
        remote_gateway_ws = f"{ws_scheme}://{domain}/cdp/{node_id}/ws?api_key={api_key}"
        
        # 同机标准连接端点 (使用宿主机对外映射端口 same_host_port，如 3000:8443 场景下为 3000)
        same_host_gateway_ws = f"{ws_scheme}://127.0.0.1:{same_host_port}/cdp/{node_id}/ws?api_key={api_key}"
        
        # 同机裸连端点 (仅 direct 与 ssh 节点具备本地监听端口；反向节点物理上无裸端口)
        if topology_type == "direct":
            same_host_loopback = f"http://127.0.0.1:{bind_port}"
        elif topology_type == "ssh_tunnel":
            same_host_loopback = f"http://127.0.0.1:{bind_port}"
        else:
            same_host_loopback = None  # WSS 反穿 / 公网 WSS 节点无本地 TCP 裸端口

        connection_views = {
            "same_host_automation": {
                "desc": "与 Hub 部署在同一台机器的自动化脚本",
                "recommended_endpoint": same_host_loopback if same_host_loopback else same_host_gateway_ws,
                "loopback_direct_url": same_host_loopback,
                "local_gateway_url": same_host_gateway_ws,
                "note": "direct/ssh 优先使用 loopback_direct_url (零延迟裸连)；WSS 反穿/直连使用 local_gateway_url"
            },
            "remote_host_automation": {
                "desc": "部署在外部服务器、本地开发机或独立容器的远程自动化脚本 (支持 IPv4/IPv6)",
                "recommended_endpoint": remote_gateway_ws,
                "gateway_url": remote_gateway_ws,
                "note": f"异机强制统一使用 {domain} 安全网关 (已下线公网裸端口，杜绝扫描入侵)"
            }
        }

        nodes_result.append({
            "id": node_id,
            "name": r["name"],
            "group_name": r.get("group_name") or "默认分组",
            "conn_type": conn_type_raw,
            "topology_type": topology_type,
            "topology_desc": topology_desc,
            "is_source": bool(r.get("is_source", 0)),
            "is_local": is_loc,
            "status": real_status,
            "cookie_count": r.get("cookie_count", 0),
            "last_sync": r.get("last_sync"),
            "preferred_cdp_url": remote_gateway_ws,
            "connection_views": connection_views,
            "cookies_export_url": f"/api/v1/nodes/{node_id}/cookies"
        })

    return {
        "code": 200,
        "hub_internal_port": hub_info["internal_port"],
        "hub_external_port": same_host_port,
        "total": len(nodes_result),
        "online_count": len([n for n in nodes_result if n["status"] == "connected"]),
        "nodes": nodes_result
    }

# ==================== 3. 提取目标节点全量 Cookies ====================
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
        cookies = await fetch_cookies_native(node['local_bind_port'], target_h, node_id=node['id'])
        return {
            "code": 200,
            "node_id": node_id,
            "node_name": node["name"],
            "total_cookies": len(cookies),
            "cookies": cookies
        }
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"提取 Cookies 失败: {e}")

# ==================== 4. 向目标节点注入 Cookies ====================
@router.post("/api/v1/nodes/{node_id}/cookies", summary="向目标节点注入 Cookies")
async def external_inject_cookies(
    node_id: int,
    payload: dict,
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

    cookies = payload.get("cookies", [])
    if not isinstance(cookies, list):
        raise HTTPException(status_code=400, detail="cookies 字段必须为列表")

    try:
        target_h = node.get('direct_host', '127.0.0.1') if node['is_local'] else "127.0.0.1"
        injected = await inject_cookies_native(node['local_bind_port'], cookies, target_h, node_id=node['id'])
        return {
            "code": 200,
            "node_id": node_id,
            "injected_count": injected,
            "message": f"成功向节点 [{node['name']}] 注入 {injected} 条 Cookies"
        }
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"注入 Cookies 失败: {e}")

# ==================== 5. 外部自动化触发同步 ====================
@router.post("/api/v1/sync", summary="外部自动化触发全网同步")
async def external_trigger_sync(
    policy_id: Optional[int] = Query(None, description="指定策略ID，留空则执行全部已启用策略"),
    auth: dict = Depends(verify_agent_access)
):
    await execute_sync_task(policy_id)
    return {"code": 200, "message": "Cookie 同步任务已成功触发"}