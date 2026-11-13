# -*- coding: utf-8 -*-
"""
Minimal Network Resolver for Edge Core (Aligned with wimotek-edge-agent specs)
极简网络解析器 (纯标准库，遵循 wimotek-edge-agent 规范):
1. 默认 auto 模式：自动检测网络拓扑 (公网/1:1 NAT 自动直连，CGNAT/NAT4 自动反穿)
2. 显式指定优先：支持 NET_MODE / EDGE_AGENT_REVERSE_TUNNEL 明确锁定
3. 纯静态纯净算法，绝不强占本地 443 端口，零误判隐患
"""
import os
import re
import urllib.request
from typing import Tuple

def get_public_ip() -> str:
    """获取节点外部 IP，优先读取环境变量 SERVER_IP，否则通过权威端点获取"""
    env_ip = os.environ.get("SERVER_IP", "").strip()
    if env_ip:
        return env_ip

    endpoints = [
        "https://api.ipify.org",
        "https://icanhazip.com"
    ]
    for url in endpoints:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "wimotek-edge-agent/1.0"})
            with urllib.request.urlopen(req, timeout=2.0) as resp:
                val = resp.read().decode("utf-8").strip()
                if re.match(r"^\d{1,3}(\.\d{1,3}){3}$", val) or ":" in val:
                    return val
        except Exception:
            pass
    return "127.0.0.1"

def is_cgnat_or_internal(ip: str) -> bool:
    """判断 IP 是否为运营商级 CGNAT (100.64.0.0/10) 或纯私网保留地址"""
    if not ip or ":" in ip:
        return False
    parts = ip.split(".")
    if len(parts) != 4:
        return False
    try:
        octets = [int(p) for p in parts]
    except ValueError:
        return False
    # RFC 6598: 100.64.0.0/10 运营商 CGNAT 大内网 (无外网端口入站)
    if octets[0] == 100 and 64 <= octets[1] <= 127:
        return True
    # RFC 1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8
    if octets[0] in (10, 127) or (octets[0] == 172 and 16 <= octets[1] <= 31) or (octets[0] == 192 and octets[1] == 168):
        return True
    return False

def detect_network_profile(preferred_mode: str = "auto") -> Tuple[str, str, str]:
    """
    遵循 wimotek-edge-agent 规范的自动网络拓扑判定：
    - 显式指定：
        * preferred_mode == 'reverse_wss' 或 EDGE_AGENT_REVERSE_TUNNEL == 'true': 强制反穿
        * preferred_mode == 'direct' 或 EDGE_AGENT_REVERSE_TUNNEL == 'false': 强制直连 REALITY
    - 默认 auto：
        * 若 EDGE_AGENT_NAT_TYPE 为 nat4/symmetric，或出口检测为 100.64.0.0/10 CGNAT / 纯私网，自动切入 reverse_wss
        * 若为公网 IPv4 (包括云厂商 1:1 NAT) 或原生全球 IPv6，自动判定为 direct 直连 REALITY
    """
    ip = get_public_ip()
    is_ipv6 = ":" in ip

    env_reverse = os.environ.get("EDGE_AGENT_REVERSE_TUNNEL", "").strip().lower()
    nat_type = os.environ.get("EDGE_AGENT_NAT_TYPE", "").strip().lower()

    if preferred_mode == "reverse_wss" or env_reverse in ("true", "1", "yes"):
        mode = "reverse_wss"
    elif preferred_mode == "direct" or env_reverse in ("false", "0", "no"):
        mode = "direct"
    elif nat_type in ("nat4", "symmetric", "nat4_reverse") or is_cgnat_or_internal(ip):
        # 默认 auto 下自适应：属于内网/CGNAT，自动反穿
        mode = "reverse_wss"
    else:
        # 默认 auto 下自适应：属于独立公网或公网 IPv6，自动 direct
        mode = "direct"

    ext_ipv4 = "" if is_ipv6 else ip
    ext_ipv6 = ip if is_ipv6 else ""
    return mode, ext_ipv4, ext_ipv6
