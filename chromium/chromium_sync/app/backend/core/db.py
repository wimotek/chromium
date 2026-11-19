import json
import os
import secrets
import threading
import time
from contextlib import contextmanager
from datetime import datetime
from typing import Any, Dict, Optional
from urllib.parse import quote_plus

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import Session, sessionmaker

from config import (
    BOOTSTRAP_CONFIG_PATH,
    DATA_DIR,
    DB_PATH,
    DEFAULT_DATABASE_URL,
    DEFAULT_DB_TYPE,
    DEFAULT_MYSQL_DATABASE,
    DEFAULT_MYSQL_HOST,
    DEFAULT_MYSQL_PASSWORD,
    DEFAULT_MYSQL_PORT,
    DEFAULT_MYSQL_USER,
    logger,
)
from core.cache import cache_mgr
from core.models import Base, Node, Setting, SyncPolicy

_engine_lock = threading.Lock()
_engine = None
_SessionLocal = None
_active_db_config: Dict[str, Any] = {}
_active_session_tls = threading.local()

SETTINGS_CACHE_PREFIX = "cfg:setting:"


def load_bootstrap_config() -> Dict[str, Any]:
    if os.path.exists(BOOTSTRAP_CONFIG_PATH):
        try:
            with open(BOOTSTRAP_CONFIG_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    return data
        except Exception:
            pass
    return {}


def save_bootstrap_config(data: Dict[str, Any]):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(BOOTSTRAP_CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    try:
        os.chmod(BOOTSTRAP_CONFIG_PATH, 0o600)
    except OSError:
        pass


def build_sqlalchemy_url(cfg: Optional[Dict[str, Any]] = None) -> tuple[str, str, Dict[str, Any]]:
    boot = cfg if cfg is not None else load_bootstrap_config()

    if DEFAULT_DATABASE_URL and cfg is None and not boot.get("db_url") and not boot.get("db_type"):
        db_type = "mysql" if DEFAULT_DATABASE_URL.startswith("mysql") else "sqlite"
        return db_type, DEFAULT_DATABASE_URL, {"db_type": db_type}

    db_type = str(boot.get("db_type") or DEFAULT_DB_TYPE or "sqlite").strip().lower()
    if db_type == "mysql":
        if boot.get("db_url"):
            return "mysql", str(boot["db_url"]), boot
        host = str(boot.get("mysql_host") or DEFAULT_MYSQL_HOST).strip()
        port = int(boot.get("mysql_port") or DEFAULT_MYSQL_PORT or 3306)
        user = str(boot.get("mysql_user") or DEFAULT_MYSQL_USER).strip()
        password = str(boot.get("mysql_password") if boot.get("mysql_password") is not None else DEFAULT_MYSQL_PASSWORD)
        database = str(boot.get("mysql_database") or DEFAULT_MYSQL_DATABASE).strip()
        url = (
            f"mysql+pymysql://{quote_plus(user)}:{quote_plus(password)}@{host}:{port}/"
            f"{quote_plus(database)}?charset=utf8mb4"
        )
        return "mysql", url, {
            "db_type": "mysql",
            "mysql_host": host,
            "mysql_port": port,
            "mysql_user": user,
            "mysql_database": database,
        }

    sqlite_path = str(boot.get("sqlite_path") or DB_PATH).strip()
    os.makedirs(os.path.dirname(sqlite_path), exist_ok=True)
    return "sqlite", f"sqlite:///{sqlite_path}", {"db_type": "sqlite", "sqlite_path": sqlite_path}


def _create_orm_engine(db_type: str, url: str):
    if db_type == "mysql":
        engine = create_engine(
            url,
            pool_pre_ping=True,
            pool_recycle=1800,
            pool_size=10,
            max_overflow=20,
            connect_args={"connect_timeout": 5},
        )
        return engine

    engine = create_engine(
        url,
        connect_args={"check_same_thread": False, "timeout": 15.0},
        pool_pre_ping=True,
    )

    @event.listens_for(engine, "connect")
    def _set_sqlite_pragma(dbapi_conn, _connection_record):
        # 禁用 pysqlite 隐式延迟事务，交由下方 BEGIN IMMEDIATE 显式开启写排队事务
        dbapi_conn.isolation_level = None
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA journal_mode=WAL;")
        cursor.execute("PRAGMA busy_timeout=15000;")
        cursor.execute("PRAGMA synchronous=NORMAL;")
        cursor.execute("PRAGMA foreign_keys=ON;")
        cursor.execute("PRAGMA temp_store=MEMORY;")
        cursor.close()

    @event.listens_for(engine, "begin")
    def _do_sqlite_begin(conn):
        # 使用 BEGIN IMMEDIATE 避免先 SELECT (SHARED锁) 再 UPDATE (RESERVED锁) 时绕过 busy_timeout 直接报错 database is locked
        conn.exec_driver_sql("BEGIN IMMEDIATE")

    return engine


def init_engine(cfg: Optional[Dict[str, Any]] = None):
    global _engine, _SessionLocal, _active_db_config
    with _engine_lock:
        db_type, url, meta = build_sqlalchemy_url(cfg)
        if _engine is not None:
            try:
                _engine.dispose()
            except Exception:
                pass
        _engine = _create_orm_engine(db_type, url)
        _SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=_engine)
        _active_db_config = meta
        logger.info(f"🗄️ [ORM] 数据库引擎已就绪: {db_type.upper()}")
        return _engine


def get_engine():
    if _engine is None:
        init_engine()
    return _engine


def get_session() -> Session:
    if _SessionLocal is None:
        init_engine()
    return _SessionLocal()


@contextmanager
def session_scope():
    stack = getattr(_active_session_tls, "stack", None)
    if stack is None:
        stack = []
        _active_session_tls.stack = stack
    if stack:
        yield stack[-1]
        return

    session = get_session()
    stack.append(session)
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        stack.pop()
        session.close()


def get_active_db_info() -> Dict[str, Any]:
    if not _active_db_config:
        get_engine()
    info = dict(_active_db_config)
    db_type = str(info.get("db_type") or "sqlite").lower()
    if db_type == "mysql":
        host = info.get("mysql_host") or DEFAULT_MYSQL_HOST
        port = info.get("mysql_port") or DEFAULT_MYSQL_PORT
        database = info.get("mysql_database") or DEFAULT_MYSQL_DATABASE
        user = info.get("mysql_user") or DEFAULT_MYSQL_USER
        info["target"] = f"{user}@{host}:{port}/{database}"
    else:
        info["target"] = str(info.get("sqlite_path") or DB_PATH)
    info["dialect"] = db_type
    info["status"] = "active"
    info["cache_backend"] = cache_mgr.get_status()["active_backend"]
    return info


def test_db_connection(cfg: Dict[str, Any]) -> Dict[str, Any]:
    db_type, url, meta = build_sqlalchemy_url(cfg)
    t0 = time.perf_counter()
    test_engine = None
    try:
        test_engine = _create_orm_engine(db_type, url)
        with test_engine.connect() as conn:
            if db_type == "mysql":
                ver = conn.execute(text("SELECT VERSION()")).scalar()
            else:
                ver = conn.execute(text("SELECT sqlite_version()")).scalar()
        lat = round((time.perf_counter() - t0) * 1000, 2)
        return {
            "ok": True,
            "db_type": db_type,
            "version": str(ver),
            "latency_ms": lat,
            "message": f"{db_type.upper()} 连接成功 (v{ver}, {lat}ms)",
        }
    except Exception as exc:
        return {
            "ok": False,
            "db_type": db_type,
            "detail": f"数据库连接失败: {exc}",
        }
    finally:
        if test_engine is not None:
            try:
                test_engine.dispose()
            except Exception:
                pass


def _ensure_additive_columns(engine):
    """安全补齐历史 SQLite/MySQL 库中新增的字段（兼容旧数据平滑升级）"""
    inspector = inspect(engine)
    dialect = engine.dialect.name
    bigint_sql = "BIGINT DEFAULT 0" if dialect == "mysql" else "INTEGER DEFAULT 0"
    varchar64_sql = "VARCHAR(64)" if dialect == "mysql" else "TEXT"

    if inspector.has_table("nodes"):
        existing_node_cols = {c["name"] for c in inspector.get_columns("nodes")}
        node_patches = [
            ("approval_status", "INTEGER DEFAULT 1"),
            ("conn_type", "VARCHAR(32) DEFAULT 'direct'"),
            ("node_uuid", "VARCHAR(128) DEFAULT ''"),
            ("fingerprint", "VARCHAR(128) DEFAULT ''"),
            ("created_at", "VARCHAR(64) DEFAULT ''"),
            ("enabled", "INTEGER DEFAULT 1"),
            ("group_name", "VARCHAR(128) DEFAULT '默认分组'"),
            ("direct_host", "VARCHAR(255) DEFAULT '127.0.0.1'"),
            ("auto_tunnel", "INTEGER DEFAULT 1"),
            ("cookie_count", "INTEGER DEFAULT 0"),
            ("network_mode", "VARCHAR(64) DEFAULT ''"),
            ("recommended_endpoint", "VARCHAR(255) DEFAULT ''"),
            ("wss_endpoint", "VARCHAR(255) DEFAULT ''"),
            ("edge_wss_secret", "VARCHAR(255) DEFAULT ''"),
            ("ipv4_reachable", "INTEGER DEFAULT 0"),
            ("ipv6_reachable", "INTEGER DEFAULT 0"),
            ("client_type", "VARCHAR(32) DEFAULT 'desktop'"),
            ("api_enabled", "INTEGER DEFAULT 1"),
            ("cdp_rx_bytes", bigint_sql),
            ("cdp_tx_bytes", bigint_sql),
            ("net_rx_bytes", bigint_sql),
            ("net_tx_bytes", bigint_sql),
            ("active_cdp_streams", "INTEGER DEFAULT 0"),
            ("last_metrics_at", f"{varchar64_sql} NULL"),
        ]
        with engine.begin() as conn:
            for col_name, col_def in node_patches:
                if col_name not in existing_node_cols:
                    try:
                        conn.execute(text(f"ALTER TABLE nodes ADD COLUMN {col_name} {col_def}"))
                    except Exception:
                        pass

        # 清理历史遗留的 local_bind_port 显式唯一索引（仅 SQLite）
        if dialect == "sqlite":
            with engine.begin() as conn:
                try:
                    rows = conn.execute(
                        text(
                            "SELECT name FROM sqlite_master WHERE type='index' "
                            "AND tbl_name='nodes' AND sql LIKE '%local_bind_port%'"
                        )
                    ).fetchall()
                    for (idx_name,) in rows:
                        if "autoindex" not in str(idx_name):
                            conn.execute(text(f"DROP INDEX IF EXISTS {idx_name}"))
                except Exception:
                    pass

    if inspector.has_table("sync_logs"):
        existing_log_cols = {c["name"] for c in inspector.get_columns("sync_logs")}
        with engine.begin() as conn:
            for col_name, col_def in [
                ("source_node", "VARCHAR(255) DEFAULT ''"),
                ("target_nodes", "VARCHAR(255) DEFAULT ''"),
                ("cookie_count", "INTEGER DEFAULT 0"),
                ("duration", "VARCHAR(32) DEFAULT ''"),
            ]:
                if col_name not in existing_log_cols:
                    try:
                        conn.execute(text(f"ALTER TABLE sync_logs ADD COLUMN {col_name} {col_def}"))
                    except Exception:
                        pass


def init_db_and_jwt(cfg: Optional[Dict[str, Any]] = None, mark_setup_completed: Optional[bool] = None):
    """
    初始化 ORM 表结构、历史字段热升级与默认全局设置。
    支持在首次安装向导切换 SQLite / MySQL 后热重载调用（管理员账号密码由安装向导创建）。
    """
    engine = init_engine(cfg)
    Base.metadata.create_all(bind=engine)
    _ensure_additive_columns(engine)

    with session_scope() as db:
        policy_count = db.query(SyncPolicy).count()
        if policy_count == 0:
            now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            db.add(
                SyncPolicy(
                    name="默认全网智能双向合并",
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

        has_admin_creds = db.query(Setting).filter(Setting.key == "admin_password").first() is not None
        existing_nodes_count = db.query(Node).count()
        boot = load_bootstrap_config()
        default_setup_flag = "1" if (mark_setup_completed or boot.get("setup_completed") or existing_nodes_count > 0 or has_admin_creds) else "0"

        initial_join_token = "hub_join_" + secrets.token_urlsafe(24)
        defaults = {
            "jwt_secret": secrets.token_hex(32),
            "edge_agent_secret": secrets.token_urlsafe(32),
            "api_key": "cdp_" + secrets.token_urlsafe(24),
            "cluster_join_token": initial_join_token,
            "direct_port_access_enabled": "1",
            "smtp_host": "smtp.yeah.net",
            "smtp_port": "465",
            "smtp_ssl": "1",
            "smtp_sender_name": "CDP 节点中心",
            "smtp_user": "",
            "smtp_pass": "",
            "smtp_status": "untested",
            "email_notify_enabled": "0",
            "email_notify_to": "",
            "serverchan_enabled": "0",
            "serverchan_key": "",
            "tofu_enabled": "1",
            "tofu_auto_approve": "0",
            "tofu_timeout_notify_minutes": "10",
            "sync_diff_enabled": "1",
            "sync_include_domains": "",
            "sync_exclude_domains": "doubleclick.net,google-analytics.com",
            "sync_cleanup_enabled": "0",
            "sync_cleanup_expired": "1",
            "sync_cleanup_domains": "",
            "sync_cleanup_keywords": "",
            "sync_cleanup_keyword_scope": "name_domain",
            "sync_cleanup_expires_before": "",
            "sync_cleanup_expiring_within_days": "0",
            "sync_cleanup_session_only": "0",
            "setup_completed": default_setup_flag,
        }

        existing_keys = {row.key: row for row in db.query(Setting).all()}
        for k, v in defaults.items():
            if k not in existing_keys:
                db.add(Setting(key=k, value=v))
            cache_mgr.delete(f"{SETTINGS_CACHE_PREFIX}{k}")

        if mark_setup_completed is True:
            row = existing_keys.get("setup_completed")
            if row:
                row.value = "1"
            else:
                db.add(Setting(key="setup_completed", value="1"))
            cache_mgr.set(f"{SETTINGS_CACHE_PREFIX}setup_completed", "1", ttl=120)


def is_setup_required() -> bool:
    boot = load_bootstrap_config()
    if boot.get("setup_completed"):
        return False
    return get_setting("setup_completed", "0") != "1"


def get_setting(key: str, default: str = "") -> str:
    cache_key = f"{SETTINGS_CACHE_PREFIX}{key}"
    cached = cache_mgr.get(cache_key)
    if cached is not None:
        return cached

    with session_scope() as db:
        row = db.get(Setting, key)
        if row is not None and row.value is not None:
            cache_mgr.set(cache_key, row.value, ttl=120)
            return row.value
    return default


def set_setting(key: str, value: str):
    str_val = str(value)
    with session_scope() as db:
        row = db.get(Setting, key)
        if row is None:
            db.add(Setting(key=key, value=str_val))
        else:
            row.value = str_val
    cache_mgr.set(f"{SETTINGS_CACHE_PREFIX}{key}", str_val, ttl=120)


def set_settings_batch(items: Dict[str, Any]):
    if not items:
        return
    normalized = {str(k): str(v) for k, v in items.items()}
    with session_scope() as db:
        existing = {
            row.key: row
            for row in db.query(Setting).filter(Setting.key.in_(list(normalized.keys()))).all()
        }
        for k, str_val in normalized.items():
            row = existing.get(k)
            if row is None:
                db.add(Setting(key=k, value=str_val))
            else:
                row.value = str_val
    for k, str_val in normalized.items():
        cache_mgr.set(f"{SETTINGS_CACHE_PREFIX}{k}", str_val, ttl=120)