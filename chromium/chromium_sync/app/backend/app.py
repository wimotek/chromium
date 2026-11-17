import warnings
# 最前置静音 Paramiko / Cryptography 的 TripleDES 废弃警告
from cryptography.utils import CryptographyDeprecationWarning
warnings.filterwarnings("ignore", category=CryptographyDeprecationWarning)
warnings.filterwarnings("ignore", module="paramiko")

import os
import uvicorn
import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from config import DIST_DIR, HUB_HOST, HUB_PORT, HUB_SERVE_FRONTEND, SSL_CERT_FILE, SSL_KEY_FILE, logger
from core.db import init_db_and_jwt, get_setting
from core.rate_limit import RATE_LIMIT_GLOBAL_PER_MIN, check_rate_limit, get_client_ip, is_loopback_ip
from core.security import ensure_ssl_certificates
from services.tunnel_manager import tunnel_mgr, tunnel_watchdog_loop
from services.traffic_service import flush_traffic_buffers, traffic_flush_loop
# 核心修复：引入多策略调度器函数 reschedule_all_policies
from services.sync_service import scheduler, reschedule_all_policies, set_main_event_loop

# 引入子模块路由
from routers.auth import router as auth_router
from routers.nodes import router as nodes_router
from routers.sync import router as sync_router
from routers.notify import router as notify_router
from routers.keys import router as keys_router
from routers.cdp_gateway import router as cdp_gateway_router
from routers.api_v1 import router as api_v1_router
from routers.setup import router as setup_router

# 1. 初始化数据库及默认配置
init_db_and_jwt()


# 2. 现代 Lifespan 上下文生命周期管理
@asynccontextmanager
async def lifespan(app: FastAPI):
    # 核心：将 FastAPI 主事件循环注入同步服务
    set_main_event_loop(asyncio.get_running_loop())

    # 启动 APScheduler 定时调度器，并自动加载所有已启用的策略任务
    scheduler.start()
    reschedule_all_policies()

    # 启动看门狗后台保活任务与流量统计定时落盘协程
    watchdog_task = asyncio.create_task(tunnel_watchdog_loop())
    traffic_task = asyncio.create_task(traffic_flush_loop())
    yield
    # 优雅停机
    try:
        watchdog_task.cancel()
        traffic_task.cancel()
        await flush_traffic_buffers()
        scheduler.shutdown(wait=False)
        for t in list(tunnel_mgr.tunnels.values()):
            try:
                t.stop()
            except Exception:
                pass
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


# 3. 创建 FastAPI 实例并挂载全局防刷、GZip 压缩与 Cloudflare 缓存策略中间件
app = FastAPI(title="CDP Cluster Hub", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=500)


@app.middleware("http")
async def global_antispam_middleware(request: Request, call_next):
    path = request.url.path or ""
    if path.startswith("/api/") or path.startswith("/cdp/"):
        client_ip = get_client_ip(request)
        if not (path == "/api/auth/status" and is_loopback_ip(client_ip)):
            allowed, _, retry_after = check_rate_limit(
                "global",
                client_ip,
                RATE_LIMIT_GLOBAL_PER_MIN,
                60,
            )
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


app.include_router(auth_router)
app.include_router(setup_router)
app.include_router(nodes_router)
app.include_router(sync_router)
app.include_router(notify_router)
app.include_router(keys_router)
app.include_router(cdp_gateway_router)
app.include_router(api_v1_router)

# 4. 静态资源与 SPA 路由托管（分离部署时设 HUB_SERVE_FRONTEND=false，仅运行纯后端 API/WSS）
if not HUB_SERVE_FRONTEND:
    logger.info("🧩 [Backend-Only] HUB_SERVE_FRONTEND=false，后端不托管前端静态资源（前端与 TLS 由 Nginx / 管理面板提供）")

    @app.get("/")
    async def backend_only_root():
        return {"service": "chromium_sync_backend", "mode": "backend_only", "ssl_enabled": False}
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
        return HTMLResponse("<h3>❌ 前端静态资源尚未生成，请检查前端打包。</h3>", status_code=500)

def _create_listen_sockets(host: str, port: int):
    """
    当 HUB_HOST 为 '::' / 'auto' / 'dual' 时，优先创建 IPV6_V6ONLY=0 的双栈 Socket
    同时承载 IPv4 与 IPv6；若系统内核禁用了双栈或容器未启用 IPv6，则自动降级为
    双独立 Socket 或回退 0.0.0.0，确保在纯 IPv4 宿主机下也能正常启动。
    """
    import socket
    from config import logger

    normalized = (host or "::").strip().strip("[]")
    if normalized not in {"::", "auto", "dual", ""}:
        return None

    # 1. 尝试单 Socket IPv4/IPv6 双栈 (IPV6_V6ONLY=0)
    if getattr(socket, "has_ipv6", False):
        sock6 = None
        try:
            sock6 = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
            sock6.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock6.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
            sock6.bind(("::", port))
            sock6.listen(2048)
            sock6.set_inheritable(True)
            logger.info(f"🌐 [Dual-Stack] 已启用 IPv4/IPv6 双栈监听 [::]:{port} (IPV6_V6ONLY=0)")
            return [sock6]
        except OSError as dual_err:
            if sock6 is not None:
                try:
                    sock6.close()
                except OSError:
                    pass
            # 2. 若内核不允许 IPV6_V6ONLY=0，尝试分别绑定 IPv4(0.0.0.0) + IPv6(::)
            sockets = []
            try:
                s4 = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s4.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s4.bind(("0.0.0.0", port))
                s4.listen(2048)
                s4.set_inheritable(True)
                sockets.append(s4)

                s6 = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
                s6.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s6.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
                s6.bind(("::", port))
                s6.listen(2048)
                s6.set_inheritable(True)
                sockets.append(s6)
                logger.info(f"🌐 [Dual-Stack] 已启用独立双栈监听 0.0.0.0:{port} + [::]:{port}")
                return sockets
            except OSError:
                for s in sockets:
                    try:
                        s.close()
                    except OSError:
                        pass
                logger.warning(f"⚠️ 当前运行环境未启用 IPv6 ({dual_err})，自动回退监听 0.0.0.0:{port} (仅 IPv4)")

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
        logger.info("🔓 [Backend-Only] HUB_SERVE_FRONTEND=false，已关闭内置 TLS，以内部明文 HTTP/WS 运行（前端与 HTTPS 由 Nginx / 管理面板处理）")

    uv_config = uvicorn.Config(app, **uv_kwargs)
    uvicorn.Server(uv_config).run(sockets=listen_sockets)


# 5. 服务入口
if __name__ == "__main__":
    run_server()