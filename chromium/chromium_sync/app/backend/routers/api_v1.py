import ipaddress
import secrets
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from config import HUB_PORT, resolve_hub_access_info
from core.db import get_setting, session_scope, set_setting
from core.models import Node
from core.rate_limit import RATE_LIMIT_API_V1_PER_MIN, enforce_rate_limit, get_client_ip
from core.security import verify_agent_access, verify_token
from services.cdp_engine import fetch_cookies_native, inject_cookies_native
from services.sync_service import execute_sync_task
from services.traffic_service import get_live_node_traffic_overlay
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
        return domain_header.split("]")[0] + "]"
    elif ":" in domain_header:
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
        "cluster_join_token": token,
    }


@router.post("/api/remote-access")
def save_remote_access_settings(data: dict, user: dict = Depends(verify_token)):
    if "cluster_join_token" in data and data["cluster_join_token"]:
        set_setting("cluster_join_token", data["cluster_join_token"].strip())
    return {"message": "远程凭据策略已更新"}


# ==================== 2. 对外 Agent 节点列表 (支持 IPv4/IPv6 双栈与流量统计) ====================
@router.get("/api/v1/nodes", summary="获取在线 CDP 节点列表 (支持 IPv6 双栈、同机/异机双视图与实时流量统计)")
def external_list_nodes(
    request: Request,
    online_only: bool = Query(False, description="仅返回当前处于在线连接状态的可用节点"),
    auth: dict = Depends(verify_agent_access),
):
    enforce_rate_limit("api_v1", get_client_ip(request), RATE_LIMIT_API_V1_PER_MIN, 60, "开放 API 请求过于频繁")
    with session_scope() as db:
        rows = [n.to_dict() for n in db.query(Node).order_by(Node.id.asc()).all()]

    overlay = get_live_node_traffic_overlay([r["id"] for r in rows])

    hub_info = resolve_hub_access_info(request)
    ws_scheme = hub_info["ws_scheme"]
    internal_ws_scheme = hub_info.get("internal_ws_scheme", ws_scheme)
    internal_port = hub_info.get("internal_port", HUB_PORT)
    domain = hub_info["public_netloc"]
    same_host_port = hub_info["same_host_port"]
    api_key = get_setting("api_key")

    nodes_result = []
    for r in rows:
        if r.get("api_enabled", 1) == 0 or (r.get("client_type") or "").lower() == "android":
            continue

        node_id = r["id"]
        is_enabled = bool(r.get("enabled", 1))
        conn_type_raw = r.get("conn_type", "direct")
        is_loc = bool(r.get("is_local", 0))
        direct_h = r.get("direct_host") or "127.0.0.1"
        bind_port = r.get("local_bind_port", 9222)

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

        remote_gateway_ws = f"{ws_scheme}://{domain}/cdp/{node_id}/ws?api_key={api_key}"
        internal_gateway_ws = f"{internal_ws_scheme}://127.0.0.1:{internal_port}/cdp/{node_id}/ws?api_key={api_key}"
        same_host_scheme = internal_ws_scheme if (same_host_port == internal_port and not request.headers.get("x-forwarded-proto")) else ws_scheme
        same_host_gateway_ws = f"{same_host_scheme}://127.0.0.1:{same_host_port}/cdp/{node_id}/ws?api_key={api_key}"

        if topology_type in ("direct", "ssh_tunnel"):
            same_host_loopback = f"http://127.0.0.1:{bind_port}"
        else:
            same_host_loopback = None

        connection_views = {
            "same_host_automation": {
                "desc": "与 Hub 部署在同一台机器的自动化脚本",
                "recommended_endpoint": same_host_loopback if same_host_loopback else same_host_gateway_ws,
                "loopback_direct_url": same_host_loopback,
                "local_gateway_url": same_host_gateway_ws,
                "internal_gateway_url": internal_gateway_ws,
                "note": "direct/ssh 优先使用 loopback_direct_url (零延迟裸连)；WSS 反穿/直连使用 local_gateway_url 或 internal_gateway_url",
            },
            "remote_host_automation": {
                "desc": "部署在外部服务器、本地开发机或独立容器的远程自动化脚本 (支持 IPv4/IPv6)",
                "recommended_endpoint": remote_gateway_ws,
                "gateway_url": remote_gateway_ws,
                "note": f"异机强制统一使用 {domain} 安全网关 (已下线公网裸端口，杜绝扫描入侵)",
            },
        }

        ov = overlay.get(node_id, {})
        cdp_rx = int(r.get("cdp_rx_bytes") or 0) + int(ov.get("cdp_rx_delta") or 0)
        cdp_tx = int(r.get("cdp_tx_bytes") or 0) + int(ov.get("cdp_tx_delta") or 0)
        net_rx = int(r.get("net_rx_bytes") or 0) + int(ov.get("net_rx_delta") or 0)
        net_tx = int(r.get("net_tx_bytes") or 0) + int(ov.get("net_tx_delta") or 0)

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
            "cookies_export_url": f"/api/v1/nodes/{node_id}/cookies",
            "traffic": {
                "cdp_rx_bytes": cdp_rx,
                "cdp_tx_bytes": cdp_tx,
                "net_rx_bytes": net_rx,
                "net_tx_bytes": net_tx,
                "active_cdp_streams": int(ov.get("active_cdp_streams") or 0),
                "last_metrics_at": ov.get("last_metrics_at") or r.get("last_metrics_at"),
            },
        })

    return {
        "code": 200,
        "hub_internal_port": hub_info["internal_port"],
        "hub_external_port": same_host_port,
        "total": len(nodes_result),
        "online_count": len([n for n in nodes_result if n["status"] == "connected"]),
        "nodes": nodes_result,
    }


# ==================== 3. 提取目标节点全量 Cookies ====================
@router.get("/api/v1/nodes/{node_id}/cookies", summary="提取目标节点全量 Cookies")
async def external_get_cookies(request: Request, node_id: int, auth: dict = Depends(verify_agent_access)):
    enforce_rate_limit("api_v1", get_client_ip(request), RATE_LIMIT_API_V1_PER_MIN, 60, "开放 API 请求过于频繁")
    with session_scope() as db:
        row = db.get(Node, node_id)
        node = row.to_dict() if row else None

    if not node:
        raise HTTPException(status_code=404, detail="目标节点不存在")
    if node.get("api_enabled", 1) == 0 or (node.get("client_type") or "").lower() == "android":
        raise HTTPException(status_code=403, detail="该节点已禁用第三方 API 接入")

    try:
        c_type = node.get("conn_type")
        target_h = "public-wss" if c_type in ("public_wss", "wss_direct") else ("reverse-nat4" if c_type == "reverse" else (node.get("direct_host", "127.0.0.1") if node["is_local"] else "127.0.0.1"))
        cookies = await fetch_cookies_native(node["local_bind_port"], target_h, node_id=node["id"])
        return {
            "code": 200,
            "node_id": node_id,
            "node_name": node["name"],
            "total_cookies": len(cookies),
            "cookies": cookies,
        }
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"提取 Cookies 失败: {e}")


# ==================== 4. 向目标节点注入 Cookies ====================
@router.post("/api/v1/nodes/{node_id}/cookies", summary="向目标节点注入 Cookies")
async def external_inject_cookies(
    request: Request,
    node_id: int,
    payload: dict,
    auth: dict = Depends(verify_agent_access),
):
    enforce_rate_limit("api_v1", get_client_ip(request), RATE_LIMIT_API_V1_PER_MIN, 60, "开放 API 请求过于频繁")
    with session_scope() as db:
        row = db.get(Node, node_id)
        node = row.to_dict() if row else None

    if not node:
        raise HTTPException(status_code=404, detail="目标节点不存在")
    if node.get("api_enabled", 1) == 0 or (node.get("client_type") or "").lower() == "android":
        raise HTTPException(status_code=403, detail="该节点已禁用第三方 API 接入")

    cookies = payload.get("cookies", [])
    if not isinstance(cookies, list):
        raise HTTPException(status_code=400, detail="cookies 字段必须为列表")

    try:
        c_type = node.get("conn_type")
        target_h = "public-wss" if c_type in ("public_wss", "wss_direct") else ("reverse-nat4" if c_type == "reverse" else (node.get("direct_host", "127.0.0.1") if node["is_local"] else "127.0.0.1"))
        injected = await inject_cookies_native(node["local_bind_port"], cookies, target_h, node_id=node["id"])
        return {
            "code": 200,
            "node_id": node_id,
            "injected_count": injected,
            "message": f"成功向节点 [{node['name']}] 注入 {injected} 条 Cookies",
        }
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"注入 Cookies 失败: {e}")


# ==================== 5. 外部自动化触发同步 ====================
@router.post("/api/v1/sync", summary="外部自动化触发全网同步")
async def external_trigger_sync(
    request: Request,
    policy_id: Optional[int] = Query(None, description="指定策略ID，留空则执行全部已启用策略"),
    auth: dict = Depends(verify_agent_access),
):
    enforce_rate_limit("api_v1_sync", get_client_ip(request), max(10, RATE_LIMIT_API_V1_PER_MIN // 4), 60, "同步触发过于频繁")
    await execute_sync_task(policy_id)
    return {"code": 200, "message": "Cookie 同步任务已成功触发"}