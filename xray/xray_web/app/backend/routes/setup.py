# -*- coding: utf-8 -*-
"""
首次运行安装向导 API（仅在 setup_completed != true 时允许调用）
支持设置：
1. 数据库引擎：内置 SQLite (WAL) 或 外置 MySQL (支持实时连通性测试)
2. 缓存引擎：内置 SQL kv_cache 或 Redis 加速 + SQL 自动回退 (支持实时 PING 测试)
3. Hub 入口与模式：PUBLIC_URL / PUBLIC_PORT / APP_MODE
4. 管理员初始账密与邮箱、集群引导令牌 (cluster_token)、TOFU 策略、系统公告
"""
import datetime
import secrets
import uuid

from flask import Blueprint, jsonify, request
from sqlalchemy import select

from config import Config
from core.cache import cache, test_redis_connection
from core.db import (
    db_session,
    hash_pwd,
    init_db,
    is_setup_required,
    reset_engine,
    set_setting,
    test_database_connection,
    upsert_system_setting,
)
from core.models import User
from core.rate_limit import rate_limit
from routes import resolve_public_endpoint

setup_bp = Blueprint("setup_bp", __name__)


def _build_db_url_from_payload(data: dict) -> str:
    db_type = str(data.get("db_type") or "sqlite").strip().lower()
    if db_type == "mysql":
        explicit_url = str(data.get("database_url") or "").strip()
        if explicit_url:
            if explicit_url.startswith("mysql://"):
                return "mysql+pymysql://" + explicit_url[len("mysql://"):]
            return explicit_url
        return Config.build_mysql_url(
            host=str(data.get("mysql_host") or "127.0.0.1").strip(),
            port=int(data.get("mysql_port") or 3306),
            user=str(data.get("mysql_user") or "root").strip(),
            password=str(data.get("mysql_password") or ""),
            database=str(data.get("mysql_database") or "xray_web").strip(),
        )
    db_path = str(data.get("db_path") or Config.DB_PATH).strip() or "/data/xray_web.db"
    return f"sqlite:///{db_path}"


def _build_redis_url_from_payload(data: dict) -> str:
    if not data.get("redis_enabled"):
        return ""
    explicit_url = str(data.get("redis_url") or "").strip()
    if explicit_url:
        return explicit_url
    host = str(data.get("redis_host") or "127.0.0.1").strip()
    port = int(data.get("redis_port") or 6379)
    password = str(data.get("redis_password") or "").strip()
    db_idx = int(data.get("redis_db") or 0)
    if password:
        import urllib.parse
        return f"redis://:{urllib.parse.quote_plus(password)}@{host}:{port}/{db_idx}"
    return f"redis://{host}:{port}/{db_idx}"


@setup_bp.route("/api/setup/status", methods=["GET"])
def setup_status():
    required = is_setup_required()
    if not required:
        return jsonify({"code": 200, "setup_required": False})

    _, public_port, public_url = resolve_public_endpoint(request)
    return jsonify({
        "code": 200,
        "setup_required": True,
        "defaults": {
            "db_type": Config.db_dialect(),
            "db_path": Config.DB_PATH,
            "mysql_host": Config.MYSQL_HOST or "127.0.0.1",
            "mysql_port": Config.MYSQL_PORT or 3306,
            "mysql_user": Config.MYSQL_USER or "xray_web",
            "mysql_database": Config.MYSQL_DATABASE or "xray_web",
            "redis_enabled": bool(Config.effective_redis_url()),
            "redis_url": Config.REDIS_URL,
            "redis_host": Config.REDIS_HOST or "127.0.0.1",
            "redis_port": Config.REDIS_PORT or 6379,
            "redis_db": Config.REDIS_DB or 0,
            "app_mode": Config.APP_MODE or "all",
            "web_port": Config.WEB_PORT,
            "detected_public_url": public_url,
            "detected_public_port": public_port,
            "public_url": Config.PUBLIC_URL,
            "public_port": Config.PUBLIC_PORT or "",
            "admin_username": "admin",
            "admin_email": "admin@system.local",
            "cluster_token": "ctk_" + secrets.token_hex(16),
            "tofu_enabled": True,
            "node_auto_approve": True,
        },
    })


@setup_bp.route("/api/setup/test_db", methods=["POST"])
@rate_limit("setup_test_db", limit=20, window_seconds=60, msg="数据库连通测试过于频繁，请稍后再试")
def setup_test_db():
    if not is_setup_required():
        return jsonify({"code": 403, "msg": "系统已完成初始化，安装向导已锁定"}), 403

    data = request.json or {}
    target_url = _build_db_url_from_payload(data)
    ok, msg = test_database_connection(target_url)
    return jsonify({"code": 200 if ok else 400, "msg": msg})


@setup_bp.route("/api/setup/test_redis", methods=["POST"])
@rate_limit("setup_test_redis", limit=20, window_seconds=60, msg="Redis 连通测试过于频繁，请稍后再试")
def setup_test_redis():
    if not is_setup_required():
        return jsonify({"code": 403, "msg": "系统已完成初始化，安装向导已锁定"}), 403

    data = request.json or {}
    data["redis_enabled"] = True
    redis_url = _build_redis_url_from_payload(data)
    ok, msg = test_redis_connection(redis_url)
    return jsonify({"code": 200 if ok else 400, "msg": msg})


@setup_bp.route("/api/setup/complete", methods=["POST"])
@rate_limit("setup_complete", limit=10, window_seconds=60, msg="提交过于频繁，请稍后再试")
def setup_complete():
    if not is_setup_required():
        return jsonify({"code": 403, "msg": "系统已完成初始化，禁止重复提交安装向导"}), 403

    data = request.json or {}
    admin_username = str(data.get("admin_username") or "admin").strip()
    admin_password = str(data.get("admin_password") or "").strip()
    admin_email = str(data.get("admin_email") or f"{admin_username}@system.local").strip().lower()

    if len(admin_username) < 2:
        return jsonify({"code": 400, "msg": "管理员用户名至少 2 位字符"}), 400
    if len(admin_password) < 6:
        return jsonify({"code": 400, "msg": "为保证安全，管理员密码至少需要 6 位字符"}), 400
    if "@" not in admin_email:
        return jsonify({"code": 400, "msg": "请输入有效的管理员邮箱"}), 400

    db_type = str(data.get("db_type") or "sqlite").strip().lower()
    if db_type not in ("sqlite", "mysql"):
        return jsonify({"code": 400, "msg": "不支持的数据库类型"}), 400

    target_db_url = _build_db_url_from_payload(data)
    db_ok, db_msg = test_database_connection(target_db_url)
    if not db_ok:
        return jsonify({"code": 400, "msg": db_msg}), 400

    redis_enabled = bool(data.get("redis_enabled"))
    redis_url = _build_redis_url_from_payload(data) if redis_enabled else ""
    if redis_enabled:
        r_ok, r_msg = test_redis_connection(redis_url)
        if not r_ok:
            return jsonify({"code": 400, "msg": f"Redis 测试未通过: {r_msg}（可关闭 Redis 使用内置 SQL Cache）"}), 400

    app_mode = str(data.get("app_mode") or "all").strip().lower()
    if app_mode not in ("all", "user", "admin"):
        app_mode = "all"

    public_url = str(data.get("public_url") or "").strip().rstrip("/")
    try:
        public_port = int(data.get("public_port") or 0)
    except (TypeError, ValueError):
        public_port = 0

    cluster_token = str(data.get("cluster_token") or "").strip() or ("ctk_" + secrets.token_hex(16))
    tofu_enabled = bool(data.get("tofu_enabled", True))
    node_auto_approve = bool(data.get("node_auto_approve", True))
    system_notice = str(data.get("system_notice") or "").strip()

    # 1. 持久化引导配置到 /data/hub_config.json (含 setup_completed=true)
    hub_cfg = {
        "setup_completed": True,
        "db_type": db_type,
        "database_url": target_db_url,
        "db_path": str(data.get("db_path") or Config.DB_PATH).strip() or "/data/xray_web.db",
        "mysql_host": str(data.get("mysql_host") or "").strip(),
        "mysql_port": int(data.get("mysql_port") or 3306),
        "mysql_user": str(data.get("mysql_user") or "").strip(),
        "mysql_password": str(data.get("mysql_password") or ""),
        "mysql_database": str(data.get("mysql_database") or "xray_web").strip(),
        "redis_url": redis_url,
        "redis_host": str(data.get("redis_host") or "").strip() if redis_enabled else "",
        "redis_port": int(data.get("redis_port") or 6379),
        "redis_password": str(data.get("redis_password") or "").strip() if redis_enabled else "",
        "redis_db": int(data.get("redis_db") or 0),
        "public_url": public_url,
        "public_port": public_port,
        "app_mode": app_mode,
    }
    Config.save_hub_config(hub_cfg)

    # 2. 重建 SQLAlchemy 连接池并初始化目标数据库表结构
    reset_engine()
    init_db(force_reload=True)
    cache.reset_client()

    # 3. 写入管理员账号与 Hub 核心配置
    ten_years = (datetime.datetime.now() + datetime.timedelta(days=3650)).strftime("%Y-%m-%d %H:%M:%S")
    with db_session() as s:
        admin_user = s.scalar(select(User).where(User.role == "admin").order_by(User.id.asc()).limit(1))
        if admin_user:
            admin_user.username = admin_username
            admin_user.password_hash = hash_pwd(admin_password)
            admin_user.email = admin_email
            admin_user.status = 1
            admin_user.is_verified = 1
        else:
            s.add(
                User(
                    username=admin_username,
                    password_hash=hash_pwd(admin_password),
                    uuid=str(uuid.uuid4()),
                    email=admin_email,
                    traffic_limit_mb=1048576,
                    used_mb=0.0,
                    expire_date=ten_years,
                    role="admin",
                    status=1,
                    is_verified=1,
                    user_group="admin",
                )
            )
        upsert_system_setting(s, "cluster_token", cluster_token)
        upsert_system_setting(s, "tofu_enabled", "true" if tofu_enabled else "false")
        upsert_system_setting(s, "node_auto_approve", "true" if node_auto_approve else "false")
        upsert_system_setting(s, "system_notice", system_notice)
        upsert_system_setting(s, "setup_completed", "true")

    cache.delete_prefix("setting:")
    set_setting("setup_completed", "true")

    return jsonify({
        "code": 200,
        "msg": "Hub 安装初始化完成！正在进入登录台...",
        "data": {
            "db_dialect": Config.db_dialect(),
            "cache_backend": cache.status()["backend"],
            "admin_username": admin_username,
        },
    })
