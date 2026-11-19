import json
import logging
import os

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
DATA_DIR = os.getenv("DATA_DIR", "/data").strip() or "/data"
KEYS_DIR = os.path.join(DATA_DIR, "keys")
DB_PATH = os.path.join(DATA_DIR, "app.db")
CACHE_DB_PATH = os.path.join(DATA_DIR, "cache.db")
BOOTSTRAP_CONFIG_PATH = os.path.join(DATA_DIR, "bootstrap.json")
CERTS_DIR = "/certs"
SSL_CERT_FILE = os.path.join(CERTS_DIR, "fullchain.pem")
SSL_KEY_FILE = os.path.join(CERTS_DIR, "privkey.pem")

# 数据库与缓存配置 (可通过环境变量覆盖，也可由首次安装向导写入 bootstrap.json)
DEFAULT_DB_TYPE = (os.getenv("DB_TYPE") or "sqlite").strip().lower()
DEFAULT_DATABASE_URL = (os.getenv("DATABASE_URL") or "").strip()
DEFAULT_MYSQL_HOST = (os.getenv("MYSQL_HOST") or "127.0.0.1").strip()
DEFAULT_MYSQL_PORT = int((os.getenv("MYSQL_PORT") or "3306").strip() or 3306)
DEFAULT_MYSQL_USER = (os.getenv("MYSQL_USER") or "root").strip()
DEFAULT_MYSQL_PASSWORD = os.getenv("MYSQL_PASSWORD") or ""
DEFAULT_MYSQL_DATABASE = (os.getenv("MYSQL_DATABASE") or "chromium_sync").strip()
DEFAULT_REDIS_URL = (os.getenv("REDIS_URL") or "").strip()
DEFAULT_REDIS_KEY_PREFIX = (os.getenv("REDIS_KEY_PREFIX") or os.getenv("CACHE_KEY_PREFIX") or "csync:").strip()

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
HUB_SERVE_FRONTEND = os.getenv("HUB_SERVE_FRONTEND", "true").strip().lower() not in {"0", "false", "no", "off"}
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


def apply_hub_network_overrides(public_host: str = None, external_port: int = None):
    """从首次安装向导或 bootstrap.json 动态应用对外域名与映射端口（不覆盖显式环境变量）"""
    global HUB_PUBLIC_HOST, HUB_EXTERNAL_PORT
    if public_host is not None and not os.getenv("HUB_PUBLIC_HOST"):
        HUB_PUBLIC_HOST = str(public_host).strip()
    if external_port is not None and not (os.getenv("HUB_EXTERNAL_PORT") or os.getenv("EXTERNAL_PORT")):
        try:
            p = int(external_port)
            HUB_EXTERNAL_PORT = p if 1 <= p <= 65535 else None
        except (TypeError, ValueError):
            pass


def _init_network_from_bootstrap():
    if os.path.exists(BOOTSTRAP_CONFIG_PATH):
        try:
            import json
            with open(BOOTSTRAP_CONFIG_PATH, "r", encoding="utf-8") as f:
                boot = json.load(f)
            if isinstance(boot, dict):
                apply_hub_network_overrides(
                    public_host=boot.get("hub_public_host"),
                    external_port=boot.get("hub_external_port"),
                )
        except Exception:
            pass


_init_network_from_bootstrap()


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
    if fwd_proto not in ("http", "https"):
        cf_visitor = (headers.get("cf-visitor") or "").strip()
        if cf_visitor:
            try:
                parsed_cf = json.loads(cf_visitor)
                if isinstance(parsed_cf, dict):
                    sch = str(parsed_cf.get("scheme") or "").strip().lower()
                    if sch in ("http", "https"):
                        fwd_proto = sch
            except Exception:
                pass
    internal_ws_scheme = "wss" if HUB_SERVE_FRONTEND else "ws"
    if fwd_proto in ("http", "https"):
        ws_scheme = "ws" if fwd_proto == "http" else "wss"
    else:
        ws_scheme = internal_ws_scheme
    http_scheme = "http" if ws_scheme == "ws" else "https"

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
        "http_scheme": http_scheme,
        "internal_ws_scheme": internal_ws_scheme,
        "ssl_enabled": HUB_SERVE_FRONTEND,
        "public_netloc": public_netloc,
        "same_host_port": same_host_port,
        "internal_port": HUB_PORT,
    }


logger.info(
    f"🌐 [Hub 服务端口] 内部监听 {HUB_HOST}:{HUB_PORT}"
    + (f" | 声明对外端口 {HUB_EXTERNAL_PORT}" if HUB_EXTERNAL_PORT else " | 对外端口自动跟随 Host/Proxy 请求头")
)

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