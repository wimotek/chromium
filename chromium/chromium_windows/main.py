"""
Wimotek Windows Edge/Chrome CDP Node 桌面客户端 (PySide6 + Fluent Design)
功能：
1. Windows 11 Fluent 风格桌面应用（侧边导航、圆角卡片、Switch 开关、InfoBar 提示、高分屏自适应）
2. 自动探测本机 Microsoft Edge / Google Chrome 并以隔离 Profile 启动 CDP 127.0.0.1:9222
3. 可配置 Hub URL / Join Token / 节点名称 / 分组 / 接入模式 / WSS 端口 / 公网 IP 或 DDNS 域名
4. 本地边缘 Cookie 隐私防火墙（严格白名单 / 黑名单屏蔽 / 全量 / 禁止导出）+ 试算预览
5. 分级运行日志与滚动持久化日志 (%APPDATA%\\WimotekEdgeNode\\logs\\agent.log)，支持 --headless 无界面运行
"""

import argparse
import asyncio
import copy
import json
import os
from pathlib import Path
import sys
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

import httpx

from browser_launcher import (
    BrowserProcessManager,
    check_local_cdp_ready,
    detect_installed_browsers,
    get_default_profile_dir,
)
from cookie_guard import (
    DEFAULT_SENSITIVE_BLACKLIST,
    CookieGuard,
    CookieGuardConfig,
    parse_rule_list,
)
from win_edge_agent import (
    WinEdgeAgent,
    append_disk_log,
    clear_log_file,
    extract_raw_local_cookies,
    get_app_data_dir,
    get_log_file_path,
    read_recent_logs,
)


APP_VERSION = "1.1.0"

DEFAULT_CONFIG: Dict[str, Any] = {
    "hub": {
        "hub_url": "https://hub.yourdomain.com:8443",
        "join_token": "",
        "node_name": "",
        "group_name": "Windows节点",
        "reverse_tunnel": "auto",
        "cdp_port": 9222,
        "edge_wss_port": 9443,
        "edge_wss_external_port": 9443,
        "public_host": "",
        "public_ipv4": "",
        "public_ipv6": "",
        "heartbeat_seconds": 60,
    },
    "browser": {
        "browser_choice": "auto",
        "custom_browser_path": "",
        "profile_mode": "isolated",
        "custom_profile_dir": "",
        "homepage": "about:blank",
        "extra_args": "",
        "launch_browser_on_start": True,
        "auto_connect_on_launch": False,
    },
    "cookie_guard": {
        "mode": "whitelist",
        "whitelist_domains": [],
        "blacklist_domains": list(DEFAULT_SENSITIVE_BLACKLIST),
        "blocked_cookie_names": [],
        "exclude_expired": True,
        "protect_inject": False,
    },
    "ui": {
        "close_to_tray": True,
    },
}


def get_config_path() -> Path:
    return get_app_data_dir() / "config.json"


def load_config(path: Optional[Path] = None) -> Dict[str, Any]:
    cfg_path = path or get_config_path()
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    if cfg_path.exists():
        try:
            loaded = json.loads(cfg_path.read_text(encoding="utf-8"))
            for section in ("hub", "browser", "cookie_guard", "ui"):
                if isinstance(loaded.get(section), dict):
                    cfg[section].update(loaded[section])
            # 兼容旧版只填写了 public_ipv4 的配置
            if not cfg["hub"].get("public_host") and cfg["hub"].get("public_ipv4"):
                cfg["hub"]["public_host"] = cfg["hub"]["public_ipv4"]
        except Exception:
            pass
    return cfg


def save_config(cfg: Dict[str, Any], path: Optional[Path] = None) -> Path:
    cfg_path = path or get_config_path()
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    cfg_path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")
    return cfg_path


def run_headless(config_path: Optional[Path] = None):
    cfg = load_config(config_path)
    browser_mgr = BrowserProcessManager()
    if cfg["browser"].get("launch_browser_on_start", True):
        try:
            b = cfg["browser"]
            label, _ = browser_mgr.launch(
                browser_choice=b["browser_choice"],
                custom_browser_path=b["custom_browser_path"],
                cdp_port=int(cfg["hub"]["cdp_port"]),
                profile_mode=b["profile_mode"],
                custom_profile_dir=b["custom_profile_dir"],
                homepage=b["homepage"],
                extra_args=b["extra_args"],
            )
            print(f"[Browser] Started {label}", flush=True)
        except Exception as e:
            print(f"[Browser] Warning: {e}", flush=True)

    agent = WinEdgeAgent(cfg, log_callback=lambda lvl, msg: print(msg, flush=True))
    try:
        asyncio.run(agent.run())
    except KeyboardInterrupt:
        agent.request_stop()
    finally:
        browser_mgr.stop()


def _resolve_asset_path(filename: str) -> Optional[Path]:
    candidates = []
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        candidates.append(Path(getattr(sys, "_MEIPASS")) / "assets" / filename)
    candidates.append(Path(__file__).resolve().parent / "assets" / filename)
    for p in candidates:
        if p.is_file():
            return p
    return None


def _run_gui(config_path: Optional[Path] = None):
    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("Wimotek.EdgeCDPNode.Desktop")
        except Exception:
            pass

    try:
        from PySide6.QtCore import QObject, Qt, QTimer, Signal
        from PySide6.QtGui import QAction, QColor, QFont, QIcon, QTextCharFormat, QTextCursor
        from PySide6.QtWidgets import (
            QAbstractItemView,
            QApplication,
            QButtonGroup,
            QDialog,
            QFileDialog,
            QFormLayout,
            QHBoxLayout,
            QHeaderView,
            QLabel,
            QMenu,
            QSizePolicy,
            QStyle,
            QSystemTrayIcon,
            QTableWidget,
            QTableWidgetItem,
            QVBoxLayout,
            QWidget,
        )
        from qfluentwidgets import (
            BodyLabel,
            CaptionLabel,
            CardWidget,
            ComboBox,
            FluentIcon as FIF,
            FluentWindow,
            InfoBar,
            InfoBarPosition,
            LineEdit,
            NavigationItemPosition,
            PasswordLineEdit,
            PlainTextEdit,
            PrimaryPushButton,
            PushButton,
            RadioButton,
            ScrollArea,
            StrongBodyLabel,
            SubtitleLabel,
            SwitchButton,
            Theme,
            setTheme,
            setThemeColor,
        )
    except ImportError as exc:
        print(
            f"[GUI Unavailable] PySide6/PySide6-Fluent-Widgets 未包含在当前二进制中 ({exc})。\n"
            "请使用 --headless 参数运行命令行模式，或启动完整的 WimotekEdgeNode.exe 图形端。",
            file=sys.stderr,
        )
        sys.exit(2)

    def _icon(name: str, fallback=FIF.SETTING):
        return getattr(FIF, name, fallback)

    def _make_badge(text: str, bg: str = "#334155", fg: str = "#f8fafc") -> QLabel:
        lbl = QLabel(text)
        lbl.setStyleSheet(
            f"QLabel {{ background-color: {bg}; color: {fg}; border-radius: 6px; "
            f"padding: 5px 12px; font-weight: 600; font-size: 12px; }}"
        )
        return lbl

    class _AgentBridge(QObject):
        log_received = Signal(str, str)
        status_received = Signal(dict)
        cdp_checked = Signal(int, bool)
        agent_stopped = Signal()
        preview_finished = Signal(str, str)
        inventory_scanned = Signal(list, object, str, bool)

    class CookieInventoryDialog(QDialog):
        def __init__(self, parent, rescan_callback):
            super().__init__(parent)
            self._rescan_callback = rescan_callback
            self._rows: List[Dict[str, Any]] = []
            self._stats: Any = None

            self.setWindowTitle("本机浏览器 Cookie 清单与防火墙审计明细")
            self.resize(960, 580)
            self.setMinimumSize(780, 460)
            self.setStyleSheet(
                "QDialog { background-color: #111827; color: #f8fafc; }"
                "QTableWidget { background-color: #0f172a; color: #e2e8f0; gridline-color: #1e293b; "
                "border: 1px solid #334155; border-radius: 6px; selection-background-color: #1d4ed8; }"
                "QHeaderView::section { background-color: #1e293b; color: #cbd5e1; padding: 6px 8px; "
                "border: none; border-bottom: 1px solid #334155; font-weight: 600; }"
            )

            lay = QVBoxLayout(self)
            lay.setContentsMargins(18, 16, 18, 16)
            lay.setSpacing(12)

            self.lbl_summary = StrongBodyLabel("正在读取本机浏览器 Cookie...", self)
            lay.addWidget(self.lbl_summary)

            bar = QHBoxLayout()
            bar.setSpacing(10)
            self.in_search = LineEdit(self)
            self.in_search.setPlaceholderText("按域名或 Cookie 名称过滤...")
            self.in_search.textChanged.connect(self._render_table)

            self.cmb_filter = ComboBox(self)
            self.cmb_filter.addItems(["全部", "仅放行", "仅拦截"])
            self.cmb_filter.currentTextChanged.connect(self._render_table)

            self.btn_rescan = PrimaryPushButton(_icon("SYNC"), "刷新扫描", self)
            self.btn_rescan.clicked.connect(self._on_rescan)

            bar.addWidget(self.in_search, 1)
            bar.addWidget(self.cmb_filter)
            bar.addWidget(self.btn_rescan)
            lay.addLayout(bar)

            self.table = QTableWidget(0, 6, self)
            self.table.setHorizontalHeaderLabels(["域名", "Cookie 名称", "防火墙状态", "脱敏值", "属性", "有效期"])
            self.table.setEditTriggers(QAbstractItemView.NoEditTriggers)
            self.table.setSelectionBehavior(QAbstractItemView.SelectRows)
            self.table.setAlternatingRowColors(False)
            self.table.verticalHeader().setVisible(False)
            hdr = self.table.horizontalHeader()
            hdr.setSectionResizeMode(0, QHeaderView.Stretch)
            hdr.setSectionResizeMode(1, QHeaderView.Interactive)
            hdr.setSectionResizeMode(2, QHeaderView.ResizeToContents)
            hdr.setSectionResizeMode(3, QHeaderView.ResizeToContents)
            hdr.setSectionResizeMode(4, QHeaderView.ResizeToContents)
            hdr.setSectionResizeMode(5, QHeaderView.ResizeToContents)
            self.table.setColumnWidth(1, 180)
            lay.addWidget(self.table, 1)

            foot = QHBoxLayout()
            hint = CaptionLabel("安全提示：本地仅展示脱敏预览值，日志不记录明文；状态为“拦截”的条目不会同步至 Hub。", self)
            hint.setTextColor(QColor("#94a3b8"), QColor("#94a3b8"))
            btn_close = PushButton("关闭", self)
            btn_close.clicked.connect(self.close)
            foot.addWidget(hint)
            foot.addStretch()
            foot.addWidget(btn_close)
            lay.addLayout(foot)

        def _on_rescan(self):
            self.btn_rescan.setEnabled(False)
            self.lbl_summary.setText("正在重新扫描本机浏览器 CDP Cookie...")
            self._rescan_callback()

        def set_scan_error(self, err_msg: str):
            self.btn_rescan.setEnabled(True)
            self.lbl_summary.setText(f"扫描失败：{err_msg}")

        def set_data(self, rows: List[Dict[str, Any]], stats: Any, mode: str):
            self.btn_rescan.setEnabled(True)
            self._rows = rows
            self._stats = stats
            self.lbl_summary.setText(
                f"当前策略：{mode}   |   总计：{stats.total} 条   |   "
                f"放行：{stats.allowed} 条   |   拦截：{stats.blocked_by_policy} 条   |   过期剔除：{stats.expired_dropped} 条"
            )
            self._render_table()

        def _render_table(self, *_unused):
            kw = self.in_search.text().strip().lower()
            flt = self.cmb_filter.currentText()
            filtered = []
            for r in self._rows:
                if flt == "仅放行" and not r["allowed"]:
                    continue
                if flt == "仅拦截" and r["allowed"]:
                    continue
                if kw and kw not in r["domain"].lower() and kw not in r["name"].lower() and kw not in r["verdict"].lower():
                    continue
                filtered.append(r)

            self.table.setRowCount(len(filtered))
            for idx, r in enumerate(filtered):
                items = [
                    QTableWidgetItem(str(r["domain"])),
                    QTableWidgetItem(str(r["name"])),
                    QTableWidgetItem(str(r["verdict"])),
                    QTableWidgetItem(str(r["value_masked"])),
                    QTableWidgetItem(str(r["flags"])),
                    QTableWidgetItem(str(r["expires_str"])),
                ]
                verdict_item = items[2]
                if r["allowed"]:
                    verdict_item.setForeground(QColor("#34d399"))
                elif "过期" in r["verdict"]:
                    verdict_item.setForeground(QColor("#fbbf24"))
                else:
                    verdict_item.setForeground(QColor("#f87171"))
                for col, it in enumerate(items):
                    self.table.setItem(idx, col, it)

    class _PageScrollArea(ScrollArea):
        def __init__(self, object_name: str, parent=None):
            super().__init__(parent)
            self.setObjectName(object_name)
            self.container = QWidget(self)
            self.vbox = QVBoxLayout(self.container)
            self.vbox.setContentsMargins(28, 22, 28, 28)
            self.vbox.setSpacing(14)
            self.setWidget(self.container)
            self.setWidgetResizable(True)
            self.setStyleSheet("QScrollArea { background: transparent; border: none; }")
            self.container.setStyleSheet("background: transparent;")

    class WimotekFluentWindow(FluentWindow):
        def __init__(self, cfg_path: Optional[Path] = None):
            super().__init__()
            self.config_path = cfg_path or get_config_path()
            self.config = load_config(self.config_path)

            self.browser_mgr = BrowserProcessManager()
            self.agent: Optional[WinEdgeAgent] = None
            self.agent_thread: Optional[threading.Thread] = None
            self.bridge = _AgentBridge()
            self.log_buffer: List[Tuple[str, str]] = []
            self._last_cdp_ok: Optional[bool] = None
            self._last_cookie_sig: Optional[Tuple[int, int, int]] = None
            self._inventory_dialog: Optional[CookieInventoryDialog] = None
            self._cached_rows: List[Dict[str, Any]] = []
            self._cached_stats: Any = None
            self._loading_ui: bool = False
            self._force_quit: bool = False
            self._tray_hint_shown: bool = False
            self.tray_icon: Optional[QSystemTrayIcon] = None
            self.tray_menu: Optional[QMenu] = None
            self.status_state = {
                "cdp": "未检测",
                "hub": "未接入",
                "mode": "-",
                "guard": self.config["cookie_guard"]["mode"],
            }

            self._init_window()
            self._build_pages()
            self._init_tray()
            self._connect_signals()
            self._load_vars_from_config()
            self._load_initial_logs()
            self._refresh_browser_probe()

            self.cdp_timer = QTimer(self)
            self.cdp_timer.timeout.connect(self._poll_cdp_health)
            self.cdp_timer.start(4000)

            self.cookie_timer = QTimer(self)
            self.cookie_timer.timeout.connect(self._poll_cookie_inventory_if_ready)
            self.cookie_timer.start(15000)

            QTimer.singleShot(400, self._poll_cdp_health)

            if self.config["browser"].get("auto_connect_on_launch"):
                QTimer.singleShot(600, self.start_all)

        def _init_window(self):
            self.resize(1040, 760)
            self.setMinimumSize(880, 640)
            self.setWindowTitle(f"Wimotek Edge CDP Node v{APP_VERSION} · Windows")
            icon_path = _resolve_asset_path("app_icon.ico") or _resolve_asset_path("app_icon.png")
            if icon_path is not None:
                self.setWindowIcon(QIcon(str(icon_path)))
            desktop = QApplication.primaryScreen().availableGeometry()
            self.move(
                max(0, desktop.center().x() - self.width() // 2),
                max(0, desktop.center().y() - self.height() // 2),
            )

        def _build_pages(self):
            self.page_hub = _PageScrollArea("pageHub", self)
            self.page_browser = _PageScrollArea("pageBrowser", self)
            self.page_guard = _PageScrollArea("pageGuard", self)
            self.page_logs = _PageScrollArea("pageLogs", self)

            self._build_hub_page()
            self._build_browser_page()
            self._build_guard_page()
            self._build_logs_page()

            self.addSubInterface(self.page_hub, _icon("HOME"), "节点接入与 Hub", NavigationItemPosition.TOP)
            self.addSubInterface(self.page_browser, _icon("GLOBE", FIF.APPLICATION), "浏览器与 CDP 隔离", NavigationItemPosition.TOP)
            self.addSubInterface(self.page_guard, _icon("CERTIFICATE", FIF.VPN), "Cookie 隐私防火墙", NavigationItemPosition.TOP)
            self.addSubInterface(self.page_logs, _icon("DOCUMENT", FIF.INFO), "运行日志与审计", NavigationItemPosition.BOTTOM)

        def _build_hub_page(self):
            v = self.page_hub.vbox

            title_row = QHBoxLayout()
            title_col = QVBoxLayout()
            title_col.addWidget(SubtitleLabel("节点接入与 Hub 网关", self.page_hub.container))
            sub = CaptionLabel("通过加密 WSS 直连 (9443) 或出站反向穿透接入 chromium_sync Hub，支持公网 IP 与 DDNS 域名探测", self.page_hub.container)
            sub.setTextColor(QColor("#94a3b8"), QColor("#94a3b8"))
            title_col.addWidget(sub)
            title_row.addLayout(title_col)
            title_row.addStretch()
            v.addLayout(title_row)

            # 状态与控制卡片
            hero = CardWidget(self.page_hub.container)
            hero_lay = QVBoxLayout(hero)
            hero_lay.setContentsMargins(18, 16, 18, 16)
            hero_lay.setSpacing(12)

            badge_row = QHBoxLayout()
            badge_row.setSpacing(10)
            self.badge_cdp = _make_badge("CDP 9222: 检测中", "#334155")
            self.badge_hub = _make_badge("Hub: 未接入", "#334155")
            self.badge_guard = _make_badge(f"Cookie 保护: {self.status_state['guard']}", "#0f766e", "#ccfbf1")
            self.badge_cookies = _make_badge("本机 Cookie: 待检测", "#334155")
            badge_row.addWidget(self.badge_cdp)
            badge_row.addWidget(self.badge_hub)
            badge_row.addWidget(self.badge_guard)
            badge_row.addWidget(self.badge_cookies)
            badge_row.addStretch()
            hero_lay.addLayout(badge_row)

            ctrl_row = QHBoxLayout()
            ctrl_row.setSpacing(10)
            self.btn_start = PrimaryPushButton(_icon("PLAY"), "启动浏览器并接入 Hub", hero)
            self.btn_stop = PushButton(_icon("CLOSE", FIF.PAUSE), "停止运行", hero)
            self.btn_stop.setEnabled(False)
            self.btn_launch_only = PushButton(_icon("GLOBE"), "仅拉起调试浏览器", hero)
            self.btn_cookie_inventory = PushButton(_icon("SEARCH"), "本机 Cookie 清单", hero)
            self.btn_save_hub = PushButton(_icon("SAVE"), "保存配置", hero)

            ctrl_row.addWidget(self.btn_start)
            ctrl_row.addWidget(self.btn_stop)
            ctrl_row.addWidget(self.btn_launch_only)
            ctrl_row.addWidget(self.btn_cookie_inventory)
            ctrl_row.addStretch()
            ctrl_row.addWidget(self.btn_save_hub)
            hero_lay.addLayout(ctrl_row)
            v.addWidget(hero)

            # Hub 参数卡片
            card_hub = CardWidget(self.page_hub.container)
            lay_hub = QVBoxLayout(card_hub)
            lay_hub.setContentsMargins(18, 16, 18, 16)
            lay_hub.setSpacing(10)
            lay_hub.addWidget(StrongBodyLabel("Hub 主控网关参数", card_hub))

            form = QFormLayout()
            form.setLabelAlignment(Qt.AlignLeft | Qt.AlignVCenter)
            form.setHorizontalSpacing(18)
            form.setVerticalSpacing(10)

            self.in_hub_url = LineEdit(card_hub)
            self.in_hub_url.setPlaceholderText("例如 https://hub.yourdomain.com:8443")
            self.in_join_token = PasswordLineEdit(card_hub)
            self.in_join_token.setPlaceholderText("留空则走 Hub TOFU 人工审批")
            self.in_node_name = LineEdit(card_hub)
            self.in_node_name.setPlaceholderText("留空自动使用 Win-<主机名>")
            self.in_group_name = LineEdit(card_hub)

            self.cmb_reverse_mode = ComboBox(card_hub)
            self.cmb_reverse_mode.addItems([
                "auto（优先公网 WSS 探测，不通自动反穿）",
                "true（强制纯出站 WSS 反向长连）",
                "false（强制公网 WSS 直连模式）",
            ])

            self.in_pub_host = LineEdit(card_hub)
            self.in_pub_host.setPlaceholderText("留空自动探测；可填公网 IPv4 或 DDNS 域名（如 home.example.com）")
            self.in_pub_v6 = LineEdit(card_hub)
            self.in_pub_v6.setPlaceholderText("留空自动探测公网 IPv6")

            ports_row = QHBoxLayout()
            ports_row.setSpacing(10)
            self.in_cdp_port = LineEdit(card_hub)
            self.in_cdp_port.setFixedWidth(96)
            self.in_wss_port = LineEdit(card_hub)
            self.in_wss_port.setFixedWidth(96)
            self.in_ext_wss_port = LineEdit(card_hub)
            self.in_ext_wss_port.setFixedWidth(96)

            ports_row.addWidget(BodyLabel("本地 CDP:", card_hub))
            ports_row.addWidget(self.in_cdp_port)
            ports_row.addSpacing(8)
            ports_row.addWidget(BodyLabel("本地 WSS:", card_hub))
            ports_row.addWidget(self.in_wss_port)
            ports_row.addSpacing(8)
            ports_row.addWidget(BodyLabel("外部映射 WSS:", card_hub))
            ports_row.addWidget(self.in_ext_wss_port)
            ports_row.addStretch()

            form.addRow(BodyLabel("Hub 地址 (HUB_URL)", card_hub), self.in_hub_url)
            form.addRow(BodyLabel("入网通行码 (JOIN_TOKEN)", card_hub), self.in_join_token)
            form.addRow(BodyLabel("节点名称", card_hub), self.in_node_name)
            form.addRow(BodyLabel("所属分组", card_hub), self.in_group_name)
            form.addRow(BodyLabel("接入模式", card_hub), self.cmb_reverse_mode)
            form.addRow(BodyLabel("端口设置", card_hub), ports_row)
            form.addRow(BodyLabel("公网 IP / 域名 (可选)", card_hub), self.in_pub_host)
            form.addRow(BodyLabel("公网 IPv6 (可选)", card_hub), self.in_pub_v6)

            lay_hub.addLayout(form)
            cfg_hint = CaptionLabel(f"配置文件路径：{self.config_path}", card_hub)
            cfg_hint.setTextColor(QColor("#64748b"), QColor("#64748b"))
            lay_hub.addWidget(cfg_hint)
            v.addWidget(card_hub)

            # 窗口关闭与系统托盘设置卡片
            tray_card = CardWidget(self.page_hub.container)
            tray_lay = QVBoxLayout(tray_card)
            tray_lay.setContentsMargins(18, 12, 18, 12)
            tray_lay.setSpacing(6)
            tray_row = QHBoxLayout()
            tray_row.addWidget(StrongBodyLabel("关闭主窗口时最小化到桌面右下角系统托盘", tray_card))
            tray_row.addStretch()
            self.sw_close_to_tray = SwitchButton(tray_card)
            tray_row.addWidget(self.sw_close_to_tray)
            tray_lay.addLayout(tray_row)
            tray_hint = CaptionLabel(
                "开启后点击窗口右上角“×”将隐藏到右下角托盘继续保持 Hub 与 CDP 在线；右键托盘图标可恢复窗口或彻底退出。",
                tray_card,
            )
            tray_hint.setTextColor(QColor("#94a3b8"), QColor("#94a3b8"))
            tray_lay.addWidget(tray_hint)
            v.addWidget(tray_card)

            # 实时运行跟踪日志卡片（首页直出，无需切换即可跟踪全部状态）
            log_preview_card = CardWidget(self.page_hub.container)
            lp_lay = QVBoxLayout(log_preview_card)
            lp_lay.setContentsMargins(18, 14, 18, 14)
            lp_lay.setSpacing(8)

            lp_hdr = QHBoxLayout()
            lp_hdr.addWidget(StrongBodyLabel("实时运行跟踪日志", log_preview_card))
            lp_path = CaptionLabel(f"持久化路径：{get_log_file_path()}", log_preview_card)
            lp_path.setTextColor(QColor("#64748b"), QColor("#64748b"))
            lp_hdr.addSpacing(10)
            lp_hdr.addWidget(lp_path)
            lp_hdr.addStretch()
            btn_hub_clear_log = PushButton(_icon("DELETE"), "清空", log_preview_card)
            btn_hub_clear_log.clicked.connect(self._clear_logs)
            btn_hub_full_log = PushButton(_icon("DOCUMENT", FIF.INFO), "完整日志审计", log_preview_card)
            btn_hub_full_log.clicked.connect(lambda: self.switchTo(self.page_logs))
            lp_hdr.addWidget(btn_hub_clear_log)
            lp_hdr.addWidget(btn_hub_full_log)
            lp_lay.addLayout(lp_hdr)

            self.txt_hub_logs = PlainTextEdit(log_preview_card)
            self.txt_hub_logs.setReadOnly(True)
            self.txt_hub_logs.setFont(QFont("Consolas", 9))
            self.txt_hub_logs.setMinimumHeight(180)
            self.txt_hub_logs.setMaximumHeight(240)
            lp_lay.addWidget(self.txt_hub_logs)
            v.addWidget(log_preview_card)

        def _build_browser_page(self):
            v = self.page_browser.vbox
            v.addWidget(SubtitleLabel("系统浏览器探测与 CDP 隔离", self.page_browser.container))
            sub = CaptionLabel("Chrome / Edge 136+ 强制要求非默认 User Data 目录才允许开启 --remote-debugging-port=9222", self.page_browser.container)
            sub.setTextColor(QColor("#94a3b8"), QColor("#94a3b8"))
            v.addWidget(sub)

            probe_card = CardWidget(self.page_browser.container)
            probe_lay = QHBoxLayout(probe_card)
            probe_lay.setContentsMargins(18, 14, 18, 14)
            self.lbl_detected_browsers = StrongBodyLabel("正在探测本机浏览器...", probe_card)
            btn_reprobe = PushButton(_icon("SYNC"), "重新探测", probe_card)
            btn_reprobe.clicked.connect(self._refresh_browser_probe)
            probe_lay.addWidget(self.lbl_detected_browsers)
            probe_lay.addStretch()
            probe_lay.addWidget(btn_reprobe)
            v.addWidget(probe_card)

            br_card = CardWidget(self.page_browser.container)
            lay = QVBoxLayout(br_card)
            lay.setContentsMargins(18, 16, 18, 16)
            lay.setSpacing(12)

            form = QFormLayout()
            form.setHorizontalSpacing(18)
            form.setVerticalSpacing(10)

            self.cmb_browser_choice = ComboBox(br_card)
            self.cmb_browser_choice.addItems([
                "auto（自动优先 Edge，其次 Chrome）",
                "edge（Microsoft Edge）",
                "chrome（Google Chrome）",
                "custom（指定自定义可执行文件）",
            ])

            exe_row = QHBoxLayout()
            self.in_custom_browser = LineEdit(br_card)
            self.in_custom_browser.setPlaceholderText("仅选择 custom 时需要填写 msedge.exe / chrome.exe 路径")
            btn_br_exe = PushButton(_icon("FOLDER"), "浏览...", br_card)
            btn_br_exe.clicked.connect(self._browse_browser_exe)
            exe_row.addWidget(self.in_custom_browser)
            exe_row.addWidget(btn_br_exe)

            self.cmb_profile_mode = ComboBox(br_card)
            self.cmb_profile_mode.addItems([
                f"isolated（推荐独立沙盒：{get_default_profile_dir().name}）",
                "system_default（系统默认目录，136+ 版本可能被浏览器拒绝开启 9222）",
            ])

            prof_row = QHBoxLayout()
            self.in_custom_profile = LineEdit(br_card)
            self.in_custom_profile.setPlaceholderText(f"留空使用 {get_default_profile_dir()}")
            btn_prof_dir = PushButton(_icon("FOLDER"), "选择目录...", br_card)
            btn_prof_dir.clicked.connect(self._browse_profile_dir)
            prof_row.addWidget(self.in_custom_profile)
            prof_row.addWidget(btn_prof_dir)

            self.in_homepage = LineEdit(br_card)
            self.in_extra_args = LineEdit(br_card)
            self.in_extra_args.setPlaceholderText("例如 --proxy-server=http://127.0.0.1:7890")

            form.addRow(BodyLabel("浏览器引擎", br_card), self.cmb_browser_choice)
            form.addRow(BodyLabel("自定义浏览器 (.exe)", br_card), exe_row)
            form.addRow(BodyLabel("数据目录隔离", br_card), self.cmb_profile_mode)
            form.addRow(BodyLabel("自定义数据目录", br_card), prof_row)
            form.addRow(BodyLabel("启动首页 URL", br_card), self.in_homepage)
            form.addRow(BodyLabel("附加启动参数", br_card), self.in_extra_args)
            lay.addLayout(form)

            sw_row1 = QHBoxLayout()
            sw_row1.addWidget(BodyLabel("接入 Hub 时自动拉起浏览器", br_card))
            sw_row1.addStretch()
            self.sw_launch_browser = SwitchButton(br_card)
            sw_row1.addWidget(self.sw_launch_browser)
            lay.addLayout(sw_row1)

            sw_row2 = QHBoxLayout()
            sw_row2.addWidget(BodyLabel("打开客户端后自动启动并接入 Hub", br_card))
            sw_row2.addStretch()
            self.sw_auto_connect = SwitchButton(br_card)
            sw_row2.addWidget(self.sw_auto_connect)
            lay.addLayout(sw_row2)

            save_row = QHBoxLayout()
            save_row.addStretch()
            btn_save_br = PrimaryPushButton(_icon("SAVE"), "保存浏览器设置", br_card)
            btn_save_br.clicked.connect(self.save_ui_config)
            save_row.addWidget(btn_save_br)
            lay.addLayout(save_row)

            v.addWidget(br_card)
            v.addStretch()

        def _build_guard_page(self):
            v = self.page_guard.vbox
            v.addWidget(SubtitleLabel("本地边缘 Cookie 隐私防火墙", self.page_guard.container))
            sub = CaptionLabel("所有拦截均在本机内存中直接生效，敏感 Cookie 在离开 Windows 网卡前即被丢弃，日志绝不输出 Cookie 明文", self.page_guard.container)
            sub.setTextColor(QColor("#94a3b8"), QColor("#94a3b8"))
            v.addWidget(sub)

            mode_card = CardWidget(self.page_guard.container)
            m_lay = QVBoxLayout(mode_card)
            m_lay.setContentsMargins(18, 16, 18, 16)
            m_lay.setSpacing(8)
            m_lay.addWidget(StrongBodyLabel("防护策略模式", mode_card))

            self.guard_btn_group = QButtonGroup(mode_card)
            self.rb_modes: Dict[str, RadioButton] = {}
            mode_defs = [
                ("whitelist", "严格白名单（推荐）：仅放行下方白名单域名（注意：白名单为空时会拦截全部 Cookie，Hub 显示 0 条）"),
                ("blacklist", "黑名单排除：放行除黑名单域名与敏感 Cookie 名以外的域名"),
                ("all", "本地全量放行：允许本地所有有效 Cookie 参与 Hub 同步（建议配合独立 BrowserProfile）"),
                ("block_export", "禁止导出（纯远程 CDP）：不允许 Hub 读取本地 Cookie，仅保留远程调试能力"),
            ]
            for val, desc in mode_defs:
                rb = RadioButton(desc, mode_card)
                self.guard_btn_group.addButton(rb)
                self.rb_modes[val] = rb
                m_lay.addWidget(rb)

            sw1 = QHBoxLayout()
            sw1.addWidget(BodyLabel("自动剔除已过期 Cookie", mode_card))
            sw1.addStretch()
            self.sw_exclude_expired = SwitchButton(mode_card)
            sw1.addWidget(self.sw_exclude_expired)
            m_lay.addLayout(sw1)

            sw2 = QHBoxLayout()
            sw2.addWidget(BodyLabel("Hub 下发 inject_cookies 写入本机时同样校验保护规则", mode_card))
            sw2.addStretch()
            self.sw_protect_inject = SwitchButton(mode_card)
            sw2.addWidget(self.sw_protect_inject)
            m_lay.addLayout(sw2)
            v.addWidget(mode_card)

            lists_row = QHBoxLayout()
            lists_row.setSpacing(12)

            wl_card = CardWidget(self.page_guard.container)
            wl_lay = QVBoxLayout(wl_card)
            wl_lay.setContentsMargins(14, 14, 14, 14)
            wl_lay.addWidget(StrongBodyLabel("白名单域名（每行或逗号分隔，支持 *.domain.com）", wl_card))
            self.txt_whitelist = PlainTextEdit(wl_card)
            self.txt_whitelist.setMinimumHeight(170)
            self.txt_whitelist.setPlaceholderText("例如：\ngithub.com\n*.openai.com")
            wl_lay.addWidget(self.txt_whitelist)

            bl_card = CardWidget(self.page_guard.container)
            bl_lay = QVBoxLayout(bl_card)
            bl_lay.setContentsMargins(14, 14, 14, 14)
            bl_lay.addWidget(StrongBodyLabel("黑名单域名（支持 *bank* 通配屏蔽）", bl_card))
            self.txt_blacklist = PlainTextEdit(bl_card)
            self.txt_blacklist.setMinimumHeight(170)
            bl_lay.addWidget(self.txt_blacklist)

            lists_row.addWidget(wl_card)
            lists_row.addWidget(bl_card)
            v.addLayout(lists_row)

            bottom_card = CardWidget(self.page_guard.container)
            b_lay = QVBoxLayout(bottom_card)
            b_lay.setContentsMargins(16, 14, 16, 14)
            b_lay.setSpacing(10)

            name_row = QHBoxLayout()
            name_row.addWidget(BodyLabel("屏蔽 Cookie 名称关键字（逗号分隔，支持 *token*）:", bottom_card))
            self.in_blocked_names = LineEdit(bottom_card)
            name_row.addWidget(self.in_blocked_names)
            b_lay.addLayout(name_row)

            act_row = QHBoxLayout()
            btn_reset_bl = PushButton(_icon("SYNC"), "恢复默认敏感黑名单", bottom_card)
            btn_reset_bl.clicked.connect(self._reset_default_blacklist)
            btn_inventory = PushButton(_icon("DOCUMENT", FIF.SEARCH), "查看本机 Cookie 清单", bottom_card)
            btn_inventory.clicked.connect(self.open_cookie_inventory)
            btn_preview = PushButton(_icon("SEARCH"), "试算本地 Cookie 过滤结果", bottom_card)
            btn_preview.clicked.connect(self.preview_cookie_guard)
            btn_apply = PrimaryPushButton(_icon("SAVE"), "应用并热更新策略", bottom_card)
            btn_apply.clicked.connect(self.save_ui_config)

            act_row.addWidget(btn_reset_bl)
            act_row.addStretch()
            act_row.addWidget(btn_inventory)
            act_row.addWidget(btn_preview)
            act_row.addWidget(btn_apply)
            b_lay.addLayout(act_row)
            v.addWidget(bottom_card)

        def _build_logs_page(self):
            v = self.page_logs.vbox
            v.addWidget(SubtitleLabel("运行日志与隐私审计", self.page_logs.container))

            bar = CardWidget(self.page_logs.container)
            b_lay = QHBoxLayout(bar)
            b_lay.setContentsMargins(14, 10, 14, 10)
            b_lay.setSpacing(8)
            b_lay.addWidget(BodyLabel("级别:", bar))
            self.cmb_log_filter = ComboBox(bar)
            self.cmb_log_filter.addItems(["ALL", "GUARD", "INFO", "WARNING", "ERROR"])
            self.cmb_log_filter.currentTextChanged.connect(self._rerender_logs)

            self.in_log_search = LineEdit(bar)
            self.in_log_search.setPlaceholderText("搜索日志关键字...")
            self.in_log_search.textChanged.connect(self._rerender_logs)

            btn_reload = PushButton(_icon("SYNC"), "刷新", bar)
            btn_reload.clicked.connect(self._reload_disk_logs)
            btn_export = PushButton(_icon("SAVE"), "导出", bar)
            btn_export.clicked.connect(self._export_logs)
            btn_clear = PushButton(_icon("DELETE"), "清空", bar)
            btn_clear.clicked.connect(self._clear_logs)
            btn_dir = PushButton(_icon("FOLDER"), "目录", bar)
            btn_dir.clicked.connect(self._open_log_dir)

            b_lay.addWidget(self.cmb_log_filter)
            b_lay.addWidget(self.in_log_search, 1)
            b_lay.addWidget(btn_reload)
            b_lay.addWidget(btn_export)
            b_lay.addWidget(btn_clear)
            b_lay.addWidget(btn_dir)
            v.addWidget(bar)

            log_hint = CaptionLabel(f"持久化日志文件：{get_log_file_path()}（自动轮转保留，重启客户端后可追溯历史）", self.page_logs.container)
            log_hint.setTextColor(QColor("#64748b"), QColor("#64748b"))
            v.addWidget(log_hint)

            log_card = CardWidget(self.page_logs.container)
            l_lay = QVBoxLayout(log_card)
            l_lay.setContentsMargins(12, 12, 12, 12)
            self.txt_logs = PlainTextEdit(log_card)
            self.txt_logs.setReadOnly(True)
            self.txt_logs.setFont(QFont("Consolas", 10))
            self.txt_logs.setMinimumHeight(460)
            self.txt_logs.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
            l_lay.addWidget(self.txt_logs)
            v.addWidget(log_card, 1)

        def _init_tray(self):
            if not QSystemTrayIcon.isSystemTrayAvailable():
                return
            icon_path = _resolve_asset_path("app_icon.ico") or _resolve_asset_path("app_icon.png")
            if icon_path is not None:
                tray_qicon = QIcon(str(icon_path))
            else:
                tray_qicon = self.style().standardIcon(QStyle.SP_ComputerIcon)

            self.tray_icon = QSystemTrayIcon(tray_qicon, self)
            self.tray_icon.setToolTip(f"Wimotek Edge CDP Node v{APP_VERSION}")

            self.tray_menu = QMenu(self)
            self._act_tray_show = QAction("显示主窗口", self)
            self._act_tray_cookies = QAction("查看本机 Cookie 清单", self)
            self._act_tray_start = QAction("启动并接入 Hub", self)
            self._act_tray_stop = QAction("停止 Hub 接入", self)
            self._act_tray_quit = QAction("退出程序", self)

            self._act_tray_show.triggered.connect(self._restore_from_tray)
            self._act_tray_cookies.triggered.connect(self._open_inventory_from_tray)
            self._act_tray_start.triggered.connect(self.start_all)
            self._act_tray_stop.triggered.connect(self.stop_all)
            self._act_tray_quit.triggered.connect(self._quit_application)

            self.tray_menu.addAction(self._act_tray_show)
            self.tray_menu.addAction(self._act_tray_cookies)
            self.tray_menu.addSeparator()
            self.tray_menu.addAction(self._act_tray_start)
            self.tray_menu.addAction(self._act_tray_stop)
            self.tray_menu.addSeparator()
            self.tray_menu.addAction(self._act_tray_quit)

            self.tray_icon.setContextMenu(self.tray_menu)
            self.tray_icon.activated.connect(self._on_tray_activated)
            self.tray_icon.show()

        def _on_tray_activated(self, reason):
            if reason in (QSystemTrayIcon.Trigger, QSystemTrayIcon.DoubleClick):
                if self.isVisible() and not self.isMinimized():
                    self.activateWindow()
                    self.raise_()
                else:
                    self._restore_from_tray()

        def _restore_from_tray(self):
            self.showNormal()
            self.raise_()
            self.activateWindow()

        def _open_inventory_from_tray(self):
            self._restore_from_tray()
            self.open_cookie_inventory()

        def _quit_application(self):
            self._force_quit = True
            self._log_event("INFO", "用户从系统托盘退出客户端...")
            if self.agent:
                self.agent.request_stop()
            if self.tray_icon is not None:
                self.tray_icon.hide()
            QApplication.quit()

        def _on_close_to_tray_toggled(self, checked: bool):
            if self._loading_ui:
                return
            try:
                self.config.setdefault("ui", {})["close_to_tray"] = bool(checked)
                save_config(self.config, self.config_path)
                state_txt = "最小化到系统托盘（后台运行）" if checked else "直接退出程序"
                self._log_event("INFO", f"窗口关闭行为已更新：{state_txt}")
            except Exception:
                pass

        def _connect_signals(self):
            self.btn_start.clicked.connect(self.start_all)
            self.btn_stop.clicked.connect(self.stop_all)
            self.btn_launch_only.clicked.connect(self.launch_browser_only)
            self.btn_cookie_inventory.clicked.connect(self.open_cookie_inventory)
            self.btn_save_hub.clicked.connect(self.save_ui_config)
            self.sw_close_to_tray.checkedChanged.connect(self._on_close_to_tray_toggled)

            self.bridge.log_received.connect(self._append_log)
            self.bridge.status_received.connect(self._apply_status_patch)
            self.bridge.cdp_checked.connect(self._apply_cdp_status)
            self.bridge.agent_stopped.connect(self._on_agent_stopped)
            self.bridge.preview_finished.connect(self._on_preview_finished)
            self.bridge.inventory_scanned.connect(self._on_inventory_scanned)

        def _load_vars_from_config(self):
            self._loading_ui = True
            try:
                h = self.config["hub"]
                self.in_hub_url.setText(h.get("hub_url", ""))
                self.in_join_token.setText(h.get("join_token", ""))
                self.in_node_name.setText(h.get("node_name", ""))
                self.in_group_name.setText(h.get("group_name", "Windows节点"))

                rev = str(h.get("reverse_tunnel", "auto")).lower()
                rev_idx = 0 if rev == "auto" else (1 if rev == "true" else 2)
                self.cmb_reverse_mode.setCurrentIndex(rev_idx)

                self.in_cdp_port.setText(str(h.get("cdp_port", 9222)))
                self.in_wss_port.setText(str(h.get("edge_wss_port", 9443)))
                self.in_ext_wss_port.setText(str(h.get("edge_wss_external_port", 9443)))
                self.in_pub_host.setText(h.get("public_host") or h.get("public_ipv4") or "")
                self.in_pub_v6.setText(h.get("public_ipv6", ""))

                b = self.config["browser"]
                br_map = {"auto": 0, "edge": 1, "chrome": 2, "custom": 3}
                self.cmb_browser_choice.setCurrentIndex(br_map.get(b.get("browser_choice", "auto"), 0))
                self.in_custom_browser.setText(b.get("custom_browser_path", ""))
                self.cmb_profile_mode.setCurrentIndex(1 if b.get("profile_mode") == "system_default" else 0)
                self.in_custom_profile.setText(b.get("custom_profile_dir", ""))
                self.in_homepage.setText(b.get("homepage", "about:blank"))
                self.in_extra_args.setText(b.get("extra_args", ""))
                self.sw_launch_browser.setChecked(bool(b.get("launch_browser_on_start", True)))
                self.sw_auto_connect.setChecked(bool(b.get("auto_connect_on_launch", False)))

                g = self.config["cookie_guard"]
                mode = g.get("mode", "whitelist")
                if mode in self.rb_modes:
                    self.rb_modes[mode].setChecked(True)
                else:
                    self.rb_modes["whitelist"].setChecked(True)
                self.sw_exclude_expired.setChecked(bool(g.get("exclude_expired", True)))
                self.sw_protect_inject.setChecked(bool(g.get("protect_inject", False)))
                self.in_blocked_names.setText(", ".join(g.get("blocked_cookie_names", [])))
                self.txt_whitelist.setPlainText("\n".join(g.get("whitelist_domains", [])))
                self.txt_blacklist.setPlainText("\n".join(g.get("blacklist_domains", [])))

                ui_cfg = self.config.get("ui", {})
                self.sw_close_to_tray.setChecked(bool(ui_cfg.get("close_to_tray", True)))
            finally:
                self._loading_ui = False

        def _collect_config_from_vars(self) -> Dict[str, Any]:
            cfg = copy.deepcopy(self.config)
            rev_map = {0: "auto", 1: "true", 2: "false"}
            br_map = {0: "auto", 1: "edge", 2: "chrome", 3: "custom"}

            cdp_port = int(self.in_cdp_port.text().strip() or 9222)
            wss_port = int(self.in_wss_port.text().strip() or 9443)
            ext_wss_port = int(self.in_ext_wss_port.text().strip() or wss_port)
            pub_host_val = self.in_pub_host.text().strip()

            cfg["hub"].update({
                "hub_url": self.in_hub_url.text().strip().rstrip("/"),
                "join_token": self.in_join_token.text().strip(),
                "node_name": self.in_node_name.text().strip(),
                "group_name": self.in_group_name.text().strip() or "Windows节点",
                "reverse_tunnel": rev_map.get(self.cmb_reverse_mode.currentIndex(), "auto"),
                "cdp_port": cdp_port,
                "edge_wss_port": wss_port,
                "edge_wss_external_port": ext_wss_port,
                "public_host": pub_host_val,
                "public_ipv4": pub_host_val,
                "public_ipv6": self.in_pub_v6.text().strip(),
            })

            cfg["browser"].update({
                "browser_choice": br_map.get(self.cmb_browser_choice.currentIndex(), "auto"),
                "custom_browser_path": self.in_custom_browser.text().strip(),
                "profile_mode": "system_default" if self.cmb_profile_mode.currentIndex() == 1 else "isolated",
                "custom_profile_dir": self.in_custom_profile.text().strip(),
                "homepage": self.in_homepage.text().strip() or "about:blank",
                "extra_args": self.in_extra_args.text().strip(),
                "launch_browser_on_start": bool(self.sw_launch_browser.isChecked()),
                "auto_connect_on_launch": bool(self.sw_auto_connect.isChecked()),
            })

            selected_mode = "whitelist"
            for m, rb in self.rb_modes.items():
                if rb.isChecked():
                    selected_mode = m
                    break

            cfg["cookie_guard"].update({
                "mode": selected_mode,
                "whitelist_domains": parse_rule_list(self.txt_whitelist.toPlainText()),
                "blacklist_domains": parse_rule_list(self.txt_blacklist.toPlainText()),
                "blocked_cookie_names": parse_rule_list(self.in_blocked_names.text()),
                "exclude_expired": bool(self.sw_exclude_expired.isChecked()),
                "protect_inject": bool(self.sw_protect_inject.isChecked()),
            })

            cfg.setdefault("ui", {})["close_to_tray"] = bool(self.sw_close_to_tray.isChecked())
            return cfg

        def _toast(self, kind: str, title: str, content: str):
            fn = {
                "success": InfoBar.success,
                "warning": InfoBar.warning,
                "error": InfoBar.error,
                "info": InfoBar.info,
            }.get(kind, InfoBar.info)
            fn(
                title=title,
                content=content,
                orient=Qt.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP_RIGHT,
                duration=3500,
                parent=self,
            )

        def save_ui_config(self):
            try:
                self.config = self._collect_config_from_vars()
                save_config(self.config, self.config_path)
                mode = self.config["cookie_guard"]["mode"]
                self.badge_guard.setText(f"Cookie 保护: {mode}")
                if self.agent is not None:
                    self.agent.update_cookie_guard(self.config["cookie_guard"])
                    msg = f"配置已保存并热更新至 Cookie 防火墙 (策略={mode})"
                else:
                    msg = f"配置已保存到本地 config.json (策略={mode})"
                self._log_event("INFO", msg)
                self._toast("success", "保存成功", msg)
                if self._last_cdp_ok:
                    self.scan_cookie_inventory(open_dialog=False, force_log=True)
            except Exception as e:
                self._toast("error", "配置无效", str(e))

        def _refresh_browser_probe(self):
            det = detect_installed_browsers()
            e_txt = f"Microsoft Edge: {'已就绪' if det['edge'] else '未发现'}"
            c_txt = f"Google Chrome: {'已就绪' if det['chrome'] else '未发现'}"
            self.lbl_detected_browsers.setText(f"{e_txt}   |   {c_txt}")
            self._log_event("INFO", f"浏览器探测 | {e_txt} | {c_txt}")

        def _browse_browser_exe(self):
            p, _ = QFileDialog.getOpenFileName(
                self, "选择浏览器可执行文件", "", "Executable (*.exe);;All Files (*)"
            )
            if p:
                self.in_custom_browser.setText(p)
                self.cmb_browser_choice.setCurrentIndex(3)

        def _browse_profile_dir(self):
            p = QFileDialog.getExistingDirectory(self, "选择浏览器数据目录 (--user-data-dir)")
            if p:
                self.in_custom_profile.setText(p)

        def _reset_default_blacklist(self):
            self.txt_blacklist.setPlainText("\n".join(DEFAULT_SENSITIVE_BLACKLIST))
            self._toast("info", "已恢复默认列表", "已重置默认敏感网银/邮箱/统计黑名单（记得点击应用保存）")

        def launch_browser_only(self):
            try:
                self.config = self._collect_config_from_vars()
                save_config(self.config, self.config_path)
                b = self.config["browser"]
                cdp_port = int(self.config["hub"]["cdp_port"])
                label, cmd = self.browser_mgr.launch(
                    browser_choice=b["browser_choice"],
                    custom_browser_path=b["custom_browser_path"],
                    cdp_port=cdp_port,
                    profile_mode=b["profile_mode"],
                    custom_profile_dir=b["custom_profile_dir"],
                    homepage=b["homepage"],
                    extra_args=b["extra_args"],
                )
                msg = f"已启动 {label} (CDP 127.0.0.1:{cdp_port})" if cmd else f"{label} 已在运行中"
                self._log_event("INFO", msg)
                self._toast("success", "浏览器就绪", msg)
                QTimer.singleShot(1200, self._poll_cdp_health)
            except Exception as e:
                self._log_event("ERROR", f"启动浏览器失败: {e}")
                self._toast("error", "启动浏览器失败", str(e))

        def start_all(self):
            try:
                self.config = self._collect_config_from_vars()
                save_config(self.config, self.config_path)
            except Exception as e:
                self._toast("error", "配置无效", str(e))
                return

            if not self.config["hub"].get("hub_url"):
                self._toast("warning", "缺少参数", "请先填写 Hub 地址 (HUB_URL)")
                return

            if self.config["browser"].get("launch_browser_on_start", True):
                self.launch_browser_only()

            if self.agent_thread and self.agent_thread.is_alive():
                return

            self._log_event("INFO", f"正在接入 Hub 网关: {self.config['hub']['hub_url']}")
            self.btn_start.setEnabled(False)
            self.btn_stop.setEnabled(True)
            self.badge_hub.setText("Hub: 连接探测中...")
            self.badge_hub.setStyleSheet(
                "QLabel { background-color: #0369a1; color: #e0f2fe; border-radius: 6px; padding: 5px 12px; font-weight: 600; font-size: 12px; }"
            )

            def _on_log(level: str, msg: str):
                self.bridge.log_received.emit(level, msg)

            def _on_status(patch: Dict[str, Any]):
                self.bridge.status_received.emit(patch)

            self.agent = WinEdgeAgent(self.config, log_callback=_on_log, status_callback=_on_status)

            def _runner():
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                try:
                    loop.run_until_complete(self.agent.run())
                except Exception as exc:
                    line = append_disk_log("ERROR", f"代理异常退出: {exc}")
                    self.bridge.log_received.emit("ERROR", line)
                finally:
                    loop.close()
                    self.bridge.agent_stopped.emit()

            self.agent_thread = threading.Thread(target=_runner, daemon=True)
            self.agent_thread.start()

        def stop_all(self):
            if self.agent:
                self.agent.request_stop()
            self._log_event("INFO", "正在停止 Hub WSS 接入...")
            self.btn_stop.setEnabled(False)

        def preview_cookie_guard(self):
            try:
                cfg = self._collect_config_from_vars()
                guard = CookieGuard(CookieGuardConfig.from_dict(cfg["cookie_guard"]))
                cdp_port = int(cfg["hub"]["cdp_port"])
            except Exception as e:
                self._toast("error", "参数错误", str(e))
                return

            def _worker():
                async def _run():
                    async with httpx.AsyncClient(timeout=4.0, trust_env=False) as client:
                        raw = await extract_raw_local_cookies(client, cdp_port)
                    _, stats = guard.filter_for_export(raw)
                    top_allow = ", ".join(
                        f"{k}({v})" for k, v in sorted(stats.allowed_domains.items(), key=lambda x: -x[1])[:8]
                    ) or "无"
                    top_block = ", ".join(
                        f"{k}({v})" for k, v in sorted(stats.blocked_domains.items(), key=lambda x: -x[1])[:8]
                    ) or "无"
                    summary = (
                        f"模式={guard.config.mode} | 总计={stats.total} | 放行={stats.allowed} | "
                        f"本地拦截={stats.blocked_by_policy} | 过期={stats.expired_dropped}"
                    )
                    log_line = append_disk_log(
                        "INFO",
                        f"[GUARD] 试算预览 | {summary} | 放行Top=[{top_allow}] | 拦截Top=[{top_block}]",
                    )
                    self.bridge.log_received.emit("GUARD", log_line)
                    self.bridge.preview_finished.emit("success", summary)

                try:
                    asyncio.run(_run())
                except Exception as exc:
                    err = f"试算失败（请确认浏览器 CDP 127.0.0.1:{cdp_port} 已启动）: {exc}"
                    line = append_disk_log("ERROR", err)
                    self.bridge.log_received.emit("ERROR", line)
                    self.bridge.preview_finished.emit("error", err)

            threading.Thread(target=_worker, daemon=True).start()

        def _on_preview_finished(self, kind: str, msg: str):
            self._toast(kind, "Cookie 防火墙试算结果" if kind == "success" else "试算失败", msg)

        def open_cookie_inventory(self):
            if self._inventory_dialog is None:
                self._inventory_dialog = CookieInventoryDialog(
                    self,
                    rescan_callback=lambda: self.scan_cookie_inventory(open_dialog=False, force_log=True),
                )
            if self._cached_stats is not None:
                mode = self.config.get("cookie_guard", {}).get("mode", "whitelist")
                self._inventory_dialog.set_data(self._cached_rows, self._cached_stats, mode)
            self._inventory_dialog.btn_rescan.setEnabled(False)
            self._inventory_dialog.lbl_summary.setText("正在扫描本机浏览器 CDP Cookie...")
            self._inventory_dialog.show()
            self._inventory_dialog.raise_()
            self._inventory_dialog.activateWindow()
            self.scan_cookie_inventory(open_dialog=False, force_log=True)

        def _poll_cookie_inventory_if_ready(self):
            if self._last_cdp_ok:
                self.scan_cookie_inventory(open_dialog=False, force_log=False)

        def scan_cookie_inventory(self, open_dialog: bool = False, force_log: bool = False):
            try:
                cfg = self._collect_config_from_vars()
                guard = CookieGuard(CookieGuardConfig.from_dict(cfg["cookie_guard"]))
                cdp_port = int(cfg["hub"]["cdp_port"])
            except Exception as e:
                if open_dialog:
                    self._toast("error", "参数错误", str(e))
                return

            def _worker():
                try:
                    async def _run():
                        async with httpx.AsyncClient(timeout=4.0, trust_env=False) as client:
                            return await extract_raw_local_cookies(client, cdp_port)

                    raw = asyncio.run(_run())
                    rows, stats = guard.inspect_cookies(raw)
                    self.bridge.inventory_scanned.emit(rows, stats, "", force_log or open_dialog)
                except Exception as exc:
                    err = f"无法读取 CDP 127.0.0.1:{cdp_port} Cookie（请先点击“仅拉起调试浏览器”）: {exc}"
                    self.bridge.inventory_scanned.emit([], None, err, force_log or open_dialog)

            threading.Thread(target=_worker, daemon=True).start()

        def _on_inventory_scanned(self, rows: List[Dict[str, Any]], stats: Any, err_msg: str, force_log: bool):
            if err_msg or stats is None:
                self.badge_cookies.setText("本机 Cookie: 未连接")
                self.badge_cookies.setStyleSheet(
                    "QLabel { background-color: #334155; color: #e2e8f0; border-radius: 6px; padding: 5px 12px; font-weight: 600; font-size: 12px; }"
                )
                if self._inventory_dialog is not None and self._inventory_dialog.isVisible():
                    self._inventory_dialog.set_scan_error(err_msg)
                if force_log and err_msg:
                    self._log_event("WARNING", err_msg)
                return

            self._cached_rows = rows
            self._cached_stats = stats
            mode = self.config.get("cookie_guard", {}).get("mode", "whitelist")
            self.badge_cookies.setText(f"本机 Cookie: {stats.total} 条 (放行 {stats.allowed})")
            if stats.allowed > 0:
                bg, fg = "#065f46", "#d1fae5"
            elif stats.total > 0:
                bg, fg = "#92400e", "#fef3c7"
            else:
                bg, fg = "#334155", "#e2e8f0"
            self.badge_cookies.setStyleSheet(
                f"QLabel {{ background-color: {bg}; color: {fg}; border-radius: 6px; padding: 5px 12px; font-weight: 600; font-size: 12px; }}"
            )

            sig = (stats.total, stats.allowed, stats.blocked_by_policy)
            if force_log or sig != self._last_cookie_sig:
                self._last_cookie_sig = sig
                self._log_event(
                    "GUARD",
                    f"[GUARD] 本机 Cookie 清单扫描 | 策略={mode} | 总计={stats.total} | 放行={stats.allowed} | "
                    f"拦截={stats.blocked_by_policy} | 过期={stats.expired_dropped}",
                )

            if self._inventory_dialog is not None and self._inventory_dialog.isVisible():
                self._inventory_dialog.set_data(rows, stats, mode)
            self._update_tray_tooltip()

        def _poll_cdp_health(self):
            raw_port = self.in_cdp_port.text().strip()
            cdp_port = int(raw_port) if raw_port.isdigit() else 9222

            def _chk():
                try:
                    ver = asyncio.run(check_local_cdp_ready(cdp_port, timeout=1.0))
                    self.bridge.cdp_checked.emit(cdp_port, bool(ver))
                except Exception:
                    self.bridge.cdp_checked.emit(cdp_port, False)

            threading.Thread(target=_chk, daemon=True).start()

        def _apply_cdp_status(self, port: int, ok: bool):
            prev = self._last_cdp_ok
            self._last_cdp_ok = ok
            bg = "#065f46" if ok else "#334155"
            fg = "#d1fae5" if ok else "#e2e8f0"
            self.badge_cdp.setText(f"CDP {port}: {'就绪' if ok else '未启动'}")
            self.badge_cdp.setStyleSheet(
                f"QLabel {{ background-color: {bg}; color: {fg}; border-radius: 6px; padding: 5px 12px; font-weight: 600; font-size: 12px; }}"
            )
            if not ok:
                self.badge_cookies.setText("本机 Cookie: 等待浏览器")
                self.badge_cookies.setStyleSheet(
                    "QLabel { background-color: #334155; color: #e2e8f0; border-radius: 6px; padding: 5px 12px; font-weight: 600; font-size: 12px; }"
                )
            if prev is None or prev != ok:
                if ok:
                    self._log_event("INFO", f"本地调试浏览器 CDP 127.0.0.1:{port} 已就绪，正在扫描本机 Cookie 数量...")
                    self.scan_cookie_inventory(open_dialog=False, force_log=True)
                elif prev is True:
                    self._log_event("WARNING", f"本地调试浏览器 CDP 127.0.0.1:{port} 已离线或关闭")
            self._update_tray_tooltip()

        def _apply_status_patch(self, patch: Dict[str, Any]):
            if "hub_status" in patch or "hub_mode" in patch:
                hs = patch.get("hub_status", self.status_state["hub"])
                hm = patch.get("hub_mode", self.status_state["mode"])
                self.status_state["hub"] = hs
                self.status_state["mode"] = hm
                if hs == "connected":
                    bg, fg = "#065f46", "#d1fae5"
                elif hs in {"pending_tofu", "reconnecting"}:
                    bg, fg = "#92400e", "#fef3c7"
                elif hs in {"error", "denied"}:
                    bg, fg = "#991b1b", "#fee2e2"
                else:
                    bg, fg = "#334155", "#f8fafc"
                self.badge_hub.setText(f"Hub: {hs} ({hm})")
                self.badge_hub.setStyleSheet(
                    f"QLabel {{ background-color: {bg}; color: {fg}; border-radius: 6px; padding: 5px 12px; font-weight: 600; font-size: 12px; }}"
                )
                self._update_tray_tooltip()

        def _on_agent_stopped(self):
            self.btn_start.setEnabled(True)
            self.btn_stop.setEnabled(False)
            self.status_state["hub"] = "已停止"
            self.badge_hub.setText("Hub: 已停止")
            self.badge_hub.setStyleSheet(
                "QLabel { background-color: #334155; color: #f8fafc; border-radius: 6px; padding: 5px 12px; font-weight: 600; font-size: 12px; }"
            )
            self._update_tray_tooltip()

        def _log_event(self, level: str, message: str):
            disk_lvl = "INFO" if level == "GUARD" else level
            line = append_disk_log(disk_lvl, message)
            self._append_log(level, line)

        def _load_initial_logs(self):
            history = read_recent_logs(250)
            for lvl, ln in history:
                self.log_buffer.append((lvl, ln))
            self._rerender_logs()
            self._log_event("INFO", f"桌面客户端已启动 (v{APP_VERSION})，配置目录: {get_app_data_dir()}")

        def _append_log(self, level: str, msg: str):
            tag = "GUARD" if "[GUARD]" in msg else level
            self.log_buffer.append((tag, msg))
            if len(self.log_buffer) > 1500:
                self.log_buffer = self.log_buffer[-1200:]
            flt = self.cmb_log_filter.currentText()
            kw = self.in_log_search.text().strip().lower() if hasattr(self, "in_log_search") else ""
            if flt in ("ALL", tag) and (not kw or kw in msg.lower()):
                self._insert_formatted_log(self.txt_logs, tag, msg)
            if hasattr(self, "txt_hub_logs"):
                if self.txt_hub_logs.document().blockCount() > 260:
                    self._rerender_hub_logs()
                else:
                    self._insert_formatted_log(self.txt_hub_logs, tag, msg)

        def _insert_formatted_log(self, editor, tag: str, msg: str):
            color_map = {
                "GUARD": "#2dd4bf",
                "WARNING": "#fbbf24",
                "ERROR": "#f87171",
                "INFO": "#cbd5e1",
            }
            fmt = QTextCharFormat()
            fmt.setForeground(QColor(color_map.get(tag, "#cbd5e1")))
            cursor = editor.textCursor()
            cursor.movePosition(QTextCursor.End)
            cursor.insertText(msg + "\n", fmt)
            editor.setTextCursor(cursor)
            editor.ensureCursorVisible()

        def _rerender_hub_logs(self):
            if not hasattr(self, "txt_hub_logs"):
                return
            self.txt_hub_logs.clear()
            for tag, msg in self.log_buffer[-160:]:
                self._insert_formatted_log(self.txt_hub_logs, tag, msg)

        def _rerender_logs(self, *_unused):
            flt = self.cmb_log_filter.currentText()
            kw = self.in_log_search.text().strip().lower() if hasattr(self, "in_log_search") else ""
            self.txt_logs.clear()
            for tag, msg in self.log_buffer:
                if flt in ("ALL", tag) and (not kw or kw in msg.lower()):
                    self._insert_formatted_log(self.txt_logs, tag, msg)
            self._rerender_hub_logs()

        def _reload_disk_logs(self):
            self.log_buffer = read_recent_logs(400)
            self._rerender_logs()
            self._toast("info", "已刷新", f"已从 {get_log_file_path().name} 载入最近 {len(self.log_buffer)} 条日志")

        def _export_logs(self):
            default_name = f"wimotek-edge-log-{time.strftime('%Y%m%d-%H%M%S')}.log"
            save_path, _ = QFileDialog.getSaveFileName(
                self, "导出运行日志", default_name, "Log Files (*.log *.txt);;All Files (*)"
            )
            if save_path:
                try:
                    content = "\n".join(msg for _, msg in self.log_buffer)
                    Path(save_path).write_text(content + ("\n" if content else ""), encoding="utf-8")
                    self._toast("success", "导出成功", f"已导出 {len(self.log_buffer)} 条日志")
                except Exception as e:
                    self._toast("error", "导出失败", str(e))

        def _clear_logs(self):
            self.log_buffer.clear()
            self.txt_logs.clear()
            if hasattr(self, "txt_hub_logs"):
                self.txt_hub_logs.clear()
            clear_log_file()
            self._toast("info", "已清空", "已清空界面显示与磁盘日志文件")

        def _open_log_dir(self):
            log_dir = get_app_data_dir() / "logs"
            log_dir.mkdir(parents=True, exist_ok=True)
            if sys.platform == "win32":
                os.startfile(str(log_dir))

        def _update_tray_tooltip(self):
            if self.tray_icon is None:
                return
            cdp_txt = "就绪" if self._last_cdp_ok else "未启动"
            hub_txt = self.status_state.get("hub", "未接入")
            cookie_txt = (
                f"{self._cached_stats.total}(放行{self._cached_stats.allowed})"
                if self._cached_stats is not None
                else "待检测"
            )
            self.tray_icon.setToolTip(
                f"Wimotek Edge CDP Node v{APP_VERSION}\n"
                f"CDP: {cdp_txt} | Hub: {hub_txt} | Cookie: {cookie_txt}"
            )

        def closeEvent(self, event):
            tray_available = self.tray_icon is not None and QSystemTrayIcon.isSystemTrayAvailable()
            if not self._force_quit and self.sw_close_to_tray.isChecked() and tray_available:
                event.ignore()
                self.hide()
                self._log_event("INFO", "主窗口已最小化到桌面右下角系统托盘（右键托盘图标可恢复或退出）")
                if not self._tray_hint_shown:
                    self._tray_hint_shown = True
                    self.tray_icon.showMessage(
                        "Wimotek Edge CDP Node",
                        "已最小化到桌面右下角系统托盘并在后台继续运行，点击托盘图标可恢复窗口。",
                        QSystemTrayIcon.Information,
                        3000,
                    )
                return

            if self.agent:
                self.agent.request_stop()
            if self.tray_icon is not None:
                self.tray_icon.hide()
            super().closeEvent(event)
            QApplication.quit()

    # Windows 高分屏缩放自动适配 + Fluent 暗色主题
    QApplication.setHighDpiScaleFactorRoundingPolicy(Qt.HighDpiScaleFactorRoundingPolicy.PassThrough)
    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)
    icon_file = _resolve_asset_path("app_icon.ico") or _resolve_asset_path("app_icon.png")
    if icon_file is not None:
        app.setWindowIcon(QIcon(str(icon_file)))
    setTheme(Theme.DARK)
    setThemeColor("#0078D4")

    win = WimotekFluentWindow(cfg_path=config_path)
    win.show()
    sys.exit(app.exec())


def main():
    parser = argparse.ArgumentParser(description="Wimotek Windows Edge/Chrome CDP Node")
    parser.add_argument("--headless", action="store_true", help="Run without GUI window")
    parser.add_argument("--config", type=str, default="", help="Path to config.json")
    args = parser.parse_args()

    cfg_path = Path(args.config) if args.config else None
    if args.headless:
        run_headless(cfg_path)
        return

    _run_gui(cfg_path)


if __name__ == "__main__":
    main()
