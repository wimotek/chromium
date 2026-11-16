import asyncio
import ipaddress
import json
import os
import secrets
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional
from urllib.parse import unquote

from fastapi import APIRouter, Depends, Header as ReqHeader, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from sqlalchemy.orm import Session

from config import DATA_DIR, logger
from core.db import get_setting, session_scope, set_setting
from core.models import Node, TrafficStat
from core.rate_limit import (
    JOIN_TOKEN_BLOCK_SECONDS,
    JOIN_TOKEN_FAIL_WINDOW_SEC,
    JOIN_TOKEN_MAX_FAILURES,
    MAX_WS_TUNNELS_PER_IP,
    RATE_LIMIT_DETECT_PER_MIN,
    RATE_LIMIT_REGISTER_PER_MIN,
    check_block,
    check_rate_limit,
    check_tofu_quota,
    clear_auth_failures,
    enforce_rate_limit,
    get_block_ttl,
    get_client_ip,
    record_auth_failure,
    ws_guard,
)
from core.security import verify_token
from services.cdp_engine import fetch_cookies_native, probe_node_cookies
from services.traffic_service import get_live_node_traffic_overlay
from services.tunnel_manager import tunnel_mgr
from services.bookmark_service import handle_client_bookmark_event, push_bookmarks_to_session

try:
    from wimotek_edge_agent.nat import detect_network_mode as _edge_detect_network_mode
    from wimotek_edge_agent.tokens import SessionTicketManager as _EdgeSessionTicketManager

    HAS_EDGE_AGENT_LIB = True
except ImportError:
    _edge_detect_network_mode = None
    _EdgeSessionTicketManager = None
    HAS_EDGE_AGENT_LIB = False

router = APIRouter(tags=["节点管理与边缘接入"])


def _issue_join_token() -> str:
    return "hub_join_" + secrets.token_urlsafe(24)


def _get_ticket_manager():
    if not HAS_EDGE_AGENT_LIB or _EdgeSessionTicketManager is None:
        return None
    secret_raw = (os.getenv("EDGE_AGENT_TOKEN_SECRET") or get_setting("edge_agent_secret") or "").strip()
    if len(secret_raw.encode("utf-8")) < 32:
        secret_raw = (secret_raw + "0" * 32)[:32]
    ttl = int(os.getenv("EDGE_AGENT_SESSION_TICKET_TTL_SECONDS", "300"))
    return _EdgeSessionTicketManager(secret=secret_raw.encode("utf-8"), ttl_seconds=ttl)


def _issue_session_ticket(node_uuid: str, fingerprint: str) -> Optional[str]:
    mgr = _get_ticket_manager()
    if mgr is None or not node_uuid:
        return None
    try:
        return mgr.issue(node_uuid, fingerprint or "sha256:unknown")
    except Exception:
        return None


def _verify_session_ticket(ticket: Optional[str], node_uuid: str, fingerprint: str) -> bool:
    if not ticket:
        return False
    mgr = _get_ticket_manager()
    if mgr is None:
        return False
    try:
        return bool(mgr.verify(ticket, node_uuid, fingerprint or "sha256:unknown"))
    except Exception:
        return False


def _verify_join_token(presented: Optional[str], valid_token: str) -> bool:
    if not presented or not valid_token:
        return False
    return secrets.compare_digest(presented.strip(), valid_token.strip())


def _allow_non_public_probe() -> bool:
    val = os.getenv("EDGE_AGENT_ALLOW_NON_PUBLIC_PROBE", "").strip().lower()
    if val in {"1", "true", "yes", "on"}:
        return True
    if val in {"0", "false", "no", "off"}:
        return False
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
        rec = (
            f"[{v6_res['host']}]:{v6_res['port']}"
            if v6_res["latency_ms"] < v4_res["latency_ms"]
            else f"{v4_res['host']}:{v4_res['port']}"
        )
    elif v6_ok:
        mode = "direct_ipv6"
        rec = f"[{v6_res['host']}]:{v6_res['port']}"
    elif v4_ok:
        mode = "direct_ipv4"
        rec = f"{v4_res['host']}:{v4_res['port']}"
    else:
        mode = "reverse_tunnel"
        rec = None

    profile = "direct" if (v4_ok or v6_ok) else "nat4_reverse"
    return {
        "network_mode": mode,
        "network_profile": profile,
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


def _append_audit_log(event: str, **kwargs):
    audit_path = os.path.join(DATA_DIR, "audit.jsonl")
    record = {"ts": datetime.now(timezone.utc).isoformat(), "event": event, **kwargs}
    try:
        os.makedirs(os.path.dirname(audit_path), exist_ok=True)
        # 超过 5MB 自动轮转归档，防止恶意扫描刷满宿主机磁盘
        if os.path.exists(audit_path) and os.path.getsize(audit_path) >= 5 * 1024 * 1024:
            rotated = audit_path + ".1"
            try:
                if os.path.exists(rotated):
                    os.remove(rotated)
                os.replace(audit_path, rotated)
            except OSError:
                pass
        with open(audit_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _get_available_bind_port(
    db: Session,
    preferred_port: int,
    exclude_node_id: Optional[int] = None,
    current_bind_port: Optional[int] = None,
) -> int:
    """确保 local_bind_port 在集群内全局唯一（ORM 兼容 SQLite & MySQL）"""
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


class TofuSettingsDTO(BaseModel):
    tofu_enabled: bool
    tofu_auto_approve: bool
    tofu_timeout_notify_minutes: Optional[int] = 10


# ==================== 1. TOFU 准入策略与配置管理 ====================
@router.get("/api/nodes/tofu-settings", summary="获取 TOFU 准入策略配置")
def get_tofu_settings(user: dict = Depends(verify_token)):
    return {
        "tofu_enabled": get_setting("tofu_enabled", "1") == "1",
        "tofu_auto_approve": get_setting("tofu_auto_approve", "0") == "1",
        "tofu_timeout_notify_minutes": int(get_setting("tofu_timeout_notify_minutes", "10")),
    }


@router.post("/api/nodes/tofu-settings", summary="保存 TOFU 准入策略配置")
def save_tofu_settings(data: TofuSettingsDTO, user: dict = Depends(verify_token)):
    set_setting("tofu_enabled", "1" if data.tofu_enabled else "0")
    set_setting("tofu_auto_approve", "1" if data.tofu_auto_approve else "0")
    if data.tofu_timeout_notify_minutes is not None:
        set_setting("tofu_timeout_notify_minutes", str(max(0, data.tofu_timeout_notify_minutes)))
    return {"message": "TOFU 准入策略已更新"}


# ==================== 2. 分组与节点查询 ====================
@router.get("/api/node-groups")
def get_node_groups(user: dict = Depends(verify_token)):
    with session_scope() as db:
        rows = (
            db.query(Node.group_name)
            .filter(Node.group_name.isnot(None), Node.group_name != "")
            .distinct()
            .all()
        )
        groups = [r[0] for r in rows if r[0]]
    return groups or ["默认分组"]


@router.get("/api/nodes")
def list_nodes(user: dict = Depends(verify_token)):
    with session_scope() as db:
        rows = [
            n.to_dict()
            for n in db.query(Node).order_by(Node.approval_status.asc(), Node.id.desc()).all()
        ]

    overlay = get_live_node_traffic_overlay([r["id"] for r in rows])
    for r in rows:
        nid = r["id"]
        if r.get("enabled") == 0:
            r["status"] = "disabled"
        elif r.get("approval_status") == 0:
            r["status"] = "pending_approval"
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

    return rows


# ==================== 3. 常规手动节点 CRUD ====================
@router.post("/api/nodes")
def create_node(data: dict, user: dict = Depends(verify_token)):
    is_local = 1 if data.get("is_local") else 0
    direct_h = (data.get("direct_host") or "127.0.0.1").strip()
    grp_name = (data.get("group_name") or "默认分组").strip()
    conn_type = "direct" if is_local else "ssh"
    client_type = (data.get("client_type") or "desktop").strip().lower()
    api_enabled = 0 if client_type == "android" else (0 if data.get("api_enabled") in (0, False, "0") else 1)

    with session_scope() as db:
        db.add(
            Node(
                name=data["name"],
                group_name=grp_name,
                enabled=1,
                approval_status=1,
                conn_type=conn_type,
                node_uuid="",
                fingerprint="",
                is_source=1 if data.get("is_source") else 0,
                is_local=is_local,
                direct_host=direct_h if is_local else "127.0.0.1",
                ssh_host="" if is_local else data.get("ssh_host", ""),
                ssh_port=22 if is_local else int(data.get("ssh_port", 22) or 22),
                ssh_user="" if is_local else data.get("ssh_user", ""),
                ssh_key_filename="" if is_local else data.get("ssh_key_filename", ""),
                ssh_password="" if is_local else data.get("ssh_password", ""),
                remote_cdp_port=9222 if is_local else int(data.get("remote_cdp_port", 9222) or 9222),
                local_bind_port=int(data["local_bind_port"]),
                cookie_count=0,
                auto_tunnel=1,
                status="stopped",
                client_type=client_type,
                api_enabled=api_enabled,
            )
        )
    return {"message": "节点配置已写入"}


@router.put("/api/nodes/{node_id}")
async def update_node(node_id: int, data: dict, user: dict = Depends(verify_token)):
    with session_scope() as db:
        node = db.get(Node, node_id)
        if not node:
            raise HTTPException(status_code=404, detail="节点不存在")

        orig_node = node.to_dict()
        is_android = (orig_node.get("client_type") or "").lower() == "android"
        req_api = data.get("api_enabled", orig_node.get("api_enabled", 1))
        api_enabled_val = 0 if req_api in (0, False, "0") else 1
        if is_android:
            if "api_enabled" in data and api_enabled_val == 1:
                raise HTTPException(status_code=403, detail="Android 移动节点自动识别并默认禁用第三方 API 接入，不可修改")
            api_enabled_val = 0

        grp_name = (data.get("group_name") or "默认分组").strip()
        name = (data.get("name") or orig_node["name"]).strip()
        l_port = int(data.get("local_bind_port") or orig_node["local_bind_port"])

        node.name = name
        node.group_name = grp_name
        node.local_bind_port = l_port
        node.api_enabled = api_enabled_val

        if orig_node["conn_type"] not in ("reverse", "public_wss", "wss_direct"):
            is_local = 1 if data.get("is_local") else 0
            direct_h = (data.get("direct_host") or "127.0.0.1").strip()
            node.is_local = is_local
            node.direct_host = direct_h if is_local else "127.0.0.1"
            node.conn_type = "direct" if is_local else "ssh"
            node.ssh_host = "" if is_local else data.get("ssh_host", "")
            node.ssh_port = 22 if is_local else int(data.get("ssh_port", 22) or 22)
            node.ssh_user = "" if is_local else data.get("ssh_user", "")
            node.ssh_key_filename = "" if is_local else data.get("ssh_key_filename", "")
            node.ssh_password = "" if is_local else data.get("ssh_password", "")
            node.remote_cdp_port = 9222 if is_local else int(data.get("remote_cdp_port", 9222) or 9222)

        db.flush()
        updated_node = node.to_dict()

    if updated_node.get("enabled", 1) == 1 and updated_node.get("approval_status", 1) == 1:
        await tunnel_mgr.start_tunnel(updated_node)

    return {"message": "节点配置已更新"}


@router.delete("/api/nodes/{node_id}")
def delete_node(node_id: int, user: dict = Depends(verify_token)):
    tunnel_mgr.stop_tunnel(node_id)
    tunnel_mgr.stop_public_wss_session(node_id)
    tunnel_mgr.unregister_reverse_tunnel(node_id)
    with session_scope() as db:
        db.query(TrafficStat).filter(TrafficStat.node_id == node_id).delete(synchronize_session=False)
        db.query(Node).filter(Node.id == node_id).delete(synchronize_session=False)
    return {"message": "节点已彻底销毁移除"}


# ==================== 4. TOFU 认领、拒绝与 Token 重置 ====================
@router.post("/api/nodes/{node_id}/approve")
async def approve_node(node_id: int, user: dict = Depends(verify_token)):
    with session_scope() as db:
        node_obj = db.get(Node, node_id)
        if not node_obj:
            raise HTTPException(status_code=404, detail="待审批节点不存在")
        node_obj.approval_status = 1
        node_obj.status = "connected"
        db.flush()
        node = node_obj.to_dict()

    session = tunnel_mgr.get_reverse_session(node_id)
    if session:
        ticket = _issue_session_ticket(node.get("node_uuid") or str(node_id), node.get("fingerprint", ""))
        await session.send_raw_json({
            "status": "approved",
            "decision": "tofu_approved",
            "network_mode": node.get("network_mode") or "reverse_tunnel",
            "network_profile": "direct" if str(node.get("network_mode", "")).startswith("direct") else "nat4_reverse",
            "recommended_endpoint": node.get("recommended_endpoint") or None,
            "session_ticket": ticket,
        })
        asyncio.create_task(push_bookmarks_to_session(session))

    _append_audit_log(
        "node_approved",
        node_uuid=node.get("node_uuid") or node.get("name"),
        fingerprint=node.get("fingerprint", ""),
        network_mode=node.get("network_mode") or "reverse_tunnel",
    )

    await tunnel_mgr.start_tunnel(node)
    return {"message": f"节点 [{node['name']}] 已经通过认领审核，正式接入集群！"}


@router.post("/api/nodes/{node_id}/reject")
async def reject_node(node_id: int, user: dict = Depends(verify_token)):
    with session_scope() as db:
        node_obj = db.get(Node, node_id)
        node = node_obj.to_dict() if node_obj else {}

    session = tunnel_mgr.get_reverse_session(node_id)
    if session:
        await session.send_raw_json({"status": "denied", "reason": "admin_rejected"})
        tunnel_mgr.unregister_reverse_tunnel(node_id)

    with session_scope() as db:
        db.query(Node).filter(Node.id == node_id, Node.approval_status == 0).delete(synchronize_session=False)

    if node:
        _append_audit_log("node_revoked", node_uuid=node.get("node_uuid") or node.get("name"))

    return {"message": "已拒绝并清除该待审节点"}


@router.post("/api/nodes/reset-join-token")
def reset_join_token(user: dict = Depends(verify_token)):
    new_token = _issue_join_token()
    set_setting("cluster_join_token", new_token)
    return {"message": "集群入网通行码已重置", "join_token": new_token}


# ==================== 5. 智能 TCP 三次握手探测与 HTTP 直连登记 ====================
@router.get("/api/nodes/detect-mode", summary="为边缘节点提供双向 TCP 探活检测 (兼容 GET)")
async def detect_node_reachability_get(request: Request, cdp_port: int = Query(9222)):
    return await _handle_detect_mode(request, DetectModeDTO(cdp_port=cdp_port))


@router.post("/api/nodes/detect-mode", summary="接收节点上传 IP/端口并执行 wimotek-edge-agent TCP 三次握手探测")
async def detect_node_reachability_post(data: DetectModeDTO, request: Request):
    return await _handle_detect_mode(request, data)


async def _handle_detect_mode(request: Request, data: DetectModeDTO) -> Dict[str, Any]:
    client_ip = get_client_ip(request)
    check_block("join_token", client_ip, "当前来源 IP 已被临时限制，请稍后再试")
    enforce_rate_limit("detect_mode", client_ip, RATE_LIMIT_DETECT_PER_MIN, 60, "网络探测请求过于频繁，请稍后再试")
    if data.node_uuid:
        enforce_rate_limit("detect_uuid", data.node_uuid.strip()[:64], RATE_LIMIT_DETECT_PER_MIN, 60, "节点网络探测过于频繁")

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

    v4_port = data.public_ipv4_port or data.cdp_port
    v6_port = data.public_ipv6_port or data.cdp_port

    det = await _run_edge_network_detection(
        public_ipv4=v4_host,
        public_ipv4_port=v4_port if v4_host else None,
        public_ipv6=v6_host,
        public_ipv6_port=v6_port if v6_host else None,
        force_reverse=data.force_reverse,
    )

    rec_host, rec_port = _split_endpoint_host_port(
        det.get("recommended_endpoint"),
        v4_host or v6_host or client_ip,
        data.cdp_port,
    )
    det["detected_ip"] = rec_host
    det["recommended_port"] = rec_port

    _append_audit_log(
        "network_detected",
        node_uuid=data.node_uuid or "probe",
        network_mode=det.get("network_mode"),
        network_profile=det.get("network_profile"),
        ipv4_reachable=det.get("ipv4_reachable"),
        ipv6_reachable=det.get("ipv6_reachable"),
        recommended_endpoint=det.get("recommended_endpoint"),
    )
    return det


@router.post("/api/nodes/{node_id}/detect-network", summary="手动触发对已注册节点的 TCP 三次握手网络重探")
async def reprobe_registered_node(node_id: int, user: dict = Depends(verify_token)):
    with session_scope() as db:
        node_obj = db.get(Node, node_id)
        if not node_obj:
            raise HTTPException(status_code=404, detail="节点不存在")
        node = node_obj.to_dict()

    host = (node.get("direct_host") or "").strip().strip("[]")
    if node.get("conn_type") in ("public_wss", "wss_direct"):
        ep_host, port = _split_endpoint_host_port(
            node.get("wss_endpoint") or node.get("recommended_endpoint"),
            host,
            9443,
        )
        host = ep_host.strip("[]") or host
    else:
        port = int(node.get("remote_cdp_port") or 9222)

    v4 = host if (host and ":" not in host and host not in ("reverse-nat4", "public-wss", "wss-direct")) else None
    v6 = host if (host and ":" in host) else None
    det = await _run_edge_network_detection(
        public_ipv4=v4,
        public_ipv4_port=port if v4 else None,
        public_ipv6=v6,
        public_ipv6_port=port if v6 else None,
    )

    with session_scope() as db:
        node_obj = db.get(Node, node_id)
        if node_obj is not None:
            node_obj.network_mode = det.get("network_mode", "")
            node_obj.recommended_endpoint = det.get("recommended_endpoint") or ""
            node_obj.ipv4_reachable = 1 if det.get("ipv4_reachable") else 0
            node_obj.ipv6_reachable = 1 if det.get("ipv6_reachable") else 0
            if node.get("conn_type") in ("public_wss", "wss_direct") and det.get("recommended_endpoint"):
                node_obj.wss_endpoint = det.get("recommended_endpoint") or ""

    session = tunnel_mgr.get_reverse_session(node_id)
    if session and not session.is_closed:
        await session.send_raw_json({"type": "network_update", **det})
    return det


@router.post("/api/nodes/auto-register", summary="HTTP 自动上报直连接入")
async def http_auto_register_node(
    data: NodeAutoRegisterDTO,
    request: Request,
    x_join_token: Optional[str] = ReqHeader(None),
):
    client_ip = get_client_ip(request)
    check_block("join_token", client_ip, "无效 JOIN_TOKEN 尝试过多，当前 IP 已被临时封禁")
    enforce_rate_limit("auto_register", client_ip, RATE_LIMIT_REGISTER_PER_MIN, 60, "节点注册请求过于频繁，请稍后再试")

    valid_token = get_setting("cluster_join_token")
    tofu_enabled = get_setting("tofu_enabled", "1") == "1"
    tofu_auto_approve = get_setting("tofu_auto_approve", "0") == "1"
    fp = data.public_key_fingerprint or ""
    has_join_token = bool(x_join_token and x_join_token.strip())

    if _verify_join_token(x_join_token, valid_token):
        clear_auth_failures("join_token", client_ip)
        approval_status = 1
        status = "connected"
        decision = "allow_token"
        reason = "edge_agent_token_verified"
    elif _verify_session_ticket(data.session_ticket, data.node_uuid, fp):
        approval_status = 1
        status = "connected"
        decision = "allow_session"
        reason = "session_ticket_verified"
    else:
        if has_join_token:
            _, blk_sec = record_auth_failure(
                "join_token",
                client_ip,
                max_failures=JOIN_TOKEN_MAX_FAILURES,
                fail_window_sec=JOIN_TOKEN_FAIL_WINDOW_SEC,
                block_sec=JOIN_TOKEN_BLOCK_SECONDS,
            )
            if blk_sec > 0:
                raise HTTPException(
                    status_code=429,
                    detail=f"无效 JOIN_TOKEN 尝试过多，已临时封禁 {blk_sec} 秒",
                    headers={"Retry-After": str(blk_sec)},
                )
        if not tofu_enabled:
            raise HTTPException(status_code=403, detail="TOFU 未授权接入功能已关闭，请配置合法 JOIN_TOKEN")
        elif tofu_auto_approve:
            approval_status = 1
            status = "connected"
            decision = "allow_token"
            reason = "tofu_auto_approved"
        else:
            approval_status = 0
            status = "pending_approval"
            decision = "pending_tofu"
            reason = "tofu_pending_admin_approval"

    fallback_ip = "127.0.0.1" if client_ip in ["127.0.0.1", "localhost", "::1"] else client_ip
    is_public_wss = (
        data.conn_type in ("public_wss", "wss_direct")
        or bool(data.wss_port)
        or bool(data.edge_wss_secret)
    )
    default_probe_port = int(data.wss_port or 9443) if is_public_wss else int(data.cdp_port or 9222)
    direct_ip, rec_port = _split_endpoint_host_port(
        data.recommended_endpoint,
        data.public_ipv4 or data.public_ipv6 or fallback_ip,
        default_probe_port,
    )

    node_name = (data.name or "").strip() or f"Edge-{data.node_uuid[:6]}"
    grp_name = (data.group_name or "").strip() or "默认分组"
    net_mode = data.network_mode or ("direct_ipv6" if ":" in direct_ip else "direct_ipv4")
    rec_ep = data.recommended_endpoint or (
        f"[{direct_ip}]:{rec_port}" if ":" in direct_ip else f"{direct_ip}:{rec_port}"
    )
    v4_ok = 1 if data.ipv4_reachable else (1 if ":" not in direct_ip else 0)
    v6_ok = 1 if data.ipv6_reachable else (1 if ":" in direct_ip else 0)

    conn_type_val = "public_wss" if is_public_wss else "direct"
    is_local_val = 0 if is_public_wss else 1
    remote_cdp_val = int(data.cdp_port or 9222) if is_public_wss else rec_port
    preferred_bind_port = rec_port or remote_cdp_val
    wss_endpoint_val = rec_ep if is_public_wss else ""
    edge_secret_val = (data.edge_wss_secret or "").strip() if is_public_wss else ""
    client_type_val = _detect_client_type(request.headers, {"client_type": data.client_type})

    node_enabled = 1
    prev_conn_type = None
    with session_scope() as db:
        existing = db.query(Node).filter(Node.node_uuid == data.node_uuid).first()
        if existing:
            node_id = existing.id
            prev_conn_type = existing.conn_type
            appr = existing.approval_status if approval_status == 0 else 1
            node_enabled = existing.enabled if existing.enabled is not None else 1
            api_enabled_val = (
                0
                if client_type_val == "android"
                else (existing.api_enabled if existing.api_enabled is not None else 1)
            )
            allocated_port = _get_available_bind_port(
                db,
                preferred_bind_port,
                exclude_node_id=node_id,
                current_bind_port=existing.local_bind_port,
            )
            final_status = "disabled" if node_enabled == 0 else ("pending_approval" if appr == 0 else status)
            existing.conn_type = conn_type_val
            existing.is_local = is_local_val
            existing.direct_host = direct_ip
            existing.remote_cdp_port = remote_cdp_val
            existing.local_bind_port = allocated_port
            existing.name = node_name
            existing.group_name = grp_name
            existing.approval_status = appr
            existing.status = final_status
            existing.fingerprint = fp
            existing.network_mode = net_mode
            existing.recommended_endpoint = rec_ep
            existing.wss_endpoint = wss_endpoint_val
            existing.edge_wss_secret = edge_secret_val
            existing.ipv4_reachable = v4_ok
            existing.ipv6_reachable = v6_ok
            existing.client_type = client_type_val
            existing.api_enabled = api_enabled_val
            approval_status = appr
            db.flush()
            saved_node = existing.to_dict()
        else:
            if approval_status == 0:
                pending_cnt = db.query(Node.id).filter(Node.approval_status == 0).count()
                ok_quota, quota_msg = check_tofu_quota(pending_cnt, client_ip)
                if not ok_quota:
                    raise HTTPException(status_code=429, detail=quota_msg)
            api_enabled_val = 0 if client_type_val == "android" else 1
            allocated_port = _get_available_bind_port(db, preferred_bind_port)
            new_node = Node(
                name=node_name,
                group_name=grp_name,
                enabled=1,
                approval_status=approval_status,
                conn_type=conn_type_val,
                node_uuid=data.node_uuid,
                fingerprint=fp,
                is_source=0,
                is_local=is_local_val,
                direct_host=direct_ip,
                ssh_host="",
                ssh_port=22,
                ssh_user="",
                ssh_key_filename="",
                ssh_password="",
                remote_cdp_port=remote_cdp_val,
                local_bind_port=allocated_port,
                status=status,
                network_mode=net_mode,
                recommended_endpoint=rec_ep,
                wss_endpoint=wss_endpoint_val,
                edge_wss_secret=edge_secret_val,
                ipv4_reachable=v4_ok,
                ipv6_reachable=v6_ok,
                client_type=client_type_val,
                api_enabled=api_enabled_val,
            )
            db.add(new_node)
            db.flush()
            node_id = new_node.id
            saved_node = new_node.to_dict()

    if prev_conn_type == "reverse" and is_public_wss:
        tunnel_mgr.unregister_reverse_tunnel(node_id)

    if is_public_wss and approval_status == 1 and node_enabled == 1:
        tunnel_mgr.ensure_public_wss_session(saved_node)

    _append_audit_log(
        "access_decision",
        node_uuid=data.node_uuid,
        source_ip=client_ip,
        is_loopback=(client_ip in ["127.0.0.1", "localhost", "::1"]),
        decision=decision,
        reason=reason,
        network_profile="direct",
        network_mode=net_mode,
        recommended_endpoint=rec_ep,
    )

    session_ticket = _issue_session_ticket(data.node_uuid, fp) if approval_status == 1 else None
    return {
        "code": 200,
        "node_id": node_id,
        "approval_status": approval_status,
        "conn_type": conn_type_val,
        "network_mode": net_mode,
        "network_profile": "direct",
        "recommended_endpoint": rec_ep,
        "session_ticket": session_ticket,
        "message": "已自动接入" if approval_status == 1 else "已进入 TOFU 待审核队列",
    }


# ==================== 6. 准入审计日志 API (查询与一键清空) ====================
@router.get("/api/nodes/audit-logs", summary="获取零信任准入决策审计流水")
def get_edge_audit_logs(user: dict = Depends(verify_token)):
    audit_files = [os.path.join(DATA_DIR, "audit.jsonl"), "edge_agent_data/audit.jsonl"]
    records = []
    for fp in audit_files:
        if os.path.exists(fp):
            try:
                with open(fp, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line:
                            records.append(json.loads(line))
            except Exception:
                pass
            break

    records.sort(key=lambda x: x.get("ts", ""), reverse=True)
    return records[:100]


@router.delete("/api/nodes/audit-logs", summary="彻底清空所有准入审计日志")
def clear_edge_audit_logs(user: dict = Depends(verify_token)):
    audit_files = [os.path.join(DATA_DIR, "audit.jsonl"), "edge_agent_data/audit.jsonl"]
    for fp in audit_files:
        if os.path.exists(fp):
            try:
                with open(fp, "w", encoding="utf-8") as f:
                    f.truncate(0)
            except Exception:
                pass
    return {"message": "准入审计流水已清空"}


# ==================== 7. NAT4 反向 WebSocket 隧道终结点 ====================
def _extract_ws_client_ip(websocket: WebSocket) -> str:
    fwd_for = (websocket.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    if fwd_for:
        return fwd_for
    real_ip = (websocket.headers.get("x-real-ip") or "").strip()
    if real_ip:
        return real_ip
    return websocket.client.host if websocket.client else "unknown"


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
        await websocket.close(code=1008, reason="Too many auth failures, temporarily blocked")
        return

    allowed_ws, _, _ = check_rate_limit("ws_reverse", client_ip, RATE_LIMIT_REGISTER_PER_MIN, 60)
    if not allowed_ws:
        await websocket.close(code=1008, reason="WebSocket connect rate limit exceeded")
        return

    if not ws_guard.acquire("reverse", client_ip, MAX_WS_TUNNELS_PER_IP):
        await websocket.close(code=1008, reason="Too many concurrent tunnels from IP")
        return

    node_id: Optional[int] = None
    session = None
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

    header_port_str = websocket.headers.get("x-cdp-port")
    try:
        cdp_port = int(header_port_str) if header_port_str else (port or 9222)
    except Exception:
        cdp_port = port or 9222

    header_ext_port_str = websocket.headers.get("x-external-port")
    try:
        ext_port = int(header_ext_port_str) if header_ext_port_str else None
    except Exception:
        ext_port = None

    node_uuid = websocket.headers.get("x-node-uuid") or uuid or websocket.query_params.get("uuid")
    node_fp = (
        websocket.headers.get("x-node-fingerprint")
        or fingerprint
        or websocket.query_params.get("fingerprint")
        or ""
    )
    enroll_token = websocket.headers.get("x-join-token") or token or websocket.query_params.get("token")
    node_name = unquote(websocket.headers.get("x-node-name") or "") or name or websocket.query_params.get("name")
    node_group = unquote(websocket.headers.get("x-node-group") or "") or group or "默认分组"

    handshake_data: Dict[str, Any] = {}
    if not node_uuid:
        try:
            first_msg_raw = await asyncio.wait_for(websocket.receive_text(), timeout=8.0)
            handshake_data = json.loads(first_msg_raw)
            node_uuid = handshake_data.get("node_uuid")
            node_fp = handshake_data.get("public_key_fingerprint", "")
            enroll_token = handshake_data.get("join_token") or enroll_token
            node_name = handshake_data.get("name") or node_name or node_uuid
            node_group = handshake_data.get("group") or node_group
            cdp_port = int(handshake_data.get("port") or cdp_port)
        except Exception as e:
            logger.error(f"❌ [Tunnel 握手失败] 未收到节点身份: {e}")
            await websocket.close(code=1008, reason="Handshake timeout or invalid JSON")
            return
    else:
        try:
            first_msg_raw = await asyncio.wait_for(websocket.receive_text(), timeout=8.0)
            handshake_data = json.loads(first_msg_raw)
            node_fp = handshake_data.get("public_key_fingerprint") or node_fp
            enroll_token = handshake_data.get("join_token") or enroll_token
            node_name = handshake_data.get("name") or node_name
            node_group = handshake_data.get("group") or node_group
            cdp_port = int(handshake_data.get("port") or cdp_port)
        except Exception:
            handshake_data = {}

    pub_v4 = handshake_data.get("public_ipv4")
    pub_v4_port = handshake_data.get("public_ipv4_port") or (cdp_port if pub_v4 else None)
    pub_v6 = handshake_data.get("public_ipv6")
    pub_v6_port = handshake_data.get("public_ipv6_port") or (cdp_port if pub_v6 else None)
    reported_port = int(
        handshake_data.get("external_port")
        or handshake_data.get("wss_port")
        or ext_port
        or pub_v4_port
        or pub_v6_port
        or cdp_port
    )
    session_ticket = handshake_data.get("session_ticket")
    forced_reverse = handshake_data.get("reverse_tunnel")
    client_type_val = _detect_client_type(websocket.headers, handshake_data)

    if (pub_v4 or pub_v6) and forced_reverse is not True:
        detection = await _run_edge_network_detection(
            public_ipv4=pub_v4,
            public_ipv4_port=pub_v4_port,
            public_ipv6=pub_v6,
            public_ipv6_port=pub_v6_port,
        )
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
    valid_token = get_setting("cluster_join_token")
    tofu_enabled = get_setting("tofu_enabled", "1") == "1"
    tofu_auto_approve = get_setting("tofu_auto_approve", "0") == "1"

    try:
        with session_scope() as db:
            existing_row = db.query(Node).filter(Node.node_uuid == node_uuid).first()

            has_enroll_token = bool(enroll_token and str(enroll_token).strip())
            if _verify_join_token(enroll_token, valid_token):
                clear_auth_failures("join_token", client_ip)
                approved = 1
                status = "connected"
                decision = "allow_token"
                reason = "edge_agent_token_verified"
            elif _verify_session_ticket(session_ticket, node_uuid, node_fp):
                approved = 1
                status = "connected"
                decision = "allow_session"
                reason = "session_ticket_verified"
            elif (
                existing_row is not None
                and existing_row.approval_status == 1
                and (not existing_row.fingerprint or existing_row.fingerprint == node_fp)
            ):
                approved = 1
                status = "connected"
                decision = "allow_session"
                reason = "trusted_fingerprint_verified"
            else:
                if has_enroll_token:
                    record_auth_failure(
                        "join_token",
                        client_ip,
                        max_failures=JOIN_TOKEN_MAX_FAILURES,
                        fail_window_sec=JOIN_TOKEN_FAIL_WINDOW_SEC,
                        block_sec=JOIN_TOKEN_BLOCK_SECONDS,
                    )
                if not tofu_enabled:
                    decision = "deny"
                    reason = "tofu_access_disabled"
                    _append_audit_log(
                        "access_decision",
                        node_uuid=node_uuid,
                        source_ip=client_ip,
                        is_loopback=(client_ip in ["127.0.0.1", "localhost", "::1"]),
                        decision="deny",
                        reason=reason,
                        network_profile=net_profile,
                        network_mode=net_mode,
                    )
                    await websocket.close(code=1008, reason="TOFU Access Disabled")
                    logger.warning(f"🚫 [TOFU 拦截] 未知节点 [{node_name}] 无 Token 且 TOFU 已关闭，直接拒绝！")
                    return
                elif tofu_auto_approve:
                    approved = 1
                    status = "connected"
                    decision = "allow_token"
                    reason = "tofu_auto_approved"
                else:
                    approved = 0
                    status = "pending_approval"
                    decision = "pending_tofu"
                    reason = "tofu_pending_admin_approval"

            prev_conn_type = None
            if existing_row is not None:
                node_id = existing_row.id
                prev_conn_type = existing_row.conn_type
                allocated_port = _get_available_bind_port(
                    db,
                    reported_port,
                    exclude_node_id=node_id,
                    current_bind_port=existing_row.local_bind_port,
                )
                is_currently_enabled = existing_row.enabled if existing_row.enabled is not None else 1
                api_enabled_val = (
                    0
                    if client_type_val == "android"
                    else (existing_row.api_enabled if existing_row.api_enabled is not None else 1)
                )
                final_status = "disabled" if is_currently_enabled == 0 else status

                existing_row.conn_type = "reverse"
                existing_row.is_local = 1
                existing_row.direct_host = "reverse-nat4"
                existing_row.wss_endpoint = ""
                existing_row.edge_wss_secret = ""
                existing_row.remote_cdp_port = cdp_port
                existing_row.local_bind_port = allocated_port
                existing_row.status = final_status
                existing_row.approval_status = approved
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
                if approved == 0:
                    pending_cnt = db.query(Node.id).filter(Node.approval_status == 0).count()
                    ok_quota, quota_msg = check_tofu_quota(pending_cnt, client_ip)
                    if not ok_quota:
                        await websocket.close(code=1008, reason=quota_msg[:120])
                        return
                api_enabled_val = 0 if client_type_val == "android" else 1
                allocated_port = _get_available_bind_port(db, reported_port)
                new_node = Node(
                    name=node_name,
                    group_name=node_group,
                    enabled=1,
                    approval_status=approved,
                    conn_type="reverse",
                    node_uuid=node_uuid,
                    fingerprint=node_fp,
                    is_source=0,
                    is_local=1,
                    direct_host="reverse-nat4",
                    ssh_host="",
                    ssh_port=22,
                    ssh_user="",
                    ssh_key_filename="",
                    ssh_password="",
                    remote_cdp_port=cdp_port,
                    local_bind_port=allocated_port,
                    status=status,
                    network_mode=net_mode,
                    recommended_endpoint=rec_endpoint,
                    wss_endpoint="",
                    edge_wss_secret="",
                    ipv4_reachable=v4_ok_int,
                    ipv6_reachable=v6_ok_int,
                    client_type=client_type_val,
                    api_enabled=api_enabled_val,
                )
                db.add(new_node)
                db.flush()
                node_id = new_node.id
    except Exception as db_err:
        logger.error(f"❌ [DB 错误] 写入节点表失败: {db_err}", exc_info=True)
        await websocket.close(code=1011, reason="Database Error")
        return

    if prev_conn_type in ("public_wss", "wss_direct"):
        tunnel_mgr.stop_public_wss_session(node_id)

    session = tunnel_mgr.register_reverse_tunnel(node_id, websocket)

    client_host = _extract_ws_client_ip(websocket)
    _append_audit_log(
        "access_decision",
        node_uuid=node_uuid,
        source_ip=client_host,
        is_loopback=(client_host in ["127.0.0.1", "localhost", "::1"]),
        decision=decision,
        reason=reason,
        network_profile=net_profile,
        network_mode=net_mode,
        recommended_endpoint=rec_endpoint or None,
    )

    feedback_fields = {
        "network_mode": net_mode,
        "network_profile": net_profile,
        "ipv4_reachable": bool(v4_ok_int),
        "ipv6_reachable": bool(v6_ok_int),
        "recommended_endpoint": rec_endpoint or None,
        "probe_results": detection.get("probe_results"),
        "client_type": client_type_val,
        "api_enabled": bool(api_enabled_val),
    }

    if approved == 1:
        issued_ticket = _issue_session_ticket(node_uuid, node_fp)
        await session.send_raw_json({
            "status": "ok",
            "decision": decision,
            "session_ticket": issued_ticket,
            **feedback_fields,
        })
        logger.info(f"✅ [反向长连接打通] 节点 [{node_name}] (ID: {node_id}, mode: {net_mode}) 认证放行！")
        asyncio.create_task(push_bookmarks_to_session(session))

        async def _auto_probe_on_connect(nid: int, lport: int):
            try:
                await asyncio.sleep(1.2)
                c_cnt, _ = await probe_node_cookies(lport, node_id=nid)
                with session_scope() as db:
                    n = db.get(Node, nid)
                    if n is not None and (n.enabled if n.enabled is not None else 1) == 1:
                        n.cookie_count = c_cnt
                        n.status = "connected"
                logger.info(f"🍪 [开机探活刷新] 节点 ID:{nid} 真实 Cookie 存量更新完毕: {c_cnt} 条")
            except Exception as e:
                logger.debug(f"开机探活跳过: {e}")

        asyncio.create_task(_auto_probe_on_connect(node_id, allocated_port))
    else:
        await session.send_raw_json({
            "status": "pending_tofu",
            "reason": "tofu_pending_admin_approval",
            **feedback_fields,
        })
        logger.info(f"🔔 [TOFU 发现新节点] 节点 [{node_name}] (UUID: {node_uuid}, mode: {net_mode}) 进入待审队列...")

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
                    elif (
                        parsed.get("type") in {"bookmark_upsert", "bookmark_delete", "bookmarks_merge", "bookmarks_pull"}
                        or parsed.get("action") == "pull_bookmarks"
                    ):
                        asyncio.create_task(handle_client_bookmark_event(node_id, node_name, parsed))
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


# ==================== 8. 探针与详情接口 ====================
@router.get("/api/nodes/{node_id}/cookie-details")
async def get_node_cookie_details(node_id: int, user: dict = Depends(verify_token)):
    with session_scope() as db:
        row = db.get(Node, node_id)
        if not row:
            raise HTTPException(status_code=404, detail="节点不存在")
        node = row.to_dict()

    now_ts = time.time()
    try:
        c_type = node.get("conn_type")
        target_h = (
            "public-wss"
            if c_type in ("public_wss", "wss_direct")
            else ("reverse-nat4" if c_type == "reverse" else (node.get("direct_host", "127.0.0.1") if node["is_local"] else "127.0.0.1"))
        )
        raw_cookies = await fetch_cookies_native(node["local_bind_port"], target_h, node_id=node["id"])
        analyzed = []
        valid_count = 0
        session_count = 0
        expired_count = 0

        for c in raw_cookies:
            expires = c.get("expires", -1)
            is_session = c.get("session", False) or (expires <= 0)
            status = "valid"
            expires_desc = "会话凭证 (浏览器关闭失效)"

            if is_session:
                session_count += 1
                status = "session"
            else:
                if expires > now_ts:
                    valid_count += 1
                    status = "valid"
                    exp_dt = datetime.fromtimestamp(expires).strftime("%Y-%m-%d %H:%M:%S")
                    days_left = max(0, int((expires - now_ts) / 86400))
                    expires_desc = f"{exp_dt} (剩余 {days_left} 天)"
                else:
                    expired_count += 1
                    status = "expired"
                    exp_dt = datetime.fromtimestamp(expires).strftime("%Y-%m-%d %H:%M:%S")
                    expires_desc = f"已失效 (于 {exp_dt})"

            analyzed.append({
                "name": c.get("name"),
                "domain": c.get("domain"),
                "path": c.get("path"),
                "value_masked": c.get("value", "")[:6] + "..." + c.get("value", "")[-4:] if len(c.get("value", "")) > 10 else "***",
                "value_full": c.get("value"),
                "status": status,
                "expires_desc": expires_desc,
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
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"无法从目标节点读取 Cookie 详情: {e}")


@router.post("/api/nodes/{node_id}/probe")
async def probe_node(node_id: int, user: dict = Depends(verify_token)):
    with session_scope() as db:
        row = db.get(Node, node_id)
        if not row:
            raise HTTPException(status_code=404, detail="节点不存在")
        node = row.to_dict()

    c_type = node.get("conn_type")
    target_h = (
        "public-wss"
        if c_type in ("public_wss", "wss_direct")
        else ("reverse-nat4" if c_type == "reverse" else (node.get("direct_host", "127.0.0.1") if node["is_local"] else "127.0.0.1"))
    )
    count, msg = await probe_node_cookies(node["local_bind_port"], target_h, node_id=node["id"])
    new_status = "connected" if msg == "OK" else "error: refused"

    with session_scope() as db:
        n = db.get(Node, node_id)
        if n is not None:
            n.cookie_count = count
            n.status = new_status

    if msg != "OK":
        raise HTTPException(status_code=502, detail=f"探针未就绪: {msg}")
    return {"cookie_count": count, "message": f"探测成功: 捕获到 {count} 条 Cookies"}


@router.post("/api/nodes/{node_id}/toggle-tunnel")
async def toggle_tunnel(node_id: int, user: dict = Depends(verify_token)):
    with session_scope() as db:
        row = db.get(Node, node_id)
        if not row:
            raise HTTPException(status_code=404, detail="节点不存在")
        node = row.to_dict()

    if node.get("conn_type") in ("public_wss", "wss_direct"):
        session = tunnel_mgr.get_reverse_session(node_id)
        if session and not session.is_closed:
            tunnel_mgr.stop_tunnel(node_id)
            return {"status": "stopped", "message": "公网 WSS 直连已手动断开"}
    elif node.get("is_local") != 1 and node_id in tunnel_mgr.tunnels:
        tunnel_mgr.stop_tunnel(node_id)
        return {"status": "stopped", "message": "隧道已手动切断"}

    ok, msg = await tunnel_mgr.start_tunnel(node)
    if not ok:
        raise HTTPException(status_code=500, detail=msg)
    return {"status": "connected", "message": msg}


@router.post("/api/nodes/{node_id}/toggle-source")
def toggle_source(node_id: int, user: dict = Depends(verify_token)):
    with session_scope() as db:
        row = db.get(Node, node_id)
        if not row:
            raise HTTPException(status_code=404, detail="节点不存在")
        new_src = 0 if row.is_source == 1 else 1
        if new_src == 1:
            db.query(Node).update({Node.is_source: 0}, synchronize_session=False)
            row.is_source = 1
            msg = "已设为全网默认源节点"
        else:
            row.is_source = 0
            msg = "已取消该节点的默认源状态"
    return {"message": msg, "is_source": new_src}


@router.post("/api/nodes/{node_id}/set-source")
def set_source_compat(node_id: int, user: dict = Depends(verify_token)):
    return toggle_source(node_id, user)


# ==================== 9. 节点启用 / 禁用流转控制 ====================
@router.post("/api/nodes/{node_id}/toggle-enabled")
async def toggle_node_enabled(node_id: int, user: dict = Depends(verify_token)):
    with session_scope() as db:
        row = db.get(Node, node_id)
        if not row:
            raise HTTPException(status_code=404, detail="节点不存在")
        curr = row.enabled if row.enabled is not None else 1
        new_val = 0 if curr == 1 else 1
        new_status = "disabled" if new_val == 0 else "standby"
        row.enabled = new_val
        row.status = new_status
        db.flush()
        updated_node = row.to_dict()

    if new_val == 0:
        tunnel_mgr.stop_tunnel(node_id)
        msg = f"节点 [{updated_node['name']}] 已禁用"
    else:
        if updated_node.get("approval_status", 1) == 1:
            ok, start_msg = await tunnel_mgr.start_tunnel(updated_node)
            msg = f"节点 [{updated_node['name']}] 已恢复启用: {start_msg}"
        else:
            msg = f"节点 [{updated_node['name']}] 已恢复启用 (等待审批放行)"

    return {"message": msg, "enabled": new_val, "status": updated_node.get("status")}


@router.post("/api/nodes/{node_id}/toggle-api", summary="切换节点第三方 API 接入权限 (Android 默认锁定禁用)")
def toggle_node_api_access(node_id: int, user: dict = Depends(verify_token)):
    with session_scope() as db:
        row = db.get(Node, node_id)
        if not row:
            raise HTTPException(status_code=404, detail="节点不存在")
        if (row.client_type or "").lower() == "android":
            raise HTTPException(status_code=403, detail="Android 移动节点已自动锁定禁用第三方 API 接入，不可修改")
        curr = 1 if (row.api_enabled if row.api_enabled is not None else 1) != 0 else 0
        new_val = 0 if curr == 1 else 1
        row.api_enabled = new_val
        node_name = row.name

    action_txt = "允许第三方 API 接入" if new_val == 1 else "已禁止第三方 API 接入（将从 /api/v1/nodes 隐藏）"
    return {"message": f"节点 [{node_name}] {action_txt}", "api_enabled": new_val}