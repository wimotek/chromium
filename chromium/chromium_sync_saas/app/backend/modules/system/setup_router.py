import asyncio
from datetime import datetime
import re
import threading
from typing import Optional

from fastapi import APIRouter, Depends, Header as ReqHeader, HTTPException, Request
from pydantic import BaseModel

from config import (
    DEFAULT_MYSQL_DATABASE,
    DEFAULT_MYSQL_HOST,
    DEFAULT_MYSQL_PORT,
    DEFAULT_MYSQL_USER,
    HUB_PORT,
    SAAS_ALLOW_PUBLIC_REGISTER,
    SAAS_DEFAULT_PLATFORM_FEE_BPS,
    apply_hub_network_overrides,
    logger,
)
from core.cache import build_encoded_redis_url, cache_mgr
from core.db import (
    create_or_update_initial_admin,
    get_active_db_info,
    init_db_and_jwt,
    is_setup_required,
    save_bootstrap_config,
    session_scope,
    set_setting,
    test_db_connection,
)
from core.models import Plan, UserLevel
from core.rate_limit import RATE_LIMIT_SETUP_PER_MIN, enforce_rate_limit, get_client_ip
from core.security import issue_user_jwt, require_admin, verify_token
from modules.audit.service import write_audit_log
from modules.notifications.email_channel import send_email_sync
from modules.sync.service import reschedule_all_policies

router = APIRouter(tags=["系统部署（首次安装向导 · 数据库 · SMTP · 初始化）"])
_setup_complete_lock = threading.Lock()
_EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")


def _verify_setup_or_admin(request: Request, authorization: Optional[str] = ReqHeader(None)):
    if is_setup_required():
        return {"sub": "setup_wizard", "role": "admin"}
    u = verify_token(request, authorization)
    return require_admin(u)


class TestDbDTO(BaseModel):
    db_type: str = "sqlite"
    mysql_host: Optional[str] = None
    mysql_port: Optional[int] = 3306
    mysql_user: Optional[str] = None
    mysql_password: Optional[str] = ""
    mysql_database: Optional[str] = None


class TestRedisDTO(BaseModel):
    redis_url: str = ""
    redis_host: Optional[str] = None
    redis_port: Optional[int] = 6379
    redis_db: Optional[int] = 0
    redis_username: Optional[str] = ""
    redis_password: Optional[str] = None
    redis_tls: bool = False
    keep_password: bool = True
    clear_password: bool = False
    key_prefix: Optional[str] = None
    use_current: bool = False


class TestSmtpDTO(BaseModel):
    smtp_host: str = "smtp.yeah.net"
    smtp_port: int = 465
    smtp_ssl: bool = True
    smtp_sender_name: str = "Wimotek SaaS Hub"
    smtp_user: str = ""
    smtp_pass: str = ""
    test_to: Optional[str] = None


class CompleteSetupDTO(BaseModel):
    db_type: str = "sqlite"
    mysql_host: Optional[str] = "127.0.0.1"
    mysql_port: Optional[int] = 3306
    mysql_user: Optional[str] = "root"
    mysql_password: Optional[str] = ""
    mysql_database: Optional[str] = "chromium_sync_saas"
    redis_url: Optional[str] = ""
    redis_host: Optional[str] = None
    redis_port: Optional[int] = 6379
    redis_db: Optional[int] = 0
    redis_username: Optional[str] = ""
    redis_password: Optional[str] = None
    redis_tls: bool = False
    redis_key_prefix: Optional[str] = None
    admin_username: str = "admin"
    admin_password: str
    admin_email: Optional[str] = ""
    hub_public_host: Optional[str] = ""
    hub_external_port: Optional[int] = None
    saas_platform_fee_bps: int = 2000
    saas_allow_public_register: bool = True
    saas_require_email_verify: bool = True
    smtp_host: Optional[str] = "smtp.yeah.net"
    smtp_port: Optional[int] = 465
    smtp_ssl: bool = True
    smtp_sender_name: Optional[str] = "Wimotek SaaS Hub"
    smtp_user: Optional[str] = ""
    smtp_pass: Optional[str] = ""
    email_notify_enabled: bool = False
    email_notify_to: Optional[str] = ""


@router.get("/api/setup/status", summary="检查 SaaS 初始化安装向导状态")
def get_setup_status():
    db_info = get_active_db_info()
    cache_status = cache_mgr.get_status()
    return {
        "setup_required": is_setup_required(),
        "edition": "saas",
        "tofu_removed": True,
        "db_type": db_info.get("db_type", "sqlite"),
        "cache_backend": cache_status.get("active_backend", "sqlite_cache"),
        "cache_state": cache_status.get("engine_state", "sqlite_cache"),
        "cache_degraded": bool(cache_status.get("degraded", False)),
        "defaults": {
            "db_type": db_info.get("db_type", "sqlite"),
            "mysql_host": DEFAULT_MYSQL_HOST,
            "mysql_port": DEFAULT_MYSQL_PORT,
            "mysql_user": DEFAULT_MYSQL_USER,
            "mysql_database": DEFAULT_MYSQL_DATABASE,
            "hub_port": HUB_PORT,
            "saas_platform_fee_bps": SAAS_DEFAULT_PLATFORM_FEE_BPS,
            "saas_allow_public_register": SAAS_ALLOW_PUBLIC_REGISTER,
            "saas_require_email_verify": True,
            "smtp_host": "smtp.yeah.net",
            "smtp_port": 465,
            "smtp_ssl": True,
            "smtp_sender_name": "Wimotek SaaS Hub",
        },
    }


@router.post("/api/setup/test-db", summary="测试 SQLite / MySQL 数据库连通性")
def setup_test_db(data: TestDbDTO, request: Request, auth: dict = Depends(_verify_setup_or_admin)):
    enforce_rate_limit("setup", get_client_ip(request), RATE_LIMIT_SETUP_PER_MIN, 60, "数据库连通性探测过于频繁")
    cfg = {
        "db_type": (data.db_type or "sqlite").strip().lower(),
        "mysql_host": (data.mysql_host or DEFAULT_MYSQL_HOST).strip(),
        "mysql_port": int(data.mysql_port or DEFAULT_MYSQL_PORT or 3306),
        "mysql_user": (data.mysql_user or DEFAULT_MYSQL_USER).strip(),
        "mysql_password": data.mysql_password or "",
        "mysql_database": (data.mysql_database or DEFAULT_MYSQL_DATABASE).strip(),
    }
    res = test_db_connection(cfg)
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("detail", "数据库连接失败"))
    return res


@router.post("/api/setup/test-redis", summary="测试 Redis 缓存服务连通性")
def setup_test_redis(data: TestRedisDTO, request: Request, auth: dict = Depends(_verify_setup_or_admin)):
    enforce_rate_limit("setup", get_client_ip(request), RATE_LIMIT_SETUP_PER_MIN, 60, "Redis 连通性探测过于频繁")
    res = cache_mgr.test_target(
        data.redis_url,
        use_current=bool(data.use_current),
        redis_host=data.redis_host,
        redis_port=data.redis_port,
        redis_db=data.redis_db,
        redis_username=data.redis_username,
        redis_password=data.redis_password,
        redis_tls=bool(data.redis_tls),
        keep_password=bool(data.keep_password),
        clear_password=bool(data.clear_password),
        key_prefix=data.key_prefix,
    )
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("detail", "Redis 连接失败"))
    return res


@router.post("/api/setup/test-smtp", summary="安装向导测试 SMTP 邮件发信连通性")
async def setup_test_smtp(data: TestSmtpDTO, request: Request, auth: dict = Depends(_verify_setup_or_admin)):
    enforce_rate_limit("setup", get_client_ip(request), RATE_LIMIT_SETUP_PER_MIN, 60, "SMTP 发信测试过于频繁")
    target = (data.test_to or data.smtp_user or "").strip()
    if not _EMAIL_RE.fullmatch(target):
        raise HTTPException(status_code=400, detail="请填写合法的测试收件邮箱地址")
    override_cfg = {
        "smtp_host": (data.smtp_host or "").strip(),
        "smtp_port": int(data.smtp_port or 465),
        "smtp_ssl": bool(data.smtp_ssl),
        "smtp_sender_name": (data.smtp_sender_name or "Wimotek SaaS Hub").strip(),
        "smtp_user": (data.smtp_user or "").strip(),
        "smtp_pass": (data.smtp_pass or "").strip(),
    }
    try:
        await asyncio.to_thread(
            send_email_sync,
            target,
            "【Chromium Sync SaaS】安装向导 SMTP 连通性测试",
            "您好，这是安装向导触发的一封测试邮件。若您能正常查收，说明您的 SMTP 发信服务器已配置就绪，可用于注册邮箱认证与系统通知。",
            override_cfg,
            False,
        )
        return {"ok": True, "message": f"SMTP 测试邮件已发送至 {target}，请查收"}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"SMTP 发信测试失败: {exc}")


@router.post("/api/setup/complete", summary="完成 SaaS 平台数据库、缓存、SMTP 与超级管理员初始化")
def complete_initial_setup(data: CompleteSetupDTO, request: Request):
    enforce_rate_limit("setup", get_client_ip(request), RATE_LIMIT_SETUP_PER_MIN, 60, "安装提交过于频繁")
    client_ip = get_client_ip(request)
    with _setup_complete_lock:
        return _complete_initial_setup_locked(data, client_ip)


def _complete_initial_setup_locked(data: CompleteSetupDTO, client_ip: str):
    if not is_setup_required():
        raise HTTPException(status_code=403, detail="系统已完成初始化，禁止通过安装向导覆盖凭据")

    username = (data.admin_username or "").strip()
    if len(username) < 2:
        raise HTTPException(status_code=400, detail="管理员用户名至少需要 2 个字符")
    if len(data.admin_password or "") < 6:
        raise HTTPException(status_code=400, detail="管理员密码至少需要 6 位字符")

    admin_email = (data.admin_email or "").strip().lower()
    if admin_email and not _EMAIL_RE.fullmatch(admin_email):
        raise HTTPException(status_code=400, detail="管理员邮箱格式不正确")

    db_type = (data.db_type or "sqlite").strip().lower()
    if db_type not in {"sqlite", "mysql"}:
        raise HTTPException(status_code=400, detail="不支持的数据库类型，仅支持 sqlite 或 mysql")

    try:
        resolved_redis_cfg, resolved_prefix = cache_mgr.resolve_target_config(
            redis_url=data.redis_url or "",
            redis_host=data.redis_host,
            redis_port=data.redis_port,
            redis_db=data.redis_db,
            redis_username=data.redis_username,
            redis_password=data.redis_password,
            redis_tls=bool(data.redis_tls),
            keep_password=False,
            clear_password=False,
            use_current=False,
            key_prefix=data.redis_key_prefix,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    boot_cfg = {
        "setup_completed": True,
        "completed_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "db_type": db_type,
        "redis_url": build_encoded_redis_url(resolved_redis_cfg) if resolved_redis_cfg else "",
        "redis_config": resolved_redis_cfg,
        "redis_key_prefix": resolved_prefix,
        "hub_public_host": (data.hub_public_host or "").strip(),
        "hub_external_port": int(data.hub_external_port) if data.hub_external_port else None,
    }
    if db_type == "mysql":
        boot_cfg.update({
            "mysql_host": (data.mysql_host or DEFAULT_MYSQL_HOST).strip(),
            "mysql_port": int(data.mysql_port or DEFAULT_MYSQL_PORT or 3306),
            "mysql_user": (data.mysql_user or DEFAULT_MYSQL_USER).strip(),
            "mysql_password": data.mysql_password or "",
            "mysql_database": (data.mysql_database or DEFAULT_MYSQL_DATABASE).strip(),
        })

    db_test = test_db_connection(boot_cfg)
    if not db_test.get("ok"):
        raise HTTPException(status_code=400, detail=db_test.get("detail", "目标数据库连接测试失败"))

    cache_mgr.reload_from_config(
        redis_url="" if not resolved_redis_cfg else None,
        source="bootstrap",
        redis_config=resolved_redis_cfg,
        key_prefix=resolved_prefix,
    )
    apply_hub_network_overrides(
        public_host=boot_cfg.get("hub_public_host"),
        external_port=boot_cfg.get("hub_external_port"),
    )

    init_db_and_jwt(boot_cfg, mark_setup_completed=True)

    fee_bps = max(0, min(10000, int(data.saas_platform_fee_bps or 0)))
    set_setting("saas_platform_fee_bps", str(fee_bps))
    set_setting("saas_reverse_fee_bps", str(fee_bps))
    set_setting("saas_allow_public_register", "1" if data.saas_allow_public_register else "0")
    set_setting("saas_require_email_verify", "1" if data.saas_require_email_verify else "0")

    smtp_host = (data.smtp_host or "").strip()
    smtp_user = (data.smtp_user or "").strip()
    smtp_pass = (data.smtp_pass or "").strip()
    if smtp_host:
        set_setting("smtp_host", smtp_host)
    set_setting("smtp_port", str(int(data.smtp_port or 465)))
    set_setting("smtp_ssl", "1" if data.smtp_ssl else "0")
    set_setting("smtp_sender_name", (data.smtp_sender_name or "Wimotek SaaS Hub").strip() or "Wimotek SaaS Hub")
    if smtp_user:
        set_setting("smtp_user", smtp_user)
    if smtp_pass:
        set_setting("smtp_pass", smtp_pass)
    if smtp_host and smtp_user and smtp_pass:
        set_setting("smtp_status", "configured")
    notify_to = (data.email_notify_to or admin_email or smtp_user or "").strip()
    if notify_to:
        set_setting("email_notify_to", notify_to)
    set_setting("email_notify_enabled", "1" if (data.email_notify_enabled or (smtp_host and smtp_user and smtp_pass)) else "0")
    set_setting("setup_completed", "1")

    with session_scope() as db:
        admin_obj = create_or_update_initial_admin(db, username, data.admin_password, admin_email=admin_email or None)
        plan = db.get(Plan, admin_obj.plan_id)
        lv = db.get(UserLevel, int(admin_obj.level_id or 1))
        user_payload = admin_obj.to_dict(include_secrets=True)
        plan_payload = plan.to_dict() if plan else None
        level_payload = lv.to_dict() if lv else None

    # 仅在数据库与初始管理员创建全部成功后落盘 setup_completed 标记，避免半途失败后阻塞重试
    save_bootstrap_config(boot_cfg)

    # 严格在 session_scope 外签发 JWT 与记录审计日志
    token = issue_user_jwt(user_payload)
    reschedule_all_policies()
    write_audit_log(
        action="setup_completed",
        actor_id=user_payload["id"],
        actor_username=username,
        target_type="system",
        target_id="saas_hub",
        ip=client_ip,
        status="ok",
        details={
            "db_type": db_type,
            "platform_fee_bps": fee_bps,
            "smtp_configured": bool(smtp_host and smtp_user and smtp_pass),
            "require_email_verify": bool(data.saas_require_email_verify),
        },
    )
    logger.info(f"🎉 [SaaS 初始化完成] 超级管理员={username} | DB={db_type.upper()} | Cache={cache_mgr.get_status()['active_backend']}")
    return {
        "message": "SaaS 平台初始化完成",
        "token": token,
        "user": user_payload,
        "plan": plan_payload,
        "level": level_payload,
        "db_type": db_type,
        "cache_backend": cache_mgr.get_status()["active_backend"],
    }
