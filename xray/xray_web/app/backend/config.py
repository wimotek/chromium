import json
import os
import threading
import urllib.parse


class Config:
    _config_lock = threading.Lock()
    _loaded_mtime: float = -1.0

    HUB_CONFIG_PATH = os.getenv("HUB_CONFIG_PATH", "/data/hub_config.json")

    SECRET_KEY = os.getenv("SECRET_KEY", "xray_secure_key_default")
    DB_PATH = os.getenv("DB_PATH", "/data/xray_web.db")

    # 双库配置：支持 DATABASE_URL 或 DB_TYPE=sqlite|mysql + MYSQL_*
    DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
    DB_TYPE = os.getenv("DB_TYPE", "").strip().lower()
    MYSQL_HOST = os.getenv("MYSQL_HOST", "").strip()
    MYSQL_PORT = int(os.getenv("MYSQL_PORT", "3306") or 3306)
    MYSQL_USER = os.getenv("MYSQL_USER", "").strip()
    MYSQL_PASSWORD = os.getenv("MYSQL_PASSWORD", "")
    MYSQL_DATABASE = os.getenv("MYSQL_DATABASE", "xray_web").strip()

    # Web 端口与代理端口彻底解耦 (容器内部默认 8443，支持 -e WEB_PORT=xxx 更改)
    WEB_PORT = int(os.getenv("WEB_PORT", 8443))
    PORT = WEB_PORT
    # 对外暴露端口/入口 URL（当使用 -p 3000:8443 端口映射或反向代理时自动识别，也可显式指定）
    PUBLIC_PORT = int(os.getenv("PUBLIC_PORT", "0") or 0)
    PUBLIC_URL = os.getenv("PUBLIC_URL", "").strip().rstrip("/")
    # 单参数开启前后端分离（设为 true 时：后端不托管静态资源、不加载 TLS 证书、仅监听纯 HTTP，前端静态资产与 HTTPS 证书全部交由 Nginx 负责）
    SEPARATE_FRONTEND = os.getenv("SEPARATE_FRONTEND", "false").strip().lower() in ("true", "1", "yes")
    # 原生 HTTPS TLS 开关（前后端分离开启时自动关闭后端内置 TLS）
    SSL_ENABLE = (
        False
        if SEPARATE_FRONTEND
        else os.getenv("SSL_ENABLE", "true").strip().lower() in ("true", "1", "yes")
    )

    APP_MODE = os.getenv("APP_MODE", "all")

    # 高并发调优与代理信任配置（SQLAlchemy 连接池、可信代理与防刷开关）
    DB_POOL_SIZE = int(os.getenv("DB_POOL_SIZE", "20") or 20)
    DB_MAX_OVERFLOW = int(os.getenv("DB_MAX_OVERFLOW", "30") or 30)
    DB_POOL_TIMEOUT = int(os.getenv("DB_POOL_TIMEOUT", "30") or 30)
    RATE_LIMIT_ENABLE = os.getenv("RATE_LIMIT_ENABLE", "true").strip().lower() in ("true", "1", "yes")
    # 代理头信任策略：auto(默认仅信任本机/内网回环Nginx等代理，防止公网直连伪造X-Forwarded-For绕过限流) | always | never
    TRUST_PROXY = os.getenv("TRUST_PROXY", "auto").strip().lower()
    RATE_LIMIT_WHITELIST = [
        ip.strip() for ip in os.getenv("RATE_LIMIT_WHITELIST", "").split(",") if ip.strip()
    ]

    # Xray 节点监听端口
    SERVER_PORT = os.getenv("PORT", "443")
    SERVER_HOST = os.getenv("SERVER_HOST", "127.0.0.1")
    SNI = os.getenv("DEST", "www.microsoft.com").split(":")[0]
    SHORT_ID = os.getenv("SHORT_ID", "123456")
    XRAY_API_SERVER = os.getenv("XRAY_API_SERVER", "127.0.0.1:10085")

    # 方案 C：第三方发卡网 API 鉴权 Token
    FAKA_API_TOKEN = os.getenv("FAKA_API_TOKEN", "faka_secret_token_8899")

    # 可选 Redis 加速配置（未配置或连接失败时自动透明回退至 SQL kv_cache）
    REDIS_URL = os.getenv("REDIS_URL", "").strip()
    REDIS_HOST = os.getenv("REDIS_HOST", "").strip()
    REDIS_PORT = int(os.getenv("REDIS_PORT", "6379") or 6379)
    REDIS_PASSWORD = os.getenv("REDIS_PASSWORD", "").strip()
    REDIS_DB = int(os.getenv("REDIS_DB", "0") or 0)
    REDIS_KEY_PREFIX = os.getenv("REDIS_KEY_PREFIX", "xray_hub:").strip()
    REDIS_TIMEOUT = float(os.getenv("REDIS_TIMEOUT", "1.5") or 1.5)
    REDIS_COOLDOWN_SECONDS = int(os.getenv("REDIS_COOLDOWN_SECONDS", "30") or 30)

    SETUP_COMPLETED = False

    @classmethod
    def _apply_hub_config_dict(cls, data: dict):
        if not isinstance(data, dict):
            return
        if "setup_completed" in data:
            cls.SETUP_COMPLETED = bool(data["setup_completed"])
        if data.get("database_url"):
            cls.DATABASE_URL = str(data["database_url"]).strip()
        if data.get("db_type"):
            cls.DB_TYPE = str(data["db_type"]).strip().lower()
        if data.get("db_path"):
            cls.DB_PATH = str(data["db_path"]).strip()
        if "mysql_host" in data:
            cls.MYSQL_HOST = str(data.get("mysql_host") or "").strip()
        if "mysql_port" in data and data["mysql_port"]:
            cls.MYSQL_PORT = int(data["mysql_port"])
        if "mysql_user" in data:
            cls.MYSQL_USER = str(data.get("mysql_user") or "").strip()
        if "mysql_password" in data:
            cls.MYSQL_PASSWORD = str(data.get("mysql_password") or "")
        if "mysql_database" in data and data["mysql_database"]:
            cls.MYSQL_DATABASE = str(data["mysql_database"]).strip()

        if "redis_url" in data:
            cls.REDIS_URL = str(data.get("redis_url") or "").strip()
        if "redis_host" in data:
            cls.REDIS_HOST = str(data.get("redis_host") or "").strip()
        if "redis_port" in data and data["redis_port"]:
            cls.REDIS_PORT = int(data["redis_port"])
        if "redis_password" in data:
            cls.REDIS_PASSWORD = str(data.get("redis_password") or "").strip()
        if "redis_db" in data and data["redis_db"] is not None:
            cls.REDIS_DB = int(data["redis_db"])

        if "public_url" in data:
            cls.PUBLIC_URL = str(data.get("public_url") or "").strip().rstrip("/")
        if "public_port" in data and data["public_port"] is not None:
            cls.PUBLIC_PORT = int(data["public_port"] or 0)
        if data.get("app_mode") in ("all", "user", "admin"):
            cls.APP_MODE = str(data["app_mode"])

    @classmethod
    def reload_if_changed(cls, force: bool = False) -> bool:
        """检查 /data/hub_config.json 是否更新（支持多 Worker 进程间热同步安装向导配置）"""
        path = os.getenv("HUB_CONFIG_PATH", cls.HUB_CONFIG_PATH)
        cls.HUB_CONFIG_PATH = path
        if not path or not os.path.exists(path):
            return False
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            return False

        if not force and mtime == cls._loaded_mtime:
            return False

        with cls._config_lock:
            if not force and mtime == cls._loaded_mtime:
                return False
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                cls._apply_hub_config_dict(data)
                cls._loaded_mtime = mtime
                return True
            except Exception as e:
                print(f"[Config] 读取 {path} 失败: {e}", flush=True)
                return False

    @classmethod
    def save_hub_config(cls, data: dict):
        path = os.getenv("HUB_CONFIG_PATH", cls.HUB_CONFIG_PATH)
        cls.HUB_CONFIG_PATH = path
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        existing = {}
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    existing = json.load(f) or {}
            except Exception:
                existing = {}
        existing.update(data)
        tmp_path = f"{path}.tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(existing, f, indent=2, ensure_ascii=False)
        try:
            os.chmod(tmp_path, 0o600)
        except Exception:
            pass
        os.replace(tmp_path, path)
        cls.reload_if_changed(force=True)

    @classmethod
    def build_mysql_url(
        cls,
        host: str,
        port: int,
        user: str,
        password: str,
        database: str,
    ) -> str:
        u = urllib.parse.quote_plus(user or "")
        p = urllib.parse.quote_plus(password or "")
        auth = f"{u}:{p}@" if password else (f"{u}@" if u else "")
        db_name = urllib.parse.quote(database or "xray_web")
        return f"mysql+pymysql://{auth}{host}:{int(port or 3306)}/{db_name}?charset=utf8mb4"

    @classmethod
    def effective_database_url(cls) -> str:
        cls.reload_if_changed()
        if cls.DATABASE_URL:
            url = cls.DATABASE_URL
            if url.startswith("mysql://"):
                url = "mysql+pymysql://" + url[len("mysql://"):]
            return url
        if cls.DB_TYPE == "mysql" or cls.MYSQL_HOST:
            return cls.build_mysql_url(
                cls.MYSQL_HOST or "127.0.0.1",
                cls.MYSQL_PORT or 3306,
                cls.MYSQL_USER or "root",
                cls.MYSQL_PASSWORD,
                cls.MYSQL_DATABASE or "xray_web",
            )
        db_path = os.path.abspath(cls.DB_PATH)
        return f"sqlite:///{db_path}"

    @classmethod
    def db_dialect(cls) -> str:
        url = cls.effective_database_url().lower()
        if url.startswith("mysql"):
            return "mysql"
        return "sqlite"

    @classmethod
    def effective_redis_url(cls) -> str:
        cls.reload_if_changed()
        if cls.REDIS_URL:
            return cls.REDIS_URL
        if cls.REDIS_HOST:
            pw = urllib.parse.quote_plus(cls.REDIS_PASSWORD) if cls.REDIS_PASSWORD else ""
            auth = f":{pw}@" if pw else ""
            return f"redis://{auth}{cls.REDIS_HOST}:{cls.REDIS_PORT}/{cls.REDIS_DB}"
        return ""


Config.reload_if_changed(force=True)