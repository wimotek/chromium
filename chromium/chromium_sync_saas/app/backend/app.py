import warnings

from cryptography.utils import CryptographyDeprecationWarning

warnings.filterwarnings("ignore", category=CryptographyDeprecationWarning)

import asyncio
from contextlib import asynccontextmanager
import os
import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from config import DIST_DIR, HUB_HOST, HUB_PORT, HUB_SERVE_FRONTEND, logger
from core.db import init_db_and_jwt
from core.rate_limit import RATE_LIMIT_GLOBAL_PER_MIN, check_rate_limit, get_client_ip, is_loopback_ip
from core.security import ensure_ssl_certificates
from modules.announcements.router import router as announcements_router
from modules.audit.router import router as audit_router
from modules.billing import billing_router, billing_settlement_loop
from modules.market import market_router
from modules.nodes import (
    api_v1_router,
    cdp_gateway_router,
    nodes_router,
    tunnel_mgr,
    tunnel_watchdog_loop,
)
from modules.nodes.traffic_service import flush_traffic_buffers, traffic_flush_loop
from modules.notifications.router import router as notify_router
from modules.sync import reschedule_all_policies, scheduler, set_main_event_loop, sync_router
from modules.system import admin_router, setup_router
from modules.users import level_evaluation_loop, users_router

init_db_and_jwt()


@asynccontextmanager
async def lifespan(app: FastAPI):
    set_main_event_loop(asyncio.get_running_loop())
    scheduler.start()
    reschedule_all_policies()

    watchdog_task = asyncio.create_task(tunnel_watchdog_loop())
    traffic_task = asyncio.create_task(traffic_flush_loop())
    billing_task = asyncio.create_task(billing_settlement_loop())
    level_task = asyncio.create_task(level_evaluation_loop())
    yield
    try:
        watchdog_task.cancel()
        traffic_task.cancel()
        billing_task.cancel()
        level_task.cancel()
        await flush_traffic_buffers()
        scheduler.shutdown(wait=False)
        for s in list(tunnel_mgr.reverse_sessions.values()):
            try:
                s.close()
            except Exception:
                pass
        for t in list(getattr(tunnel_mgr, "public_wss_tasks", {}).values()):
            try:
                t.cancel()
            except Exception:
                pass
    except Exception:
        pass


app = FastAPI(title="Chromium Sync SaaS Hub", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=500)


@app.middleware("http")
async def global_antispam_middleware(request: Request, call_next):
    path = request.url.path or ""
    if path.startswith("/api/") or path.startswith("/cdp/"):
        client_ip = get_client_ip(request)
        if not (path == "/api/auth/status" and is_loopback_ip(client_ip)):
            allowed, _, retry_after = check_rate_limit("global", client_ip, RATE_LIMIT_GLOBAL_PER_MIN, 60)
            if not allowed:
                return JSONResponse(
                    status_code=429,
                    content={"detail": f"全局请求频率过高，请 {retry_after} 秒后再试"},
                    headers={"Retry-After": str(max(1, retry_after))},
                )
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    if path.startswith("/assets/"):
        response.headers.setdefault("Cache-Control", "public, max-age=31536000, immutable")
    elif path.startswith("/api/") or path.startswith("/cdp/"):
        response.headers.setdefault("Cache-Control", "no-store")
    elif request.method == "GET":
        response.headers.setdefault("Cache-Control", "no-cache, must-revalidate")
    return response


app.include_router(users_router)
app.include_router(setup_router)
app.include_router(announcements_router)
app.include_router(nodes_router)
app.include_router(market_router)
app.include_router(billing_router)
app.include_router(admin_router)
app.include_router(audit_router)
app.include_router(sync_router)
app.include_router(notify_router)
app.include_router(cdp_gateway_router)
app.include_router(api_v1_router)

if not HUB_SERVE_FRONTEND:
    logger.info("🧩 [SaaS Backend-Only] HUB_SERVE_FRONTEND=false，仅运行 API/WSS 后端服务（静态资源与 TLS 由 Nginx / 管理面板处理）")

    @app.get("/")
    async def backend_only_root():
        return {"service": "chromium_sync_saas_backend", "mode": "backend_only", "auth": "strict_join_token"}
elif DIST_DIR:
    assets_dir = os.path.join(DIST_DIR, "assets")
    if os.path.exists(assets_dir):
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/")
    async def serve_index():
        return FileResponse(os.path.join(DIST_DIR, "index.html"))

    @app.get("/{full_path:path}")
    async def serve_vue(full_path: str):
        target_file = os.path.join(DIST_DIR, full_path)
        if full_path and os.path.exists(target_file) and os.path.isfile(target_file):
            return FileResponse(target_file)
        return FileResponse(os.path.join(DIST_DIR, "index.html"))
else:
    @app.get("/")
    async def fallback_error():
        return HTMLResponse("<h3>❌ SaaS 前端静态资源尚未构建。</h3>", status_code=500)


def _create_listen_sockets(host: str, port: int):
    import socket

    normalized = (host or "::").strip().strip("[]")
    if normalized not in {"::", "auto", "dual", ""}:
        return None

    if getattr(socket, "has_ipv6", False):
        sock6 = None
        try:
            sock6 = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
            sock6.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock6.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
            sock6.bind(("::", port))
            sock6.listen(2048)
            sock6.set_inheritable(True)
            logger.info(f"🌐 [Dual-Stack] 已启用 IPv4/IPv6 双栈监听 [::]:{port}")
            return [sock6]
        except OSError:
            if sock6 is not None:
                try:
                    sock6.close()
                except OSError:
                    pass
    sock4 = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock4.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock4.bind(("0.0.0.0", port))
    sock4.listen(2048)
    sock4.set_inheritable(True)
    return [sock4]


def run_server():
    import logging

    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)

    enable_access_log = os.getenv("UVICORN_ACCESS_LOG", "false").strip().lower() in {"1", "true", "yes", "on"}
    listen_sockets = _create_listen_sockets(HUB_HOST, HUB_PORT)
    uv_kwargs = dict(
        host=HUB_HOST.strip("[]") or "0.0.0.0",
        port=HUB_PORT,
        proxy_headers=True,
        forwarded_allow_ips="*",
        access_log=enable_access_log,
    )
    if HUB_SERVE_FRONTEND:
        cert_path, key_path = ensure_ssl_certificates()
        uv_kwargs["ssl_certfile"] = cert_path
        uv_kwargs["ssl_keyfile"] = key_path
    else:
        logger.info("🔓 [Backend-Only] HUB_SERVE_FRONTEND=false，已关闭内置 TLS，以内部 HTTP/WS 运行")

    uv_config = uvicorn.Config(app, **uv_kwargs)
    uvicorn.Server(uv_config).run(sockets=listen_sockets)


if __name__ == "__main__":
    run_server()
