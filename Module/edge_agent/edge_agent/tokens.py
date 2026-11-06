from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import secrets
import time
from dataclasses import asdict, dataclass
from typing import Optional, Protocol


class TokenError(Exception):
    pass


class TokenReplayStore(Protocol):
    def consume_token(self, jti: str, expires_at: int) -> bool:
        ...


def _b64e(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64d(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


@dataclass(frozen=True)
class JoinTokenClaims:
    jti: str
    exp: int
    iat: int
    aud: str
    iss: str
    node_group: str
    node_uuid: Optional[str] = None
    allowed_ip_cidr: Optional[str] = None


class JoinTokenIssuer:
    def __init__(
        self,
        secret: bytes,
        audience: str = "edge-agent",
        issuer: str = "central",
        max_ttl_seconds: int = 600,
    ) -> None:
        if len(secret) < 32:
            raise ValueError("token secret must be at least 32 bytes")
        self.secret = secret
        self.audience = audience
        self.issuer = issuer
        self.max_ttl_seconds = max_ttl_seconds

    def issue(
        self,
        node_group: str,
        ttl_seconds: int = 300,
        node_uuid: Optional[str] = None,
        allowed_ip_cidr: Optional[str] = None,
    ) -> str:
        if ttl_seconds <= 0 or ttl_seconds > self.max_ttl_seconds:
            raise ValueError("ttl_seconds out of allowed range")

        now = int(time.time())
        claims = JoinTokenClaims(
            jti=secrets.token_urlsafe(24),
            exp=now + ttl_seconds,
            iat=now,
            aud=self.audience,
            iss=self.issuer,
            node_group=node_group,
            node_uuid=node_uuid,
            allowed_ip_cidr=allowed_ip_cidr,
        )
        payload = json.dumps(
            asdict(claims), separators=(",", ":"), sort_keys=True
        ).encode("utf-8")
        signature = hmac.new(self.secret, payload, hashlib.sha256).digest()
        return f"{_b64e(payload)}.{_b64e(signature)}"


class JoinTokenVerifier:
    def __init__(
        self,
        secret: bytes,
        replay_store: TokenReplayStore,
        audience: str = "edge-agent",
        issuer: str = "central",
        max_ttl_seconds: int = 600,
    ) -> None:
        if len(secret) < 32:
            raise ValueError("token secret must be at least 32 bytes")
        self.secret = secret
        self.replay_store = replay_store
        self.audience = audience
        self.issuer = issuer
        self.max_ttl_seconds = max_ttl_seconds

    def verify(
        self,
        token: str,
        source_ip: str,
        node_uuid: str,
    ) -> JoinTokenClaims:
        try:
            payload_b64, signature_b64 = token.split(".", 1)
            payload = _b64d(payload_b64)
            signature = _b64d(signature_b64)
        except Exception as exc:
            raise TokenError("malformed token") from exc

        expected = hmac.new(self.secret, payload, hashlib.sha256).digest()
        if not hmac.compare_digest(signature, expected):
            raise TokenError("bad token signature")

        try:
            data = json.loads(payload.decode("utf-8"))
            claims = JoinTokenClaims(**data)
        except Exception as exc:
            raise TokenError("bad token payload") from exc

        now = int(time.time())
        if claims.exp <= now:
            raise TokenError("token expired")
        if claims.iat > now + 60:
            raise TokenError("token issued in the future")
        if claims.exp - claims.iat > self.max_ttl_seconds:
            raise TokenError("token ttl too long")
        if claims.aud != self.audience:
            raise TokenError("token audience mismatch")
        if claims.iss != self.issuer:
            raise TokenError("token issuer mismatch")

        if claims.node_uuid is not None and claims.node_uuid != node_uuid:
            raise TokenError("token node_uuid mismatch")

        if claims.allowed_ip_cidr:
            try:
                network = ipaddress.ip_network(claims.allowed_ip_cidr, strict=False)
                address = ipaddress.ip_address(source_ip)
            except ValueError as exc:
                raise TokenError("invalid token ip binding or source ip") from exc
            if address not in network:
                raise TokenError("source ip not allowed by token")

        if not self.replay_store.consume_token(claims.jti, claims.exp):
            raise TokenError("token replay detected")

        return claims


class SessionTicketManager:
    """
    短期会话票据，用于已信任节点断线重连，避免重复 TOFU/Token 流程。
    不是单次使用，但有效期短且绑定 node_uuid + fingerprint。
    """

    def __init__(self, secret: bytes, ttl_seconds: int = 300) -> None:
        if len(secret) < 32:
            raise ValueError("session secret must be at least 32 bytes")
        self.secret = secret + b":session-ticket"
        self.ttl_seconds = ttl_seconds

    def issue(self, node_uuid: str, fingerprint: str) -> str:
        now = int(time.time())
        payload = json.dumps(
            {
                "node_uuid": node_uuid,
                "fp": fingerprint,
                "iat": now,
                "exp": now + self.ttl_seconds,
            },
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        signature = hmac.new(self.secret, payload, hashlib.sha256).digest()
        return f"{_b64e(payload)}.{_b64e(signature)}"

    def verify(self, ticket: str) -> dict:
        try:
            payload_b64, signature_b64 = ticket.split(".", 1)
            payload = _b64d(payload_b64)
            signature = _b64d(signature_b64)
        except Exception as exc:
            raise TokenError("malformed session ticket") from exc

        expected = hmac.new(self.secret, payload, hashlib.sha256).digest()
        if not hmac.compare_digest(signature, expected):
            raise TokenError("bad session ticket signature")

        try:
            data = json.loads(payload.decode("utf-8"))
        except Exception as exc:
            raise TokenError("bad session ticket payload") from exc

        if int(data.get("exp", 0)) <= int(time.time()):
            raise TokenError("session ticket expired")
        return data