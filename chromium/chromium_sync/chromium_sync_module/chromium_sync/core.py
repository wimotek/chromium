#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Chromium Cluster Session & Cookie Synchronizer
现代多节点 Chromium 会话同步调度器
- 支持 1对1 与 1对多集群拓扑
- 本地节点直接直连免密免隧道，远程节点支持 SSH 密钥与密码登录
- 同步策略: merge (全节点 Cookie/Storage 智能融合并保留最新有效期) 与 sync (单源节点向多目标广播)
- 零额外数据库依赖：内置一行代码获取节点在线状态、Cookie 总数与完整详情
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
from typing import Dict, List, Optional, Union, Any, TYPE_CHECKING

if TYPE_CHECKING:
    from playwright.async_api import BrowserContext
else:
    BrowserContext = Any


@dataclass
class NodeConfig:
    """
    统一节点配置
    - 本地节点：只需提供 cdp_port (无需提供 ssh_host，自动识别为本地免密直连)
    - 远程节点：提供 ssh_host, cdp_port，可选 ssh_user, ssh_key_path, ssh_key_data, ssh_password
    """
    id: str
    name: str = ""
    is_local: bool = False
    cdp_host: str = "127.0.0.1"
    cdp_port: int = 9222
    ssh_host: Optional[str] = None
    ssh_port: int = 22
    ssh_user: str = "root"
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

    @property
    def cdp_url(self) -> str:
        if self.is_local:
            return f"http://{self.cdp_host}:{self.cdp_port}"
        return f"http://127.0.0.1:{self.tunnel_port}"


def merge_cookies(cookies_lists: List[List[dict]]) -> List[dict]:
    """
    合并各节点 Cookie，针对同一 Cookie 保留有效期最新 (expires 最长) 的记录。
    Cookie 唯一标识: (name, domain.lower(), path)
    """
    merged_map: Dict[tuple, dict] = {}

    for cookies in cookies_lists:
        for c in cookies:
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
                # 持久凭据优先于临时会话凭据
                should_replace = True
            elif curr_exp <= 0 and exist_exp <= 0:
                # 均为会话凭据时，优先保留较完整/非空值
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
    - 针对密钥（路径或数据）与密码自动装配
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

        # 检查是否已存在可用的隧道
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

        # 私钥认证
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

        # 密码认证
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
    现代多节点 Chromium 会话同步管理器
    """
    def __init__(
        self,
        nodes: List[Union[NodeConfig, dict]],
        mode: str = "sync",                     # "sync" (单源广播) 或 "merge" (全节点合并最新)
        source: Optional[str] = None,           # sync 模式下的源节点 ID (默认第一个节点)
        targets: Optional[List[str]] = None,    # sync 模式下的目标节点 ID 列表 (默认其余全部在线节点)
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
        cookies = await browser_ctx.cookies()
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
            "cookies": cookies,
            "page_info": page_info,
            "page_title": page_title,
            "page_url": page_url,
            "storage_origins": storage_origins,
            "storage_state": storage_state
        }

    async def inspect_async(self) -> Dict[str, dict]:
        """异步获取所有节点的完整状态与 Cookie 数据"""
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
        """同步获取所有节点完整状态与 Cookie 数据 (供代码直接调用)"""
        return asyncio.run(self.inspect_async())

    def get_cookies(self, node_id: Optional[str] = None) -> Union[List[dict], Dict[str, List[dict]]]:
        """
        极简 Cookie 查询接口:
        - 传入 node_id: 返回指定节点的 List[dict] Cookie 列表
        - 不传 node_id: 返回全节点字典 { node_id: List[dict] }
        """
        report = self.inspect()
        if node_id:
            return report.get(node_id, {}).get("cookies", [])
        return {nid: data.get("cookies", []) for nid, data in report.items()}

    def get_summary_table(self, report: Optional[Dict[str, dict]] = None) -> str:
        """生成格式化节点状态 ASCII 摘要表"""
        if report is None:
            report = self.inspect()

        lines = [
            "\n" + "=" * 90,
            f"{'节点 ID':<10} | {'节点名称':<14} | {'类型':<10} | {'CDP端口/映射':<12} | {'Cookie数':<10} | {'当前页面状态'}",
            "-" * 90
        ]

        for nid, data in report.items():
            ntype = "本地直连" if data.get("is_local") else "SSH远程"
            port_str = data.get("cdp_url", "").split(":")[-1]
            status_cookie = f"{data.get('cookie_count', 0)} 条" if data.get("online") else "离线"
            page_text = data.get("page_info", "未知")
            if len(page_text) > 32:
                page_text = page_text[:29] + "..."
            lines.append(f"{nid:<10} | {data.get('name', nid):<14} | {ntype:<10} | {port_str:<12} | {status_cookie:<10} | {page_text}")

        lines.append("=" * 90 + "\n")
        return "\n".join(lines)

    async def _apply_cookies_and_storage(
        self,
        target_ctx: BrowserContext,
        target_node: NodeConfig,
        cookies: List[dict],
        storage_state: Optional[dict] = None
    ):
        if cookies:
            await target_ctx.add_cookies(cookies)

        if target_ctx.pages and storage_state:
            p = target_ctx.pages[0]
            for origin in storage_state.get("origins", []):
                origin_url = origin.get("origin", "")
                items = origin.get("localStorage", [])
                if items:
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
            try:
                await p.reload()
                logging.info(f" -> 节点 [{target_node.name}] 页面热刷新成功！")
            except Exception:
                pass

    async def _run_async(
        self,
        mode: Optional[str] = None,
        source: Optional[str] = None,
        targets: Optional[List[str]] = None
    ):
        active_mode = (mode or self.mode).lower()
        active_source = source or self.source
        active_targets = targets or self.targets

        self._start_all_tunnels()
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            raise RuntimeError("[-] 未安装 playwright 模块，请先运行: pip install playwright && playwright install chromium")

        try:
            async with async_playwright() as p:
                browsers: Dict[str, Any] = {}
                contexts: Dict[str, BrowserContext] = {}
                nodes_data: Dict[str, dict] = {}

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
                    logging.error("[-] 无可用在线节点，退出同步。")
                    return

                print(self.get_summary_table(nodes_data))

                if active_mode == "merge":
                    logging.info("[*] 正在执行全节点 Cookie 智能 Merge (合并最新有效凭据)...")
                    all_cookies = [data["cookies"] for data in nodes_data.values() if data.get("cookies")]
                    merged = merge_cookies(all_cookies)
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
                        await self._apply_cookies_and_storage(
                            contexts[dest.id],
                            dest,
                            merged,
                            combined_storage
                        )

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
                    logging.info(f" -> 源凭证量: {len(src_cookies)} 条 Cookie")

                    for dest in dest_nodes:
                        logging.info(f"[*] 正在推送凭证至目标节点: [{dest.name}]")
                        await self._apply_cookies_and_storage(
                            contexts[dest.id],
                            dest,
                            src_cookies,
                            src_storage
                        )

                logging.info("[+] 同步任务已成功完成！")

                for b in browsers.values():
                    await b.close()
        finally:
            self._stop_all_tunnels()

    def run(
        self,
        mode: Optional[str] = None,
        source: Optional[str] = None,
        targets: Optional[List[str]] = None
    ):
        """同步运行入口"""
        asyncio.run(self._run_async(mode=mode, source=source, targets=targets))
