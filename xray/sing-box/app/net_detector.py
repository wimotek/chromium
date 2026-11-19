# -*- coding: utf-8 -*-
"""
Dual-Stack Public IP Reporter & Local Dual-Stack Listen Detector for Sing-box Edge Core
与 xray_core 完全对齐：
1. 独立采集节点自身的公网 IPv4 与公网 IPv6 地址，一并上报给 Hub
2. 真实网络模式 (direct / reverse_wss) 交由 Hub 端 wimotek-edge-agent 并发拨测权威裁决
3. 自动探测内核是否支持 :: 双栈监听 (IPV6_V6ONLY=0)，兼容纯 IPv4 宿主机
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


def detect_listen_address() -> str:
    """检测本机内核是否支持 IPv4+IPv6 双栈 :: 监听，否则安全回退 0.0.0.0"""
    try:
        with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as s:
            v6only = s.getsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY)
            s.bind(("::", 0))
            return "::" if v6only == 0 else "0.0.0.0"
    except Exception:
        return "0.0.0.0"


def detect_network_profile(preferred_mode: str = "auto") -> Tuple[str, str, str]:
    """
    获取节点公网双栈地址并返回初始启动模式：
    - 节点端不做本地端口猜测，真实网络判定交由 Hub 端 wimotek-edge-agent 拨测
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
