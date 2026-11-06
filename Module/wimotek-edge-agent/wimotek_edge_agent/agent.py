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

    if args.command == "simulate":
        is_loop = agent._is_loopback(args.source_ip)
        ctx = ConnectionContext(
            source_ip=args.source_ip,
            is_loopback=is_loop,
            node_uuid=args.node_uuid,
            public_key_fingerprint=args.fingerprint,
            join_token=args.join_token,
            local_bypass_token=args.local_bypass_token,
            session_ticket=args.session_ticket,
            nat_type=args.nat_type,
            reverse_tunnel=args.reverse_tunnel,
        )
        res = agent.authenticate(ctx)
        out = {
            "decision": res.decision.value,
            "reason": res.reason,
            "network_profile": res.network_profile,
            "node_status": res.node_status.value if res.node_status else None,
        }
        print(json.dumps(out, indent=2))
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