from sqlalchemy import (
    BigInteger,
    Column,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


class Node(Base):
    __tablename__ = "nodes"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(128), nullable=False)
    group_name = Column(String(128), default="默认分组")
    enabled = Column(Integer, default=1)
    approval_status = Column(Integer, default=1)
    conn_type = Column(String(32), default="direct")
    node_uuid = Column(String(128), default="", index=True)
    fingerprint = Column(String(128), default="")
    created_at = Column(String(64), default="")
    is_source = Column(Integer, default=0)
    is_local = Column(Integer, default=0)
    direct_host = Column(String(255), default="127.0.0.1")
    ssh_host = Column(String(255), default="")
    ssh_port = Column(Integer, default=22)
    ssh_user = Column(String(128), default="")
    ssh_key_filename = Column(String(255), default="")
    ssh_password = Column(Text, default="")
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

    # 流量统计字段 (BigInteger 兼容 TB 级统计及 MySQL BIGINT)
    cdp_rx_bytes = Column(BigInteger, default=0)
    cdp_tx_bytes = Column(BigInteger, default=0)
    net_rx_bytes = Column(BigInteger, default=0)
    net_tx_bytes = Column(BigInteger, default=0)
    active_cdp_streams = Column(Integer, default=0)
    last_metrics_at = Column(String(64), nullable=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "group_name": self.group_name or "默认分组",
            "enabled": self.enabled if self.enabled is not None else 1,
            "approval_status": self.approval_status if self.approval_status is not None else 1,
            "conn_type": self.conn_type or "direct",
            "node_uuid": self.node_uuid or "",
            "fingerprint": self.fingerprint or "",
            "created_at": self.created_at or "",
            "is_source": self.is_source or 0,
            "is_local": self.is_local or 0,
            "direct_host": self.direct_host or "127.0.0.1",
            "ssh_host": self.ssh_host or "",
            "ssh_port": self.ssh_port or 22,
            "ssh_user": self.ssh_user or "",
            "ssh_key_filename": self.ssh_key_filename or "",
            "ssh_password": self.ssh_password or "",
            "remote_cdp_port": self.remote_cdp_port or 9222,
            "local_bind_port": self.local_bind_port,
            "cookie_count": self.cookie_count or 0,
            "auto_tunnel": self.auto_tunnel if self.auto_tunnel is not None else 1,
            "status": self.status or "stopped",
            "last_sync": self.last_sync,
            "network_mode": self.network_mode or "",
            "recommended_endpoint": self.recommended_endpoint or "",
            "wss_endpoint": self.wss_endpoint or "",
            "edge_wss_secret": self.edge_wss_secret or "",
            "ipv4_reachable": self.ipv4_reachable or 0,
            "ipv6_reachable": self.ipv6_reachable or 0,
            "client_type": self.client_type or "desktop",
            "api_enabled": self.api_enabled if self.api_enabled is not None else 1,
            "cdp_rx_bytes": int(self.cdp_rx_bytes or 0),
            "cdp_tx_bytes": int(self.cdp_tx_bytes or 0),
            "net_rx_bytes": int(self.net_rx_bytes or 0),
            "net_tx_bytes": int(self.net_tx_bytes or 0),
            "active_cdp_streams": int(self.active_cdp_streams or 0),
            "last_metrics_at": self.last_metrics_at,
        }


class SyncPolicy(Base):
    __tablename__ = "sync_policies"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(128), nullable=False)
    enabled = Column(Integer, default=1)
    interval_minutes = Column(Integer, default=15)
    sync_type = Column(String(32), default="smart_merge")
    source_type = Column(String(32), default="node")
    source_id = Column(Integer, default=0)
    source_group = Column(String(128), default="")
    target_type = Column(String(32), default="all")
    target_ids = Column(Text, default="[]")
    target_group = Column(String(128), default="")
    last_run = Column(String(64), nullable=True)
    created_at = Column(String(64), nullable=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "enabled": self.enabled if self.enabled is not None else 1,
            "interval_minutes": self.interval_minutes or 15,
            "sync_type": self.sync_type or "smart_merge",
            "source_type": self.source_type or "node",
            "source_id": self.source_id or 0,
            "source_group": self.source_group or "",
            "target_type": self.target_type or "all",
            "target_ids": self.target_ids or "[]",
            "target_group": self.target_group or "",
            "last_run": self.last_run,
            "created_at": self.created_at,
        }


class SshKey(Base):
    __tablename__ = "ssh_keys"

    id = Column(Integer, primary_key=True, autoincrement=True)
    filename = Column(String(255), unique=True, nullable=False)
    remark = Column(String(255), default="")
    created_at = Column(String(64), nullable=False)
    size = Column(Integer, default=0)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "filename": self.filename,
            "remark": self.remark or "",
            "created_at": self.created_at,
            "size": self.size or 0,
        }


class Setting(Base):
    __tablename__ = "settings"

    key = Column("key", String(128), primary_key=True)
    value = Column("value", Text, default="")


class SyncLog(Base):
    __tablename__ = "sync_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    timestamp = Column(String(64), default="")
    source_node = Column(String(255), default="")
    target_nodes = Column(String(255), default="")
    cookie_count = Column(Integer, default=0)
    duration = Column(String(32), default="")
    status = Column(String(32), default="")
    details = Column(Text, default="")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "timestamp": self.timestamp or "",
            "source_node": self.source_node or "",
            "target_nodes": self.target_nodes or "",
            "cookie_count": self.cookie_count or 0,
            "duration": self.duration or "",
            "status": self.status or "",
            "details": self.details or "",
        }


class TrafficStat(Base):
    __tablename__ = "traffic_stats"
    __table_args__ = (
        UniqueConstraint("node_id", "bucket_hour", "channel_type", name="uq_traffic_node_hour_channel"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    node_id = Column(Integer, nullable=False, index=True)
    bucket_hour = Column(String(32), nullable=False, index=True)
    channel_type = Column(String(32), nullable=False, default="cdp_gateway")
    rx_bytes = Column(BigInteger, default=0)
    tx_bytes = Column(BigInteger, default=0)
    request_count = Column(BigInteger, default=0)
    duration_sec = Column(BigInteger, default=0)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "node_id": self.node_id,
            "bucket_hour": self.bucket_hour,
            "channel_type": self.channel_type,
            "rx_bytes": int(self.rx_bytes or 0),
            "tx_bytes": int(self.tx_bytes or 0),
            "request_count": int(self.request_count or 0),
            "duration_sec": int(self.duration_sec or 0),
        }


class Bookmark(Base):
    __tablename__ = "bookmarks"

    id = Column(Integer, primary_key=True, autoincrement=True)
    title = Column(String(255), nullable=False)
    url = Column(String(1024), nullable=False, unique=True, index=True)
    folder = Column(String(128), default="常用站点")
    pinned = Column(Integer, default=1)
    sort_order = Column(Integer, default=0)
    source_node = Column(String(128), default="hub")
    created_at = Column(String(64), default="")
    updated_at = Column(String(64), default="")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title or "",
            "url": self.url or "",
            "folder": self.folder or "常用站点",
            "pinned": int(self.pinned if self.pinned is not None else 1),
            "sort_order": int(self.sort_order or 0),
            "source_node": self.source_node or "hub",
            "created_at": self.created_at or "",
            "updated_at": self.updated_at or "",
        }

