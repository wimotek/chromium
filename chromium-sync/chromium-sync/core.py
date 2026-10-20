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
    通用 Chromium 会话同步与 SSH 隧道调度器
    """
    def __init__(
        self,
        # 远程 SSH 连接配置
        remote_ssh: str = "root@kr2.wimotek.com",
        remote_ssh_port: int = 22,
        # 端口自由定义区域
        local_cdp_port: int = 16002,       # 本地容器的 CDP 端口
        remote_cdp_port: int = 9222,      # 远程服务器上容器实际暴露的端口
        remote_tunnel_port: int = 9222,   # 远程容器通过 SSH 映射到本机的端口
        # 逻辑控制配置
        direction: str = "push",          # 默认流向: "push" (本地->远程) 或 "pull" (远程->本地)
        timeout: int = 15,                 # 倒计时等待秒数 (0 为秒执行)
        auto_close_tunnel: bool = False, # 任务完毕是否关闭由本模块创建的隧道
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

        # 端口自检碰撞提示
        if self.local_cdp_port == self.remote_tunnel_port:
            logging.warning(
                f"[警告] 本地容器端口与隧道映射端口重叠 ({self.local_cdp_port})！"
                "两者不能占用本机同一端口，建议为本地容器与隧道分别指定不同端口 (如 9223 与 9222)。"
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
            logging.info(f"[*] 本地 {self.remote_tunnel_port} 端口已处于监听状态，跳过执行 SSH 命令直接复用。")
            self.is_reused_tunnel = True
            return

        logging.info(
            f"[*] 正在拉起 SSH 隧道: {self.remote_ssh}:{self.remote_ssh_port} "
            f"(本地:{self.remote_tunnel_port} -> 远程:{self.remote_cdp_port}) ..."
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
        sys.stdout.write(prompt)
        sys.stdout.flush()
        if timeout <= 0:
            sys.stdout.write(f"\n[*] 倒计时为 0，直接采用默认选项: {default_val}\n")
            return default_val

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
        if context.pages:
            p = context.pages[0]
            try:
                title = await p.title()
                page_info = f"[{title}] {p.url}"
            except Exception:
                page_info = p.url
        return {"name": name, "cookie_count": len(cookies), "page_info": page_info}

    async def _transfer(self, source: BrowserContext, target: BrowserContext, from_name: str, to_name: str):
        logging.info(f"[*] 开始数据传输: 【{from_name}】 ---> 【{to_name}】")
        cookies = await source.cookies()
        storage_state = await source.storage_state()
        logging.info(f" -> 提取到 {len(cookies)} 个 Cookie 条目")

        if cookies:
            await target.add_cookies(cookies)

        if target.pages:
            p = target.pages[0]
            for origin in storage_state.get("origins", []):
                items = origin.get("localStorage", [])
                if items and not p.url.startswith("about:"):
                    await p.evaluate(
                        """(items) => {
                            for (const item of items) {
                                try { window.localStorage.setItem(item.name, item.value); } catch(e){}
                            }
                        }""",
                        items
                    )
            try:
                await p.reload()
                logging.info(f" -> 【{to_name}】页面已自动刷新生效！")
            except Exception:
                pass

        logging.info(f"[+] 同步完毕！【{to_name}】已成功获得对端会话凭证。\n")

    async def _run_async(self, direction_override: Optional[str] = None, timeout_override: Optional[int] = None):
        target_dir = direction_override.lower() if direction_override else None
        target_timeout = timeout_override if timeout_override is not None else self.timeout

        self._start_tunnel()
        try:
            async with async_playwright() as p:
                logging.info("正在连通两端容器 CDP 接口...")
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

                # 探测两端状态
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

                if not target_dir:
                    def_key = "1" if self.default_direction == "push" else "2"
                    def_text = "Push (本地->远程)" if self.default_direction == "push" else "Pull (远程->本地)"

                    print(f"请选择同步流向（等待 {target_timeout} 秒自动执行默认操作）：")
                    print(" 1. 本地 -> 远程 (Push: 推送本地凭证至远程) " + ("[默认]" if self.default_direction == "push" else ""))
                    print(" 2. 远程 -> 本地 (Pull: 拉取远程凭证到本地) " + ("[默认]" if self.default_direction == "pull" else ""))
                    print(" 0. 退出 (仅探测状态，不执行同步)")

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
                        target_dir = self.default_direction

                if target_dir == "push":
                    await self._transfer(ctx_local, ctx_remote, "本地容器", "远程容器")
                elif target_dir == "pull":
                    await self._transfer(ctx_remote, ctx_local, "远程容器", "本地容器")

                await browser_remote.close()
                await browser_local.close()
        finally:
            self._stop_tunnel()

    def run(self, direction: Optional[str] = None, timeout: Optional[int] = None):
        """同步运行入口 (开箱即用，无需 async 包装)"""
        asyncio.run(self._run_async(direction_override=direction, timeout_override=timeout))
