#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import asyncio
import logging
import os
import select
import socket
import subprocess
import sys
import time
import urllib.request
from typing import Optional
from playwright.async_api import async_playwright, BrowserContext


class ChromiumSync:
    """
    通用 Chromium 会话热同步与 SSH 隧道调度器
    """
    def __init__(
        self,
        remote_ssh: str = "root@kr2.wimotek.com",
        remote_ssh_port: int = 22,
        local_cdp_port: int = 9223,
        remote_cdp_port: int = 9222,
        remote_tunnel_port: int = 9222,
        direction: str = "push",  # "push", "pull", 或 "auto" (智能判断)
        timeout: int = 5,
        auto_close_tunnel: bool = False,
        verbose: bool = True
    ):
        self.remote_ssh = os.getenv("CHROMIUM_REMOTE_SSH", remote_ssh)
        self.remote_ssh_port = int(os.getenv("CHROMIUM_SSH_PORT", str(remote_ssh_port)))
        self.local_cdp_port = int(os.getenv("CHROMIUM_LOCAL_PORT", str(local_cdp_port)))
        self.remote_cdp_port = int(os.getenv("CHROMIUM_REMOTE_CDP_PORT", str(remote_cdp_port)))
        self.remote_tunnel_port = int(os.getenv("CHROMIUM_TUNNEL_PORT", str(remote_tunnel_port)))

        self.default_direction = os.getenv("CHROMIUM_DIRECTION", direction).lower()
        self.timeout = int(os.getenv("CHROMIUM_TIMEOUT", str(timeout)))
        self.auto_close_tunnel = auto_close_tunnel

        self.remote_cdp_url = f"http://127.0.0.1:{self.remote_tunnel_port}"
        self.local_cdp_url = f"http://127.0.0.1:{self.local_cdp_port}"

        self.tunnel_proc: Optional[subprocess.Popen] = None
        self.is_reused_tunnel: bool = False

        log_level = logging.INFO if verbose else logging.WARNING
        logging.basicConfig(level=log_level, format="%(asctime)s [%(levelname)s] %(message)s")

        if self.local_cdp_port == self.remote_tunnel_port:
            logging.warning(
                f"[警告] 本地容器端口与隧道映射端口重复 ({self.local_cdp_port})！建议区分 (如 9223 与 9222)。"
            )

    def _is_port_in_use(self, port: int) -> bool:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            return s.connect_ex(("127.0.0.1", port)) == 0

    def _is_cdp_ready(self, url: str) -> bool:
        try:
            proxy_handler = urllib.request.ProxyHandler({})
            opener = urllib.request.build_opener(proxy_handler)
            resp = opener.open(f"{url}/json/version", timeout=2)
            return resp.getcode() == 200
        except Exception:
            return False

    def _start_tunnel(self):
        if self._is_port_in_use(self.remote_tunnel_port):
            logging.info(f"[*] 本地 {self.remote_tunnel_port} 端口已被监听，跳过执行 SSH 命令直接复用。")
            self.is_reused_tunnel = True
            return

        logging.info(
            f"[*] 正在拉起 SSH 隧道: {self.remote_ssh}:{self.remote_ssh_port} "
            f"(映射本地 {self.remote_tunnel_port} -> 远程 {self.remote_cdp_port}) ..."
        )
        cmd = [
            "ssh", "-N",
            "-p", str(self.remote_ssh_port),
            "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=3",
            "-o", "TCPKeepAlive=yes",
            "-o", "ExitOnForwardFailure=yes",
            "-L", f"{self.remote_tunnel_port}:127.0.0.1:{self.remote_cdp_port}",
            self.remote_ssh
        ]
        self.tunnel_proc = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=(not self.auto_close_tunnel)
        )

        for _ in range(20):
            time.sleep(0.5)
            if self._is_port_in_use(self.remote_tunnel_port) and self._is_cdp_ready(self.remote_cdp_url):
                logging.info(f"[+] SSH 隧道建立成功！端口 {self.remote_tunnel_port} 已就绪。")
                return
            if self.tunnel_proc.poll() is not None:
                break

        self._stop_tunnel(force=True)
        raise RuntimeError("[-] 建立 SSH 隧道失败，请检查网络或 SSH 免密连接配置！")

    def _stop_tunnel(self, force: bool = False):
        if self.is_reused_tunnel and not force:
            return
        if self.tunnel_proc and self.tunnel_proc.poll() is None:
            if self.auto_close_tunnel or force:
                logging.info(f"[*] 正在关闭 SSH 隧道 (PID: {self.tunnel_proc.pid})...")
                self.tunnel_proc.terminate()
                self.tunnel_proc.wait()
                logging.info("[*] 隧道已释放。")
            else:
                logging.info("[*] 提示：SSH 隧道已保留在后台持续运行。")

    def _timed_input(self, prompt: str, timeout: int, default_val: str) -> str:
        # 非交互式环境 (例如 cron / 后台运行)，直接返回默认值
        if not sys.stdin or not sys.stdin.isatty() or timeout <= 0:
            sys.stdout.write(f"\n[*] 非交互环境或超时设为 0，自动采用默认值: {default_val}\n")
            return default_val

        sys.stdout.write(prompt)
        sys.stdout.flush()

        if sys.platform != "win32":
            ready, _, _ = select.select([sys.stdin], [], [], timeout)
            if ready:
                line = sys.stdin.readline().strip()
                return line if line else default_val
            sys.stdout.write(f"\n[*] 超过 {timeout} 秒无操作，自动执行默认流向: {default_val}\n")
            return default_val
        else:
            start_time = time.time()
            import msvcrt
            input_chars = []
            while True:
                if msvcrt.kbhit():
                    char = msvcrt.getwche()
                    if char in ("\r", "\n"):
                        print()
                        line = "".join(input_chars).strip()
                        return line if line else default_val
                    input_chars.append(char)
                if time.time() - start_time > timeout:
                    print(f"\n[*] 超过 {timeout} 秒无操作，自动执行默认流向: {default_val}")
                    return default_val
                time.sleep(0.05)

    async def _get_info(self, context: BrowserContext, name: str) -> dict:
        cookies = await context.cookies()
        page_info = "无打开页面"
        page_url = ""
        if context.pages:
            p = context.pages[0]
            page_url = p.url
            try:
                title = await p.title()
                page_info = f"[{title}] {p.url}"
            except Exception:
                page_info = p.url
        return {"name": name, "cookie_count": len(cookies), "page_info": page_info, "page_url": page_url}

    async def _transfer(self, source: BrowserContext, target: BrowserContext, from_name: str, to_name: str):
        logging.info(f"[*] 开始同步: 【{from_name}】 ---> 【{to_name}】")
        cookies = await source.cookies()
        storage_state = await source.storage_state()
        logging.info(f" -> 提取到 {len(cookies)} 个 Cookie")

        if cookies:
            await target.add_cookies(cookies)

        if target.pages:
            p = target.pages[0]
            for origin in storage_state.get("origins", []):
                origin_url = origin.get("origin", "")
                items = origin.get("localStorage", [])
                if items:
                    # 如果当前是空白页，尝试导航至目标源以允许写入 LocalStorage
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
                    except Exception as e:
                        logging.debug(f"LocalStorage 写入跳过: {e}")
            try:
                await p.reload()
                logging.info(f" -> 【{to_name}】页面已自动刷新生效！")
            except Exception:
                pass

        logging.info(f"[+] 同步完成！【{to_name}】已成功获得登录状态。\n")

    async def _run_async(self, direction_override: Optional[str] = None, timeout_override: Optional[int] = None):
        target_dir = direction_override.lower() if direction_override else None
        target_timeout = timeout_override if timeout_override is not None else self.timeout

        self._start_tunnel()
        try:
            async with async_playwright() as p:
                logging.info("正在连通【本地】与【远程】容器 CDP 接口...")
                try:
                    browser_remote = await p.chromium.connect_over_cdp(self.remote_cdp_url)
                    ctx_remote = browser_remote.contexts[0] if browser_remote.contexts else await browser_remote.new_context()
                except Exception as e:
                    logging.error(f"连接【远程容器】失败 ({self.remote_cdp_url}): {e}")
                    return

                try:
                    browser_local = await p.chromium.connect_over_cdp(self.local_cdp_url)
                    ctx_local = browser_local.contexts[0] if browser_local.contexts else await browser_local.new_context()
                except Exception as e:
                    logging.error(f"连接【本地容器】失败 ({self.local_cdp_url}): {e}")
                    await browser_remote.close()
                    return

                info_r = await self._get_info(ctx_remote, "远程容器")
                info_l = await self._get_info(ctx_local, "本地容器")

                print("\n" + "=" * 65)
                print("                 两端容器状态探测就绪")
                print("=" * 65)
                print(f" [本地] URL/标题 : {info_l['page_info']}")
                print(f"        Cookie数 : {info_l['cookie_count']} 条 (端口: {self.local_cdp_port})")
                print("-" * 65)
                print(f" [远程] URL/标题 : {info_r['page_info']}")
                print(f"        Cookie数 : {info_r['cookie_count']} 条 (端口: {self.remote_tunnel_port})")
                print("=" * 65 + "\n")

                # 智能识别推荐
                smart_recommend = self.default_direction
                if self.default_direction == "auto":
                    if info_r['cookie_count'] > info_l['cookie_count']:
                        smart_recommend = "pull"
                    else:
                        smart_recommend = "push"

                if not target_dir:
                    def_key = "1" if smart_recommend == "push" else "2"
                    def_text = "Push (本地->远程)" if smart_recommend == "push" else "Pull (远程->本地)"

                    print(f"请选择同步流向（等待 {target_timeout} 秒自动执行默认操作）：")
                    print(" 1. 本地 -> 远程 (Push: 推送本地凭证至远程) " + ("[默认]" if smart_recommend == "push" else ""))
                    print(" 2. 远程 -> 本地 (Pull: 拉取远程凭证到本地) " + ("[默认]" if smart_recommend == "pull" else ""))
                    print(" 0. 退出 (仅查看状态，不执行同步)")

                    prompt = f"\n请输入选项 [1/2/0] (默认 {def_key} [{def_text}]): "
                    choice = await asyncio.to_thread(self._timed_input, prompt, target_timeout, def_key)
                    choice = choice.strip()

                    if choice == "1":
                        target_dir = "push"
                    elif choice == "2":
                        target_dir = "pull"
                    elif choice == "0":
                        logging.info("[*] 取消同步，安全退出。")
                        await browser_remote.close()
                        await browser_local.close()
                        return
                    else:
                        target_dir = smart_recommend

                if target_dir == "push":
                    await self._transfer(ctx_local, ctx_remote, "本地容器", "远程容器")
                elif target_dir == "pull":
                    await self._transfer(ctx_remote, ctx_local, "远程容器", "本地容器")

                await browser_remote.close()
                await browser_local.close()
        finally:
            self._stop_tunnel()

    def run(self, direction: Optional[str] = None, timeout: Optional[int] = None):
        """同步运行入口 (开箱即用)"""
        asyncio.run(self._run_async(direction_override=direction, timeout_override=timeout))
