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

os.makedirs(KEYS_DIR, exist_ok=True)
os.makedirs(CERTS_DIR, exist_ok=True)

# 管理员初始凭据 (未设置默认: admin / 123456)
INIT_USERNAME = (os.getenv("ADMIN_INIT_USER") or "admin").strip()
INIT_PASSWORD = (os.getenv("ADMIN_INIT_PASS") or "123456").strip()

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