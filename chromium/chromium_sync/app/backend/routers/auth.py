import random
import uuid
from datetime import datetime, timedelta

import jwt
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from core.cache import cache_mgr
from core.db import get_active_db_info, get_setting, is_setup_required, set_setting
from core.rate_limit import (
    LOGIN_BLOCK_SECONDS,
    LOGIN_FAIL_WINDOW_SEC,
    LOGIN_MAX_FAILURES,
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
    store_captcha,
    verify_and_pop_captcha,
    verify_password,
    verify_token,
)

router = APIRouter(tags=["认证"])


class LoginDTO(BaseModel):
    username: str
    password: str
    captcha_token: str
    captcha_answer: str


@router.get("/api/auth/status", summary="健康检查与初始化/缓存引擎状态")
def auth_status():
    db_info = get_active_db_info()
    cache_status = cache_mgr.get_status()
    return {
        "ok": True,
        "status": "healthy",
        "setup_required": is_setup_required(),
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
        <rect width="100%" height="100%" fill="#09122a" rx="4"/>
        <text x="18" y="25" font-family="-apple-system, system-ui" font-size="16" font-weight="bold" fill="#00f0ff">{a} + {b} = ?</text>
    </svg>'''
    return {"token": token, "svg": svg}


@router.post("/api/login")
def login(data: LoginDTO, req: Request):
    if is_setup_required():
        raise HTTPException(status_code=403, detail="系统尚未完成初始化安装，请先通过首次安装向导设置管理员账号与密码")
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

    admin_user = get_setting("admin_username", "")
    hashed_pwd = get_setting("admin_password", "")

    if not admin_user or not hashed_pwd or uname != admin_user or not verify_password(data.password, hashed_pwd):
        fails_ip, blk_ip = record_auth_failure("login", ip, LOGIN_MAX_FAILURES, LOGIN_FAIL_WINDOW_SEC, LOGIN_BLOCK_SECONDS)
        _, blk_user = record_auth_failure("login_user", user_scope_key, LOGIN_MAX_FAILURES, LOGIN_FAIL_WINDOW_SEC, LOGIN_BLOCK_SECONDS)
        blk = max(blk_ip, blk_user)
        if blk > 0:
            raise HTTPException(
                status_code=429,
                detail=f"登录连续失败过多，请 {blk} 秒后再试",
                headers={"Retry-After": str(blk)},
            )
        rem_tries = max(1, LOGIN_MAX_FAILURES - fails_ip)
        raise HTTPException(status_code=401, detail=f"用户名或密码错误（剩余 {rem_tries} 次尝试后将临时锁定）")

    clear_auth_failures("login", ip)
    clear_auth_failures("login_user", user_scope_key)
    clear_auth_failures("jwt_auth", ip)

    jwt_secret = get_setting("jwt_secret")
    return {
        "token": jwt.encode(
            {"sub": admin_user, "exp": datetime.utcnow() + timedelta(days=7)},
            jwt_secret,
            algorithm="HS256",
        )
    }


@router.get("/api/profile")
def get_profile(user: dict = Depends(verify_token)):
    return {
        "username": get_setting("admin_username"),
        "api_key": get_setting("api_key"),
    }


@router.post("/api/profile")
def update_profile(data: dict, user: dict = Depends(verify_token)):
    import secrets

    if data.get("username"):
        set_setting("admin_username", data["username"].strip())
    if data.get("new_password"):
        set_setting("admin_password", hash_password(data["new_password"]))
    if data.get("regenerate_key"):
        set_setting("api_key", "cdp_" + secrets.token_urlsafe(24))
    return {"message": "配置更新成功"}