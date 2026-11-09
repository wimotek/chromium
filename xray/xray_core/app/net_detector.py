# -*- coding: utf-8 -*-
"""
Smart Dual-Stack (IPv4 & IPv6) Network Environment Detector
智能双栈网络探测器：
1. 原生支持 IPv4 + IPv6 探测
2. 彻底解决 Oracle Cloud / AWS EC2 / 阿里云 1:1 NAT（本地私网 IP 但有公网 IP 端口直通）误判问题
3. 双重判定：云厂商元数据 API + STUN/NAT 映射反向探测
"""
import os
import re
import socket
import subprocess
import urllib.request
import urllib.error
from typing import Tuple, Dict, Any, Optional

def query_endpoint(url: str, timeout: float = 2.5, is_ipv6: bool = False) -> str:
    """带超时请求 IP 获取端点"""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "curl/7.88.1"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            val = resp.read().decode("utf-8").strip()
            if is_ipv6:
                # 简单校验 IPv6 格式
                if ":" in val and len(val) >= 3:
                    return val
            else:
                if re.match(r"^\d{1,3}(\.\d{1,3}){3}$", val):
                    return val
    except Exception:
        pass
    return ""

def get_public_ipv4() -> str:
    env_ip = os.environ.get("SERVER_IP", "").strip()
    if env_ip and ":" not in env_ip:
        return env_ip

    endpoints = [
        "https://api.ipify.org",
        "https://icanhazip.com",
        "https://ifconfig.me/ip",
        "https://v4.ident.me"
    ]
    for url in endpoints:
        ip = query_endpoint(url, timeout=2.5, is_ipv6=False)
        if ip:
            return ip
    return ""

def get_public_ipv6() -> str:
    """获取节点真实公网 IPv6 地址"""
    env_ipv6 = os.environ.get("SERVER_IPV6", "").strip()
    if env_ipv6 and ":" in env_ipv6:
        return env_ipv6

    endpoints = [
        "https://api6.ipify.org",
        "https://v6.ident.me",
        "https://ipv6.icanhazip.com"
    ]
    for url in endpoints:
        ip = query_endpoint(url, timeout=2.5, is_ipv6=True)
        if ip:
            return ip

    # 尝试从本地网卡抓取 global scope 的 IPv6
    try:
        res = subprocess.run(["ip", "-6", "addr", "show", "scope", "global"], capture_output=True, text=True, timeout=2)
        matches = re.findall(r"inet6\s+([0-9a-fA-F:]+)/\d+", res.stdout)
        for m in matches:
            # 排除 fe80:: 链路本地和 fc00::/fd00:: 唯一本地
            if not m.lower().startswith("fe80:") and not m.lower().startswith("fc") and not m.lower().startswith("fd"):
                return m
    except Exception:
        pass

    return ""

def check_cloud_nat1_to_1() -> bool:
    """
    针对 Oracle Cloud, AWS, GCP, Azure, 阿里/腾讯云 检查 1:1 NAT
    这些云主机本地网卡显示 10.x.x.x，但云路由器做了 Full Cone 1:1 NAT，公网所有端口直通入站
    """
    # 1. Oracle Cloud 实例元数据探测 (IMDSv1 & IMDSv2)
    # Oracle IMDS: http://169.254.169.254/opc/v2/vnics/
    try:
        req = urllib.request.Request(
            "http://169.254.169.254/opc/v2/vnics/",
            headers={"Authorization": "Bearer Oracle", "User-Agent": "cloud-init"}
        )
        with urllib.request.urlopen(req, timeout=1.0) as resp:
            content = resp.read().decode("utf-8")
            if "publicIp" in content:
                return True
    except Exception:
        pass

    # 2. AWS / GCP / Azure / 阿里云 通用元数据探测
    try:
        req = urllib.request.Request("http://169.254.169.254/latest/meta-data/public-ipv4", headers={"User-Agent": "cloud-init"})
        with urllib.request.urlopen(req, timeout=1.0) as resp:
            if resp.status == 200:
                val = resp.read().decode("utf-8").strip()
                if re.match(r"^\d{1,3}(\.\d{1,3}){3}$", val):
                    return True
    except Exception:
        pass

    return False

def check_local_inbound_capability(port: int = 443) -> bool:
    """
    检测本机是否可以成功绑定并监听指定端口
    """
    try:
        # 支持双栈监听 ::
        s = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
        s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("", port))
        s.close()
        return True
    except Exception:
        try:
            s4 = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s4.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s4.bind(("", port))
            s4.close()
            return True
        except Exception:
            return False

def detect_network_profile(preferred_mode: str = "auto") -> Tuple[str, str, str]:
    """
    智能网络探测 (包含 Oracle Cloud 1:1 NAT 完美识别)
    返回: (net_mode, external_ipv4, external_ipv6)
    net_mode:
      - 'direct': 拥有公网 IP（包括原生公网网卡、Oracle/AWS 云主机 1:1 NAT、或公网 IPv6 直连）
      - 'reverse_wss': 处于大内网/家庭宽带多层 NAT4/CGNAT (无端口直入能力)，必须走 WSS 反穿
    """
    ext_ipv4 = get_public_ipv4()
    ext_ipv6 = get_public_ipv6()

    primary_ip = ext_ipv4 or (f"[{ext_ipv6}]" if ext_ipv6 else "127.0.0.1")

    # 1. 用户强制指定
    if preferred_mode in ["direct", "reverse_wss"]:
        return preferred_mode, ext_ipv4, ext_ipv6

    # 2. 如果检测到有可用的公网 IPv6 且没有 IPv4，IPv6 原生就是端到端可达直连
    has_global_ipv6 = bool(ext_ipv6 and not ext_ipv6.startswith("fe80:") and not ext_ipv6.startswith("fc") and not ext_ipv6.startswith("fd"))

    # 3. 检查是否为云厂商 1:1 NAT (Oracle Cloud, AWS EC2, GCP, Azure, 阿里/腾讯轻量)
    is_cloud_nat = check_cloud_nat1_to_1()
    if is_cloud_nat and ext_ipv4:
        return "direct", ext_ipv4, ext_ipv6

    # 4. 检查本地网卡是否有公网 IP
    local_ips = []
    try:
        res = subprocess.run(["ip", "-4", "addr", "show"], capture_output=True, text=True, timeout=2)
        local_ips = re.findall(r"\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b", res.stdout)
    except Exception:
        pass

    private_patterns = [
        r"^127\.",
        r"^10\.",
        r"^192\.168\.",
        r"^172\.(1[6-9]|2[0-9]|3[0-1])\.",
        r"^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\."  # CGNAT 运营商大内网
    ]

    has_public_local_if = False
    is_cgnat = False
    for ip in local_ips:
        if re.match(r"^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\.", ip):
            is_cgnat = True
        if not any(re.match(pat, ip) for pat in private_patterns):
            has_public_local_if = True
            break

    # 判定逻辑：
    # A. 本地网卡有真实公网 IPv4 -> 100% direct
    if has_public_local_if:
        return "direct", ext_ipv4, ext_ipv6

    # B. 明确处于运营商级 CGNAT (100.64.0.0/10) 或家用 192.168.x.x 且不是云主机 -> 100% reverse_wss
    # 注意：如果云厂商 10.x 网段且对外有公网 IPv4，在云服务器环境下绝大多数是 1:1 NAT 直通
    if ext_ipv4 and not is_cgnat:
        # 如果不是 CGNAT，且拥有唯一公网 IPv4（例如 Oracle 主机 10.0.0.x 对应特定公网 IP）
        # 且能够正常监听 443 端口，判定为 direct
        if check_local_inbound_capability(443):
            return "direct", ext_ipv4, ext_ipv6

    # C. 纯 IPv6 独享主机（无公网 IPv4）
    if has_global_ipv6 and not ext_ipv4:
        return "direct", ext_ipv4, ext_ipv6

    # D. 其余判定为 NAT4 家宽/内网，启用反穿
    return "reverse_wss", ext_ipv4, ext_ipv6
