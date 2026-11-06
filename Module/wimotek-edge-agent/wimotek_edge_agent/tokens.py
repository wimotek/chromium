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


class TokenStore(Protocol):
    def save_issued_token(self, token: str, claims: JoinTokenClaims) -> None:
        ...

    def get_issued_token(self, token: str) -> Optional[JoinTokenClaims]:
        ...

    def consume_token(self, jti: str, expires_at: int) -> bool:
        ...


class InMemoryTokenStore:
    """轻量内存 Token 存储，供单测或无 SQLite 场景使用。"""

    def __init__(self) -> None:
        self._tokens: dict[str, JoinTokenClaims] = {}
        self._used: set[str] = set()

    def save_issued_token(self, token: str, claims: JoinTokenClaims) -> None:
        self._tokens[token] = claims

    def get_issued_token(self, token: str) -> Optional[JoinTokenClaims]:
        now = int(time.time())
        claims = self._tokens.get(token)
        if claims and claims.exp < now:
            self._tokens.pop(token, None)
            return None
        return claims

    def is_token_used(self, jti: str) -> bool:
        return jti in self._used

    def consume_token(self, jti: str, expires_at: int) -> bool:
        if jti in self._used:
            return False
        self._used.add(jti)
        self._tokens.pop(jti, None)
        return True


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
    """
    签发单次准入令牌。
    采用 30 字节紧凑编码 (14 字节安全随机 ID + 16 字节 HMAC-SHA256 签名)，
    Base64URL 编码后长度严格为 40 个字符，摆脱 >200 字符的冗长 JWT 结构。
    """

    def __init__(
        self,
        secret: bytes,
        store: Optional[TokenStore] = None,
        audience: str = "edge-agent",
        issuer: str = "central",
        max_ttl_seconds: int = 600,
    ) -> None:
        if len(secret) < 32:
            raise ValueError("token secret must be at least 32 bytes")
        self.secret = secret
        self.store: TokenStore = store if store is not None else InMemoryTokenStore()
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

        # 14 字节密码学高熵安全随机数 (112 位熵)
        token_id = secrets.token_bytes(14)
        # 16 字节 HMAC-SHA256 截断签名 (128 位数字签名防伪)
        sig = hmac.new(self.secret, token_id, hashlib.sha256).digest()[:16]
        # 拼接为恰好 30 字节的紧凑二进制数据
        raw = token_id + sig
        # Base64URL 编码后长度严格为 40 个无填充字符
        token = _b64e(raw)

        claims = JoinTokenClaims(
            jti=token,
            exp=now + ttl_seconds,
            iat=now,
            aud=self.audience,
            iss=self.issuer,
            node_group=node_group,
            node_uuid=node_uuid,
            allowed_ip_cidr=allowed_ip_cidr,
        )
        self.store.save_issued_token(token, claims)
        return token


class JoinTokenVerifier:
    def __init__(
        self,
        secret: bytes,
        replay_store: TokenReplayStore,
        store: Optional[TokenStore] = None,
        audience: str = "edge-agent",
        issuer: str = "central",
        max_ttl_seconds: int = 600,
    ) -> None:
        if len(secret) < 32:
            raise ValueError("token secret must be at least 32 bytes")
        self.secret = secret
        self.replay_store = replay_store
        if store is not None:
            self.store = store
        elif hasattr(replay_store, "get_issued_token"):
            self.store = replay_store  # type: ignore
        else:
            self.store = InMemoryTokenStore()
        self.audience = audience
        self.issuer = issuer
        self.max_ttl_seconds = max_ttl_seconds

    def verify(
        self,
        token: str,
        source_ip: str,
        node_uuid: str,
    ) -> JoinTokenClaims:
        # 兼容旧版带句号 "." 的 JWT 长票据
        if "." in token:
            return self._verify_legacy_jwt(token, source_ip, node_uuid)

        # 紧凑型 40 字符 Token 验证
        try:
            raw = _b64d(token)
            if len(raw) != 30:
                raise TokenError("malformed token length")
            token_id = raw[:14]
            signature = raw[14:]
        except Exception as exc:
            raise TokenError("malformed token") from exc

        # O(1) 密码学签名核对，拦截伪造与垃圾请求
        expected = hmac.new(self.secret, token_id, hashlib.sha256).digest()[:16]
        if not hmac.compare_digest(signature, expected):
            raise TokenError("bad token signature")

        # 载荷查询
        claims = self.store.get_issued_token(token)
        if claims is None:
            # 明确区分：如果在 used_tokens 中已记录，则准确判定为重放拦截
            if hasattr(self.replay_store, "is_token_used") and self.replay_store.is_token_used(token):
                raise TokenError("token replay detected")
            if hasattr(self.store, "is_token_used") and self.store.is_token_used(token):
                raise TokenError("token replay detected")
            raise TokenError("token not found or expired")

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

    def _verify_legacy_jwt(
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