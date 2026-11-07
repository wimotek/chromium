#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Universal SSH Tunnel & Port Forwarding Engine
通用 SSH 隧道与端口映射调度引擎 (无 Chromium 依赖，支持任意 TCP 端口穿透)
- 支持 SSH 私钥文本内容 (PEM String) 自动写入安全受限临时文件 (0600)
- 支持 SSH 私钥路径 (~/.ssh/id_rsa)
- 支持 SSH 密码认证 (sshpass 或原生临时 SSH_ASKPASS 独立环境脚本注入)
- 支持端口占用检测、死连接防僵尸复用与安全热释放
- 支持多隧道连接池管理与端口自增分配 (默认 19222 起步)
- 支持连接超时判定、异常分类与自动跳过日志输出
"""

import os
import sys
import time
import socket
import shutil
import logging
import tempfile
import subprocess
from dataclasses import dataclass, field
from typing import Optional, Dict, List, Union, Any

logger = logging.getLogger("wimotek-ssh-tunnel")


@dataclass
class TunnelConfig:
    """
    通用 SSH 隧道配置 (支持任意目标服务穿透，如 CDP 9222、MySQL 3306、Redis 6379 等)
    """
    id: str
    ssh_host: str
    ssh_port: int = 22
    ssh_user: str = "root"
    remote_host: str = "127.0.0.1"
    remote_port: int = 9222          # 默认目标端口 (如 CDP 9222)
    local_port: Optional[int] = None # 本地监听端口 (如 19222，留空则自动分配)
    ssh_key: Optional[str] = None    # 私钥文件绝对路径 或 PEM 字符串
    ssh_password: Optional[str] = None
    timeout_sec: float = 6.0
    name: str = ""
    extra_options: Dict[str, str] = field(default_factory=dict)

    def __post_init__(self):
        if not self.name:
            self.name = self.id
        if self.local_port is None:
            self.local_port = 19222


class TunnelException(Exception):
    def __init__(self, code: str, message: str, suggestion: Optional[str] = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.suggestion = suggestion


class SshTunnelSession:
    """
    单个 SSH 隧道会话实例
    移植并泛化自 wimotek-chromium-sync 原有核心隧道逻辑，实现零框架依赖的纯通用穿透。
    """
    def __init__(self, config: Union[TunnelConfig, dict]):
        if isinstance(config, dict):
            self.config = TunnelConfig(**config)
        else:
            self.config = config

        self.proc: Optional[subprocess.Popen] = None
        self.is_reused: bool = False
        self.temp_key_file: Optional[str] = None
        self.askpass_script: Optional[str] = None
        self.local_port: int = self.config.local_port or 19222

    def _is_port_in_use(self, port: int) -> bool:
        """检测本地端口是否已被占用"""
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.3)
            return s.connect_ex(("127.0.0.1", port)) == 0

    def _is_service_ready(self, port: int) -> bool:
        """探测本地端口是否已能正常建立 TCP 握手"""
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(1.0)
                return s.connect_ex(("127.0.0.1", port)) == 0
        except Exception:
            return False

    def _prepare_key_file(self) -> Optional[str]:
        """准备并校验 SSH 密钥临时文件 (PEM 文本写入 0600 权限临时文件或扩展路径)"""
        if not self.config.ssh_key:
            return None
        key_str = self.config.ssh_key.strip()
        if "-----BEGIN" in key_str or "\n" in key_str:
            fd, tmp_path = tempfile.mkstemp(prefix="ssh_key_")
            with open(tmp_path, "w") as f:
                f.write(key_str + "\n")
            os.close(fd)
            os.chmod(tmp_path, 0o600)
            self.temp_key_file = tmp_path
            return tmp_path
        else:
            expanded_key = os.path.expanduser(key_str)
            if os.path.exists(expanded_key):
                return expanded_key
            else:
                raise TunnelException(
                    "SSH_KEY_NOT_FOUND",
                    f"指定的私钥文件不存在: {expanded_key}",
                    "检查私钥路径配置或直接传入 PEM 文本内容。"
                )

    def _prepare_askpass_script(self) -> Optional[str]:
        """生成无交互密码输入的临时 ASKPASS 脚本 (0700)"""
        if not self.config.ssh_password:
            return None
        fd, askpass_path = tempfile.mkstemp(prefix="askpass_", suffix=".sh")
        escaped_pw = self.config.ssh_password.replace("'", "'\\''")
        with open(askpass_path, "w") as f:
            f.write(f"#!/bin/sh\necho '{escaped_pw}'\n")
        os.close(fd)
        os.chmod(askpass_path, 0o700)
        self.askpass_script = askpass_path
        return askpass_path

    def start(self, auto_close: bool = False) -> int:
        """
        拉起 SSH 隧道进程并建立端口转发。
        若网络中断、认证失败或超时，抛出 typed TunnelException，供上层调度器记录并跳过。
        """
        # 0. 检查是否为无需穿透的本地回环
        if self.config.ssh_host in ("127.0.0.1", "localhost", "::1", ""):
            logger.info(f"[*] 节点 [{self.config.name}] 为本地主机，无需建立 SSH 隧道，直连端口 {self.config.remote_port}。")
            self.local_port = self.config.remote_port
            return self.local_port

        target_local_port = self.local_port

        # 1. 检查本地端口是否已有存活连接可复用
        if self._is_port_in_use(target_local_port):
            if self._is_service_ready(target_local_port):
                logger.info(f"[*] 节点 [{self.config.name}] 本地端口 {target_local_port} 已通畅，复用现有隧道连接。")
                self.is_reused = True
                return target_local_port

        logger.info(
            f"[*] 正在建立 SSH 隧道: {self.config.name} -> {self.config.ssh_user}@{self.config.ssh_host}:{self.config.ssh_port} "
            f"(本地 127.0.0.1:{target_local_port} -> 远程 {self.config.remote_host}:{self.config.remote_port}) ..."
        )

        ssh_cmd = [
            "ssh", "-N",
            "-p", str(self.config.ssh_port),
            "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=3",
            "-o", "TCPKeepAlive=yes",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "ExitOnForwardFailure=yes",
            "-o", f"ConnectTimeout={int(self.config.timeout_sec)}",
            "-L", f"{target_local_port}:{self.config.remote_host}:{self.config.remote_port}"
        ]

        env = os.environ.copy()

        # 2. 智能解析 SSH 密钥 (支持文件路径或 PEM 文本内容)
        if self.config.ssh_key:
            key_arg = self._prepare_key_file()
            if key_arg:
                ssh_cmd.extend(["-i", key_arg])

        # 3. 智能解析 SSH 密码
        if self.config.ssh_password:
            if shutil.which("sshpass"):
                ssh_cmd = ["sshpass", "-p", self.config.ssh_password] + ssh_cmd
            else:
                askpass_path = self._prepare_askpass_script()
                env["SSH_ASKPASS"] = askpass_path
                env["SSH_ASKPASS_REQUIRE"] = "force"
                env["DISPLAY"] = ":0"
                ssh_cmd.extend(["-o", "BatchMode=no"])

        ssh_cmd.append(f"{self.config.ssh_user}@{self.config.ssh_host}")

        try:
            self.proc = subprocess.Popen(
                ssh_cmd,
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=(not auto_close)
            )
        except FileNotFoundError:
            raise TunnelException(
                "SSH_COMMAND_NOT_FOUND",
                "系统未找到 ssh 命令执行文件，请确认安装 openssh-client",
                "在 Linux 上运行: apt-get install openssh-client 或 yum install openssh-clients"
            )

        # 4. 轮询检测隧道是否就绪
        max_attempts = int(self.config.timeout_sec / 0.3)
        for _ in range(max_attempts):
            time.sleep(0.3)
            if self._is_port_in_use(target_local_port) and self._is_service_ready(target_local_port):
                logger.info(f"[+] 节点 [{self.config.name}] SSH 隧道建立成功 (本地端口: {target_local_port})。")
                return target_local_port

            if self.proc.poll() is not None:
                # 进程过早退出，说明认证或网络失败
                break

        self.stop(force=True)
        raise TunnelException(
            "SSH_CONNECT_TIMEOUT",
            f"建立 SSH 隧道失败或超时 [{self.config.name} -> {self.config.ssh_host}:{self.config.ssh_port}]",
            "检查远程 SSH 账号密码/密钥、防火墙入站规则及 9222 端口监听状态。"
        )

    def stop(self, force: bool = False):
        """停止隧道并清理敏感临时文件"""
        if self.is_reused and not force:
            return

        if self.proc and self.proc.poll() is None:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=2)
            except Exception:
                try:
                    self.proc.kill()
                except Exception:
                    pass
            logger.info(f"[*] 节点 [{self.config.name}] 隧道已释放。")

        # 安全销毁临时私钥与密码凭据脚本
        if self.temp_key_file and os.path.exists(self.temp_key_file):
            try:
                os.remove(self.temp_key_file)
            except Exception:
                pass
        if self.askpass_script and os.path.exists(self.askpass_script):
            try:
                os.remove(self.askpass_script)
            except Exception:
                pass


class SSHTunnelManager:
    """
    通用集群多隧道调度管理器 (支持上下文管理器 with SSHTunnelManager() as tm:)
    负责批量拉起多节点隧道，自动递增分发 19222, 19223, 19224... 端口，
    遇到异常节点时，自动捕获、触发日志、跳过并汇总记录。
    """
    def __init__(self, start_port: int = 19222, base_local_port: Optional[int] = None, auto_close: bool = False):
        self.start_port = base_local_port if base_local_port is not None else start_port
        self.auto_close = auto_close
        self.tunnels: Dict[str, SshTunnelSession] = {}
        self.skips: List[Dict[str, Any]] = []
        self._current_allocated_port = self.start_port

    def allocate_port(self, config: Optional[Union[TunnelConfig, dict]] = None) -> int:
        """为新隧道或节点动态分配下一个唯一递增端口 (默认 19222 起步)"""
        port = self._current_allocated_port
        self._current_allocated_port += 1
        return port

    def add_tunnel(self, config: Union[TunnelConfig, dict]) -> SshTunnelSession:
        cfg = config if isinstance(config, TunnelConfig) else TunnelConfig(**config)
        session = SshTunnelSession(cfg)
        self.tunnels[cfg.id] = session
        return session

    def start_all(self, skip_on_failure: bool = True) -> Dict[str, int]:
        """
        批量启动所有隧道，自动分配端口并跳过故障节点
        返回: { node_id: local_bound_port }
        """
        active_ports: Dict[str, int] = {}
        allocated_port = self.start_port

        for nid, tunnel in self.tunnels.items():
            if tunnel.config.local_port is None or tunnel.config.local_port == 19222:
                tunnel.local_port = allocated_port
                tunnel.config.local_port = allocated_port
                allocated_port += 1

            try:
                port = tunnel.start(auto_close=self.auto_close)
                active_ports[nid] = port
            except TunnelException as te:
                skip_info = {
                    "node_id": nid,
                    "name": tunnel.config.name,
                    "host": tunnel.config.ssh_host,
                    "code": te.code,
                    "error": te.message,
                    "suggestion": te.suggestion
                }
                self.skips.append(skip_info)
                logger.warning(f"⚠️ [SKIP] [{te.code}] 跳过异常节点 {tunnel.config.name} ({tunnel.config.ssh_host}): {te.message}")
                if not skip_on_failure:
                    raise te
            except Exception as e:
                skip_info = {
                    "node_id": nid,
                    "name": tunnel.config.name,
                    "host": tunnel.config.ssh_host,
                    "code": "UNKNOWN_ERROR",
                    "error": str(e)
                }
                self.skips.append(skip_info)
                logger.error(f"⚠️ [SKIP] 跳过未预料故障节点 {tunnel.config.name}: {e}")
                if not skip_on_failure:
                    raise e

        return active_ports

    def stop_all(self, force: bool = False):
        for tunnel in self.tunnels.values():
            tunnel.stop(force=force or self.auto_close)
        self.tunnels.clear()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.stop_all(force=True)


# 快捷别名导出
SSHTunnel = SshTunnelSession
