#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
wimotek-ssh-tunnel
Universal SSH Tunnel & Port Forwarding Engine
通用 SSH 隧道与端口映射调度引擎 (无 Chromium 依赖，支持任意 TCP 端口穿透)
"""

from .tunnel import (
    TunnelConfig,
    SshTunnelSession,
    SSHTunnel,
    SSHTunnelManager,
    TunnelException,
)
from .logger import TunnelLogger, default_logger
from .models import (
    SshHostConfig,
    SkipEvent,
)

# Backward compatibility alias
SshTunnelInstance = SshTunnelSession

__version__ = "1.0.0"
__author__ = "Wimotek Engineering <wimotek@gmail.com>"
__all__ = [
    "TunnelConfig",
    "SshTunnelSession",
    "SSHTunnel",
    "SSHTunnelManager",
    "TunnelException",
    "TunnelLogger",
    "default_logger",
    "SshHostConfig",
    "SshTunnelInstance",
    "SkipEvent",
    "open_tunnel",
]

def open_tunnel(
    ssh_host: str,
    remote_port: int = 9222,
    local_port: int = 19222,
    ssh_user: str = "root",
    ssh_port: int = 22,
    ssh_key: str = None,
    ssh_password: str = None,
    remote_host: str = "127.0.0.1",
    timeout_sec: float = 6.0
) -> SshTunnelSession:
    """
    一键建立通用 SSH 端口转发隧道便捷工具函数。
    返回建立好的 SshTunnelSession 会话对象。
    """
    cfg = TunnelConfig(
        id=f"tunnel-{ssh_host}-{remote_port}",
        ssh_host=ssh_host,
        ssh_port=ssh_port,
        ssh_user=ssh_user,
        remote_host=remote_host,
        remote_port=remote_port,
        local_port=local_port,
        ssh_key=ssh_key,
        ssh_password=ssh_password,
        timeout_sec=timeout_sec,
    )
    session = SshTunnelSession(cfg)
    session.start()
    return session
