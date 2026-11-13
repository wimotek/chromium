from __future__ import annotations

import os
import secrets
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on", "y"}


def _env_opt_bool(name: str) -> Optional[bool]:
    value = os.getenv(name)
    if value is None:
        return None
    return value.strip().lower() in {"1", "true", "yes", "on", "y"}


@dataclass
class Config:
    """
    商业模块配置。

    安全默认：
    - 本地回环连接也要求 local_bypass_token，避免同主机其他进程直接利用 127.0.0.1。
    - 如需兼容“本地连接默认放行”的旧逻辑，设置：
      EDGE_AGENT_REQUIRE_LOCAL_BYPASS_TOKEN=false
    """

    data_dir: Path = Path("./edge_agent_data")

    require_local_bypass_token: bool = True

    token_secret: bytes = b""
    token_audience: str = "edge-agent"
    token_issuer: str = "central"
    token_max_ttl_seconds: int = 600

    session_ticket_ttl_seconds: int = 300
    tofu_heartbeat_seconds: int = 10

    # 审计日志自动轮转配置
    audit_max_bytes: int = 10 * 1024 * 1024  # 默认 10MB
    audit_backup_count: int = 5              # 默认保留 5 个归档

    # 网络连通性主动探测配置
    network_probe_timeout_seconds: float = 2.0
    allow_non_public_probe: bool = False

    # None 表示自动判断；True 表示强制反向隧道；False 表示强制直连。
    reverse_tunnel: Optional[bool] = None
    nat_type: Optional[str] = None

    # 远程节点上报的公网 IPv4 / IPv6 与端口
    public_ipv4: Optional[str] = None
    public_ipv4_port: Optional[int] = None
    public_ipv6: Optional[str] = None
    public_ipv6_port: Optional[int] = None

    tls_server_name: Optional[str] = None
    certificate_pin_sha256: Optional[str] = None

    # 反向隧道模式下 Agent 自身身份
    node_uuid: str = ""
    public_key_fingerprint: str = ""
    join_token: Optional[str] = None

    @property
    def trust_db_path(self) -> Path:
        return self.data_dir / "trust_store.sqlite3"

    @property
    def audit_log_path(self) -> Path:
        return self.data_dir / "audit.jsonl"

    @property
    def local_bypass_token_path(self) -> Path:
        return self.data_dir / "local_bypass.token"

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        for path in (
            self.trust_db_path.parent,
            self.audit_log_path.parent,
            self.local_bypass_token_path.parent,
        ):
            path.mkdir(parents=True, exist_ok=True)

    @classmethod
    def from_env(cls) -> "Config":
        token_secret_raw = os.getenv("EDGE_AGENT_TOKEN_SECRET", "")
        token_secret = token_secret_raw.encode("utf-8") if token_secret_raw else b""
        v4_port_raw = os.getenv("EDGE_AGENT_PUBLIC_IPV4_PORT", "").strip()
        v6_port_raw = os.getenv("EDGE_AGENT_PUBLIC_IPV6_PORT", "").strip()

        return cls(
            data_dir=Path(os.getenv("EDGE_AGENT_DATA_DIR", "./edge_agent_data")),
            require_local_bypass_token=_env_bool(
                "EDGE_AGENT_REQUIRE_LOCAL_BYPASS_TOKEN", True
            ),
            token_secret=token_secret,
            token_audience=os.getenv("EDGE_AGENT_TOKEN_AUDIENCE", "edge-agent"),
            token_issuer=os.getenv("EDGE_AGENT_TOKEN_ISSUER", "central"),
            token_max_ttl_seconds=int(
                os.getenv("EDGE_AGENT_TOKEN_MAX_TTL_SECONDS", "600")
            ),
            session_ticket_ttl_seconds=int(
                os.getenv("EDGE_AGENT_SESSION_TICKET_TTL_SECONDS", "300")
            ),
            tofu_heartbeat_seconds=int(
                os.getenv("EDGE_AGENT_TOFU_HEARTBEAT_SECONDS", "10")
            ),
            audit_max_bytes=int(
                os.getenv("EDGE_AGENT_AUDIT_MAX_BYTES", str(10 * 1024 * 1024))
            ),
            audit_backup_count=int(
                os.getenv("EDGE_AGENT_AUDIT_BACKUP_COUNT", "5")
            ),
            network_probe_timeout_seconds=float(
                os.getenv("EDGE_AGENT_NETWORK_PROBE_TIMEOUT_SECONDS", "2.0")
            ),
            allow_non_public_probe=_env_bool(
                "EDGE_AGENT_ALLOW_NON_PUBLIC_PROBE", False
            ),
            reverse_tunnel=_env_opt_bool("EDGE_AGENT_REVERSE_TUNNEL"),
            nat_type=os.getenv("EDGE_AGENT_NAT_TYPE") or None,
            public_ipv4=os.getenv("EDGE_AGENT_PUBLIC_IPV4") or None,
            public_ipv4_port=int(v4_port_raw) if v4_port_raw else None,
            public_ipv6=os.getenv("EDGE_AGENT_PUBLIC_IPV6") or None,
            public_ipv6_port=int(v6_port_raw) if v6_port_raw else None,
            tls_server_name=os.getenv("EDGE_AGENT_TLS_SERVER_NAME") or None,
            certificate_pin_sha256=(
                os.getenv("EDGE_AGENT_CERTIFICATE_PIN_SHA256") or None
            ),
            node_uuid=os.getenv("EDGE_AGENT_NODE_UUID", ""),
            public_key_fingerprint=os.getenv(
                "EDGE_AGENT_PUBLIC_KEY_FINGERPRINT", ""
            ),
            join_token=os.getenv("EDGE_AGENT_JOIN_TOKEN") or None,
        )


def generate_token_secret() -> str:
    """仅供初始化部署时生成一个高熵 secret。"""
    return secrets.token_urlsafe(48)