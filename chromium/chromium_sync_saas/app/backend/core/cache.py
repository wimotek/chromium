import json
import os
import re
import sqlite3
import threading
import time
from typing import Any, Dict, List, Optional
from urllib.parse import quote, unquote

from config import (
    BOOTSTRAP_CONFIG_PATH,
    CACHE_DB_PATH,
    DEFAULT_REDIS_KEY_PREFIX,
    DEFAULT_REDIS_URL,
    logger,
)

try:
    import redis
    HAS_REDIS_LIB = True
except ImportError:
    redis = None
    HAS_REDIS_LIB = False

_REDIS_HOSTPATH_RE = re.compile(
    r"^(\[[^\]]+\]|[^/\s:?#]+)(?::(\d+))?(?:/(\d*))?(?:\?([^#]*))?$"
)
_PCT_ESCAPED_RE = re.compile(r"%[0-9A-Fa-f]{2}")
_KEY_PREFIX_VALID_RE = re.compile(r"^[A-Za-z0-9:._-]+$")


def normalize_key_prefix(
    prefix: Optional[str],
    fallback: str = DEFAULT_REDIS_KEY_PREFIX,
    strict: bool = False,
) -> str:
    """规范化 Redis 键命名空间前缀，生产环境默认强制附加统一冒号前缀避免冲突"""
    raw = fallback if prefix is None else str(prefix)
    cleaned = raw.strip()
    if not cleaned:
        cleaned = (fallback or "csync_saas:").strip() or "csync_saas:"
    if not _KEY_PREFIX_VALID_RE.fullmatch(cleaned):
        if strict:
            raise ValueError("键命名空间前缀仅允许字母、数字、冒号(:)、点(.)、下划线(_)与短横线(-)")
        cleaned = re.sub(r"[^A-Za-z0-9:._-]", "", cleaned)
        if not cleaned:
            cleaned = (fallback or "csync_saas:").strip() or "csync_saas:"
    cleaned = cleaned.rstrip(":")
    if not cleaned:
        cleaned = "csync_saas"
    return f"{cleaned}:"


def _smart_decode_userinfo_part(raw_part: str) -> str:
    if not raw_part:
        return ""
    if any(ch in raw_part for ch in ("@", "#", "?", "/", " ")):
        return raw_part
    if _PCT_ESCAPED_RE.search(raw_part):
        return unquote(raw_part)
    return raw_part


def parse_redis_url_safe(raw_url: str) -> Optional[Dict[str, Any]]:
    """安全解析 Redis URL，避免密码中含 @ / # / ? / / / ! / : 等特殊字符时被 urlparse 截断"""
    url = (raw_url or "").strip()
    if not url:
        return None
    if url.startswith("unix://"):
        return {
            "scheme": "unix",
            "raw_url": url,
            "host": url,
            "port": 0,
            "db": 0,
            "username": "",
            "password": "",
            "tls": False,
        }

    if "://" not in url:
        raise ValueError("Redis URL 必须以 redis://、rediss:// 或 unix:// 开头")

    scheme, rest = url.split("://", 1)
    scheme = scheme.strip().lower()
    if scheme not in {"redis", "rediss"}:
        raise ValueError(f"不支持的 Redis 协议头: {scheme}://（仅支持 redis://、rediss://、unix://）")

    username = ""
    password = ""
    hostpath = rest

    if "@" in rest:
        userinfo, candidate_host = rest.rsplit("@", 1)
        if not _REDIS_HOSTPATH_RE.match(candidate_host):
            raise ValueError("无法解析 Redis 主机与端口，建议使用分项参数表单填写（支持密码任意特殊字符）")
        hostpath = candidate_host
        if ":" in userinfo:
            raw_u, raw_p = userinfo.split(":", 1)
            username = _smart_decode_userinfo_part(raw_u)
            password = _smart_decode_userinfo_part(raw_p)
        else:
            password = _smart_decode_userinfo_part(userinfo)

    m = _REDIS_HOSTPATH_RE.match(hostpath)
    if not m:
        raise ValueError("Redis 地址格式无效，正确示例: redis://:password@127.0.0.1:6379/0")

    raw_host, port_s, db_s, query_s = m.groups()
    host = raw_host[1:-1] if (raw_host.startswith("[") and raw_host.endswith("]")) else raw_host
    port = int(port_s) if port_s else 6379
    if not (1 <= port <= 65535):
        raise ValueError(f"Redis 端口超出范围 (1-65535): {port}")
    db = int(db_s) if (db_s is not None and db_s != "") else 0
    if not (0 <= db <= 255):
        raise ValueError(f"Redis DB 编号超出范围 (0-255): {db}")

    return {
        "scheme": scheme,
        "host": host,
        "port": port,
        "db": db,
        "username": username,
        "password": password,
        "tls": scheme == "rediss",
        "query": query_s or "",
    }


def normalize_redis_config_dict(cfg: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not cfg or not isinstance(cfg, dict):
        return None
    if cfg.get("scheme") == "unix" and cfg.get("raw_url"):
        return {
            "scheme": "unix",
            "raw_url": str(cfg["raw_url"]).strip(),
            "host": str(cfg["raw_url"]).strip(),
            "port": 0,
            "db": 0,
            "username": "",
            "password": "",
            "tls": False,
        }
    host = str(cfg.get("host") or "").strip()
    if not host:
        return None
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1].strip()
    try:
        port = int(cfg.get("port") if cfg.get("port") not in (None, "") else 6379)
    except (TypeError, ValueError):
        raise ValueError("Redis 端口必须是有效整数 (1-65535)")
    if not (1 <= port <= 65535):
        raise ValueError(f"Redis 端口超出范围 (1-65535): {port}")
    try:
        db = int(cfg.get("db") if cfg.get("db") not in (None, "") else 0)
    except (TypeError, ValueError):
        raise ValueError("Redis DB 编号必须是有效整数 (0-255)")
    if not (0 <= db <= 255):
        raise ValueError(f"Redis DB 编号超出范围 (0-255): {db}")

    tls = bool(cfg.get("tls") or str(cfg.get("scheme") or "").lower() == "rediss")
    return {
        "scheme": "rediss" if tls else "redis",
        "host": host,
        "port": port,
        "db": db,
        "username": str(cfg.get("username") or "").strip(),
        "password": "" if cfg.get("password") is None else str(cfg.get("password")),
        "tls": tls,
        "query": str(cfg.get("query") or "").strip(),
    }


def build_encoded_redis_url(cfg: Optional[Dict[str, Any]]) -> str:
    if not cfg:
        return ""
    if cfg.get("scheme") == "unix":
        return str(cfg.get("raw_url") or "")
    host = str(cfg.get("host") or "").strip()
    if not host:
        return ""
    host_fmt = f"[{host}]" if (":" in host and not host.startswith("[")) else host
    scheme = "rediss" if cfg.get("tls") else "redis"
    port = int(cfg.get("port") or 6379)
    db = int(cfg.get("db") or 0)
    user = str(cfg.get("username") or "")
    pwd = str(cfg.get("password") or "")
    auth = ""
    if user or pwd:
        enc_u = quote(user, safe="") if user else ""
        enc_p = quote(pwd, safe="") if pwd else ""
        auth = f"{enc_u}:{enc_p}@"
    query = str(cfg.get("query") or "").strip()
    q_suffix = f"?{query}" if query else ""
    return f"{scheme}://{auth}{host_fmt}:{port}/{db}{q_suffix}"


def mask_redis_config(cfg: Optional[Dict[str, Any]]) -> str:
    if not cfg:
        return ""
    if cfg.get("scheme") == "unix":
        return str(cfg.get("raw_url") or "")
    host = str(cfg.get("host") or "").strip()
    if not host:
        return ""
    host_fmt = f"[{host}]" if (":" in host and not host.startswith("[")) else host
    scheme = "rediss" if cfg.get("tls") else "redis"
    port = int(cfg.get("port") or 6379)
    db = int(cfg.get("db") or 0)
    user = str(cfg.get("username") or "")
    has_pwd = bool(cfg.get("password"))
    if user and has_pwd:
        auth = f"{user}:***@"
    elif has_pwd:
        auth = "***@"
    elif user:
        auth = f"{user}@"
    else:
        auth = ""
    return f"{scheme}://{auth}{host_fmt}:{port}/{db}"


def _create_redis_client(
    cfg: Dict[str, Any],
    socket_connect_timeout: float = 1.5,
    socket_timeout: float = 1.5,
    health_check_interval: int = 30,
):
    if cfg.get("scheme") == "unix":
        return redis.Redis.from_url(
            cfg["raw_url"],
            decode_responses=True,
            socket_connect_timeout=socket_connect_timeout,
            socket_timeout=socket_timeout,
            health_check_interval=health_check_interval,
        )
    kwargs: Dict[str, Any] = {
        "host": cfg["host"],
        "port": int(cfg.get("port") or 6379),
        "db": int(cfg.get("db") or 0),
        "decode_responses": True,
        "socket_connect_timeout": socket_connect_timeout,
        "socket_timeout": socket_timeout,
        "health_check_interval": health_check_interval,
    }
    if cfg.get("username"):
        kwargs["username"] = cfg["username"]
    if cfg.get("password"):
        kwargs["password"] = cfg["password"]
    if cfg.get("tls"):
        kwargs["ssl"] = True
    return redis.Redis(**kwargs)



class SQLiteCacheBackend:
    """SQLite WAL 本地缓存与原子计数器后端"""

    def __init__(self, db_path: str):
        self.db_path = db_path
        self._lock = threading.Lock()
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        conn = sqlite3.connect(self.db_path, timeout=10.0, check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA busy_timeout=3000;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        return conn

    def _init_schema(self):
        with self._lock:
            conn = self._connect()
            try:
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS cache_entries (
                        k TEXT PRIMARY KEY,
                        v TEXT NOT NULL,
                        expires_at REAL
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS cache_hash_counters (
                        hkey TEXT NOT NULL,
                        field TEXT NOT NULL,
                        val INTEGER NOT NULL DEFAULT 0,
                        PRIMARY KEY (hkey, field)
                    )
                    """
                )
                conn.commit()
            finally:
                conn.close()

    def get(self, key: str) -> Optional[str]:
        now = time.time()
        with self._lock:
            conn = self._connect()
            try:
                cur = conn.cursor()
                cur.execute("SELECT v, expires_at FROM cache_entries WHERE k=?", (key,))
                row = cur.fetchone()
                if not row:
                    return None
                val, exp = row
                if exp is not None and exp <= now:
                    cur.execute("DELETE FROM cache_entries WHERE k=?", (key,))
                    conn.commit()
                    return None
                return val
            finally:
                conn.close()

    def set(self, key: str, value: str, ttl: Optional[int] = None):
        exp = (time.time() + ttl) if (ttl and ttl > 0) else None
        with self._lock:
            conn = self._connect()
            try:
                conn.execute(
                    "INSERT OR REPLACE INTO cache_entries (k, v, expires_at) VALUES (?, ?, ?)",
                    (key, str(value), exp),
                )
                conn.commit()
            finally:
                conn.close()

    def mset_batch(self, items: Dict[str, str], ttl: Optional[int] = None):
        if not items:
            return
        exp = (time.time() + ttl) if (ttl and ttl > 0) else None
        rows = [(str(k), str(v), exp) for k, v in items.items()]
        with self._lock:
            conn = self._connect()
            try:
                conn.executemany(
                    "INSERT OR REPLACE INTO cache_entries (k, v, expires_at) VALUES (?, ?, ?)",
                    rows,
                )
                conn.commit()
            finally:
                conn.close()

    def delete(self, key: str):
        with self._lock:
            conn = self._connect()
            try:
                conn.execute("DELETE FROM cache_entries WHERE k=?", (key,))
                conn.commit()
            finally:
                conn.close()

    def incr_window(self, key: str, window_sec: int, delta: int = 1) -> tuple[int, int]:
        win = max(1, int(window_sec or 60))
        step = int(delta or 1)
        now = time.time()
        with self._lock:
            conn = self._connect()
            try:
                cur = conn.cursor()
                cur.execute("SELECT v, expires_at FROM cache_entries WHERE k=?", (key,))
                row = cur.fetchone()
                if row and row[1] is not None and float(row[1]) > now:
                    try:
                        curr_val = int(row[0])
                    except (TypeError, ValueError):
                        curr_val = 0
                    new_val = curr_val + step
                    exp = float(row[1])
                    conn.execute("UPDATE cache_entries SET v=? WHERE k=?", (str(new_val), key))
                    conn.commit()
                    return new_val, max(1, int(exp - now))

                new_val = step
                exp = now + win
                conn.execute(
                    "INSERT OR REPLACE INTO cache_entries (k, v, expires_at) VALUES (?, ?, ?)",
                    (key, str(new_val), exp),
                )
                conn.commit()
                return new_val, win
            finally:
                conn.close()

    def hincrby(self, hkey: str, field: str, delta: int) -> int:
        with self._lock:
            conn = self._connect()
            try:
                cur = conn.cursor()
                cur.execute(
                    """
                    INSERT INTO cache_hash_counters (hkey, field, val) VALUES (?, ?, ?)
                    ON CONFLICT(hkey, field) DO UPDATE SET val = cache_hash_counters.val + excluded.val
                    """,
                    (hkey, field, int(delta)),
                )
                cur.execute("SELECT val FROM cache_hash_counters WHERE hkey=? AND field=?", (hkey, field))
                row = cur.fetchone()
                conn.commit()
                return int(row[0]) if row else 0
            finally:
                conn.close()

    def hgetall_readonly(self, hkey: str) -> Dict[str, int]:
        with self._lock:
            conn = self._connect()
            try:
                cur = conn.cursor()
                cur.execute("SELECT field, val FROM cache_hash_counters WHERE hkey=?", (hkey,))
                return {str(f): int(v or 0) for f, v in cur.fetchall() if int(v or 0) != 0}
            finally:
                conn.close()

    def hgetall_and_reset(self, hkey: str) -> Dict[str, int]:
        with self._lock:
            conn = self._connect()
            try:
                cur = conn.cursor()
                cur.execute("SELECT field, val FROM cache_hash_counters WHERE hkey=?", (hkey,))
                rows = cur.fetchall()
                if rows:
                    cur.execute("DELETE FROM cache_hash_counters WHERE hkey=?", (hkey,))
                    conn.commit()
                return {str(f): int(v or 0) for f, v in rows if int(v or 0) != 0}
            finally:
                conn.close()

    def keys_with_prefix(self, prefix: str) -> List[str]:
        with self._lock:
            conn = self._connect()
            try:
                cur = conn.cursor()
                cur.execute("SELECT DISTINCT hkey FROM cache_hash_counters WHERE hkey LIKE ?", (f"{prefix}%",))
                return [str(r[0]) for r in cur.fetchall()]
            finally:
                conn.close()

    def hincrby_batch(self, ops: Dict[str, Dict[str, int]]):
        if not ops:
            return
        params = []
        for hkey, fields in ops.items():
            for field, delta in fields.items():
                d = int(delta or 0)
                if d:
                    params.append((hkey, field, d))
        if not params:
            return
        with self._lock:
            conn = self._connect()
            try:
                conn.executemany(
                    """
                    INSERT INTO cache_hash_counters (hkey, field, val) VALUES (?, ?, ?)
                    ON CONFLICT(hkey, field) DO UPDATE SET val = cache_hash_counters.val + excluded.val
                    """,
                    params,
                )
                conn.commit()
            finally:
                conn.close()

    def hgetall_batch(self, hkeys: List[str]) -> Dict[str, Dict[str, int]]:
        result: Dict[str, Dict[str, int]] = {}
        if not hkeys:
            return result
        unique_keys = list(dict.fromkeys(hkeys))
        with self._lock:
            conn = self._connect()
            try:
                cur = conn.cursor()
                for i in range(0, len(unique_keys), 400):
                    chunk = unique_keys[i : i + 400]
                    placeholders = ",".join("?" for _ in chunk)
                    cur.execute(
                        f"SELECT hkey, field, val FROM cache_hash_counters WHERE hkey IN ({placeholders})",
                        chunk,
                    )
                    for hk, f, v in cur.fetchall():
                        iv = int(v or 0)
                        if iv != 0:
                            result.setdefault(str(hk), {})[str(f)] = iv
                return result
            finally:
                conn.close()

    def mget_batch(self, keys: List[str]) -> Dict[str, Optional[str]]:
        result: Dict[str, Optional[str]] = {}
        if not keys:
            return result
        unique_keys = list(dict.fromkeys(keys))
        now = time.time()
        expired_keys = []
        with self._lock:
            conn = self._connect()
            try:
                cur = conn.cursor()
                for i in range(0, len(unique_keys), 400):
                    chunk = unique_keys[i : i + 400]
                    placeholders = ",".join("?" for _ in chunk)
                    cur.execute(
                        f"SELECT k, v, expires_at FROM cache_entries WHERE k IN ({placeholders})",
                        chunk,
                    )
                    for k, val, exp in cur.fetchall():
                        if exp is not None and exp <= now:
                            expired_keys.append((k,))
                        else:
                            result[str(k)] = val
                if expired_keys:
                    conn.executemany("DELETE FROM cache_entries WHERE k=?", expired_keys)
                    conn.commit()
                return result
            finally:
                conn.close()

    def cleanup_expired(self):
        now = time.time()
        with self._lock:
            conn = self._connect()
            try:
                conn.execute("DELETE FROM cache_entries WHERE expires_at IS NOT NULL AND expires_at <= ?", (now,))
                conn.commit()
            finally:
                conn.close()

    def stats(self) -> dict:
        with self._lock:
            conn = self._connect()
            try:
                cur = conn.cursor()
                cur.execute("SELECT count(*) FROM cache_entries")
                kv_cnt = cur.fetchone()[0]
                cur.execute("SELECT count(DISTINCT hkey) FROM cache_hash_counters")
                hash_cnt = cur.fetchone()[0]
                return {"entries": kv_cnt, "buffered_hashes": hash_cnt, "db_path": self.db_path}
            finally:
                conn.close()


class CacheManager:
    def __init__(self):
        self._sqlite_cache = SQLiteCacheBackend(CACHE_DB_PATH)
        self._redis_client = None
        self._redis_config: Optional[Dict[str, Any]] = None
        self._redis_url = ""
        self._key_prefix = normalize_key_prefix(DEFAULT_REDIS_KEY_PREFIX)
        self._config_source = "default"
        self._active_backend = "sqlite_cache"
        self._last_error = ""
        self._last_probe_ts = 0.0
        self._probe_cooldown_sec = 30.0
        self._hits = 0
        self._misses = 0
        self._fallbacks = 0
        self._lock = threading.Lock()
        self.reload_from_config()

    def _rk(self, key: str) -> str:
        k = str(key)
        p = self._key_prefix
        if not p or k.startswith(p):
            return k
        return f"{p}{k}"

    def _strip_rk(self, key: str) -> str:
        k = str(key)
        p = self._key_prefix
        if p and k.startswith(p):
            return k[len(p):]
        return k

    def get_key_prefix(self) -> str:
        return self._key_prefix

    def get_current_redis_config(self) -> Optional[Dict[str, Any]]:
        return dict(self._redis_config) if self._redis_config else None

    def _resolve_redis_settings(self) -> tuple[Optional[Dict[str, Any]], str, str, str]:
        if os.path.exists(BOOTSTRAP_CONFIG_PATH):
            try:
                with open(BOOTSTRAP_CONFIG_PATH, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    prefix_raw = data.get("redis_key_prefix")
                    if prefix_raw is None and isinstance(data.get("redis_config"), dict):
                        prefix_raw = data["redis_config"].get("key_prefix")
                    key_prefix = normalize_key_prefix(prefix_raw, DEFAULT_REDIS_KEY_PREFIX, strict=False)

                    if "redis_config" in data or "redis_url" in data:
                        raw_cfg = data.get("redis_config")
                        if isinstance(raw_cfg, dict) and (raw_cfg.get("host") or raw_cfg.get("raw_url")):
                            cfg = normalize_redis_config_dict(raw_cfg)
                            return cfg, build_encoded_redis_url(cfg), key_prefix, "bootstrap"
                        raw_url = str(data.get("redis_url") or "").strip()
                        if raw_url:
                            cfg = parse_redis_url_safe(raw_url)
                            return cfg, build_encoded_redis_url(cfg), key_prefix, "bootstrap"
                        return None, "", key_prefix, "bootstrap"
            except Exception as exc:
                logger.warning(f"⚠️ [Cache] 解析 bootstrap.json Redis 配置失败 ({exc})，将尝试回退默认配置")

        key_prefix = normalize_key_prefix(DEFAULT_REDIS_KEY_PREFIX, DEFAULT_REDIS_KEY_PREFIX, strict=False)
        if DEFAULT_REDIS_URL:
            try:
                cfg = parse_redis_url_safe(DEFAULT_REDIS_URL)
                return cfg, build_encoded_redis_url(cfg), key_prefix, "env"
            except Exception as exc:
                logger.warning(f"⚠️ [Cache] 环境变量 REDIS_URL 格式无效 ({exc})，将保持原样标记降级")
                return None, DEFAULT_REDIS_URL, key_prefix, "env"
        return None, "", key_prefix, "default"

    def resolve_target_config(
        self,
        *,
        redis_url: str = "",
        redis_host: Optional[str] = None,
        redis_port: Optional[int] = 6379,
        redis_db: Optional[int] = 0,
        redis_username: Optional[str] = "",
        redis_password: Optional[str] = None,
        redis_tls: bool = False,
        keep_password: bool = True,
        clear_password: bool = False,
        use_current: bool = False,
        key_prefix: Optional[str] = None,
    ) -> tuple[Optional[Dict[str, Any]], str]:
        prefix = normalize_key_prefix(
            key_prefix if key_prefix is not None else self._key_prefix,
            DEFAULT_REDIS_KEY_PREFIX,
            strict=True,
        )
        host_clean = (redis_host or "").strip()
        url_clean = (redis_url or "").strip()

        if host_clean:
            pwd_val = ""
            if clear_password:
                pwd_val = ""
            elif redis_password is not None and redis_password != "":
                pwd_val = str(redis_password)
            elif keep_password and self._redis_config:
                pwd_val = str(self._redis_config.get("password") or "")
            cfg = normalize_redis_config_dict({
                "host": host_clean,
                "port": redis_port if redis_port not in (None, "") else 6379,
                "db": redis_db if redis_db not in (None, "") else 0,
                "username": (redis_username or "").strip(),
                "password": pwd_val,
                "tls": bool(redis_tls),
            })
            return cfg, prefix

        if url_clean:
            cfg = parse_redis_url_safe(url_clean)
            return cfg, prefix

        if use_current and self._redis_config:
            return dict(self._redis_config), prefix

        return None, prefix

    def reload_from_config(
        self,
        redis_url: Optional[str] = None,
        source: Optional[str] = None,
        redis_config: Optional[Dict[str, Any]] = None,
        key_prefix: Optional[str] = None,
    ) -> str:
        parse_err = ""
        if redis_config is not None:
            try:
                target_cfg = normalize_redis_config_dict(redis_config) if redis_config else None
            except Exception as exc:
                target_cfg = None
                parse_err = str(exc)
            target_url = build_encoded_redis_url(target_cfg) if target_cfg else ""
            target_prefix = normalize_key_prefix(
                key_prefix if key_prefix is not None else self._key_prefix,
                DEFAULT_REDIS_KEY_PREFIX,
                strict=False,
            )
            resolved_source = source or "bootstrap"
        elif redis_url is None:
            target_cfg, target_url, target_prefix, resolved_source = self._resolve_redis_settings()
            if key_prefix is not None:
                target_prefix = normalize_key_prefix(key_prefix, DEFAULT_REDIS_KEY_PREFIX, strict=False)
        else:
            raw_u = str(redis_url).strip()
            target_prefix = normalize_key_prefix(
                key_prefix if key_prefix is not None else self._key_prefix,
                DEFAULT_REDIS_KEY_PREFIX,
                strict=False,
            )
            resolved_source = source or "bootstrap"
            if not raw_u:
                target_cfg = None
                target_url = ""
            else:
                try:
                    target_cfg = parse_redis_url_safe(raw_u)
                    target_url = build_encoded_redis_url(target_cfg)
                except Exception as exc:
                    target_cfg = None
                    target_url = raw_u
                    parse_err = str(exc)

        with self._lock:
            old_client = self._redis_client
            self._redis_config = target_cfg
            self._redis_url = target_url
            self._key_prefix = target_prefix
            self._config_source = resolved_source
            self._redis_client = None
            self._last_error = ""
            self._last_probe_ts = time.monotonic()

            if old_client is not None:
                try:
                    old_client.close()
                except Exception:
                    pass

            if not target_cfg and not target_url:
                self._active_backend = "sqlite_cache"
                logger.info(
                    f"💾 [Cache] 未配置 Redis，启用内置 SQLite WAL Cache ({CACHE_DB_PATH}) | 命名空间前缀={self._key_prefix}"
                )
                return self._active_backend

            if parse_err or target_cfg is None:
                self._active_backend = "sqlite_cache"
                self._last_error = parse_err or "Redis 配置无效"
                self._fallbacks += 1
                logger.warning(f"⚠️ [Cache] Redis 配置解析失败 ({self._last_error})，自动回退至 SQLite Cache")
                return self._active_backend

            if not HAS_REDIS_LIB:
                self._active_backend = "sqlite_cache"
                self._last_error = "redis Python 库未安装"
                logger.warning("⚠️ [Cache] 缺少 redis 库，自动回退至 SQLite Cache")
                return self._active_backend

            try:
                client = _create_redis_client(
                    target_cfg,
                    socket_connect_timeout=1.5,
                    socket_timeout=1.5,
                    health_check_interval=30,
                )
                client.ping()
                self._redis_client = client
                self._active_backend = "redis"
                logger.info(
                    f"⚡ [Cache] Redis 高速缓存已连通并激活 ({mask_redis_config(target_cfg)} | 前缀={self._key_prefix})"
                )
            except Exception as exc:
                self._redis_client = None
                self._active_backend = "sqlite_cache"
                self._last_error = str(exc)
                self._fallbacks += 1
                logger.warning(f"⚠️ [Cache] Redis 连接失败 ({exc})，已自动无缝回退至 SQLite Cache")
            return self._active_backend

    def _get_redis(self):
        if self._redis_client is not None:
            return self._redis_client
        if (self._redis_config or self._redis_url) and (time.monotonic() - self._last_probe_ts) >= self._probe_cooldown_sec:
            self.reload_from_config(
                redis_url=self._redis_url if self._redis_config is None else None,
                source=self._config_source,
                redis_config=self._redis_config,
                key_prefix=self._key_prefix,
            )
            return self._redis_client
        return None

    def _trip_fallback(self, exc: Exception):
        with self._lock:
            self._redis_client = None
            self._active_backend = "sqlite_cache"
            self._last_error = str(exc)
            self._last_probe_ts = time.monotonic()
            self._fallbacks += 1
        logger.warning(f"⚠️ [Cache] Redis 运行时异常 ({exc})，已瞬时回退至 SQLite Cache")

    def get(self, key: str) -> Optional[str]:
        r = self._get_redis()
        if r is not None:
            try:
                val = r.get(self._rk(key))
                self._hits += 1 if val is not None else 0
                self._misses += 1 if val is None else 0
                return val
            except Exception as exc:
                self._trip_fallback(exc)
        val = self._sqlite_cache.get(key)
        self._hits += 1 if val is not None else 0
        self._misses += 1 if val is None else 0
        return val

    def set(self, key: str, value: Any, ttl: Optional[int] = None):
        str_val = str(value)
        r = self._get_redis()
        if r is not None:
            try:
                rk = self._rk(key)
                if ttl and ttl > 0:
                    r.setex(rk, int(ttl), str_val)
                else:
                    r.set(rk, str_val)
                return
            except Exception as exc:
                self._trip_fallback(exc)
        self._sqlite_cache.set(key, str_val, ttl=ttl)

    def mset_batch(self, items: Dict[str, Any], ttl: Optional[int] = None):
        if not items:
            return
        encoded = {str(k): str(v) for k, v in items.items()}
        r = self._get_redis()
        if r is not None:
            try:
                pipe = r.pipeline(transaction=False)
                for k, raw in encoded.items():
                    rk = self._rk(k)
                    if ttl and ttl > 0:
                        pipe.setex(rk, int(ttl), raw)
                    else:
                        pipe.set(rk, raw)
                pipe.execute()
                return
            except Exception as exc:
                self._trip_fallback(exc)
        self._sqlite_cache.mset_batch(encoded, ttl=ttl)

    def delete(self, key: str):
        r = self._get_redis()
        if r is not None:
            try:
                r.delete(self._rk(key))
                return
            except Exception as exc:
                self._trip_fallback(exc)
        self._sqlite_cache.delete(key)

    def get_json(self, key: str) -> Optional[Any]:
        raw = self.get(key)
        if raw is None:
            return None
        try:
            return json.loads(raw)
        except Exception:
            return None

    def set_json(self, key: str, value: Any, ttl: Optional[int] = None):
        self.set(key, json.dumps(value, ensure_ascii=False), ttl=ttl)

    _LUA_INCR_WINDOW = """
    local c = redis.call('INCRBY', KEYS[1], ARGV[1])
    local ttl = redis.call('TTL', KEYS[1])
    if ttl < 0 then
        redis.call('EXPIRE', KEYS[1], ARGV[2])
        ttl = tonumber(ARGV[2])
    end
    return {c, ttl}
    """

    def incr_window(self, key: str, window_sec: int, delta: int = 1) -> tuple[int, int]:
        win = max(1, int(window_sec or 60))
        step = int(delta or 1)
        r = self._get_redis()
        if r is not None:
            try:
                res = r.eval(self._LUA_INCR_WINDOW, 1, self._rk(key), step, win)
                count = int(res[0])
                ttl_left = max(1, int(res[1])) if len(res) > 1 and int(res[1]) > 0 else win
                return count, ttl_left
            except Exception as exc:
                self._trip_fallback(exc)
        return self._sqlite_cache.incr_window(key, win, step)

    def hincrby(self, hkey: str, field: str, delta: int) -> int:
        if delta == 0:
            return 0
        r = self._get_redis()
        if r is not None:
            try:
                return int(r.hincrby(self._rk(hkey), field, int(delta)))
            except Exception as exc:
                self._trip_fallback(exc)
        return self._sqlite_cache.hincrby(hkey, field, int(delta))

    def hincrby_batch(self, ops: Dict[str, Dict[str, int]]):
        if not ops:
            return
        r = self._get_redis()
        if r is not None:
            try:
                pipe = r.pipeline(transaction=False)
                has_cmd = False
                for hkey, fields in ops.items():
                    rk = self._rk(hkey)
                    for field, delta in fields.items():
                        d = int(delta or 0)
                        if d:
                            pipe.hincrby(rk, field, d)
                            has_cmd = True
                if has_cmd:
                    pipe.execute()
                return
            except Exception as exc:
                self._trip_fallback(exc)
        self._sqlite_cache.hincrby_batch(ops)

    def mset_json_batch(self, items: Dict[str, Any], ttl: Optional[int] = None):
        if not items:
            return
        encoded = {k: json.dumps(v, ensure_ascii=False) for k, v in items.items()}
        r = self._get_redis()
        if r is not None:
            try:
                pipe = r.pipeline(transaction=False)
                for k, raw in encoded.items():
                    rk = self._rk(k)
                    if ttl and ttl > 0:
                        pipe.setex(rk, int(ttl), raw)
                    else:
                        pipe.set(rk, raw)
                pipe.execute()
                return
            except Exception as exc:
                self._trip_fallback(exc)
        for k, raw in encoded.items():
            self._sqlite_cache.set(k, raw, ttl=ttl)

    def mget_json_batch(self, keys: List[str]) -> Dict[str, Any]:
        if not keys:
            return {}
        out: Dict[str, Any] = {}
        r = self._get_redis()
        if r is not None:
            try:
                vals = r.mget([self._rk(k) for k in keys])
                for k, raw in zip(keys, vals):
                    if raw is not None:
                        self._hits += 1
                        try:
                            out[k] = json.loads(raw)
                        except Exception:
                            pass
                    else:
                        self._misses += 1
                return out
            except Exception as exc:
                self._trip_fallback(exc)

        raw_map = self._sqlite_cache.mget_batch(keys)
        for k in keys:
            raw = raw_map.get(k)
            if raw is not None:
                self._hits += 1
                try:
                    out[k] = json.loads(raw)
                except Exception:
                    pass
            else:
                self._misses += 1
        return out

    def drain_hash_counters(self, hkey: str) -> Dict[str, int]:
        merged: Dict[str, int] = {}
        sqlite_leftover = self._sqlite_cache.hgetall_and_reset(hkey)
        for k, v in sqlite_leftover.items():
            merged[k] = merged.get(k, 0) + v
        r = self._get_redis()
        if r is not None:
            try:
                rk = self._rk(hkey)
                pipe = r.pipeline()
                pipe.hgetall(rk)
                pipe.delete(rk)
                res, _ = pipe.execute()
                for k, v in (res or {}).items():
                    merged[str(k)] = merged.get(str(k), 0) + int(v or 0)
            except Exception as exc:
                self._trip_fallback(exc)
        return {k: v for k, v in merged.items() if v != 0}

    def hgetall_readonly(self, hkey: str) -> Dict[str, int]:
        merged = self._sqlite_cache.hgetall_readonly(hkey)
        r = self._get_redis()
        if r is not None:
            try:
                res = r.hgetall(self._rk(hkey))
                for k, v in (res or {}).items():
                    merged[str(k)] = merged.get(str(k), 0) + int(v or 0)
            except Exception as exc:
                self._trip_fallback(exc)
        return {k: v for k, v in merged.items() if v != 0}

    def hgetall_readonly_batch(self, hkeys: List[str]) -> Dict[str, Dict[str, int]]:
        if not hkeys:
            return {}
        merged = self._sqlite_cache.hgetall_batch(hkeys)
        r = self._get_redis()
        if r is not None:
            try:
                pipe = r.pipeline(transaction=False)
                for hk in hkeys:
                    pipe.hgetall(self._rk(hk))
                rows = pipe.execute()
                for hk, res in zip(hkeys, rows):
                    if not res:
                        continue
                    target = merged.setdefault(hk, {})
                    for k, v in res.items():
                        iv = int(v or 0)
                        if iv != 0:
                            target[str(k)] = target.get(str(k), 0) + iv
            except Exception as exc:
                self._trip_fallback(exc)
        return {
            hk: {k: v for k, v in fields.items() if v != 0}
            for hk, fields in merged.items()
            if any(v != 0 for v in fields.values())
        }

    def list_hash_keys(self, prefix: str) -> List[str]:
        found = set(self._sqlite_cache.keys_with_prefix(prefix))
        r = self._get_redis()
        if r is not None:
            try:
                for k in r.scan_iter(match=f"{self._rk(prefix)}*", count=200):
                    found.add(self._strip_rk(str(k)))
            except Exception as exc:
                self._trip_fallback(exc)
        return sorted(found)

    def cleanup_sqlite_expired(self):
        self._sqlite_cache.cleanup_expired()

    @staticmethod
    def mask_redis_url(url: str) -> str:
        raw = (url or "").strip()
        if not raw:
            return ""
        try:
            cfg = parse_redis_url_safe(raw)
            if cfg:
                return mask_redis_config(cfg)
        except Exception:
            pass
        if "@" in raw and "://" in raw:
            scheme, rest = raw.split("://", 1)
            _, hostpart = rest.rsplit("@", 1)
            return f"{scheme}://***@{hostpart}"
        return raw

    def get_current_redis_url(self) -> str:
        return self._redis_url

    def get_status(self) -> dict:
        sqlite_stats = self._sqlite_cache.stats()
        redis_info = None
        client = self._redis_client
        if self._active_backend == "redis" and client is not None:
            try:
                t0 = time.perf_counter()
                client.ping()
                ping_ms = round((time.perf_counter() - t0) * 1000, 2)
                mem_info = client.info("memory")
                srv_info = client.info("server")
                cli_info = client.info("clients")
                redis_info = {
                    "connected": True,
                    "ping_ms": ping_ms,
                    "version": srv_info.get("redis_version", ""),
                    "used_memory_human": mem_info.get("used_memory_human", ""),
                    "connected_clients": int(cli_info.get("connected_clients") or 0),
                    "uptime_in_seconds": int(srv_info.get("uptime_in_seconds") or 0),
                }
            except Exception as exc:
                self._trip_fallback(exc)
                redis_info = {"connected": False}

        redis_configured = bool(self._redis_config or self._redis_url)
        redis_connected = self._active_backend == "redis" and self._redis_client is not None and bool(redis_info and redis_info.get("connected"))
        degraded = redis_configured and not redis_connected
        engine_state = "redis" if redis_connected else ("degraded" if degraded else "sqlite_cache")
        if engine_state == "redis":
            engine_label = "Redis 高速缓存"
        elif engine_state == "degraded":
            engine_label = "Redis 已降级 · SQLite Cache 兜底"
        else:
            engine_label = "SQLite WAL Cache"

        next_probe_in_sec = (
            max(0, int(round(self._probe_cooldown_sec - (time.monotonic() - self._last_probe_ts))))
            if degraded
            else 0
        )
        total_ops = self._hits + self._misses
        hit_rate = round((self._hits / total_ops) * 100, 1) if total_ops > 0 else 0.0

        cfg = self._redis_config or {}
        redis_params = {
            "host": str(cfg.get("host") or ""),
            "port": int(cfg.get("port") or 6379),
            "db": int(cfg.get("db") or 0),
            "username": str(cfg.get("username") or ""),
            "tls": bool(cfg.get("tls", False)),
            "has_password": bool(cfg.get("password")),
            "key_prefix": self._key_prefix,
        }

        return {
            "active_backend": self._active_backend,
            "engine_state": engine_state,
            "engine_label": engine_label,
            "degraded": degraded,
            "config_source": self._config_source,
            "key_prefix": self._key_prefix,
            "default_key_prefix": normalize_key_prefix(DEFAULT_REDIS_KEY_PREFIX),
            "has_redis_lib": HAS_REDIS_LIB,
            "redis_configured": redis_configured,
            "redis_connected": redis_connected,
            "redis_url_masked": mask_redis_config(self._redis_config) if self._redis_config else self.mask_redis_url(self._redis_url),
            "redis_params": redis_params,
            "redis_info": redis_info,
            "probe_cooldown_sec": int(self._probe_cooldown_sec),
            "next_probe_in_sec": next_probe_in_sec,
            "fallback_count": self._fallbacks,
            "last_error": self._last_error,
            "hits": self._hits,
            "misses": self._misses,
            "hit_rate": hit_rate,
            "stats": {
                "hits": self._hits,
                "misses": self._misses,
                "fallbacks": self._fallbacks,
                "sqlite_fallbacks": self._fallbacks,
            },
            "sqlite_cache": sqlite_stats,
        }

    def probe_reconnect(self) -> dict:
        if not (self._redis_config or self._redis_url):
            return {
                "ok": False,
                "detail": "当前未配置 Redis，处于内置 SQLite WAL Cache 模式",
                "cache": self.get_status(),
            }
        self.reload_from_config(
            redis_url=self._redis_url if self._redis_config is None else None,
            source=self._config_source,
            redis_config=self._redis_config,
            key_prefix=self._key_prefix,
        )
        status = self.get_status()
        if status["engine_state"] == "redis":
            info = status.get("redis_info") or {}
            ver = info.get("version") or "?"
            ping_ms = info.get("ping_ms")
            lat_txt = f", {ping_ms}ms" if ping_ms is not None else ""
            return {
                "ok": True,
                "message": f"Redis 已恢复连接 (v{ver}{lat_txt} · 前缀 {status.get('key_prefix')})",
                "cache": status,
            }
        return {
            "ok": False,
            "detail": f"Redis 仍不可达 ({status.get('last_error') or '连接失败'})，继续使用 SQLite WAL Cache 兜底",
            "cache": status,
        }

    def test_target(
        self,
        redis_url: str = "",
        use_current: bool = False,
        *,
        redis_host: Optional[str] = None,
        redis_port: Optional[int] = 6379,
        redis_db: Optional[int] = 0,
        redis_username: Optional[str] = "",
        redis_password: Optional[str] = None,
        redis_tls: bool = False,
        keep_password: bool = True,
        clear_password: bool = False,
        key_prefix: Optional[str] = None,
    ) -> dict:
        try:
            cfg, prefix = self.resolve_target_config(
                redis_url=redis_url,
                redis_host=redis_host,
                redis_port=redis_port,
                redis_db=redis_db,
                redis_username=redis_username,
                redis_password=redis_password,
                redis_tls=redis_tls,
                keep_password=keep_password,
                clear_password=clear_password,
                use_current=use_current,
                key_prefix=key_prefix,
            )
        except ValueError as exc:
            return {"ok": False, "pong": False, "detail": str(exc)}
        if not cfg:
            return {"ok": False, "pong": False, "detail": "请填写 Redis 服务器地址或连接 URL"}
        return self.test_connection_cfg(cfg, key_prefix=prefix)

    @staticmethod
    def test_connection(redis_url: str, key_prefix: Optional[str] = None) -> dict:
        url = (redis_url or "").strip()
        if not url:
            return {"ok": False, "pong": False, "detail": "Redis URL 不能为空"}
        try:
            cfg = parse_redis_url_safe(url)
        except ValueError as exc:
            return {"ok": False, "pong": False, "detail": str(exc)}
        return CacheManager.test_connection_cfg(cfg, key_prefix=key_prefix)

    @staticmethod
    def test_connection_cfg(cfg: Optional[Dict[str, Any]], key_prefix: Optional[str] = None) -> dict:
        if not cfg:
            return {"ok": False, "pong": False, "detail": "Redis 连接参数不能为空"}
        if not HAS_REDIS_LIB:
            return {"ok": False, "pong": False, "detail": "后端未安装 redis 依赖包"}
        prefix = normalize_key_prefix(key_prefix, DEFAULT_REDIS_KEY_PREFIX, strict=False)
        masked = mask_redis_config(cfg)
        client = None
        t0 = time.perf_counter()
        try:
            client = _create_redis_client(
                cfg,
                socket_connect_timeout=2.5,
                socket_timeout=2.5,
                health_check_interval=0,
            )
            pong = bool(client.ping())
            lat = round((time.perf_counter() - t0) * 1000, 2)
            srv_info = client.info("server")
            mem_info = client.info("memory")
            ver = srv_info.get("redis_version", "unknown")
            mem_human = mem_info.get("used_memory_human", "")
            mem_suffix = f", 内存 {mem_human}" if mem_human else ""
            return {
                "ok": True,
                "pong": pong,
                "latency_ms": lat,
                "version": ver,
                "used_memory_human": mem_human,
                "key_prefix": prefix,
                "redis_url_masked": masked,
                "message": f"PONG · Redis 连接成功 (v{ver}, {lat}ms{mem_suffix} · 命名空间 {prefix})",
            }
        except Exception as exc:
            return {
                "ok": False,
                "pong": False,
                "key_prefix": prefix,
                "redis_url_masked": masked,
                "detail": f"Redis PING 失败: {exc}",
            }
        finally:
            if client is not None:
                try:
                    client.close()
                except Exception:
                    pass


cache_mgr = CacheManager()
