from typing import Any, Dict
from sqlalchemy import BigInteger, Column, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import declarative_base

Base = declarative_base()

# 内部金额最小精度：1 元 = 10000 厘（units），1 分 = 100 units，全程整数精确计算无浮点漂移
UNITS_PER_YUAN = 10000


def units_to_yuan(units: int) -> float:
    return round(float(int(units or 0)) / UNITS_PER_YUAN, 4)


def units_to_yuan_str(units: int) -> str:
    val = int(units or 0)
    yuan = val / UNITS_PER_YUAN
    return f"{yuan:.4f}" if val % 100 != 0 else f"{yuan:.2f}"


def yuan_to_units(yuan_val: Any) -> int:
    try:
        return int(round(float(yuan_val or 0) * UNITS_PER_YUAN))
    except (TypeError, ValueError):
        return 0


class Plan(Base):
    """SaaS 会员套餐与配额限制"""
    __tablename__ = "plans"

    id = Column(Integer, primary_key=True, autoincrement=True)
    code = Column(String(64), unique=True, nullable=False, index=True)
    name = Column(String(128), nullable=False)
    monthly_price_units = Column(BigInteger, nullable=False, default=0)
    max_nodes = Column(Integer, nullable=False, default=3)
    max_active_leases = Column(Integer, nullable=False, default=2)
    max_monthly_traffic_bytes = Column(BigInteger, nullable=False, default=10 * 1024 * 1024 * 1024)
    # 买家购买套餐后享有的平台抽成减免基点（bps，例如 500 = 减免 5%）
    platform_fee_discount_bps = Column(Integer, nullable=False, default=0)
    can_share_nodes = Column(Integer, nullable=False, default=1)
    is_default = Column(Integer, nullable=False, default=0)
    description = Column(String(255), default="")

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "code": self.code,
            "name": self.name,
            "monthly_price_units": int(self.monthly_price_units or 0),
            "monthly_price_yuan": units_to_yuan(self.monthly_price_units or 0),
            "max_nodes": int(self.max_nodes or 0),
            "max_active_leases": int(self.max_active_leases or 0),
            "max_monthly_traffic_bytes": int(self.max_monthly_traffic_bytes or 0),
            "platform_fee_discount_bps": int(self.platform_fee_discount_bps or 0),
            "can_share_nodes": bool(self.can_share_nodes),
            "is_default": bool(self.is_default),
            "description": self.description or "",
        }


class User(Base):
    """多租户 SaaS 账号、余额账户与专属入网/API 凭据"""
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(64), unique=True, nullable=False, index=True)
    email = Column(String(191), unique=True, nullable=True, index=True)
    password_hash = Column(String(255), nullable=False)
    role = Column(String(32), nullable=False, default="user")  # user | admin
    status = Column(String(32), nullable=False, default="active")  # active | suspended
    plan_id = Column(Integer, nullable=False, default=1, index=True)

    balance_units = Column(BigInteger, nullable=False, default=0)
    frozen_units = Column(BigInteger, nullable=False, default=0)
    total_recharged_units = Column(BigInteger, nullable=False, default=0)
    total_spent_units = Column(BigInteger, nullable=False, default=0)
    total_earned_units = Column(BigInteger, nullable=False, default=0)
    monthly_traffic_bytes = Column(BigInteger, nullable=False, default=0)

    api_key = Column(String(128), unique=True, nullable=False, index=True)
    cluster_join_token = Column(String(128), unique=True, nullable=False, index=True)
    created_at = Column(String(64), default="")
    last_login_at = Column(String(64), default="")

    def to_dict(self, include_secrets: bool = False) -> Dict[str, Any]:
        d = {
            "id": self.id,
            "username": self.username,
            "email": self.email or "",
            "role": self.role,
            "status": self.status,
            "plan_id": self.plan_id,
            "balance_units": int(self.balance_units or 0),
            "balance_yuan": units_to_yuan_str(self.balance_units or 0),
            "total_recharged_units": int(self.total_recharged_units or 0),
            "total_recharged_yuan": units_to_yuan_str(self.total_recharged_units or 0),
            "total_spent_units": int(self.total_spent_units or 0),
            "total_spent_yuan": units_to_yuan_str(self.total_spent_units or 0),
            "total_earned_units": int(self.total_earned_units or 0),
            "total_earned_yuan": units_to_yuan_str(self.total_earned_units or 0),
            "monthly_traffic_bytes": int(self.monthly_traffic_bytes or 0),
            "created_at": self.created_at or "",
            "last_login_at": self.last_login_at or "",
        }
        if include_secrets:
            d["api_key"] = self.api_key
            d["cluster_join_token"] = self.cluster_join_token
        return d


class Node(Base):
    """节点实体（彻底移除 TOFU approval_status，强归属 owner_id 并支持共享市场定价）"""
    __tablename__ = "nodes"

    id = Column(Integer, primary_key=True, autoincrement=True)
    owner_id = Column(Integer, nullable=False, default=1, index=True)
    name = Column(String(255), nullable=False)
    group_name = Column(String(128), default="默认分组")
    enabled = Column(Integer, default=1)
    conn_type = Column(String(32), default="direct")
    node_uuid = Column(String(128), default="", index=True)
    fingerprint = Column(String(128), default="")
    is_source = Column(Integer, default=0)
    is_local = Column(Integer, default=0)
    direct_host = Column(String(255), default="127.0.0.1")
    ssh_host = Column(String(255), default="")
    ssh_port = Column(Integer, default=22)
    ssh_user = Column(String(128), default="")
    ssh_key_filename = Column(String(255), default="")
    ssh_password = Column(String(255), default="")
    remote_cdp_port = Column(Integer, default=9222)
    local_bind_port = Column(Integer, nullable=False)
    cookie_count = Column(Integer, default=0)
    auto_tunnel = Column(Integer, default=1)
    status = Column(String(64), default="stopped")
    last_sync = Column(String(64), nullable=True)
    network_mode = Column(String(64), default="")
    recommended_endpoint = Column(String(255), default="")
    wss_endpoint = Column(String(255), default="")
    edge_wss_secret = Column(String(255), default="")
    ipv4_reachable = Column(Integer, default=0)
    ipv6_reachable = Column(Integer, default=0)
    client_type = Column(String(32), default="desktop")
    api_enabled = Column(Integer, default=1)
    cdp_rx_bytes = Column(BigInteger, default=0)
    cdp_tx_bytes = Column(BigInteger, default=0)
    net_rx_bytes = Column(BigInteger, default=0)
    net_tx_bytes = Column(BigInteger, default=0)
    active_cdp_streams = Column(Integer, default=0)
    last_metrics_at = Column(String(64), nullable=True)

    # 共享节点市场定价与隔离模式
    share_enabled = Column(Integer, default=0, index=True)
    share_title = Column(String(255), default="")
    share_region = Column(String(64), default="Global")
    share_tags = Column(String(255), default="")
    seller_price_per_hour_units = Column(BigInteger, default=5000)  # 默认 0.50 元/小时
    seller_price_per_gb_units = Column(BigInteger, default=10000)   # 默认 1.00 元/GB
    max_concurrent_leases = Column(Integer, default=1)              # 默认 1 独占租约槽位
    active_lease_count = Column(Integer, default=0)
    isolation_mode = Column(String(32), default="exclusive_slot")   # exclusive_slot | ephemeral_profile
    total_leased_seconds = Column(BigInteger, default=0)
    total_leased_bytes = Column(BigInteger, default=0)
    created_at = Column(String(64), default="")

    def to_dict(self) -> Dict[str, Any]:
        return {c.name: getattr(self, c.name) for c in self.__table__.columns}


class NodeLease(Base):
    """节点共享租约与买卖双价平台差价结算记录"""
    __tablename__ = "node_leases"

    id = Column(Integer, primary_key=True, autoincrement=True)
    node_id = Column(Integer, nullable=False, index=True)
    seller_id = Column(Integer, nullable=False, index=True)
    buyer_id = Column(Integer, nullable=False, index=True)
    status = Column(String(32), nullable=False, default="active", index=True)  # active | ended | exhausted | revoked
    lease_token = Column(String(64), unique=True, nullable=False)
    isolation_profile_id = Column(String(64), nullable=False)

    seller_hour_units = Column(BigInteger, nullable=False, default=0)
    buyer_hour_units = Column(BigInteger, nullable=False, default=0)
    seller_gb_units = Column(BigInteger, nullable=False, default=0)
    buyer_gb_units = Column(BigInteger, nullable=False, default=0)
    platform_fee_bps = Column(Integer, nullable=False, default=2000)

    consumed_bytes = Column(BigInteger, nullable=False, default=0)
    billed_bytes = Column(BigInteger, nullable=False, default=0)
    billed_seconds = Column(BigInteger, nullable=False, default=0)
    buyer_spent_units = Column(BigInteger, nullable=False, default=0)
    seller_earned_units = Column(BigInteger, nullable=False, default=0)
    platform_profit_units = Column(BigInteger, nullable=False, default=0)

    started_at = Column(String(64), nullable=False)
    last_billed_at = Column(String(64), nullable=False)
    ended_at = Column(String(64), nullable=True)
    end_reason = Column(String(128), default="")

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "node_id": self.node_id,
            "seller_id": self.seller_id,
            "buyer_id": self.buyer_id,
            "status": self.status,
            "isolation_profile_id": self.isolation_profile_id,
            "seller_hour_units": int(self.seller_hour_units or 0),
            "buyer_hour_units": int(self.buyer_hour_units or 0),
            "seller_hour_yuan": units_to_yuan_str(self.seller_hour_units or 0),
            "buyer_hour_yuan": units_to_yuan_str(self.buyer_hour_units or 0),
            "seller_gb_units": int(self.seller_gb_units or 0),
            "buyer_gb_units": int(self.buyer_gb_units or 0),
            "seller_gb_yuan": units_to_yuan_str(self.seller_gb_units or 0),
            "buyer_gb_yuan": units_to_yuan_str(self.buyer_gb_units or 0),
            "platform_fee_bps": int(self.platform_fee_bps or 0),
            "consumed_bytes": int(self.consumed_bytes or 0),
            "billed_bytes": int(self.billed_bytes or 0),
            "billed_seconds": int(self.billed_seconds or 0),
            "buyer_spent_units": int(self.buyer_spent_units or 0),
            "buyer_spent_yuan": units_to_yuan_str(self.buyer_spent_units or 0),
            "seller_earned_units": int(self.seller_earned_units or 0),
            "seller_earned_yuan": units_to_yuan_str(self.seller_earned_units or 0),
            "platform_profit_units": int(self.platform_profit_units or 0),
            "platform_profit_yuan": units_to_yuan_str(self.platform_profit_units or 0),
            "started_at": self.started_at,
            "last_billed_at": self.last_billed_at,
            "ended_at": self.ended_at or "",
            "end_reason": self.end_reason or "",
        }


class BillingLedger(Base):
    """钱包财务双分录流水（充值 / 租约扣费 / 卖家分成 / 平台差价抽成 / 管理员调账）"""
    __tablename__ = "billing_ledger"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, nullable=False, index=True)
    related_lease_id = Column(Integer, nullable=True, index=True)
    related_node_id = Column(Integer, nullable=True, index=True)
    tx_type = Column(String(32), nullable=False, index=True)
    amount_units = Column(BigInteger, nullable=False, default=0)  # 正为入账，负为扣款
    balance_after_units = Column(BigInteger, nullable=False, default=0)
    platform_spread_units = Column(BigInteger, nullable=False, default=0)
    remark = Column(String(255), default="")
    created_at = Column(String(64), nullable=False)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "user_id": self.user_id,
            "related_lease_id": self.related_lease_id,
            "related_node_id": self.related_node_id,
            "tx_type": self.tx_type,
            "amount_units": int(self.amount_units or 0),
            "amount_yuan": units_to_yuan_str(self.amount_units or 0),
            "balance_after_units": int(self.balance_after_units or 0),
            "balance_after_yuan": units_to_yuan_str(self.balance_after_units or 0),
            "platform_spread_units": int(self.platform_spread_units or 0),
            "platform_spread_yuan": units_to_yuan_str(self.platform_spread_units or 0),
            "remark": self.remark or "",
            "created_at": self.created_at,
        }


class SyncPolicy(Base):
    __tablename__ = "sync_policies"

    id = Column(Integer, primary_key=True, autoincrement=True)
    owner_id = Column(Integer, nullable=False, default=1, index=True)
    name = Column(String(255), nullable=False)
    enabled = Column(Integer, default=1)
    interval_minutes = Column(Integer, default=15)
    sync_type = Column(String(64), default="smart_merge")
    source_type = Column(String(32), default="all")
    source_id = Column(Integer, default=0)
    source_group = Column(String(128), default="")
    target_type = Column(String(32), default="all")
    target_ids = Column(Text, default="[]")
    target_group = Column(String(128), default="")
    created_at = Column(String(64), default="")
    last_run = Column(String(64), nullable=True)

    def to_dict(self) -> Dict[str, Any]:
        return {c.name: getattr(self, c.name) for c in self.__table__.columns}


class SyncLog(Base):
    __tablename__ = "sync_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    owner_id = Column(Integer, nullable=False, default=1, index=True)
    timestamp = Column(String(64), nullable=False)
    source_node = Column(String(255), default="")
    target_nodes = Column(String(255), default="")
    cookie_count = Column(Integer, default=0)
    duration = Column(String(32), default="")
    status = Column(String(32), nullable=False)
    details = Column(Text, default="")

    def to_dict(self) -> Dict[str, Any]:
        return {c.name: getattr(self, c.name) for c in self.__table__.columns}


class SshKey(Base):
    __tablename__ = "ssh_keys"

    id = Column(Integer, primary_key=True, autoincrement=True)
    owner_id = Column(Integer, nullable=False, default=1, index=True)
    name = Column(String(255), nullable=False)
    filename = Column(String(255), unique=True, nullable=False)
    fingerprint = Column(String(128), default="")
    created_at = Column(String(64), nullable=False)

    def to_dict(self) -> Dict[str, Any]:
        return {c.name: getattr(self, c.name) for c in self.__table__.columns}


class TrafficStat(Base):
    __tablename__ = "traffic_stats"

    id = Column(Integer, primary_key=True, autoincrement=True)
    owner_id = Column(Integer, nullable=False, default=1, index=True)
    node_id = Column(Integer, nullable=False, index=True)
    lease_id = Column(Integer, nullable=False, default=0, index=True)
    bucket_hour = Column(String(32), nullable=False, index=True)
    channel_type = Column(String(32), nullable=False)
    rx_bytes = Column(BigInteger, default=0)
    tx_bytes = Column(BigInteger, default=0)
    request_count = Column(BigInteger, default=0)
    duration_sec = Column(BigInteger, default=0)

    __table_args__ = (
        UniqueConstraint("node_id", "lease_id", "bucket_hour", "channel_type", name="uq_traffic_node_lease_hour_chan"),
    )

    def to_dict(self) -> Dict[str, Any]:
        return {c.name: getattr(self, c.name) for c in self.__table__.columns}


class Bookmark(Base):
    __tablename__ = "bookmarks"

    id = Column(Integer, primary_key=True, autoincrement=True)
    owner_id = Column(Integer, nullable=False, default=1, index=True)
    title = Column(String(255), nullable=False)
    url = Column(String(768), nullable=False)
    folder = Column(String(128), default="常用站点")
    pinned = Column(Integer, default=1)
    sort_order = Column(Integer, default=0)
    source_node = Column(String(128), default="hub")
    created_at = Column(String(64), default="")
    updated_at = Column(String(64), default="")

    __table_args__ = (
        UniqueConstraint("owner_id", "url", name="uq_bookmark_owner_url"),
    )

    def to_dict(self) -> Dict[str, Any]:
        return {c.name: getattr(self, c.name) for c in self.__table__.columns}


class AuditLog(Base):
    """全量不可篡改的多租户严苛审计流水表"""
    __tablename__ = "audit_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    actor_id = Column(Integer, nullable=True, index=True)
    actor_username = Column(String(64), default="anonymous", index=True)
    action = Column(String(64), nullable=False, index=True)
    target_type = Column(String(64), default="")
    target_id = Column(String(128), default="")
    ip = Column(String(64), default="unknown")
    status = Column(String(32), nullable=False, default="ok", index=True)  # ok | deny | error
    detail_json = Column(Text, default="{}")
    created_at = Column(String(64), nullable=False, index=True)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "actor_id": self.actor_id,
            "actor_username": self.actor_username or "anonymous",
            "action": self.action,
            "target_type": self.target_type or "",
            "target_id": self.target_id or "",
            "ip": self.ip or "unknown",
            "status": self.status,
            "detail_json": self.detail_json or "{}",
            "created_at": self.created_at,
        }


class Setting(Base):
    __tablename__ = "settings"

    key = Column(String(128), primary_key=True)
    value = Column(Text, nullable=False)
