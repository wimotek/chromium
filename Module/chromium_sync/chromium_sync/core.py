#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Chromium Cluster Session & Cookie Synchronizer
现代多节点 Chromium 会话同步与连接池调度引擎
- 支持 1对1 与 1对多集群拓扑
- 域名过滤机制 (include_domains / exclude_domains) 剔除广告/统计垃圾 Cookie
- 会话级连接池复用 (支持 async with / with 上下文管理器，避免频繁握手)
- Cookie 指纹差量比对 (Diff / Delta Sync，避免重复落盘，保护从节点磁盘 IO)
- 本地节点直接直连免密免隧道，远程节点支持 SSH 私钥内容(PEM)/路径与密码
- 结构化指标返回与轻量静态探针工具
"""

import asyncio
import json
import logging
import os
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Optional, Union, Any, Tuple, TYPE_CHECKING

if TYPE_CHECKING:
    from playwright.async_api import BrowserContext, Playwright, Browser
else:
    BrowserContext = Any
    Playwright = Any
    Browser = Any


# =============================================================================
# 域名过滤与指纹计算辅助函数
# =============================================================================

def is_domain_match(cookie_domain: str, pattern: str) -> bool:
    """
    严格判定 Cookie 域名是否匹配规则。
    例如:
      '.mail.google.com' 与 'google.com' -> True
      'google.com' 与 '.google.com' -> True
      'doubleclick.net' 与 'doubleclick.net' -> True
      'notgoogle.com' 与 'google.com' -> False
    """
    c_dom = cookie_domain.lstrip(".").lower()
    p_dom = pattern.lstrip(".").lower()
    return c_dom == p_dom or c_dom.endswith("." + p_dom)


def filter_cookie_by_domain(
    cookie: dict,
    include_domains: Optional[List[str]] = None,
    exclude_domains: Optional[List[str]] = None
) -> bool:
    """按白名单与黑名单过滤单条 Cookie"""
    domain = cookie.get("domain", "")
    if not domain:
        return True

    # 1. 黑名单过滤：命中任何排除项立即丢弃
    if exclude_domains:
        for ex in exclude_domains:
            if is_domain_match(domain, ex):
                return False

    # 2. 白名单过滤：若开启白名单，必须至少命中一项
    if include_domains:
        matched = False
        for inc in include_domains:
            if is_domain_match(domain, inc):
                matched = True
                break
        if not matched:
            return False

    return True


def filter_cookies(
    cookies: List[dict],
    include_domains: Optional[List[str]] = None,
    exclude_domains: Optional[List[str]] = None
) -> List[dict]:
    """批量过滤 Cookie 列表"""
    if not include_domains and not exclude_domains:
        return cookies
    return [c for c in cookies if filter_cookie_by_domain(c, include_domains, exclude_domains)]


def get_cookie_fingerprint(c: dict) -> Tuple[str, str, str, str]:
    """获取 Cookie 核心指纹 (name, domain, path, value)"""
    return (
        c.get("name", ""),
        c.get("domain", "").lstrip(".").lower(),
        c.get("path", "/"),
        c.get("value", "")
    )


def compute_cookie_delta(
    incoming_cookies: List[dict],
    existing_cookies: List[dict]
) -> Tuple[List[dict], int]:
    """
    计算 Cookie 指纹变更差量 (Diff)：
    返回: (需要实际写入的新增/变更 Cookie 列表, 无需写入的相同跳过条数)
    """
    existing_fps = {get_cookie_fingerprint(c) for c in existing_cookies}
    delta = []
    skipped = 0

    for c in incoming_cookies:
        fp = get_cookie_fingerprint(c)
        if fp in existing_fps:
            skipped += 1
        else:
            delta.append(c)

    return delta, skipped


@dataclass
class NodeConfig:
    """
    统一节点配置
    - 本地节点：只需提供 cdp_port (无需提供 ssh_host，自动识别为本地免密直连)
    - 远程节点：提供 ssh_host, cdp_port
    - 认证方式：
      * ssh_key: 原生支持私钥文件绝对路径 或 私钥 PEM 文本内容字符串
      * ssh_password: SSH 密码认证
    """
    id: str
    name: str = ""
    is_local: bool = False
    cdp_host: str = "127.0.0.1"
    cdp_port: int = 9222
    ssh_host: Optional[str] = None
    ssh_port: int = 22
    ssh_user: str = "root"
    ssh_key: Optional[str] = None
    ssh_key_path: Optional[str] = None
    ssh_key_data: Optional[str] = None
    ssh_password: Optional[str] = None
    tunnel_port: Optional[int] = None

    def __post_init__(self):
        if not self.name:
            self.name = self.id

        # 智能判定本地节点：未提供 ssh_host 或指定本地回环
        if not self.ssh_host or self.ssh_host.strip() in ("127.0.0.1", "localhost", "::1", ""):
            self.is_local = True

        # 本地节点无需额外隧道映射，直接连接 cdp_port
        if self.is_local:
            self.tunnel_port = self.cdp_port

        # 智能解析 ssh_key：支持文件路径或 PEM 字符串内容
        key_input = self.ssh_key or self.ssh_key_path or self.ssh_key_data
        if key_input:
            key_str = key_input.strip()
            if "-----BEGIN" in key_str or "\n" in key_str:
                self.ssh_key_data = key_str
            else:
                expanded = os.path.expanduser(key_str)
                if os.path.exists(expanded):
                    self.ssh_key_path = expanded
                else:
                    self.ssh_key_path = expanded

    @property
    def cdp_url(self) -> str:
        if self.is_local:
            return f"http://{self.cdp_host}:{self.cdp_port}"
        return f"http://127.0.0.1:{self.tunnel_port}"


def merge_cookies(
    cookies_lists: List[List[dict]],
    include_domains: Optional[List[str]] = None,
    exclude_domains: Optional[List[str]] = None
) -> List[dict]:
    """
    合并各节点 Cookie，针对同一 Cookie 保留有效期最新 (expires 最长) 的记录。
    自动应用白名单与黑名单过滤。
    """
    merged_map: Dict[tuple, dict] = {}

    for cookies in cookies_lists:
        filtered = filter_cookies(cookies, include_domains, exclude_domains)
        for c in filtered:
            name = c.get("name", "")
            domain = c.get("domain", "").lstrip(".").lower()
            path = c.get("path", "/")
            key = (name, domain, path)

            if key not in merged_map:
                merged_map[key] = dict(c)
                continue

            existing = merged_map[key]
            curr_exp = float(c.get("expires") or -1)
            exist_exp = float(existing.get("expires") or -1)

            should_replace = False
            if curr_exp > 0 and exist_exp > 0:
                if curr_exp > exist_exp:
                    should_replace = True
            elif curr_exp > 0 and exist_exp <= 0:
                should_replace = True
            elif curr_exp <= 0 and exist_exp <= 0:
                val_curr = str(c.get("value", ""))
                val_exist = str(existing.get("value", ""))
                if val_curr and not val_exist:
                    should_replace = True
                elif len(val_curr) > len(val_exist):
                    should_replace = True

            if should_replace:
                merged_map[key] = dict(c)

    return list(merged_map.values())


class SshTunnelSession:
    """
    SSH 隧道生命周期管理
    - 支持密钥文本 (PEM String) 自动写入安全受限临时文件
    - 支持密钥路径与密码认证
    - 支持端口复用检测与防僵尸连接自愈
    """
    def __init__(self, node: NodeConfig):
        self.node = node
        self.proc: Optional[subprocess.Popen] = None
        self.is_reused: bool = False
        self.temp_key_file: Optional[str] = None
        self.askpass_script: Optional[str] = None

    def _is_port_in_use(self, port: int) -> bool:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.3)
            return s.connect_ex(("127.0.0.1", port)) == 0

    def _is_cdp_ready(self, url: str) -> bool:
        try:
            proxy_handler = urllib.request.ProxyHandler({})
            opener = urllib.request.build_opener(proxy_handler)
            resp = opener.open(f"{url}/json/version", timeout=1.5)
            return resp.getcode() == 200
        except Exception:
            return False

    def start(self, auto_close: bool = False):
        if self.node.is_local:
            return

        target_local_port = self.node.tunnel_port
        target_url = f"http://127.0.0.1:{target_local_port}"

        if self._is_port_in_use(target_local_port):
            if self._is_cdp_ready(target_url):
                logging.info(f"[*] 节点 [{self.node.name}] 本地端口 {target_local_port} 已通畅，复用现有连接。")
                self.is_reused = True
                return

        logging.info(
            f"[*] 正在拉起 SSH 隧道: {self.node.name} -> {self.node.ssh_user}@{self.node.ssh_host}:{self.node.ssh_port} "
            f"(本地 127.0.0.1:{target_local_port} -> 远程 127.0.0.1:{self.node.cdp_port}) ..."
        )

        ssh_cmd = [
            "ssh", "-N",
            "-p", str(self.node.ssh_port),
            "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=3",
            "-o", "TCPKeepAlive=yes",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "ExitOnForwardFailure=yes",
            "-L", f"{target_local_port}:127.0.0.1:{self.node.cdp_port}"
        ]

        env = os.environ.copy()

        if self.node.ssh_key_data:
            fd, tmp_path = tempfile.mkstemp(prefix="ssh_key_")
            with open(tmp_path, "w") as f:
                f.write(self.node.ssh_key_data.strip() + "\n")
            os.close(fd)
            os.chmod(tmp_path, 0o600)
            self.temp_key_file = tmp_path
            ssh_cmd.extend(["-i", tmp_path])
        elif self.node.ssh_key_path:
            expanded_key = os.path.expanduser(self.node.ssh_key_path)
            if os.path.exists(expanded_key):
                ssh_cmd.extend(["-i", expanded_key])

        if self.node.ssh_password:
            if shutil.which("sshpass"):
                ssh_cmd = ["sshpass", "-p", self.node.ssh_password] + ssh_cmd
            else:
                fd, askpass_path = tempfile.mkstemp(prefix="askpass_", suffix=".sh")
                escaped_pw = self.node.ssh_password.replace("'", "'\\''")
                with open(askpass_path, "w") as f:
                    f.write(f"#!/bin/sh\necho '{escaped_pw}'\n")
                os.close(fd)
                os.chmod(askpass_path, 0o700)
                self.askpass_script = askpass_path
                env["SSH_ASKPASS"] = askpass_path
                env["SSH_ASKPASS_REQUIRE"] = "force"
                env["DISPLAY"] = ":0"
                ssh_cmd.extend(["-o", "BatchMode=no"])

        ssh_cmd.append(f"{self.node.ssh_user}@{self.node.ssh_host}")

        try:
            self.proc = subprocess.Popen(
                ssh_cmd,
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=(not auto_close)
            )
        except FileNotFoundError:
            raise RuntimeError(f"[-] 系统未找到 ssh 可执行文件，无法为远程节点 [{self.node.name}] 建立隧道！")

        for _ in range(25):
            time.sleep(0.4)
            if self._is_port_in_use(target_local_port) and self._is_cdp_ready(target_url):
                logging.info(f"[+] 节点 [{self.node.name}] SSH 隧道建立成功 (端口: {target_local_port})。")
                return
            if self.proc.poll() is not None:
                break

        self.stop(force=True)
        raise RuntimeError(f"[-] 建立 SSH 隧道失败 [{self.node.name}]，请检查网络或认证凭据！")

    def stop(self, force: bool = False):
        if self.is_reused and not force:
            return

        if self.proc and self.proc.poll() is None:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=2)
            except Exception:
                self.proc.kill()
            logging.info(f"[*] 节点 [{self.node.name}] 隧道已释放。")

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


class ChromiumSync:
    """
    现代多节点 Chromium 会话同步与连接池调度管理器
    """
    def __init__(
        self,
        nodes: List[Union[NodeConfig, dict]],
        mode: str = "sync",                     # "sync" (单源广播) 或 "merge" (全节点合并最新)
        source: Optional[str] = None,           # sync 模式下的源节点 ID (默认第一个节点)
        targets: Optional[List[str]] = None,    # sync 模式下的目标节点 ID 列表 (默认其余全部在线节点)
        include_domains: Optional[List[str]] = None, # 域名白名单过滤 (如 ['.google.com', '.github.com'])
        exclude_domains: Optional[List[str]] = None, # 域名黑名单过滤 (如 ['doubleclick.net', 'google-analytics.com'])
        diff: bool = True,                      # 是否开启 Cookie 指纹差量写入 (避免无变更频繁刷盘)
        ssh_key: Optional[str] = None,          # 集群通用私钥 (路径 或 PEM String)
        ssh_password: Optional[str] = None,     # 集群通用 SSH 密码
        auto_close_tunnel: bool = False,
        verbose: bool = True
    ):
        if not nodes:
            raise ValueError("[-] 必须至少提供一个节点配置！")

        self.mode = mode.lower()
        if self.mode not in ("sync", "merge"):
            raise ValueError(f"[-] 未知的同步模式 '{self.mode}'，仅支持 'sync' 或 'merge'")

        self.source = source
        self.targets = targets or []
        self.include_domains = include_domains
        self.exclude_domains = exclude_domains
        self.diff = diff
        self.auto_close_tunnel = auto_close_tunnel

        log_level = logging.INFO if verbose else logging.WARNING
        logging.basicConfig(level=log_level, format="%(asctime)s [%(levelname)s] %(message)s")

        # 初始化节点与隧道端口分配
        self.nodes: List[NodeConfig] = []
        used_tunnel_ports = set()
        auto_port = 19222

        for item in nodes:
            cfg = item if isinstance(item, NodeConfig) else NodeConfig(**item)
            if not cfg.is_local:
                if not cfg.ssh_key and not cfg.ssh_key_path and not cfg.ssh_key_data and ssh_key:
                    cfg.ssh_key = ssh_key
                    cfg.__post_init__()
                if not cfg.ssh_password and ssh_password:
                    cfg.ssh_password = ssh_password

                if not cfg.tunnel_port:
                    while auto_port in used_tunnel_ports:
                        auto_port += 1
                    cfg.tunnel_port = auto_port
                    used_tunnel_ports.add(auto_port)
                    auto_port += 1
                else:
                    used_tunnel_ports.add(cfg.tunnel_port)
            self.nodes.append(cfg)

        self.tunnels: Dict[str, SshTunnelSession] = {}

        # 连接池模式状态
        self._pool_active: bool = False
        self._pool_playwright: Optional[Any] = None
        self._pooled_browsers: Dict[str, Any] = {}
        self._pooled_contexts: Dict[str, BrowserContext] = {}

    # =========================================================================
    # 会话级连接池复用 (Connection Pooling 上下文管理器)
    # =========================================================================

    async def __aenter__(self):
        """异步上下文管理器入口：拉起隧道并预热持久 WebSocket CDP 连接池"""
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            raise RuntimeError("[-] 未安装 playwright 模块，请先运行: pip install playwright && playwright install chromium")

        logging.info("[*] 正在启动会话级连接池 (Connection Pooling)...")
        self._start_all_tunnels()
        self._pool_playwright = await async_playwright().start()
        self._pooled_browsers = {}
        self._pooled_contexts = {}

        for node in self.nodes:
            cdp_url = node.cdp_url
            try:
                b = await self._pool_playwright.chromium.connect_over_cdp(cdp_url)
                ctx = b.contexts[0] if b.contexts else await b.new_context()
                self._pooled_browsers[node.id] = b
                self._pooled_contexts[node.id] = ctx
            except Exception as e:
                logging.warning(f"[-] 连接池预连接节点 [{node.name}] 失败: {e}")

        self._pool_active = True
        logging.info(f"[+] 连接池已就绪: 已接入 {len(self._pooled_contexts)} 个常驻节点连接。")
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """异步上下文管理器出口：安全释放连接池与隧道"""
        logging.info("[*] 正在关闭会话级连接池...")
        for b in self._pooled_browsers.values():
            try:
                await b.close()
            except Exception:
                pass
        self._pooled_browsers.clear()
        self._pooled_contexts.clear()

        if self._pool_playwright:
            try:
                await self._pool_playwright.stop()
            except Exception:
                pass
            self._pool_playwright = None

        self._pool_active = False
        self._stop_all_tunnels(force=True)
        logging.info("[+] 会话级连接池已安全释放。")

    def __enter__(self):
        """同步上下文管理器入口"""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        if loop and loop.is_running():
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                return pool.submit(asyncio.run, self.__aenter__()).result()
        else:
            return asyncio.run(self.__aenter__())

    def __exit__(self, exc_type, exc_val, exc_tb):
        """同步上下文管理器出口"""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        if loop and loop.is_running():
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                return pool.submit(asyncio.run, self.__aexit__(exc_type, exc_val, exc_tb)).result()
        else:
            return asyncio.run(self.__aexit__(exc_type, exc_val, exc_tb))

    # =========================================================================
    # 静态探针与工具方法 (轻量级无需实例化 ChromiumSync)
    # =========================================================================

    @staticmethod
    async def get_cookies_async(
        port: int = 9222,
        host: str = "127.0.0.1",
        include_domains: Optional[List[str]] = None,
        exclude_domains: Optional[List[str]] = None
    ) -> List[dict]:
        """[静态异步工具] 直接连通指定 CDP 端口获取 Cookie 列表 (支持域名过滤)"""
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            raise RuntimeError("[-] 未安装 playwright 模块，请先运行: pip install playwright && playwright install chromium")

        cdp_url = f"http://{host}:{port}"
        async with async_playwright() as p:
            browser = await p.chromium.connect_over_cdp(cdp_url)
            ctx = browser.contexts[0] if browser.contexts else await browser.new_context()
            cookies = await ctx.cookies()
            await browser.close()
            return filter_cookies(cookies, include_domains, exclude_domains)

    @staticmethod
    def get_cookies_from_host(
        port: int = 9222,
        host: str = "127.0.0.1",
        include_domains: Optional[List[str]] = None,
        exclude_domains: Optional[List[str]] = None
    ) -> List[dict]:
        """[静态同步工具] 直接连通指定 CDP 端口获取 Cookie 列表"""
        return asyncio.run(ChromiumSync.get_cookies_async(
            port=port, host=host, include_domains=include_domains, exclude_domains=exclude_domains
        ))

    @staticmethod
    async def set_cookies_async(
        cookies: List[dict],
        port: int = 9222,
        host: str = "127.0.0.1",
        reload: bool = True,
        diff: bool = True
    ) -> bool:
        """[静态异步工具] 向指定 CDP 端口写入 Cookie (支持指纹差量 Diff 过滤与热刷新)"""
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            raise RuntimeError("[-] 未安装 playwright 模块，请先运行: pip install playwright && playwright install chromium")

        cdp_url = f"http://{host}:{port}"
        async with async_playwright() as p:
            browser = await p.chromium.connect_over_cdp(cdp_url)
            ctx = browser.contexts[0] if browser.contexts else await browser.new_context()

            target_cookies = cookies
            if diff:
                existing = await ctx.cookies()
                target_cookies, skipped = compute_cookie_delta(cookies, existing)
                if not target_cookies:
                    await browser.close()
                    return True

            if target_cookies:
                await ctx.add_cookies(target_cookies)
            if reload and ctx.pages:
                try:
                    await ctx.pages[0].reload()
                except Exception:
                    pass
            await browser.close()
            return True

    @staticmethod
    def set_cookies(
        cookies: List[dict],
        port: int = 9222,
        host: str = "127.0.0.1",
        reload: bool = True,
        diff: bool = True
    ) -> bool:
        """[静态同步工具] 向指定 CDP 端口写入 Cookie"""
        return asyncio.run(ChromiumSync.set_cookies_async(
            cookies, port=port, host=host, reload=reload, diff=diff
        ))

    @staticmethod
    async def probe_async(port: int = 9222, host: str = "127.0.0.1") -> dict:
        """[静态异步工具] 单点探测 CDP 节点状态 (包含在线状态、Cookie 数与页面标题)"""
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            raise RuntimeError("[-] 未安装 playwright 模块，请先运行: pip install playwright && playwright install chromium")

        cdp_url = f"http://{host}:{port}"
        try:
            async with async_playwright() as p:
                browser = await p.chromium.connect_over_cdp(cdp_url)
                ctx = browser.contexts[0] if browser.contexts else await browser.new_context()
                cookies = await ctx.cookies()
                page_title = ""
                page_url = ""
                if ctx.pages:
                    p_obj = ctx.pages[0]
                    page_url = p_obj.url
                    try:
                        page_title = await p_obj.title()
                    except Exception:
                        pass
                await browser.close()
                return {
                    "online": True,
                    "host": host,
                    "port": port,
                    "cdp_url": cdp_url,
                    "cookie_count": len(cookies),
                    "page_title": page_title,
                    "page_url": page_url,
                    "error": None
                }
        except Exception as e:
            return {
                "online": False,
                "host": host,
                "port": port,
                "cdp_url": cdp_url,
                "cookie_count": 0,
                "page_title": "",
                "page_url": "",
                "error": str(e)
            }

    @staticmethod
    def probe(port: int = 9222, host: str = "127.0.0.1") -> dict:
        """[静态同步工具] 单点探测 CDP 节点状态"""
        return asyncio.run(ChromiumSync.probe_async(port=port, host=host))

    # =========================================================================
    # 集群管理与同步
    # =========================================================================

    def _start_all_tunnels(self):
        for node in self.nodes:
            if not node.is_local:
                tunnel = SshTunnelSession(node)
                tunnel.start(auto_close=self.auto_close_tunnel)
                self.tunnels[node.id] = tunnel

    def _stop_all_tunnels(self, force: bool = False):
        for tunnel in self.tunnels.values():
            tunnel.stop(force=force or self.auto_close_tunnel)
        self.tunnels.clear()

    async def _fetch_node_data(self, browser_ctx: BrowserContext, node: NodeConfig) -> dict:
        raw_cookies = await browser_ctx.cookies()
        # 域过滤
        cookies = filter_cookies(raw_cookies, self.include_domains, self.exclude_domains)
        storage_state = await browser_ctx.storage_state()

        page_info = "无打开页面"
        page_url = ""
        page_title = ""
        if browser_ctx.pages:
            p = browser_ctx.pages[0]
            page_url = p.url
            try:
                page_title = await p.title()
                page_info = f"[{page_title}] {p.url}"
            except Exception:
                page_info = p.url

        storage_origins = len(storage_state.get("origins", []))

        return {
            "id": node.id,
            "name": node.name,
            "is_local": node.is_local,
            "cdp_url": node.cdp_url,
            "online": True,
            "cookie_count": len(cookies),
            "raw_cookie_count": len(raw_cookies),
            "cookies": cookies,
            "page_info": page_info,
            "page_title": page_title,
            "page_url": page_url,
            "storage_origins": storage_origins,
            "storage_state": storage_state
        }

    async def inspect_async(self) -> Dict[str, dict]:
        """异步获取所有节点的完整状态与 Cookie 数据"""
        # 如果当前在连接池上下文中，复用已有连接
        if self._pool_active:
            results: Dict[str, dict] = {}
            for node in self.nodes:
                ctx = self._pooled_contexts.get(node.id)
                if ctx:
                    results[node.id] = await self._fetch_node_data(ctx, node)
                else:
                    results[node.id] = {
                        "id": node.id,
                        "name": node.name,
                        "is_local": node.is_local,
                        "cdp_url": node.cdp_url,
                        "online": False,
                        "cookie_count": 0,
                        "cookies": [],
                        "page_info": "离线"
                    }
            return results

        # 独立运行模式
        self._start_all_tunnels()
        results: Dict[str, dict] = {}

        try:
            from playwright.async_api import async_playwright
        except ImportError:
            raise RuntimeError("[-] 未安装 playwright 模块，请先运行: pip install playwright && playwright install chromium")

        try:
            async with async_playwright() as p:
                for node in self.nodes:
                    cdp_url = node.cdp_url
                    try:
                        browser = await p.chromium.connect_over_cdp(cdp_url)
                        ctx = browser.contexts[0] if browser.contexts else await browser.new_context()
                        results[node.id] = await self._fetch_node_data(ctx, node)
                        await browser.close()
                    except Exception as e:
                        logging.warning(f"无法连通节点 [{node.name}] ({cdp_url}): {e}")
                        results[node.id] = {
                            "id": node.id,
                            "name": node.name,
                            "is_local": node.is_local,
                            "cdp_url": cdp_url,
                            "online": False,
                            "error": str(e),
                            "cookie_count": 0,
                            "cookies": [],
                            "page_info": "离线",
                            "page_title": "",
                            "page_url": "",
                            "storage_origins": 0,
                            "storage_state": {}
                        }
        finally:
            self._stop_all_tunnels()

        return results

    def inspect(self) -> Dict[str, dict]:
        """同步获取所有节点完整状态与 Cookie 数据"""
        return asyncio.run(self.inspect_async())

    def _get_instance_cookies(self, node_id: Optional[str] = None) -> Union[List[dict], Dict[str, List[dict]]]:
        report = self.inspect()
        if node_id:
            return report.get(node_id, {}).get("cookies", [])
        return {nid: data.get("cookies", []) for nid, data in report.items()}

    def get_cookies(self, *args, **kwargs) -> Any:
        """
        双模式 Cookie 获取接口：
        1. 实例调用: syncer.get_cookies(node_id="local") -> 返回集群节点 Cookie
        2. 静态/类调用: ChromiumSync.get_cookies(port=9222, host="127.0.0.1") -> 单点直接获取
        """
        if isinstance(self, ChromiumSync):
            node_id = kwargs.get("node_id") if "node_id" in kwargs else (args[0] if args else None)
            return self._get_instance_cookies(node_id)
        else:
            port = args[0] if args else kwargs.get("port", 9222)
            host = args[1] if len(args) > 1 else kwargs.get("host", "127.0.0.1")
            inc = kwargs.get("include_domains")
            exc = kwargs.get("exclude_domains")
            return ChromiumSync.get_cookies_from_host(port=port, host=host, include_domains=inc, exclude_domains=exc)

    def get_summary_table(self, report: Optional[Dict[str, dict]] = None) -> str:
        """生成格式化节点状态 ASCII 摘要表"""
        if report is None:
            report = self.inspect()

        filter_note = ""
        if self.include_domains:
            filter_note += f" [白名单: {', '.join(self.include_domains)}]"
        if self.exclude_domains:
            filter_note += f" [黑名单: {', '.join(self.exclude_domains)}]"

        lines = [
            "\n" + "=" * 92,
            f"{'节点 ID':<10} | {'节点名称':<14} | {'类型':<10} | {'CDP端口/映射':<12} | {'Cookie有效数':<12} | {'当前页面状态'}",
            "-" * 92
        ]

        for nid, data in report.items():
            ntype = "本地直连" if data.get("is_local") else "SSH远程"
            port_str = data.get("cdp_url", "").split(":")[-1]
            status_cookie = f"{data.get('cookie_count', 0)} 条" if data.get("online") else "离线"
            page_text = data.get("page_info", "未知")
            if len(page_text) > 30:
                page_text = page_text[:27] + "..."
            lines.append(f"{nid:<10} | {data.get('name', nid):<14} | {ntype:<10} | {port_str:<12} | {status_cookie:<12} | {page_text}")

        if filter_note:
            lines.append("-" * 92)
            lines.append(f"过滤规则:{filter_note}")

        lines.append("=" * 92 + "\n")
        return "\n".join(lines)

    async def _apply_cookies_and_storage(
        self,
        target_ctx: BrowserContext,
        target_node: NodeConfig,
        cookies: List[dict],
        storage_state: Optional[dict] = None
    ) -> Tuple[int, int]:
        """
        向目标节点写入 Cookie 与 LocalStorage
        返回值: (实际写入的新增/变更数量, 跳过的相同数量)
        """
        actual_written = len(cookies)
        diff_skipped = 0

        # Cookie 指纹差量比对
        if self.diff:
            existing_cookies = await target_ctx.cookies()
            delta_cookies, diff_skipped = compute_cookie_delta(cookies, existing_cookies)
            actual_written = len(delta_cookies)
            if delta_cookies:
                await target_ctx.add_cookies(delta_cookies)
                logging.info(
                    f" -> 节点 [{target_node.name}] 差量写入: 更新 {actual_written} 条, 跳过一致凭据 {diff_skipped} 条"
                )
            else:
                logging.info(f" -> 节点 [{target_node.name}] 指纹比对完全一致 (跳过 {diff_skipped} 条)，免刷盘。")
        else:
            if cookies:
                await target_ctx.add_cookies(cookies)

        # 写入 LocalStorage
        has_storage_changes = False
        if target_ctx.pages and storage_state:
            p = target_ctx.pages[0]
            for origin in storage_state.get("origins", []):
                origin_url = origin.get("origin", "")
                items = origin.get("localStorage", [])
                if items:
                    has_storage_changes = True
                    if p.url.startswith("about:") and origin_url:
                        try:
                            await p.goto(origin_url)
                        except Exception:
                            pass
                    try:
                        await p.evaluate(
                            """(items) => {
                                for (const item of items) {
                                    try { window.localStorage.setItem(item.name, item.value); } catch(e){}
                                }
                            }""",
                            items
                        )
                    except Exception:
                        pass

        # 仅在实际写入了 Cookie 或 LocalStorage 变更时热重载
        if (actual_written > 0 or has_storage_changes) and target_ctx.pages:
            try:
                await target_ctx.pages[0].reload()
                logging.info(f" -> 节点 [{target_node.name}] 页面热刷新成功！")
            except Exception:
                pass

        return actual_written, diff_skipped

    async def run_async(
        self,
        mode: Optional[str] = None,
        source: Optional[str] = None,
        targets: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """
        [原生异步执行入口]
        返回结构化执行结果字典 (包含 status, transferred_count, diff_skipped_count, duration 等指标)。
        在 async with 连接池上下文内自动复用连接，避免重复握手。
        """
        start_time = time.time()
        active_mode = (mode or self.mode).lower()
        active_source = source or self.source
        active_targets = targets or self.targets

        try:
            from playwright.async_api import async_playwright
        except ImportError:
            elapsed = round(time.time() - start_time, 2)
            return {
                "status": "failed",
                "mode": active_mode,
                "transferred_count": 0,
                "diff_skipped_count": 0,
                "source_total": 0,
                "target_total": 0,
                "nodes_synced": [],
                "duration": elapsed,
                "details": "未安装 playwright 模块，请先运行: pip install playwright && playwright install chromium",
                "error": "playwright not installed"
            }

        is_pooled = self._pool_active
        if not is_pooled:
            self._start_all_tunnels()

        try:
            browsers: Dict[str, Any] = {}
            contexts: Dict[str, BrowserContext] = {}
            nodes_data: Dict[str, dict] = {}

            if is_pooled:
                contexts = self._pooled_contexts
                for node in self.nodes:
                    if node.id in contexts:
                        nodes_data[node.id] = await self._fetch_node_data(contexts[node.id], node)
            else:
                async with async_playwright() as p:
                    for node in self.nodes:
                        cdp_url = node.cdp_url
                        try:
                            b = await p.chromium.connect_over_cdp(cdp_url)
                            ctx = b.contexts[0] if b.contexts else await b.new_context()
                            browsers[node.id] = b
                            contexts[node.id] = ctx
                            nodes_data[node.id] = await self._fetch_node_data(ctx, node)
                        except Exception as e:
                            logging.error(f"[-] 连接节点 [{node.name}] 失败 ({cdp_url}): {e}")

                    if not contexts:
                        elapsed = round(time.time() - start_time, 2)
                        return {
                            "status": "failed",
                            "mode": active_mode,
                            "transferred_count": 0,
                            "diff_skipped_count": 0,
                            "source_total": 0,
                            "target_total": 0,
                            "nodes_synced": [],
                            "duration": elapsed,
                            "details": "无可用在线节点，同步终止",
                            "error": "No available online nodes"
                        }

                    res = await self._execute_sync_flow(
                        active_mode, active_source, active_targets, contexts, nodes_data, start_time
                    )
                    for b in browsers.values():
                        await b.close()
                    return res

            # 连接池模式下执行核心逻辑
            if not contexts:
                elapsed = round(time.time() - start_time, 2)
                return {
                    "status": "failed",
                    "mode": active_mode,
                    "transferred_count": 0,
                    "diff_skipped_count": 0,
                    "source_total": 0,
                    "target_total": 0,
                    "nodes_synced": [],
                    "duration": elapsed,
                    "details": "连接池中无可用在线节点",
                    "error": "No available online nodes in pool"
                }

            return await self._execute_sync_flow(
                active_mode, active_source, active_targets, contexts, nodes_data, start_time
            )

        except Exception as e:
            elapsed = round(time.time() - start_time, 2)
            logging.error(f"[-] 同步发生异常: {e}")
            return {
                "status": "failed",
                "mode": active_mode,
                "transferred_count": 0,
                "diff_skipped_count": 0,
                "source_total": 0,
                "target_total": 0,
                "nodes_synced": [],
                "duration": elapsed,
                "details": f"同步发生异常: {e}",
                "error": str(e)
            }
        finally:
            if not is_pooled:
                self._stop_all_tunnels()

    async def _execute_sync_flow(
        self,
        active_mode: str,
        active_source: Optional[str],
        active_targets: Optional[List[str]],
        contexts: Dict[str, BrowserContext],
        nodes_data: Dict[str, dict],
        start_time: float
    ) -> Dict[str, Any]:
        """内部执行流"""
        print(self.get_summary_table(nodes_data))
        total_transferred = 0
        total_skipped = 0

        if active_mode == "merge":
            logging.info("[*] 正在执行全节点 Cookie 智能 Merge (合并最新有效凭据)...")
            all_cookies = [data["cookies"] for data in nodes_data.values() if data.get("cookies")]
            source_total = sum(len(c) for c in all_cookies)
            merged = merge_cookies(all_cookies, self.include_domains, self.exclude_domains)
            logging.info(f" -> 汇总融合完成: 共生成 {len(merged)} 条最新有效 Cookie")

            combined_storage = {"origins": []}
            origin_map = {}
            for data in nodes_data.values():
                for orig in data.get("storage_state", {}).get("origins", []):
                    ourl = orig.get("origin")
                    if ourl not in origin_map:
                        origin_map[ourl] = []
                    origin_map[ourl].extend(orig.get("localStorage", []))
            for ourl, items in origin_map.items():
                combined_storage["origins"].append({"origin": ourl, "localStorage": items})

            dest_nodes = [n for n in self.nodes if n.id in contexts]
            if active_targets:
                dest_nodes = [n for n in dest_nodes if n.id in active_targets]

            for dest in dest_nodes:
                logging.info(f"[*] 注入合并凭据至节点: [{dest.name}]")
                w, s = await self._apply_cookies_and_storage(
                    contexts[dest.id],
                    dest,
                    merged,
                    combined_storage
                )
                total_transferred += w
                total_skipped += s

            elapsed = round(time.time() - start_time, 2)
            return {
                "status": "success",
                "mode": "merge",
                "transferred_count": total_transferred,
                "diff_skipped_count": total_skipped,
                "source_total": source_total,
                "target_total": len(merged),
                "nodes_synced": [n.id for n in dest_nodes],
                "duration": elapsed,
                "details": f"全节点 Merge 成功: 融合并向 {[n.name for n in dest_nodes]} 写入 {total_transferred} 条凭证 (跳过一致指纹 {total_skipped} 条)",
                "error": None
            }

        elif active_mode == "sync":
            if not active_source:
                active_source = self.nodes[0].id
            if active_source not in contexts:
                raise RuntimeError(f"[-] 指定的源节点 [{active_source}] 未在线！")

            src_data = nodes_data[active_source]
            src_cookies = src_data["cookies"]
            src_storage = src_data["storage_state"]

            dest_nodes = [n for n in self.nodes if n.id != active_source and n.id in contexts]
            if active_targets:
                dest_nodes = [n for n in dest_nodes if n.id in active_targets]

            logging.info(f"[*] 正在执行单源广播同步: [{src_data['name']}] -> {[n.name for n in dest_nodes]}")
            logging.info(f" -> 源有效凭证量: {len(src_cookies)} 条 Cookie")

            for dest in dest_nodes:
                logging.info(f"[*] 正在推送凭证至目标节点: [{dest.name}]")
                w, s = await self._apply_cookies_and_storage(
                    contexts[dest.id],
                    dest,
                    src_cookies,
                    src_storage
                )
                total_transferred += w
                total_skipped += s

            elapsed = round(time.time() - start_time, 2)
            return {
                "status": "success",
                "mode": "sync",
                "transferred_count": total_transferred,
                "diff_skipped_count": total_skipped,
                "source_total": len(src_cookies),
                "target_total": len(src_cookies),
                "nodes_synced": [n.id for n in dest_nodes],
                "duration": elapsed,
                "details": f"单源同步成功: [{src_data['name']}] 写入 {total_transferred} 条凭据至 {[n.name for n in dest_nodes]} (跳过一致指纹 {total_skipped} 条)",
                "error": None
            }

        return {
            "status": "failed",
            "error": f"Unknown mode {active_mode}"
        }

    def run(
        self,
        mode: Optional[str] = None,
        source: Optional[str] = None,
        targets: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """[同步运行入口 (开箱即用)]"""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        if loop and loop.is_running():
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                return pool.submit(
                    asyncio.run,
                    self.run_async(mode=mode, source=source, targets=targets)
                ).result()
        else:
            return asyncio.run(self.run_async(mode=mode, source=source, targets=targets))

    # 快捷别名
    sync = run
    sync_async = run_async
