"""
Windows 系统 Edge / Chrome 探测与本地 CDP (127.0.0.1:9222) 启动管理器
"""

import os
import sys
import subprocess
from pathlib import Path
from typing import Dict, List, Optional, Tuple
import httpx


def _default_app_data_dir() -> Path:
    base = os.getenv("LOCALAPPDATA") or os.getenv("APPDATA") or str(Path.home())
    return Path(base) / "WimotekEdgeNode"


def get_default_profile_dir() -> Path:
    return _default_app_data_dir() / "BrowserProfile"


def _query_windows_registry_app_path(exe_name: str) -> Optional[str]:
    if sys.platform != "win32":
        return None
    try:
        import winreg
        subkey = rf"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exe_name}"
        for root in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            try:
                with winreg.OpenKey(root, subkey) as key:
                    val, _ = winreg.QueryValueEx(key, None)
                    if val and Path(val).exists():
                        return str(val)
            except OSError:
                continue
    except Exception:
        pass
    return None


def detect_installed_browsers() -> Dict[str, Optional[str]]:
    """探测 Windows 本机安装的 Microsoft Edge 与 Google Chrome 可执行文件路径"""
    pf = os.getenv("PROGRAMFILES", r"C:\Program Files")
    pf86 = os.getenv("PROGRAMFILES(X86)", r"C:\Program Files (x86)")
    local_app = os.getenv("LOCALAPPDATA", "")

    edge_candidates = [
        _query_windows_registry_app_path("msedge.exe"),
        str(Path(pf86) / "Microsoft" / "Edge" / "Application" / "msedge.exe"),
        str(Path(pf) / "Microsoft" / "Edge" / "Application" / "msedge.exe"),
        str(Path(local_app) / "Microsoft" / "Edge" / "Application" / "msedge.exe") if local_app else None,
    ]
    chrome_candidates = [
        _query_windows_registry_app_path("chrome.exe"),
        str(Path(pf) / "Google" / "Chrome" / "Application" / "chrome.exe"),
        str(Path(pf86) / "Google" / "Chrome" / "Application" / "chrome.exe"),
        str(Path(local_app) / "Google" / "Chrome" / "Application" / "chrome.exe") if local_app else None,
    ]

    edge_path = next((p for p in edge_candidates if p and Path(p).is_file()), None)
    chrome_path = next((p for p in chrome_candidates if p and Path(p).is_file()), None)
    return {"edge": edge_path, "chrome": chrome_path}


def resolve_browser_executable(browser_choice: str, custom_path: str = "") -> Tuple[str, str]:
    """
    根据配置选择解析最终浏览器可执行路径:
    browser_choice: 'auto' | 'edge' | 'chrome' | 'custom'
    返回 (browser_label, executable_path)
    """
    choice = (browser_choice or "auto").strip().lower()
    detected = detect_installed_browsers()

    if choice == "custom":
        cpath = (custom_path or "").strip().strip('"')
        if cpath and Path(cpath).is_file():
            return "自定义浏览器", cpath
        raise FileNotFoundError(f"指定的浏览器路径不存在: {custom_path}")

    if choice == "edge":
        if detected["edge"]:
            return "Microsoft Edge", detected["edge"]
        raise FileNotFoundError("未在系统中检测到 Microsoft Edge (msedge.exe)，请手动指定路径")

    if choice == "chrome":
        if detected["chrome"]:
            return "Google Chrome", detected["chrome"]
        raise FileNotFoundError("未在系统中检测到 Google Chrome (chrome.exe)，请手动指定路径")

    # auto: 优先 Edge（Windows 预装率最高），其次 Chrome
    if detected["edge"]:
        return "Microsoft Edge", detected["edge"]
    if detected["chrome"]:
        return "Google Chrome", detected["chrome"]
    if custom_path and Path(custom_path.strip('"')).is_file():
        return "自定义浏览器", custom_path.strip('"')
    raise FileNotFoundError("未检测到系统安装的 Edge 或 Chrome，请安装后重试或选择“自定义路径”")


async def check_local_cdp_ready(cdp_port: int = 9222, timeout: float = 1.5) -> Optional[dict]:
    url = f"http://127.0.0.1:{int(cdp_port)}/json/version"
    try:
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
            res = await client.get(url)
            if res.status_code == 200:
                return res.json()
    except Exception:
        return None
    return None


class BrowserProcessManager:
    """管理由本应用拉起的隔离式 Edge / Chrome 调试进程"""

    def __init__(self):
        self.proc: Optional[subprocess.Popen] = None
        self.active_browser_label: str = ""

    def is_running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def launch(
        self,
        browser_choice: str = "auto",
        custom_browser_path: str = "",
        cdp_port: int = 9222,
        profile_mode: str = "isolated",
        custom_profile_dir: str = "",
        homepage: str = "about:blank",
        extra_args: str = "",
    ) -> Tuple[str, List[str]]:
        if self.is_running():
            return self.active_browser_label, []

        label, exe_path = resolve_browser_executable(browser_choice, custom_browser_path)

        cmd: List[str] = [
            exe_path,
            f"--remote-debugging-port={int(cdp_port)}",
            "--remote-debugging-address=127.0.0.1",
            "--remote-allow-origins=*",
            "--disable-features=msEdgeStartupBoost",
            "--no-first-run",
            "--no-default-browser-check",
        ]

        # Chrome/Edge 136+ 仅允许在非默认数据目录下开启远程调试端口；
        # 独立 Profile 也避免把个人日常网银 Cookie 混入同步池
        if (profile_mode or "isolated").lower() != "system_default":
            profile_dir = Path(custom_profile_dir.strip()) if custom_profile_dir.strip() else get_default_profile_dir()
            profile_dir.mkdir(parents=True, exist_ok=True)
            cmd.append(f"--user-data-dir={profile_dir}")

        if extra_args and extra_args.strip():
            import shlex
            cmd.extend(shlex.split(extra_args, posix=(sys.platform != "win32")))

        target_url = (homepage or "").strip()
        if target_url:
            cmd.append(target_url)

        creationflags = 0
        if sys.platform == "win32":
            creationflags = subprocess.CREATE_NEW_PROCESS_GROUP

        self.proc = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creationflags,
        )
        self.active_browser_label = label
        return label, cmd

    def stop(self):
        if self.proc is None:
            return
        try:
            if self.proc.poll() is None:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=4)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
        except Exception:
            pass
        finally:
            self.proc = None
            self.active_browser_label = ""
