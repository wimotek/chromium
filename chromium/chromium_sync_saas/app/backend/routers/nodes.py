import asyncio
from datetime import datetime
import ipaddress
import json
import os
import secrets
import time
from typing import Any, Dict, Optional
from urllib.parse import unquote

from fastapi import APIRouter, Depends, Header as ReqHeader, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from sqlalchemy.orm import Session

from config import logger
from core.db import get_setting, session_scope
from core.models import Node, NodeLease, Plan, TrafficStat, User, UserLevel
from core.rate_limit import (
    JOIN_TOKEN_BLOCK_SECONDS,
    JOIN_TOKEN_FAIL_WINDOW_SEC,
    JOIN_TOKEN_MAX_FAILURES,
    MAX_WS_TUNNELS_PER_IP,
    RATE_LIMIT_DETECT_PER_MIN,
    RATE_LIMIT_REGISTER_PER_MIN,
    check_block,
    check_rate_limit,
    clear_auth_failures,
    enforce_rate_limit,
    get_block_ttl,
    get_client_ip,
    record_auth_failure,
    ws_guard,
)
from core.security import verify_token
from services.audit_service import write_audit_log
from services.billing_service import (
    compute_buyer_price_units,
    is_shareable_conn_type,
    normalize_billing_channel,
    resolve_channel_platform_fee_bps,
)
from services.cdp_engine import fetch_cookies_native, probe_node_cookies, probe_node_with_latency
from services.level_service import record_node_telemetry_sync
from services.traffic_service import get_live_node_traffic_overlay
from services.tunnel_manager import tunnel_mgr

try:
    from wimotek_edge_agent.nat import detect_network_mode as _edge_detect_network_mode
    from wimotek_edge_agent.tokens import SessionTicketManager as _EdgeSessionTicketManager

    HAS_EDGE_AGENT_LIB = True
except ImportError:
    _edge_detect_network_mode = None
    _EdgeSessionTicketManager = None
    HAS_EDGE_AGENT_LIB = False

router = APIRouter(tags=["租户节点管理、零TOFU入网与共享发布"])


def _get_ticket_manager():
    if not HAS_EDGE_AGENT_LIB or _EdgeSessionTicketManager is None:
        return None
    secret_raw = (os.getenv("EDGE_AGENT_TOKEN_SECRET") or get_setting("edge_agent_secret") or "").strip()
    if len(secret_raw.encode("utf-8")) < 32:
        secret_raw = (secret_raw + "0" * 32)[:32]
    ttl = int(os.getenv("EDGE_AGENT_SESSION_TICKET_TTL_SECONDS", "300"))
    return _EdgeSessionTicketManager(secret=secret_raw.encode("utf-8"), ttl_seconds=ttl)


def _issue_session_ticket(node_uuid: str, owner_id: int, fingerprint: str) -> Optional[str]:
    mgr = _get_ticket_manager()
    if mgr is None or not node_uuid:
        return None
    try:
        return mgr.issue(f"{node_uuid}:{int(owner_id)}", fingerprint or "sha256:unknown")
    except Exception:
        return None


def _verify_session_ticket(ticket: Optional[str], node_uuid: str, owner_id: int, fingerprint: str) -> bool:
    if not ticket or not owner_id:
        return False
    mgr = _get_ticket_manager()
    if mgr is None:
        return False
    try:
        return bool(mgr.verify(ticket, f"{node_uuid}:{int(owner_id)}", fingerprint or "sha256:unknown"))
    except Exception:
        return False


def _authenticate_owner_by_join_token(db: Session, presented: Optional[str]) -> Optional[User]:
    tok = (presented or "").strip()
    if not tok:
        return None
    u = db.query(User).filter(User.cluster_join_token == tok).first()
    if u is None or not secrets.compare_digest(tok, u.cluster_join_token):
        return None
    if u.status != "active":
        return None
    return u


def _allow_non_public_probe() -> bool:
    val = os.getenv("EDGE_AGENT_ALLOW_NON_PUBLIC_PROBE", "").strip().lower()
    return val in {"1", "true", "yes", "on"}


def _is_non_public_host(host: Optional[str]) -> bool:
    clean = (host or "").strip().strip("[]").lower()
    if not clean:
        return True
    if clean in {"localhost", "localhost.localdomain", "host.docker.internal", "0.0.0.0", "::", "::1"}:
        return True
    if clean.endswith(".local") or clean.endswith(".internal"):
        return True
    try:
        ip_obj = ipaddress.ip_address(clean)
        return not ip_obj.is_global
    except ValueError:
        return False


async def _run_edge_network_detection(
    public_ipv4: Optional[str] = None,
    public_ipv4_port: Optional[int] = None,
    public_ipv6: Optional[str] = None,
    public_ipv6_port: Optional[int] = None,
    force_reverse: Optional[bool] = None,
) -> Dict[str, Any]:
    timeout_sec = float(os.getenv("EDGE_AGENT_NETWORK_PROBE_TIMEOUT_SECONDS", "2.0"))
    allow_non_public = _allow_non_public_probe()

    if HAS_EDGE_AGENT_LIB and _edge_detect_network_mode is not None:
        det = await _edge_detect_network_mode(
            public_ipv4=public_ipv4,
            public_ipv4_port=public_ipv4_port,
            public_ipv6=public_ipv6,
            public_ipv6_port=public_ipv6_port,
            timeout=timeout_sec,
            allow_non_public=allow_non_public,
            force_reverse=force_reverse,
        )
        d = det.to_dict()
        d["can_direct"] = d.get("network_profile") == "direct" and bool(
            d.get("ipv4_reachable") or d.get("ipv6_reachable")
        )
        d["probe_results"] = {"ipv4": d.get("ipv4"), "ipv6": d.get("ipv6")}
        return d

    async def _tcp_probe(host: Optional[str], port: Optional[int], family: str):
        if not host or not port:
            return None
        try:
            p_int = int(port)
            if not (1 <= p_int <= 65535):
                return {"family": family, "host": host, "port": p_int, "reachable": False, "latency_ms": None, "error": "invalid_port"}
        except (TypeError, ValueError):
            return None
        clean_host = str(host).strip().strip("[]")
        if not allow_non_public:
            try:
                ip_obj = ipaddress.ip_address(clean_host)
                if not ip_obj.is_global:
                    return {"family": family, "host": host, "port": p_int, "reachable": False, "latency_ms": None, "error": "non_public_ip_blocked"}
            except ValueError:
                return {"family": family, "host": host, "port": p_int, "reachable": False, "latency_ms": None, "error": "invalid_ip"}
        t0 = time.perf_counter()
        writer = None
        try:
            _, writer = await asyncio.wait_for(asyncio.open_connection(clean_host, p_int), timeout=timeout_sec)
            lat = round((time.perf_counter() - t0) * 1000, 2)
            return {"family": family, "host": clean_host, "port": p_int, "reachable": True, "latency_ms": lat, "error": None}
        except Exception as exc:
            return {"family": family, "host": clean_host, "port": p_int, "reachable": False, "latency_ms": None, "error": str(exc)}
        finally:
            if writer:
                writer.close()

    if force_reverse is True:
        return {
            "network_mode": "reverse_tunnel",
            "network_profile": "nat4_reverse",
            "ipv4_reachable": False,
            "ipv6_reachable": False,
            "recommended_endpoint": None,
            "can_direct": False,
            "probe_results": {"ipv4": None, "ipv6": None},
        }

    v4_res, v6_res = await asyncio.gather(
        _tcp_probe(public_ipv4, public_ipv4_port, "ipv4"),
        _tcp_probe(public_ipv6, public_ipv6_port, "ipv6"),
    )
    v4_ok = bool(v4_res and v4_res["reachable"])
    v6_ok = bool(v6_res and v6_res["reachable"])
    if v4_ok and v6_ok:
        mode = "direct_dual"
        rec = f"[{v6_res['host']}]:{v6_res['port']}" if v6_res["latency_ms"] < v4_res["latency_ms"] else f"{v4_res['host']}:{v4_res['port']}"
    elif v6_ok:
        mode = "direct_ipv6"
        rec = f"[{v6_res['host']}]:{v6_res['port']}"
    elif v4_ok:
        mode = "direct_ipv4"
        rec = f"{v4_res['host']}:{v4_res['port']}"
    else:
        mode = "reverse_tunnel"
        rec = None

    return {
        "network_mode": mode,
        "network_profile": "direct" if (v4_ok or v6_ok) else "nat4_reverse",
        "ipv4_reachable": v4_ok,
        "ipv6_reachable": v6_ok,
        "recommended_endpoint": rec,
        "can_direct": v4_ok or v6_ok,
        "probe_results": {"ipv4": v4_res, "ipv6": v6_res},
    }


def _split_endpoint_host_port(endpoint: Optional[str], fallback_host: str, fallback_port: int) -> tuple[str, int]:
    if not endpoint:
        return fallback_host, fallback_port
    ep = endpoint.strip()
    if ep.startswith("[") and "]:" in ep:
        h, p = ep[1:].split("]:", 1)
        return h, int(p)
    if ":" in ep and ep.count(":") == 1:
        h, p = ep.rsplit(":", 1)
        return h, int(p)
    return fallback_host, fallback_port


def _get_available_bind_port(
    db: Session,
    preferred_port: int,
    exclude_node_id: Optional[int] = None,
    current_bind_port: Optional[int] = None,
) -> int:
    q = db.query(Node.id).filter(Node.local_bind_port == preferred_port)
    if exclude_node_id is not None:
        q = q.filter(Node.id != exclude_node_id)
    if q.first() is None:
        return preferred_port

    ports_q = db.query(Node.local_bind_port)
    if exclude_node_id is not None:
        ports_q = ports_q.filter(Node.id != exclude_node_id)
    used_ports = {r[0] for r in ports_q.all() if r[0] is not None}

    if current_bind_port and current_bind_port >= 10000 and current_bind_port not in used_ports:
        return current_bind_port

    candidate = 10000
    while candidate in used_ports:
        candidate += 1
    return candidate


def _check_owner_node_quota(db: Session, owner_id: int):
    owner = db.get(User, int(owner_id))
    if owner is None or owner.status != "active":
        raise HTTPException(status_code=403, detail="租户账号不存在或已停用")
    plan = db.get(Plan, owner.plan_id)
    max_nodes = int(plan.max_nodes) if plan else 3
    cur_count = db.query(Node.id).filter(Node.owner_id == owner.id).count()
    if cur_count >= max_nodes:
        raise HTTPException(
            status_code=403,
            detail=f"已达到当前套餐节点配额上限 ({cur_count}/{max_nodes})，请升级套餐或清理空闲节点",
        )


def _get_owned_node_or_404(db: Session, node_id: int, user: dict) -> Node:
    node = db.get(Node, int(node_id))
    if node is None:
        raise HTTPException(status_code=404, detail="节点不存在")
    if int(node.owner_id) != int(user["id"]) and user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="无权操作其他租户名下的节点")
    return node


def _detect_client_type(headers: Any = None, payload: Optional[Dict[str, Any]] = None) -> str:
    p = payload or {}
    raw_hdr = ""
    ua_hdr = ""
    if headers is not None:
        raw_hdr = str(headers.get("x-client-type") or headers.get("X-Client-Type") or "").strip().lower()
        ua_hdr = str(headers.get("user-agent") or headers.get("User-Agent") or "").strip().lower()
    raw_body = str(p.get("client_type") or p.get("os") or "").strip().lower()
    val = raw_body or raw_hdr
    if val == "android" or "android" in ua_hdr:
        return "android"
    if val in {"windows", "win32", "linux", "docker", "macos", "desktop"}:
        return val
    return "desktop"


class DetectModeDTO(BaseModel):
    node_uuid: Optional[str] = None
    cdp_port: int = 9222
    public_ipv4: Optional[str] = None
    public_ipv4_port: Optional[int] = None
    public_ipv6: Optional[str] = None
    public_ipv6_port: Optional[int] = None
    force_reverse: Optional[bool] = None


class NodeAutoRegisterDTO(BaseModel):
    node_uuid: str
    public_key_fingerprint: Optional[str] = ""
    name: Optional[str] = ""
    group_name: Optional[str] = "默认分组"
    conn_type: Optional[str] = None
    cdp_port: int = 9222
    wss_port: Optional[int] = None
    edge_wss_secret: Optional[str] = None
    public_ipv4: Optional[str] = None
    public_ipv4_port: Optional[int] = None
    public_ipv6: Optional[str] = None
    public_ipv6_port: Optional[int] = None
    network_mode: Optional[str] = None
    recommended_endpoint: Optional[str] = None
    ipv4_reachable: Optional[bool] = None
    ipv6_reachable: Optional[bool] = None
    session_ticket: Optional[str] = None
    client_type: Optional[str] = None


class NodeShareConfigDTO(BaseModel):
    share_enabled: bool
    share_title: str = ""
    share_region: str = "Global"
    share_tags: str = ""
    seller_price_per_hour_yuan: float = 0.5
    seller_price_per_gb_yuan: float = 1.0
    max_concurrent_leases: int = 1
    isolation_mode: str = "exclusive_slot"


@router.get("/api/node-groups")
def get_node_groups(user: dict = Depends(verify_token)):
    with session_scope() as db:
        rows = (
            db.query(Node.group_name)
            .filter(Node.owner_id == int(user["id"]), Node.group_name.isnot(None), Node.group_name != "")
            .distinct()
            .all()
        )
        groups = [r[0] for r in rows if r[0]]
    return groups or ["默认分组"]


@router.get("/api/nodes", summary="查询当前租户名下的自有节点与共享上架状态")
def list_my_nodes(user: dict = Depends(verify_token)):
    with session_scope() as db:
        owner = db.get(User, int(user["id"]))
        seller_level = db.get(UserLevel, int(owner.level_id or 1)) if owner else None
        level_code = seller_level.code if seller_level else "lv1"
        level_name = seller_level.name if seller_level else "Lv.1 青铜节点主"
        rows = [
            n.to_dict()
            for n in db.query(Node).filter(Node.owner_id == int(user["id"])).order_by(Node.id.desc()).all()
        ]

    overlay = get_live_node_traffic_overlay([r["id"] for r in rows])
    for r in rows:
        nid = r["id"]
        if r.get("enabled") == 0:
            r["status"] = "disabled"
        elif r.get("conn_type") in ("reverse", "public_wss", "wss_direct"):
            session = tunnel_mgr.get_reverse_session(nid)
            r["status"] = "connected" if (session and not session.is_closed) else "stopped"

        ov = overlay.get(nid, {})
        r["cdp_rx_bytes"] = int(r.get("cdp_rx_bytes") or 0) + int(ov.get("cdp_rx_delta") or 0)
        r["cdp_tx_bytes"] = int(r.get("cdp_tx_bytes") or 0) + int(ov.get("cdp_tx_delta") or 0)
        r["net_rx_bytes"] = int(r.get("net_rx_bytes") or 0) + int(ov.get("net_rx_delta") or 0)
        r["net_tx_bytes"] = int(r.get("net_tx_bytes") or 0) + int(ov.get("net_tx_delta") or 0)
        r["active_cdp_streams"] = int(ov.get("active_cdp_streams") or 0)
        r["last_metrics_at"] = ov.get("last_metrics_at") or r.get("last_metrics_at")

        # 按接入通道 + 卖家当前等级计算平台差价预览（仅 WSS 直连 / WSS 反向穿透可共享）
        ch = normalize_billing_channel(r.get("conn_type"))
        shareable = is_shareable_conn_type(r.get("conn_type"))
        fee_bps = resolve_channel_platform_fee_bps(r.get("conn_type"), seller_level)
        b_hr, _, spread_hr = compute_buyer_price_units(int(r.get("seller_price_per_hour_units") or 0), fee_bps, 0)
        b_gb, _, spread_gb = compute_buyer_price_units(int(r.get("seller_price_per_gb_units") or 0), fee_bps, 0)
        r["channel_type"] = ch
        r["is_shareable"] = shareable
        r["platform_fee_bps"] = fee_bps
        r["seller_level_code"] = level_code
        r["seller_level_name"] = level_name
        r["buyer_preview_hour_units"] = b_hr
        r["buyer_preview_gb_units"] = b_gb
        r["platform_spread_hour_units"] = spread_hr
        r["platform_spread_gb_units"] = spread_gb

    return rows


@router.put("/api/nodes/{node_id}")
async def update_node(node_id: int, data: dict, request: Request, user: dict = Depends(verify_token)):
    with session_scope() as db:
        node = _get_owned_node_or_404(db, node_id, user)
        orig_node = node.to_dict()
        if data.get("conn_type") is not None and data.get("conn_type") not in ("reverse", "public_wss", "wss_direct"):
            raise HTTPException(status_code=400, detail="SaaS 版仅支持 public_wss（公网 WSS 直连）或 reverse（WSS 反向穿透）节点")

        is_android = (orig_node.get("client_type") or "").lower() == "android"
        req_api = data.get("api_enabled", orig_node.get("api_enabled", 1))
        api_enabled_val = 0 if req_api in (0, False, "0") else 1
        if is_android:
            if "api_enabled" in data and api_enabled_val == 1:
                raise HTTPException(status_code=403, detail="Android 移动节点自动锁定禁用第三方 API 接入")
            api_enabled_val = 0

        grp_name = (data.get("group_name") or "默认分组").strip()
        name = (data.get("name") or orig_node["name"]).strip()
        l_port = _get_available_bind_port(
            db,
            int(data.get("local_bind_port") or orig_node["local_bind_port"]),
            exclude_node_id=node_id,
            current_bind_port=orig_node["local_bind_port"],
        )

        node.name = name
        node.group_name = grp_name
        node.local_bind_port = l_port
        node.api_enabled = api_enabled_val
        if orig_node.get("conn_type") in ("public_wss", "wss_direct"):
            if "wss_endpoint" in data and str(data.get("wss_endpoint") or "").strip():
                node.wss_endpoint = str(data.get("wss_endpoint")).strip()[:255]
                node.recommended_endpoint = node.wss_endpoint
            if "edge_wss_secret" in data and data.get("edge_wss_secret") is not None:
                node.edge_wss_secret = str(data.get("edge_wss_secret")).strip()[:255]

        db.flush()
        updated_node = node.to_dict()

    if updated_node.get("enabled", 1) == 1:
        await tunnel_mgr.start_tunnel(updated_node)

    write_audit_log(
        action="node_update",
        actor_id=user["id"],
        actor_username=user["username"],
        target_type="node",
        target_id=node_id,
        ip=get_client_ip(request),
        status="ok",
    )
    return {"message": "节点配置已更新"}


@router.post("/api/nodes/{node_id}/share", summary="上架/定价/下架共享节点到 SaaS 交易市场")
def configure_node_sharing(node_id: int, data: NodeShareConfigDTO, request: Request, user: dict = Depends(verify_token)):
    from core.models import yuan_to_units

    with session_scope() as db:
        owner = db.get(User, int(user["id"]))
        plan = db.get(Plan, owner.plan_id) if owner else None
        seller_level = db.get(UserLevel, int(owner.level_id or 1)) if owner else None
        if data.share_enabled and plan and not plan.can_share_nodes:
            raise HTTPException(status_code=403, detail="您当前的套餐暂不支持节点共享出租")

        node = _get_owned_node_or_404(db, node_id, user)
        if data.share_enabled:
            if (node.client_type or "").lower() == "android" or node.api_enabled == 0:
                raise HTTPException(status_code=403, detail="Android 或禁用 API 的节点不可作为共享 CDP 算力节点出租")
            if not is_shareable_conn_type(node.conn_type):
                raise HTTPException(
                    status_code=403,
                    detail="SaaS 版仅支持公网 WSS 直连或 WSS 反向穿透节点上架共享",
                )

        seller_hr = max(0, yuan_to_units(data.seller_price_per_hour_yuan))
        seller_gb = max(0, yuan_to_units(data.seller_price_per_gb_yuan))
        iso_mode = data.isolation_mode if data.isolation_mode in {"exclusive_slot", "ephemeral_profile"} else "exclusive_slot"
        max_leases = max(1, min(8, int(data.max_concurrent_leases or 1)))
        if iso_mode == "exclusive_slot":
            max_leases = 1

        node.share_enabled = 1 if data.share_enabled else 0
        node.share_title = (data.share_title or node.name).strip()[:255]
        node.share_region = (data.share_region or "Global").strip()[:64]
        node.share_tags = (data.share_tags or "").strip()[:255]
        node.seller_price_per_hour_units = seller_hr
        node.seller_price_per_gb_units = seller_gb
        node.isolation_mode = iso_mode
        node.max_concurrent_leases = max_leases
        db.flush()
        saved = node.to_dict()
        fee_bps = resolve_channel_platform_fee_bps(saved.get("conn_type"), seller_level)
        seller_lv_code = seller_level.code if seller_level else "lv1"

    channel_type = normalize_billing_channel(saved.get("conn_type"))
    b_hr, _, sp_hr = compute_buyer_price_units(saved["seller_price_per_hour_units"], fee_bps, 0)
    b_gb, _, sp_gb = compute_buyer_price_units(saved["seller_price_per_gb_units"], fee_bps, 0)

    write_audit_log(
        action="node_share_config",
        actor_id=user["id"],
        actor_username=user["username"],
        target_type="node",
        target_id=node_id,
        ip=get_client_ip(request),
        status="ok",
        details={
            "share_enabled": bool(saved["share_enabled"]),
            "channel_type": channel_type,
            "seller_level": seller_lv_code,
            "platform_fee_bps": fee_bps,
            "seller_hr_units": saved["seller_price_per_hour_units"],
            "seller_gb_units": saved["seller_price_per_gb_units"],
            "isolation_mode": iso_mode,
            "max_concurrent_leases": max_leases,
        },
    )
    return {
        "message": "已上架至共享交易市场" if saved["share_enabled"] else "已从共享交易市场下架",
        "node": saved,
        "pricing_preview": {
            "channel_type": channel_type,
            "seller_level_code": seller_lv_code,
            "platform_fee_bps": fee_bps,
            "buyer_hour_units": b_hr,
            "buyer_gb_units": b_gb,
            "spread_hour_units": sp_hr,
            "spread_gb_units": sp_gb,
        },
    }


@router.delete("/api/nodes/{node_id}")
async def delete_node(node_id: int, request: Request, user: dict = Depends(verify_token)):
    with session_scope() as db:
        node = _get_owned_node_or_404(db, node_id, user)
        active_leases = db.query(NodeLease).filter(NodeLease.node_id == node_id, NodeLease.status == "active").count()
        if active_leases > 0:
            raise HTTPException(status_code=409, detail="该节点仍有进行中的市场租约，请先下架并等待租约结束或由管理员强制中止")

    tunnel_mgr.stop_tunnel(node_id)
    tunnel_mgr.stop_public_wss_session(node_id)
    tunnel_mgr.unregister_reverse_tunnel(node_id)

    with session_scope() as db:
        db.query(TrafficStat).filter(TrafficStat.node_id == node_id).delete(synchronize_session=False)
        db.query(Node).filter(Node.id == node_id).delete(synchronize_session=False)

    write_audit_log(
        action="node_delete",
        actor_id=user["id"],
        actor_username=user["username"],
        target_type="node",
        target_id=node_id,
        ip=get_client_ip(request),
        status="ok",
    )
    return {"message": "自有节点已移除"}


# ==================== 零 TOFU：网络探测与严格凭据入网 ====================
@router.get("/api/nodes/detect-mode")
async def detect_node_reachability_get(request: Request, cdp_port: int = Query(9222)):
    return await _handle_detect_mode(request, DetectModeDTO(cdp_port=cdp_port))


@router.post("/api/nodes/detect-mode")
async def detect_node_reachability_post(data: DetectModeDTO, request: Request):
    return await _handle_detect_mode(request, data)


async def _handle_detect_mode(request: Request, data: DetectModeDTO) -> Dict[str, Any]:
    client_ip = get_client_ip(request)
    check_block("join_token", client_ip, "当前来源 IP 已被临时限制，请稍后再试")
    enforce_rate_limit("detect_mode", client_ip, RATE_LIMIT_DETECT_PER_MIN, 60, "网络探测请求过于频繁，请稍后再试")

    v4_host = data.public_ipv4
    v6_host = data.public_ipv6
    if not v4_host and not v6_host and client_ip:
        try:
            ip_obj = ipaddress.ip_address(client_ip.strip("[]"))
            if ip_obj.version == 6:
                v6_host = str(ip_obj)
            else:
                v4_host = str(ip_obj)
        except ValueError:
            v4_host = client_ip

    det = await _run_edge_network_detection(
        public_ipv4=v4_host,
        public_ipv4_port=(data.public_ipv4_port or data.cdp_port) if v4_host else None,
        public_ipv6=v6_host,
        public_ipv6_port=(data.public_ipv6_port or data.cdp_port) if v6_host else None,
        force_reverse=data.force_reverse,
    )
    rec_host, rec_port = _split_endpoint_host_port(
        det.get("recommended_endpoint"),
        v4_host or v6_host or client_ip,
        data.cdp_port,
    )
    det["detected_ip"] = rec_host
    det["recommended_port"] = rec_port
    return det


@router.post("/api/nodes/auto-register", summary="零 TOFU 公网 WSS 直连鉴权入网（仅支持公网 WSS 直连或 WSS 反向穿透）")
async def http_auto_register_node(
    data: NodeAutoRegisterDTO,
    request: Request,
    x_join_token: Optional[str] = ReqHeader(None),
):
    client_ip = get_client_ip(request)
    check_block("join_token", client_ip, "无效 JOIN_TOKEN 尝试过多，当前 IP 已被临时封禁")
    enforce_rate_limit("auto_register", client_ip, RATE_LIMIT_REGISTER_PER_MIN, 60, "节点注册请求过于频繁，请稍后再试")

    fp = data.public_key_fingerprint or ""
    fallback_ip = "127.0.0.1" if client_ip in ["127.0.0.1", "localhost", "::1"] else client_ip
    is_public_wss = (
        data.conn_type in ("public_wss", "wss_direct")
        or bool(data.wss_port)
        or bool(data.edge_wss_secret)
    )
    if not is_public_wss:
        raise HTTPException(
            status_code=400,
            detail="SaaS 多租户版已移除直连 127.0.0.1 与 SSH 节点，/auto-register 仅允许公网 WSS 直连（NAT 客户端请直接接入 WSS 反向穿透）",
        )

    default_probe_port = int(data.wss_port or 9443)
    direct_ip, rec_port = _split_endpoint_host_port(
        data.recommended_endpoint,
        data.public_ipv4 or data.public_ipv6 or fallback_ip,
        default_probe_port,
    )
    if _is_non_public_host(direct_ip) and not _allow_non_public_probe():
        raise HTTPException(
            status_code=400,
            detail="公网 WSS 直连节点必须提供可路由公网 IP/域名；内网环境请使用 /api/nodes/reverse-tunnel 反向穿透接入",
        )

    node_name = (data.name or "").strip() or f"Edge-{data.node_uuid[:6]}"
    grp_name = (data.group_name or "").strip() or "默认分组"
    net_mode = data.network_mode or ("direct_ipv6" if ":" in direct_ip else "direct_ipv4")
    rec_ep = data.recommended_endpoint or (f"[{direct_ip}]:{rec_port}" if ":" in direct_ip else f"{direct_ip}:{rec_port}")
    v4_ok = 1 if data.ipv4_reachable else (1 if ":" not in direct_ip else 0)
    v6_ok = 1 if data.ipv6_reachable else (1 if ":" in direct_ip else 0)

    conn_type_val = "public_wss"
    remote_cdp_val = int(data.cdp_port or 9222)
    preferred_bind_port = rec_port or remote_cdp_val
    wss_endpoint_val = rec_ep
    edge_secret_val = (data.edge_wss_secret or "").strip()
    client_type_val = _detect_client_type(request.headers, {"client_type": data.client_type})
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    with session_scope() as db:
        existing = db.query(Node).filter(Node.node_uuid == data.node_uuid).first()
        token_owner = _authenticate_owner_by_join_token(db, x_join_token)
        if token_owner is not None:
            owner_id = token_owner.id
            owner_name = token_owner.username
            clear_auth_failures("join_token", client_ip)
            decision = "allow_user_join_token"
        elif existing is not None and _verify_session_ticket(data.session_ticket, data.node_uuid, existing.owner_id, fp):
            owner_obj = db.get(User, existing.owner_id)
            if owner_obj is None or owner_obj.status != "active":
                raise HTTPException(status_code=403, detail="归属租户已被停用")
            owner_id = owner_obj.id
            owner_name = owner_obj.username
            decision = "allow_session_ticket"
        else:
            _, blk = record_auth_failure(
                "join_token",
                client_ip,
                max_failures=JOIN_TOKEN_MAX_FAILURES,
                fail_window_sec=JOIN_TOKEN_FAIL_WINDOW_SEC,
                block_sec=JOIN_TOKEN_BLOCK_SECONDS,
            )
            write_audit_log(
                action="node_register_denied",
                actor_username="anonymous",
                target_type="node_uuid",
                target_id=data.node_uuid,
                ip=client_ip,
                status="deny",
                details={"reason": "invalid_join_token_no_tofu"},
            )
            if blk > 0:
                raise HTTPException(status_code=429, detail=f"无效入网凭证尝试过多，封禁 {blk} 秒", headers={"Retry-After": str(blk)})
            raise HTTPException(status_code=403, detail="SaaS 多租户版本已永久移除 TOFU，请在客户端配置您的专属 JOIN_TOKEN")

        if existing is not None:
            if int(existing.owner_id) != int(owner_id):
                write_audit_log(
                    action="node_hijack_blocked",
                    actor_id=owner_id,
                    actor_username=owner_name,
                    target_type="node",
                    target_id=existing.id,
                    ip=client_ip,
                    status="deny",
                    details={"existing_owner_id": existing.owner_id, "node_uuid": data.node_uuid},
                )
                raise HTTPException(status_code=403, detail="节点 UUID 已被其他租户绑定，拒绝越权覆盖")
            node_id = existing.id
            prev_conn_type = existing.conn_type
            node_enabled = existing.enabled if existing.enabled is not None else 1
            api_enabled_val = 0 if client_type_val == "android" else (existing.api_enabled if existing.api_enabled is not None else 1)
            allocated_port = _get_available_bind_port(db, preferred_bind_port, exclude_node_id=node_id, current_bind_port=existing.local_bind_port)
            existing.conn_type = conn_type_val
            existing.remote_cdp_port = remote_cdp_val
            existing.local_bind_port = allocated_port
            existing.name = node_name
            existing.group_name = grp_name
            existing.status = "disabled" if node_enabled == 0 else "connected"
            existing.fingerprint = fp
            existing.network_mode = net_mode
            existing.recommended_endpoint = rec_ep
            existing.wss_endpoint = wss_endpoint_val
            existing.edge_wss_secret = edge_secret_val
            existing.ipv4_reachable = v4_ok
            existing.ipv6_reachable = v6_ok
            existing.client_type = client_type_val
            existing.api_enabled = api_enabled_val
            db.flush()
            saved_node = existing.to_dict()
        else:
            prev_conn_type = None
            node_enabled = 1
            _check_owner_node_quota(db, owner_id)
            api_enabled_val = 0 if client_type_val == "android" else 1
            allocated_port = _get_available_bind_port(db, preferred_bind_port)
            new_node = Node(
                owner_id=owner_id,
                name=node_name,
                group_name=grp_name,
                enabled=1,
                conn_type=conn_type_val,
                node_uuid=data.node_uuid,
                fingerprint=fp,
                is_source=0,
                remote_cdp_port=remote_cdp_val,
                local_bind_port=allocated_port,
                status="connected",
                network_mode=net_mode,
                recommended_endpoint=rec_ep,
                wss_endpoint=wss_endpoint_val,
                edge_wss_secret=edge_secret_val,
                ipv4_reachable=v4_ok,
                ipv6_reachable=v6_ok,
                client_type=client_type_val,
                api_enabled=api_enabled_val,
                created_at=now_str,
            )
            db.add(new_node)
            db.flush()
            node_id = new_node.id
            saved_node = new_node.to_dict()

    if prev_conn_type == "reverse":
        tunnel_mgr.unregister_reverse_tunnel(node_id)
    if node_enabled == 1:
        tunnel_mgr.ensure_public_wss_session(saved_node)

    session_ticket = _issue_session_ticket(data.node_uuid, owner_id, fp)
    write_audit_log(
        action="node_auto_register",
        actor_id=owner_id,
        actor_username=owner_name,
        target_type="node",
        target_id=node_id,
        ip=client_ip,
        status="ok",
        details={"decision": decision, "node_uuid": data.node_uuid, "conn_type": conn_type_val},
    )
    return {
        "code": 200,
        "node_id": node_id,
        "owner_id": owner_id,
        "conn_type": conn_type_val,
        "network_mode": net_mode,
        "network_profile": "direct",
        "recommended_endpoint": rec_ep,
        "session_ticket": session_ticket,
        "message": "已完成强身份鉴权并以公网 WSS 直连模式接入 SaaS 集群",
    }


@router.websocket("/api/nodes/reverse-tunnel")
async def reverse_tunnel_endpoint(
    websocket: WebSocket,
    uuid: Optional[str] = Query(None),
    fingerprint: Optional[str] = Query(None),
    name: Optional[str] = Query(None),
    group: Optional[str] = Query(None),
    token: Optional[str] = Query(None),
    port: Optional[int] = Query(None),
):
    client_ip = get_client_ip(websocket)
    if get_block_ttl("join_token", client_ip) > 0:
        await websocket.close(code=1008, reason="Temporarily blocked due to auth failures")
        return

    allowed_ws, _, _ = check_rate_limit("ws_reverse", client_ip, RATE_LIMIT_REGISTER_PER_MIN, 60)
    if not allowed_ws:
        await websocket.close(code=1008, reason="WebSocket connect rate limit exceeded")
        return

    if not ws_guard.acquire("reverse", client_ip, MAX_WS_TUNNELS_PER_IP):
        await websocket.close(code=1008, reason="Too many concurrent tunnels from IP")
        return

    try:
        await _run_reverse_tunnel_session(
            websocket=websocket,
            client_ip=client_ip,
            uuid=uuid,
            fingerprint=fingerprint,
            name=name,
            group=group,
            token=token,
            port=port,
        )
    finally:
        ws_guard.release("reverse", client_ip)


async def _run_reverse_tunnel_session(
    websocket: WebSocket,
    client_ip: str,
    uuid: Optional[str] = None,
    fingerprint: Optional[str] = None,
    name: Optional[str] = None,
    group: Optional[str] = None,
    token: Optional[str] = None,
    port: Optional[int] = None,
):
    await websocket.accept()
    node_id: Optional[int] = None

    try:
        cdp_port = int(websocket.headers.get("x-cdp-port") or port or 9222)
    except Exception:
        cdp_port = port or 9222

    node_uuid = websocket.headers.get("x-node-uuid") or uuid or websocket.query_params.get("uuid")
    node_fp = websocket.headers.get("x-node-fingerprint") or fingerprint or websocket.query_params.get("fingerprint") or ""
    enroll_token = websocket.headers.get("x-join-token") or token or websocket.query_params.get("token")
    node_name = unquote(websocket.headers.get("x-node-name") or "") or name or websocket.query_params.get("name")
    node_group = unquote(websocket.headers.get("x-node-group") or "") or group or "默认分组"

    handshake_data: Dict[str, Any] = {}
    try:
        first_msg_raw = await asyncio.wait_for(websocket.receive_text(), timeout=8.0)
        handshake_data = json.loads(first_msg_raw)
        node_uuid = handshake_data.get("node_uuid") or node_uuid
        node_fp = handshake_data.get("public_key_fingerprint") or node_fp
        enroll_token = handshake_data.get("join_token") or enroll_token
        node_name = handshake_data.get("name") or node_name
        node_group = handshake_data.get("group") or node_group
        cdp_port = int(handshake_data.get("port") or cdp_port)
    except Exception as e:
        if not node_uuid:
            await websocket.close(code=1008, reason=f"Handshake missing node_uuid: {e}")
            return

    if not node_uuid:
        await websocket.close(code=1008, reason="Missing node_uuid")
        return

    pub_v4 = handshake_data.get("public_ipv4")
    pub_v4_port = handshake_data.get("public_ipv4_port") or (cdp_port if pub_v4 else None)
    pub_v6 = handshake_data.get("public_ipv6")
    pub_v6_port = handshake_data.get("public_ipv6_port") or (cdp_port if pub_v6 else None)
    reported_port = int(handshake_data.get("external_port") or handshake_data.get("wss_port") or pub_v4_port or pub_v6_port or cdp_port)
    session_ticket = handshake_data.get("session_ticket")
    forced_reverse = handshake_data.get("reverse_tunnel")
    client_type_val = _detect_client_type(websocket.headers, handshake_data)

    if (pub_v4 or pub_v6) and forced_reverse is not True:
        detection = await _run_edge_network_detection(pub_v4, pub_v4_port, pub_v6, pub_v6_port)
    else:
        detection = {
            "network_mode": "reverse_tunnel",
            "network_profile": "nat4_reverse",
            "ipv4_reachable": False,
            "ipv6_reachable": False,
            "recommended_endpoint": None,
            "probe_results": {"ipv4": None, "ipv6": None},
        }

    net_mode = detection.get("network_mode", "reverse_tunnel")
    net_profile = detection.get("network_profile", "nat4_reverse")
    rec_endpoint = detection.get("recommended_endpoint") or ""
    v4_ok_int = 1 if detection.get("ipv4_reachable") else 0
    v6_ok_int = 1 if detection.get("ipv6_reachable") else 0
    node_name = node_name or f"Edge-{node_uuid[:6]}"
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    owner_id = 0
    owner_name = ""
    prev_conn_type = None
    try:
        with session_scope() as db:
            existing_row = db.query(Node).filter(Node.node_uuid == node_uuid).first()
            token_owner = _authenticate_owner_by_join_token(db, enroll_token)
            if token_owner is not None:
                clear_auth_failures("join_token", client_ip)
                owner_id = token_owner.id
                owner_name = token_owner.username
                decision = "allow_user_join_token"
            elif existing_row is not None and _verify_session_ticket(session_ticket, node_uuid, existing_row.owner_id, node_fp):
                owner_obj = db.get(User, existing_row.owner_id)
                if owner_obj is None or owner_obj.status != "active":
                    await websocket.close(code=1008, reason="Tenant account suspended")
                    return
                owner_id = owner_obj.id
                owner_name = owner_obj.username
                decision = "allow_session_ticket"
            else:
                record_auth_failure(
                    "join_token",
                    client_ip,
                    max_failures=JOIN_TOKEN_MAX_FAILURES,
                    fail_window_sec=JOIN_TOKEN_FAIL_WINDOW_SEC,
                    block_sec=JOIN_TOKEN_BLOCK_SECONDS,
                )
                write_audit_log(
                    action="ws_tunnel_denied",
                    actor_username="anonymous",
                    target_type="node_uuid",
                    target_id=node_uuid,
                    ip=client_ip,
                    status="deny",
                    details={"reason": "invalid_join_token_or_ticket_no_tofu"},
                )
                await websocket.close(code=1008, reason="SaaS Mode requires valid User JOIN_TOKEN (TOFU disabled)")
                return

            if existing_row is not None:
                if int(existing_row.owner_id) != int(owner_id):
                    write_audit_log(
                        action="ws_tunnel_hijack_blocked",
                        actor_id=owner_id,
                        actor_username=owner_name,
                        target_type="node",
                        target_id=existing_row.id,
                        ip=client_ip,
                        status="deny",
                        details={"existing_owner_id": existing_row.owner_id, "node_uuid": node_uuid},
                    )
                    await websocket.close(code=1008, reason="node_uuid belongs to another tenant")
                    return
                node_id = existing_row.id
                prev_conn_type = existing_row.conn_type
                allocated_port = _get_available_bind_port(db, reported_port, exclude_node_id=node_id, current_bind_port=existing_row.local_bind_port)
                is_cur_enabled = existing_row.enabled if existing_row.enabled is not None else 1
                api_enabled_val = 0 if client_type_val == "android" else (existing_row.api_enabled if existing_row.api_enabled is not None else 1)

                existing_row.conn_type = "reverse"
                existing_row.wss_endpoint = ""
                existing_row.edge_wss_secret = ""
                existing_row.remote_cdp_port = cdp_port
                existing_row.local_bind_port = allocated_port
                existing_row.status = "disabled" if is_cur_enabled == 0 else "connected"
                existing_row.name = node_name
                existing_row.group_name = node_group
                existing_row.fingerprint = node_fp
                existing_row.network_mode = net_mode
                existing_row.recommended_endpoint = rec_endpoint
                existing_row.ipv4_reachable = v4_ok_int
                existing_row.ipv6_reachable = v6_ok_int
                existing_row.client_type = client_type_val
                existing_row.api_enabled = api_enabled_val
            else:
                owner_obj = db.get(User, owner_id)
                plan = db.get(Plan, owner_obj.plan_id) if owner_obj else None
                max_nodes = int(plan.max_nodes) if plan else 3
                cur_cnt = db.query(Node.id).filter(Node.owner_id == owner_id).count()
                if cur_cnt >= max_nodes:
                    await websocket.close(code=1008, reason=f"Plan quota exceeded ({cur_cnt}/{max_nodes} nodes)")
                    return

                api_enabled_val = 0 if client_type_val == "android" else 1
                allocated_port = _get_available_bind_port(db, reported_port)
                new_node = Node(
                    owner_id=owner_id,
                    name=node_name,
                    group_name=node_group,
                    enabled=1,
                    conn_type="reverse",
                    node_uuid=node_uuid,
                    fingerprint=node_fp,
                    is_source=0,
                    remote_cdp_port=cdp_port,
                    local_bind_port=allocated_port,
                    status="connected",
                    network_mode=net_mode,
                    recommended_endpoint=rec_endpoint,
                    ipv4_reachable=v4_ok_int,
                    ipv6_reachable=v6_ok_int,
                    client_type=client_type_val,
                    api_enabled=api_enabled_val,
                    created_at=now_str,
                )
                db.add(new_node)
                db.flush()
                node_id = new_node.id
    except Exception as db_err:
        logger.error(f"❌ [SaaS Tunnel] 写入节点失败: {db_err}", exc_info=True)
        await websocket.close(code=1011, reason="Database Error")
        return

    if prev_conn_type in ("public_wss", "wss_direct"):
        tunnel_mgr.stop_public_wss_session(node_id)

    session = tunnel_mgr.register_reverse_tunnel(node_id, websocket, owner_id=owner_id)
    write_audit_log(
        action="ws_tunnel_connected",
        actor_id=owner_id,
        actor_username=owner_name,
        target_type="node",
        target_id=node_id,
        ip=client_ip,
        status="ok",
        details={"decision": decision, "node_uuid": node_uuid, "network_mode": net_mode},
    )

    issued_ticket = _issue_session_ticket(node_uuid, owner_id, node_fp)
    await session.send_raw_json({
        "status": "ok",
        "decision": decision,
        "owner_id": owner_id,
        "session_ticket": issued_ticket,
        "network_mode": net_mode,
        "network_profile": net_profile,
        "ipv4_reachable": bool(v4_ok_int),
        "ipv6_reachable": bool(v6_ok_int),
        "recommended_endpoint": rec_endpoint or None,
        "probe_results": detection.get("probe_results"),
        "client_type": client_type_val,
        "api_enabled": bool(api_enabled_val),
    })

    async def _auto_probe(nid: int, lport: int):
        try:
            await asyncio.sleep(1.2)
            c_cnt, _ = await probe_node_cookies(lport, node_id=nid)
            with session_scope() as db:
                n = db.get(Node, nid)
                if n is not None and (n.enabled if n.enabled is not None else 1) == 1:
                    n.cookie_count = c_cnt
                    n.status = "connected"
        except Exception:
            pass

    asyncio.create_task(_auto_probe(node_id, allocated_port))

    try:
        while True:
            text = await websocket.receive_text()
            if text in ["ping", "pong"]:
                await websocket.send_text("pong")
                continue
            handled_control = False
            try:
                parsed = json.loads(text)
                if isinstance(parsed, dict):
                    if parsed.get("action") == "ping" or parsed.get("type") == "ping":
                        await websocket.send_text("pong")
                        handled_control = True
                    elif parsed.get("type") == "network_probe":
                        ok_probe, _, _ = check_rate_limit("ws_probe", str(node_id), 6, 60)
                        if not ok_probe:
                            await session.send_raw_json({"type": "network_probe_result", "error": "rate_limited"})
                            handled_control = True
                            continue
                        re_det = await _run_edge_network_detection(
                            public_ipv4=parsed.get("public_ipv4") or parsed.get("ipv4"),
                            public_ipv4_port=parsed.get("public_ipv4_port") or parsed.get("ipv4_port") or parsed.get("port"),
                            public_ipv6=parsed.get("public_ipv6") or parsed.get("ipv6"),
                            public_ipv6_port=parsed.get("public_ipv6_port") or parsed.get("ipv6_port") or parsed.get("port"),
                        )
                        with session_scope() as db:
                            n = db.get(Node, node_id)
                            if n is not None:
                                n.network_mode = re_det.get("network_mode", "")
                                n.recommended_endpoint = re_det.get("recommended_endpoint") or ""
                                n.ipv4_reachable = 1 if re_det.get("ipv4_reachable") else 0
                                n.ipv6_reachable = 1 if re_det.get("ipv6_reachable") else 0
                        await session.send_raw_json({"type": "network_probe_result", **re_det})
                        handled_control = True
            except Exception:
                pass

            if not handled_control:
                session.handle_incoming_text(text)
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        if node_id:
            tunnel_mgr.unregister_reverse_tunnel(node_id, expected_session=session)
            if tunnel_mgr.get_reverse_session(node_id) is None:
                try:
                    with session_scope() as db:
                        n = db.get(Node, node_id)
                        if n is not None and (n.enabled if n.enabled is not None else 1) == 1:
                            n.status = "stopped"
                except Exception:
                    pass


@router.get("/api/nodes/{node_id}/cookie-details")
async def get_node_cookie_details(node_id: int, user: dict = Depends(verify_token)):
    with session_scope() as db:
        row = _get_owned_node_or_404(db, node_id, user)
        if int(row.active_lease_count or 0) > 0:
            raise HTTPException(status_code=409, detail="该节点当前正在市场出租中，为隔离保护买家隐私，暂禁止查看实时 Cookie 明细")
        node = row.to_dict()

    now_ts = time.time()
    c_type = node.get("conn_type")
    if c_type not in ("reverse", "public_wss", "wss_direct"):
        raise HTTPException(status_code=400, detail="SaaS 版仅支持公网 WSS 直连或 WSS 反向穿透节点")
    target_h = "public-wss" if c_type in ("public_wss", "wss_direct") else "reverse-nat4"
    raw_cookies = await fetch_cookies_native(node["local_bind_port"], target_h, node_id=node["id"])
    analyzed = []
    valid_count = session_count = expired_count = 0
    for c in raw_cookies:
        expires = c.get("expires", -1)
        is_session = c.get("session", False) or (expires <= 0)
        if is_session:
            session_count += 1
            st = "session"
            desc = "会话凭证"
        elif expires > now_ts:
            valid_count += 1
            st = "valid"
            days_left = max(0, int((expires - now_ts) / 86400))
            desc = f"{datetime.fromtimestamp(expires).strftime('%Y-%m-%d %H:%M:%S')} (剩余 {days_left} 天)"
        else:
            expired_count += 1
            st = "expired"
            desc = f"已失效 ({datetime.fromtimestamp(expires).strftime('%Y-%m-%d %H:%M:%S')})"

        analyzed.append({
            "name": c.get("name"),
            "domain": c.get("domain"),
            "path": c.get("path"),
            "value_masked": c.get("value", "")[:6] + "..." + c.get("value", "")[-4:] if len(c.get("value", "")) > 10 else "***",
            "status": st,
            "expires_desc": desc,
            "secure": c.get("secure", False),
            "httpOnly": c.get("httpOnly", False),
        })
    return {
        "node_name": node["name"],
        "total": len(raw_cookies),
        "valid_count": valid_count,
        "session_count": session_count,
        "expired_count": expired_count,
        "cookies": analyzed,
    }


@router.post("/api/nodes/{node_id}/probe")
async def probe_node(node_id: int, user: dict = Depends(verify_token)):
    with session_scope() as db:
        row = _get_owned_node_or_404(db, node_id, user)
        node = row.to_dict()
    c_type = node.get("conn_type")
    if c_type not in ("reverse", "public_wss", "wss_direct"):
        raise HTTPException(status_code=400, detail="SaaS 版仅支持公网 WSS 直连或 WSS 反向穿透节点")
    target_h = "public-wss" if c_type in ("public_wss", "wss_direct") else "reverse-nat4"
    count, msg, lat_ms = await probe_node_with_latency(node["local_bind_port"], target_h, node_id=node["id"])
    new_status = "connected" if msg == "OK" else "error: refused"
    with session_scope() as db:
        n = db.get(Node, node_id)
        if n is not None:
            n.cookie_count = count
            n.status = new_status
    record_node_telemetry_sync(
        node_id,
        latency_ms=lat_ms if msg == "OK" else None,
        mark_online_tick=(msg == "OK"),
        is_offline=(msg != "OK"),
    )
    if msg != "OK":
        raise HTTPException(status_code=502, detail=f"探针未就绪: {msg}")
    return {"cookie_count": count, "latency_ms": lat_ms, "message": f"探测成功: 捕获到 {count} 条 Cookies（延迟 {lat_ms}ms）"}


@router.post("/api/nodes/{node_id}/toggle-tunnel")
async def toggle_tunnel(node_id: int, user: dict = Depends(verify_token)):
    with session_scope() as db:
        node = _get_owned_node_or_404(db, node_id, user).to_dict()
    if node.get("conn_type") in ("public_wss", "wss_direct"):
        sess = tunnel_mgr.get_reverse_session(node_id)
        if sess and not sess.is_closed:
            tunnel_mgr.stop_tunnel(node_id)
            return {"status": "stopped", "message": "公网 WSS 直连已断开"}
    ok, msg = await tunnel_mgr.start_tunnel(node)
    if not ok:
        raise HTTPException(status_code=500, detail=msg)
    return {"status": "connected", "message": msg}


@router.post("/api/nodes/{node_id}/toggle-source")
def toggle_source(node_id: int, user: dict = Depends(verify_token)):
    with session_scope() as db:
        row = _get_owned_node_or_404(db, node_id, user)
        new_src = 0 if row.is_source == 1 else 1
        if new_src == 1:
            db.query(Node).filter(Node.owner_id == row.owner_id).update({Node.is_source: 0}, synchronize_session=False)
            row.is_source = 1
            msg = "已设为本租户默认源节点"
        else:
            row.is_source = 0
            msg = "已取消该节点的默认源状态"
    return {"message": msg, "is_source": new_src}


@router.post("/api/nodes/{node_id}/toggle-enabled")
async def toggle_node_enabled(node_id: int, user: dict = Depends(verify_token)):
    with session_scope() as db:
        row = _get_owned_node_or_404(db, node_id, user)
        curr = row.enabled if row.enabled is not None else 1
        new_val = 0 if curr == 1 else 1
        row.enabled = new_val
        row.status = "disabled" if new_val == 0 else "standby"
        db.flush()
        updated = row.to_dict()
    if new_val == 0:
        tunnel_mgr.stop_tunnel(node_id)
        msg = f"节点 [{updated['name']}] 已禁用"
    else:
        ok, start_msg = await tunnel_mgr.start_tunnel(updated)
        msg = f"节点 [{updated['name']}] 已恢复启用: {start_msg}"
    return {"message": msg, "enabled": new_val, "status": updated.get("status")}


@router.post("/api/nodes/{node_id}/toggle-api")
def toggle_node_api_access(node_id: int, user: dict = Depends(verify_token)):
    with session_scope() as db:
        row = _get_owned_node_or_404(db, node_id, user)
        if (row.client_type or "").lower() == "android":
            raise HTTPException(status_code=403, detail="Android 移动节点自动锁定禁用第三方 API 接入")
        curr = 1 if (row.api_enabled if row.api_enabled is not None else 1) != 0 else 0
        new_val = 0 if curr == 1 else 1
        row.api_enabled = new_val
        node_name = row.name
    return {"message": f"节点 [{node_name}] {'已开放' if new_val else '已禁用'}第三方 API 接入", "api_enabled": new_val}
