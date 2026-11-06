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

    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class AccessDecisionResult:
    decision: AccessDecision
    reason: str
    network_profile: str
    node_status: Optional[TrustStatus] = None


@dataclass(frozen=True)
class NodeRecord:
    node_uuid: str
    fingerprint: str
    status: TrustStatus
    first_seen: str
    approved_at: Optional[str]
    network_profile: str
    metadata: dict[str, Any] = field(default_factory=dict)