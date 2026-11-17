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


class UserLevel(Base):
    """用户节点主等级：按在线时长、节点速度、贡献流量自动升降级，并决定不同接入通道的平台差价"""
    __tablename__ = "user_levels"

    id = Column(Integer, primary_key=True, autoincrement=True)
    code = Column(String(32), unique=True, nullable=False, index=True)
    name = Column(String(64), nullable=False)
    rank_order = Column(Integer, nullable=False, default=1, index=True)
    badge_color = Column(String(32), default="#94a3b8")

    min_online_hours = Column(Integer, nullable=False, default=0)
    min_contributed_gb = Column(Integer, nullable=False, default=0)
    max_avg_latency_ms = Column(Integer, nullable=False, default=0)
    min_speed_kbps = Column(Integer, nullable=False, default=0)

    reverse_fee_bps = Column(Integer, nullable=False, default=2500)
    public_wss_fee_bps = Column(Integer, nullable=False, default=1000)
    buyer_discount_bps = Column(Integer, nullable=False, default=0)
    description = Column(String(255), default="")

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "code": self.code,
            "name": self.name,
            "rank_order": int(self.rank_order or 1),
            "badge_color": self.badge_color or "#94a3b8",
            "min_online_hours": int(self.min_online_hours or 0),
            "min_contributed_gb": int(self.min_contributed_gb or 0),
            "max_avg_latency_ms": int(self.max_avg_latency_ms or 0),
            "min_speed_kbps": int(self.min_speed_kbps or 0),
            "reverse_fee_bps": int(self.reverse_fee_bps if self.reverse_fee_bps is not None else 2500),
            "public_wss_fee_bps": int(self.public_wss_fee_bps if self.public_wss_fee_bps is not None else 1000),
            "buyer_discount_bps": int(self.buyer_discount_bps or 0),
            "description": self.description or "",
        }


class User(Base):
    """多租户 SaaS 账号、邮箱认证、推荐邀请、等级信用指标、余额账户与专属入网/API 凭据"""
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(64), unique=True, nullable=False, index=True)
    email = Column(String(191), unique=True, nullable=True, index=True)
    email_verified = Column(Integer, nullable=False, default=0)
    password_hash = Column(String(255), nullable=False)
    role = Column(String(32), nullable=False, default="user")
    status = Column(String(32), nullable=False, default="active")
    plan_id = Column(Integer, nullable=False, default=1, index=True)

    invite_code = Column(String(32), unique=True, nullable=True, index=True)
    invited_by_id = Column(Integer, nullable=True, index=True)

    level_id = Column(Integer, nullable=False, default=1, index=True)
    level_locked = Column(Integer, nullable=False, default=0)
    total_online_seconds = Column(BigInteger, nullable=False, default=0)
    avg_node_latency_ms = Column(Integer, nullable=False, default=0)
    avg_node_speed_kbps = Column(Integer, nullable=False, default=0)
    contributed_traffic_bytes = Column(BigInteger, nullable=False, default=0)
    level_score = Column(Integer, nullable=False, default=0)
    level_evaluated_at = Column(String(64), default="")
    last_level_change_reason = Column(String(255), default="")

    balance_units = Column(BigInteger, nullable=False, default=0)
    frozen_units = Column(BigInteger, nullable=False, default=0)
    total_recharged_units = Column(BigInteger, nullable=False, default=0)
    total_spent_units = Column(BigInteger, nullable=False, default=0)
    total_earned_units = Column(BigInteger, nullable=False, default=0)
    monthly_traffic_bytes = Column(BigInteger, nullable=False, default=0)
    self_reverse_billed_bytes = Column(BigInteger, nullable=False, default=0)
    self_reverse_billed_units = Column(BigInteger, nullable=False, default=0)

    last_checkin_date = Column(String(16), default="")
    checkin_streak = Column(Integer, nullable=False, default=0)
    last_monthly_claim_ym = Column(String(16), default="")

    api_key = Column(String(128), unique=True, nullable=False, index=True)
    cluster_join_token = Column(String(128), unique=True, nullable=False, index=True)
    created_at = Column(String(64), default="")
    last_login_at = Column(String(64), default="")

    def to_dict(self, include_secrets: bool = False) -> Dict[str, Any]:
        d = {
            "id": self.id,
            "username": self.username,
            "email": self.email or "",
            "email_verified": bool(self.email_verified),
            "role": self.role,
            "status": self.status,
            "plan_id": self.plan_id,
            "invite_code": self.invite_code or "",
            "invited_by_id": self.invited_by_id,
            "level_id": int(self.level_id or 1),
            "level_locked": bool(self.level_locked),
            "total_online_seconds": int(self.total_online_seconds or 0),
            "avg_node_latency_ms": int(self.avg_node_latency_ms or 0),
            "avg_node_speed_kbps": int(self.avg_node_speed_kbps or 0),
            "contributed_traffic_bytes": int(self.contributed_traffic_bytes or 0),
            "level_score": int(self.level_score or 0),
            "level_evaluated_at": self.level_evaluated_at or "",
            "last_level_change_reason": self.last_level_change_reason or "",
            "balance_units": int(self.balance_units or 0),
            "balance_yuan": units_to_yuan_str(self.balance_units or 0),
            "total_recharged_units": int(self.total_recharged_units or 0),
            "total_recharged_yuan": units_to_yuan_str(self.total_recharged_units or 0),
            "total_spent_units": int(self.total_spent_units or 0),
            "total_spent_yuan": units_to_yuan_str(self.total_spent_units or 0),
            "total_earned_units": int(self.total_earned_units or 0),
            "total_earned_yuan": units_to_yuan_str(self.total_earned_units or 0),
            "monthly_traffic_bytes": int(self.monthly_traffic_bytes or 0),
            "self_reverse_billed_bytes": int(self.self_reverse_billed_bytes or 0),
            "self_reverse_billed_units": int(self.self_reverse_billed_units or 0),
            "self_reverse_billed_yuan": units_to_yuan_str(self.self_reverse_billed_units or 0),
            "last_checkin_date": self.last_checkin_date or "",
            "checkin_streak": int(self.checkin_streak or 0),
            "last_monthly_claim_ym": self.last_monthly_claim_ym or "",
            "created_at": self.created_at or "",
            "last_login_at": self.last_login_at or "",
        }
        if include_secrets:
            d["api_key"] = self.api_key
            d["cluster_join_token"] = self.cluster_join_token
        return d


class ReferralReward(Base):
    """推荐邀请奖励明细流水"""
    __tablename__ = "referral_rewards"

    id = Column(Integer, primary_key=True, autoincrement=True)
    inviter_id = Column(Integer, nullable=False, index=True)
    invitee_id = Column(Integer, nullable=False, index=True)
    invitee_username = Column(String(64), nullable=False)
    inviter_bonus_units = Column(BigInteger, nullable=False, default=0)
    invitee_bonus_units = Column(BigInteger, nullable=False, default=0)
    status = Column(String(32), nullable=False, default="credited")
    remark = Column(String(255), default="")
    created_at = Column(String(64), nullable=False)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "inviter_id": self.inviter_id,
            "invitee_id": self.invitee_id,
            "invitee_username": self.invitee_username,
            "inviter_bonus_units": int(self.inviter_bonus_units or 0),
            "inviter_bonus_yuan": units_to_yuan_str(self.inviter_bonus_units or 0),
            "invitee_bonus_units": int(self.invitee_bonus_units or 0),
            "invitee_bonus_yuan": units_to_yuan_str(self.invitee_bonus_units or 0),
            "status": self.status,
            "remark": self.remark or "",
            "created_at": self.created_at,
        }


class Announcement(Base):
    """平台系统公告（支持登录页公开展示与工作台顶部横幅）"""
    __tablename__ = "announcements"

    id = Column(Integer, primary_key=True, autoincrement=True)
    title = Column(String(200), nullable=False)
    content = Column(Text, nullable=False)
    level = Column(String(32), nullable=False, default="info")  # info | success | warn | danger
    is_pinned = Column(Integer, nullable=False, default=0)
    is_active = Column(Integer, nullable=False, default=1, index=True)
    show_on_auth = Column(Integer, nullable=False, default=1)
    author_username = Column(String(64), default="admin")
    created_at = Column(String(64), nullable=False)
    updated_at = Column(String(64), nullable=False)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "content": self.content,
            "level": self.level or "info",
            "is_pinned": bool(self.is_pinned),
            "is_active": bool(self.is_active),
            "show_on_auth": bool(self.show_on_auth),
            "author_username": self.author_username or "admin",
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


class Node(Base):
    """节点实体（强归属 owner_id 并支持共享市场定价与实时质量遥测）"""
    __tablename__ = "nodes"

    id = Column(Integer, primary_key=True, autoincrement=True)
    owner_id = Column(Integer, nullable=False, default=1, index=True)
    name = Column(String(255), nullable=False)
    group_name = Column(String(128), default="默认分组")
    enabled = Column(Integer, default=1)
    conn_type = Column(String(32), default="reverse")
    node_uuid = Column(String(128), default="", index=True)
    fingerprint = Column(String(128), default="")
    is_source = Column(Integer, default=0)
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

    avg_latency_ms = Column(Integer, default=0)
    avg_speed_kbps = Column(Integer, default=0)
    online_seconds = Column(BigInteger, default=0)
    last_online_tick_at = Column(String(64), default="")

    share_enabled = Column(Integer, default=0, index=True)
    share_title = Column(String(255), default="")
    share_region = Column(String(64), default="Global")
    share_tags = Column(String(255), default="")
    seller_price_per_hour_units = Column(BigInteger, default=5000)
    seller_price_per_gb_units = Column(BigInteger, default=10000)
    max_concurrent_leases = Column(Integer, default=1)
    active_lease_count = Column(Integer, default=0)
    isolation_mode = Column(String(32), default="exclusive_slot")
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
    status = Column(String(32), nullable=False, default="active", index=True)
    lease_token = Column(String(64), unique=True, nullable=False)
    isolation_profile_id = Column(String(64), nullable=False)
    channel_type = Column(String(32), nullable=False, default="reverse")
    seller_level_code = Column(String(32), nullable=False, default="lv1")

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
            "channel_type": self.channel_type or "reverse",
            "seller_level_code": self.seller_level_code or "lv1",
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
    """钱包财务双分录流水"""
    __tablename__ = "billing_ledger"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, nullable=False, index=True)
    related_lease_id = Column(Integer, nullable=True, index=True)
    related_node_id = Column(Integer, nullable=True, index=True)
    tx_type = Column(String(32), nullable=False, index=True)
    amount_units = Column(BigInteger, nullable=False, default=0)
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


class RechargeOrder(Base):
    """用户钱包充值订单"""
    __tablename__ = "recharge_orders"

    id = Column(Integer, primary_key=True, autoincrement=True)
    order_no = Column(String(64), unique=True, nullable=False, index=True)
    user_id = Column(Integer, nullable=False, index=True)
    channel = Column(String(32), nullable=False, default="alipay")
    amount_units = Column(BigInteger, nullable=False, default=0)
    status = Column(String(32), nullable=False, default="pending", index=True)
    pay_url = Column(String(512), default="")
    qr_code_text = Column(String(512), default="")
    external_trade_no = Column(String(128), default="")
    created_at = Column(String(64), nullable=False)
    paid_at = Column(String(64), nullable=True)
    remark = Column(String(255), default="")

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "order_no": self.order_no,
            "user_id": self.user_id,
            "channel": self.channel,
            "amount_units": int(self.amount_units or 0),
            "amount_yuan": units_to_yuan_str(self.amount_units or 0),
            "status": self.status,
            "pay_url": self.pay_url or "",
            "qr_code_text": self.qr_code_text or "",
            "external_trade_no": self.external_trade_no or "",
            "created_at": self.created_at,
            "paid_at": self.paid_at or "",
            "remark": self.remark or "",
        }


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
    status = Column(String(32), nullable=False, default="ok", index=True)
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
