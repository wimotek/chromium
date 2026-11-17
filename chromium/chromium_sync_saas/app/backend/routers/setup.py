from datetime import datetime
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
from core.cache import cache_mgr
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
from core.rate_limit import RATE_LIMIT_SETUP_PER_MIN, enforce_rate_limit, get_client_ip
from core.security import issue_user_jwt, require_admin, verify_token
from services.audit_service import write_audit_log
from services.sync_service import reschedule_all_policies

router = APIRouter(tags=["SaaS 首次安装向导"])
_setup_complete_lock = threading.Lock()


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


class CompleteSetupDTO(BaseModel):
    db_type: str = "sqlite"
    mysql_host: Optional[str] = "127.0.0.1"
    mysql_port: Optional[int] = 3306
    mysql_user: Optional[str] = "root"
    mysql_password: Optional[str] = ""
    mysql_database: Optional[str] = "chromium_sync_saas"
    redis_url: Optional[str] = ""
    admin_username: str = "admin"
    admin_password: str
    hub_public_host: Optional[str] = ""
    hub_external_port: Optional[int] = None
    saas_platform_fee_bps: int = 2000
    saas_allow_public_register: bool = True


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
        "defaults": {
            "db_type": db_info.get("db_type", "sqlite"),
            "mysql_host": DEFAULT_MYSQL_HOST,
            "mysql_port": DEFAULT_MYSQL_PORT,
            "mysql_user": DEFAULT_MYSQL_USER,
            "mysql_database": DEFAULT_MYSQL_DATABASE,
            "hub_port": HUB_PORT,
            "saas_platform_fee_bps": SAAS_DEFAULT_PLATFORM_FEE_BPS,
            "saas_allow_public_register": SAAS_ALLOW_PUBLIC_REGISTER,
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
    res = cache_mgr.test_connection(data.redis_url)
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("detail", "Redis 连接失败"))
    return res


@router.post("/api/setup/complete", summary="完成 SaaS 平台数据库、缓存与超级管理员初始化（零 TOFU）")
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

    db_type = (data.db_type or "sqlite").strip().lower()
    if db_type not in {"sqlite", "mysql"}:
        raise HTTPException(status_code=400, detail="不支持的数据库类型，仅支持 sqlite 或 mysql")

    boot_cfg = {
        "setup_completed": True,
        "completed_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "db_type": db_type,
        "redis_url": (data.redis_url or "").strip(),
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

    save_bootstrap_config(boot_cfg)
    cache_mgr.reload_from_config(boot_cfg["redis_url"])

    apply_hub_network_overrides(
        public_host=boot_cfg.get("hub_public_host"),
        external_port=boot_cfg.get("hub_external_port"),
    )

    init_db_and_jwt(boot_cfg, mark_setup_completed=True)

    fee_bps = max(0, min(10000, int(data.saas_platform_fee_bps or 0)))
    set_setting("saas_platform_fee_bps", str(fee_bps))
    set_setting("saas_allow_public_register", "1" if data.saas_allow_public_register else "0")
    set_setting("setup_completed", "1")

    with session_scope() as db:
        admin_obj = create_or_update_initial_admin(db, username, data.admin_password)
        token = issue_user_jwt(admin_obj)
        user_payload = admin_obj.to_dict(include_secrets=True)

    reschedule_all_policies()
    write_audit_log(
        action="setup_completed",
        actor_id=user_payload["id"],
        actor_username=username,
        target_type="system",
        target_id="saas_hub",
        ip=client_ip,
        status="ok",
        details={"db_type": db_type, "platform_fee_bps": fee_bps},
    )
    logger.info(f"🎉 [SaaS 初始化完成] 超级管理员={username} | DB={db_type.upper()} | Cache={cache_mgr.get_status()['active_backend']}")
    return {
        "message": "SaaS 平台初始化完成",
        "token": token,
        "user": user_payload,
        "db_type": db_type,
        "cache_backend": cache_mgr.get_status()["active_backend"],
    }
