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
    INIT_PASSWORD,
    INIT_USERNAME,
    SAAS_ALLOW_PUBLIC_REGISTER,
    SAAS_ALLOW_SELF_RECHARGE,
    SAAS_DEFAULT_PLATFORM_FEE_BPS,
    SAAS_WELCOME_BONUS_UNITS,
    SKIP_SETUP_WIZARD,
    logger,
)
from core.cache import cache_mgr
from core.models import Base, BillingLedger, Bookmark, Node, Plan, Setting, SyncPolicy, User

_engine_lock = threading.Lock()
_engine = None
_SessionLocal = None
_active_db_config: Dict[str, Any] = {}

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
        return create_engine(
            url,
            pool_pre_ping=True,
            pool_recycle=1800,
            pool_size=12,
            max_overflow=24,
            connect_args={"connect_timeout": 5},
        )

    engine = create_engine(
        url,
        connect_args={"check_same_thread": False, "timeout": 15.0},
        pool_pre_ping=True,
    )

    @event.listens_for(engine, "connect")
    def _set_sqlite_pragma(dbapi_conn, _connection_record):
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
        logger.info(f"🗄️ [SaaS ORM] 数据库引擎已就绪: {db_type.upper()}")
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
    session = get_session()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_active_db_info() -> Dict[str, Any]:
    if not _active_db_config:
        get_engine()
    info = dict(_active_db_config)
    info["cache_backend"] = cache_mgr.get_status()["active_backend"]
    return info


def test_db_connection(cfg: Dict[str, Any]) -> Dict[str, Any]:
    db_type, url, _ = build_sqlalchemy_url(cfg)
    t0 = time.perf_counter()
    test_engine = None
    try:
        test_engine = _create_orm_engine(db_type, url)
        with test_engine.connect() as conn:
            ver = conn.execute(text("SELECT VERSION()" if db_type == "mysql" else "SELECT sqlite_version()")).scalar()
        lat = round((time.perf_counter() - t0) * 1000, 2)
        return {"ok": True, "db_type": db_type, "version": str(ver), "latency_ms": lat, "message": f"{db_type.upper()} 连接成功 (v{ver}, {lat}ms)"}
    except Exception as exc:
        return {"ok": False, "db_type": db_type, "detail": f"数据库连接失败: {exc}"}
    finally:
        if test_engine is not None:
            try:
                test_engine.dispose()
            except Exception:
                pass


def issue_user_api_key() -> str:
    return "cdp_u_" + secrets.token_urlsafe(24)


def issue_user_join_token() -> str:
    return "hub_u_" + secrets.token_urlsafe(24)


def _seed_default_plans(db: Session):
    if db.query(Plan).count() > 0:
        return
    plans = [
        Plan(
            code="free",
            name="Starter 体验版",
            monthly_price_units=0,
            max_nodes=3,
            max_active_leases=2,
            max_monthly_traffic_bytes=10 * 1024 * 1024 * 1024,
            platform_fee_discount_bps=0,
            can_share_nodes=1,
            is_default=1,
            description="免费入门套餐：支持接入 3 个自有节点、同时租用 2 个市场节点、月流量 10 GB",
        ),
        Plan(
            code="pro",
            name="Pro 专业租户版",
            monthly_price_units=990000,  # 99.00 元/月
            max_nodes=25,
            max_active_leases=12,
            max_monthly_traffic_bytes=200 * 1024 * 1024 * 1024,
            platform_fee_discount_bps=500,  # 市场租用加价减免 5%
            can_share_nodes=1,
            is_default=0,
            description="专业运营套餐：25 个节点配额、12 路并发租用、200 GB 月流量、市场手续费减免 5%",
        ),
        Plan(
            code="enterprise",
            name="Enterprise 集群版",
            monthly_price_units=3990000,  # 399.00 元/月
            max_nodes=200,
            max_active_leases=64,
            max_monthly_traffic_bytes=2 * 1024 * 1024 * 1024 * 1024,
            platform_fee_discount_bps=1000,  # 市场租用加价减免 10%
            can_share_nodes=1,
            is_default=0,
            description="企业大规模集群：200 节点上限、64 路并发市场租用、2 TB 月流量、手续费减免 10%",
        ),
    ]
    for p in plans:
        db.add(p)
    db.flush()


def init_db_and_jwt(cfg: Optional[Dict[str, Any]] = None, mark_setup_completed: Optional[bool] = None):
    from core.security import hash_password

    engine = init_engine(cfg)
    Base.metadata.create_all(bind=engine)

    # 验证是否已有任何历史用户，决定向导初始状态
    with session_scope() as db:
        _seed_default_plans(db)
        default_plan = db.query(Plan).filter(Plan.is_default == 1).first() or db.query(Plan).order_by(Plan.id.asc()).first()
        ent_plan = db.query(Plan).filter(Plan.code == "enterprise").first() or default_plan
        default_plan_id = ent_plan.id if ent_plan else 1

        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        admin_user = db.query(User).filter(User.role == "admin").order_by(User.id.asc()).first()
        if admin_user is None:
            admin_user = User(
                username=INIT_USERNAME,
                email=f"{INIT_USERNAME}@local.saas",
                password_hash=hash_password(INIT_PASSWORD),
                role="admin",
                status="active",
                plan_id=default_plan_id,
                balance_units=1000000,  # 初始运营管理员测试钱包 100.00 元
                total_recharged_units=1000000,
                api_key=issue_user_api_key(),
                cluster_join_token=issue_user_join_token(),
                created_at=now_str,
            )
            db.add(admin_user)
            db.flush()
            db.add(
                BillingLedger(
                    user_id=admin_user.id,
                    tx_type="welcome_bonus",
                    amount_units=1000000,
                    balance_after_units=1000000,
                    platform_spread_units=0,
                    remark="SaaS 平台管理员初始化授信余额",
                    created_at=now_str,
                )
            )
            db.add(
                SyncPolicy(
                    owner_id=admin_user.id,
                    name="我的自有节点智能双向合并",
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

        existing_nodes_count = db.query(Node).count()
        boot = load_bootstrap_config()
        default_setup_flag = "1" if (mark_setup_completed or SKIP_SETUP_WIZARD or boot.get("setup_completed") or existing_nodes_count > 0) else "0"

        defaults = {
            "jwt_secret": secrets.token_hex(32),
            "edge_agent_secret": secrets.token_urlsafe(32),
            "saas_allow_public_register": "1" if SAAS_ALLOW_PUBLIC_REGISTER else "0",
            "saas_allow_self_recharge": "1" if SAAS_ALLOW_SELF_RECHARGE else "0",
            "saas_platform_fee_bps": str(SAAS_DEFAULT_PLATFORM_FEE_BPS),
            "saas_welcome_bonus_units": str(SAAS_WELCOME_BONUS_UNITS),
            "smtp_host": "smtp.yeah.net",
            "smtp_port": "465",
            "smtp_ssl": "1",
            "smtp_sender_name": "Wimotek SaaS Hub",
            "smtp_user": "",
            "smtp_pass": "",
            "smtp_status": "untested",
            "email_notify_enabled": "0",
            "email_notify_to": "",
            "serverchan_enabled": "0",
            "serverchan_key": "",
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
    if SKIP_SETUP_WIZARD:
        return False
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


def get_user_setting(user_id: int, key: str, default: Optional[str] = None) -> str:
    scoped = get_setting(f"u:{int(user_id)}:{key}", "__UNSET__")
    if scoped != "__UNSET__":
        return scoped
    if default is not None:
        return default
    return get_setting(key, "")


def set_user_setting(user_id: int, key: str, value: str):
    set_setting(f"u:{int(user_id)}:{key}", value)
