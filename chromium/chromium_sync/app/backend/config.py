import os
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("CDP_Sync")

# config.py 直接在 app/backend/ 下，BASE_DIR 即为后端根目录
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# 前端构建产物候选路径（直截了当，无需 .. 退级）
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

# 持久化存储与安全路径
DATA_DIR = "/data"
KEYS_DIR = os.path.join(DATA_DIR, "keys")
DB_PATH = os.path.join(DATA_DIR, "app.db")
CERTS_DIR = "/certs"
SSL_CERT_FILE = os.path.join(CERTS_DIR, "fullchain.pem")
SSL_KEY_FILE = os.path.join(CERTS_DIR, "privkey.pem")

os.makedirs(KEYS_DIR, exist_ok=True)
os.makedirs(CERTS_DIR, exist_ok=True)

INIT_PASSWORD = os.getenv("ADMIN_INIT_PASS", "Admin@123456")

# 引入已升级的 wimotek-chromium-sync 核心模块
ChromiumSync = None
try:
    from chromium_sync import ChromiumSync
    logger.info("✅ 成功载入已升级的 wimotek-chromium-sync (ChromiumSync) 核心模块！")
except ImportError as e:
    logger.warning(f"⚠️ 外部 ChromiumSync 模块未激活 ({e})，启用内置高并发 WebSocket 探测与合并引擎。")