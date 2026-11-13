from __future__ import annotations

import asyncio
import ipaddress
import ssl
import time
from pathlib import Path
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
from .nat import (
    NetworkDetectionResult,
    ProbeFn,
    detect_network_mode,
    detect_network_mode_sync,
    detect_network_profile,
)
from .policy import AccessPolicyEngine
from .tokens import JoinTokenIssuer, JoinTokenVerifier, SessionTicketManager
from .transport import JsonLineTransport, TunnelDialer, open_reverse_tunnel
from .trust_store import TrustStore

DataHandler = Callable[[JsonLineTransport, ConnectionContext], Awaitable[None]]


def _parse_int_port(value: object) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _split_host_port(
    host: Optional[str], port: Optional[int], family: str
) -> tuple[Optional[str], Optional[int]]:
    if not host:
        return None, port
    cleaned = str(host).strip()
    if not cleaned:
        return None, port
    if port is None:
        if family == "ipv4" and ":" in cleaned and cleaned.count(":") == 1:
            h, p = cleaned.rsplit(":", 1)
            return h.strip(), _parse_int_port(p)
        if family == "ipv6" and cleaned.startswith("[") and "]:" in cleaned:
            h, p = cleaned[1:].split("]:", 1)
            return h.strip(), _parse_int_port(p)
    if family == "ipv6" and cleaned.startswith("[") and cleaned.endswith("]"):
        cleaned = cleaned[1:-1]
    return cleaned, port


class EdgeAgent:
    def __init__(
        self,
        config: Config,
        data_handler: Optional[DataHandler] = None,
        probe_fn: Optional[ProbeFn] = None,
    ) -> None:
        if not config.token_secret:
            raise ValueError(
                "EDGE_AGENT_TOKEN_SECRET is required and must be at least 32 bytes"
            )

        self.config = config
        self.config.ensure_dirs()
        self.data_handler = data_handler
        self.probe_fn = probe_fn
        self.last_network_mode: Optional[str] = None
        self.last_network_detection: Optional[NetworkDetectionResult] = None

        self.audit = AuditLogger(
            config.audit_log_path,
            max_bytes=config.audit_max_bytes,
            backup_count=config.audit_backup_count,
        )
        self.trust_store = TrustStore(config.trust_db_path)
        self.local_bypass = LocalBypassManager(
            config.local_bypass_token_path,
            required=config.require_local_bypass_token,
        )

        self.token_issuer = JoinTokenIssuer(
            secret=config.token_secret,
            store=self.trust_store,
            audience=config.token_audience,
            issuer=config.token_issuer,
            max_ttl_seconds=config.token_max_ttl_seconds,
        )
        self.token_verifier = JoinTokenVerifier(
            secret=config.token_secret,
            replay_store=self.trust_store,
            store=self.trust_store,
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

    def _extract_reported_endpoints(
        self, handshake: dict
    ) -> tuple[Optional[str], Optional[int], Optional[str], Optional[int]]:
        shared_port = _parse_int_port(handshake.get("port"))
        v4_raw = handshake.get("public_ipv4") or handshake.get("ipv4")
        v4_port = _parse_int_port(
            handshake.get("public_ipv4_port") or handshake.get("ipv4_port")
        )
        v4_host, v4_port = _split_host_port(v4_raw, v4_port, "ipv4")
        if v4_host and v4_port is None:
            v4_port = shared_port

        v6_raw = handshake.get("public_ipv6") or handshake.get("ipv6")
        v6_port = _parse_int_port(
            handshake.get("public_ipv6_port") or handshake.get("ipv6_port")
        )
        v6_host, v6_port = _split_host_port(v6_raw, v6_port, "ipv6")
        if v6_host and v6_port is None:
            v6_port = shared_port

        return v4_host, v4_port, v6_host, v6_port

    async def detect_remote_network(
        self,
        handshake: Optional[dict] = None,
        public_ipv4: Optional[str] = None,
        public_ipv4_port: Optional[int] = None,
        public_ipv6: Optional[str] = None,
        public_ipv6_port: Optional[int] = None,
        timeout: Optional[float] = None,
        allow_non_public: Optional[bool] = None,
    ) -> NetworkDetectionResult:
        if handshake is not None:
            h_v4, h_v4_p, h_v6, h_v6_p = self._extract_reported_endpoints(handshake)
            public_ipv4 = public_ipv4 or h_v4
            public_ipv4_port = public_ipv4_port if public_ipv4_port is not None else h_v4_p
            public_ipv6 = public_ipv6 or h_v6
            public_ipv6_port = public_ipv6_port if public_ipv6_port is not None else h_v6_p

        result = await detect_network_mode(
            public_ipv4=public_ipv4,
            public_ipv4_port=public_ipv4_port,
            public_ipv6=public_ipv6,
            public_ipv6_port=public_ipv6_port,
            timeout=timeout if timeout is not None else self.config.network_probe_timeout_seconds,
            allow_non_public=(
                allow_non_public
                if allow_non_public is not None
                else self.config.allow_non_public_probe
            ),
            force_reverse=self.config.reverse_tunnel,
            probe_fn=self.probe_fn,
        )
        self.last_network_detection = result
        self.audit.emit(
            "network_detected",
            network_mode=result.network_mode,
            network_profile=result.network_profile,
            ipv4_reachable=result.ipv4_reachable,
            ipv6_reachable=result.ipv6_reachable,
            recommended_endpoint=result.recommended_endpoint,
            public_ipv4=public_ipv4,
            public_ipv4_port=public_ipv4_port,
            public_ipv6=public_ipv6,
            public_ipv6_port=public_ipv6_port,
        )
        return result

    def detect_remote_network_sync(
        self,
        handshake: Optional[dict] = None,
        public_ipv4: Optional[str] = None,
        public_ipv4_port: Optional[int] = None,
        public_ipv6: Optional[str] = None,
        public_ipv6_port: Optional[int] = None,
        timeout: Optional[float] = None,
        allow_non_public: Optional[bool] = None,
    ) -> NetworkDetectionResult:
        if handshake is not None:
            h_v4, h_v4_p, h_v6, h_v6_p = self._extract_reported_endpoints(handshake)
            public_ipv4 = public_ipv4 or h_v4
            public_ipv4_port = public_ipv4_port if public_ipv4_port is not None else h_v4_p
            public_ipv6 = public_ipv6 or h_v6
            public_ipv6_port = public_ipv6_port if public_ipv6_port is not None else h_v6_p

        result = detect_network_mode_sync(
            public_ipv4=public_ipv4,
            public_ipv4_port=public_ipv4_port,
            public_ipv6=public_ipv6,
            public_ipv6_port=public_ipv6_port,
            timeout=timeout if timeout is not None else self.config.network_probe_timeout_seconds,
            allow_non_public=(
                allow_non_public
                if allow_non_public is not None
                else self.config.allow_non_public_probe
            ),
            force_reverse=self.config.reverse_tunnel,
            probe_fn=self.probe_fn,
        )
        self.last_network_detection = result
        return result

    def context_from_handshake(
        self,
        handshake: dict,
        peer_ip: str,
        network_detection: Optional[NetworkDetectionResult] = None,
    ) -> ConnectionContext:
        node_uuid = str(handshake.get("node_uuid", "")).strip()
        fingerprint = str(handshake.get("public_key_fingerprint", "")).strip()
        if not node_uuid:
            raise ValueError("handshake missing node_uuid")
        if not fingerprint:
            raise ValueError("handshake missing public_key_fingerprint")

        v4_host, v4_port, v6_host, v6_port = self._extract_reported_endpoints(handshake)
        has_reported_endpoints = bool(v4_host or v6_host)

        advertised_nat_type = handshake.get("nat_type")
        advertised_reverse = handshake.get("reverse_tunnel")
        if advertised_reverse is not None:
            advertised_reverse = bool(advertised_reverse)

        if network_detection is None and has_reported_endpoints and not advertised_reverse:
            network_detection = self.detect_remote_network_sync(
                public_ipv4=v4_host,
                public_ipv4_port=v4_port,
                public_ipv6=v6_host,
                public_ipv6_port=v6_port,
            )

        if network_detection is not None:
            network_profile = network_detection.network_profile
            network_mode = network_detection.network_mode
            nat_type = str(advertised_nat_type or "probed").lower()
        else:
            network_profile, nat_type = detect_network_profile(
                self.config,
                advertised_nat_type=str(advertised_nat_type)
                if advertised_nat_type
                else None,
                advertised_reverse=advertised_reverse,
            )
            network_mode = (
                "reverse_tunnel" if network_profile == "nat4_reverse" else "direct"
            )

        metadata = {
            "user_agent": handshake.get("user_agent"),
            "network_profile": network_profile,
            "network_mode": network_mode,
        }
        if network_detection is not None:
            metadata["network_probe"] = network_detection.to_dict()

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
            public_ipv4=v4_host,
            public_ipv4_port=v4_port,
            public_ipv6=v6_host,
            public_ipv6_port=v6_port,
            network_mode=network_mode,
            metadata=metadata,
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
            network_mode=result.network_mode,
            nat_type=ctx.nat_type,
            fingerprint=ctx.public_key_fingerprint,
            node_status=result.node_status.value if result.node_status else None,
        )
        return result

    def _network_feedback_fields(
        self,
        result: AccessDecisionResult,
        ctx: ConnectionContext,
        network_detection: Optional[NetworkDetectionResult] = None,
    ) -> dict:
        payload: dict = {
            "network_profile": result.network_profile,
            "network_mode": result.network_mode
            or ctx.network_mode
            or ("reverse_tunnel" if result.network_profile == "nat4_reverse" else "direct"),
        }
        if network_detection is not None:
            payload.update(
                {
                    "ipv4_reachable": network_detection.ipv4_reachable,
                    "ipv6_reachable": network_detection.ipv6_reachable,
                    "recommended_endpoint": network_detection.recommended_endpoint,
                    "probe_results": {
                        "ipv4": network_detection.to_dict()["ipv4"],
                        "ipv6": network_detection.to_dict()["ipv6"],
                    },
                }
            )
        return payload

    def _ok_response(
        self,
        result: AccessDecisionResult,
        ctx: ConnectionContext,
        network_detection: Optional[NetworkDetectionResult] = None,
    ) -> dict:
        response = {
            "status": "ok",
            "decision": result.decision.value,
            **self._network_feedback_fields(result, ctx, network_detection),
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

        network_detection: Optional[NetworkDetectionResult] = None
        v4_host, v4_port, v6_host, v6_port = self._extract_reported_endpoints(handshake)
        if (v4_host or v6_host) and not handshake.get("reverse_tunnel"):
            network_detection = await self.detect_remote_network(
                public_ipv4=v4_host,
                public_ipv4_port=v4_port,
                public_ipv6=v6_host,
                public_ipv6_port=v6_port,
            )

        try:
            ctx = self.context_from_handshake(
                handshake, peer_ip, network_detection=network_detection
            )
        except ValueError as exc:
            await transport.write_message(
                {"status": "denied", "reason": str(exc)}
            )
            await transport.close()
            return

        result = self.authenticate(ctx)

        if result.decision == AccessDecision.DENY:
            await transport.write_message(
                {
                    "status": "denied",
                    "reason": result.reason,
                    **self._network_feedback_fields(result, ctx, network_detection),
                }
            )
            await transport.close()
            return

        if result.decision == AccessDecision.PENDING_TOFU:
            await transport.write_message(
                {
                    "status": "pending_tofu",
                    "reason": result.reason,
                    **self._network_feedback_fields(result, ctx, network_detection),
                }
            )
            await self._quarantine(transport, ctx, network_detection)
            return

        await transport.write_message(
            self._ok_response(result, ctx, network_detection)
        )
        await self._run_data(transport, ctx)

    async def _quarantine(
        self,
        transport: JsonLineTransport,
        ctx: ConnectionContext,
        network_detection: Optional[NetworkDetectionResult] = None,
    ) -> None:
        """
        TOFU 隔离区：只发送心跳，不允许业务数据中继，直到管理员 approve。
        """
        while True:
            node = self.trust_store.get_node(ctx.node_uuid)

            if node is not None and node.status == TrustStatus.TRUSTED:
                approved_payload = {
                    "status": "approved",
                    "decision": "tofu_approved",
                    "network_profile": node.network_profile,
                    "network_mode": ctx.network_mode
                    or (
                        "reverse_tunnel"
                        if node.network_profile == "nat4_reverse"
                        else "direct"
                    ),
                    "session_ticket": self.session_manager.issue(
                        ctx.node_uuid, ctx.public_key_fingerprint
                    ),
                }
                if network_detection is not None:
                    approved_payload.update(
                        {
                            "ipv4_reachable": network_detection.ipv4_reachable,
                            "ipv6_reachable": network_detection.ipv6_reachable,
                            "recommended_endpoint": network_detection.recommended_endpoint,
                        }
                    )
                await transport.write_message(approved_payload)
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
            elif msg_type == "network_probe":
                detection = await self.detect_remote_network(handshake=msg)
                await transport.write_message(
                    {"type": "network_probe_result", **detection.to_dict()}
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

                handshake_payload = {
                    "node_uuid": self.config.node_uuid,
                    "public_key_fingerprint": self.config.public_key_fingerprint,
                    "join_token": self.config.join_token,
                    "nat_type": self.config.nat_type or "nat4",
                    "reverse_tunnel": True,
                    "user_agent": "edge-agent-reverse/1.0",
                }
                if self.config.public_ipv4:
                    handshake_payload["public_ipv4"] = self.config.public_ipv4
                if self.config.public_ipv4_port is not None:
                    handshake_payload["public_ipv4_port"] = self.config.public_ipv4_port
                if self.config.public_ipv6:
                    handshake_payload["public_ipv6"] = self.config.public_ipv6
                if self.config.public_ipv6_port is not None:
                    handshake_payload["public_ipv6_port"] = self.config.public_ipv6_port

                await transport.write_message(handshake_payload)

                while True:
                    response = await transport.read_message()
                    if "network_mode" in response:
                        self.last_network_mode = response.get("network_mode")
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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="wimotek-edge-agent",
        description="Universal Edge Tunnel & Access Policy Agent",
    )
    parser.add_argument(
        "--data-dir",
        type=str,
        default=None,
        help="Custom path for edge agent data directory",
    )
    parser.add_argument(
        "--secret",
        type=str,
        default=None,
        help="HMAC secret key (min 32 bytes) or env EDGE_AGENT_TOKEN_SECRET",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    # 1. listen
    p_listen = subparsers.add_parser("listen", help="Start direct TLS/TCP listener")
    p_listen.add_argument("--host", default="0.0.0.0", help="Listen host (default 0.0.0.0)")
    p_listen.add_argument("--port", type=int, default=8443, help="Listen port (default 8443)")
    p_listen.add_argument("--cert", default=None, help="Path to TLS certificate file")
    p_listen.add_argument("--key", default=None, help="Path to TLS private key file")

    # 2. approve
    p_app = subparsers.add_parser("approve", help="Approve a pending TOFU node")
    p_app.add_argument("--node-uuid", required=True, help="Target node UUID")
    p_app.add_argument("--fingerprint", default=None, help="Expected public key fingerprint")

    # 3. revoke
    p_rev = subparsers.add_parser("revoke", help="Revoke a trusted node")
    p_rev.add_argument("--node-uuid", required=True, help="Target node UUID")

    # 4. show-node
    p_show = subparsers.add_parser("show-node", help="Inspect a node record")
    p_show.add_argument("--node-uuid", required=True, help="Target node UUID")

    # 5. list-nodes
    p_list = subparsers.add_parser("list-nodes", help="List nodes in Trust Store")
    p_list.add_argument(
        "--status",
        choices=["pending", "trusted", "revoked", "all"],
        default="all",
        help="Filter by trust status",
    )
    p_list.add_argument("--json", action="store_true", help="Output JSON lines")

    # 6. delete-node
    p_del = subparsers.add_parser("delete-node", help="Delete a node record")
    p_del.add_argument("--node-uuid", required=True, help="Target node UUID")

    # 7. issue-token
    p_iss = subparsers.add_parser("issue-token", help="Issue single-use HMAC join token")
    p_iss.add_argument("--node-group", default="default", help="Node group tag")
    p_iss.add_argument("--ttl", type=int, default=300, help="TTL in seconds (default 300)")
    p_iss.add_argument("--node-uuid", default=None, help="Bind token to specific node UUID")
    p_iss.add_argument("--allowed-ip-cidr", default=None, help="Bind token to source IP/CIDR")

    # 8. verify-token
    p_ver = subparsers.add_parser("verify-token", help="Verify a join token")
    p_ver.add_argument("--token", required=True, help="Join token string")
    p_ver.add_argument("--source-ip", default="127.0.0.1", help="Source IP to test against")
    p_ver.add_argument("--node-uuid", default="", help="Node UUID to test against")

    # 9. generate-secret
    subparsers.add_parser("generate-secret", help="Generate a high-entropy 48-byte secret")

    # 10. bypass-token
    subparsers.add_parser("bypass-token", help="Ensure and show local bypass token")

    # 11. stats
    subparsers.add_parser("stats", help="Show summary statistics of Trust Store")

    # 12. simulate
    p_sim = subparsers.add_parser("simulate", help="Simulate Access Policy handshake")
    p_sim.add_argument("--source-ip", default="127.0.0.1")
    p_sim.add_argument("--node-uuid", default="sim-node-1")
    p_sim.add_argument("--fingerprint", default="sha256:simulated")
    p_sim.add_argument("--join-token", default=None)
    p_sim.add_argument("--local-bypass-token", default=None)
    p_sim.add_argument("--session-ticket", default=None)
    p_sim.add_argument("--reverse-tunnel", action="store_true")
    p_sim.add_argument("--nat-type", default="unknown")
    p_sim.add_argument("--ipv4", default=None, help="Remote node reported public IPv4")
    p_sim.add_argument("--ipv4-port", type=int, default=None, help="Remote node reported IPv4 port")
    p_sim.add_argument("--ipv6", default=None, help="Remote node reported public IPv6")
    p_sim.add_argument("--ipv6-port", type=int, default=None, help="Remote node reported IPv6 port")
    p_sim.add_argument("--timeout", type=float, default=2.0, help="Probe timeout seconds")
    p_sim.add_argument("--allow-non-public", action="store_true", help="Allow probing private/loopback IPs")

    # 13. detect-network
    p_det = subparsers.add_parser(
        "detect-network",
        help="Probe remote node public IPv4/IPv6 ports and determine network mode",
    )
    p_det.add_argument("--ipv4", default=None, help="Remote node public IPv4")
    p_det.add_argument("--ipv4-port", type=int, default=None, help="Remote node IPv4 port")
    p_det.add_argument("--ipv6", default=None, help="Remote node public IPv6")
    p_det.add_argument("--ipv6-port", type=int, default=None, help="Remote node IPv6 port")
    p_det.add_argument("--port", type=int, default=None, help="Shared port if IPv4/IPv6 use same port")
    p_det.add_argument("--timeout", type=float, default=2.0, help="TCP probe timeout seconds")
    p_det.add_argument("--allow-non-public", action="store_true", help="Allow probing non-public/loopback IPs")

    # 14. clean-audit
    p_clean = subparsers.add_parser("clean-audit", help="Truncate or clear audit log")
    p_clean.add_argument(
        "--keep",
        type=int,
        default=0,
        help="Keep last N records (default 0, clears all records)",
    )

    return parser


def _init_agent_for_cli(args: argparse.Namespace) -> EdgeAgent:
    config = Config.from_env()
    if args.data_dir:
        config.data_dir = Path(args.data_dir)
    if args.secret:
        config.token_secret = args.secret.encode("utf-8")
    elif not config.token_secret:
        # Default fallback secret for CLI inspection if not configured
        config.token_secret = b"edge-agent-commercial-default-hmac-secret-32b"
    return EdgeAgent(config)


def main(argv: Optional[list[str]] = None) -> int:
    import json
    import sys
    from dataclasses import asdict

    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "generate-secret":
        import secrets
        secret = secrets.token_urlsafe(48)
        print(secret)
        return 0

    agent = _init_agent_for_cli(args)

    if args.command == "bypass-token":
        token = agent.local_bypass.ensure_token()
        print(json.dumps({
            "token": token,
            "path": str(agent.config.local_bypass_token_path),
            "required": agent.config.require_local_bypass_token,
        }, indent=2))
        return 0

    if args.command == "clean-audit":
        retained = agent.audit.clear(keep_last_lines=args.keep)
        agent.audit.emit("audit_log_cleaned", retained_lines=retained, keep_requested=args.keep)
        print(json.dumps({
            "status": "ok",
            "message": f"Audit log cleaned (retained {retained} lines)",
            "retained_lines": retained,
        }, indent=2))
        return 0

    if args.command == "stats":
        stats = agent.trust_store.get_stats()
        print(json.dumps(stats, indent=2))
        return 0

    if args.command == "show-node":
        node = agent.trust_store.get_node(args.node_uuid)
        if node is None:
            sys.stderr.write(f"Node '{args.node_uuid}' not found in trust store.\n")
            return 1
        print(json.dumps(asdict(node), indent=2, ensure_ascii=False))
        return 0

    if args.command == "list-nodes":
        status_filter = None
        if args.status and args.status != "all":
            status_filter = TrustStatus(args.status)
        nodes = agent.trust_store.list_nodes(status_filter)
        if args.json:
            for n in nodes:
                print(json.dumps(asdict(n), ensure_ascii=False))
        else:
            print(json.dumps([asdict(n) for n in nodes], indent=2, ensure_ascii=False))
        return 0

    if args.command == "approve":
        ok = agent.trust_store.approve_tofu(args.node_uuid, args.fingerprint)
        if ok:
            agent.audit.emit("node_approved", node_uuid=args.node_uuid, fingerprint=args.fingerprint)
            print(json.dumps({"status": "ok", "message": f"Node '{args.node_uuid}' approved as TRUSTED"}, indent=2))
            return 0
        else:
            sys.stderr.write(f"Failed to approve node '{args.node_uuid}' (not found or fingerprint mismatch).\n")
            return 1

    if args.command == "revoke":
        ok = agent.trust_store.revoke(args.node_uuid)
        if ok:
            agent.audit.emit("node_revoked", node_uuid=args.node_uuid)
            print(json.dumps({"status": "ok", "message": f"Node '{args.node_uuid}' marked as REVOKED"}, indent=2))
            return 0
        else:
            sys.stderr.write(f"Node '{args.node_uuid}' not found.\n")
            return 1

    if args.command == "delete-node":
        ok = agent.trust_store.delete_node(args.node_uuid)
        if ok:
            agent.audit.emit("node_deleted", node_uuid=args.node_uuid)
            print(json.dumps({"status": "ok", "message": f"Node '{args.node_uuid}' deleted"}, indent=2))
            return 0
        else:
            sys.stderr.write(f"Node '{args.node_uuid}' not found.\n")
            return 1

    if args.command == "issue-token":
        try:
            token = agent.token_issuer.issue(
                node_group=args.node_group,
                ttl_seconds=args.ttl,
                node_uuid=args.node_uuid,
                allowed_ip_cidr=args.allowed_ip_cidr,
            )
            print(token)
            return 0
        except Exception as e:
            sys.stderr.write(f"Failed to issue token: {e}\n")
            return 1

    if args.command == "verify-token":
        try:
            claims = agent.token_verifier.verify(
                token=args.token,
                source_ip=args.source_ip,
                node_uuid=args.node_uuid,
            )
            print(json.dumps(asdict(claims), indent=2))
            return 0
        except Exception as e:
            sys.stderr.write(f"Token verification failed: {e}\n")
            return 1

    if args.command == "detect-network":
        v4_port = args.ipv4_port if args.ipv4_port is not None else args.port
        v6_port = args.ipv6_port if args.ipv6_port is not None else args.port
        detection = agent.detect_remote_network_sync(
            public_ipv4=args.ipv4,
            public_ipv4_port=v4_port,
            public_ipv6=args.ipv6,
            public_ipv6_port=v6_port,
            timeout=args.timeout,
            allow_non_public=True if args.allow_non_public else None,
        )
        print(json.dumps(detection.to_dict(), indent=2, ensure_ascii=False))
        return 0

    if args.command == "simulate":
        is_loop = agent._is_loopback(args.source_ip)
        detection = None
        if (args.ipv4 or args.ipv6) and not args.reverse_tunnel:
            detection = agent.detect_remote_network_sync(
                public_ipv4=args.ipv4,
                public_ipv4_port=args.ipv4_port,
                public_ipv6=args.ipv6,
                public_ipv6_port=args.ipv6_port,
                timeout=args.timeout,
                allow_non_public=True if args.allow_non_public else None,
            )

        network_profile = (
            detection.network_profile
            if detection is not None
            else ("nat4_reverse" if args.reverse_tunnel else "direct")
        )
        network_mode = (
            detection.network_mode
            if detection is not None
            else ("reverse_tunnel" if args.reverse_tunnel else "direct")
        )
        ctx = ConnectionContext(
            source_ip=args.source_ip,
            is_loopback=is_loop,
            node_uuid=args.node_uuid,
            public_key_fingerprint=args.fingerprint,
            join_token=args.join_token,
            local_bypass_token=args.local_bypass_token,
            session_ticket=args.session_ticket,
            nat_type=args.nat_type,
            reverse_tunnel=(network_profile == "nat4_reverse"),
            public_ipv4=args.ipv4,
            public_ipv4_port=args.ipv4_port,
            public_ipv6=args.ipv6,
            public_ipv6_port=args.ipv6_port,
            network_mode=network_mode,
        )
        res = agent.authenticate(ctx)
        out = {
            "decision": res.decision.value,
            "reason": res.reason,
            "network_profile": res.network_profile,
            "network_mode": res.network_mode,
            "node_status": res.node_status.value if res.node_status else None,
        }
        if detection is not None:
            det_dict = detection.to_dict()
            out["ipv4_reachable"] = det_dict["ipv4_reachable"]
            out["ipv6_reachable"] = det_dict["ipv6_reachable"]
            out["recommended_endpoint"] = det_dict["recommended_endpoint"]
            out["probe_results"] = {"ipv4": det_dict["ipv4"], "ipv6": det_dict["ipv6"]}
        print(json.dumps(out, indent=2, ensure_ascii=False))
        return 0

    if args.command == "listen":
        ssl_ctx = None
        if args.cert and args.key:
            import ssl
            ssl_ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
            ssl_ctx.load_cert_chain(certfile=args.cert, keyfile=args.key)

        async def _run_server():
            server = await asyncio.start_server(
                lambda r, w: agent.handle_connection(
                    JsonLineTransport(r, w),
                    w.get_extra_info("peername")[0] if w.get_extra_info("peername") else "unknown",
                ),
                host=args.host,
                port=args.port,
                ssl=ssl_ctx,
            )
            proto = "TLS" if ssl_ctx else "Plain TCP"
            sys.stderr.write(f"[edge-agent] Listening on {args.host}:{args.port} ({proto})\n")
            async with server:
                await server.serve_forever()

        try:
            asyncio.run(_run_server())
        except KeyboardInterrupt:
            sys.stderr.write("[edge-agent] Server stopped by user\n")
            return 0

    return 0


if __name__ == "__main__":
    import argparse
    import sys
    sys.exit(main())
else:
    import argparse