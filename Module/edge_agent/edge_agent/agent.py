from __future__ import annotations

import asyncio
import ipaddress
import ssl
import time
from typing import Awaitable, Callable, Optional

from .audit import AuditLogger
from .config import Config
from .local_bypass import LocalBypassManager
from .models import (
    AccessDecision,
    AccessDecisionResult,
    ConnectionContext,
    TrustStatus,
)
from .nat import detect_network_profile
from .policy import AccessPolicyEngine
from .tokens import JoinTokenIssuer, JoinTokenVerifier, SessionTicketManager
from .transport import JsonLineTransport, TunnelDialer, open_reverse_tunnel
from .trust_store import TrustStore

DataHandler = Callable[[JsonLineTransport, ConnectionContext], Awaitable[None]]


class EdgeAgent:
    def __init__(
        self,
        config: Config,
        data_handler: Optional[DataHandler] = None,
    ) -> None:
        if not config.token_secret:
            raise ValueError(
                "EDGE_AGENT_TOKEN_SECRET is required and must be at least 32 bytes"
            )

        self.config = config
        self.config.ensure_dirs()
        self.data_handler = data_handler

        self.audit = AuditLogger(config.audit_log_path)
        self.trust_store = TrustStore(config.trust_db_path)
        self.local_bypass = LocalBypassManager(
            config.local_bypass_token_path,
            required=config.require_local_bypass_token,
        )

        self.token_issuer = JoinTokenIssuer(
            secret=config.token_secret,
            audience=config.token_audience,
            issuer=config.token_issuer,
            max_ttl_seconds=config.token_max_ttl_seconds,
        )
        self.token_verifier = JoinTokenVerifier(
            secret=config.token_secret,
            replay_store=self.trust_store,
            audience=config.token_audience,
            issuer=config.token_issuer,
            max_ttl_seconds=config.token_max_ttl_seconds,
        )
        self.session_manager = SessionTicketManager(
            secret=config.token_secret,
            ttl_seconds=config.session_ticket_ttl_seconds,
        )
        self.policy = AccessPolicyEngine(
            config=config,
            trust_store=self.trust_store,
            token_verifier=self.token_verifier,
            session_manager=self.session_manager,
            local_bypass=self.local_bypass,
            audit=self.audit,
        )

    def _is_loopback(self, ip: str) -> bool:
        try:
            return ipaddress.ip_address(ip).is_loopback
        except ValueError:
            return False

    def context_from_handshake(
        self,
        handshake: dict,
        peer_ip: str,
    ) -> ConnectionContext:
        node_uuid = str(handshake.get("node_uuid", "")).strip()
        fingerprint = str(handshake.get("public_key_fingerprint", "")).strip()
        if not node_uuid:
            raise ValueError("handshake missing node_uuid")
        if not fingerprint:
            raise ValueError("handshake missing public_key_fingerprint")

        advertised_nat_type = handshake.get("nat_type")
        advertised_reverse = handshake.get("reverse_tunnel")
        if advertised_reverse is not None:
            advertised_reverse = bool(advertised_reverse)

        network_profile, nat_type = detect_network_profile(
            self.config,
            advertised_nat_type=str(advertised_nat_type)
            if advertised_nat_type
            else None,
            advertised_reverse=advertised_reverse,
        )

        return ConnectionContext(
            source_ip=peer_ip,
            is_loopback=self._is_loopback(peer_ip),
            node_uuid=node_uuid,
            public_key_fingerprint=fingerprint,
            join_token=handshake.get("join_token"),
            local_bypass_token=handshake.get("local_bypass_token"),
            session_ticket=handshake.get("session_ticket"),
            nat_type=nat_type,
            reverse_tunnel=(network_profile == "nat4_reverse"),
            metadata={
                "user_agent": handshake.get("user_agent"),
                "network_profile": network_profile,
            },
        )

    def authenticate(self, ctx: ConnectionContext) -> AccessDecisionResult:
        result = self.policy.decide(ctx)
        self.audit.emit(
            "access_decision",
            node_uuid=ctx.node_uuid,
            source_ip=ctx.source_ip,
            is_loopback=ctx.is_loopback,
            decision=result.decision.value,
            reason=result.reason,
            network_profile=result.network_profile,
            nat_type=ctx.nat_type,
            fingerprint=ctx.public_key_fingerprint,
            node_status=result.node_status.value if result.node_status else None,
        )
        return result

    def _ok_response(
        self,
        result: AccessDecisionResult,
        ctx: ConnectionContext,
    ) -> dict:
        response = {
            "status": "ok",
            "decision": result.decision.value,
            "network_profile": result.network_profile,
        }
        if result.decision in {
            AccessDecision.ALLOW_LOCAL,
            AccessDecision.ALLOW_TOKEN,
            AccessDecision.ALLOW_SESSION,
        }:
            response["session_ticket"] = self.session_manager.issue(
                ctx.node_uuid, ctx.public_key_fingerprint
            )
        return response

    async def handle_connection(
        self,
        transport: JsonLineTransport,
        peer_ip: str,
    ) -> None:
        try:
            handshake = await transport.read_message()
        except Exception:
            await transport.close()
            return

        try:
            ctx = self.context_from_handshake(handshake, peer_ip)
        except ValueError as exc:
            await transport.write_message(
                {"status": "denied", "reason": str(exc)}
            )
            await transport.close()
            return

        result = self.authenticate(ctx)

        if result.decision == AccessDecision.DENY:
            await transport.write_message(
                {"status": "denied", "reason": result.reason}
            )
            await transport.close()
            return

        if result.decision == AccessDecision.PENDING_TOFU:
            await transport.write_message(
                {
                    "status": "pending_tofu",
                    "reason": result.reason,
                    "network_profile": result.network_profile,
                }
            )
            await self._quarantine(transport, ctx)
            return

        await transport.write_message(self._ok_response(result, ctx))
        await self._run_data(transport, ctx)

    async def _quarantine(
        self,
        transport: JsonLineTransport,
        ctx: ConnectionContext,
    ) -> None:
        """
        TOFU 隔离区：只发送心跳，不允许业务数据中继，直到管理员 approve。
        """
        while True:
            node = self.trust_store.get_node(ctx.node_uuid)

            if node is not None and node.status == TrustStatus.TRUSTED:
                await transport.write_message(
                    {
                        "status": "approved",
                        "decision": "tofu_approved",
                        "network_profile": node.network_profile,
                        "session_ticket": self.session_manager.issue(
                            ctx.node_uuid, ctx.public_key_fingerprint
                        ),
                    }
                )
                await self._run_data(transport, ctx)
                return

            if node is not None and node.status == TrustStatus.REVOKED:
                await transport.write_message(
                    {"status": "revoked", "reason": "node_revoked"}
                )
                await transport.close()
                return

            try:
                await transport.write_message(
                    {
                        "status": "pending_tofu",
                        "heartbeat": int(time.time()),
                    }
                )
            except Exception:
                await transport.close()
                return

            await asyncio.sleep(self.config.tofu_heartbeat_seconds)

    async def _run_data(
        self,
        transport: JsonLineTransport,
        ctx: ConnectionContext,
    ) -> None:
        if self.data_handler is not None:
            await self.data_handler(transport, ctx)
            return

        # 默认无业务处理器时，只提供最小 ping/close 保活语义。
        while True:
            try:
                msg = await transport.read_message()
            except Exception:
                await transport.close()
                return

            msg_type = msg.get("type")
            if msg_type == "ping":
                await transport.write_message(
                    {"type": "pong", "ts": int(time.time())}
                )
            elif msg_type == "close":
                await transport.close()
                return
            else:
                await transport.write_message(
                    {
                        "type": "error",
                        "reason": "no_data_handler_configured",
                    }
                )

    def _reverse_context(self) -> ConnectionContext:
        nat_type = self.config.nat_type or "nat4"
        return ConnectionContext(
            source_ip="reverse-tunnel",
            is_loopback=False,
            node_uuid=self.config.node_uuid,
            public_key_fingerprint=self.config.public_key_fingerprint,
            join_token=self.config.join_token,
            nat_type=nat_type,
            reverse_tunnel=True,
            metadata={"mode": "reverse_tunnel"},
        )

    async def run_reverse_tunnel(
        self,
        url: str,
        dialer: TunnelDialer,
        ssl_context: ssl.SSLContext,
        server_hostname: Optional[str] = None,
    ) -> None:
        """
        NAT4 反向隧道客户端循环。
        认证由中心端执行；Agent 只发送 handshake 并等待 ok/approved/pending/denied。
        """
        if not self.config.node_uuid:
            raise ValueError("EDGE_AGENT_NODE_UUID is required for reverse tunnel")
        if not self.config.public_key_fingerprint:
            raise ValueError(
                "EDGE_AGENT_PUBLIC_KEY_FINGERPRINT is required for reverse tunnel"
            )

        ctx = self._reverse_context()
        backoff = 1

        while True:
            transport: Optional[JsonLineTransport] = None
            try:
                transport = await open_reverse_tunnel(
                    url=url,
                    dialer=dialer,
                    ssl_context=ssl_context,
                    server_hostname=server_hostname
                    or self.config.tls_server_name
                    or "",
                    certificate_pin_sha256=self.config.certificate_pin_sha256,
                )

                await transport.write_message(
                    {
                        "node_uuid": self.config.node_uuid,
                        "public_key_fingerprint": self.config.public_key_fingerprint,
                        "join_token": self.config.join_token,
                        "nat_type": self.config.nat_type or "nat4",
                        "reverse_tunnel": True,
                        "user_agent": "edge-agent-reverse/1.0",
                    }
                )

                while True:
                    response = await transport.read_message()
                    status = response.get("status")

                    if status in {"ok", "approved"}:
                        backoff = 1
                        await self._run_data(transport, ctx)
                        break

                    if status == "pending_tofu":
                        # 中心端尚未审批，保持连接等待下一条 approved/denied。
                        continue

                    if status in {"denied", "revoked"}:
                        await transport.close()
                        break

                    await transport.close()
                    break

            except Exception:
                if transport is not None:
                    await transport.close()
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60)