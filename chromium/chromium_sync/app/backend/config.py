import os
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("CDP_Sync")

# config.py 直接位于 app/backend/ 下，BASE_DIR 即为后端根目录
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# 前端构建产物候选路径
CANDIDATE_DIST_DIRS = [
    os.path.abspath(os.path.join(BASE_DIR, "../frontend/dist")),
    os.path.abspath(os.path.join(BASE_DIR, "frontend/dist")),
    os.path.abspath(os.path.join(BASE_DIR, "dist")),
    "/app/frontend/dist"
]

DIST_DIR = None
for candidate in CANDIDATE_DIST_DIRS:
    if os.path.exists(candidate) and os.path.exists(os.path.join(candidate, "index.html")):
        DIST_DIR = candidate
        break

# 持久化存储与证书路径
DATA_DIR = "/data"
KEYS_DIR = os.path.join(DATA_DIR, "keys")
DB_PATH = os.path.join(DATA_DIR, "app.db")
CERTS_DIR = "/certs"
SSL_CERT_FILE = os.path.join(CERTS_DIR, "fullchain.pem")
SSL_KEY_FILE = os.path.join(CERTS_DIR, "privkey.pem")

try:
    os.makedirs(KEYS_DIR, exist_ok=True)
except PermissionError as exc:
    logger.error(f"❌ /data/keys 目录不可写 ({exc})！非 root 容器默认以 UID 1000 运行，请在宿主机执行: chown -R 1000:1000 ./data")
    raise

try:
    os.makedirs(CERTS_DIR, exist_ok=True)
except OSError:
    # /certs 可能以只读 (:ro) 挂载，跳过创建并交由 ensure_ssl_certificates() 回退至 /data/certs
    pass

# Hub 服务监听地址与端口 (HUB_HOST 默认 "::" 同时支持 IPv4/IPv6 双栈；未开启 IPv6 时 app.py 会自动回退 0.0.0.0)
# 若使用 Docker 端口映射 (如 -p 3000:8443)，可通过 HUB_EXTERNAL_PORT=3000 指定宿主机对外端口；
# 未设置时也会自动从 HTTP Host / X-Forwarded-Host / X-Forwarded-Port 请求头自动识别。
HUB_HOST = (os.getenv("HUB_HOST") or "::").strip()
_raw_hub_port = (os.getenv("HUB_PORT") or "8443").strip()
try:
    HUB_PORT = int(_raw_hub_port)
    if not (1 <= HUB_PORT <= 65535):
        raise ValueError("port out of range")
except ValueError:
    logger.warning(f"⚠️ 无效的 HUB_PORT='{_raw_hub_port}'，已回退默认端口 8443")
    HUB_PORT = 8443

_raw_ext_port = (os.getenv("HUB_EXTERNAL_PORT") or os.getenv("EXTERNAL_PORT") or "").strip()
HUB_EXTERNAL_PORT = None
if _raw_ext_port:
    try:
        _parsed_ext = int(_raw_ext_port)
        if 1 <= _parsed_ext <= 65535:
            HUB_EXTERNAL_PORT = _parsed_ext
        else:
            logger.warning(f"⚠️ 无效的 HUB_EXTERNAL_PORT='{_raw_ext_port}'，将自动从请求头识别")
    except ValueError:
        logger.warning(f"⚠️ 无效的 HUB_EXTERNAL_PORT='{_raw_ext_port}'，将自动从请求头识别")

HUB_PUBLIC_HOST = (os.getenv("HUB_PUBLIC_HOST") or "").strip()


def _parse_host_header(header_val: str):
    """安全解析 Host / X-Forwarded-Host，兼容 IPv6 [host]:port 与 IPv4/域名:port"""
    raw = (header_val or "").strip()
    if not raw:
        return "", None
    if raw.startswith("["):
        end_idx = raw.find("]")
        if end_idx != -1:
            host_part = raw[: end_idx + 1]
            rest = raw[end_idx + 1 :].strip()
            if rest.startswith(":") and rest[1:].isdigit():
                return host_part, int(rest[1:])
            return host_part, None
    if ":" in raw:
        h, p = raw.rsplit(":", 1)
        if p.isdigit():
            return h, int(p)
    return raw, None


def resolve_hub_access_info(request) -> dict:
    """
    综合容器内部 HUB_PORT、宿主机映射 HUB_EXTERNAL_PORT 与代理/Host 请求头，
    准确解析对外网域 netloc、协议与同机回环端口 (适配如 -p 3000:8443 映射场景)。
    """
    headers = request.headers
    fwd_proto = (headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
    ws_scheme = "ws" if fwd_proto == "http" else "wss"

    fwd_host = (headers.get("x-forwarded-host") or "").split(",")[0].strip()
    raw_host = fwd_host or (headers.get("host") or "").strip()
    parsed_host, parsed_port = _parse_host_header(raw_host)

    fwd_port_raw = (headers.get("x-forwarded-port") or "").split(",")[0].strip()
    fwd_port = int(fwd_port_raw) if fwd_port_raw.isdigit() else None

    client_visible_port = fwd_port or parsed_port
    same_host_port = HUB_EXTERNAL_PORT or client_visible_port or HUB_PORT

    if HUB_PUBLIC_HOST:
        pub_h, pub_p = _parse_host_header(HUB_PUBLIC_HOST)
        target_port = HUB_EXTERNAL_PORT or pub_p or client_visible_port or HUB_PORT
        if (ws_scheme == "wss" and target_port == 443) or (ws_scheme == "ws" and target_port == 80):
            public_netloc = pub_h
        else:
            public_netloc = f"{pub_h}:{target_port}"
    elif parsed_host:
        if fwd_port:
            if (ws_scheme == "wss" and fwd_port == 443) or (ws_scheme == "ws" and fwd_port == 80):
                public_netloc = parsed_host
            else:
                public_netloc = f"{parsed_host}:{fwd_port}"
        elif parsed_port:
            # 若上游反代未改写 Host 端口仍透传容器内部 HUB_PORT，而用户声明了 HUB_EXTERNAL_PORT，则自动修正为对外端口
            if HUB_EXTERNAL_PORT and parsed_port == HUB_PORT and HUB_EXTERNAL_PORT != HUB_PORT:
                public_netloc = f"{parsed_host}:{HUB_EXTERNAL_PORT}"
            else:
                public_netloc = f"{parsed_host}:{parsed_port}"
        else:
            public_netloc = parsed_host
    else:
        fallback_p = HUB_EXTERNAL_PORT or HUB_PORT
        public_netloc = f"localhost:{fallback_p}"

    return {
        "ws_scheme": ws_scheme,
        "public_netloc": public_netloc,
        "same_host_port": same_host_port,
        "internal_port": HUB_PORT,
    }


# 管理员初始凭据 (未设置默认: admin / 123456)
INIT_USERNAME = (os.getenv("ADMIN_INIT_USER") or "admin").strip()
INIT_PASSWORD = (os.getenv("ADMIN_INIT_PASS") or "123456").strip()

logger.info(
    f"🌐 [Hub 服务端口] 内部监听 {HUB_HOST}:{HUB_PORT}"
    + (f" | 声明对外端口 {HUB_EXTERNAL_PORT}" if HUB_EXTERNAL_PORT else " | 对外端口自动跟随 Host/Proxy 请求头")
)
logger.info(f"🔑 [管理员初始凭据] 初始账号: {INIT_USERNAME} | 初始密码: {INIT_PASSWORD}")
logger.info("💡 提示：若此前已在管理控制台修改过密码，则以数据库持久化的最新密码为准。")

# =========================================================================
# 1. 动态加载通用 SSH 隧道引擎 (wimotek-ssh-tunnel)
# =========================================================================
HAS_WIMOTEK_TUNNEL = False
TunnelConfig = None
SshTunnelSession = None
SSHTunnelManager = None
TunnelException = Exception

try:
    from wimotek_ssh_tunnel import (
        TunnelConfig,
        SshTunnelSession,
        SSHTunnelManager,
        TunnelException,
    )
    HAS_WIMOTEK_TUNNEL = True
    logger.info("✅ 成功载入已解耦的通用 SSH 隧道模块 (wimotek-ssh-tunnel v1.0)！")
except ImportError as e:
    logger.warning(f"⚠️ 外部 wimotek-ssh-tunnel 模块未就绪 ({e})，启用备用连接兼容。")

# =========================================================================
# 2. 动态加载多节点会话同步调度引擎 (wimotek-chromium-sync v1.3.0)
# =========================================================================
HAS_CHROMIUM_SYNC = False
ChromiumSync = None
NodeConfig = None
merge_cookies = None
filter_cookies = None
compute_cookie_delta = None

try:
    from wimotek_chromium_sync import (
        ChromiumSync,
        NodeConfig,
        merge_cookies,
        filter_cookies,
        compute_cookie_delta,
    )
    HAS_CHROMIUM_SYNC = True
    logger.info("✅ 成功载入已解耦的 ChromiumSync 同步调度引擎 (wimotek-chromium-sync v1.3)！")
except ImportError:
    try:
        from chromium_sync import ChromiumSync, NodeConfig
        HAS_CHROMIUM_SYNC = True
        logger.info("✅ 成功载入兼容包 chromium_sync！")
    except ImportError as e:
        logger.warning(f"⚠️ 外部 wimotek-chromium-sync 模块未激活 ({e})，启用内置 WebSocket 探测与合并引擎。")