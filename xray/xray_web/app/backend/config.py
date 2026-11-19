import json
import os
import re
import threading
import time
import urllib.parse


_UNSAFE_USERINFO_RE = re.compile(r"[@#/?:\[\]\s]|%(?![0-9A-Fa-f]{2})")


def _normalize_redis_key_prefix(raw_prefix: str) -> str:
    """统一规范化 Redis 键命名空间前缀，确保非空且以单个冒号 ':' 结尾"""
    clean = str(raw_prefix or "").strip().rstrip(":")
    if not clean:
        return "xray_hub:"
    return f"{clean}:"


class Config:
    _config_lock = threading.Lock()
    _loaded_mtime: float = -1.0
    _last_stat_check: float = 0.0
    _STAT_CHECK_INTERVAL: float = 1.0

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
    _ENV_REDIS_URL = os.getenv("REDIS_URL", "").strip()
    _ENV_REDIS_HOST = os.getenv("REDIS_HOST", "").strip()
    _ENV_REDIS_PORT = int(os.getenv("REDIS_PORT", "6379") or 6379)
    _ENV_REDIS_PASSWORD = os.getenv("REDIS_PASSWORD", "").strip()
    _ENV_REDIS_DB = int(os.getenv("REDIS_DB", "0") or 0)
    _ENV_REDIS_KEY_PREFIX = _normalize_redis_key_prefix(os.getenv("REDIS_KEY_PREFIX", "xray_hub:"))
    _ENV_REDIS_TIMEOUT = float(os.getenv("REDIS_TIMEOUT", "1.5") or 1.5)
    _ENV_REDIS_COOLDOWN_SECONDS = int(os.getenv("REDIS_COOLDOWN_SECONDS", "30") or 30)

    REDIS_URL = _ENV_REDIS_URL
    REDIS_HOST = _ENV_REDIS_HOST
    REDIS_PORT = _ENV_REDIS_PORT
    REDIS_PASSWORD = _ENV_REDIS_PASSWORD
    REDIS_DB = _ENV_REDIS_DB
    REDIS_KEY_PREFIX = _ENV_REDIS_KEY_PREFIX
    REDIS_TIMEOUT = _ENV_REDIS_TIMEOUT
    REDIS_COOLDOWN_SECONDS = _ENV_REDIS_COOLDOWN_SECONDS
    # 缓存模式：""(自动判定) | "redis" | "sql_cache"
    CACHE_MODE = "redis" if (_ENV_REDIS_URL or _ENV_REDIS_HOST) else ""
    CACHE_CONFIG_SOURCE = "env" if (_ENV_REDIS_URL or _ENV_REDIS_HOST) else "default"

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

        raw_cache_mode = str(data.get("cache_mode") or "").strip().lower()
        hub_redis_url = str(data.get("redis_url") or "").strip()
        hub_redis_host = str(data.get("redis_host") or "").strip()

        if "redis_key_prefix" in data and str(data.get("redis_key_prefix") or "").strip():
            cls.REDIS_KEY_PREFIX = cls.normalize_redis_key_prefix(data.get("redis_key_prefix"))
        if "redis_timeout" in data and data.get("redis_timeout") not in (None, ""):
            try:
                cls.REDIS_TIMEOUT = max(0.3, min(15.0, float(data["redis_timeout"])))
            except (TypeError, ValueError):
                pass
        if "redis_cooldown_seconds" in data and data.get("redis_cooldown_seconds") not in (None, ""):
            try:
                cls.REDIS_COOLDOWN_SECONDS = max(5, min(600, int(data["redis_cooldown_seconds"])))
            except (TypeError, ValueError):
                pass

        if raw_cache_mode == "sql_cache":
            cls.CACHE_MODE = "sql_cache"
            cls.CACHE_CONFIG_SOURCE = "hub_config"
            # 保留已保存的连接参数以便后台随时切回 Redis
            if "redis_url" in data:
                cls.REDIS_URL = hub_redis_url
            if "redis_host" in data:
                cls.REDIS_HOST = hub_redis_host
            if "redis_port" in data and data["redis_port"]:
                cls.REDIS_PORT = int(data["redis_port"])
            if "redis_password" in data:
                cls.REDIS_PASSWORD = str(data.get("redis_password") or "").strip()
            if "redis_db" in data and data["redis_db"] is not None:
                cls.REDIS_DB = int(data["redis_db"])
        elif raw_cache_mode == "redis" or hub_redis_url or hub_redis_host:
            cls.CACHE_MODE = "redis"
            cls.CACHE_CONFIG_SOURCE = "hub_config"
            if "redis_url" in data:
                cls.REDIS_URL = hub_redis_url
            if "redis_host" in data:
                cls.REDIS_HOST = hub_redis_host
            if "redis_port" in data and data["redis_port"]:
                cls.REDIS_PORT = int(data["redis_port"])
            if "redis_password" in data:
                cls.REDIS_PASSWORD = str(data.get("redis_password") or "").strip()
            if "redis_db" in data and data["redis_db"] is not None:
                cls.REDIS_DB = int(data["redis_db"])
        else:
            # 兼容旧版安装向导写入的空 redis_url/redis_host：不覆盖环境变量中显式配置的 Redis
            cls.REDIS_URL = cls._ENV_REDIS_URL
            cls.REDIS_HOST = cls._ENV_REDIS_HOST
            cls.REDIS_PORT = cls._ENV_REDIS_PORT
            cls.REDIS_PASSWORD = cls._ENV_REDIS_PASSWORD
            cls.REDIS_DB = cls._ENV_REDIS_DB
            if cls._ENV_REDIS_URL or cls._ENV_REDIS_HOST:
                cls.CACHE_MODE = "redis"
                cls.CACHE_CONFIG_SOURCE = "env"
            else:
                cls.CACHE_MODE = ""
                cls.CACHE_CONFIG_SOURCE = "default"

        if "public_url" in data:
            cls.PUBLIC_URL = str(data.get("public_url") or "").strip().rstrip("/")
        if "public_port" in data and data["public_port"] is not None:
            cls.PUBLIC_PORT = int(data["public_port"] or 0)
        if data.get("app_mode") in ("all", "user", "admin"):
            cls.APP_MODE = str(data["app_mode"])

    @classmethod
    def reload_if_changed(cls, force: bool = False) -> bool:
        """检查 /data/hub_config.json 是否更新（支持多 Worker 进程间热同步安装向导与后台配置）"""
        now_mono = time.monotonic()
        if not force and (now_mono - cls._last_stat_check) < cls._STAT_CHECK_INTERVAL:
            return False

        path = os.getenv("HUB_CONFIG_PATH", cls.HUB_CONFIG_PATH)
        cls.HUB_CONFIG_PATH = path
        if not path or not os.path.exists(path):
            cls._last_stat_check = now_mono
            return False
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            cls._last_stat_check = now_mono
            return False

        if not force and mtime == cls._loaded_mtime:
            cls._last_stat_check = now_mono
            return False

        with cls._config_lock:
            now_mono = time.monotonic()
            if not force and mtime == cls._loaded_mtime:
                cls._last_stat_check = now_mono
                return False
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                cls._apply_hub_config_dict(data)
                cls._loaded_mtime = mtime
                cls._last_stat_check = now_mono
                return True
            except Exception as e:
                print(f"[Config] 读取 {path} 失败: {e}", flush=True)
                cls._last_stat_check = now_mono
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
    def normalize_redis_key_prefix(cls, raw_prefix: str) -> str:
        return _normalize_redis_key_prefix(raw_prefix)

    @classmethod
    def normalize_redis_url(cls, raw_url: str) -> str:
        """自动转义 Redis URL 密码/用户名中未编码的特殊字符（如 @ # / ? : [ ] 空格等）"""
        raw = str(raw_url or "").strip()
        if not raw or "://" not in raw:
            return raw
        scheme, rest = raw.split("://", 1)
        if scheme.lower() not in ("redis", "rediss"):
            return raw

        search_end = len(rest)
        while True:
            at_idx = rest.rfind("@", 0, search_end)
            if at_idx < 0:
                return raw
            userinfo = rest[:at_idx]
            host_part = rest[at_idx + 1:]
            try:
                probe = urllib.parse.urlparse(f"{scheme}://{host_part}")
                _ = probe.port
                valid_host = bool(probe.hostname) and not probe.fragment and "@" not in (probe.netloc or "")
            except ValueError:
                valid_host = False
            if valid_host:
                try:
                    raw_probe = urllib.parse.urlparse(raw)
                    _ = raw_probe.port
                    if (
                        raw_probe.hostname
                        and not raw_probe.fragment
                        and raw_probe.username is None
                        and raw_probe.password is None
                    ):
                        return raw
                except ValueError:
                    pass

                if ":" in userinfo:
                    user, pwd = userinfo.split(":", 1)
                    enc_user = urllib.parse.quote(user, safe="") if _UNSAFE_USERINFO_RE.search(user) else user
                    enc_pwd = urllib.parse.quote(pwd, safe="") if _UNSAFE_USERINFO_RE.search(pwd) else pwd
                    new_userinfo = f"{enc_user}:{enc_pwd}"
                else:
                    new_userinfo = (
                        urllib.parse.quote(userinfo, safe="")
                        if _UNSAFE_USERINFO_RE.search(userinfo)
                        else userinfo
                    )
                return f"{scheme}://{new_userinfo}@{host_part}"
            search_end = at_idx

    @classmethod
    def build_redis_url(
        cls,
        host: str,
        port: int = 6379,
        password: str = "",
        db: int = 0,
    ) -> str:
        clean_host = str(host or "").strip()
        if not clean_host:
            return ""
        formatted_host = (
            f"[{clean_host}]"
            if (":" in clean_host and not clean_host.startswith("["))
            else clean_host
        )
        pw = urllib.parse.quote(str(password or "").strip(), safe="")
        auth = f":{pw}@" if pw else ""
        return f"redis://{auth}{formatted_host}:{int(port or 6379)}/{int(db or 0)}"

    @classmethod
    def mask_redis_url(cls, url: str) -> str:
        raw = cls.normalize_redis_url(url)
        if not raw:
            return ""
        try:
            parsed = urllib.parse.urlparse(raw)
            if not parsed.scheme or not parsed.hostname:
                return raw
            host = f"[{parsed.hostname}]" if ":" in parsed.hostname else parsed.hostname
            port_part = f":{parsed.port}" if parsed.port else ""
            if parsed.password is not None:
                user_part = parsed.username or ""
                netloc = f"{user_part}:***@{host}{port_part}"
            elif parsed.username:
                netloc = f"{parsed.username}@{host}{port_part}"
            else:
                netloc = f"{host}{port_part}"
            return urllib.parse.urlunparse((parsed.scheme, netloc, parsed.path or "/0", "", parsed.query, ""))
        except Exception:
            return raw

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
        if cls.CACHE_MODE == "sql_cache":
            return ""
        if cls.REDIS_URL:
            return cls.normalize_redis_url(cls.REDIS_URL)
        if cls.REDIS_HOST:
            return cls.build_redis_url(cls.REDIS_HOST, cls.REDIS_PORT, cls.REDIS_PASSWORD, cls.REDIS_DB)
        return ""

    @classmethod
    def cache_config_summary(cls) -> dict:
        """返回供管理后台安全展示的缓存配置摘要（绝不返回明文密码）"""
        cls.reload_if_changed()
        effective_url = cls.effective_redis_url()
        host = cls.REDIS_HOST
        port = cls.REDIS_PORT or 6379
        db_idx = cls.REDIS_DB or 0
        has_password = bool(cls.REDIS_PASSWORD)
        raw_url_for_parse = cls.normalize_redis_url(cls.REDIS_URL) or effective_url

        if raw_url_for_parse:
            try:
                parsed = urllib.parse.urlparse(raw_url_for_parse)
                if not host and parsed.hostname:
                    host = parsed.hostname
                if parsed.port:
                    port = parsed.port
                if parsed.password:
                    has_password = True
                path_db = (parsed.path or "").lstrip("/")
                if path_db.isdigit():
                    db_idx = int(path_db)
            except Exception:
                pass

        return {
            "cache_mode": "redis" if effective_url else "sql_cache",
            "config_source": cls.CACHE_CONFIG_SOURCE,
            "has_env_redis": bool(cls._ENV_REDIS_URL or cls._ENV_REDIS_HOST),
            "redis_url_masked": cls.mask_redis_url(effective_url or cls.REDIS_URL),
            "using_custom_url": bool(cls.REDIS_URL),
            "redis_host": host or "127.0.0.1",
            "redis_port": int(port or 6379),
            "redis_db": int(db_idx or 0),
            "has_redis_password": has_password,
            "redis_key_prefix": cls.normalize_redis_key_prefix(cls.REDIS_KEY_PREFIX),
            "redis_timeout": float(cls.REDIS_TIMEOUT or 1.5),
            "redis_cooldown_seconds": int(cls.REDIS_COOLDOWN_SECONDS or 30),
            "hub_config_path": cls.HUB_CONFIG_PATH,
        }


Config.reload_if_changed(force=True)