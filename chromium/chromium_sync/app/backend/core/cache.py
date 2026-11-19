import json
import os
import sqlite3
import threading
import time
from typing import Any, Dict, List, Optional

from config import BOOTSTRAP_CONFIG_PATH, CACHE_DB_PATH, DEFAULT_REDIS_URL, logger

try:
    import redis
    from redis.exceptions import RedisError
    HAS_REDIS_LIB = True
except ImportError:
    redis = None
    RedisError = Exception
    HAS_REDIS_LIB = False


class SQLiteCacheBackend:
    """
    高性能 SQLite WAL 本地缓存引擎：
    当未配置 Redis 或 Redis 异常不可达时自动接管 KV 缓存、TTL 过期与原子流量累加。
    """

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

    def delete(self, key: str):
        with self._lock:
            conn = self._connect()
            try:
                conn.execute("DELETE FROM cache_entries WHERE k=?", (key,))
                conn.commit()
            finally:
                conn.close()

    def incr_window(self, key: str, window_sec: int, delta: int = 1) -> tuple[int, int]:
        """固定时间窗口原子递增计数器，返回 (当前计数, 窗口剩余秒数)"""
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
                    conn.execute(
                        "UPDATE cache_entries SET v=? WHERE k=?",
                        (str(new_val), key),
                    )
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
                rows = cur.fetchall()
                return {str(f): int(v or 0) for f, v in rows if int(v or 0) != 0}
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
                    chunk = unique_keys[i:i + 400]
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
                    chunk = unique_keys[i:i + 400]
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
    """
    统一缓存与高频计数器管理中心：
    1. 优先接入 Redis (连接池 + 1.5s 快速超时熔断)
    2. 未配置 Redis 或 Redis 异常时，自动零感回退至 SQLite WAL Cache (/data/cache.db)
    3. 断线冷却期 (30s) 后自动探测恢复 Redis 连接
    """

    def __init__(self):
        self._sqlite_cache = SQLiteCacheBackend(CACHE_DB_PATH)
        self._redis_client = None
        self._redis_url = ""
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

    def _resolve_redis_url(self) -> tuple[str, str]:
        if os.path.exists(BOOTSTRAP_CONFIG_PATH):
            try:
                with open(BOOTSTRAP_CONFIG_PATH, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict) and "redis_url" in data:
                    return str(data.get("redis_url") or "").strip(), "bootstrap"
            except Exception:
                pass
        if DEFAULT_REDIS_URL:
            return DEFAULT_REDIS_URL, "env"
        return "", "default"

    def reload_from_config(self, redis_url: Optional[str] = None, source: Optional[str] = None) -> str:
        if redis_url is None:
            target_url, resolved_source = self._resolve_redis_url()
        else:
            target_url = str(redis_url).strip()
            resolved_source = source or "bootstrap"

        with self._lock:
            old_client = self._redis_client
            self._redis_url = target_url
            self._config_source = resolved_source
            self._redis_client = None
            self._last_error = ""
            self._last_probe_ts = time.monotonic()

            if old_client is not None:
                try:
                    old_client.close()
                except Exception:
                    pass

            if not target_url:
                self._active_backend = "sqlite_cache"
                logger.info(f"💾 [Cache] 未配置 Redis，启用内置 SQLite WAL Cache ({CACHE_DB_PATH})")
                return self._active_backend

            if not HAS_REDIS_LIB:
                self._active_backend = "sqlite_cache"
                self._last_error = "redis Python 库未安装"
                logger.warning("⚠️ [Cache] 缺少 redis 库，自动回退至 SQLite Cache")
                return self._active_backend

            try:
                client = redis.Redis.from_url(
                    target_url,
                    decode_responses=True,
                    socket_connect_timeout=1.5,
                    socket_timeout=1.5,
                    health_check_interval=30,
                )
                client.ping()
                self._redis_client = client
                self._active_backend = "redis"
                logger.info("⚡ [Cache] Redis 高速缓存已连通并激活 (支持故障自动回退 SQLite Cache)")
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
        if self._redis_url and (time.monotonic() - self._last_probe_ts) >= self._probe_cooldown_sec:
            self.reload_from_config(self._redis_url)
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
                val = r.get(key)
                if val is not None:
                    self._hits += 1
                else:
                    self._misses += 1
                return val
            except Exception as exc:
                self._trip_fallback(exc)

        val = self._sqlite_cache.get(key)
        if val is not None:
            self._hits += 1
        else:
            self._misses += 1
        return val

    def set(self, key: str, value: Any, ttl: Optional[int] = None):
        str_val = str(value)
        r = self._get_redis()
        if r is not None:
            try:
                if ttl and ttl > 0:
                    r.setex(key, int(ttl), str_val)
                else:
                    r.set(key, str_val)
                return
            except Exception as exc:
                self._trip_fallback(exc)
        self._sqlite_cache.set(key, str_val, ttl=ttl)

    def delete(self, key: str):
        r = self._get_redis()
        if r is not None:
            try:
                r.delete(key)
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
        """固定时间窗口原子递增计数器，返回 (当前计数, 窗口剩余秒数)"""
        win = max(1, int(window_sec or 60))
        step = int(delta or 1)
        r = self._get_redis()
        if r is not None:
            try:
                res = r.eval(self._LUA_INCR_WINDOW, 1, key, step, win)
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
                return int(r.hincrby(hkey, field, int(delta)))
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
                    for field, delta in fields.items():
                        d = int(delta or 0)
                        if d:
                            pipe.hincrby(hkey, field, d)
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
                    if ttl and ttl > 0:
                        pipe.setex(k, int(ttl), raw)
                    else:
                        pipe.set(k, raw)
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
                vals = r.mget(keys)
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
        """原子读取并清零缓冲计数器（先从当前激活后端取，同时顺便排空 SQLite 回退缓冲避免切回 Redis 后丢失）"""
        merged: Dict[str, int] = {}

        sqlite_leftover = self._sqlite_cache.hgetall_and_reset(hkey)
        for k, v in sqlite_leftover.items():
            merged[k] = merged.get(k, 0) + v

        r = self._get_redis()
        if r is not None:
            try:
                pipe = r.pipeline()
                pipe.hgetall(hkey)
                pipe.delete(hkey)
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
                res = r.hgetall(hkey)
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
                    pipe.hgetall(hk)
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
                for k in r.scan_iter(match=f"{prefix}*", count=200):
                    found.add(str(k))
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

        redis_configured = bool(self._redis_url)
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

        return {
            "active_backend": self._active_backend,
            "engine_state": engine_state,
            "engine_label": engine_label,
            "degraded": degraded,
            "config_source": self._config_source,
            "has_redis_lib": HAS_REDIS_LIB,
            "redis_configured": redis_configured,
            "redis_connected": redis_connected,
            "redis_url_masked": self.mask_redis_url(self._redis_url),
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
        if not self._redis_url:
            return {
                "ok": False,
                "detail": "当前未配置 Redis URL，处于内置 SQLite WAL Cache 模式",
                "cache": self.get_status(),
            }
        self.reload_from_config(self._redis_url, source=self._config_source)
        status = self.get_status()
        if status["engine_state"] == "redis":
            info = status.get("redis_info") or {}
            ver = info.get("version") or "?"
            ping_ms = info.get("ping_ms")
            lat_txt = f", {ping_ms}ms" if ping_ms is not None else ""
            return {
                "ok": True,
                "message": f"Redis 已恢复连接 (v{ver}{lat_txt})",
                "cache": status,
            }
        return {
            "ok": False,
            "detail": f"Redis 仍不可达 ({status.get('last_error') or '连接失败'})，继续使用 SQLite WAL Cache 兜底",
            "cache": status,
        }

    def test_target(self, redis_url: str = "", use_current: bool = False) -> dict:
        url = (redis_url or "").strip()
        if not url and use_current:
            url = self._redis_url
            if not url:
                return {"ok": False, "pong": False, "detail": "当前尚未配置 Redis URL，请先输入连接串"}
        return self.test_connection(url)

    @staticmethod
    def test_connection(redis_url: str) -> dict:
        url = (redis_url or "").strip()
        if not url:
            return {"ok": False, "pong": False, "detail": "Redis URL 不能为空"}
        if not HAS_REDIS_LIB:
            return {"ok": False, "pong": False, "detail": "后端未安装 redis 依赖包"}
        client = None
        t0 = time.perf_counter()
        try:
            client = redis.Redis.from_url(
                url,
                decode_responses=True,
                socket_connect_timeout=2.5,
                socket_timeout=2.5,
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
                "message": f"PONG · Redis 连接成功 (v{ver}, {lat}ms{mem_suffix})",
            }
        except Exception as exc:
            return {"ok": False, "pong": False, "detail": f"Redis PING 失败: {exc}"}
        finally:
            if client is not None:
                try:
                    client.close()
                except Exception:
                    pass


cache_mgr = CacheManager()
