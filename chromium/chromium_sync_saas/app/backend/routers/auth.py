from datetime import datetime
import random
import re
from typing import Optional
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from core.cache import cache_mgr
from core.db import (
    get_active_db_info,
    get_setting,
    is_setup_required,
    issue_user_api_key,
    issue_user_join_token,
    session_scope,
)
from core.models import BillingLedger, Plan, SyncPolicy, User, units_to_yuan_str
from core.rate_limit import (
    LOGIN_BLOCK_SECONDS,
    LOGIN_FAIL_WINDOW_SEC,
    LOGIN_MAX_FAILURES,
    RATE_LIMIT_ACCOUNT_REGISTER_PER_MIN,
    RATE_LIMIT_CAPTCHA_PER_MIN,
    RATE_LIMIT_LOGIN_PER_MIN,
    check_block,
    clear_auth_failures,
    enforce_rate_limit,
    get_client_ip,
    record_auth_failure,
)
from core.security import (
    hash_password,
    issue_user_jwt,
    store_captcha,
    verify_and_pop_captcha,
    verify_password,
    verify_token,
)
from services.audit_service import write_audit_log
from services.bookmark_service import seed_starter_bookmarks
from services.sync_service import reschedule_all_policies

router = APIRouter(tags=["多租户认证与个人中心"])


class RegisterDTO(BaseModel):
    username: str
    email: Optional[str] = ""
    password: str
    captcha_token: str
    captcha_answer: str


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


@router.get("/api/auth/status", summary="健康检查、系统开关与安装向导状态")
def auth_status():
    db_info = get_active_db_info()
    cache_status = cache_mgr.get_status()
    return {
        "ok": True,
        "status": "healthy",
        "edition": "saas",
        "setup_required": is_setup_required(),
        "allow_public_register": get_setting("saas_allow_public_register", "1") == "1",
        "allow_self_recharge": get_setting("saas_allow_self_recharge", "1") == "1",
        "platform_fee_bps": int(get_setting("saas_platform_fee_bps", "2000") or 2000),
        "db_type": db_info.get("db_type", "sqlite"),
        "cache_backend": cache_status.get("active_backend", "sqlite_cache"),
    }


@router.get("/api/captcha")
def get_captcha(request: Request):
    ip = get_client_ip(request)
    enforce_rate_limit("captcha", ip, RATE_LIMIT_CAPTCHA_PER_MIN, 60, "获取验证码过于频繁，请稍后再试")
    a, b = random.randint(10, 50), random.randint(1, 9)
    token = str(uuid.uuid4())
    store_captcha(token, a + b, ttl_seconds=180)
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="120" height="38" viewBox="0 0 120 38">
        <rect width="100%" height="100%" fill="#0b1224" rx="4"/>
        <text x="18" y="25" font-family="-apple-system, system-ui" font-size="16" font-weight="bold" fill="#38bdf8">{a} + {b} = ?</text>
    </svg>'''
    return {"token": token, "svg": svg}


@router.post("/api/register", summary="SaaS 公开用户注册（分配个人套餐、体验赠金、独立入网码与 API Key）")
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
    email = (data.email or "").strip().lower() or None
    if email and "@" not in email:
        raise HTTPException(status_code=400, detail="邮箱格式不正确")
    if len(data.password or "") < 6:
        raise HTTPException(status_code=400, detail="密码至少需要 6 位字符")

    welcome_units = max(0, int(get_setting("saas_welcome_bonus_units", "100000") or 0))
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    with session_scope() as db:
        if db.query(User.id).filter(User.username == username).first() is not None:
            raise HTTPException(status_code=409, detail="该用户名已被注册")
        if email and db.query(User.id).filter(User.email == email).first() is not None:
            raise HTTPException(status_code=409, detail="该邮箱已被绑定")

        default_plan = db.query(Plan).filter(Plan.is_default == 1).first() or db.query(Plan).order_by(Plan.id.asc()).first()
        plan_id = default_plan.id if default_plan else 1

        new_user = User(
            username=username,
            email=email,
            password_hash=hash_password(data.password),
            role="user",
            status="active",
            plan_id=plan_id,
            balance_units=welcome_units,
            total_recharged_units=welcome_units,
            api_key=issue_user_api_key(),
            cluster_join_token=issue_user_join_token(),
            created_at=now_str,
            last_login_at=now_str,
        )
        db.add(new_user)
        db.flush()

        if welcome_units > 0:
            db.add(
                BillingLedger(
                    user_id=new_user.id,
                    tx_type="welcome_bonus",
                    amount_units=welcome_units,
                    balance_after_units=welcome_units,
                    platform_spread_units=0,
                    remark=f"新用户注册体验赠金 (¥{units_to_yuan_str(welcome_units)})",
                    created_at=now_str,
                )
            )

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
        token = issue_user_jwt(new_user)
        user_payload = new_user.to_dict(include_secrets=True)
        plan_payload = default_plan.to_dict() if default_plan else None

    seed_starter_bookmarks(user_payload["id"])
    reschedule_all_policies()
    write_audit_log(
        action="user_register",
        actor_id=user_payload["id"],
        actor_username=username,
        target_type="user",
        target_id=user_payload["id"],
        ip=ip,
        status="ok",
        details={"email": email or "", "welcome_yuan": units_to_yuan_str(welcome_units)},
    )
    return {"message": "注册成功", "token": token, "user": user_payload, "plan": plan_payload}


@router.post("/api/login", summary="多租户账号密码 + 验证码登录")
def login(data: LoginDTO, req: Request):
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

    with session_scope() as db:
        u = db.query(User).filter(User.username == uname).first()
        if u is None or not verify_password(data.password, u.password_hash):
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

        if u.status != "active":
            write_audit_log(
                action="user_login_blocked",
                actor_id=u.id,
                actor_username=u.username,
                target_type="user",
                target_id=u.id,
                ip=ip,
                status="deny",
                details={"reason": "user_suspended"},
            )
            raise HTTPException(status_code=403, detail="当前账号已被管理员停用，禁止登录")

        u.last_login_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        token = issue_user_jwt(u)
        user_payload = u.to_dict(include_secrets=True)
        plan = db.get(Plan, u.plan_id)
        plan_payload = plan.to_dict() if plan else None

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
    return {"token": token, "user": user_payload, "plan": plan_payload}


@router.get("/api/profile", summary="获取当前租户完整档案、套餐配额与个人接入凭据")
def get_profile(user: dict = Depends(verify_token)):
    with session_scope() as db:
        u = db.get(User, int(user["id"]))
        if u is None:
            raise HTTPException(status_code=404, detail="用户不存在")
        plan = db.get(Plan, u.plan_id)
        return {
            "user": u.to_dict(include_secrets=True),
            "plan": plan.to_dict() if plan else None,
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
