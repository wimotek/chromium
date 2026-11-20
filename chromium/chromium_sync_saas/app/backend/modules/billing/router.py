import asyncio
from datetime import datetime, timedelta
import hashlib
import hmac
import json
import secrets
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from sqlalchemy import func, or_

from config import logger
from core.db import get_setting, session_scope
from core.models import (
    BillingLedger,
    Node,
    NodeLease,
    Plan,
    RechargeOrder,
    ReferralReward,
    User,
    units_to_yuan_str,
    yuan_to_units,
)
from core.rate_limit import get_client_ip
from core.security import verify_token
from modules.audit.service import write_audit_log
from modules.billing.payment_gateway import (
    create_alipay_order,
    create_wechat_native_order,
    get_effective_alipay_public_key,
    infer_base_url_from_request,
    is_alipay_api_configured,
    is_wechat_v3_configured,
    query_alipay_order,
    query_wechat_order,
    verify_alipay_notify_signature,
    verify_and_decrypt_wechat_v3_notify,
)
from modules.billing.service import get_all_channel_fee_bps, get_self_reverse_hub_gb_units
from modules.users.level_service import get_user_level_progress

router = APIRouter(tags=["财务系统（套餐 · 钱包 · 充值 · 账单）"])


def _get_alipay_gateway_cfg() -> Dict[str, Any]:
    f2f_on = get_setting("saas_alipay_f2f_enabled", "1") == "1"
    page_on = get_setting("saas_alipay_page_enabled", "1") == "1"
    static_on = get_setting("saas_alipay_static_enabled", "0") == "1"
    return {
        "enabled": f2f_on or page_on or static_on,
        "mode": get_setting("saas_alipay_mode", "precreate") or "precreate",
        "sign_mode": get_setting("saas_alipay_sign_mode", "public_key") or "public_key",
        "app_id": get_setting("saas_alipay_app_id", ""),
        "private_key": get_setting("saas_alipay_private_key", ""),
        "public_key": get_setting("saas_alipay_public_key", ""),
        "app_cert": get_setting("saas_alipay_app_cert", ""),
        "cert_public_key": get_setting("saas_alipay_cert_public_key", ""),
        "root_cert": get_setting("saas_alipay_root_cert", ""),
        "gateway_url": get_setting("saas_alipay_gateway_url", "https://openapi.alipay.com/gateway.do"),
        "notify_url": get_setting("saas_alipay_notify_url", ""),
        "return_url": get_setting("saas_alipay_return_url", ""),
        "qr_url": get_setting("saas_alipay_qr_url", ""),
    }


def _get_wechat_gateway_cfg() -> Dict[str, Any]:
    native_on = get_setting("saas_wechat_native_enabled", "1") == "1"
    static_on = get_setting("saas_wechat_static_enabled", "0") == "1"
    return {
        "enabled": native_on or static_on,
        "mode": get_setting("saas_wechat_mode", "native_v3") or "native_v3",
        "app_id": get_setting("saas_wechat_app_id", ""),
        "mch_id": get_setting("saas_wechat_mch_id", ""),
        "serial_no": get_setting("saas_wechat_serial_no", ""),
        "private_key": get_setting("saas_wechat_private_key", ""),
        "api_v3_key": get_setting("saas_wechat_api_v3_key", ""),
        "platform_public_key": get_setting("saas_wechat_platform_public_key", ""),
        "gateway_url": get_setting("saas_wechat_gateway_url", "https://api.mch.weixin.qq.com"),
        "notify_url": get_setting("saas_wechat_notify_url", ""),
        "qr_url": get_setting("saas_wechat_qr_url", ""),
    }


def _build_payment_methods_matrix(alipay_cfg: Dict[str, Any], wechat_cfg: Dict[str, Any]) -> list:
    alipay_api_ok = is_alipay_api_configured(alipay_cfg)
    wechat_api_ok = is_wechat_v3_configured(wechat_cfg)

    f2f_on = get_setting("saas_alipay_f2f_enabled", "1") == "1"
    page_on = get_setting("saas_alipay_page_enabled", "1") == "1"
    alipay_static_on = get_setting("saas_alipay_static_enabled", "0") == "1"
    wechat_native_on = get_setting("saas_wechat_native_enabled", "1") == "1"
    wechat_static_on = get_setting("saas_wechat_static_enabled", "0") == "1"

    return [
        {
            "id": "alipay_f2f",
            "channel": "alipay",
            "mode": "precreate",
            "name": "支付宝当面付",
            "badge": "官方扫码 · 自动到账",
            "description": "生成本次订单专属收款二维码，请打开手机支付宝扫一扫完成付款，支付后自动实时到账",
            "configured": alipay_api_ok,
            "enabled": f2f_on,
        },
        {
            "id": "alipay_page",
            "channel": "alipay",
            "mode": "page_pay",
            "name": "支付宝电脑网站支付",
            "badge": "官方网页收银台",
            "description": "跳转至支付宝官方网页收银台（alipay.trade.page.pay）扫码或登录完成付款",
            "configured": alipay_api_ok,
            "enabled": page_on,
        },
        {
            "id": "alipay_static",
            "channel": "alipay",
            "mode": "static_qr",
            "name": "支付宝扫码转账",
            "badge": "人工收款 · 核账入账",
            "description": "打开手机支付宝扫描下方专属收款码完成转账，付款后将由平台管理员核账确认入账",
            "configured": bool(str(alipay_cfg.get("qr_url") or "").strip()),
            "enabled": alipay_static_on,
        },
        {
            "id": "wechat_native",
            "channel": "wechat",
            "mode": "native_v3",
            "name": "微信支付 V3",
            "badge": "官方 Native 扫码",
            "description": "直连微信支付商户 API V3 生成专属付款码，打开微信扫一扫支付后自动实时到账",
            "configured": wechat_api_ok,
            "enabled": wechat_native_on,
        },
        {
            "id": "wechat_static",
            "channel": "wechat",
            "mode": "static_qr",
            "name": "微信扫码转账",
            "badge": "人工收款 · 核账入账",
            "description": "打开手机微信扫描下方专属收款码完成转账，付款后将由平台管理员核账确认入账",
            "configured": bool(str(wechat_cfg.get("qr_url") or "").strip()),
            "enabled": wechat_static_on,
        },
    ]


class RechargeDTO(BaseModel):
    amount_yuan: float = 20.0


class RechargeCreateDTO(BaseModel):
    channel: str = "alipay"
    pay_method: Optional[str] = None
    amount_yuan: float = 20.0
    remark: str = ""


class PlanSubscribeDTO(BaseModel):
    plan_id: int


def _mark_recharge_order_paid_sync(
    db,
    order_no: str,
    expected_channel: Optional[str],
    external_trade_no: str,
    paid_remark: str,
    allow_cancelled: bool = False,
) -> Dict[str, Any]:
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    allowed_statuses = ["pending", "cancelled"] if allow_cancelled else ["pending"]
    q = db.query(RechargeOrder).filter(
        RechargeOrder.order_no == order_no,
        RechargeOrder.status.in_(allowed_statuses),
    )
    if expected_channel:
        q = q.filter(RechargeOrder.channel == expected_channel)

    affected = q.update(
        {
            RechargeOrder.status: "paid",
            RechargeOrder.paid_at: now_str,
            RechargeOrder.external_trade_no: external_trade_no[:128],
        },
        synchronize_session=False,
    )

    order = db.query(RechargeOrder).filter(RechargeOrder.order_no == order_no).first()
    if order is None:
        raise HTTPException(status_code=404, detail="充值订单不存在")
    if affected == 0:
        if order.status != "paid":
            raise HTTPException(status_code=400, detail=f"订单当前状态为 {order.status}，无法入账")
        u = db.get(User, int(order.user_id))
        return {
            "already_paid": True,
            "order": order.to_dict(),
            "user": u.to_dict(include_secrets=True) if u else None,
        }

    u = db.get(User, int(order.user_id))
    if u is None:
        raise HTTPException(status_code=404, detail="订单所属用户不存在")

    add_units = int(order.amount_units or 0)
    db.query(User).filter(User.id == u.id).update(
        {
            User.balance_units: User.balance_units + add_units,
            User.total_recharged_units: User.total_recharged_units + add_units,
        },
        synchronize_session=False,
    )
    db.expire(u)
    u = db.get(User, int(order.user_id))
    db.add(
        BillingLedger(
            user_id=u.id,
            tx_type=f"recharge_{order.channel}",
            amount_units=add_units,
            balance_after_units=int(u.balance_units or 0),
            platform_spread_units=0,
            remark=paid_remark,
            created_at=now_str,
        )
    )
    db.flush()
    return {
        "already_paid": False,
        "order": order.to_dict(),
        "user": u.to_dict(include_secrets=True),
    }


def _plan_tier_key(plan: Plan) -> tuple:
    return (
        int(plan.monthly_price_units or 0),
        int(plan.max_nodes or 0),
        int(plan.max_active_leases or 0),
        int(plan.max_monthly_traffic_bytes or 0),
        int(plan.platform_fee_discount_bps or 0),
        int(plan.id or 0),
    )


def _evaluate_plan_relation(target_plan: Plan, current_plan: Optional[Plan]) -> Dict[str, Any]:
    target_price = max(0, int(target_plan.monthly_price_units or 0))
    if current_plan is None:
        return {
            "relation": "upgrade",
            "can_upgrade": True,
            "upgrade_price_units": target_price,
            "upgrade_price_yuan": units_to_yuan_str(target_price),
            "is_diff_pricing": False,
        }
    if int(target_plan.id) == int(current_plan.id):
        return {
            "relation": "current",
            "can_upgrade": False,
            "upgrade_price_units": 0,
            "upgrade_price_yuan": units_to_yuan_str(0),
            "is_diff_pricing": False,
        }
    if _plan_tier_key(target_plan) <= _plan_tier_key(current_plan):
        return {
            "relation": "lower",
            "can_upgrade": False,
            "upgrade_price_units": 0,
            "upgrade_price_yuan": units_to_yuan_str(0),
            "is_diff_pricing": False,
        }
    current_price = max(0, int(current_plan.monthly_price_units or 0))
    diff_units = max(0, target_price - current_price)
    return {
        "relation": "upgrade",
        "can_upgrade": True,
        "upgrade_price_units": diff_units,
        "upgrade_price_yuan": units_to_yuan_str(diff_units),
        "is_diff_pricing": current_price > 0 and diff_units < target_price,
    }


@router.get("/api/plans", summary="获取 SaaS 会员套餐列表")
def list_plans(user: dict = Depends(verify_token)):
    with session_scope() as db:
        u = db.get(User, int(user["id"]))
        current_plan_id = int(u.plan_id) if u is not None else int(user.get("plan_id") or 0)
        plan_rows = sorted(db.query(Plan).all(), key=_plan_tier_key)
        current_plan = next((p for p in plan_rows if int(p.id) == current_plan_id), None)
        plans = []
        for idx, p in enumerate(plan_rows, start=1):
            d = p.to_dict()
            d["tier_rank"] = idx
            d.update(_evaluate_plan_relation(p, current_plan))
            plans.append(d)
    is_highest_plan = bool(current_plan is not None and all(p["relation"] != "upgrade" for p in plans))
    return {
        "plans": plans,
        "current_plan_id": current_plan_id,
        "is_highest_plan": is_highest_plan,
    }


@router.post("/api/plans/subscribe", summary="升级会员套餐（仅支持向更高级别升级，按差价扣款）")
def subscribe_plan(data: PlanSubscribeDTO, request: Request, user: dict = Depends(verify_token)):
    client_ip = get_client_ip(request)
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with session_scope() as db:
        u = db.get(User, int(user["id"]))
        plan = db.get(Plan, int(data.plan_id))
        if u is None or plan is None:
            raise HTTPException(status_code=404, detail="用户或套餐不存在")

        current_plan_id = int(u.plan_id or 0)
        current_plan = db.get(Plan, current_plan_id) if current_plan_id else None
        rel = _evaluate_plan_relation(plan, current_plan)

        if rel["relation"] == "current":
            raise HTTPException(status_code=400, detail="您当前已处于该套餐")
        if rel["relation"] == "lower":
            cur_name = current_plan.name if current_plan is not None else "当前套餐"
            raise HTTPException(
                status_code=400,
                detail=f"您当前已处于更高级别套餐 [{cur_name}]，不可降级至 [{plan.name}]；如需调整套餐请联系管理员",
            )

        upgrade_price = int(rel["upgrade_price_units"] or 0)
        cur_balance = int(u.balance_units or 0)
        if cur_balance < upgrade_price:
            if rel["is_diff_pricing"] and current_plan is not None:
                msg = (
                    f"余额不足，从 [{current_plan.name}] 补差价升级至 [{plan.name}] 需要 "
                    f"¥{units_to_yuan_str(upgrade_price)}（当前余额 ¥{units_to_yuan_str(cur_balance)}）"
                )
            else:
                msg = (
                    f"余额不足，升级至 [{plan.name}] 需要 "
                    f"¥{units_to_yuan_str(upgrade_price)}（当前余额 ¥{units_to_yuan_str(cur_balance)}）"
                )
            raise HTTPException(status_code=402, detail=msg)

        if upgrade_price > 0:
            affected = (
                db.query(User)
                .filter(
                    User.id == u.id,
                    User.plan_id == current_plan_id,
                    User.balance_units >= upgrade_price,
                )
                .update(
                    {
                        User.balance_units: User.balance_units - upgrade_price,
                        User.total_spent_units: User.total_spent_units + upgrade_price,
                        User.plan_id: plan.id,
                    },
                    synchronize_session=False,
                )
            )
            if affected == 0:
                raise HTTPException(status_code=409, detail="套餐状态或余额已发生变动，请刷新后重试")
            db.expire(u)
            u = db.get(User, int(user["id"]))
            remark = (
                f"套餐升级 [{current_plan.name}] → [{plan.name}]（补差价 ¥{units_to_yuan_str(upgrade_price)}）"
                if (rel["is_diff_pricing"] and current_plan is not None)
                else f"升级会员套餐 [{plan.name}]"
            )
            db.add(
                BillingLedger(
                    user_id=u.id,
                    tx_type="plan_purchase",
                    amount_units=-upgrade_price,
                    balance_after_units=int(u.balance_units or 0),
                    platform_spread_units=upgrade_price,
                    remark=remark,
                    created_at=now_str,
                )
            )
        else:
            u.plan_id = plan.id

        db.flush()
        from_plan_code = current_plan.code if current_plan is not None else ""
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
        details={
            "from_plan_code": from_plan_code,
            "plan_code": plan_payload["code"],
            "price_yuan": units_to_yuan_str(upgrade_price),
            "is_diff_pricing": bool(rel["is_diff_pricing"]),
        },
    )
    return {
        "message": f"已成功升级至 [{plan_payload['name']}]",
        "user": user_payload,
        "plan": plan_payload,
    }


@router.get("/api/billing/overview", summary="查询个人钱包余额、自用双通道计费规则、推广领奖与收支流水")
def billing_overview(user: dict = Depends(verify_token)):
    uid = int(user["id"])
    now_dt = datetime.now()
    current_ym = now_dt.strftime("%Y-%m")
    today_str = now_dt.strftime("%Y-%m-%d")

    with session_scope() as db:
        u = db.get(User, uid)
        if u is None:
            raise HTTPException(status_code=404, detail="用户不存在")
        plan = db.get(Plan, u.plan_id)
        level_progress = get_user_level_progress(db, u)
        ledger = [
            row.to_dict()
            for row in db.query(BillingLedger).filter(BillingLedger.user_id == uid).order_by(BillingLedger.id.desc()).limit(100).all()
        ]
        orders = [
            o.to_dict()
            for o in db.query(RechargeOrder).filter(RechargeOrder.user_id == uid).order_by(RechargeOrder.id.desc()).limit(30).all()
        ]
        active_leases_cnt = db.query(NodeLease).filter(NodeLease.buyer_id == uid, NodeLease.status == "active").count()
        owned_nodes_cnt = db.query(Node).filter(Node.owner_id == uid).count()
        invited_count = db.query(ReferralReward).filter(ReferralReward.inviter_id == uid).count()
        earned_referral_units = (
            db.query(func.coalesce(func.sum(ReferralReward.inviter_bonus_units), 0))
            .filter(ReferralReward.inviter_id == uid)
            .scalar()
            or 0
        )
        user_payload = u.to_dict(include_secrets=True)
        plan_payload = plan.to_dict() if plan else None

    self_rev_units = get_self_reverse_hub_gb_units()
    monthly_claim_units = max(0, int(get_setting("saas_monthly_claim_units", "100000") or 0))
    daily_checkin_units = max(0, int(get_setting("saas_daily_checkin_units", "5000") or 0))
    daily_streak_units = max(0, int(get_setting("saas_daily_streak_bonus_units", "1000") or 0))
    ref_inviter_units = max(0, int(get_setting("saas_referral_inviter_bonus_units", "50000") or 0))
    ref_invitee_units = max(0, int(get_setting("saas_referral_invitee_bonus_units", "30000") or 0))

    return {
        "user": user_payload,
        "plan": plan_payload,
        "level": level_progress.get("current_level"),
        "level_progress": level_progress,
        "channel_fees": get_all_channel_fee_bps(),
        "quotas": {
            "owned_nodes": owned_nodes_cnt,
            "max_nodes": int(plan_payload["max_nodes"]) if plan_payload else 3,
            "active_leases": active_leases_cnt,
            "max_active_leases": int(plan_payload["max_active_leases"]) if plan_payload else 2,
            "monthly_traffic_bytes": int(user_payload["monthly_traffic_bytes"] or 0),
            "max_monthly_traffic_bytes": int(plan_payload["max_monthly_traffic_bytes"]) if plan_payload else 10 * 1024 * 1024 * 1024,
        },
        "referral": {
            "enabled": get_setting("saas_referral_enabled", "1") == "1",
            "invite_code": user_payload.get("invite_code", ""),
            "invited_count": int(invited_count),
            "earned_yuan": units_to_yuan_str(int(earned_referral_units)),
            "inviter_bonus_yuan": units_to_yuan_str(ref_inviter_units),
            "invitee_bonus_yuan": units_to_yuan_str(ref_invitee_units),
        },
        "self_use_billing": {
            "public_wss_node_yuan": "0.00",
            "public_wss_hub_yuan": "0.00",
            "reverse_node_yuan": "0.00",
            "reverse_hub_gb_units": self_rev_units,
            "reverse_hub_gb_yuan": units_to_yuan_str(self_rev_units),
            "self_reverse_billed_bytes": int(user_payload.get("self_reverse_billed_bytes") or 0),
            "self_reverse_billed_units": int(user_payload.get("self_reverse_billed_units") or 0),
            "self_reverse_billed_yuan": user_payload.get("self_reverse_billed_yuan", "0.00"),
        },
        "promo": {
            "monthly_claim_enabled": get_setting("saas_monthly_claim_enabled", "1") == "1",
            "monthly_claim_yuan": units_to_yuan_str(monthly_claim_units),
            "monthly_claimed_this_month": user_payload.get("last_monthly_claim_ym") == current_ym,
            "current_ym": current_ym,
            "daily_checkin_enabled": get_setting("saas_daily_checkin_enabled", "1") == "1",
            "daily_checkin_yuan": units_to_yuan_str(daily_checkin_units),
            "daily_streak_bonus_yuan": units_to_yuan_str(daily_streak_units),
            "checked_in_today": user_payload.get("last_checkin_date") == today_str,
            "checkin_streak": int(user_payload.get("checkin_streak") or 0),
            "today": today_str,
        },
        "payment_channels": {
            "alipay_enabled": (
                (get_setting("saas_alipay_f2f_enabled", "1") == "1")
                or (get_setting("saas_alipay_page_enabled", "1") == "1")
                or (get_setting("saas_alipay_static_enabled", "0") == "1")
            ),
            "alipay_mode": get_setting("saas_alipay_mode", "precreate") or "precreate",
            "alipay_f2f_enabled": get_setting("saas_alipay_f2f_enabled", "1") == "1",
            "alipay_page_enabled": get_setting("saas_alipay_page_enabled", "1") == "1",
            "alipay_static_enabled": get_setting("saas_alipay_static_enabled", "0") == "1",
            "alipay_configured": is_alipay_api_configured(_get_alipay_gateway_cfg()),
            "wechat_enabled": (
                (get_setting("saas_wechat_native_enabled", "1") == "1")
                or (get_setting("saas_wechat_static_enabled", "0") == "1")
            ),
            "wechat_mode": get_setting("saas_wechat_mode", "native_v3") or "native_v3",
            "wechat_native_enabled": get_setting("saas_wechat_native_enabled", "1") == "1",
            "wechat_static_enabled": get_setting("saas_wechat_static_enabled", "0") == "1",
            "wechat_configured": is_wechat_v3_configured(_get_wechat_gateway_cfg()),
            "allow_self_recharge": get_setting("saas_allow_self_recharge", "1") == "1",
            "alipay_qr_url": get_setting("saas_alipay_qr_url", ""),
            "wechat_qr_url": get_setting("saas_wechat_qr_url", ""),
            "methods": _build_payment_methods_matrix(_get_alipay_gateway_cfg(), _get_wechat_gateway_cfg()),
        },
        "allow_self_recharge": get_setting("saas_allow_self_recharge", "1") == "1",
        "recharge_orders": orders,
        "ledger": ledger,
    }


@router.post("/api/billing/promo/monthly-claim", summary="每月领取固定推广体验额度（每自然月限领一次）")
def claim_monthly_allowance(request: Request, user: dict = Depends(verify_token)):
    if get_setting("saas_monthly_claim_enabled", "1") != "1":
        raise HTTPException(status_code=403, detail="当前未开放每月固定领奖活动")
    claim_units = max(0, int(get_setting("saas_monthly_claim_units", "100000") or 0))
    if claim_units <= 0:
        raise HTTPException(status_code=400, detail="管理员未配置每月领取金额")

    uid = int(user["id"])
    now_dt = datetime.now()
    ym = now_dt.strftime("%Y-%m")
    now_str = now_dt.strftime("%Y-%m-%d %H:%M:%S")

    with session_scope() as db:
        affected = (
            db.query(User)
            .filter(
                User.id == uid,
                or_(User.last_monthly_claim_ym != ym, User.last_monthly_claim_ym.is_(None)),
            )
            .update(
                {
                    User.balance_units: User.balance_units + claim_units,
                    User.total_recharged_units: User.total_recharged_units + claim_units,
                    User.last_monthly_claim_ym: ym,
                },
                synchronize_session=False,
            )
        )
        if affected == 0:
            raise HTTPException(status_code=400, detail=f"本月 ({ym}) 固定补贴已领取，请下月再来")
        db.expire_all()
        u = db.get(User, uid)
        db.add(
            BillingLedger(
                user_id=uid,
                tx_type="promo_monthly",
                amount_units=claim_units,
                balance_after_units=int(u.balance_units or 0),
                platform_spread_units=0,
                remark=f"每月固定推广福利领取 ({ym})",
                created_at=now_str,
            )
        )
        db.flush()
        user_payload = u.to_dict(include_secrets=True)

    write_audit_log(
        action="promo_monthly_claim",
        actor_id=uid,
        actor_username=user["username"],
        target_type="user",
        target_id=uid,
        ip=get_client_ip(request),
        status="ok",
        details={"ym": ym, "reward_yuan": units_to_yuan_str(claim_units)},
    )
    return {
        "message": f"成功领取 {ym} 每月固定补贴 ¥{units_to_yuan_str(claim_units)}",
        "reward_yuan": units_to_yuan_str(claim_units),
        "user": user_payload,
        "promo": {
            "monthly_claimed_this_month": True,
            "current_ym": ym,
        },
    }


@router.post("/api/billing/promo/daily-checkin", summary="每日签到领奖励（支持连续签到加成）")
def claim_daily_checkin(request: Request, user: dict = Depends(verify_token)):
    if get_setting("saas_daily_checkin_enabled", "1") != "1":
        raise HTTPException(status_code=403, detail="当前未开放每日签到奖励")
    base_units = max(0, int(get_setting("saas_daily_checkin_units", "5000") or 0))
    streak_bonus_units = max(0, int(get_setting("saas_daily_streak_bonus_units", "1000") or 0))

    uid = int(user["id"])
    now_dt = datetime.now()
    today_str = now_dt.strftime("%Y-%m-%d")
    yesterday_str = (now_dt.date() - timedelta(days=1)).strftime("%Y-%m-%d")
    now_str = now_dt.strftime("%Y-%m-%d %H:%M:%S")

    with session_scope() as db:
        u = db.get(User, uid)
        if u is None:
            raise HTTPException(status_code=404, detail="用户不存在")
        new_streak = (int(u.checkin_streak or 0) + 1) if (u.last_checkin_date == yesterday_str) else 1
        bonus = streak_bonus_units * min(new_streak - 1, 7)
        total_reward = max(1, base_units + bonus)

        affected = (
            db.query(User)
            .filter(
                User.id == uid,
                or_(User.last_checkin_date != today_str, User.last_checkin_date.is_(None)),
            )
            .update(
                {
                    User.balance_units: User.balance_units + total_reward,
                    User.total_recharged_units: User.total_recharged_units + total_reward,
                    User.last_checkin_date: today_str,
                    User.checkin_streak: new_streak,
                },
                synchronize_session=False,
            )
        )
        if affected == 0:
            raise HTTPException(status_code=400, detail=f"今日 ({today_str}) 已完成签到，请明天再来")
        db.expire_all()
        u = db.get(User, uid)
        db.add(
            BillingLedger(
                user_id=uid,
                tx_type="promo_checkin",
                amount_units=total_reward,
                balance_after_units=int(u.balance_units or 0),
                platform_spread_units=0,
                remark=f"每日签到奖励 ({today_str}, 连签第 {new_streak} 天)",
                created_at=now_str,
            )
        )
        db.flush()
        user_payload = u.to_dict(include_secrets=True)

    write_audit_log(
        action="promo_daily_checkin",
        actor_id=uid,
        actor_username=user["username"],
        target_type="user",
        target_id=uid,
        ip=get_client_ip(request),
        status="ok",
        details={"date": today_str, "streak": new_streak, "reward_yuan": units_to_yuan_str(total_reward)},
    )
    return {
        "message": f"签到成功（连续 {new_streak} 天），已到账 ¥{units_to_yuan_str(total_reward)}",
        "reward_yuan": units_to_yuan_str(total_reward),
        "checkin_streak": new_streak,
        "user": user_payload,
        "promo": {
            "checked_in_today": True,
            "checkin_streak": new_streak,
            "today": today_str,
        },
    }


@router.post("/api/billing/recharge/create", summary="创建支付宝 / 微信支付充值订单（自动调用官方网关、人工收款码或沙盒不落盘演示）")
async def create_recharge_order(data: RechargeCreateDTO, request: Request, user: dict = Depends(verify_token)):
    def _load_create_context():
        a_cfg = _get_alipay_gateway_cfg()
        w_cfg = _get_wechat_gateway_cfg()
        m_list = _build_payment_methods_matrix(a_cfg, w_cfg)
        allow_sb = get_setting("saas_allow_self_recharge", "1") == "1"
        return a_cfg, w_cfg, m_list, allow_sb

    alipay_cfg, wechat_cfg, methods, allow_sandbox = await asyncio.to_thread(_load_create_context)
    methods_by_id = {m["id"]: m for m in methods}

    req_method = (data.pay_method or "").strip().lower()
    if req_method:
        target_m = methods_by_id.get(req_method)
        if target_m is None:
            raise HTTPException(status_code=400, detail=f"不支持的支付方式: {req_method}")
        if not target_m["enabled"]:
            raise HTTPException(status_code=403, detail=f"支付方式「{target_m['name']}」已被管理员关闭")
        ch = target_m["channel"]
        selected_mode = target_m["mode"]
    else:
        ch = (data.channel or "alipay").strip().lower()
        if ch not in {"alipay", "wechat"}:
            raise HTTPException(status_code=400, detail="充值渠道仅支持 alipay（支付宝）或 wechat（微信支付）")
        enabled_for_ch = [m for m in methods if m["channel"] == ch and m["enabled"]]
        if not enabled_for_ch:
            raise HTTPException(status_code=403, detail=f"当前未启用{'支付宝' if ch == 'alipay' else '微信支付'}充值渠道")
        pref_mode = (alipay_cfg["mode"] if ch == "alipay" else wechat_cfg["mode"]).strip().lower()
        chosen = next((m for m in enabled_for_ch if m["mode"] == pref_mode), enabled_for_ch[0])
        selected_mode = chosen["mode"]

    if data.amount_yuan < 0.01 or data.amount_yuan > 50000:
        raise HTTPException(status_code=400, detail="单笔充值金额需在 0.01 ~ 50000 元之间")

    if ch == "alipay":
        alipay_cfg = {**alipay_cfg, "mode": selected_mode}
        if not allow_sandbox:
            if selected_mode in {"precreate", "page_pay"} and not is_alipay_api_configured(alipay_cfg):
                raise HTTPException(status_code=400, detail="管理员尚未完整配置支付宝官方密钥或公钥证书参数，请联系管理员配置")
            if selected_mode == "static_qr" and not alipay_cfg.get("qr_url"):
                raise HTTPException(status_code=400, detail="管理员尚未配置支付宝人工收款码链接")
    else:
        wechat_cfg = {**wechat_cfg, "mode": selected_mode}
        if not allow_sandbox:
            if selected_mode == "native_v3" and not (
                wechat_cfg.get("app_id") and wechat_cfg.get("mch_id") and wechat_cfg.get("serial_no") and wechat_cfg.get("private_key")
            ):
                raise HTTPException(status_code=400, detail="管理员尚未配置微信支付 V3 官方商户证书，请联系管理员配置")
            if selected_mode == "static_qr" and not wechat_cfg.get("qr_url"):
                raise HTTPException(status_code=400, detail="管理员尚未配置微信人工收款码链接")

    amount_units = yuan_to_units(data.amount_yuan)
    amount_yuan_str = units_to_yuan_str(amount_units)
    now_dt = datetime.now()
    now_str = now_dt.strftime("%Y-%m-%d %H:%M:%S")
    order_no = f"RC{now_dt.strftime('%Y%m%d%H%M%S')}{secrets.token_hex(4).upper()}"
    base_url = infer_base_url_from_request(request)
    subject = f"Chromium Sync SaaS 钱包充值 {float(amount_yuan_str):.2f}元"

    try:
        if ch == "alipay":
            gw_res = await create_alipay_order(
                order_no=order_no,
                amount_yuan_str=amount_yuan_str,
                subject=subject,
                cfg=alipay_cfg,
                base_url=base_url,
            )
        else:
            gw_res = await create_wechat_native_order(
                order_no=order_no,
                amount_units=amount_units,
                description=subject,
                cfg=wechat_cfg,
                base_url=base_url,
            )
    except Exception as exc:
        logger.warning(f"💳 [Billing] 支付下单失败 (channel={ch}, mode={selected_mode}, order={order_no}): {exc}")
        # 使用 HTTP 400 而非 502，避免 Cloudflare / Nginx 反代拦截 502 状态码并替换为 HTML 错误页
        raise HTTPException(status_code=400, detail=str(exc))

    pay_url = str(gw_res.get("pay_url") or "")
    qr_text = str(gw_res.get("qr_code_text") or "")
    gateway_used = str(gw_res.get("gateway_used") or "")
    is_simulated = bool(gw_res.get("simulated")) or gateway_used == "sandbox_fallback"

    if is_simulated:
        sim_order_no = f"SIM{now_dt.strftime('%Y%m%d%H%M%S')}{secrets.token_hex(3).upper()}"
        return {
            "message": gw_res.get("message") or f"已生成沙盒模拟订单 {sim_order_no}（数据未落盘）",
            "gateway_used": "sandbox_fallback",
            "simulated": True,
            "persisted": False,
            "order": {
                "id": 0,
                "order_no": sim_order_no,
                "user_id": int(user["id"]),
                "channel": ch,
                "amount_units": amount_units,
                "amount_yuan": amount_yuan_str,
                "status": "pending",
                "pay_url": pay_url,
                "qr_code_text": qr_text.replace(order_no, sim_order_no),
                "external_trade_no": "",
                "created_at": now_str,
                "paid_at": "",
                "remark": "沙盒模拟演练（数据未落盘）",
                "simulated": True,
            },
        }

    order_remark = (data.remark or "").strip() or gateway_used
    client_ip = get_client_ip(request)

    def _persist_order_and_audit():
        with session_scope() as db:
            order = RechargeOrder(
                order_no=order_no,
                user_id=int(user["id"]),
                channel=ch,
                amount_units=amount_units,
                status="pending",
                pay_url=pay_url,
                qr_code_text=qr_text,
                created_at=now_str,
                remark=order_remark[:255],
            )
            db.add(order)
            db.flush()
            payload = order.to_dict()
        write_audit_log(
            action="recharge_order_create",
            actor_id=user["id"],
            actor_username=user["username"],
            target_type="recharge_order",
            target_id=order_no,
            ip=client_ip,
            status="ok",
            details={"channel": ch, "amount_yuan": payload["amount_yuan"], "gateway_used": gateway_used},
        )
        return payload

    try:
        order_payload = await asyncio.to_thread(_persist_order_and_audit)
    except Exception as exc:
        logger.error(f"💳 [Billing] 充值订单落盘失败 (order={order_no}): {exc}")
        raise HTTPException(status_code=500, detail=f"充值订单写入数据库失败: {exc}")

    return {
        "message": gw_res.get("message") or f"充值订单 {order_no} 已创建",
        "gateway_used": gateway_used,
        "simulated": False,
        "persisted": True,
        "order": order_payload,
    }


@router.get("/api/billing/recharge/orders", summary="查询我的钱包充值订单列表")
def list_my_recharge_orders(user: dict = Depends(verify_token)):
    with session_scope() as db:
        rows = (
            db.query(RechargeOrder)
            .filter(RechargeOrder.user_id == int(user["id"]))
            .order_by(RechargeOrder.id.desc())
            .limit(50)
            .all()
        )
        return {"orders": [r.to_dict() for r in rows]}


@router.get("/api/billing/recharge/orders/{order_no}", summary="查询单笔充值订单状态（如配置了官方网关将自动主动查单同步）")
async def get_recharge_order_status(order_no: str, request: Request, user: dict = Depends(verify_token)):
    with session_scope() as db:
        order = db.query(RechargeOrder).filter(RechargeOrder.order_no == order_no).first()
        if order is None:
            raise HTTPException(status_code=404, detail="充值订单不存在")
        if int(order.user_id) != int(user["id"]) and user.get("role") != "admin":
            raise HTTPException(status_code=403, detail="无权查询他人充值订单")
        order_payload = order.to_dict()

    synced_paid = False
    user_payload = None
    if order_payload["status"] == "pending":
        ch = order_payload["channel"]
        q_res: Dict[str, Any] = {"supported": False, "paid": False}
        try:
            if ch == "alipay":
                q_res = await query_alipay_order(order_no, _get_alipay_gateway_cfg())
            elif ch == "wechat":
                q_res = await query_wechat_order(order_no, _get_wechat_gateway_cfg())
        except Exception:
            q_res = {"supported": False, "paid": False}

        if q_res.get("paid"):
            amt_ok = True
            if ch == "alipay" and q_res.get("total_amount"):
                amt_ok = abs(yuan_to_units(q_res["total_amount"]) - int(order_payload["amount_units"])) <= 100
            elif ch == "wechat" and q_res.get("total_fen"):
                expected_fen = max(1, int(round(int(order_payload["amount_units"]) / 100)))
                amt_ok = int(q_res["total_fen"]) == expected_fen

            if amt_ok:
                ext_no = q_res.get("trade_no") or f"{ch.upper()}-{secrets.token_hex(6).upper()}"
                with session_scope() as db:
                    res = _mark_recharge_order_paid_sync(
                        db,
                        order_no=order_no,
                        expected_channel=ch,
                        external_trade_no=ext_no,
                        paid_remark=f"{ch.upper()} 官方主动查单入账 ({order_no})",
                        allow_cancelled=True,
                    )
                    order_payload = res["order"]
                    user_payload = res["user"]
                    synced_paid = not res["already_paid"]
                if synced_paid:
                    write_audit_log(
                        action="recharge_query_paid",
                        actor_id=order_payload["user_id"],
                        actor_username=user["username"],
                        target_type="recharge_order",
                        target_id=order_no,
                        ip=get_client_ip(request),
                        status="ok",
                        details={"channel": ch, "amount_yuan": order_payload["amount_yuan"], "trade_no": ext_no},
                    )
        elif (q_res.get("trade_status") == "TRADE_CLOSED") or (q_res.get("trade_state") == "CLOSED"):
            with session_scope() as db:
                row = db.query(RechargeOrder).filter(
                    RechargeOrder.order_no == order_no,
                    RechargeOrder.status == "pending",
                ).first()
                if row is not None:
                    row.status = "cancelled"
                    row.remark = f"{(row.remark + ' | ') if row.remark else ''}官方网关交易已关闭"[:255]
                    db.flush()
                    order_payload = row.to_dict()

    return {"order": order_payload, "user": user_payload, "synced_paid": synced_paid}


@router.post("/api/billing/recharge/orders/{order_no}/cancel", summary="租户取消尚未支付的充值订单")
def cancel_my_recharge_order(order_no: str, request: Request, user: dict = Depends(verify_token)):
    with session_scope() as db:
        order = db.query(RechargeOrder).filter(RechargeOrder.order_no == order_no).first()
        if order is None:
            raise HTTPException(status_code=404, detail="充值订单不存在")
        if int(order.user_id) != int(user["id"]) and user.get("role") != "admin":
            raise HTTPException(status_code=403, detail="无权操作他人充值订单")
        if order.status == "paid":
            raise HTTPException(status_code=400, detail="订单已完成支付入账，无法取消")
        if order.status == "cancelled":
            return {"message": f"订单 {order_no} 已处于取消状态", "order": order.to_dict()}
        if order.status != "pending":
            raise HTTPException(status_code=400, detail=f"订单当前状态 ({order.status}) 不支持取消")

        order.status = "cancelled"
        order.remark = f"{(order.remark + ' | ') if order.remark else ''}用户 {user['username']} 主动取消"[:255]
        db.flush()
        order_payload = order.to_dict()

    write_audit_log(
        action="recharge_order_cancel",
        actor_id=user["id"],
        actor_username=user["username"],
        target_type="recharge_order",
        target_id=order_no,
        ip=get_client_ip(request),
        status="ok",
        details={"amount_yuan": order_payload["amount_yuan"], "channel": order_payload["channel"]},
    )
    return {"message": f"已取消充值订单 {order_no}", "order": order_payload}


@router.post("/api/billing/recharge/{order_no}/sandbox-pay", summary="沙盒模拟演练支付（纯内存模拟，数据不落盘）")
def sandbox_pay_recharge_order(
    order_no: str,
    channel: str = "alipay",
    amount_yuan: float = 50.0,
    user: dict = Depends(verify_token),
):
    if get_setting("saas_allow_self_recharge", "1") != "1" and user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="当前已关闭沙盒模拟演示开关")

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    ch = (channel or "alipay").strip().lower()
    if ch not in {"alipay", "wechat"}:
        ch = "alipay"
    amt_units = yuan_to_units(max(0.01, min(50000.0, float(amount_yuan or 50.0))))
    amt_yuan_str = units_to_yuan_str(amt_units)

    if not order_no.startswith("SIM"):
        with session_scope() as db:
            existing = db.query(RechargeOrder).filter(RechargeOrder.order_no == order_no).first()
            if existing is not None:
                if int(existing.user_id) != int(user["id"]) and user.get("role") != "admin":
                    raise HTTPException(status_code=403, detail="无权操作他人充值订单")
                ch = existing.channel
                amt_units = int(existing.amount_units or amt_units)
                amt_yuan_str = units_to_yuan_str(amt_units)

    return {
        "message": "沙盒模拟支付演练完成（数据未落盘：数据库订单、流水与真实余额均未变更）",
        "simulated": True,
        "persisted": False,
        "already_paid": False,
        "order": {
            "id": 0,
            "order_no": order_no,
            "user_id": int(user["id"]),
            "channel": ch,
            "amount_units": amt_units,
            "amount_yuan": amt_yuan_str,
            "status": "paid",
            "external_trade_no": f"SIM-{secrets.token_hex(6).upper()}",
            "paid_at": now_str,
            "created_at": now_str,
            "remark": "沙盒模拟演练（数据未落盘）",
            "simulated": True,
        },
    }


@router.post("/api/billing/recharge/notify/{channel}", summary="支付宝 RSA2 / 微信 V3 AES-GCM 官方异步回调与 HMAC Webhook")
async def payment_webhook_notify(channel: str, request: Request):
    ch = channel.strip().lower()
    if ch not in {"alipay", "wechat"}:
        raise HTTPException(status_code=400, detail="未知支付渠道")

    client_ip = get_client_ip(request)
    content_type = (request.headers.get("content-type") or "").lower()

    # 1) 支付宝官方异步回调 (application/x-www-form-urlencoded + RSA2)
    if ch == "alipay" and ("application/x-www-form-urlencoded" in content_type or "multipart/form-data" in content_type):
        form_data = dict(await request.form())
        cfg = _get_alipay_gateway_cfg()
        if not verify_alipay_notify_signature(form_data, get_effective_alipay_public_key(cfg)):
            write_audit_log(
                action="recharge_alipay_rsa2_denied",
                actor_username="alipay_notify",
                target_type="recharge_order",
                target_id=str(form_data.get("out_trade_no") or ""),
                ip=client_ip,
                status="deny",
                details={"reason": "invalid_rsa2_signature"},
            )
            return PlainTextResponse("failure", status_code=400)

        if cfg.get("app_id") and str(form_data.get("app_id") or "") != cfg["app_id"]:
            return PlainTextResponse("failure", status_code=400)
        trade_status = str(form_data.get("trade_status") or "")
        if trade_status not in {"TRADE_SUCCESS", "TRADE_FINISHED"}:
            return PlainTextResponse("success")

        order_no = str(form_data.get("out_trade_no") or "").strip()
        trade_no = str(form_data.get("trade_no") or "").strip()
        total_amount = str(form_data.get("total_amount") or "").strip()
        with session_scope() as db:
            order = db.query(RechargeOrder).filter(RechargeOrder.order_no == order_no, RechargeOrder.channel == "alipay").first()
            if order is None:
                return PlainTextResponse("failure", status_code=404)
            if total_amount and abs(yuan_to_units(total_amount) - int(order.amount_units or 0)) > 100:
                return PlainTextResponse("failure", status_code=400)
            res = _mark_recharge_order_paid_sync(
                db,
                order_no=order_no,
                expected_channel="alipay",
                external_trade_no=trade_no or f"ALIPAY-{secrets.token_hex(6).upper()}",
                paid_remark=f"支付宝官方异步回调到账 ({order_no})",
                allow_cancelled=True,
            )
        if not res["already_paid"]:
            write_audit_log(
                action="recharge_alipay_paid",
                actor_id=res["order"]["user_id"],
                actor_username="alipay_notify",
                target_type="recharge_order",
                target_id=order_no,
                ip=client_ip,
                status="ok",
                details={"amount_yuan": res["order"]["amount_yuan"], "trade_no": trade_no},
            )
        return PlainTextResponse("success")

    raw_body = await request.body()
    try:
        payload = json.loads(raw_body.decode("utf-8")) if raw_body else {}
    except Exception:
        raise HTTPException(status_code=400, detail="无法解析回调请求体")

    # 2) 微信支付 V3 官方异步回调 (AEAD_AES_256_GCM 加密报文)
    if ch == "wechat" and isinstance(payload, dict) and "resource" in payload and "event_type" in payload:
        cfg = _get_wechat_gateway_cfg()
        try:
            decrypted = verify_and_decrypt_wechat_v3_notify(dict(request.headers), raw_body, cfg)
        except Exception as exc:
            write_audit_log(
                action="recharge_wechat_v3_denied",
                actor_username="wechat_notify",
                target_type="recharge_order",
                target_id=str(payload.get("id") or ""),
                ip=client_ip,
                status="deny",
                details={"reason": str(exc)},
            )
            raise HTTPException(status_code=403, detail=str(exc))

        if decrypted.get("trade_state") != "SUCCESS":
            return {"code": "SUCCESS", "message": "成功"}

        order_no = str(decrypted.get("out_trade_no") or "").strip()
        tx_id = str(decrypted.get("transaction_id") or "").strip()
        total_fen = int((decrypted.get("amount") or {}).get("total") or 0)
        with session_scope() as db:
            order = db.query(RechargeOrder).filter(RechargeOrder.order_no == order_no, RechargeOrder.channel == "wechat").first()
            if order is None:
                raise HTTPException(status_code=404, detail="订单不存在")
            expected_fen = max(1, int(round(int(order.amount_units or 0) / 100)))
            if total_fen != expected_fen:
                raise HTTPException(status_code=400, detail="微信回调金额与订单金额不一致")
            res = _mark_recharge_order_paid_sync(
                db,
                order_no=order_no,
                expected_channel="wechat",
                external_trade_no=tx_id or f"WXPAY-{secrets.token_hex(6).upper()}",
                paid_remark=f"微信支付 V3 官方回调到账 ({order_no})",
                allow_cancelled=True,
            )
        if not res["already_paid"]:
            write_audit_log(
                action="recharge_wechat_paid",
                actor_id=res["order"]["user_id"],
                actor_username="wechat_notify",
                target_type="recharge_order",
                target_id=order_no,
                ip=client_ip,
                status="ok",
                details={"amount_yuan": res["order"]["amount_yuan"], "transaction_id": tx_id},
            )
        return {"code": "SUCCESS", "message": "成功"}

    # 3) 通用 JSON HMAC-SHA256 Webhook（兼容第三方聚合网关或自动化测试）
    order_no = str(payload.get("order_no") or payload.get("out_trade_no") or "").strip()
    ext_trade_no = str(payload.get("external_trade_no") or payload.get("trade_no") or "").strip()
    sig = str(request.headers.get("x-pay-signature") or payload.get("signature") or "").strip().lower()
    if not order_no or not sig:
        raise HTTPException(status_code=400, detail="缺少 order_no 或签名")

    secret = get_setting("saas_payment_notify_secret", "").strip()
    if not secret:
        raise HTTPException(status_code=503, detail="系统尚未配置支付回调验签密钥")

    sig_bad = False
    res = None

    with session_scope() as db:
        order = db.query(RechargeOrder).filter(RechargeOrder.order_no == order_no, RechargeOrder.channel == ch).first()
        if order is None:
            raise HTTPException(status_code=404, detail="充值订单不存在或渠道不匹配")

        if "amount_units" in payload:
            req_units = int(payload["amount_units"] or 0)
        elif "amount_yuan" in payload:
            req_units = yuan_to_units(payload["amount_yuan"])
        else:
            req_units = int(order.amount_units or 0)
        if req_units != int(order.amount_units or 0):
            raise HTTPException(status_code=400, detail="回调金额与订单金额不一致")

        sign_msg = f"{ch}:{order_no}:{int(order.amount_units or 0)}:{ext_trade_no}"
        expected_sig = hmac.new(secret.encode("utf-8"), sign_msg.encode("utf-8"), hashlib.sha256).hexdigest().lower()
        if not hmac.compare_digest(sig, expected_sig):
            sig_bad = True
        else:
            res = _mark_recharge_order_paid_sync(
                db,
                order_no=order_no,
                expected_channel=ch,
                external_trade_no=ext_trade_no or f"{ch.upper()}-{secrets.token_hex(6).upper()}",
                paid_remark=f"{ch.upper()} 回调充值入账 ({order_no})",
            )

    if sig_bad:
        write_audit_log(
            action="recharge_webhook_denied",
            actor_username="payment_webhook",
            target_type="recharge_order",
            target_id=order_no,
            ip=client_ip,
            status="deny",
            details={"channel": ch, "reason": "bad_signature"},
        )
        raise HTTPException(status_code=403, detail="支付回调 HMAC-SHA256 验签失败")

    if res and not res["already_paid"]:
        write_audit_log(
            action="recharge_webhook_paid",
            actor_id=res["order"]["user_id"],
            actor_username="payment_webhook",
            target_type="recharge_order",
            target_id=order_no,
            ip=client_ip,
            status="ok",
            details={"channel": ch, "amount_yuan": res["order"]["amount_yuan"], "external_trade_no": ext_trade_no},
        )
    return {
        "code": 200,
        "status": "ok",
        "already_paid": res["already_paid"],
        "order": res["order"],
    }


@router.post("/api/billing/recharge", summary="管理员直接给自身账户调试入账（兼容旧接口，仅管理员可用）")
def self_recharge(data: RechargeDTO, request: Request, user: dict = Depends(verify_token)):
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="请通过收银台下单支付或联系管理员核账入账")
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
