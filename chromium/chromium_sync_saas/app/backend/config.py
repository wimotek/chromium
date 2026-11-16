import json
import logging
import os

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("CDP_Sync_SaaS")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

CANDIDATE_DIST_DIRS = [
    os.path.abspath(os.path.join(BASE_DIR, "../frontend/dist")),
    os.path.abspath(os.path.join(BASE_DIR, "frontend/dist")),
    os.path.abspath(os.path.join(BASE_DIR, "dist")),
    "/app/frontend/dist",
]

DIST_DIR = None
for candidate in CANDIDATE_DIST_DIRS:
    if os.path.exists(candidate) and os.path.exists(os.path.join(candidate, "index.html")):
        DIST_DIR = candidate
        break

DATA_DIR = os.getenv("DATA_DIR", "/data").strip() or "/data"
KEYS_DIR = os.path.join(DATA_DIR, "keys")
DB_PATH = os.path.join(DATA_DIR, "app.db")
CACHE_DB_PATH = os.path.join(DATA_DIR, "cache.db")
BOOTSTRAP_CONFIG_PATH = os.path.join(DATA_DIR, "bootstrap.json")
CERTS_DIR = "/certs"
SSL_CERT_FILE = os.path.join(CERTS_DIR, "fullchain.pem")
SSL_KEY_FILE = os.path.join(CERTS_DIR, "privkey.pem")

SKIP_SETUP_WIZARD = os.getenv("SKIP_SETUP_WIZARD", "false").strip().lower() in {"1", "true", "yes", "on"}
DEFAULT_DB_TYPE = (os.getenv("DB_TYPE") or "sqlite").strip().lower()
DEFAULT_DATABASE_URL = (os.getenv("DATABASE_URL") or "").strip()
DEFAULT_MYSQL_HOST = (os.getenv("MYSQL_HOST") or "127.0.0.1").strip()
DEFAULT_MYSQL_PORT = int((os.getenv("MYSQL_PORT") or "3306").strip() or 3306)
DEFAULT_MYSQL_USER = (os.getenv("MYSQL_USER") or "root").strip()
DEFAULT_MYSQL_PASSWORD = os.getenv("MYSQL_PASSWORD") or ""
DEFAULT_MYSQL_DATABASE = (os.getenv("MYSQL_DATABASE") or "chromium_sync_saas").strip()
DEFAULT_REDIS_URL = (os.getenv("REDIS_URL") or "").strip()

# SaaS 多租户运营与抽成默认参数
SAAS_ALLOW_PUBLIC_REGISTER = os.getenv("SAAS_ALLOW_PUBLIC_REGISTER", "true").strip().lower() not in {"0", "false", "no", "off"}
SAAS_ALLOW_SELF_RECHARGE = os.getenv("SAAS_ALLOW_SELF_RECHARGE", "true").strip().lower() not in {"0", "false", "no", "off"}
try:
    SAAS_DEFAULT_PLATFORM_FEE_BPS = max(0, min(10000, int((os.getenv("SAAS_PLATFORM_FEE_BPS") or "2000").strip() or 2000)))
except ValueError:
    SAAS_DEFAULT_PLATFORM_FEE_BPS = 2000

try:
    SAAS_WELCOME_BONUS_UNITS = max(0, int((os.getenv("SAAS_WELCOME_BONUS_UNITS") or "50000").strip() or 50000))
except ValueError:
    SAAS_WELCOME_BONUS_UNITS = 50000

try:
    os.makedirs(KEYS_DIR, exist_ok=True)
except PermissionError as exc:
    logger.error(f"❌ /data/keys 目录不可写 ({exc})！非 root 容器默认以 UID 1000 运行，请在宿主机执行: chown -R 1000:1000 ./data")
    raise

try:
    os.makedirs(CERTS_DIR, exist_ok=True)
except OSError:
    pass

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
    except ValueError:
        pass

HUB_PUBLIC_HOST = (os.getenv("HUB_PUBLIC_HOST") or "").strip()


def apply_hub_network_overrides(public_host: str = None, external_port: int = None):
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
    headers = request.headers
    fwd_proto = (headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
    internal_ws_scheme = "wss" if HUB_SERVE_FRONTEND else "ws"
    if fwd_proto in ("http", "https"):
        ws_scheme = "ws" if fwd_proto == "http" else "wss"
    else:
        ws_scheme = internal_ws_scheme

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
        "http_scheme": "https" if ws_scheme == "wss" else "http",
        "ws_scheme": ws_scheme,
        "internal_ws_scheme": internal_ws_scheme,
        "ssl_enabled": HUB_SERVE_FRONTEND,
        "public_netloc": public_netloc,
        "same_host_port": same_host_port,
        "internal_port": HUB_PORT,
    }


INIT_USERNAME = (os.getenv("ADMIN_INIT_USER") or "admin").strip()
INIT_PASSWORD = (os.getenv("ADMIN_INIT_PASS") or "123456").strip()

logger.info(
    f"🌐 [SaaS Hub 服务端口] 内部监听 {HUB_HOST}:{HUB_PORT}"
    + (f" | 对外端口 {HUB_EXTERNAL_PORT}" if HUB_EXTERNAL_PORT else " | 对外端口跟随 Proxy/Host")
)

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
except ImportError:
    pass

HAS_CHROMIUM_SYNC = False
ChromiumSync = None
NodeConfig = None

try:
    from wimotek_chromium_sync import ChromiumSync, NodeConfig
    HAS_CHROMIUM_SYNC = True
except ImportError:
    try:
        from chromium_sync import ChromiumSync, NodeConfig
        HAS_CHROMIUM_SYNC = True
    except ImportError:
        pass
