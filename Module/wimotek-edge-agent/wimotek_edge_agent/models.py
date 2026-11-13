from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


class AccessDecision(str, Enum):
    ALLOW_LOCAL = "allow_local"
    ALLOW_TOKEN = "allow_token"
    ALLOW_SESSION = "allow_session"
    PENDING_TOFU = "pending_tofu"
    DENY = "deny"


class TrustStatus(str, Enum):
    PENDING = "pending"
    TRUSTED = "trusted"
    REVOKED = "revoked"


@dataclass(frozen=True)
class ConnectionContext:
    source_ip: str
    is_loopback: bool
    node_uuid: str
    public_key_fingerprint: str

    join_token: Optional[str] = None
    local_bypass_token: Optional[str] = None
    session_ticket: Optional[str] = None

    nat_type: str = "unknown"
    reverse_tunnel: bool = False

    public_ipv4: Optional[str] = None
    public_ipv4_port: Optional[int] = None
    public_ipv6: Optional[str] = None
    public_ipv6_port: Optional[int] = None
    network_mode: Optional[str] = None

    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class AccessDecisionResult:
    decision: AccessDecision
    reason: str
    network_profile: str
    node_status: Optional[TrustStatus] = None
    network_mode: Optional[str] = None


@dataclass(frozen=True)
class NodeRecord:
    node_uuid: str
    fingerprint: str
    status: TrustStatus
    first_seen: str
    approved_at: Optional[str]
    network_profile: str
    metadata: dict[str, Any] = field(default_factory=dict)