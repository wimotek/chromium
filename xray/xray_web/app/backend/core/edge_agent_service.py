# -*- coding: utf-8 -*-
"""
Edge Agent Enterprise Service (Powered by wimotek-edge-agent >= 1.0.16)
基于官方 PyPI 模块 wimotek-edge-agent 构建 Hub 端统一零信任控制引擎：
1. 主动双栈网络拨测 (detect_network_mode_sync)：并发探测节点上报的公网 IPv4 / IPv6 端口，
   权威裁决 direct_dual / direct_ipv4 / direct_ipv6 / reverse_tunnel
2. 单次高熵 40 字符 Base64URL HMAC Join Token 签发与原子防重放核销
3. 基于 SQLite WAL 的 TrustStore 节点零信任生命周期管理
4. 线程安全结构化 JSONL 审计流水 (10MB 自动轮换归档 + 安全截断)
"""
import ipaddress
import os
import secrets
import socket
from pathlib import Path
from typing import Optional, Dict, Any, Tuple

from wimotek_edge_agent import Config, EdgeAgent
from wimotek_edge_agent.models import AccessDecision
from wimotek_edge_agent.nat import NetworkDetectionResult, detect_network_mode_sync
from wimotek_edge_agent.tokens import JoinTokenClaims, TokenError


def _is_valid_public_ip(ip_str: Optional[str]) -> bool:
    if not ip_str:
        return False
    try:
        addr = ipaddress.ip_address(ip_str.strip().strip("[]"))
        if addr.is_loopback or addr.is_unspecified or addr.is_multicast or addr.is_link_local or addr.is_private:
            return False
        if isinstance(addr, ipaddress.IPv4Address) and addr in ipaddress.IPv4Network("100.64.0.0/10"):
            return False
        return True
    except ValueError:
        return False


class EdgeAgentService:
    _instance: Optional['EdgeAgentService'] = None

    def __init__(self):
        base_dir = os.environ.get("DATA_DIR", "/data")
        self.data_dir = Path(base_dir) / "edge_agent_data"
        self.data_dir.mkdir(parents=True, exist_ok=True)

        secret_file = self.data_dir / "master_secret.key"
        if secret_file.exists():
            self.secret_bytes = secret_file.read_bytes().strip()
        else:
            self.secret_bytes = secrets.token_bytes(32)
            secret_file.write_bytes(self.secret_bytes)

        self.config = Config(
            token_secret=self.secret_bytes,
            data_dir=self.data_dir,
            audit_max_bytes=10 * 1024 * 1024,
            audit_backup_count=5,
            network_probe_timeout_seconds=float(os.environ.get("EDGE_AGENT_PROBE_TIMEOUT", "2.0")),
            allow_non_public_probe=os.environ.get("EDGE_AGENT_ALLOW_NON_PUBLIC_PROBE", "false").lower() in ("1", "true", "yes"),
        )
        self.agent = EdgeAgent(self.config)

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
        allowed_ip_cidr: Optional[str] = None,
    ) -> str:
        """签发高强度 40 字符紧凑单次 Join Token (Base64URL，内置防重放 JTI 与 HMAC 签名)"""
        return self.agent.token_issuer.issue(
            node_group=node_group,
            ttl_seconds=ttl_seconds,
            node_uuid=node_uuid,
            allowed_ip_cidr=allowed_ip_cidr,
        )

    def verify_token(
        self,
        token: str,
        source_ip: str,
        node_uuid: str,
    ) -> Optional[JoinTokenClaims]:
        """核验单次 Join Token 并原子性防重放核销"""
        if not token:
            return None
        try:
            return self.agent.token_verifier.verify(
                token=token,
                source_ip=source_ip,
                node_uuid=node_uuid,
            )
        except TokenError:
            return None
        except Exception:
            return None

    def probe_node_network(
        self,
        public_ipv4: Optional[str] = None,
        public_ipv4_port: Optional[int] = None,
        public_ipv6: Optional[str] = None,
        public_ipv6_port: Optional[int] = None,
        preferred_mode: str = "auto",
        remote_addr: Optional[str] = None,
    ) -> Tuple[str, str, NetworkDetectionResult]:
        """
        调用 wimotek-edge-agent detect_network_mode_sync 执行主动双栈 TCP 拨测：
        - 若节点未显式上报公网 IPv4/IPv6，尝试以连接来源 IP (remote_addr) 作为兜底候选
        - 返回: (xray_net_mode ['direct'|'reverse_wss'], best_reachable_ip, NetworkDetectionResult)
        """
        v4 = (public_ipv4 or "").strip() or None
        v6 = (public_ipv6 or "").strip().strip("[]") or None

        # 若节点自身未能探测出公网 IP，利用 HTTP 请求来源地址补充候选
        if not v4 and not v6 and _is_valid_public_ip(remote_addr):
            addr = ipaddress.ip_address(remote_addr.strip().strip("[]"))
            if isinstance(addr, ipaddress.IPv6Address):
                v6 = str(addr)
                public_ipv6_port = public_ipv6_port or public_ipv4_port
            else:
                v4 = str(addr)
                public_ipv4_port = public_ipv4_port or public_ipv6_port

        pref = (preferred_mode or "auto").strip().lower()
        force_reverse: Optional[bool]
        if pref == "reverse_wss":
            force_reverse = True
        elif pref == "direct":
            force_reverse = False
        else:
            force_reverse = None

        det = detect_network_mode_sync(
            public_ipv4=v4,
            public_ipv4_port=public_ipv4_port if v4 else None,
            public_ipv6=v6,
            public_ipv6_port=public_ipv6_port if v6 else None,
            timeout=self.config.network_probe_timeout_seconds,
            allow_non_public=self.config.allow_non_public_probe,
            force_reverse=force_reverse,
        )

        xray_net_mode = "reverse_wss" if det.network_mode == "reverse_tunnel" else "direct"

        # 选择最佳直连可达地址 (优先延迟最低且可达的端点；若仅 IPv6 可达则选用 IPv6)
        if det.ipv4_reachable and det.ipv6_reachable and det.ipv4 and det.ipv6:
            v4_lat = det.ipv4.latency_ms if det.ipv4.latency_ms is not None else float("inf")
            v6_lat = det.ipv6.latency_ms if det.ipv6.latency_ms is not None else float("inf")
            best_ip = det.ipv6.host if v6_lat < v4_lat else det.ipv4.host
        elif det.ipv4_reachable and det.ipv4:
            best_ip = det.ipv4.host
        elif det.ipv6_reachable and det.ipv6:
            best_ip = det.ipv6.host
        else:
            best_ip = v4 or v6 or (remote_addr or "127.0.0.1")

        self.agent.audit.emit(
            "network_detected",
            network_mode=det.network_mode,
            network_profile=det.network_profile,
            xray_net_mode=xray_net_mode,
            ipv4_reachable=det.ipv4_reachable,
            ipv6_reachable=det.ipv6_reachable,
            recommended_endpoint=det.recommended_endpoint,
            best_ip=best_ip,
            public_ipv4=v4,
            public_ipv4_port=public_ipv4_port,
            public_ipv6=v6,
            public_ipv6_port=public_ipv6_port,
        )

        return xray_net_mode, best_ip, det

    def probe_host_endpoint(
        self,
        host: str,
        port: int = 443,
        preferred_mode: str = "auto",
    ) -> Tuple[bool, Optional[float], NetworkDetectionResult]:
        """
        对已有节点的地址（IPv4 / [IPv6] / 域名）使用 wimotek-edge-agent 执行并发 TCP 三次握手测活。
        返回: (reachable, best_rtt_ms, NetworkDetectionResult)
        """
        clean_host = (host or "").strip().strip("[]")
        v4: Optional[str] = None
        v6: Optional[str] = None

        if clean_host and clean_host != "0.0.0.0":
            try:
                addr = ipaddress.ip_address(clean_host)
                if addr.version == 6:
                    v6 = str(addr)
                else:
                    v4 = str(addr)
            except ValueError:
                # 域名：解析 A / AAAA 记录并交由 wimotek-edge-agent 并发 TCP 握手探测
                try:
                    for info in socket.getaddrinfo(clean_host, port, type=socket.SOCK_STREAM):
                        fam, _, _, _, sockaddr = info
                        cand_ip = sockaddr[0].split("%")[0]
                        if fam == socket.AF_INET and not v4:
                            v4 = cand_ip
                        elif fam == socket.AF_INET6 and not v6:
                            v6 = cand_ip
                except Exception:
                    pass

        pref = (preferred_mode or "auto").strip().lower()
        force_reverse: Optional[bool] = True if pref == "reverse_wss" else None

        det = detect_network_mode_sync(
            public_ipv4=v4,
            public_ipv4_port=port if v4 else None,
            public_ipv6=v6,
            public_ipv6_port=port if v6 else None,
            timeout=self.config.network_probe_timeout_seconds,
            allow_non_public=self.config.allow_non_public_probe,
            force_reverse=force_reverse,
        )

        latencies = []
        if det.ipv4_reachable and det.ipv4 and det.ipv4.latency_ms is not None:
            latencies.append(det.ipv4.latency_ms)
        if det.ipv6_reachable and det.ipv6 and det.ipv6.latency_ms is not None:
            latencies.append(det.ipv6.latency_ms)

        reachable = det.ipv4_reachable or det.ipv6_reachable
        best_rtt = round(min(latencies), 1) if latencies else None
        return reachable, best_rtt, det

    def log_access(
        self,
        source_ip: str,
        node_uuid: str,
        fingerprint: str,
        decision: AccessDecision,
        reason: str,
        network_profile: str = "direct",
        network_mode: Optional[str] = None,
        node_status: str = "trusted",
    ):
        """记录高保真结构化 JSONL 审计日志 (自动 10MB 轮换)"""
        try:
            self.agent.audit.emit(
                "access_decision",
                node_uuid=node_uuid,
                source_ip=source_ip,
                is_loopback=source_ip in ("127.0.0.1", "::1"),
                decision=decision.value if isinstance(decision, AccessDecision) else str(decision),
                reason=reason,
                network_profile=network_profile,
                network_mode=network_mode or network_profile,
                fingerprint=fingerprint or "unknown",
                node_status=node_status,
            )
        except Exception:
            pass

    def get_audit_log_path(self) -> Path:
        return self.config.audit_log_path

    def clean_audit_log(self, keep_lines: int = 500) -> int:
        """调用 wimotek-edge-agent AuditLogger.clear 安全截断日志"""
        return self.agent.audit.clear(keep_last_lines=max(0, keep_lines))
