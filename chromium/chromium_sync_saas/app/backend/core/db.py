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
    SAAS_ALLOW_PUBLIC_REGISTER,
    SAAS_ALLOW_SELF_RECHARGE,
    SAAS_DEFAULT_PLATFORM_FEE_BPS,
    SAAS_WELCOME_BONUS_UNITS,
    logger,
)
from core.cache import cache_mgr
from core.models import Announcement, Base, BillingLedger, Node, Plan, Setting, SyncPolicy, User, UserLevel

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


def _get_thread_active_session() -> Optional[Session]:
    stack = getattr(_active_session_tls, "stack", None)
    if stack:
        return stack[-1]
    return None


@contextmanager
def session_scope():
    session = get_session()
    stack = getattr(_active_session_tls, "stack", None)
    if stack is None:
        stack = []
        _active_session_tls.stack = stack
    stack.append(session)
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        if stack and stack[-1] is session:
            stack.pop()
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


def issue_user_invite_code() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(8))


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
            monthly_price_units=990000,
            max_nodes=25,
            max_active_leases=12,
            max_monthly_traffic_bytes=200 * 1024 * 1024 * 1024,
            platform_fee_discount_bps=500,
            can_share_nodes=1,
            is_default=0,
            description="专业运营套餐：25 个节点配额、12 路并发租用、200 GB 月流量、市场手续费减免 5%",
        ),
        Plan(
            code="enterprise",
            name="Enterprise 集群版",
            monthly_price_units=3990000,
            max_nodes=200,
            max_active_leases=64,
            max_monthly_traffic_bytes=2 * 1024 * 1024 * 1024 * 1024,
            platform_fee_discount_bps=1000,
            can_share_nodes=1,
            is_default=0,
            description="企业大规模集群：200 节点上限、64 路并发市场租用、2 TB 月流量、手续费减免 10%",
        ),
    ]
    for p in plans:
        db.add(p)
    db.flush()


def _seed_default_user_levels(db: Session):
    if db.query(UserLevel).count() > 0:
        return
    levels = [
        UserLevel(
            code="lv1",
            name="Lv.1 青铜节点主",
            rank_order=1,
            badge_color="#94a3b8",
            min_online_hours=0,
            min_contributed_gb=0,
            max_avg_latency_ms=0,
            min_speed_kbps=0,
            reverse_fee_bps=2800,
            public_wss_fee_bps=1200,
            buyer_discount_bps=0,
            description="入门基础等级，新注册默认归属；WSS 反穿差价较高，公网 WSS 直连更优惠",
        ),
        UserLevel(
            code="lv2",
            name="Lv.2 白银节点主",
            rank_order=2,
            badge_color="#38bdf8",
            min_online_hours=12,
            min_contributed_gb=1,
            max_avg_latency_ms=450,
            min_speed_kbps=50,
            reverse_fee_bps=2400,
            public_wss_fee_bps=1000,
            buyer_discount_bps=200,
            description="累计在线 >=12h、贡献流量 >=1GB 且节点延迟 <=450ms / 速度 >=50KB/s",
        ),
        UserLevel(
            code="lv3",
            name="Lv.3 黄金节点主",
            rank_order=3,
            badge_color="#f59e0b",
            min_online_hours=72,
            min_contributed_gb=10,
            max_avg_latency_ms=200,
            min_speed_kbps=200,
            reverse_fee_bps=1900,
            public_wss_fee_bps=700,
            buyer_discount_bps=400,
            description="累计在线 >=72h、贡献流量 >=10GB 且节点延迟 <=200ms / 速度 >=200KB/s",
        ),
        UserLevel(
            code="lv4",
            name="Lv.4 钻石超级节点",
            rank_order=4,
            badge_color="#34d399",
            min_online_hours=240,
            min_contributed_gb=50,
            max_avg_latency_ms=100,
            min_speed_kbps=500,
            reverse_fee_bps=1400,
            public_wss_fee_bps=400,
            buyer_discount_bps=600,
            description="累计在线 >=240h、贡献流量 >=50GB 且节点延迟 <=100ms / 速度 >=500KB/s；若速率退化将自动降级",
        ),
    ]
    for lv in levels:
        db.add(lv)
    db.flush()


def _seed_default_announcement(db: Session):
    if db.query(Announcement).count() > 0:
        return
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    db.add(
        Announcement(
            title="欢迎使用 Chromium Sync SaaS 多租户云控平台",
            content="平台支持公网 WSS 直连与 WSS 反向穿透接入，开启推荐邀请奖励与邮箱安全认证。管理员可在后台随时发布、置顶或编辑系统公告。",
            level="info",
            is_pinned=1,
            is_active=1,
            show_on_auth=1,
            author_username="system",
            created_at=now_str,
            updated_at=now_str,
        )
    )
    db.flush()


def _ensure_schema_migrations(engine):
    """兼容已有 SQLite/MySQL 库平滑补齐新增字段"""
    inspector = inspect(engine)
    pending_alters = {
        "users": {
            "email_verified": "INTEGER NOT NULL DEFAULT 0",
            "invite_code": "VARCHAR(32) DEFAULT ''",
            "invited_by_id": "INTEGER NULL",
            "level_id": "INTEGER NOT NULL DEFAULT 1",
            "level_locked": "INTEGER NOT NULL DEFAULT 0",
            "total_online_seconds": "BIGINT NOT NULL DEFAULT 0",
            "avg_node_latency_ms": "INTEGER NOT NULL DEFAULT 0",
            "avg_node_speed_kbps": "INTEGER NOT NULL DEFAULT 0",
            "contributed_traffic_bytes": "BIGINT NOT NULL DEFAULT 0",
            "level_score": "INTEGER NOT NULL DEFAULT 0",
            "level_evaluated_at": "VARCHAR(64) DEFAULT ''",
            "last_level_change_reason": "VARCHAR(255) DEFAULT ''",
            "self_reverse_billed_bytes": "BIGINT NOT NULL DEFAULT 0",
            "self_reverse_billed_units": "BIGINT NOT NULL DEFAULT 0",
            "last_checkin_date": "VARCHAR(16) DEFAULT ''",
            "checkin_streak": "INTEGER NOT NULL DEFAULT 0",
            "last_monthly_claim_ym": "VARCHAR(16) DEFAULT ''",
        },
        "nodes": {
            "last_ip": "VARCHAR(64) DEFAULT ''",
            "avg_latency_ms": "INTEGER DEFAULT 0",
            "avg_speed_kbps": "INTEGER DEFAULT 0",
            "online_seconds": "BIGINT DEFAULT 0",
            "last_online_tick_at": "VARCHAR(64) DEFAULT ''",
        },
        "node_leases": {
            "channel_type": "VARCHAR(32) NOT NULL DEFAULT 'reverse'",
            "seller_level_code": "VARCHAR(32) NOT NULL DEFAULT 'lv1'",
        },
    }
    existing_tables = set(inspector.get_table_names())
    existing_cols_by_table = {
        tbl: {c["name"] for c in inspector.get_columns(tbl)}
        for tbl in pending_alters
        if tbl in existing_tables
    }
    with engine.begin() as conn:
        for tbl, cols in pending_alters.items():
            if tbl not in existing_tables:
                continue
            existing_cols = existing_cols_by_table.get(tbl, set())
            for col_name, col_def in cols.items():
                if col_name not in existing_cols:
                    try:
                        conn.execute(text(f"ALTER TABLE {tbl} ADD COLUMN {col_name} {col_def}"))
                    except Exception as exc:
                        logger.debug(f"迁移字段 {tbl}.{col_name} 跳过: {exc}")
        if "nodes" in existing_tables:
            try:
                conn.execute(
                    text(
                        "UPDATE nodes SET enabled=0, share_enabled=0, status='disabled_legacy' "
                        "WHERE conn_type NOT IN ('reverse', 'public_wss', 'wss_direct')"
                    )
                )
            except Exception as exc:
                logger.debug(f"下线历史直连/SSH节点跳过: {exc}")
        if "recharge_orders" in existing_tables and engine.dialect.name != "sqlite":
            for col_name in ("pay_url", "qr_code_text"):
                try:
                    conn.execute(text(f"ALTER TABLE recharge_orders MODIFY COLUMN {col_name} TEXT"))
                except Exception as exc:
                    logger.debug(f"扩展 recharge_orders.{col_name} 为 TEXT 跳过: {exc}")


def _backfill_user_invite_codes(db: Session):
    missing = db.query(User).filter((User.invite_code.is_(None)) | (User.invite_code == "")).all()
    if not missing:
        return
    used = {r[0] for r in db.query(User.invite_code).filter(User.invite_code.isnot(None), User.invite_code != "").all()}
    for u in missing:
        code = issue_user_invite_code()
        while code in used:
            code = issue_user_invite_code()
        used.add(code)
        u.invite_code = code
    db.flush()


def create_or_update_initial_admin(db: Session, username: str, raw_password: str, admin_email: Optional[str] = None) -> User:
    from core.security import hash_password

    default_plan = db.query(Plan).filter(Plan.is_default == 1).first() or db.query(Plan).order_by(Plan.id.asc()).first()
    ent_plan = db.query(Plan).filter(Plan.code == "enterprise").first() or default_plan
    default_plan_id = ent_plan.id if ent_plan else 1
    default_level = db.query(UserLevel).order_by(UserLevel.rank_order.asc()).first()
    default_level_id = default_level.id if default_level else 1
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    clean_email = (admin_email or "").strip().lower() or f"{username}@local.saas"

    admin_user = db.query(User).filter(User.role == "admin").order_by(User.id.asc()).first()
    if admin_user is not None:
        admin_user.username = username
        admin_user.password_hash = hash_password(raw_password)
        if admin_email and "@" in clean_email:
            admin_user.email = clean_email
        admin_user.email_verified = 1
        if not admin_user.invite_code:
            admin_user.invite_code = issue_user_invite_code()
        db.flush()
        return admin_user

    admin_user = User(
        username=username,
        email=clean_email,
        email_verified=1,
        password_hash=hash_password(raw_password),
        role="admin",
        status="active",
        plan_id=default_plan_id,
        level_id=default_level_id,
        invite_code=issue_user_invite_code(),
        balance_units=1000000,
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
    db.flush()
    return admin_user


def init_db_and_jwt(cfg: Optional[Dict[str, Any]] = None, mark_setup_completed: Optional[bool] = None):
    engine = init_engine(cfg)
    Base.metadata.create_all(bind=engine)
    _ensure_schema_migrations(engine)

    with session_scope() as db:
        _seed_default_plans(db)
        _seed_default_user_levels(db)
        _seed_default_announcement(db)
        _backfill_user_invite_codes(db)

        existing_admin_exists = db.query(User.id).filter(User.role == "admin").first() is not None
        existing_nodes_count = db.query(Node).count()
        boot = load_bootstrap_config()
        default_setup_flag = "1" if (mark_setup_completed or boot.get("setup_completed") or existing_nodes_count > 0 or existing_admin_exists) else "0"

        defaults = {
            "jwt_secret": secrets.token_hex(32),
            "edge_agent_secret": secrets.token_urlsafe(32),
            "saas_allow_public_register": "1" if SAAS_ALLOW_PUBLIC_REGISTER else "0",
            "saas_require_email_verify": "1",
            "saas_referral_enabled": "1",
            "saas_referral_inviter_bonus_units": "50000",
            "saas_referral_invitee_bonus_units": "30000",
            "saas_allow_self_recharge": "1" if SAAS_ALLOW_SELF_RECHARGE else "0",
            "saas_platform_fee_bps": str(SAAS_DEFAULT_PLATFORM_FEE_BPS),
            "saas_reverse_fee_bps": "2500",
            "saas_public_wss_fee_bps": "1000",
            "saas_market_base_hour_units": "5000",
            "saas_market_base_gb_units": "10000",
            "saas_self_reverse_hub_gb_units": "2000",
            "saas_auto_level_enabled": "1",
            "saas_welcome_bonus_units": str(SAAS_WELCOME_BONUS_UNITS),
            "saas_monthly_claim_enabled": "1",
            "saas_monthly_claim_units": "100000",
            "saas_daily_checkin_enabled": "1",
            "saas_daily_checkin_units": "5000",
            "saas_daily_streak_bonus_units": "1000",
            "saas_alipay_enabled": "1",
            "saas_alipay_mode": "precreate",
            "saas_alipay_sign_mode": "public_key",
            "saas_alipay_f2f_enabled": "1",
            "saas_alipay_page_enabled": "1",
            "saas_alipay_static_enabled": "0",
            "saas_alipay_app_id": "",
            "saas_alipay_private_key": "",
            "saas_alipay_public_key": "",
            "saas_alipay_app_cert": "",
            "saas_alipay_cert_public_key": "",
            "saas_alipay_root_cert": "",
            "saas_alipay_gateway_url": "https://openapi.alipay.com/gateway.do",
            "saas_alipay_notify_url": "",
            "saas_alipay_return_url": "",
            "saas_alipay_qr_url": "",
            "saas_wechat_enabled": "1",
            "saas_wechat_mode": "native_v3",
            "saas_wechat_native_enabled": "1",
            "saas_wechat_static_enabled": "0",
            "saas_wechat_app_id": "",
            "saas_wechat_mch_id": "",
            "saas_wechat_serial_no": "",
            "saas_wechat_private_key": "",
            "saas_wechat_api_v3_key": "",
            "saas_wechat_platform_public_key": "",
            "saas_wechat_gateway_url": "https://api.mch.weixin.qq.com",
            "saas_wechat_notify_url": "",
            "saas_wechat_qr_url": "",
            "saas_payment_notify_secret": secrets.token_urlsafe(24),
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
            "webhook_enabled": "0",
            "webhook_url": "",
            "webhook_secret": "",
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
                actual_val = v
            else:
                actual_val = existing_keys[k].value
            cache_mgr.set(f"{SETTINGS_CACHE_PREFIX}{k}", str(actual_val), ttl=120)

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

    active_sess = _get_thread_active_session()
    if active_sess is not None:
        row = active_sess.get(Setting, key)
        if row is not None and row.value is not None:
            cache_mgr.set(cache_key, row.value, ttl=120)
            return row.value
        return default

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
