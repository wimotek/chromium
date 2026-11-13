import warnings
# 最前置静音 Paramiko / Cryptography 的 TripleDES 废弃警告
from cryptography.utils import CryptographyDeprecationWarning
warnings.filterwarnings("ignore", category=CryptographyDeprecationWarning)
warnings.filterwarnings("ignore", module="paramiko")

import os
import uvicorn
import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from config import DIST_DIR, HUB_HOST, HUB_PORT, SSL_CERT_FILE, SSL_KEY_FILE
from core.database import init_db_and_jwt, get_setting
from core.security import ensure_ssl_certificates
from services.tunnel_manager import tunnel_mgr, tunnel_watchdog_loop
# 核心修复：引入多策略调度器函数 reschedule_all_policies
from services.sync_service import scheduler, reschedule_all_policies

# 引入子模块路由
from routers.auth import router as auth_router
from routers.nodes import router as nodes_router
from routers.sync import router as sync_router
from routers.notify import router as notify_router
from routers.keys import router as keys_router
from routers.cdp_gateway import router as cdp_gateway_router
from routers.api_v1 import router as api_v1_router

# 1. 初始化数据库及默认配置
init_db_and_jwt()

# 2. 现代 Lifespan 上下文生命周期管理
# 修改 app.py 的 lifespan
from services.sync_service import scheduler, reschedule_all_policies, set_main_event_loop

@asynccontextmanager
async def lifespan(app: FastAPI):
    # 核心：将 FastAPI 主事件循环注入同步服务
    set_main_event_loop(asyncio.get_running_loop())
    
    # 启动 APScheduler 定时调度器，并自动加载所有已启用的策略任务
    scheduler.start()
    reschedule_all_policies()
    
    # 启动看门狗后台保活任务
    watchdog_task = asyncio.create_task(tunnel_watchdog_loop())
    yield
    # 优雅停机
    try:
        watchdog_task.cancel()
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

# 3. 创建 FastAPI 实例并挂载路由
app = FastAPI(title="CDP Cluster Hub", lifespan=lifespan)

app.include_router(auth_router)
app.include_router(nodes_router)
app.include_router(sync_router)
app.include_router(notify_router)
app.include_router(keys_router)
app.include_router(cdp_gateway_router)
app.include_router(api_v1_router)

# 4. 静态资源与 SPA 路由托管
if DIST_DIR:
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


# 5. 服务入口
if __name__ == "__main__":
    cert_path, key_path = ensure_ssl_certificates()
    listen_sockets = _create_listen_sockets(HUB_HOST, HUB_PORT)
    uv_config = uvicorn.Config(
        app,
        host=HUB_HOST.strip("[]") or "0.0.0.0",
        port=HUB_PORT,
        ssl_certfile=cert_path,
        ssl_keyfile=key_path,
        proxy_headers=True,
        forwarded_allow_ips="*",
    )
    uvicorn.Server(uv_config).run(sockets=listen_sockets)