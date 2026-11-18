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
    return {
        "enabled": get_setting("saas_alipay_enabled", "1") == "1",
        "mode": get_setting("saas_alipay_mode", "precreate") or "precreate",
        "app_id": get_setting("saas_alipay_app_id", ""),
        "private_key": get_setting("saas_alipay_private_key", ""),
        "public_key": get_setting("saas_alipay_public_key", ""),
        "gateway_url": get_setting("saas_alipay_gateway_url", "https://openapi.alipay.com/gateway.do"),
        "notify_url": get_setting("saas_alipay_notify_url", ""),
        "return_url": get_setting("saas_alipay_return_url", ""),
        "qr_url": get_setting("saas_alipay_qr_url", ""),
    }


def _get_wechat_gateway_cfg() -> Dict[str, Any]:
    return {
        "enabled": get_setting("saas_wechat_enabled", "1") == "1",
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


class RechargeDTO(BaseModel):
    amount_yuan: float = 20.0


class RechargeCreateDTO(BaseModel):
    channel: str = "alipay"
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
) -> Dict[str, Any]:
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    q = db.query(RechargeOrder).filter(
        RechargeOrder.order_no == order_no,
        RechargeOrder.status == "pending",
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
            "alipay_enabled": get_setting("saas_alipay_enabled", "1") == "1",
            "alipay_mode": get_setting("saas_alipay_mode", "precreate") or "precreate",
            "alipay_configured": is_alipay_api_configured(_get_alipay_gateway_cfg()),
            "wechat_enabled": get_setting("saas_wechat_enabled", "1") == "1",
            "wechat_mode": get_setting("saas_wechat_mode", "native_v3") or "native_v3",
            "wechat_configured": is_wechat_v3_configured(_get_wechat_gateway_cfg()),
            "allow_self_recharge": get_setting("saas_allow_self_recharge", "1") == "1",
            "alipay_qr_url": get_setting("saas_alipay_qr_url", ""),
            "wechat_qr_url": get_setting("saas_wechat_qr_url", ""),
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


@router.post("/api/billing/recharge/create", summary="创建支付宝 / 微信支付充值订单（自动调用官方网关或静态码）")
async def create_recharge_order(data: RechargeCreateDTO, request: Request, user: dict = Depends(verify_token)):
    ch = (data.channel or "alipay").strip().lower()
    if ch not in {"alipay", "wechat"}:
        raise HTTPException(status_code=400, detail="充值渠道仅支持 alipay（支付宝）或 wechat（微信支付）")
    if ch == "alipay" and get_setting("saas_alipay_enabled", "1") != "1":
        raise HTTPException(status_code=403, detail="当前未启用支付宝充值渠道")
    if ch == "wechat" and get_setting("saas_wechat_enabled", "1") != "1":
        raise HTTPException(status_code=403, detail="当前未启用微信支付充值渠道")
    if data.amount_yuan < 0.01 or data.amount_yuan > 50000:
        raise HTTPException(status_code=400, detail="单笔充值金额需在 0.01 ~ 50000 元之间")

    amount_units = yuan_to_units(data.amount_yuan)
    amount_yuan_str = units_to_yuan_str(amount_units)
    now_dt = datetime.now()
    now_str = now_dt.strftime("%Y-%m-%d %H:%M:%S")
    order_no = f"RC{now_dt.strftime('%Y%m%d%H%M%S')}{secrets.token_hex(4).upper()}"
    base_url = infer_base_url_from_request(request)
    subject = f"Chromium Sync SaaS 钱包充值 ¥{float(amount_yuan_str):.2f}"

    try:
        if ch == "alipay":
            gw_res = await create_alipay_order(
                order_no=order_no,
                amount_yuan_str=amount_yuan_str,
                subject=subject,
                cfg=_get_alipay_gateway_cfg(),
                base_url=base_url,
            )
        else:
            gw_res = await create_wechat_native_order(
                order_no=order_no,
                amount_units=amount_units,
                description=subject,
                cfg=_get_wechat_gateway_cfg(),
                base_url=base_url,
            )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    pay_url = str(gw_res.get("pay_url") or "")
    qr_text = str(gw_res.get("qr_code_text") or "")
    gateway_used = str(gw_res.get("gateway_used") or "")
    order_remark = (data.remark or "").strip() or gateway_used

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
        order_payload = order.to_dict()

    write_audit_log(
        action="recharge_order_create",
        actor_id=user["id"],
        actor_username=user["username"],
        target_type="recharge_order",
        target_id=order_no,
        ip=get_client_ip(request),
        status="ok",
        details={"channel": ch, "amount_yuan": order_payload["amount_yuan"], "gateway_used": gateway_used},
    )
    return {
        "message": gw_res.get("message") or f"充值订单 {order_no} 已创建",
        "gateway_used": gateway_used,
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

    return {"order": order_payload, "user": user_payload, "synced_paid": synced_paid}


@router.post("/api/billing/recharge/{order_no}/sandbox-pay", summary="沙盒/演示一键确认支付入账")
def sandbox_pay_recharge_order(order_no: str, request: Request, user: dict = Depends(verify_token)):
    if get_setting("saas_allow_self_recharge", "1") != "1" and user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="当前已关闭沙盒演示支付，请扫码付款后等待管理员确认或支付回调入账")

    with session_scope() as db:
        existing = db.query(RechargeOrder).filter(RechargeOrder.order_no == order_no).first()
        if existing is None:
            raise HTTPException(status_code=404, detail="充值订单不存在")
        if int(existing.user_id) != int(user["id"]) and user.get("role") != "admin":
            raise HTTPException(status_code=403, detail="无权操作他人充值订单")
        res = _mark_recharge_order_paid_sync(
            db,
            order_no=order_no,
            expected_channel=None,
            external_trade_no=f"SANDBOX-{secrets.token_hex(6).upper()}",
            paid_remark=f"{existing.channel.upper()} 充值到账 ({order_no})",
        )

    if not res["already_paid"]:
        write_audit_log(
            action="recharge_order_sandbox_paid",
            actor_id=user["id"],
            actor_username=user["username"],
            target_type="recharge_order",
            target_id=order_no,
            ip=get_client_ip(request),
            status="ok",
            details={"amount_yuan": res["order"]["amount_yuan"], "channel": res["order"]["channel"]},
        )
    return {
        "message": "订单早已完成入账（幂等返回）" if res["already_paid"] else f"成功充值 ¥{res['order']['amount_yuan']}",
        "already_paid": res["already_paid"],
        "order": res["order"],
        "user": res["user"],
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
        if not verify_alipay_notify_signature(form_data, cfg.get("public_key", "")):
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


@router.post("/api/billing/recharge", summary="租户自助演示充值余额（兼容旧接口）")
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
