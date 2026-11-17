import asyncio
from datetime import datetime
import re
import secrets
from typing import Optional
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import func

from core.cache import cache_mgr
from core.db import (
    get_active_db_info,
    get_setting,
    is_setup_required,
    issue_user_api_key,
    issue_user_invite_code,
    issue_user_join_token,
    session_scope,
)
from core.models import (
    BillingLedger,
    Plan,
    ReferralReward,
    SyncPolicy,
    User,
    UserLevel,
    units_to_yuan_str,
)
from core.rate_limit import (
    LOGIN_BLOCK_SECONDS,
    LOGIN_FAIL_WINDOW_SEC,
    LOGIN_MAX_FAILURES,
    RATE_LIMIT_ACCOUNT_REGISTER_PER_MIN,
    RATE_LIMIT_CAPTCHA_PER_MIN,
    RATE_LIMIT_EMAIL_CODE_PER_MIN,
    RATE_LIMIT_LOGIN_PER_MIN,
    check_block,
    clear_auth_failures,
    enforce_rate_limit,
    get_client_ip,
    record_auth_failure,
)
from core.security import (
    generate_strong_captcha,
    get_email_code_cooldown,
    hash_password,
    issue_user_jwt,
    store_captcha,
    store_email_code,
    verify_and_pop_captcha,
    verify_and_pop_email_code,
    verify_password,
    verify_token,
)
from modules.audit.service import write_audit_log
from modules.billing.service import get_all_channel_fee_bps
from modules.notifications.email_channel import send_email_sync
from modules.sync.service import reschedule_all_policies

router = APIRouter(tags=["用户系统（认证 · 邮箱验证 · 邀请奖励 · 个人中心）"])

_EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")


class SendEmailCodeDTO(BaseModel):
    email: str
    captcha_token: str
    captcha_answer: str


class RegisterDTO(BaseModel):
    username: str
    email: str
    password: str
    captcha_token: str
    captcha_answer: str
    email_code: Optional[str] = ""
    invite_code: Optional[str] = ""


class LoginDTO(BaseModel):
    username: str
    password: str
    captcha_token: str
    captcha_answer: str


class PasswordUpdateDTO(BaseModel):
    old_password: str
    new_password: str


class RotateCredDTO(BaseModel):
    rotate_api_key: bool = False
    rotate_join_token: bool = False


@router.get("/api/auth/status", summary="健康检查、系统开关、邮箱验证与邀请奖励配置")
def auth_status():
    db_info = get_active_db_info()
    cache_status = cache_mgr.get_status()
    ch_fees = get_all_channel_fee_bps()
    inviter_bonus_units = max(0, int(get_setting("saas_referral_inviter_bonus_units", "50000") or 0))
    invitee_bonus_units = max(0, int(get_setting("saas_referral_invitee_bonus_units", "30000") or 0))
    return {
        "ok": True,
        "status": "healthy",
        "edition": "saas",
        "setup_required": is_setup_required(),
        "allow_public_register": get_setting("saas_allow_public_register", "1") == "1",
        "require_email_verify": get_setting("saas_require_email_verify", "1") == "1",
        "referral_enabled": get_setting("saas_referral_enabled", "1") == "1",
        "referral_inviter_bonus_yuan": units_to_yuan_str(inviter_bonus_units),
        "referral_invitee_bonus_yuan": units_to_yuan_str(invitee_bonus_units),
        "allow_self_recharge": get_setting("saas_allow_self_recharge", "1") == "1",
        "platform_fee_bps": ch_fees["reverse"],
        "channel_fees": ch_fees,
        "auto_level_enabled": get_setting("saas_auto_level_enabled", "1") == "1",
        "db_type": db_info.get("db_type", "sqlite"),
        "cache_backend": cache_status.get("active_backend", "sqlite_cache"),
    }


@router.get("/api/captcha", summary="生成抗 OCR 干扰图形验证码")
def get_captcha(request: Request):
    ip = get_client_ip(request)
    enforce_rate_limit("captcha", ip, RATE_LIMIT_CAPTCHA_PER_MIN, 60, "获取验证码过于频繁，请稍后再试")
    code, svg = generate_strong_captcha(length=5)
    token = str(uuid.uuid4())
    store_captcha(token, code, ttl_seconds=180)
    return {"token": token, "svg": svg}


@router.post("/api/auth/send-email-code", summary="校验图形验证码后发送注册邮箱验证码")
async def send_register_email_code(data: SendEmailCodeDTO, request: Request):
    if is_setup_required():
        raise HTTPException(status_code=403, detail="系统尚未完成初始化安装，请先引导管理员完成安装向导")
    if get_setting("saas_allow_public_register", "1") != "1":
        raise HTTPException(status_code=403, detail="平台当前已关闭公开自助注册")

    ip = get_client_ip(request)
    check_block("email_code_ip", ip, "验证码请求异常过多，当前 IP 已被临时限制")
    enforce_rate_limit("email_code", ip, RATE_LIMIT_EMAIL_CODE_PER_MIN, 60, "发送邮箱验证码过于频繁，请稍后再试")

    email = (data.email or "").strip().lower()
    if not _EMAIL_RE.fullmatch(email):
        raise HTTPException(status_code=400, detail="请输入有效格式的邮箱地址")

    cooldown = get_email_code_cooldown(email)
    if cooldown > 0:
        raise HTTPException(status_code=429, detail=f"发送过于频繁，请 {cooldown} 秒后再试")

    if not verify_and_pop_captcha(data.captcha_token, data.captcha_answer):
        record_auth_failure("email_code_ip", ip, max_failures=12, fail_window_sec=600, block_sec=600)
        raise HTTPException(status_code=400, detail="图形验证码错误或已过期")

    smtp_host = get_setting("smtp_host", "").strip()
    smtp_user = get_setting("smtp_user", "").strip()
    smtp_pass = get_setting("smtp_pass", "").strip()
    if not (smtp_host and smtp_user and smtp_pass):
        raise HTTPException(status_code=503, detail="系统尚未配置完成 SMTP 邮件发信服务器，请联系管理员完成设置")

    with session_scope() as db:
        exists = db.query(User.id).filter(User.email == email).first() is not None
    if exists:
        raise HTTPException(status_code=409, detail="该邮箱已被其他账号绑定，请直接登录或更换邮箱")

    otp = f"{secrets.randbelow(900000) + 100000}"
    subject = "【Chromium Sync SaaS】注册邮箱安全验证码"
    html_body = (
        '<div style="font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; padding: 24px; '
        'background: #0f172a; color: #e2e8f0; border-radius: 10px;">'
        '<h2 style="color: #38bdf8; margin-top: 0;">欢迎注册 Chromium Sync SaaS 多租户平台</h2>'
        '<p>您正在进行新账号邮箱验证，本次一次性验证码为：</p>'
        f'<div style="font-size: 28px; font-weight: 700; letter-spacing: 6px; color: #34d399; '
        f'background: #020617; padding: 14px 20px; border-radius: 8px; display: inline-block; margin: 12px 0;">{otp}</div>'
        '<p style="color: #94a3b8; font-size: 13px;">验证码 10 分钟内有效，如非本人操作请忽略本邮件。</p>'
        '</div>'
    )

    try:
        await asyncio.to_thread(send_email_sync, email, subject, html_body, None, True)
    except Exception as exc:
        write_audit_log(
            action="auth_send_email_code_failed",
            actor_username="anonymous",
            target_type="email",
            target_id=email,
            ip=ip,
            status="error",
            details={"error": str(exc)[:160]},
        )
        raise HTTPException(status_code=500, detail=f"邮箱验证码发送失败: {exc}")

    store_email_code(email, otp, ttl_seconds=600, cooldown_seconds=60)
    write_audit_log(
        action="auth_send_email_code",
        actor_username="anonymous",
        target_type="email",
        target_id=email,
        ip=ip,
        status="ok",
    )
    return {"message": f"验证码已发送至 {email}，10 分钟内有效", "cooldown_seconds": 60}


@router.post("/api/register", summary="SaaS 公开用户注册（必选邮箱验证 + 图形验证码 + 邀请奖励）")
def public_register(data: RegisterDTO, request: Request):
    ip = get_client_ip(request)
    if is_setup_required():
        raise HTTPException(status_code=403, detail="系统尚未完成初始化安装，请先引导管理员完成安装向导")
    if get_setting("saas_allow_public_register", "1") != "1":
        raise HTTPException(status_code=403, detail="平台当前已关闭公开自助注册，请联系管理员分配账号")

    check_block("register_ip", ip, "注册尝试过于频繁，请稍后再试")
    enforce_rate_limit("account_register", ip, RATE_LIMIT_ACCOUNT_REGISTER_PER_MIN, 60, "注册请求过于频繁，请稍后再试")

    if not verify_and_pop_captcha(data.captcha_token, data.captcha_answer):
        record_auth_failure("register_ip", ip, max_failures=10, fail_window_sec=600, block_sec=600)
        raise HTTPException(status_code=400, detail="图形验证码错误或已过期")

    username = (data.username or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_.-]{3,32}", username):
        raise HTTPException(status_code=400, detail="用户名需为 3~32 位字母、数字、下划线或点号")

    email = (data.email or "").strip().lower()
    if not _EMAIL_RE.fullmatch(email):
        raise HTTPException(status_code=400, detail="请填写有效格式的邮箱地址（注册必填）")

    if len(data.password or "") < 6:
        raise HTTPException(status_code=400, detail="密码至少需要 6 位字符")

    require_email_verify = get_setting("saas_require_email_verify", "1") == "1"
    if require_email_verify:
        ok_otp, otp_msg = verify_and_pop_email_code(email, data.email_code or "")
        if not ok_otp:
            record_auth_failure("register_ip", ip, max_failures=10, fail_window_sec=600, block_sec=600)
            raise HTTPException(status_code=400, detail=otp_msg)

    welcome_units = max(0, int(get_setting("saas_welcome_bonus_units", "100000") or 0))
    referral_enabled = get_setting("saas_referral_enabled", "1") == "1"
    inviter_bonus_units = max(0, int(get_setting("saas_referral_inviter_bonus_units", "50000") or 0))
    invitee_bonus_units = max(0, int(get_setting("saas_referral_invitee_bonus_units", "30000") or 0))
    clean_ref = (data.invite_code or "").strip().upper()
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    inviter_info = None
    with session_scope() as db:
        if db.query(User.id).filter(User.username == username).first() is not None:
            raise HTTPException(status_code=409, detail="该用户名已被注册")
        if db.query(User.id).filter(User.email == email).first() is not None:
            raise HTTPException(status_code=409, detail="该邮箱已被绑定")

        inviter = None
        if clean_ref and referral_enabled:
            inviter = db.query(User).filter(User.invite_code == clean_ref).first()
            if inviter is None or inviter.status != "active":
                raise HTTPException(status_code=400, detail="填写的邀请码无效或对应邀请人已停用")

        default_plan = db.query(Plan).filter(Plan.is_default == 1).first() or db.query(Plan).order_by(Plan.id.asc()).first()
        plan_id = default_plan.id if default_plan else 1
        default_level = db.query(UserLevel).order_by(UserLevel.rank_order.asc()).first()
        level_id = default_level.id if default_level else 1

        my_invite_code = issue_user_invite_code()
        while db.query(User.id).filter(User.invite_code == my_invite_code).first() is not None:
            my_invite_code = issue_user_invite_code()

        actual_invitee_bonus = invitee_bonus_units if inviter is not None else 0
        init_balance = welcome_units + actual_invitee_bonus

        new_user = User(
            username=username,
            email=email,
            email_verified=1 if require_email_verify else 0,
            password_hash=hash_password(data.password),
            role="user",
            status="active",
            plan_id=plan_id,
            level_id=level_id,
            invite_code=my_invite_code,
            invited_by_id=inviter.id if inviter is not None else None,
            balance_units=init_balance,
            total_recharged_units=init_balance,
            api_key=issue_user_api_key(),
            cluster_join_token=issue_user_join_token(),
            created_at=now_str,
            last_login_at=now_str,
        )
        db.add(new_user)
        db.flush()

        running_bal = 0
        if welcome_units > 0:
            running_bal += welcome_units
            db.add(
                BillingLedger(
                    user_id=new_user.id,
                    tx_type="welcome_bonus",
                    amount_units=welcome_units,
                    balance_after_units=running_bal,
                    platform_spread_units=0,
                    remark=f"新用户注册体验赠金 (¥{units_to_yuan_str(welcome_units)})",
                    created_at=now_str,
                )
            )

        if inviter is not None:
            if actual_invitee_bonus > 0:
                running_bal += actual_invitee_bonus
                db.add(
                    BillingLedger(
                        user_id=new_user.id,
                        tx_type="referral_bonus",
                        amount_units=actual_invitee_bonus,
                        balance_after_units=running_bal,
                        platform_spread_units=0,
                        remark=f"使用邀请码 [{inviter.invite_code}] 注册加赠 (¥{units_to_yuan_str(actual_invitee_bonus)})",
                        created_at=now_str,
                    )
                )
            if inviter_bonus_units > 0:
                inviter.balance_units = int(inviter.balance_units or 0) + inviter_bonus_units
                inviter.total_recharged_units = int(inviter.total_recharged_units or 0) + inviter_bonus_units
                db.add(
                    BillingLedger(
                        user_id=inviter.id,
                        tx_type="referral_reward",
                        amount_units=inviter_bonus_units,
                        balance_after_units=inviter.balance_units,
                        platform_spread_units=0,
                        remark=f"邀请新租户 [{username}] 注册返利 (+¥{units_to_yuan_str(inviter_bonus_units)})",
                        created_at=now_str,
                    )
                )
            db.add(
                ReferralReward(
                    inviter_id=inviter.id,
                    invitee_id=new_user.id,
                    invitee_username=username,
                    inviter_bonus_units=inviter_bonus_units,
                    invitee_bonus_units=actual_invitee_bonus,
                    status="credited",
                    remark=f"通过邀请码 {inviter.invite_code} 注册奖励",
                    created_at=now_str,
                )
            )
            inviter_info = {"id": inviter.id, "username": inviter.username, "invite_code": inviter.invite_code}

        db.add(
            SyncPolicy(
                owner_id=new_user.id,
                name="我的自有节点默认合并策略",
                enabled=1,
                interval_minutes=15,
                sync_type="smart_merge",
                source_type="all",
                source_id=0,
                source_group="",
                target_type="all",
                target_ids="[]",
                target_group="",
                created_at=now_str,
            )
        )
        db.flush()
        user_payload = new_user.to_dict(include_secrets=True)
        plan_payload = default_plan.to_dict() if default_plan else None
        level_payload = default_level.to_dict() if default_level else None

    # 严格在 session_scope 事务结束后签发 JWT、刷新策略并记录审计日志（避免 SQLite 嵌套写锁）
    token = issue_user_jwt(user_payload)
    reschedule_all_policies()
    write_audit_log(
        action="user_register",
        actor_id=user_payload["id"],
        actor_username=username,
        target_type="user",
        target_id=user_payload["id"],
        ip=ip,
        status="ok",
        details={
            "email": email,
            "email_verified": require_email_verify,
            "welcome_yuan": units_to_yuan_str(welcome_units),
            "inviter": inviter_info,
        },
    )
    return {"message": "注册成功", "token": token, "user": user_payload, "plan": plan_payload, "level": level_payload}


@router.post("/api/login", summary="多租户账号密码 + 图形验证码登录")
def login(data: LoginDTO, req: Request):
    if is_setup_required():
        raise HTTPException(status_code=403, detail="系统尚未完成初始化安装，请先引导管理员完成安装向导")
    ip = get_client_ip(req)
    uname = (data.username or "").strip()
    user_scope_key = f"{ip}:{uname[:64]}"

    check_block("login", ip, "登录失败次数过多，当前 IP 已被临时限制登录")
    check_block("login_user", user_scope_key, "该账号连续登录失败次数过多，请稍后再试")
    enforce_rate_limit("login", ip, RATE_LIMIT_LOGIN_PER_MIN, 60, "登录请求过于频繁，请稍后再试")

    if not verify_and_pop_captcha(data.captcha_token, data.captcha_answer):
        _, blk = record_auth_failure("login", ip, LOGIN_MAX_FAILURES * 2, LOGIN_FAIL_WINDOW_SEC, LOGIN_BLOCK_SECONDS)
        if blk > 0:
            raise HTTPException(
                status_code=429,
                detail=f"验证码连续错误过多，请 {blk} 秒后再试",
                headers={"Retry-After": str(blk)},
            )
        raise HTTPException(status_code=400, detail="验证码错误或已过期")

    deny_reason: Optional[str] = None
    suspended_uid: Optional[int] = None
    suspended_uname: Optional[str] = None
    user_payload = None
    plan_payload = None
    level_payload = None

    with session_scope() as db:
        u = db.query(User).filter(User.username == uname).first()
        if u is None or not verify_password(data.password, u.password_hash):
            deny_reason = "invalid_credentials"
        elif u.status != "active":
            deny_reason = "user_suspended"
            suspended_uid = u.id
            suspended_uname = u.username
        else:
            u.last_login_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            db.flush()
            user_payload = u.to_dict(include_secrets=True)
            plan = db.get(Plan, u.plan_id)
            plan_payload = plan.to_dict() if plan else None
            lv = db.get(UserLevel, int(u.level_id or 1))
            level_payload = lv.to_dict() if lv else None

    if deny_reason == "invalid_credentials":
        fails_ip, blk_ip = record_auth_failure("login", ip, LOGIN_MAX_FAILURES, LOGIN_FAIL_WINDOW_SEC, LOGIN_BLOCK_SECONDS)
        _, blk_user = record_auth_failure("login_user", user_scope_key, LOGIN_MAX_FAILURES, LOGIN_FAIL_WINDOW_SEC, LOGIN_BLOCK_SECONDS)
        blk = max(blk_ip, blk_user)
        write_audit_log(
            action="user_login_failed",
            actor_username=uname or "unknown",
            target_type="user",
            target_id=uname,
            ip=ip,
            status="deny",
            details={"reason": "invalid_credentials"},
        )
        if blk > 0:
            raise HTTPException(
                status_code=429,
                detail=f"登录连续失败过多，请 {blk} 秒后再试",
                headers={"Retry-After": str(blk)},
            )
        rem_tries = max(1, LOGIN_MAX_FAILURES - fails_ip)
        raise HTTPException(status_code=401, detail=f"用户名或密码错误（剩余 {rem_tries} 次尝试后将临时锁定）")

    if deny_reason == "user_suspended":
        write_audit_log(
            action="user_login_blocked",
            actor_id=suspended_uid,
            actor_username=suspended_uname or uname,
            target_type="user",
            target_id=suspended_uid,
            ip=ip,
            status="deny",
            details={"reason": "user_suspended"},
        )
        raise HTTPException(status_code=403, detail="当前账号已被管理员停用，禁止登录")

    token = issue_user_jwt(user_payload)
    clear_auth_failures("login", ip)
    clear_auth_failures("login_user", user_scope_key)
    clear_auth_failures("jwt_auth", ip)
    write_audit_log(
        action="user_login",
        actor_id=user_payload["id"],
        actor_username=user_payload["username"],
        target_type="user",
        target_id=user_payload["id"],
        ip=ip,
        status="ok",
    )
    return {"token": token, "user": user_payload, "plan": plan_payload, "level": level_payload}


@router.get("/api/profile", summary="获取当前租户完整档案、等级、套餐配额与个人接入凭据")
def get_profile(user: dict = Depends(verify_token)):
    with session_scope() as db:
        u = db.get(User, int(user["id"]))
        if u is None:
            raise HTTPException(status_code=404, detail="用户不存在")
        plan = db.get(Plan, u.plan_id)
        lv = db.get(UserLevel, int(u.level_id or 1))
        return {
            "user": u.to_dict(include_secrets=True),
            "plan": plan.to_dict() if plan else None,
            "level": lv.to_dict() if lv else None,
        }


@router.get("/api/referrals/overview", summary="查询我的推荐邀请码、奖励规则与历史返利明细")
def get_my_referrals(user: dict = Depends(verify_token)):
    uid = int(user["id"])
    with session_scope() as db:
        u = db.get(User, uid)
        if u is None:
            raise HTTPException(status_code=404, detail="用户不存在")
        if not u.invite_code:
            u.invite_code = issue_user_invite_code()
            db.flush()
        invite_code = u.invite_code
        rows = (
            db.query(ReferralReward)
            .filter(ReferralReward.inviter_id == uid)
            .order_by(ReferralReward.id.desc())
            .limit(100)
            .all()
        )
        total_earned_units = (
            db.query(func.coalesce(func.sum(ReferralReward.inviter_bonus_units), 0))
            .filter(ReferralReward.inviter_id == uid)
            .scalar()
            or 0
        )
        rewards = [r.to_dict() for r in rows]

    inviter_bonus_units = max(0, int(get_setting("saas_referral_inviter_bonus_units", "50000") or 0))
    invitee_bonus_units = max(0, int(get_setting("saas_referral_invitee_bonus_units", "30000") or 0))
    return {
        "referral_enabled": get_setting("saas_referral_enabled", "1") == "1",
        "invite_code": invite_code,
        "inviter_bonus_yuan": units_to_yuan_str(inviter_bonus_units),
        "invitee_bonus_yuan": units_to_yuan_str(invitee_bonus_units),
        "invited_count": len(rewards),
        "total_earned_units": int(total_earned_units),
        "total_earned_yuan": units_to_yuan_str(int(total_earned_units)),
        "rewards": rewards,
    }


@router.post("/api/profile/rotate-credentials", summary="重置个人 API-Key 或个人集群节点入网码")
def rotate_my_credentials(data: RotateCredDTO, request: Request, user: dict = Depends(verify_token)):
    if not (data.rotate_api_key or data.rotate_join_token):
        raise HTTPException(status_code=400, detail="请至少选择轮换 API-Key 或 JOIN_TOKEN 之一")
    with session_scope() as db:
        u = db.get(User, int(user["id"]))
        if u is None:
            raise HTTPException(status_code=404, detail="用户不存在")
        if data.rotate_api_key:
            u.api_key = issue_user_api_key()
        if data.rotate_join_token:
            u.cluster_join_token = issue_user_join_token()
        db.flush()
        payload = u.to_dict(include_secrets=True)

    write_audit_log(
        action="rotate_credentials",
        actor_id=user["id"],
        actor_username=user["username"],
        target_type="user",
        target_id=user["id"],
        ip=get_client_ip(request),
        status="ok",
        details={"rotate_api_key": data.rotate_api_key, "rotate_join_token": data.rotate_join_token},
    )
    return {"message": "个人凭据已轮换更新", "user": payload}


@router.post("/api/user/password", summary="修改当前账号登录密码")
def update_my_password(data: PasswordUpdateDTO, request: Request, user: dict = Depends(verify_token)):
    if len(data.new_password or "") < 6:
        raise HTTPException(status_code=400, detail="新密码长度不能少于 6 位")
    with session_scope() as db:
        u = db.get(User, int(user["id"]))
        if u is None:
            raise HTTPException(status_code=404, detail="用户不存在")
        if not verify_password(data.old_password, u.password_hash):
            raise HTTPException(status_code=400, detail="原密码校验失败")
        u.password_hash = hash_password(data.new_password)

    write_audit_log(
        action="change_password",
        actor_id=user["id"],
        actor_username=user["username"],
        target_type="user",
        target_id=user["id"],
        ip=get_client_ip(request),
        status="ok",
    )
    return {"message": "登录密码已修改"}
