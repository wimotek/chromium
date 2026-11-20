# -*- coding: utf-8 -*-
"""
SQLAlchemy 2.0 统一数据模型（兼容 SQLite 与 MySQL 8.0 / MariaDB InnoDB utf8mb4）
"""
from datetime import datetime
from sqlalchemy import (
    Column,
    DateTime,
    Float,
    Index,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.orm import declarative_base

Base = declarative_base()


class DictMixin:
    def to_dict(self) -> dict:
        out = {}
        for col in self.__table__.columns:
            val = getattr(self, col.name)
            if isinstance(val, datetime):
                out[col.name] = val.strftime("%Y-%m-%d %H:%M:%S")
            else:
                out[col.name] = val
        return out


class User(Base, DictMixin):
    __tablename__ = "users"
    __table_args__ = (
        Index("idx_users_uuid", "uuid"),
        Index("idx_users_active", "status", "is_verified"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(128), unique=True, nullable=False)
    password_hash = Column(String(128), nullable=False)
    uuid = Column(String(64), nullable=False)
    email = Column(String(191), unique=True, nullable=False)
    traffic_limit_mb = Column(Integer, default=1024, nullable=False)
    used_mb = Column(Float, default=0.0, nullable=False)
    expire_date = Column(String(32), nullable=False)
    role = Column(String(32), default="user", nullable=False)
    status = Column(Integer, default=1, nullable=False)
    is_verified = Column(Integer, default=0, nullable=False)
    serverchan_key = Column(String(255), default="", nullable=False)
    notify_type = Column(String(32), default="email", nullable=False)
    is_monthly = Column(Integer, default=0, nullable=False)
    reset_day = Column(Integer, default=1, nullable=False)
    user_group = Column(String(64), default="default", nullable=False)
    referral_code = Column(String(64), default="", nullable=False)
    invited_by = Column(String(128), default="", nullable=False)
    referral_count = Column(Integer, default=0, nullable=False)
    referral_bonus_gb = Column(Float, default=0.0, nullable=False)
    referral_bonus_days = Column(Integer, default=0, nullable=False)


class Node(Base, DictMixin):
    __tablename__ = "nodes"
    __table_args__ = (
        Index("idx_nodes_node_id", "node_id"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    node_id = Column(String(128), unique=True, nullable=False)
    node_key = Column(String(128), default="", nullable=False)
    pending_key = Column(String(128), default="", nullable=False)
    name = Column(String(191), nullable=False)
    ip = Column(String(128), nullable=False)
    port = Column(Integer, nullable=False)
    dest = Column(String(255), default="www.microsoft.com:443", nullable=False)
    sni = Column(String(255), nullable=False)
    server_names = Column(Text, default="", nullable=False)
    pbk = Column(String(128), default="", nullable=False)
    sid = Column(String(64), default="", nullable=False)
    status = Column(Integer, default=1, nullable=False)
    last_heartbeat = Column(String(64), nullable=False)
    allow_all = Column(Integer, default=1, nullable=False)
    allowed_groups = Column(Text, default="", nullable=False)
    allowed_users = Column(Text, default="", nullable=False)
    is_approved = Column(Integer, default=1, nullable=False)
    node_public_key = Column(String(255), default="", nullable=False)
    key_lock_status = Column(String(32), default="unlocked", nullable=False)
    last_challenge_nonce = Column(String(128), default="", nullable=False)
    last_nonce_created_at = Column(Float, default=0.0, nullable=False)
    net_mode = Column(String(32), default="direct", nullable=False)
    tunnel_uuid = Column(String(64), default="", nullable=False)
    tunnel_status = Column(String(64), default="disconnected", nullable=False)
    last_heartbeat_ts = Column(Float, default=0.0, nullable=False)
    agent_health = Column(String(255), default="", nullable=False)
    last_probe = Column(String(512), default="", nullable=False)
    core_type = Column(String(32), default="xray", nullable=False)
    hy2_enabled = Column(Integer, default=0, nullable=False)
    hy2_port = Column(Integer, default=0, nullable=False)
    hy2_sni = Column(String(255), default="", nullable=False)
    hy2_insecure = Column(Integer, default=1, nullable=False)
    hy2_cert_sha256 = Column(String(128), default="", nullable=False)


class Card(Base, DictMixin):
    __tablename__ = "cards"
    __table_args__ = {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"}

    code = Column(String(64), primary_key=True)
    traffic_gb = Column(Integer, nullable=False)
    days = Column(Integer, nullable=False)
    is_used = Column(Integer, default=0, nullable=False)
    used_by = Column(String(128), nullable=True)
    created_at = Column(String(32), nullable=False)
    used_at = Column(String(32), default="", nullable=False)
    is_monthly = Column(Integer, default=0, nullable=False)


class VerifyCode(Base, DictMixin):
    __tablename__ = "verify_codes"
    __table_args__ = {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"}

    id = Column(Integer, primary_key=True, autoincrement=True)
    email = Column(String(191), nullable=False)
    code = Column(String(32), nullable=False)
    created_at = Column(DateTime, server_default=func.now())


class Captcha(Base, DictMixin):
    __tablename__ = "captchas"
    __table_args__ = {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"}

    id = Column(String(64), primary_key=True)
    answer = Column(String(64), nullable=False)
    expire_at = Column(Float, nullable=False)
    created_at = Column(Float, default=0.0, nullable=False)


class IpSecurityLimit(Base, DictMixin):
    __tablename__ = "ip_security_limits"
    __table_args__ = {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"}

    ip = Column(String(64), primary_key=True)
    fail_count = Column(Integer, default=0, nullable=False)
    lock_until = Column(Float, default=0.0, nullable=False)
    last_attempt = Column(Float, default=0.0, nullable=False)


class SystemSetting(Base, DictMixin):
    __tablename__ = "system_settings"
    __table_args__ = {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"}

    key = Column("key", String(128), primary_key=True)
    value = Column(Text, default="", nullable=True)


class NotifyLog(Base, DictMixin):
    __tablename__ = "notify_logs"
    __table_args__ = {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"}

    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(128), nullable=False)
    warn_type = Column(String(191), nullable=False)
    sent_date = Column(String(32), nullable=False)


class AuditLog(Base, DictMixin):
    __tablename__ = "audit_logs"
    __table_args__ = {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"}

    id = Column(Integer, primary_key=True, autoincrement=True)
    level = Column(String(32), nullable=False)
    event_type = Column(String(64), nullable=False)
    node_id = Column(String(128), default="", nullable=False)
    node_name = Column(String(191), default="", nullable=False)
    ip = Column(String(128), default="", nullable=False)
    message = Column(Text, nullable=False)
    created_at = Column(DateTime, server_default=func.now())


class KvCache(Base, DictMixin):
    __tablename__ = "kv_cache"
    __table_args__ = (
        Index("idx_kv_cache_expire", "expire_at"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    cache_key = Column(String(191), primary_key=True)
    cache_val = Column(Text, nullable=False)
    expire_at = Column(Float, default=0.0, nullable=False)
