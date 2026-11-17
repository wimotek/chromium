from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel

from config import resolve_hub_access_info
from core.db import session_scope
from core.models import Node, NodeLease, Plan, User, UserLevel, units_to_yuan_str
from core.rate_limit import RATE_LIMIT_MARKET_PER_MIN, enforce_rate_limit, get_client_ip
from core.security import verify_token
from modules.billing.service import (
    compute_buyer_price_units,
    get_all_channel_fee_bps,
    get_platform_fee_bps,
    is_shareable_conn_type,
    normalize_billing_channel,
    resolve_channel_platform_fee_bps,
    settle_single_lease_sync,
    start_lease_sync,
)
from modules.nodes.traffic_service import get_traffic_summary
from modules.nodes.tunnel_manager import tunnel_mgr

router = APIRouter(tags=["算力市场（节点租赁 · 渠道定价 · 流量汇总）"])


class LeaseCreateDTO(BaseModel):
    remark: str = ""


@router.get("/api/market/nodes", summary="浏览当前全平台可租用的共享算力节点市场（按接入通道 + 卖家等级动态差价）")
def list_marketplace_nodes(user: dict = Depends(verify_token)):
    channel_fees = get_all_channel_fee_bps()
    fallback_fee_bps = get_platform_fee_bps()
    with session_scope() as db:
        buyer = db.get(User, int(user["id"]))
        buyer_plan = db.get(Plan, int(buyer.plan_id if buyer else (user.get("plan_id") or 1)))
        buyer_level = db.get(UserLevel, int(buyer.level_id or 1)) if buyer else None
        plan_discount_bps = int(buyer_plan.platform_fee_discount_bps) if buyer_plan else 0
        level_discount_bps = int(buyer_level.buyer_discount_bps) if buyer_level else 0
        discount_bps = plan_discount_bps + level_discount_bps

        levels_map = {lv.id: lv for lv in db.query(UserLevel).all()}
        shared_nodes = (
            db.query(Node)
            .filter(Node.enabled == 1, Node.share_enabled == 1)
            .order_by(Node.status.desc(), Node.id.desc())
            .all()
        )
        owners = {u.id: u for u in db.query(User).filter(User.status == "active").all()}
        items = []
        for n in shared_nodes:
            if not is_shareable_conn_type(n.conn_type):
                continue
            seller = owners.get(int(n.owner_id))
            if seller is None:
                continue
            seller_lv = levels_map.get(int(seller.level_id or 1))
            channel_name = normalize_billing_channel(n.conn_type)
            ch_base_fee_bps = resolve_channel_platform_fee_bps(
                n.conn_type,
                seller_lv,
                fallback_fees=channel_fees,
            )

            sess = tunnel_mgr.get_reverse_session(n.id)
            live_status = "connected" if (sess and not sess.is_closed) else n.status
            seller_hr = int(n.seller_price_per_hour_units or 0)
            seller_gb = int(n.seller_price_per_gb_units or 0)
            buyer_hr, eff_bps, spread_hr = compute_buyer_price_units(seller_hr, ch_base_fee_bps, discount_bps)
            buyer_gb, _, spread_gb = compute_buyer_price_units(seller_gb, ch_base_fee_bps, discount_bps)
            items.append({
                "id": n.id,
                "owner_id": n.owner_id,
                "owner_username": seller.username,
                "seller_level_code": seller_lv.code if seller_lv else "lv1",
                "seller_level_name": seller_lv.name if seller_lv else "Lv.1 青铜节点主",
                "seller_level_color": seller_lv.badge_color if seller_lv else "#94a3b8",
                "is_mine": int(n.owner_id) == int(user["id"]),
                "title": n.share_title or n.name,
                "region": n.share_region or "Global",
                "tags": n.share_tags or "",
                "conn_type": n.conn_type,
                "channel_type": channel_name,
                "status": live_status,
                "avg_latency_ms": int(n.avg_latency_ms or 0),
                "avg_speed_kbps": int(n.avg_speed_kbps or 0),
                "online_seconds": int(n.online_seconds or 0),
                "isolation_mode": n.isolation_mode or "exclusive_slot",
                "max_concurrent_leases": int(n.max_concurrent_leases or 1),
                "active_lease_count": int(n.active_lease_count or 0),
                "available_slots": max(0, max(1, int(n.max_concurrent_leases or 1)) - int(n.active_lease_count or 0)),
                "seller_hour_yuan": units_to_yuan_str(seller_hr),
                "buyer_hour_units": buyer_hr,
                "buyer_hour_yuan": units_to_yuan_str(buyer_hr),
                "buyer_gb_units": buyer_gb,
                "buyer_gb_yuan": units_to_yuan_str(buyer_gb),
                "channel_base_fee_bps": ch_base_fee_bps,
                "effective_fee_bps": eff_bps,
                "spread_hour_yuan": units_to_yuan_str(spread_hr),
                "spread_gb_yuan": units_to_yuan_str(spread_gb),
                "total_leased_seconds": int(n.total_leased_seconds or 0),
            })
        buyer_level_payload = buyer_level.to_dict() if buyer_level else None
    return {
        "nodes": items,
        "platform_fee_bps": fallback_fee_bps,
        "channel_fees": channel_fees,
        "plan_discount_bps": plan_discount_bps,
        "level_discount_bps": level_discount_bps,
        "your_discount_bps": discount_bps,
        "buyer_level": buyer_level_payload,
    }


@router.post("/api/market/nodes/{node_id}/lease", summary="租用指定共享节点（创建隔离租约并实时计时/计流）")
def lease_shared_node(node_id: int, request: Request, user: dict = Depends(verify_token)):
    client_ip = get_client_ip(request)
    enforce_rate_limit("market", f"u:{user['id']}:{client_ip}", RATE_LIMIT_MARKET_PER_MIN, 60, "租约操作过于频繁")
    try:
        lease = start_lease_sync(buyer_id=int(user["id"]), node_id=node_id, client_ip=client_ip)
    except LookupError as le:
        raise HTTPException(status_code=404, detail=str(le))
    except PermissionError as pe:
        raise HTTPException(status_code=403, detail=str(pe))
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    return {"message": "共享节点租用成功，已分配独立 CDP 会话通道", "lease": lease}


@router.get("/api/leases", summary="查看我作为买家租用的节点与作为卖家出租的收益租约")
def list_my_leases(request: Request, user: dict = Depends(verify_token)):
    uid = int(user["id"])
    hub_info = resolve_hub_access_info(request)
    ws_scheme = hub_info["ws_scheme"]
    domain = hub_info["public_netloc"]

    with session_scope() as db:
        u = db.get(User, uid)
        api_key = u.api_key if u else ""
        nodes_map = {n.id: n for n in db.query(Node).all()}
        users_map = {x.id: x.username for x in db.query(User.id, User.username).all()}

        buyer_rows = db.query(NodeLease).filter(NodeLease.buyer_id == uid).order_by(NodeLease.id.desc()).limit(100).all()
        seller_rows = db.query(NodeLease).filter(NodeLease.seller_id == uid).order_by(NodeLease.id.desc()).limit(100).all()

        def _fmt(l: NodeLease, include_ws: bool):
            d = l.to_dict()
            n = nodes_map.get(l.node_id)
            d["node_name"] = (n.share_title or n.name) if n else f"Node#{l.node_id}"
            d["seller_username"] = users_map.get(l.seller_id, f"user#{l.seller_id}")
            d["buyer_username"] = users_map.get(l.buyer_id, f"user#{l.buyer_id}")
            if include_ws and l.status == "active":
                d["cdp_ws_url"] = f"{ws_scheme}://{domain}/cdp/{l.node_id}/ws?api_key={api_key}"
                d["cdp_version_url"] = f"{hub_info['http_scheme']}://{domain}/cdp/{l.node_id}/json/version?api_key={api_key}"
            return d

        return {
            "buyer_leases": [_fmt(r, True) for r in buyer_rows],
            "seller_leases": [_fmt(r, False) for r in seller_rows],
        }


@router.post("/api/leases/{lease_id}/stop", summary="买家或卖家停止共享租约并触发尾款/差价最终结算")
async def stop_my_lease(lease_id: int, request: Request, user: dict = Depends(verify_token)):
    client_ip = get_client_ip(request)
    with session_scope() as db:
        l = db.get(NodeLease, int(lease_id))
        if l is None:
            raise HTTPException(status_code=404, detail="租约不存在")
        if int(l.buyer_id) != int(user["id"]) and int(l.seller_id) != int(user["id"]) and user.get("role") != "admin":
            raise HTTPException(status_code=403, detail="无权中止他人租约")
        if l.status != "active":
            return {"message": "租约早已结束", "lease": l.to_dict()}
        is_seller_stop = int(l.seller_id) == int(user["id"]) and int(l.buyer_id) != int(user["id"])

    end_reason = "卖家强制收回节点" if is_seller_stop else "买家主动停止租用"
    lease_dict, need_dc = settle_single_lease_sync(
        lease_id=lease_id,
        force_end_status="ended",
        end_reason=end_reason,
        actor_id=int(user["id"]),
        client_ip=client_ip,
    )
    if need_dc:
        await tunnel_mgr.disconnect_lease_streams(int(lease_dict["node_id"]), int(lease_id))
    return {"message": "租约已结算并安全关闭", "lease": lease_dict}


@router.get("/api/traffic/summary", summary="查询当前租户自有节点的流量消耗统计")
def api_tenant_traffic_summary(hours: int = Query(24, ge=1, le=168), user: dict = Depends(verify_token)):
    return get_traffic_summary(owner_id=int(user["id"]), limit_hours=hours)
