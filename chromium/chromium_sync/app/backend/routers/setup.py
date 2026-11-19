from datetime import datetime, timedelta
import threading
from typing import Optional
import jwt
from fastapi import APIRouter, Depends, Header as ReqHeader, HTTPException, Query, Request
from pydantic import BaseModel

from config import (
    DEFAULT_MYSQL_DATABASE,
    DEFAULT_MYSQL_HOST,
    DEFAULT_MYSQL_PORT,
    DEFAULT_MYSQL_USER,
    HUB_PORT,
    apply_hub_network_overrides,
    logger,
)
from core.cache import cache_mgr
from core.db import (
    get_active_db_info,
    get_setting,
    init_db_and_jwt,
    is_setup_required,
    load_bootstrap_config,
    save_bootstrap_config,
    set_settings_batch,
    test_db_connection,
)
from core.rate_limit import RATE_LIMIT_SETUP_PER_MIN, enforce_rate_limit, get_antispam_stats, get_client_ip
from core.security import hash_password, verify_token
from services.sync_service import reschedule_all_policies
from services.traffic_service import (
    get_node_traffic_detail,
    get_traffic_summary,
    reset_node_traffic,
)

router = APIRouter(tags=["首次安装向导与运行时监控"])
_setup_complete_lock = threading.Lock()


def _verify_setup_or_admin(request: Request, authorization: Optional[str] = ReqHeader(None)):
    if is_setup_required():
        return {"sub": "setup_wizard"}
    return verify_token(request, authorization)


class TestDbDTO(BaseModel):
    db_type: str = "sqlite"
    mysql_host: Optional[str] = None
    mysql_port: Optional[int] = 3306
    mysql_user: Optional[str] = None
    mysql_password: Optional[str] = ""
    mysql_database: Optional[str] = None


class TestRedisDTO(BaseModel):
    redis_url: str = ""
    use_current: bool = False


class CacheReloadDTO(BaseModel):
    mode: Optional[str] = None
    redis_url: str = ""
    use_current: bool = False
    reconnect_only: bool = False


class CompleteSetupDTO(BaseModel):
    db_type: str = "sqlite"
    mysql_host: Optional[str] = "127.0.0.1"
    mysql_port: Optional[int] = 3306
    mysql_user: Optional[str] = "root"
    mysql_password: Optional[str] = ""
    mysql_database: Optional[str] = "chromium_sync"
    redis_url: Optional[str] = ""
    admin_username: str = "admin"
    admin_password: str
    hub_public_host: Optional[str] = ""
    hub_external_port: Optional[int] = None
    tofu_enabled: bool = True
    tofu_auto_approve: bool = False


@router.get("/api/setup/status", summary="检查首次安装向导状态与默认存储引擎")
def get_setup_status():
    db_info = get_active_db_info()
    cache_status = cache_mgr.get_status()
    return {
        "setup_required": is_setup_required(),
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
            "tofu_enabled": True,
            "tofu_auto_approve": False,
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
    res = cache_mgr.test_target(data.redis_url, use_current=bool(data.use_current))
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("detail", "Redis 连接失败"))
    return res


@router.post("/api/setup/complete", summary="保存配置、初始化数据库/缓存并完成首次安装")
def complete_initial_setup(data: CompleteSetupDTO, request: Request):
    enforce_rate_limit("setup", get_client_ip(request), RATE_LIMIT_SETUP_PER_MIN, 60, "安装提交过于频繁")
    with _setup_complete_lock:
        return _complete_initial_setup_locked(data)


def _complete_initial_setup_locked(data: CompleteSetupDTO):
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

    # 1. 先行校验目标数据库连通性
    db_test = test_db_connection(boot_cfg)
    if not db_test.get("ok"):
        raise HTTPException(status_code=400, detail=db_test.get("detail", "目标数据库连接测试失败"))

    # 2. 切换缓存引擎并应用对外域名/端口覆盖参数（此时尚未落盘 bootstrap.json，确保失败可重试）
    cache_mgr.reload_from_config(boot_cfg["redis_url"])
    apply_hub_network_overrides(
        public_host=boot_cfg.get("hub_public_host"),
        external_port=boot_cfg.get("hub_external_port"),
    )

    # 3. 热初始化目标数据库引擎、ORM 表、默认策略与管理员凭据（单事务批量写入）
    init_db_and_jwt(boot_cfg, mark_setup_completed=True)
    set_settings_batch({
        "admin_username": username,
        "admin_password": hash_password(data.admin_password),
        "tofu_enabled": "1" if data.tofu_enabled else "0",
        "tofu_auto_approve": "1" if data.tofu_auto_approve else "0",
        "setup_completed": "1",
    })

    # 4. 生成管理员会话 JWT 与集群关键凭据
    jwt_secret = get_setting("jwt_secret")
    api_key_val = get_setting("api_key")
    join_tok_val = get_setting("cluster_join_token")
    token = jwt.encode(
        {"sub": username, "exp": datetime.utcnow() + timedelta(days=7)},
        jwt_secret,
        algorithm="HS256",
    )

    # 5. 所有核心初始化全部成功后再原子落盘 bootstrap.json，彻底避免半成品锁死安装向导
    save_bootstrap_config(boot_cfg)

    try:
        reschedule_all_policies()
    except Exception as exc:
        logger.warning(f"⚠️ 首次安装后重载定时策略异常（将在服务周期内自动恢复）: {exc}")

    logger.info(f"🎉 [首次安装完成] 管理员={username} | DB={db_type.upper()} | Cache={cache_mgr.get_status()['active_backend']}")
    return {
        "message": "系统初始化完成",
        "token": token,
        "api_key": api_key_val,
        "cluster_join_token": join_tok_val,
        "db_type": db_type,
        "cache_backend": cache_mgr.get_status()["active_backend"],
    }


@router.get("/api/system/runtime-info", summary="获取数据库 ORM 与缓存运行时状态")
def get_system_runtime_info(user: dict = Depends(verify_token)):
    return {
        "setup_completed": not is_setup_required(),
        "db": get_active_db_info(),
        "cache": cache_mgr.get_status(),
        "antispam": get_antispam_stats(),
    }


@router.get("/api/system/cache/status", summary="实时获取当前缓存引擎状态（SQL Cache / Redis / 降级状态）")
def get_cache_engine_status(user: dict = Depends(verify_token)):
    return cache_mgr.get_status()


@router.post("/api/system/cache/test", summary="在线执行 Redis PING 连通性测试")
def test_cache_redis_ping(data: TestRedisDTO, request: Request, user: dict = Depends(verify_token)):
    enforce_rate_limit("setup", get_client_ip(request), RATE_LIMIT_SETUP_PER_MIN, 60, "Redis PING 测试过于频繁")
    return cache_mgr.test_target(data.redis_url, use_current=bool(data.use_current))


@router.post("/api/system/cache/reload", summary="一键热切换并持久化缓存引擎配置（SQLite Cache / Redis）")
def reload_cache_config(data: CacheReloadDTO, user: dict = Depends(verify_token)):
    if data.reconnect_only:
        return cache_mgr.probe_reconnect()

    mode = (data.mode or "").strip().lower()
    if mode in {"sqlite", "sqlite_cache", "sql"}:
        new_url = ""
    elif data.use_current and not (data.redis_url or "").strip():
        new_url = cache_mgr.get_current_redis_url()
    else:
        new_url = (data.redis_url or "").strip()

    if mode == "redis" and not new_url:
        raise HTTPException(status_code=400, detail="请填写 Redis 连接 URL（如 redis://127.0.0.1:6379/0）")

    boot = load_bootstrap_config()
    boot["redis_url"] = new_url
    save_bootstrap_config(boot)
    cache_mgr.reload_from_config(new_url, source="bootstrap")
    status = cache_mgr.get_status()

    if status["engine_state"] == "redis":
        info = status.get("redis_info") or {}
        ver = info.get("version") or "?"
        ping_ms = info.get("ping_ms")
        lat_txt = f", {ping_ms}ms" if ping_ms is not None else ""
        msg = f"已热切换并保存为 Redis 高速缓存 (v{ver}{lat_txt})"
        ok = True
    elif status["engine_state"] == "degraded":
        msg = f"Redis 配置已保存，但当前连接失败 ({status.get('last_error') or '不可达'})，已自动降级至 SQLite WAL Cache 兜底"
        ok = False
    else:
        msg = "已热切换并保存为内置 SQLite WAL Cache"
        ok = True

    return {
        "ok": ok,
        "degraded": bool(status.get("degraded", False)),
        "message": msg,
        "cache": status,
    }


@router.get("/api/traffic/summary", summary="获取全集群 CDP 网关与节点网卡流量统计总览")
def api_traffic_summary(
    hours: int = Query(24, ge=1, le=168),
    user: dict = Depends(verify_token),
):
    return get_traffic_summary(limit_hours=hours)


@router.get("/api/nodes/{node_id}/traffic", summary="获取指定节点实时与按小时流量明细")
def api_node_traffic_detail(node_id: int, user: dict = Depends(verify_token)):
    detail = get_node_traffic_detail(node_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="节点不存在")
    return detail


@router.post("/api/nodes/{node_id}/traffic/reset", summary="清零指定节点的累计流量统计")
def api_reset_node_traffic(node_id: int, user: dict = Depends(verify_token)):
    reset_node_traffic(node_id)
    return {"message": f"节点 ID:{node_id} 流量统计已清零"}
