from __future__ import annotations

from .audit import AuditLogger
from .config import Config
from .local_bypass import LocalBypassManager
from .models import (
    AccessDecision,
    AccessDecisionResult,
    ConnectionContext,
    TrustStatus,
)
from .tokens import JoinTokenVerifier, SessionTicketManager, TokenError
from .trust_store import TrustStore


class AccessPolicyEngine:
    """
    三层策略引擎：
    1. 本地回环：local_bypass_token 校验后放行。
    2. 外网 + token：验证 Edge Agent token，成功即绑定信任。
    3. 外网无 token：TOFU 隔离待审核。
    NAT4 / 反向隧道只改变 network_profile，不降低认证强度。
    """

    def __init__(
        self,
        config: Config,
        trust_store: TrustStore,
        token_verifier: JoinTokenVerifier,
        session_manager: SessionTicketManager,
        local_bypass: LocalBypassManager,
        audit: AuditLogger,
    ) -> None:
        self.config = config
        self.trust_store = trust_store
        self.token_verifier = token_verifier
        self.session_manager = session_manager
        self.local_bypass = local_bypass
        self.audit = audit

    def decide(self, ctx: ConnectionContext) -> AccessDecisionResult:
        network_profile = "nat4_reverse" if ctx.reverse_tunnel else "direct"

        existing = self.trust_store.get_node(ctx.node_uuid)

        # 已撤销节点，无论来源一律拒绝。
        if existing is not None and existing.status == TrustStatus.REVOKED:
            return AccessDecisionResult(
                AccessDecision.DENY,
                "node_revoked",
                network_profile,
                existing.status,
            )

        # 1. 本地连接：默认放行，但商业默认要求 local_bypass_token。
        if ctx.is_loopback:
            if self.local_bypass.verify(ctx.local_bypass_token):
                return AccessDecisionResult(
                    AccessDecision.ALLOW_LOCAL,
                    "local_loopback_bypass_ok",
                    network_profile,
                    existing.status if existing else None,
                )
            return AccessDecisionResult(
                AccessDecision.DENY,
                "local_bypass_token_required_or_invalid",
                network_profile,
                existing.status if existing else None,
            )

        # 2. 外网 + Edge Agent token。
        if ctx.join_token:
            try:
                self.token_verifier.verify(
                    token=ctx.join_token,
                    source_ip=ctx.source_ip,
                    node_uuid=ctx.node_uuid,
                )
            except TokenError as exc:
                return AccessDecisionResult(
                    AccessDecision.DENY,
                    f"token_invalid:{exc}",
                    network_profile,
                    existing.status if existing else None,
                )

            self.trust_store.bind_token(
                node_uuid=ctx.node_uuid,
                fingerprint=ctx.public_key_fingerprint,
                network_profile=network_profile,
                metadata=ctx.metadata,
            )
            return AccessDecisionResult(
                AccessDecision.ALLOW_TOKEN,
                "edge_agent_token_verified",
                network_profile,
                TrustStatus.TRUSTED,
            )

        # 3. 已信任节点短期会话票据重连。
        if ctx.session_ticket:
            try:
                ticket_data = self.session_manager.verify(ctx.session_ticket)
            except TokenError:
                ticket_data = None

            if (
                ticket_data
                and ticket_data.get("node_uuid") == ctx.node_uuid
                and ticket_data.get("fp") == ctx.public_key_fingerprint
                and self.trust_store.is_trusted(
                    ctx.node_uuid, ctx.public_key_fingerprint
                )
            ):
                return AccessDecisionResult(
                    AccessDecision.ALLOW_SESSION,
                    "trusted_session_ticket_verified",
                    network_profile,
                    TrustStatus.TRUSTED,
                )

        # 已信任节点不允许无 token/session 降级回 TOFU。
        if existing is not None and existing.status == TrustStatus.TRUSTED:
            if existing.fingerprint != ctx.public_key_fingerprint:
                reason = "trusted_node_fingerprint_mismatch"
            else:
                reason = "trusted_node_requires_token_or_session"
            return AccessDecisionResult(
                AccessDecision.DENY,
                reason,
                network_profile,
                existing.status,
            )

        # 待审核节点指纹不一致，拒绝，防止首次 TOFU 被覆盖。
        if (
            existing is not None
            and existing.status == TrustStatus.PENDING
            and existing.fingerprint != ctx.public_key_fingerprint
        ):
            return AccessDecisionResult(
                AccessDecision.DENY,
                "pending_node_fingerprint_mismatch",
                network_profile,
                existing.status,
            )

        # 4. TOFU 隔离待审核。
        self.trust_store.upsert_pending(
            node_uuid=ctx.node_uuid,
            fingerprint=ctx.public_key_fingerprint,
            network_profile=network_profile,
            metadata=ctx.metadata,
        )
        return AccessDecisionResult(
            AccessDecision.PENDING_TOFU,
            "tofu_pending_admin_approval",
            network_profile,
            TrustStatus.PENDING,
        )