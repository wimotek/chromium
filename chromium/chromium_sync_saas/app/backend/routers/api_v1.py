from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from config import HUB_PORT, resolve_hub_access_info
from core.db import session_scope
from core.models import Node, NodeLease
from core.rate_limit import RATE_LIMIT_API_V1_PER_MIN, enforce_rate_limit, get_client_ip
from core.security import verify_agent_access
from services.audit_service import write_audit_log
from services.cdp_engine import fetch_cookies_native, inject_cookies_native
from services.sync_service import execute_sync_task
from services.traffic_service import get_live_node_traffic_overlay
from services.tunnel_manager import tunnel_mgr

router = APIRouter(tags=["SaaS 多租户开放 Agent API"])


@router.get("/api/v1/nodes", summary="获取当前租户可见的 CDP 节点（自有节点 + 已在市场租用的节点）")
def external_list_nodes(
    request: Request,
    online_only: bool = Query(False, description="仅返回在线可用节点"),
    auth: dict = Depends(verify_agent_access),
):
    enforce_rate_limit("api_v1", get_client_ip(request), RATE_LIMIT_API_V1_PER_MIN, 60, "开放 API 请求过于频繁")
    uid = int(auth["id"])
    api_key = auth.get("api_key", "")

    with session_scope() as db:
        owned_rows = [n.to_dict() for n in db.query(Node).filter(Node.owner_id == uid).order_by(Node.id.asc()).all()]
        active_leases = db.query(NodeLease).filter(NodeLease.buyer_id == uid, NodeLease.status == "active").all()
        lease_map = {l.node_id: l.to_dict() for l in active_leases}
        leased_nodes = []
        if lease_map:
            leased_nodes = [
                n.to_dict()
                for n in db.query(Node).filter(Node.id.in_(list(lease_map.keys()))).order_by(Node.id.asc()).all()
            ]

    combined = [(r, "owner", None) for r in owned_rows] + [(r, "leased_buyer", lease_map.get(r["id"])) for r in leased_nodes]
    overlay = get_live_node_traffic_overlay([r["id"] for r, _, _ in combined])
    hub_info = resolve_hub_access_info(request)
    ws_scheme = hub_info["ws_scheme"]
    internal_ws_scheme = hub_info.get("internal_ws_scheme", ws_scheme)
    internal_port = hub_info.get("internal_port", HUB_PORT)
    domain = hub_info["public_netloc"]
    same_host_port = hub_info["same_host_port"]

    nodes_result = []
    for r, access_role, lease_info in combined:
        if r.get("api_enabled", 1) == 0 or (r.get("client_type") or "").lower() == "android":
            continue
        node_id = r["id"]
        is_enabled = bool(r.get("enabled", 1))
        conn_type_raw = r.get("conn_type", "reverse")
        if not is_enabled:
            real_status = "disabled"
        elif conn_type_raw in ["reverse", "public_wss", "wss_direct"]:
            session = tunnel_mgr.get_reverse_session(node_id)
            real_status = "connected" if (session and not session.is_closed) else "stopped"
        else:
            real_status = "disabled_legacy"

        if online_only and real_status != "connected":
            continue

        remote_gateway_ws = f"{ws_scheme}://{domain}/cdp/{node_id}/ws?api_key={api_key}"
        internal_gateway_ws = f"{internal_ws_scheme}://127.0.0.1:{internal_port}/cdp/{node_id}/ws?api_key={api_key}"
        ov = overlay.get(node_id, {})

        entry = {
            "id": node_id,
            "name": r["name"],
            "access_role": access_role,
            "lease_id": lease_info["id"] if lease_info else None,
            "group_name": r.get("group_name") or "默认分组",
            "conn_type": conn_type_raw,
            "status": real_status,
            "cookie_count": r.get("cookie_count", 0) if access_role == "owner" else 0,
            "preferred_cdp_url": remote_gateway_ws,
            "connection_views": {
                "same_host_automation": {
                    "recommended_endpoint": internal_gateway_ws,
                    "gateway_url": internal_gateway_ws,
                },
                "remote_host_automation": {
                    "recommended_endpoint": remote_gateway_ws,
                    "gateway_url": remote_gateway_ws,
                },
            },
            "cookies_export_url": f"/api/v1/nodes/{node_id}/cookies" if access_role == "owner" else None,
            "traffic": {
                "cdp_rx_bytes": int(r.get("cdp_rx_bytes") or 0) + int(ov.get("cdp_rx_delta") or 0),
                "cdp_tx_bytes": int(r.get("cdp_tx_bytes") or 0) + int(ov.get("cdp_tx_delta") or 0),
                "active_cdp_streams": int(ov.get("active_cdp_streams") or 0),
            },
        }
        nodes_result.append(entry)

    return {
        "code": 200,
        "tenant_id": uid,
        "hub_internal_port": internal_port,
        "hub_external_port": same_host_port,
        "total": len(nodes_result),
        "online_count": len([n for n in nodes_result if n["status"] == "connected"]),
        "nodes": nodes_result,
    }


def _assert_owner_cookie_access(node_id: int, auth: dict) -> dict:
    with session_scope() as db:
        row = db.get(Node, int(node_id))
        if row is None:
            raise HTTPException(status_code=404, detail="目标节点不存在")
        if int(row.owner_id) != int(auth["id"]):
            raise HTTPException(status_code=403, detail="安全红线拦截：共享租赁买家仅可使用 CDP 会话网关，严禁读取或注入宿主节点 Cookie 池")
        if int(row.active_lease_count or 0) > 0:
            raise HTTPException(status_code=409, detail="安全红线拦截：该节点当前正有买家租约使用中，禁止同步或读取 Cookie 池")
        if row.api_enabled == 0 or (row.client_type or "").lower() == "android":
            raise HTTPException(status_code=403, detail="该节点已禁用第三方 API 接入")
        return row.to_dict()


@router.get("/api/v1/nodes/{node_id}/cookies", summary="提取自有空闲节点的 Cookies（严禁租约买家或出租期越权提取）")
async def external_get_cookies(request: Request, node_id: int, auth: dict = Depends(verify_agent_access)):
    client_ip = get_client_ip(request)
    enforce_rate_limit("api_v1", client_ip, RATE_LIMIT_API_V1_PER_MIN, 60, "开放 API 请求过于频繁")
    node = _assert_owner_cookie_access(node_id, auth)
    c_type = node.get("conn_type")
    if c_type not in ("reverse", "public_wss", "wss_direct"):
        raise HTTPException(status_code=400, detail="SaaS 版仅支持公网 WSS 直连或 WSS 反向穿透节点")
    target_h = "public-wss" if c_type in ("public_wss", "wss_direct") else "reverse-nat4"
    cookies = await fetch_cookies_native(node["local_bind_port"], target_h, node_id=node["id"])
    write_audit_log(
        action="api_v1_cookies_read",
        actor_id=auth["id"],
        actor_username=auth["username"],
        target_type="node",
        target_id=node_id,
        ip=client_ip,
        status="ok",
        details={"cookie_count": len(cookies)},
    )
    return {"code": 200, "node_id": node_id, "node_name": node["name"], "total_cookies": len(cookies), "cookies": cookies}


@router.post("/api/v1/nodes/{node_id}/cookies", summary="向自有空闲节点注入 Cookies（出租期间严格锁定禁止）")
async def external_inject_cookies(request: Request, node_id: int, payload: dict, auth: dict = Depends(verify_agent_access)):
    client_ip = get_client_ip(request)
    enforce_rate_limit("api_v1", client_ip, RATE_LIMIT_API_V1_PER_MIN, 60, "开放 API 请求过于频繁")
    node = _assert_owner_cookie_access(node_id, auth)
    cookies = payload.get("cookies", [])
    if not isinstance(cookies, list):
        raise HTTPException(status_code=400, detail="cookies 字段必须为列表")

    c_type = node.get("conn_type")
    if c_type not in ("reverse", "public_wss", "wss_direct"):
        raise HTTPException(status_code=400, detail="SaaS 版仅支持公网 WSS 直连或 WSS 反向穿透节点")
    target_h = "public-wss" if c_type in ("public_wss", "wss_direct") else "reverse-nat4"
    injected = await inject_cookies_native(node["local_bind_port"], cookies, target_h, node_id=node["id"])
    write_audit_log(
        action="api_v1_cookies_inject",
        actor_id=auth["id"],
        actor_username=auth["username"],
        target_type="node",
        target_id=node_id,
        ip=client_ip,
        status="ok",
        details={"injected_count": injected},
    )
    return {"code": 200, "node_id": node_id, "injected_count": injected, "message": f"成功写入 {injected} 条 Cookies"}


@router.post("/api/v1/sync", summary="触发当前租户的自有空闲节点 Cookie 同步（自动跳过出租中节点）")
async def external_trigger_sync(
    request: Request,
    policy_id: Optional[int] = Query(None),
    auth: dict = Depends(verify_agent_access),
):
    enforce_rate_limit("api_v1_sync", get_client_ip(request), max(10, RATE_LIMIT_API_V1_PER_MIN // 4), 60, "同步触发过于频繁")
    await execute_sync_task(policy_id, owner_id=int(auth["id"]))
    return {"code": 200, "message": "本租户自有空闲节点 Cookie 同步已执行完成"}
