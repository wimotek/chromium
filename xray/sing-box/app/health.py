# -*- coding: utf-8 -*-
"""
Loopback-only /healthz Endpoint & Docker HEALTHCHECK Probe for Sing-box Edge Core
安全设计原则：
1. 严格仅绑定回环地址 127.0.0.1:${HEALTH_PORT:-10087}，绝不监听公网网卡，
   即使在 --network=host 模式下也不会对外暴露任何多余 HTTP 端口。
2. 实时检查 Sing-box 主进程存活、VLESS TCP 端口、Hysteria2 UDP 端口、v2ray_api 统计端口及反穿隧道状态。
"""
import http.server
import json
import os
import socket
import sys
import threading
import urllib.request
from typing import Optional

from .config import AppConfig


def _check_tcp_listening_proc(port: int) -> Optional[bool]:
    """通过 Linux /proc/net/tcp(6) 零发包检查本机是否处于 TCP LISTEN (0A) 状态，避免触发 REALITY invalid connection 刷屏日志"""
    if not port or port <= 0:
        return False
    hex_port = f":{int(port):04X}"
    readable_any = False
    for proc_path in ("/proc/net/tcp6", "/proc/net/tcp"):
        try:
            with open(proc_path, "r", encoding="utf-8") as f:
                readable_any = True
                next(f, None)  # skip header
                for line in f:
                    parts = line.split()
                    if len(parts) >= 4 and parts[3].upper() == "0A" and parts[1].upper().endswith(hex_port):
                        return True
        except Exception:
            continue
    return False if readable_any else None


def _check_tcp_local(port: int, timeout: float = 1.5) -> bool:
    """探测本机 TCP 监听端口是否就绪（优先 /proc/net/tcp(6) 零发包检测，非 Linux 回退 connect_ex）"""
    proc_res = _check_tcp_listening_proc(port)
    if proc_res is not None:
        return proc_res
    for family, host in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
        try:
            with socket.socket(family, socket.SOCK_STREAM) as s:
                s.settimeout(timeout)
                if s.connect_ex((host, port)) == 0:
                    return True
        except Exception:
            continue
    return False


def _check_udp_listening(port: int) -> bool:
    """通过 Linux /proc/net/udp(6) 零发包检查本机是否正在监听目标 UDP 端口"""
    if not port or port <= 0:
        return False
    hex_port = f":{int(port):04X}"
    for proc_path in ("/proc/net/udp6", "/proc/net/udp"):
        try:
            with open(proc_path, "r", encoding="utf-8") as f:
                next(f, None)  # skip header
                for line in f:
                    parts = line.split()
                    if len(parts) >= 2 and parts[1].upper().endswith(hex_port):
                        return True
        except Exception:
            continue
    return False


def evaluate_health(app_ref) -> tuple[bool, dict]:
    """评估 Sing-box Edge Core 当前运行健康度（兼容 Hub 端 xray_alive 协议字段）"""
    sb_mgr = getattr(app_ref, "sb_mgr", None)
    proc = getattr(sb_mgr, "proc", None) if sb_mgr else None
    core_alive = bool(proc is not None and proc.poll() is None)

    net_mode = getattr(app_ref, "net_mode", "direct")
    target_port = AppConfig.LOCAL_BRIDGE_PORT if net_mode == "reverse_wss" else AppConfig.PORT
    port_ready = _check_tcp_local(target_port) if core_alive else False

    is_standalone = not bool(AppConfig.PANEL_URL)
    stats_ready = True if is_standalone else (_check_tcp_local(AppConfig.STATS_PORT) if core_alive else False)

    hy2_active = (net_mode == "direct" and bool(AppConfig.HY2_ENABLED) and int(AppConfig.HY2_PORT or 0) > 0)
    hy2_ready = _check_udp_listening(AppConfig.HY2_PORT) if (core_alive and hy2_active) else None

    tunnel_sup = getattr(app_ref, "tunnel_supervisor", None)
    tunnel_connected = bool(tunnel_sup and getattr(tunnel_sup, "is_connected", False)) if net_mode == "reverse_wss" else None

    healthy = core_alive and port_ready and stats_ready
    if hy2_active and hy2_ready is False:
        healthy = False
    if net_mode == "reverse_wss" and tunnel_sup is not None:
        healthy = healthy and bool(tunnel_connected)

    payload = {
        "status": "ok" if healthy else "unhealthy",
        "healthy": healthy,
        "core_type": AppConfig.CORE_TYPE,
        "core_alive": core_alive,
        # 保留 xray_alive 兼容键名，确保与 Hub 联合测活逻辑 100% 无缝对接
        "xray_alive": core_alive,
        "core_pid": proc.pid if core_alive and proc else None,
        "net_mode": net_mode,
        "listen_port": target_port,
        "port_ready": port_ready,
        "hy2_ready": hy2_ready,
        "hy2_port": AppConfig.HY2_PORT if hy2_active else None,
        "stats_ready": stats_ready,
        "tunnel_connected": tunnel_connected,
    }
    return healthy, payload


def start_health_server(app_ref) -> Optional[http.server.ThreadingHTTPServer]:
    """在后台守护线程启动纯回环 127.0.0.1 /healthz 服务"""
    health_port = AppConfig.HEALTH_PORT
    if health_port <= 0:
        return None

    class _HealthHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path.split("?", 1)[0] != "/healthz":
                self.send_response(404)
                self.end_headers()
                return
            healthy, payload = evaluate_health(app_ref)
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(200 if healthy else 503)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format, *args):
            return

    try:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", health_port), _HealthHandler)
        t = threading.Thread(target=server.serve_forever, name="EdgeHealthServer", daemon=True)
        t.start()
        print(f"[Healthz] 🩺 本地健康检查点已就绪: http://127.0.0.1:{health_port}/healthz (仅回环可见)", flush=True)
        return server
    except OSError as e:
        print(f"[Healthz] ⚠️ 本地端口 127.0.0.1:{health_port} 不可用 ({e})，将改用直接端口探活", flush=True)
        return None


def run_cli_probe() -> int:
    """Docker HEALTHCHECK 探针入口：优先请求 /healthz，若禁用/冲突则回退检测本地业务端口"""
    health_port = int(os.environ.get("HEALTH_PORT", str(AppConfig.HEALTH_PORT)))
    if health_port > 0:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{health_port}/healthz", timeout=3.0) as resp:
                return 0 if resp.status == 200 else 1
        except Exception:
            pass

    target_port = AppConfig.PORT
    try:
        if os.path.exists(AppConfig.CONFIG_FILE):
            with open(AppConfig.CONFIG_FILE, "r", encoding="utf-8") as f:
                cfg = json.load(f)
                for ib in cfg.get("inbounds", []):
                    if ib.get("tag") in ("vless-direct", "vless-bridge") and ib.get("listen_port"):
                        target_port = int(ib["listen_port"])
                        break
    except Exception:
        pass

    return 0 if _check_tcp_local(target_port, timeout=2.0) else 1


if __name__ == "__main__":
    sys.exit(run_cli_probe())
