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
from .audit import AuditLogger

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
    统一节点配置 (支持 CDP Hub 全部 4 种连接方式与离线弹性跳过)
    1. 直连 (direct): 本地或内网直接访问 cdp_port，如 http://192.168.1.100:9222
    2. wss直连 (wss_direct): TLS 网关加密直连，如 wss://hub.internal:8443/devtools/...
    3. wss反穿 (wss_reverse): 边缘端向 Hub 反向长连接的会话映射
    4. ssh穿透 (ssh_tunnel): 通过 wimotek-ssh-tunnel 模块建立加密端口转发 (如 19222 -> 9222)
    """
    id: str
    name: str = ""
    mode: str = "direct"                 # "direct" | "wss_direct" | "wss_reverse" | "ssh_tunnel"
    endpoint_url: Optional[str] = None  # 显式指定完整 CDP 调试 URL (如 wss://... 或 ws://...)
    headers: Optional[Dict[str, str]] = None # 可选 WebSocket/HTTP 鉴权请求头 (如 Bearer token)
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

        # 智能判定连接模式
        if self.endpoint_url:
            raw_url = self.endpoint_url.strip()
            if raw_url.startswith("wss://"):
                self.mode = "wss_direct"
            elif raw_url.startswith("ws://") and ("reverse" in raw_url or "agent" in raw_url):
                self.mode = "wss_reverse"
            elif raw_url.startswith("http://") or raw_url.startswith("ws://"):
                self.mode = "direct"
            self.is_local = False
        elif self.ssh_host and self.ssh_host.strip() not in ("127.0.0.1", "localhost", "::1", ""):
            self.mode = "ssh_tunnel"
            self.is_local = False
        else:
            self.mode = "direct"
            self.is_local = True

        # 本地免密直连无需隧道映射
        if self.is_local and not self.tunnel_port:
            self.tunnel_port = self.cdp_port

        # 智能解析 ssh_key
        key_input = self.ssh_key or self.ssh_key_path or self.ssh_key_data
        if key_input:
            key_str = key_input.strip()
            if "-----BEGIN" in key_str or "\n" in key_str:
                self.ssh_key_data = key_str
            else:
                self.ssh_key_path = os.path.expanduser(key_str)

    @property
    def cdp_url(self) -> str:
        # 1. 显式指定端点 URL (支持 wss://, ws://, http://)
        if self.endpoint_url:
            return self.endpoint_url.strip()

        # 2. SSH 穿透模式 (通过本地映射端口访问)
        if self.mode == "ssh_tunnel":
            return f"http://127.0.0.1:{self.tunnel_port or 19222}"

        # 3. WSS 直连模式
        if self.mode == "wss_direct":
            return f"wss://{self.cdp_host}:{self.cdp_port}"

        # 4. 直连模式 (默认)
        return f"http://{self.cdp_host}:{self.cdp_port}"


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


# =============================================================================
# SSH 隧道管理 (已解耦剥离至独立通用模块 wimotek-ssh-tunnel)
# =============================================================================

try:
    from wimotek_ssh_tunnel import SSHTunnel, SSHTunnelManager, SshTunnelSession, TunnelConfig, TunnelException
    HAS_SSH_TUNNEL = True
except ImportError:
    try:
        import sys
        sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "wimotek-ssh-tunnel")))
        from wimotek_ssh_tunnel import SSHTunnel, SSHTunnelManager, SshTunnelSession, TunnelConfig, TunnelException
        HAS_SSH_TUNNEL = True
    except Exception:
        HAS_SSH_TUNNEL = False
        SSHTunnel = None
        SSHTunnelManager = None
        SshTunnelSession = None
        TunnelConfig = None
        TunnelException = Exception


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
        verbose: bool = True,
        audit_file: Optional[str] = "audit.jsonl",
        audit_max_bytes: int = 10 * 1024 * 1024,
        audit_backup_count: int = 5,
        audit_enabled: bool = True
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

        # 审计日志与自动轮转参数 (开箱即用)
        self.audit_enabled: bool = audit_enabled
        self.audit_file: str = audit_file or "audit.jsonl"
        self.audit_max_bytes: int = audit_max_bytes
        self.audit_backup_count: int = audit_backup_count
        self.audit_logger: Optional[AuditLogger] = (
            AuditLogger(
                file_path=self.audit_file,
                max_bytes=self.audit_max_bytes,
                backup_count=self.audit_backup_count,
                enabled=self.audit_enabled
            )
            if self.audit_enabled and self.audit_file
            else None
        )

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

    def _audit(
        self,
        event_type: str,
        details: Optional[Dict[str, Any]] = None,
        level: str = "INFO",
        **kwargs
    ) -> Optional[Dict[str, Any]]:
        """写入一条结构化审计日志 (自动大小轮转与淘汰)"""
        if self.audit_logger:
            return self.audit_logger.log(event_type, details=details, level=level, **kwargs)
        return None

    def get_audit_records(self, limit: int = 50) -> List[Dict[str, Any]]:
        """读取最近生成的结构化审计日志记录"""
        if self.audit_logger:
            return self.audit_logger.read_recent_records(limit=limit)
        return []

    def get_audit_files(self) -> List[str]:
        """获取当前存在的主日志及轮转归档文件列表"""
        if self.audit_logger:
            return self.audit_logger.get_audit_files()
        return []

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
        """
        拉起所有需要 SSH 穿透的节点 (模式 4)
        直接委托给通用解耦模块 wimotek-ssh-tunnel
        """
        for node in self.nodes:
            if getattr(node, "mode", "direct") == "ssh_tunnel" and not node.is_local:
                if not HAS_SSH_TUNNEL or not SshTunnelSession:
                    raise RuntimeError(
                        f"[-] 节点 [{node.name}] 处于 ssh_tunnel 模式，但未安装独立模块 wimotek-ssh-tunnel！\n"
                        f"请先运行: pip install wimotek-ssh-tunnel"
                    )
                cfg = TunnelConfig(
                    id=node.id,
                    name=node.name,
                    ssh_host=node.ssh_host,
                    ssh_port=node.ssh_port,
                    ssh_user=node.ssh_user,
                    remote_host=node.cdp_host,
                    remote_port=node.cdp_port,
                    local_port=node.tunnel_port or 19222,
                    ssh_key=node.ssh_key_data or node.ssh_key_path or node.ssh_key,
                    ssh_password=node.ssh_password,
                )
                try:
                    tunnel = SshTunnelSession(cfg)
                    tunnel.start(auto_close=self.auto_close_tunnel)
                    self.tunnels[node.id] = tunnel
                except Exception as e:
                    logging.warning(f"⚠️ [SKIP] 节点 [{node.name}] SSH 穿透拉起失败，标记异常跳过: {e}")

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

        self._audit("sync_start", {
            "mode": active_mode,
            "source": active_source,
            "targets": active_targets,
            "nodes": [n.id for n in self.nodes]
        })

        try:
            from playwright.async_api import async_playwright
        except ImportError:
            elapsed = round(time.time() - start_time, 2)
            self._audit("sync_failed", {"reason": "playwright not installed"}, level="ERROR")
            return {
                "status": "failed",
                "mode": active_mode,
                "transferred_count": 0,
                "diff_skipped_count": 0,
                "source_total": 0,
                "target_total": 0,
                "nodes_synced": [],
                "nodes_skipped": [],
                "skips": [],
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

            skipped_nodes: List[Dict[str, Any]] = []

            if is_pooled:
                contexts = self._pooled_contexts
                for node in self.nodes:
                    if node.id in contexts:
                        nodes_data[node.id] = await self._fetch_node_data(contexts[node.id], node)
                        self._audit("node_connected", {
                            "node_id": node.id,
                            "name": node.name,
                            "mode": getattr(node, "mode", "direct"),
                            "pooled": True
                        })
                    else:
                        logging.warning(f"⚠️ [SKIP] 连接池中节点 [{node.name}] 不可用，自动跳过。")
                        skipped_nodes.append({
                            "id": node.id,
                            "name": node.name,
                            "mode": getattr(node, "mode", "direct"),
                            "cdp_url": node.cdp_url,
                            "reason": "Not connected in pool"
                        })
                        self._audit("node_skipped", {
                            "node_id": node.id,
                            "name": node.name,
                            "mode": getattr(node, "mode", "direct"),
                            "reason": "Not connected in pool"
                        }, level="WARNING")
            else:
                async with async_playwright() as p:
                    for node in self.nodes:
                        cdp_url = node.cdp_url
                        try:
                            connect_kwargs = {}
                            if getattr(node, "headers", None):
                                connect_kwargs["headers"] = node.headers
                            b = await p.chromium.connect_over_cdp(cdp_url, **connect_kwargs)
                            ctx = b.contexts[0] if b.contexts else await b.new_context()
                            browsers[node.id] = b
                            contexts[node.id] = ctx
                            nodes_data[node.id] = await self._fetch_node_data(ctx, node)
                            self._audit("node_connected", {
                                "node_id": node.id,
                                "name": node.name,
                                "mode": getattr(node, "mode", "direct"),
                                "cdp_url": cdp_url
                            })
                        except Exception as e:
                            logging.warning(f"⚠️ [SKIP] 节点 [{node.name}] 离线或连接异常 ({cdp_url})，自动跳过: {e}")
                            skipped_nodes.append({
                                "id": node.id,
                                "name": node.name,
                                "mode": getattr(node, "mode", "direct"),
                                "cdp_url": cdp_url,
                                "reason": str(e)
                            })
                            self._audit("node_skipped", {
                                "node_id": node.id,
                                "name": node.name,
                                "mode": getattr(node, "mode", "direct"),
                                "cdp_url": cdp_url,
                                "reason": str(e)
                            }, level="WARNING")

                    if not contexts:
                        elapsed = round(time.time() - start_time, 2)
                        self._audit("sync_failed", {
                            "mode": active_mode,
                            "reason": "No available online nodes",
                            "skipped_nodes": [n["id"] for n in skipped_nodes]
                        }, level="ERROR")
                        return {
                            "status": "failed",
                            "mode": active_mode,
                            "transferred_count": 0,
                            "diff_skipped_count": 0,
                            "source_total": 0,
                            "target_total": 0,
                            "nodes_synced": [],
                            "nodes_skipped": [n["id"] for n in skipped_nodes],
                            "skips": skipped_nodes,
                            "duration": elapsed,
                            "details": "全部节点离线或异常，无可用在线节点，同步终止",
                            "error": "No available online nodes"
                        }

                    res = await self._execute_sync_flow(
                        active_mode, active_source, active_targets, contexts, nodes_data, start_time, skipped_nodes
                    )
                    for b in browsers.values():
                        await b.close()
                    return res

            # 连接池模式下执行核心逻辑
            if not contexts:
                elapsed = round(time.time() - start_time, 2)
                self._audit("sync_failed", {
                    "mode": active_mode,
                    "reason": "No available online nodes in pool",
                    "skipped_nodes": [n["id"] for n in skipped_nodes]
                }, level="ERROR")
                return {
                    "status": "failed",
                    "mode": active_mode,
                    "transferred_count": 0,
                    "diff_skipped_count": 0,
                    "source_total": 0,
                    "target_total": 0,
                    "nodes_synced": [],
                    "nodes_skipped": [n["id"] for n in skipped_nodes],
                    "skips": skipped_nodes,
                    "duration": elapsed,
                    "details": "连接池中无可用在线节点",
                    "error": "No available online nodes in pool"
                }

            return await self._execute_sync_flow(
                active_mode, active_source, active_targets, contexts, nodes_data, start_time, skipped_nodes
            )

        except Exception as e:
            elapsed = round(time.time() - start_time, 2)
            logging.error(f"[-] 同步发生异常: {e}")
            self._audit("sync_exception", {"mode": active_mode, "error": str(e)}, level="ERROR")
            return {
                "status": "failed",
                "mode": active_mode,
                "transferred_count": 0,
                "diff_skipped_count": 0,
                "source_total": 0,
                "target_total": 0,
                "nodes_synced": [],
                "nodes_skipped": [n["id"] for n in skipped_nodes] if 'skipped_nodes' in locals() else [],
                "skips": skipped_nodes if 'skipped_nodes' in locals() else [],
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
        start_time: float,
        skipped_nodes: Optional[List[Dict[str, Any]]] = None
    ) -> Dict[str, Any]:
        """内部执行流"""
        print(self.get_summary_table(nodes_data))
        total_transferred = 0
        total_skipped = 0
        skips_list = skipped_nodes or []

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

            self._audit("cookies_merged", {
                "raw_total": source_total,
                "merged_total": len(merged),
                "dest_nodes": [n.id for n in dest_nodes]
            })

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
            self._audit("sync_finish", {
                "status": "success",
                "mode": "merge",
                "transferred_count": total_transferred,
                "diff_skipped_count": total_skipped,
                "source_total": source_total,
                "target_total": len(merged),
                "nodes_synced": [n.id for n in dest_nodes],
                "nodes_skipped": [n["id"] for n in skips_list],
                "duration": elapsed
            })
            return {
                "status": "success",
                "mode": "merge",
                "transferred_count": total_transferred,
                "diff_skipped_count": total_skipped,
                "source_total": source_total,
                "target_total": len(merged),
                "nodes_synced": [n.id for n in dest_nodes],
                "nodes_skipped": [n["id"] for n in skips_list],
                "skips": skips_list,
                "duration": elapsed,
                "details": f"全节点 Merge 成功: 向 {[n.name for n in dest_nodes]} 写入 {total_transferred} 条凭证 (跳过异常节点: {[n['name'] for n in skips_list] if skips_list else '无'})",
                "error": None
            }

        elif active_mode == "sync":
            if not active_source:
                active_source = self.nodes[0].id

            # 源节点离线检查：如果指定源节点离线，打印明确通知日志并立即终止同步流程
            if active_source not in contexts:
                source_node_obj = next((n for n in self.nodes if n.id == active_source), None)
                source_name = source_node_obj.name if source_node_obj else active_source
                elapsed = round(time.time() - start_time, 2)
                msg = f"⚠️ [SOURCE_OFFLINE] 单向同步指定的源节点 [{source_name}] ({active_source}) 离线或连接异常，无法提取基准凭据，同步流程终止。"
                logging.error(msg)
                self._audit("source_offline", {
                    "source": active_source,
                    "source_name": source_name,
                    "details": msg
                }, level="ERROR")
                self._audit("sync_failed", {
                    "mode": "sync",
                    "reason": f"Source node '{active_source}' is offline",
                    "source": active_source
                }, level="ERROR")
                return {
                    "status": "failed",
                    "mode": "sync",
                    "transferred_count": 0,
                    "diff_skipped_count": 0,
                    "source_total": 0,
                    "target_total": 0,
                    "nodes_synced": [],
                    "nodes_skipped": [n["id"] for n in skips_list],
                    "skips": skips_list,
                    "duration": elapsed,
                    "details": msg,
                    "error": f"Source node '{active_source}' is offline"
                }

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
            self._audit("sync_finish", {
                "status": "success",
                "mode": "sync",
                "source": active_source,
                "transferred_count": total_transferred,
                "diff_skipped_count": total_skipped,
                "source_total": len(src_cookies),
                "target_total": len(src_cookies),
                "nodes_synced": [n.id for n in dest_nodes],
                "nodes_skipped": [n["id"] for n in skips_list],
                "duration": elapsed
            })
            return {
                "status": "success",
                "mode": "sync",
                "transferred_count": total_transferred,
                "diff_skipped_count": total_skipped,
                "source_total": len(src_cookies),
                "target_total": len(src_cookies),
                "nodes_synced": [n.id for n in dest_nodes],
                "nodes_skipped": [n["id"] for n in skips_list],
                "skips": skips_list,
                "duration": elapsed,
                "details": f"单源同步成功: [{src_data['name']}] 写入 {total_transferred} 条凭据至 {[n.name for n in dest_nodes]} (跳过异常节点: {[n['name'] for n in skips_list] if skips_list else '无'})",
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
