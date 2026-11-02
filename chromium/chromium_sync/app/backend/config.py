import os
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("CDP_Sync")

# config.py 直接在 app/backend/ 下，BASE_DIR 即为后端根目录
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

# ==================== 可选管理员初始凭据 (未设置默认: admin / 123456) ====================
INIT_USERNAME = (os.getenv("ADMIN_INIT_USER") or "admin").strip()
INIT_PASSWORD = (os.getenv("ADMIN_INIT_PASS") or "123456").strip()

# 启动时在日志中清晰打印初始配置信息
logger.info(f"🔑 [管理员初始凭据] 初始账号: {INIT_USERNAME} | 初始密码: {INIT_PASSWORD}")
logger.info("💡 提示：若此前已在管理控制台修改过密码，则以数据库持久化的最新密码为准。")

# 引入已升级的 wimotek-chromium-sync 核心模块
ChromiumSync = None
try:
    from chromium_sync import ChromiumSync
    logger.info("✅ 成功载入已升级的 wimotek-chromium-sync (ChromiumSync) 核心模块！")
except ImportError as e:
    logger.warning(f"⚠️ 外部 ChromiumSync 模块未激活 ({e})，启用内置高并发 WebSocket 探测与合并引擎。")