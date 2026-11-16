from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel

from config import resolve_hub_access_info
from core.db import get_setting, session_scope
from core.models import BillingLedger, Node, NodeLease, Plan, User, units_to_yuan_str, yuan_to_units
from core.rate_limit import RATE_LIMIT_MARKET_PER_MIN, enforce_rate_limit, get_client_ip
from core.security import verify_token
from services.audit_service import write_audit_log
from services.billing_service import (
    compute_buyer_price_units,
    get_platform_fee_bps,
    settle_single_lease_sync,
    start_lease_sync,
)
from services.traffic_service import get_traffic_summary
from services.tunnel_manager import tunnel_mgr

router = APIRouter(tags=["共享节点交易市场、套餐与钱包结算"])


class LeaseCreateDTO(BaseModel):
    remark: str = ""


class RechargeDTO(BaseModel):
    amount_yuan: float = 20.0


class PlanSubscribeDTO(BaseModel):
    plan_id: int


@router.get("/api/plans", summary="获取 SaaS 会员套餐列表")
def list_plans(user: dict = Depends(verify_token)):
    with session_scope() as db:
        plans = [p.to_dict() for p in db.query(Plan).order_by(Plan.monthly_price_units.asc(), Plan.id.asc()).all()]
    return {"plans": plans, "current_plan_id": user.get("plan_id")}


@router.post("/api/plans/subscribe", summary="升级或切换会员套餐（按月费余额扣款）")
def subscribe_plan(data: PlanSubscribeDTO, request: Request, user: dict = Depends(verify_token)):
    client_ip = get_client_ip(request)
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with session_scope() as db:
        u = db.get(User, int(user["id"]))
        plan = db.get(Plan, int(data.plan_id))
        if u is None or plan is None:
            raise HTTPException(status_code=404, detail="用户或套餐不存在")
        if int(u.plan_id) == int(plan.id):
            raise HTTPException(status_code=400, detail="您当前已处于该套餐")
        price = int(plan.monthly_price_units or 0)
        if int(u.balance_units or 0) < price:
            raise HTTPException(status_code=402, detail=f"余额不足，升级 [{plan.name}] 需要 ¥{units_to_yuan_str(price)}")

        if price > 0:
            u.balance_units = int(u.balance_units or 0) - price
            u.total_spent_units = int(u.total_spent_units or 0) + price
            db.add(
                BillingLedger(
                    user_id=u.id,
                    tx_type="plan_purchase",
                    amount_units=-price,
                    balance_after_units=u.balance_units,
                    platform_spread_units=price,
                    remark=f"开通/切换会员套餐 [{plan.name}]",
                    created_at=now_str,
                )
            )
        u.plan_id = plan.id
        db.flush()
        user_payload = u.to_dict(include_secrets=True)
        plan_payload = plan.to_dict()

    write_audit_log(
        action="plan_subscribe",
        actor_id=user["id"],
        actor_username=user["username"],
        target_type="plan",
        target_id=plan_payload["id"],
        ip=client_ip,
        status="ok",
        details={"plan_code": plan_payload["code"], "price_yuan": units_to_yuan_str(price)},
    )
    return {"message": f"已成功切换至 [{plan_payload['name']}]", "user": user_payload, "plan": plan_payload}


@router.get("/api/market/nodes", summary="浏览当前全平台可租用的共享算力节点市场（显示买家价）")
def list_marketplace_nodes(user: dict = Depends(verify_token)):
    fee_bps = get_platform_fee_bps()
    with session_scope() as db:
        buyer_plan = db.get(Plan, int(user.get("plan_id") or 1))
        discount_bps = int(buyer_plan.platform_fee_discount_bps) if buyer_plan else 0
        shared_nodes = (
            db.query(Node)
            .filter(Node.enabled == 1, Node.share_enabled == 1)
            .order_by(Node.status.desc(), Node.id.desc())
            .all()
        )
        owners = {
            u.id: u.username
            for u in db.query(User.id, User.username).filter(User.status == "active").all()
        }
        items = []
        for n in shared_nodes:
            if int(n.owner_id) not in owners:
                continue
            sess = tunnel_mgr.get_reverse_session(n.id) if n.conn_type in ("reverse", "public_wss", "wss_direct") else None
            live_status = "connected" if (sess and not sess.is_closed) else n.status
            seller_hr = int(n.seller_price_per_hour_units or 0)
            seller_gb = int(n.seller_price_per_gb_units or 0)
            buyer_hr, eff_bps, spread_hr = compute_buyer_price_units(seller_hr, fee_bps, discount_bps)
            buyer_gb, _, spread_gb = compute_buyer_price_units(seller_gb, fee_bps, discount_bps)
            items.append({
                "id": n.id,
                "owner_id": n.owner_id,
                "owner_username": owners.get(n.owner_id, f"user#{n.owner_id}"),
                "is_mine": int(n.owner_id) == int(user["id"]),
                "title": n.share_title or n.name,
                "region": n.share_region or "Global",
                "tags": n.share_tags or "",
                "conn_type": n.conn_type,
                "status": live_status,
                "isolation_mode": n.isolation_mode or "exclusive_slot",
                "max_concurrent_leases": int(n.max_concurrent_leases or 1),
                "active_lease_count": int(n.active_lease_count or 0),
                "available_slots": max(0, max(1, int(n.max_concurrent_leases or 1)) - int(n.active_lease_count or 0)),
                "seller_hour_yuan": units_to_yuan_str(seller_hr),
                "buyer_hour_units": buyer_hr,
                "buyer_hour_yuan": units_to_yuan_str(buyer_hr),
                "buyer_gb_units": buyer_gb,
                "buyer_gb_yuan": units_to_yuan_str(buyer_gb),
                "effective_fee_bps": eff_bps,
                "spread_hour_yuan": units_to_yuan_str(spread_hr),
                "spread_gb_yuan": units_to_yuan_str(spread_gb),
                "total_leased_seconds": int(n.total_leased_seconds or 0),
            })
    return {"nodes": items, "platform_fee_bps": fee_bps, "your_discount_bps": discount_bps}


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


@router.post("/api/leases/{lease_id}/stop", summary="买家主动停止共享租约并触发尾款/差价最终结算")
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

    end_reason = "卖家强制收回节点" if int(l.seller_id) == int(user["id"]) and int(l.buyer_id) != int(user["id"]) else "买家主动停止租用"
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


@router.get("/api/billing/overview", summary="查询个人钱包余额、收支统计与明细流水")
def billing_overview(user: dict = Depends(verify_token)):
    uid = int(user["id"])
    with session_scope() as db:
        u = db.get(User, uid)
        if u is None:
            raise HTTPException(status_code=404, detail="用户不存在")
        plan = db.get(Plan, u.plan_id)
        ledger = [
            row.to_dict()
            for row in db.query(BillingLedger).filter(BillingLedger.user_id == uid).order_by(BillingLedger.id.desc()).limit(100).all()
        ]
        active_leases_cnt = db.query(NodeLease).filter(NodeLease.buyer_id == uid, NodeLease.status == "active").count()
        owned_nodes_cnt = db.query(Node).filter(Node.owner_id == uid).count()

    return {
        "user": u.to_dict(include_secrets=True),
        "plan": plan.to_dict() if plan else None,
        "quotas": {
            "owned_nodes": owned_nodes_cnt,
            "max_nodes": int(plan.max_nodes) if plan else 3,
            "active_leases": active_leases_cnt,
            "max_active_leases": int(plan.max_active_leases) if plan else 2,
            "monthly_traffic_bytes": int(u.monthly_traffic_bytes or 0),
            "max_monthly_traffic_bytes": int(plan.max_monthly_traffic_bytes) if plan else 10 * 1024 * 1024 * 1024,
        },
        "allow_self_recharge": get_setting("saas_allow_self_recharge", "1") == "1",
        "ledger": ledger,
    }


@router.post("/api/billing/recharge", summary="租户自助模拟充值余额（生产可对接支付回调）")
def self_recharge(data: RechargeDTO, request: Request, user: dict = Depends(verify_token)):
    if get_setting("saas_allow_self_recharge", "1") != "1" and user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="当前未开启自助演示充值，请联系管理员入账")
    if data.amount_yuan <= 0 or data.amount_yuan > 10000:
        raise HTTPException(status_code=400, detail="单次充值金额需在 0.01 ~ 10000 元之间")

    add_units = yuan_to_units(data.amount_yuan)
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with session_scope() as db:
        u = db.get(User, int(user["id"]))
        if u is None:
            raise HTTPException(status_code=404, detail="用户不存在")
        u.balance_units = int(u.balance_units or 0) + add_units
        u.total_recharged_units = int(u.total_recharged_units or 0) + add_units
        db.add(
            BillingLedger(
                user_id=u.id,
                tx_type="recharge",
                amount_units=add_units,
                balance_after_units=u.balance_units,
                platform_spread_units=0,
                remark=f"自助充值到账 ¥{units_to_yuan_str(add_units)}",
                created_at=now_str,
            )
        )
        db.flush()
        user_payload = u.to_dict(include_secrets=True)

    write_audit_log(
        action="wallet_recharge",
        actor_id=user["id"],
        actor_username=user["username"],
        target_type="user",
        target_id=user["id"],
        ip=get_client_ip(request),
        status="ok",
        details={"amount_yuan": units_to_yuan_str(add_units), "balance_after": user_payload["balance_yuan"]},
    )
    return {"message": f"成功充值 ¥{units_to_yuan_str(add_units)}", "user": user_payload}


@router.get("/api/traffic/summary", summary="查询当前租户自有节点的流量消耗统计")
def api_tenant_traffic_summary(hours: int = Query(24, ge=1, le=168), user: dict = Depends(verify_token)):
    return get_traffic_summary(owner_id=int(user["id"]), limit_hours=hours)
