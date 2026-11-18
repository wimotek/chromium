"""
Windows 系统 Edge / Chrome 探测与本地 CDP (127.0.0.1:9222) 启动管理器
支持三种窗口运行模式:
- hidden_window: 默认后台隐身运行（真实桌面内核 + Win32 隐藏窗口，支持不断连瞬时唤出/隐藏）
- headless: 纯无头模式 (--headless=new，零桌面窗口，唤出/切回时保留同 Profile 重启)
- visible: 常规前台窗口模式
"""

import ctypes
import os
import shlex
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple
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


def probe_existing_cdp_sync(cdp_port: int = 9222, timeout: float = 0.8) -> Optional[dict]:
    """同步检测 127.0.0.1:cdp_port 是否已被外部浏览器占用"""
    url = f"http://127.0.0.1:{int(cdp_port)}/json/version"
    try:
        with httpx.Client(timeout=timeout, trust_env=False) as client:
            res = client.get(url)
            if res.status_code == 200:
                return res.json()
    except Exception:
        return None
    return None


# ==================== Windows 原生窗口隐藏 / 唤出工具 ====================

def _collect_pid_tree_win32(root_pid: int) -> Set[int]:
    if sys.platform != "win32" or root_pid <= 0:
        return set()
    pids: Set[int] = {root_pid}
    try:
        from ctypes import wintypes

        class PROCESSENTRY32W(ctypes.Structure):
            _fields_ = [
                ("dwSize", wintypes.DWORD),
                ("cntUsage", wintypes.DWORD),
                ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", ctypes.c_size_t),
                ("th32ModuleID", wintypes.DWORD),
                ("cntThreads", wintypes.DWORD),
                ("th32ParentProcessID", wintypes.DWORD),
                ("pcPriClassBase", ctypes.c_long),
                ("dwFlags", wintypes.DWORD),
                ("szExeFile", ctypes.c_wchar * 260),
            ]

        kernel32 = ctypes.windll.kernel32
        snap = kernel32.CreateToolhelp32Snapshot(0x00000002, 0)
        if snap == wintypes.HANDLE(-1).value:
            return pids
        try:
            entry = PROCESSENTRY32W()
            entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
            children: List[Tuple[int, int]] = []
            if kernel32.Process32FirstW(snap, ctypes.byref(entry)):
                while True:
                    children.append((int(entry.th32ProcessID), int(entry.th32ParentProcessID)))
                    if not kernel32.Process32NextW(snap, ctypes.byref(entry)):
                        break
            changed = True
            while changed:
                changed = False
                for pid, ppid in children:
                    if ppid in pids and pid not in pids:
                        pids.add(pid)
                        changed = True
        finally:
            kernel32.CloseHandle(snap)
    except Exception:
        pass
    return pids


def _find_browser_hwnds_win32(root_pid: int) -> List[int]:
    if sys.platform != "win32" or root_pid <= 0:
        return []
    tree_pids = _collect_pid_tree_win32(root_pid)
    if not tree_pids:
        return []

    hwnds: List[int] = []
    try:
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

        def _cb(hwnd, _lparam):
            pid = wintypes.DWORD(0)
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value in tree_pids and user32.GetWindow(hwnd, 4) == 0:
                cls_buf = ctypes.create_unicode_buffer(256)
                user32.GetClassNameW(hwnd, cls_buf, 256)
                if cls_buf.value.startswith("Chrome_WidgetWin"):
                    hwnds.append(int(hwnd))
            return True

        cb_ref = WNDENUMPROC(_cb)
        user32.EnumWindows(cb_ref, 0)
    except Exception:
        pass
    return hwnds


def _hide_browser_hwnds_win32(root_pid: int) -> int:
    if sys.platform != "win32" or root_pid <= 0:
        return 0
    count = 0
    try:
        user32 = ctypes.windll.user32
        for hwnd in _find_browser_hwnds_win32(root_pid):
            if user32.IsWindowVisible(hwnd):
                user32.ShowWindow(hwnd, 0)  # SW_HIDE
                count += 1
    except Exception:
        pass
    return count


def _show_browser_hwnds_win32(root_pid: int) -> int:
    if sys.platform != "win32" or root_pid <= 0:
        return 0
    count = 0
    try:
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        screen_w = max(800, int(user32.GetSystemMetrics(0) or 1920))
        screen_h = max(600, int(user32.GetSystemMetrics(1) or 1080))
        target_w = min(1280, max(860, screen_w - 160))
        target_h = min(860, max(620, screen_h - 140))
        target_x = max(40, (screen_w - target_w) // 2)
        target_y = max(30, (screen_h - target_h) // 2)

        for hwnd in _find_browser_hwnds_win32(root_pid):
            rect = wintypes.RECT()
            if user32.GetWindowRect(hwnd, ctypes.byref(rect)):
                w = rect.right - rect.left
                h = rect.bottom - rect.top
                offscreen = (
                    rect.left < -5000
                    or rect.top < -5000
                    or rect.left >= screen_w - 40
                    or rect.top >= screen_h - 40
                    or w < 240
                    or h < 180
                )
                if offscreen:
                    user32.SetWindowPos(hwnd, 0, target_x, target_y, target_w, target_h, 0x0004)  # SWP_NOZORDER
            user32.ShowWindow(hwnd, 9)  # SW_RESTORE
            user32.SetForegroundWindow(hwnd)
            count += 1
    except Exception:
        pass
    return count


class BrowserProcessManager:
    """管理由本应用拉起的隔离式 Edge / Chrome 调试进程（支持后台静默运行与手动唤出/隐藏）"""

    def __init__(self):
        self.proc: Optional[subprocess.Popen] = None
        self.active_browser_label: str = ""
        self.last_launch_warning: str = ""
        self.background_mode: str = "hidden_window"
        self.is_headless_active: bool = False
        self.window_hidden: bool = False
        self._is_reused_external: bool = False
        self._last_launch_kwargs: Optional[Dict[str, Any]] = None
        self._hide_stop_event = threading.Event()
        self._hide_thread: Optional[threading.Thread] = None

    def is_running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def _stop_hide_watcher(self):
        self._hide_stop_event.set()
        if self._hide_thread is not None and self._hide_thread.is_alive():
            try:
                self._hide_thread.join(timeout=1.0)
            except Exception:
                pass
        self._hide_thread = None

    def _start_hide_watcher(self):
        self._stop_hide_watcher()
        if sys.platform != "win32" or not self.is_running() or not self.window_hidden:
            return
        self._hide_stop_event.clear()

        def _watch():
            started = time.monotonic()
            while not self._hide_stop_event.is_set() and self.window_hidden and self.is_running():
                if self.proc is not None:
                    _hide_browser_hwnds_win32(self.proc.pid)
                interval = 0.15 if (time.monotonic() - started) < 4.0 else 0.5
                if self._hide_stop_event.wait(interval):
                    break

        self._hide_thread = threading.Thread(target=_watch, daemon=True)
        self._hide_thread.start()

    def launch(
        self,
        browser_choice: str = "auto",
        custom_browser_path: str = "",
        cdp_port: int = 9222,
        profile_mode: str = "isolated",
        custom_profile_dir: str = "",
        homepage: str = "about:blank",
        extra_args: str = "",
        isolate_os_signin: bool = True,
        background_mode: str = "hidden_window",
        _override_headless: Optional[bool] = None,
        _override_hidden: Optional[bool] = None,
    ) -> Tuple[str, List[str]]:
        self.last_launch_warning = ""
        norm_bg = (background_mode or "hidden_window").strip().lower()
        if norm_bg not in {"hidden_window", "headless", "visible"}:
            norm_bg = "hidden_window"
        self.background_mode = norm_bg

        self._last_launch_kwargs = {
            "browser_choice": browser_choice,
            "custom_browser_path": custom_browser_path,
            "cdp_port": int(cdp_port),
            "profile_mode": profile_mode,
            "custom_profile_dir": custom_profile_dir,
            "homepage": homepage,
            "extra_args": extra_args,
            "isolate_os_signin": bool(isolate_os_signin),
            "background_mode": norm_bg,
        }

        if self.is_running():
            return self.active_browser_label, []

        existing_cdp = probe_existing_cdp_sync(cdp_port)
        if existing_cdp is not None:
            browser_ver = existing_cdp.get("Browser", "未知浏览器")
            self.last_launch_warning = (
                f"检测到本机 127.0.0.1:{int(cdp_port)} 已被现有浏览器进程 ({browser_ver}) 占用！\n"
                "客户端将直接复用该端口上的浏览器会话——如果那是你的日常个人浏览器，你的个人账号和 Cookie 会直接暴露给调试接口。"
                "如需严格独立环境，请更改本程序的 CDP 端口（如 9223）或先关闭外部调试浏览器。"
            )
            self._is_reused_external = True
            self.is_headless_active = False
            self.window_hidden = False
            self.active_browser_label = f"复用已运行端口 ({browser_ver})"
            return self.active_browser_label, []

        self._is_reused_external = False
        label, exe_path = resolve_browser_executable(browser_choice, custom_browser_path)
        is_isolated = (profile_mode or "isolated").lower() != "system_default"

        use_headless = (norm_bg == "headless") if _override_headless is None else bool(_override_headless)
        use_hidden_win = (norm_bg == "hidden_window") if _override_hidden is None else bool(_override_hidden)
        if use_headless:
            use_hidden_win = False

        disabled_features = ["msEdgeStartupBoost"]
        if is_isolated and isolate_os_signin:
            disabled_features.extend(["msImplicitSignin", "msEdgeAccountConsistency"])

        cmd: List[str] = [
            exe_path,
            f"--remote-debugging-port={int(cdp_port)}",
            "--remote-debugging-address=127.0.0.1",
            "--remote-allow-origins=*",
            f"--disable-features={','.join(disabled_features)}",
            "--no-first-run",
            "--no-default-browser-check",
        ]

        if is_isolated:
            profile_dir = Path(custom_profile_dir.strip()) if custom_profile_dir.strip() else get_default_profile_dir()
            profile_dir.mkdir(parents=True, exist_ok=True)
            cmd.append(f"--user-data-dir={profile_dir}")
            if isolate_os_signin:
                cmd.append("--disable-sync")
        else:
            if custom_profile_dir.strip():
                profile_dir = Path(custom_profile_dir.strip())
                profile_dir.mkdir(parents=True, exist_ok=True)
                cmd.append(f"--user-data-dir={profile_dir}")
            else:
                self.last_launch_warning = (
                    "已选择「主机默认 Profile」：1) Chrome / Edge 136+ 默认禁止在系统默认 User Data 目录开启 9222 远程调试端口；"
                    "2) 若本机日常浏览器已在后台运行，新窗口会并入旧进程导致 9222 端口不生效（请先完全退出全部 Edge/Chrome 窗口再启动）。"
                )

        if use_headless:
            cmd.append("--headless=new")
        elif use_hidden_win:
            cmd.append("--window-position=-32000,-32000")

        if extra_args and extra_args.strip():
            cmd.extend(shlex.split(extra_args, posix=(sys.platform != "win32")))

        target_url = (homepage or "").strip()
        if target_url:
            cmd.append(target_url)

        creationflags = 0
        startupinfo = None
        if sys.platform == "win32":
            creationflags = subprocess.CREATE_NEW_PROCESS_GROUP
            if use_hidden_win:
                startupinfo = subprocess.STARTUPINFO()
                startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                startupinfo.wShowWindow = 7  # SW_SHOWMINNOACTIVE: 启动不抢焦点

        self.proc = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creationflags,
            startupinfo=startupinfo,
        )
        self.active_browser_label = label
        self.is_headless_active = use_headless
        self.window_hidden = use_headless or use_hidden_win
        if use_hidden_win:
            self._start_hide_watcher()
        return label, cmd

    def show_window(self) -> Tuple[bool, str]:
        """手动唤出调试浏览器窗口（hidden_window 模式无损瞬时显示；headless 模式保留同 Profile 切换有头窗口）"""
        if self._is_reused_external:
            return False, "当前复用外部已打开的浏览器进程，请在系统任务栏直接切换对应窗口"

        if not self.is_running():
            if not self._last_launch_kwargs:
                return False, "调试浏览器尚未启动，请先启动浏览器或点击「启动浏览器并接入 Hub」"
            self.launch(**self._last_launch_kwargs, _override_headless=False, _override_hidden=False)
            return True, "已按可见窗口模式启动调试浏览器"

        if self.is_headless_active:
            if not self._last_launch_kwargs:
                return False, "缺少启动参数，无法从无头模式重启为可见窗口"
            self.stop()
            time.sleep(0.35)
            self.launch(**self._last_launch_kwargs, _override_headless=False, _override_hidden=False)
            return True, "已从无头模式切换为可见桌面窗口（保留同一 Profile 与 Cookie，可手动登录/过验证）"

        self.window_hidden = False
        self._stop_hide_watcher()
        shown = _show_browser_hwnds_win32(self.proc.pid) if self.proc is not None else 0
        if shown == 0 and sys.platform == "win32" and self._last_launch_kwargs:
            # 若此前所有窗口已被关闭仅剩后台进程，重新拉起可见窗口
            self.stop()
            time.sleep(0.3)
            self.launch(**self._last_launch_kwargs, _override_headless=False, _override_hidden=False)
            return True, "已重新唤出调试浏览器窗口"
        return True, "已将后台调试浏览器唤出到前台（活跃 CDP 会话未中断）"

    def hide_window(self) -> Tuple[bool, str]:
        """将调试浏览器重新隐藏到后台静默运行"""
        if self._is_reused_external:
            return False, "当前复用外部已打开的浏览器进程，无法由客户端隐藏"
        if not self.is_running():
            return False, "调试浏览器尚未启动"

        if self.background_mode == "headless" and not self.is_headless_active and self._last_launch_kwargs:
            self.stop()
            time.sleep(0.35)
            self.launch(**self._last_launch_kwargs, _override_headless=True, _override_hidden=False)
            return True, "已关闭可见窗口并切回纯无头后台模式（Cookie 已保存至本地 Profile）"

        self.window_hidden = True
        if self.proc is not None:
            _hide_browser_hwnds_win32(self.proc.pid)
        self._start_hide_watcher()
        return True, "调试浏览器已隐藏到后台静默运行（CDP 会话保持在线不断连）"

    def stop(self):
        self._stop_hide_watcher()
        if self.proc is None:
            self.is_headless_active = False
            self.window_hidden = False
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
            self.is_headless_active = False
            self.window_hidden = False
            self._is_reused_external = False
