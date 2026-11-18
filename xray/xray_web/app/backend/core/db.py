# -*- coding: utf-8 -*-
"""
SQLAlchemy 2.0 统一数据库引擎抽象层（全面兼容 SQLite WAL 与 MySQL InnoDB）
支持：
- 多 Worker 进程热感知 /data/hub_config.json 变更并自动重建连接池
- SQLite 自动启用 WAL + busy_timeout=30000 + temp_store=MEMORY
- MySQL 自动启用连接池 (pool_pre_ping=True, pool_recycle=1800, utf8mb4)
- 幂等建表与历史表结构平滑升级
"""
import datetime
import fcntl
import hashlib
import os
import secrets
import threading
import time
import uuid
from contextlib import contextmanager
from typing import Optional

from sqlalchemy import create_engine, event, func, inspect, select, text
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import sessionmaker

from config import Config
from core.models import (
    Base,
    KvCache,
    Node,
    SystemSetting,
    User,
)

_engine_lock = threading.Lock()
_engine = None
_engine_url: str = ""
_SessionLocal = None


def hash_pwd(pwd: str) -> str:
    return hashlib.sha256(pwd.encode("utf-8")).hexdigest()


def _create_sqlalchemy_engine(db_url: str):
    is_sqlite = db_url.lower().startswith("sqlite")
    if is_sqlite:
        if db_url.startswith("sqlite:///") and not db_url.startswith("sqlite:///:memory:"):
            file_part = db_url[len("sqlite:///"):]
            parent = os.path.dirname(file_part)
            if parent:
                os.makedirs(parent, exist_ok=True)
        eng = create_engine(
            db_url,
            connect_args={"timeout": 30.0, "check_same_thread": False},
            pool_pre_ping=True,
            future=True,
        )

        @event.listens_for(eng, "connect")
        def _set_sqlite_pragmas(dbapi_conn, _conn_record):
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA busy_timeout=30000;")
            cur.execute("PRAGMA synchronous=NORMAL;")
            cur.execute("PRAGMA temp_store=MEMORY;")
            cur.close()

        try:
            with eng.connect() as conn:
                conn.execute(text("PRAGMA journal_mode=WAL;"))
        except Exception:
            pass

        return eng

    # MySQL / MariaDB 生产连接池（支持环境变量调优）
    return create_engine(
        db_url,
        pool_pre_ping=True,
        pool_recycle=1800,
        pool_size=max(5, Config.DB_POOL_SIZE),
        max_overflow=max(10, Config.DB_MAX_OVERFLOW),
        pool_timeout=max(5, Config.DB_POOL_TIMEOUT),
        connect_args={"connect_timeout": 8},
        future=True,
    )


def get_engine(force_reload: bool = False):
    global _engine, _engine_url, _SessionLocal
    Config.reload_if_changed()
    target_url = Config.effective_database_url()

    if not force_reload and _engine is not None and _engine_url == target_url:
        return _engine

    with _engine_lock:
        Config.reload_if_changed()
        target_url = Config.effective_database_url()
        if not force_reload and _engine is not None and _engine_url == target_url:
            return _engine
        old_engine = _engine
        _engine = _create_sqlalchemy_engine(target_url)
        _engine_url = target_url
        _SessionLocal = sessionmaker(
            bind=_engine,
            autocommit=False,
            autoflush=False,
            expire_on_commit=False,
            future=True,
        )
        if old_engine is not None:
            try:
                old_engine.dispose()
            except Exception:
                pass
        return _engine


def reset_engine():
    get_engine(force_reload=True)


@contextmanager
def db_session(readonly: bool = False):
    """统一事务会话管理器：自动 commit / rollback / close（readonly=True 时跳过无效 commit）"""
    get_engine()
    session = _SessionLocal()
    try:
        yield session
        if readonly:
            session.rollback()
        else:
            session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def current_dialect() -> str:
    eng = get_engine()
    return eng.dialect.name.lower()


def random_order_expr():
    if current_dialect() == "mysql":
        return func.rand()
    return func.random()


def upsert_system_setting(session, key: str, value: str):
    bind = session.get_bind()
    dialect = bind.dialect.name.lower() if bind else current_dialect()
    if dialect == "mysql":
        stmt = mysql_insert(SystemSetting).values(key=key, value=value)
        stmt = stmt.on_duplicate_key_update(value=stmt.inserted.value)
    else:
        stmt = sqlite_insert(SystemSetting).values(key=key, value=value)
        stmt = stmt.on_conflict_do_update(index_elements=["key"], set_={"value": stmt.excluded.value})
    session.execute(stmt)


def upsert_kv_cache(session, cache_key: str, cache_val: str, expire_at: float):
    bind = session.get_bind()
    dialect = bind.dialect.name.lower() if bind else current_dialect()
    if dialect == "mysql":
        stmt = mysql_insert(KvCache).values(
            cache_key=cache_key, cache_val=cache_val, expire_at=expire_at
        )
        stmt = stmt.on_duplicate_key_update(
            cache_val=stmt.inserted.cache_val,
            expire_at=stmt.inserted.expire_at,
        )
    else:
        stmt = sqlite_insert(KvCache).values(
            cache_key=cache_key, cache_val=cache_val, expire_at=expire_at
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=["cache_key"],
            set_={
                "cache_val": stmt.excluded.cache_val,
                "expire_at": stmt.excluded.expire_at,
            },
        )
    session.execute(stmt)


def test_database_connection(db_url: str) -> tuple[bool, str]:
    """供首次安装向导验证 SQLite / MySQL 连通性"""
    eng = None
    try:
        eng = _create_sqlalchemy_engine(db_url)
        with eng.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True, "数据库连接测试通过"
    except Exception as exc:
        return False, f"数据库连接失败: {exc}"
    finally:
        if eng is not None:
            try:
                eng.dispose()
            except Exception:
                pass


def _upgrade_legacy_columns(eng):
    """兼容历史旧库平滑补全字段（幂等）"""
    insp = inspect(eng)
    dialect = eng.dialect.name.lower()

    def ensure_cols(table_name: str, expected_cols: list[tuple[str, str]]):
        if not insp.has_table(table_name):
            return
        existing = {col["name"] for col in insp.get_columns(table_name)}
        with eng.begin() as conn:
            for col_name, col_ddl in expected_cols:
                if col_name not in existing:
                    try:
                        conn.execute(text(f"ALTER TABLE {table_name} ADD COLUMN {col_name} {col_ddl}"))
                    except Exception:
                        pass

    text_default = "" if dialect == "mysql" else " DEFAULT ''"
    ensure_cols(
        "nodes",
        [
            ("node_key", "VARCHAR(128) DEFAULT ''"),
            ("pending_key", "VARCHAR(128) DEFAULT ''"),
            ("dest", "VARCHAR(255) DEFAULT 'www.microsoft.com:443'"),
            ("server_names", f"TEXT{text_default}"),
            ("allow_all", "INTEGER DEFAULT 1"),
            ("allowed_groups", f"TEXT{text_default}"),
            ("allowed_users", f"TEXT{text_default}"),
            ("is_approved", "INTEGER DEFAULT 1"),
            ("node_public_key", "VARCHAR(255) DEFAULT ''"),
            ("key_lock_status", "VARCHAR(32) DEFAULT 'unlocked'"),
            ("last_challenge_nonce", "VARCHAR(128) DEFAULT ''"),
            ("last_nonce_created_at", "FLOAT DEFAULT 0"),
            ("net_mode", "VARCHAR(32) DEFAULT 'direct'"),
            ("tunnel_uuid", "VARCHAR(64) DEFAULT ''"),
            ("tunnel_status", "VARCHAR(64) DEFAULT 'disconnected'"),
        ],
    )
    ensure_cols(
        "users",
        [
            ("user_group", "VARCHAR(64) DEFAULT 'default'"),
            ("referral_code", "VARCHAR(64) DEFAULT ''"),
            ("invited_by", "VARCHAR(128) DEFAULT ''"),
            ("referral_count", "INTEGER DEFAULT 0"),
            ("referral_bonus_gb", "FLOAT DEFAULT 0"),
            ("referral_bonus_days", "INTEGER DEFAULT 0"),
        ],
    )
    ensure_cols("captchas", [("created_at", "FLOAT DEFAULT 0")])


@contextmanager
def _init_db_lock():
    """跨 Granian 多 Worker 进程初始化排他锁，杜绝并发建表与初始种子竞争"""
    lock_candidates = []
    db_dir = os.path.dirname(os.path.abspath(Config.DB_PATH)) if Config.DB_PATH else ""
    if db_dir:
        lock_candidates.append(os.path.join(db_dir, ".init_db.lock"))
    lock_candidates.append("/tmp/.xray_web_init_db.lock")

    lock_fd = None
    for path in lock_candidates:
        try:
            parent = os.path.dirname(path)
            if parent:
                os.makedirs(parent, exist_ok=True)
            lock_fd = open(path, "a+")
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            break
        except OSError:
            if lock_fd is not None:
                try:
                    lock_fd.close()
                except Exception:
                    pass
                lock_fd = None
    try:
        yield
    finally:
        if lock_fd is not None:
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
            except Exception:
                pass
            try:
                lock_fd.close()
            except Exception:
                pass


def _safe_create_all(eng):
    """幂等建表：先整体尝试，若遇跨节点/进程并发建表冲突则逐表安全兜底"""
    try:
        Base.metadata.create_all(eng, checkfirst=True)
    except OperationalError as exc:
        if "already exists" not in str(exc).lower():
            raise
        for table in Base.metadata.sorted_tables:
            try:
                table.create(eng, checkfirst=True)
            except OperationalError as t_exc:
                if "already exists" not in str(t_exc).lower():
                    raise


def init_db(force_reload: bool = False):
    with _init_db_lock():
        eng = get_engine(force_reload=force_reload)
        _safe_create_all(eng)
        _upgrade_legacy_columns(eng)

        with db_session() as s:
            defaults = {
                "tofu_enabled": "true",
                "cluster_token": "ctk_" + secrets.token_hex(16),
                "node_auto_approve": "true",
                "crypto_key_lock_enforced": "true",
                "referral_enabled": "true",
                "referral_inviter_traffic_gb": "10",
                "referral_inviter_days": "30",
                "referral_invitee_traffic_gb": "5",
                "referral_invitee_days": "30",
                "referral_max_per_user": "50",
            }
            for k, v in defaults.items():
                exists = s.get(SystemSetting, k)
                if not exists:
                    s.add(SystemSetting(key=k, value=v))

            # 初始管理员账号
            admin_exists = s.scalar(select(User.id).where(User.role == "admin").limit(1))
            if not admin_exists:
                admin_user = os.getenv("ADMIN_USERNAME") or "admin"
                admin_pwd = os.getenv("ADMIN_PASSWORD") or secrets.token_urlsafe(12)
                ten_years = (datetime.datetime.now() + datetime.timedelta(days=3650)).strftime("%Y-%m-%d %H:%M:%S")
                s.add(
                    User(
                        username=admin_user,
                        password_hash=hash_pwd(admin_pwd),
                        uuid=str(uuid.uuid4()),
                        email=f"{admin_user}@system.local",
                        traffic_limit_mb=1048576,
                        used_mb=0.0,
                        expire_date=ten_years,
                        role="admin",
                        status=1,
                        is_verified=1,
                        user_group="admin",
                    )
                )
                s.flush()

            # 首次安装向导标记判定：若已有配置文件或老集群已有节点/多个用户，自动标记已完成，避免老系统升级被锁
            setup_row = s.get(SystemSetting, "setup_completed")
            if Config.SETUP_COMPLETED:
                upsert_system_setting(s, "setup_completed", "true")
            elif not setup_row:
                nodes_cnt = s.scalar(select(func.count()).select_from(Node)) or 0
                users_cnt = s.scalar(select(func.count()).select_from(User)) or 0
                auto_skip = os.getenv("AUTO_SKIP_SETUP", "").lower() in ("1", "true", "yes")
                if auto_skip or nodes_cnt > 0 or users_cnt > 1:
                    s.add(SystemSetting(key="setup_completed", value="true"))
                else:
                    s.add(SystemSetting(key="setup_completed", value="false"))


def is_setup_required() -> bool:
    Config.reload_if_changed()
    if Config.SETUP_COMPLETED:
        return False
    return get_setting("setup_completed", "false").lower() != "true"


def get_setting(key: str, default: str = "") -> str:
    from core.cache import cache

    cache_key = f"setting:{key}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    val = None
    with db_session(readonly=True) as s:
        row = s.get(SystemSetting, key)
        if row is not None and row.value is not None:
            val = str(row.value)

    if val is not None:
        cache.set(cache_key, val, ttl=300)
        return val
    return default


def set_setting(key: str, value: str):
    from core.cache import cache

    with db_session() as s:
        upsert_system_setting(s, key, str(value))
    cache.set(f"setting:{key}", str(value), ttl=300)


def get_cached_active_users() -> list[dict]:
    from core.cache import cache

    def _load():
        with db_session(readonly=True) as s:
            rows = s.execute(
                select(User.username, User.email, User.uuid, User.user_group, User.role).where(
                    User.status == 1, User.is_verified == 1
                )
            ).all()
            return [
                {
                    "username": r.username,
                    "email": r.email,
                    "uuid": r.uuid,
                    "user_group": r.user_group,
                    "role": r.role,
                }
                for r in rows
            ]

    return cache.get_or_set_json("cluster:active_users", _load, ttl=30)


def invalidate_users_cache():
    from core.cache import cache
    cache.delete("cluster:active_users")


def get_cached_nodes() -> list[dict]:
    from core.cache import cache

    def _load():
        with db_session(readonly=True) as s:
            rows = s.scalars(select(Node).order_by(Node.id.asc())).all()
            return [n.to_dict() for n in rows]

    return cache.get_or_set_json("cluster:nodes", _load, ttl=30)


def invalidate_nodes_cache():
    from core.cache import cache
    cache.delete("cluster:nodes")