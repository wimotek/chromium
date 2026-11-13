# -*- coding: utf-8 -*-
"""
Edge Agent Enterprise Service (Powered by wimotek-edge-agent)
集成官方 PyPI 标准模块 wimotek-edge-agent：
1. 单次高熵 40 字符 Base64URL HMAC Join Token 签发与防重放核销
2. 基于 SQLite WAL 的 TrustStore 节点零信任态生命周期管理 (trusted, pending_tofu, revoked)
3. 线程安全结构化 JSONL 审计流水记录 (带 10MB 自动轮转与备份归档)
4. 标准化 NAT 与拓扑配置探测 (direct vs nat4_reverse)
"""
import os
import secrets
from pathlib import Path
from typing import Optional, Dict, Any, List

from wimotek_edge_agent.config import Config
from wimotek_edge_agent.trust_store import TrustStore
from wimotek_edge_agent.tokens import JoinTokenIssuer, JoinTokenVerifier, JoinTokenClaims, TokenError
from wimotek_edge_agent.audit import AuditLogger
from wimotek_edge_agent.models import (
    AccessDecision,
    AccessDecisionResult,
    ConnectionContext,
    TrustStatus,
    NodeRecord
)
from wimotek_edge_agent.nat import detect_network_profile

class EdgeAgentService:
    _instance: Optional['EdgeAgentService'] = None

    def __init__(self):
        # 确定数据持久化目录
        base_dir = os.environ.get("DATA_DIR", "/data")
        self.data_dir = Path(base_dir) / "edge_agent_data"
        self.data_dir.mkdir(parents=True, exist_ok=True)

        # 确保持久化 Token 签名密钥 (>= 32 字节)
        secret_file = self.data_dir / "master_secret.key"
        if secret_file.exists():
            with open(secret_file, "rb") as f:
                self.secret_bytes = f.read().strip()
        else:
            self.secret_bytes = secrets.token_bytes(32)
            with open(secret_file, "wb") as f:
                f.write(self.secret_bytes)

        # 初始化 wimotek-edge-agent 核心组件
        self.config = Config(
            token_secret=self.secret_bytes.decode("latin1", errors="ignore") if isinstance(self.secret_bytes, bytes) else self.secret_bytes,
            data_dir=self.data_dir,
            audit_max_bytes=10 * 1024 * 1024, # 10MB 自动轮换
            audit_backup_count=5
        )
        self.config.token_secret = self.secret_bytes

        self.trust_store = TrustStore(self.data_dir / "trust_store.sqlite3")
        self.token_issuer = JoinTokenIssuer(secret=self.secret_bytes, store=self.trust_store)
        self.token_verifier = JoinTokenVerifier(secret=self.secret_bytes, replay_store=self.trust_store, store=self.trust_store)
        self.audit_logger = AuditLogger(
            self.data_dir / "audit.jsonl",
            max_bytes=10 * 1024 * 1024,
            backup_count=5
        )

    @classmethod
    def get_instance(cls) -> 'EdgeAgentService':
        if cls._instance is None:
            cls._instance = EdgeAgentService()
        return cls._instance

    def issue_token(
        self,
        node_group: str = "default",
        ttl_seconds: int = 600,
        node_uuid: Optional[str] = None,
        allowed_ip_cidr: Optional[str] = None
    ) -> str:
        """
        签发高强度 40 字符紧凑单次 Join Token (Base64URL，内置防重放 JTI 与 HMAC 签名)
        """
        return self.token_issuer.issue(
            node_group=node_group,
            ttl_seconds=ttl_seconds,
            node_uuid=node_uuid,
            allowed_ip_cidr=allowed_ip_cidr
        )

    def verify_token(
        self,
        token: str,
        source_ip: str,
        node_uuid: str
    ) -> Optional[JoinTokenClaims]:
        """
        核验单次 Join Token：
        - 验证 HMAC-SHA256 签名合法性
        - 验证过期时间
        - 验证目标 node_uuid 与 IP CIDR 白名单
        - 原子性移入 used_tokens，防止重放攻击
        """
        try:
            claims = self.token_verifier.verify(token=token, source_ip=source_ip, node_uuid=node_uuid)
            return claims
        except TokenError as e:
            return None
        except Exception:
            return None

    def log_access(
        self,
        source_ip: str,
        node_uuid: str,
        fingerprint: str,
        decision: AccessDecision,
        reason: str,
        network_profile: str = "direct",
        nat_type: str = "unknown",
        node_status: str = "trusted",
        join_token: Optional[str] = None
    ):
        """
        记录高保真结构化审计日志 (自动按 10MB 切割归档，防止磁盘被日志撑爆)
        """
        try:
            ctx = ConnectionContext(
                source_ip=source_ip,
                is_loopback=source_ip in ("127.0.0.1", "::1"),
                node_uuid=node_uuid,
                public_key_fingerprint=fingerprint or "unknown",
                join_token=join_token,
                nat_type=nat_type,
                reverse_tunnel=(network_profile == "nat4_reverse")
            )
            dec_result = AccessDecisionResult(
                decision=decision,
                reason=reason,
                network_profile=network_profile,
                node_status=TrustStatus(node_status) if node_status in ("pending", "trusted", "revoked") else None
            )
            self.audit_logger.log(ctx, dec_result, node_status=node_status)
        except Exception:
            pass

    def get_audit_log_path(self) -> Path:
        return self.data_dir / "audit.jsonl"

    def clean_audit_log(self, keep_lines: int = 500) -> int:
        """
        安全清理审计日志 (支持保留最近 N 行或完全清空)
        """
        audit_file = self.get_audit_log_path()
        if not audit_file.exists():
            return 0
        try:
            with open(audit_file, "r", encoding="utf-8") as f:
                lines = f.readlines()
            total = len(lines)
            if keep_lines <= 0:
                with open(audit_file, "w", encoding="utf-8") as f:
                    f.truncate(0)
                return total
            if len(lines) > keep_lines:
                with open(audit_file, "w", encoding="utf-8") as f:
                    f.writelines(lines[-keep_lines:])
                return total - keep_lines
            return 0
        except Exception:
            return 0
