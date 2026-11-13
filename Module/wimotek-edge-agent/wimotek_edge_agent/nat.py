from __future__ import annotations

import asyncio
import concurrent.futures
import ipaddress
import socket
import time
from dataclasses import asdict, dataclass
from typing import Any, Awaitable, Callable, Optional

from .config import Config

_PRIVATE_V4_NETS = (
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("100.64.0.0/10"),  # CGNAT (NAT444)
)
_PRIVATE_V6_NETS = (
    ipaddress.ip_network("fc00::/7"),  # ULA
)


@dataclass(frozen=True)
class EndpointProbeResult:
    family: str  # "ipv4" | "ipv6"
    host: str
    port: int
    reachable: bool
    latency_ms: Optional[float] = None
    error: Optional[str] = None


@dataclass(frozen=True)
class NetworkDetectionResult:
    """
    简化的网络模式探测结果：
    1. 远程节点上报自己的公网 IPv4 / IPv6 与端口；
    2. 本模块并发测试连通性，判定最终网络模式并传回给远程节点。
    """

    network_mode: str  # "direct_dual" | "direct_ipv4" | "direct_ipv6" | "reverse_tunnel"
    network_profile: str  # "direct" | "nat4_reverse"
    ipv4_reachable: bool
    ipv6_reachable: bool
    recommended_endpoint: Optional[str] = None
    ipv4: Optional[EndpointProbeResult] = None
    ipv6: Optional[EndpointProbeResult] = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "network_mode": self.network_mode,
            "network_profile": self.network_profile,
            "ipv4_reachable": self.ipv4_reachable,
            "ipv6_reachable": self.ipv6_reachable,
            "recommended_endpoint": self.recommended_endpoint,
            "ipv4": asdict(self.ipv4) if self.ipv4 else None,
            "ipv6": asdict(self.ipv6) if self.ipv6 else None,
        }


ProbeFn = Callable[[str, int, str, float], Awaitable[EndpointProbeResult]]


def _validate_endpoint(
    host: str,
    port: Optional[int],
    family: str,
    allow_non_public: bool,
) -> tuple[Optional[ipaddress.IPv4Address | ipaddress.IPv6Address], Optional[int], Optional[str]]:
    if not host or not isinstance(host, str):
        return None, None, "missing_host"
    if port is None:
        return None, None, "missing_port"
    try:
        port_int = int(port)
    except (TypeError, ValueError):
        return None, None, "invalid_port"
    if port_int < 1 or port_int > 65535:
        return None, None, "port_out_of_range"

    try:
        addr = ipaddress.ip_address(host.strip())
    except ValueError:
        return None, port_int, "invalid_ip_address"

    expected_version = 4 if family == "ipv4" else 6
    if addr.version != expected_version:
        return None, port_int, f"expected_{family}_address"

    if not allow_non_public:
        if addr.is_loopback or addr.is_unspecified or addr.is_multicast or addr.is_link_local:
            return None, port_int, "non_routable_ip"
        if addr.version == 4 and any(addr in net for net in _PRIVATE_V4_NETS):
            return None, port_int, "private_ip_not_public"
        if addr.version == 6 and any(addr in net for net in _PRIVATE_V6_NETS):
            return None, port_int, "private_ip_not_public"

    return addr, port_int, None


async def probe_tcp_endpoint(
    host: str,
    port: int,
    family: str,
    timeout: float = 2.0,
    allow_non_public: bool = False,
) -> EndpointProbeResult:
    """
    对上报的 IPv4 或 IPv6 端口执行异步 TCP 连通性拨测。
    """
    addr, port_int, err = _validate_endpoint(host, port, family, allow_non_public)
    if err is not None or addr is None or port_int is None:
        return EndpointProbeResult(
            family=family,
            host=str(host).strip(),
            port=port_int or 0,
            reachable=False,
            latency_ms=None,
            error=err,
        )

    sock_family = socket.AF_INET if addr.version == 4 else socket.AF_INET6
    start = time.monotonic()
    writer: Optional[asyncio.StreamWriter] = None
    try:
        _, writer = await asyncio.wait_for(
            asyncio.open_connection(str(addr), port_int, family=sock_family),
            timeout=max(0.1, float(timeout)),
        )
        latency_ms = round((time.monotonic() - start) * 1000.0, 2)
        return EndpointProbeResult(
            family=family,
            host=str(addr),
            port=port_int,
            reachable=True,
            latency_ms=latency_ms,
            error=None,
        )
    except asyncio.TimeoutError:
        return EndpointProbeResult(
            family=family,
            host=str(addr),
            port=port_int,
            reachable=False,
            latency_ms=None,
            error="timeout",
        )
    except OSError as exc:
        return EndpointProbeResult(
            family=family,
            host=str(addr),
            port=port_int,
            reachable=False,
            latency_ms=None,
            error=exc.strerror or str(exc) or exc.__class__.__name__,
        )
    finally:
        if writer is not None:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass


def _format_endpoint(host: str, port: int, family: str) -> str:
    if family == "ipv6":
        return f"[{host}]:{port}"
    return f"{host}:{port}"


async def detect_network_mode(
    public_ipv4: Optional[str] = None,
    public_ipv4_port: Optional[int] = None,
    public_ipv6: Optional[str] = None,
    public_ipv6_port: Optional[int] = None,
    timeout: float = 2.0,
    allow_non_public: bool = False,
    force_reverse: Optional[bool] = None,
    probe_fn: Optional[ProbeFn] = None,
) -> NetworkDetectionResult:
    """
    核心网络模式判定入口：
    - 若管理员强制 reverse_tunnel=True，直接返回 reverse_tunnel。
    - 否则并发探测远程节点上报的公网 IPv4 / IPv6 端口：
      - 均通 -> direct_dual
      - 仅 IPv6 通 -> direct_ipv6
      - 仅 IPv4 通 -> direct_ipv4
      - 均不通或未上报 -> reverse_tunnel (自动回落反向隧道)
    """
    if force_reverse is True:
        return NetworkDetectionResult(
            network_mode="reverse_tunnel",
            network_profile="nat4_reverse",
            ipv4_reachable=False,
            ipv6_reachable=False,
            recommended_endpoint=None,
            ipv4=None,
            ipv6=None,
        )

    async def _run_one(
        host: Optional[str], port: Optional[int], family: str
    ) -> Optional[EndpointProbeResult]:
        if not host and port is None:
            return None
        if not host or port is None:
            return EndpointProbeResult(
                family=family,
                host=str(host or "").strip(),
                port=int(port) if port is not None else 0,
                reachable=False,
                latency_ms=None,
                error="missing_host" if not host else "missing_port",
            )
        if probe_fn is not None:
            addr, port_int, err = _validate_endpoint(host, port, family, allow_non_public)
            if err is not None or addr is None or port_int is None:
                return EndpointProbeResult(
                    family=family,
                    host=str(host).strip(),
                    port=port_int or 0,
                    reachable=False,
                    latency_ms=None,
                    error=err,
                )
            return await probe_fn(str(addr), port_int, family, timeout)
        return await probe_tcp_endpoint(
            host=host,
            port=port,
            family=family,
            timeout=timeout,
            allow_non_public=allow_non_public,
        )

    v4_res, v6_res = await asyncio.gather(
        _run_one(public_ipv4, public_ipv4_port, "ipv4"),
        _run_one(public_ipv6, public_ipv6_port, "ipv6"),
    )

    v4_ok = bool(v4_res and v4_res.reachable)
    v6_ok = bool(v6_res and v6_res.reachable)

    if v4_ok and v6_ok and v4_res is not None and v6_res is not None:
        v4_lat = v4_res.latency_ms if v4_res.latency_ms is not None else float("inf")
        v6_lat = v6_res.latency_ms if v6_res.latency_ms is not None else float("inf")
        recommended = (
            _format_endpoint(v6_res.host, v6_res.port, "ipv6")
            if v6_lat < v4_lat
            else _format_endpoint(v4_res.host, v4_res.port, "ipv4")
        )
        return NetworkDetectionResult(
            network_mode="direct_dual",
            network_profile="direct",
            ipv4_reachable=True,
            ipv6_reachable=True,
            recommended_endpoint=recommended,
            ipv4=v4_res,
            ipv6=v6_res,
        )

    if v6_ok and v6_res is not None:
        return NetworkDetectionResult(
            network_mode="direct_ipv6",
            network_profile="direct",
            ipv4_reachable=False,
            ipv6_reachable=True,
            recommended_endpoint=_format_endpoint(v6_res.host, v6_res.port, "ipv6"),
            ipv4=v4_res,
            ipv6=v6_res,
        )

    if v4_ok and v4_res is not None:
        return NetworkDetectionResult(
            network_mode="direct_ipv4",
            network_profile="direct",
            ipv4_reachable=True,
            ipv6_reachable=False,
            recommended_endpoint=_format_endpoint(v4_res.host, v4_res.port, "ipv4"),
            ipv4=v4_res,
            ipv6=v6_res,
        )

    if force_reverse is False:
        return NetworkDetectionResult(
            network_mode="direct",
            network_profile="direct",
            ipv4_reachable=False,
            ipv6_reachable=False,
            recommended_endpoint=None,
            ipv4=v4_res,
            ipv6=v6_res,
        )

    return NetworkDetectionResult(
        network_mode="reverse_tunnel",
        network_profile="nat4_reverse",
        ipv4_reachable=False,
        ipv6_reachable=False,
        recommended_endpoint=None,
        ipv4=v4_res,
        ipv6=v6_res,
    )


def detect_network_mode_sync(
    public_ipv4: Optional[str] = None,
    public_ipv4_port: Optional[int] = None,
    public_ipv6: Optional[str] = None,
    public_ipv6_port: Optional[int] = None,
    timeout: float = 2.0,
    allow_non_public: bool = False,
    force_reverse: Optional[bool] = None,
    probe_fn: Optional[ProbeFn] = None,
) -> NetworkDetectionResult:
    """同步调用包装器，兼容同步上下文和已存在事件循环的上下文。"""
    coro = detect_network_mode(
        public_ipv4=public_ipv4,
        public_ipv4_port=public_ipv4_port,
        public_ipv6=public_ipv6,
        public_ipv6_port=public_ipv6_port,
        timeout=timeout,
        allow_non_public=allow_non_public,
        force_reverse=force_reverse,
        probe_fn=probe_fn,
    )
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


def detect_network_profile(
    config: Config,
    advertised_nat_type: Optional[str] = None,
    advertised_reverse: Optional[bool] = None,
) -> tuple[str, str]:
    """
    兼容旧接口：返回 (network_profile, nat_type)。
    如未传入端点探测结果，回退使用显式标志判断。
    """
    nat_type = (advertised_nat_type or config.nat_type or "unknown").lower()

    if config.reverse_tunnel is not None:
        reverse = config.reverse_tunnel
    elif advertised_reverse is not None:
        reverse = advertised_reverse
    else:
        reverse = nat_type in {"nat4", "symmetric", "nat4_reverse"}

    profile = "nat4_reverse" if reverse else "direct"
    return profile, nat_type