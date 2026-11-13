# -*- coding: utf-8 -*-
"""
Dual-Stack Public IP Reporter for Edge Core
极简公网 IP 采集器 (纯标准库，不做任何本地网络猜测):
1. 独立采集节点自身的公网 IPv4 与公网 IPv6 地址，一并上报给 Hub
2. 真正的连通性与网络模式 (direct_dual / direct_ipv4 / direct_ipv6 / reverse_tunnel)
   完全由 Hub 端通过 wimotek-edge-agent 并发 TCP 拨测权威裁决！
3. 启动初始态：除非用户显式指定 NET_MODE=reverse_wss，否则默认先以 direct 拉起监听等待 Hub 拨测
"""
import ipaddress
import os
import socket
import urllib.request
from typing import Tuple


def _query_ip_endpoint(url: str, family: int, timeout: float = 2.0) -> str:
    """请求外部端点并校验返回是否为对应协议族的合法 IP"""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "wimotek-edge-agent/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            val = resp.read().decode("utf-8").strip()
            addr = ipaddress.ip_address(val)
            if family == 4 and isinstance(addr, ipaddress.IPv4Address):
                return str(addr)
            if family == 6 and isinstance(addr, ipaddress.IPv6Address):
                return str(addr)
    except Exception:
        pass
    return ""


def get_public_ipv4() -> str:
    """获取节点公网 IPv4 地址 (优先读 SERVER_IP，其次外网端点)"""
    env_ip = os.environ.get("SERVER_IP", "").strip()
    if env_ip:
        try:
            addr = ipaddress.ip_address(env_ip)
            if isinstance(addr, ipaddress.IPv4Address):
                return str(addr)
        except ValueError:
            pass

    for url in (
        "https://api.ipify.org",
        "https://v4.ident.me",
        "https://ipv4.icanhazip.com",
    ):
        ip = _query_ip_endpoint(url, family=4, timeout=2.0)
        if ip:
            return ip
    return ""


def get_public_ipv6() -> str:
    """获取节点真实公网 IPv6 地址 (端点优先，纯 Python 路由与 /proc/net/if_inet6 兜底)"""
    env_ipv6 = os.environ.get("SERVER_IPV6", "").strip() or os.environ.get("SERVER_IP", "").strip()
    if env_ipv6:
        try:
            addr = ipaddress.ip_address(env_ipv6)
            if isinstance(addr, ipaddress.IPv6Address):
                return str(addr)
        except ValueError:
            pass

    for url in (
        "https://api6.ipify.org",
        "https://v6.ident.me",
        "https://ipv6.icanhazip.com",
    ):
        ip = _query_ip_endpoint(url, family=6, timeout=2.0)
        if ip:
            return ip

    # 兜底 1：纯标准库 UDP 路由选路探测 (无实际发包)
    try:
        with socket.socket(socket.AF_INET6, socket.SOCK_DGRAM) as s:
            s.settimeout(1.0)
            s.connect(("2606:4700:4700::1111", 80))
            cand = s.getsockname()[0].split("%")[0]
            addr = ipaddress.IPv6Address(cand)
            if addr.is_global and not addr.is_private and not addr.is_link_local:
                return str(addr)
    except Exception:
        pass

    # 兜底 2：直接读取 Linux /proc/net/if_inet6 筛选全球单播地址
    try:
        with open("/proc/net/if_inet6", "r", encoding="utf-8") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 1 and len(parts[0]) == 32:
                    raw = bytes.fromhex(parts[0])
                    addr = ipaddress.IPv6Address(raw)
                    if addr.is_global and not addr.is_private and not addr.is_link_local and not addr.is_loopback:
                        return str(addr)
    except Exception:
        pass

    return ""


def detect_network_profile(preferred_mode: str = "auto") -> Tuple[str, str, str]:
    """
    获取节点公网双栈地址并返回初始启动模式：
    - 节点端不再本地猜测端口是否通畅，真实网络判定交由 Hub 端 wimotek-edge-agent 拨测
    - 启动初始模式：仅当明确指定 reverse_wss 时直接反穿，其余均先以 direct 启动监听等待 Hub 拨测
    """
    ext_ipv4 = get_public_ipv4()
    ext_ipv6 = get_public_ipv6()

    env_reverse = os.environ.get("EDGE_AGENT_REVERSE_TUNNEL", "").strip().lower()
    if preferred_mode == "reverse_wss" or env_reverse in ("true", "1", "yes"):
        initial_mode = "reverse_wss"
    else:
        initial_mode = "direct"

    return initial_mode, ext_ipv4, ext_ipv6
