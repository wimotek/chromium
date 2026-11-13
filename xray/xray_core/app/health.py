# -*- coding: utf-8 -*-
"""
Loopback-only /healthz Endpoint & Docker HEALTHCHECK Probe for Edge Core
安全设计原则：
1. 严格仅绑定回环地址 127.0.0.1:${HEALTH_PORT:-10087}，绝不监听公网网卡，
   即使在 --network=host 模式下也不会对外暴露任何多余 HTTP 端口，保障 REALITY 隐身抗探测。
2. 实时检查 Xray 主进程存活与本地业务端口监听状态，供 Docker HEALTHCHECK 使用。
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


def _check_tcp_local(port: int, timeout: float = 1.5) -> bool:
    """探测本机监听端口是否可达（兼容 127.0.0.1 与 ::1）"""
    for family, host in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
        try:
            with socket.socket(family, socket.SOCK_STREAM) as s:
                s.settimeout(timeout)
                if s.connect_ex((host, port)) == 0:
                    return True
        except Exception:
            continue
    return False


def evaluate_health(app_ref) -> tuple[bool, dict]:
    """评估 Edge Core 当前运行健康度"""
    xray_mgr = getattr(app_ref, "xray_mgr", None)
    proc = getattr(xray_mgr, "proc", None) if xray_mgr else None
    xray_alive = bool(proc is not None and proc.poll() is None)

    net_mode = getattr(app_ref, "net_mode", "direct")
    target_port = AppConfig.LOCAL_BRIDGE_PORT if net_mode == "reverse_wss" else AppConfig.PORT
    port_ready = _check_tcp_local(target_port) if xray_alive else False

    healthy = xray_alive and port_ready
    payload = {
        "status": "ok" if healthy else "unhealthy",
        "xray_alive": xray_alive,
        "xray_pid": proc.pid if xray_alive and proc else None,
        "net_mode": net_mode,
        "listen_port": target_port,
        "port_ready": port_ready,
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
    """Docker HEALTHCHECK 探针入口：优先请求 /healthz，若禁用/冲突则回退检测 Xray 本地端口"""
    health_port = int(os.environ.get("HEALTH_PORT", str(AppConfig.HEALTH_PORT)))
    if health_port > 0:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{health_port}/healthz", timeout=3.0) as resp:
                return 0 if resp.status == 200 else 1
        except Exception:
            pass

    # 若 HEALTH_PORT=0 或端口占用回退：直接检查 Xray 配置文件中的实际业务端口
    target_port = AppConfig.PORT
    try:
        if os.path.exists(AppConfig.CONFIG_FILE):
            with open(AppConfig.CONFIG_FILE, "r", encoding="utf-8") as f:
                cfg = json.load(f)
                for ib in cfg.get("inbounds", []):
                    if ib.get("tag") in ("vless-direct", "vless-bridge") and ib.get("port"):
                        target_port = int(ib["port"])
                        break
    except Exception:
        pass

    return 0 if _check_tcp_local(target_port, timeout=2.0) else 1


if __name__ == "__main__":
    sys.exit(run_cli_probe())
