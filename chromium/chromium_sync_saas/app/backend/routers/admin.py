from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import func

from core.cache import cache_mgr
from core.db import get_active_db_info, get_setting, load_bootstrap_config, save_bootstrap_config, session_scope, set_setting
from core.models import BillingLedger, Node, NodeLease, Plan, User, units_to_yuan_str, yuan_to_units
from core.rate_limit import get_antispam_stats, get_client_ip
from core.security import require_admin
from services.audit_service import write_audit_log
from services.billing_service import settle_single_lease_sync
from services.traffic_service import get_traffic_summary
from services.tunnel_manager import tunnel_mgr

router = APIRouter(tags=["SaaS 超级管理员运营台"])


class AdminSettingsDTO(BaseModel):
    saas_platform_fee_bps: Optional[int] = None
    saas_allow_public_register: Optional[bool] = None
    saas_allow_self_recharge: Optional[bool] = None
    saas_welcome_bonus_yuan: Optional[float] = None


class AdminUserUpdateDTO(BaseModel):
    role: Optional[str] = None
    status: Optional[str] = None
    plan_id: Optional[int] = None
    adjust_balance_yuan: Optional[float] = None
    adjust_remark: str = ""


class AdminPlanUpdateDTO(BaseModel):
    name: Optional[str] = None
    monthly_price_yuan: Optional[float] = None
    max_nodes: Optional[int] = None
    max_active_leases: Optional[int] = None
    max_monthly_traffic_gb: Optional[float] = None
    platform_fee_discount_bps: Optional[int] = None
    can_share_nodes: Optional[bool] = None


class RedisReloadDTO(BaseModel):
    redis_url: str = ""


@router.get("/api/admin/overview", summary="平台总营收、差价抽成、租户与共享节点大盘（Admin）")
def admin_overview(admin: dict = Depends(require_admin)):
    with session_scope() as db:
        total_users = db.query(User).count()
        active_users = db.query(User).filter(User.status == "active").count()
        total_nodes = db.query(Node).count()
        shared_nodes = db.query(Node).filter(Node.share_enabled == 1).count()
        active_leases = db.query(NodeLease).filter(NodeLease.status == "active").count()
        total_leases = db.query(NodeLease).count()
        spread_sum = db.query(func.coalesce(func.sum(NodeLease.platform_profit_units), 0)).scalar() or 0
        gmv_sum = db.query(func.coalesce(func.sum(NodeLease.buyer_spent_units), 0)).scalar() or 0
        seller_sum = db.query(func.coalesce(func.sum(NodeLease.seller_earned_units), 0)).scalar() or 0
        recent_leases = [l.to_dict() for l in db.query(NodeLease).order_by(NodeLease.id.desc()).limit(50).all()]

    return {
        "metrics": {
            "total_users": total_users,
            "active_users": active_users,
            "total_nodes": total_nodes,
            "shared_nodes": shared_nodes,
            "active_leases": active_leases,
            "total_leases": total_leases,
            "platform_profit_units": int(spread_sum),
            "platform_profit_yuan": units_to_yuan_str(int(spread_sum)),
            "gmv_units": int(gmv_sum),
            "gmv_yuan": units_to_yuan_str(int(gmv_sum)),
            "seller_payout_units": int(seller_sum),
            "seller_payout_yuan": units_to_yuan_str(int(seller_sum)),
        },
        "settings": {
            "saas_platform_fee_bps": int(get_setting("saas_platform_fee_bps", "2000") or 2000),
            "saas_allow_public_register": get_setting("saas_allow_public_register", "1") == "1",
            "saas_allow_self_recharge": get_setting("saas_allow_self_recharge", "1") == "1",
            "saas_welcome_bonus_yuan": float(units_to_yuan_str(int(get_setting("saas_welcome_bonus_units", "100000") or 0))),
        },
        "runtime": {
            "db": get_active_db_info(),
            "cache": cache_mgr.get_status(),
            "antispam": get_antispam_stats(),
        },
        "recent_leases": recent_leases,
        "traffic": get_traffic_summary(owner_id=None, limit_hours=24),
    }


@router.post("/api/admin/settings", summary="调整平台抽成差价比例、公开注册开关与新用户赠金")
def admin_update_settings(data: AdminSettingsDTO, request: Request, admin: dict = Depends(require_admin)):
    if data.saas_platform_fee_bps is not None:
        bps = max(0, min(10000, int(data.saas_platform_fee_bps)))
        set_setting("saas_platform_fee_bps", str(bps))
    if data.saas_allow_public_register is not None:
        set_setting("saas_allow_public_register", "1" if data.saas_allow_public_register else "0")
    if data.saas_allow_self_recharge is not None:
        set_setting("saas_allow_self_recharge", "1" if data.saas_allow_self_recharge else "0")
    if data.saas_welcome_bonus_yuan is not None:
        set_setting("saas_welcome_bonus_units", str(max(0, yuan_to_units(data.saas_welcome_bonus_yuan))))

    write_audit_log(
        action="admin_update_settings",
        actor_id=admin["id"],
        actor_username=admin["username"],
        target_type="platform_settings",
        target_id="saas_global",
        ip=get_client_ip(request),
        status="ok",
        details=data.model_dump(exclude_none=True),
    )
    return {"message": "平台商业化全局策略已更新"}


@router.get("/api/admin/users", summary="查看全部租户、配额占用与钱包情况")
def admin_list_users(admin: dict = Depends(require_admin)):
    with session_scope() as db:
        plans_map = {p.id: p.name for p in db.query(Plan).all()}
        node_counts = dict(db.query(Node.owner_id, func.count(Node.id)).group_by(Node.owner_id).all())
        lease_counts = dict(
            db.query(NodeLease.buyer_id, func.count(NodeLease.id))
            .filter(NodeLease.status == "active")
            .group_by(NodeLease.buyer_id)
            .all()
        )
        users = []
        for u in db.query(User).order_by(User.id.asc()).all():
            d = u.to_dict(include_secrets=False)
            d["plan_name"] = plans_map.get(u.plan_id, f"Plan#{u.plan_id}")
            d["node_count"] = int(node_counts.get(u.id, 0))
            d["active_lease_count"] = int(lease_counts.get(u.id, 0))
            users.append(d)
    return users


@router.put("/api/admin/users/{uid}", summary="管理员调整租户状态、角色、套餐或后台调账")
def admin_update_user(uid: int, data: AdminUserUpdateDTO, request: Request, admin: dict = Depends(require_admin)):
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with session_scope() as db:
        u = db.get(User, int(uid))
        if u is None:
            raise HTTPException(status_code=404, detail="目标用户不存在")
        if data.role in {"user", "admin"}:
            if int(u.id) == int(admin["id"]) and data.role != "admin":
                raise HTTPException(status_code=400, detail="不能降级当前操作者自己的管理员权限")
            u.role = data.role
        if data.status in {"active", "suspended"}:
            if int(u.id) == int(admin["id"]) and data.status != "active":
                raise HTTPException(status_code=400, detail="不能停用当前登录的管理员自身")
            u.status = data.status
        if data.plan_id is not None:
            if db.get(Plan, int(data.plan_id)) is None:
                raise HTTPException(status_code=404, detail="目标套餐不存在")
            u.plan_id = int(data.plan_id)
        if data.adjust_balance_yuan is not None and abs(data.adjust_balance_yuan) > 0:
            delta = yuan_to_units(data.adjust_balance_yuan)
            u.balance_units = max(0, int(u.balance_units or 0) + delta)
            if delta > 0:
                u.total_recharged_units = int(u.total_recharged_units or 0) + delta
            db.add(
                BillingLedger(
                    user_id=u.id,
                    tx_type="admin_adjust",
                    amount_units=delta,
                    balance_after_units=u.balance_units,
                    platform_spread_units=0,
                    remark=data.adjust_remark or f"管理员人工调账 ({units_to_yuan_str(delta)} 元)",
                    created_at=now_str,
                )
            )
        db.flush()
        out = u.to_dict(include_secrets=False)

    write_audit_log(
        action="admin_update_user",
        actor_id=admin["id"],
        actor_username=admin["username"],
        target_type="user",
        target_id=uid,
        ip=get_client_ip(request),
        status="ok",
        details=data.model_dump(exclude_none=True),
    )
    return {"message": f"租户 [{out['username']}] 已更新", "user": out}


@router.put("/api/admin/plans/{pid}", summary="调整套餐月价、节点配额与抽成折扣")
def admin_update_plan(pid: int, data: AdminPlanUpdateDTO, request: Request, admin: dict = Depends(require_admin)):
    with session_scope() as db:
        p = db.get(Plan, int(pid))
        if p is None:
            raise HTTPException(status_code=404, detail="套餐不存在")
        if data.name is not None:
            p.name = data.name.strip()[:128]
        if data.monthly_price_yuan is not None:
            p.monthly_price_units = max(0, yuan_to_units(data.monthly_price_yuan))
        if data.max_nodes is not None:
            p.max_nodes = max(1, int(data.max_nodes))
        if data.max_active_leases is not None:
            p.max_active_leases = max(1, int(data.max_active_leases))
        if data.max_monthly_traffic_gb is not None:
            p.max_monthly_traffic_bytes = max(1, int(data.max_monthly_traffic_gb * 1024 * 1024 * 1024))
        if data.platform_fee_discount_bps is not None:
            p.platform_fee_discount_bps = max(0, min(10000, int(data.platform_fee_discount_bps)))
        if data.can_share_nodes is not None:
            p.can_share_nodes = 1 if data.can_share_nodes else 0
        db.flush()
        saved = p.to_dict()

    write_audit_log(
        action="admin_update_plan",
        actor_id=admin["id"],
        actor_username=admin["username"],
        target_type="plan",
        target_id=pid,
        ip=get_client_ip(request),
        status="ok",
        details=saved,
    )
    return {"message": "套餐配置已保存", "plan": saved}


@router.post("/api/admin/leases/{lease_id}/revoke", summary="管理员风控强制中止异常租约并立即结算断流")
async def admin_revoke_lease(lease_id: int, request: Request, admin: dict = Depends(require_admin)):
    client_ip = get_client_ip(request)
    lease_dict, need_dc = settle_single_lease_sync(
        lease_id=lease_id,
        force_end_status="revoked",
        end_reason="管理员风控强制中止",
        actor_id=int(admin["id"]),
        client_ip=client_ip,
    )
    if need_dc:
        await tunnel_mgr.disconnect_lease_streams(int(lease_dict["node_id"]), int(lease_id))
    return {"message": f"租约 #{lease_id} 已被强制中止并完成尾款结算", "lease": lease_dict}


@router.post("/api/system/cache/reload", summary="热更新 Redis 缓存配置（Admin）")
def admin_reload_cache(data: RedisReloadDTO, admin: dict = Depends(require_admin)):
    new_url = (data.redis_url or "").strip()
    boot = load_bootstrap_config()
    boot["redis_url"] = new_url
    save_bootstrap_config(boot)
    backend = cache_mgr.reload_from_config(new_url)
    return {"message": f"缓存引擎已切换为: {backend}", "cache": cache_mgr.get_status()}
