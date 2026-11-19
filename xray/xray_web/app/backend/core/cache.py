# -*- coding: utf-8 -*-
"""
统一缓存引擎 (Redis 优先 + SQLAlchemy kv_cache 自动透明回退)
设计目标：
1. 未配置 REDIS_URL/REDIS_HOST 时零开销直接使用数据库 kv_cache 表（兼容 SQLite 与 MySQL，多 Worker 共享）。
2. 已配置 Redis 时优先走 Redis；一旦连接超时、认证失败或运行中宕机，自动触发熔断冷却并将读写平滑回退至 SQL kv_cache，绝不中断主业务。
3. 熔断冷却期满后自动探测 Redis，恢复后无缝切回 Redis 加速。
"""
import json
import threading
import time
from typing import Any, Callable, Optional

from sqlalchemy import delete, func, select, text

from config import Config
from core.db import db_session, upsert_kv_cache
from core.models import KvCache

try:
    import redis as redis_lib
except ImportError:
    redis_lib = None


class CacheManager:
    def __init__(self):
        self._lock = threading.RLock()
        self._client = None
        self._client_url: str = ""
        self._last_attempted_url: str = ""
        self._cooldown_until: float = 0.0
        self._was_degraded: bool = False
        self._last_error: str = ""
        self._sql_dirty: bool = False

    def _prefixed(self, key: str) -> str:
        prefix = Config.normalize_redis_key_prefix(Config.REDIS_KEY_PREFIX)
        return f"{prefix}{key}"

    def _close_client_locked(self):
        old = self._client
        self._client = None
        self._client_url = ""
        if old is not None:
            try:
                old.close()
            except Exception:
                pass

    def reset_client(self):
        with self._lock:
            self._close_client_locked()
            self._last_attempted_url = ""
            self._cooldown_until = 0.0
            self._was_degraded = False
            self._last_error = ""

    def _get_redis(self):
        if redis_lib is None:
            return None
        url = Config.effective_redis_url()
        if not url:
            if self._client is not None or self._client_url or self._last_attempted_url:
                with self._lock:
                    self._close_client_locked()
                    self._last_attempted_url = ""
                    self._cooldown_until = 0.0
                    self._was_degraded = False
                    self._last_error = ""
            return None

        now = time.monotonic()
        if url == self._last_attempted_url and now < self._cooldown_until:
            return None

        with self._lock:
            url = Config.effective_redis_url()
            if not url:
                self._close_client_locked()
                self._last_attempted_url = ""
                self._cooldown_until = 0.0
                self._was_degraded = False
                self._last_error = ""
                return None

            now = time.monotonic()
            # 若目标 Redis 地址发生变更，立即清除旧冷却状态以实现多 Worker 秒级热切换
            if url != self._last_attempted_url:
                self._cooldown_until = 0.0
                self._last_error = ""
            elif now < self._cooldown_until:
                return None

            if self._client is not None and self._client_url == url:
                return self._client

            self._last_attempted_url = url
            try:
                client = redis_lib.Redis.from_url(
                    url,
                    socket_connect_timeout=Config.REDIS_TIMEOUT,
                    socket_timeout=Config.REDIS_TIMEOUT,
                    decode_responses=True,
                    health_check_interval=30,
                )
                client.ping()
                self._close_client_locked()
                self._client = client
                self._client_url = url
                self._last_error = ""
                self._cooldown_until = 0.0
                if self._was_degraded:
                    print("==> [Cache] Redis 连接已恢复，重新启用 Redis 加速！", flush=True)
                    self._was_degraded = False
                return self._client
            except Exception as exc:
                self._trip_breaker(exc)
                return None

    def _trip_breaker(self, exc: Exception):
        with self._lock:
            self._close_client_locked()
            self._cooldown_until = time.monotonic() + max(5, Config.REDIS_COOLDOWN_SECONDS)
            self._sql_dirty = True
            self._last_error = str(exc)[:300]
            if not self._was_degraded:
                print(f"==> [Cache] Redis 不可用 ({exc})，已自动降级回退至 SQL Cache", flush=True)
                self._was_degraded = True

    def _mark_redis_ok(self):
        if self._was_degraded or self._last_error:
            with self._lock:
                self._last_error = ""
                if self._was_degraded:
                    print("==> [Cache] Redis 连接已恢复，重新启用 Redis 加速！", flush=True)
                    self._was_degraded = False

    # -------------------- SQLAlchemy kv_cache 回退实现 (兼容 SQLite + MySQL) --------------------

    def _sql_get(self, key: str) -> Optional[str]:
        now = time.time()
        expired = False
        with db_session(readonly=True) as s:
            row = s.get(KvCache, key)
            if not row:
                return None
            exp = float(row.expire_at or 0.0)
            if exp > 0 and exp <= now:
                expired = True
            else:
                return row.cache_val
        if expired:
            with db_session() as s:
                s.execute(delete(KvCache).where(KvCache.cache_key == key, KvCache.expire_at > 0, KvCache.expire_at <= now))
        return None

    def _sql_set(self, key: str, value: str, ttl: int = 0) -> bool:
        self._sql_dirty = True
        expire_at = (time.time() + ttl) if ttl > 0 else 0.0
        with db_session() as s:
            upsert_kv_cache(s, key, value, expire_at)
        return True

    def _sql_delete(self, *keys: str) -> int:
        if not keys:
            return 0
        key_list = list(keys)
        with db_session(readonly=True) as s:
            has_any = s.scalar(select(KvCache.cache_key).where(KvCache.cache_key.in_(key_list)).limit(1))
        if not has_any:
            return 0
        with db_session() as s:
            res = s.execute(delete(KvCache).where(KvCache.cache_key.in_(key_list)))
            return int(res.rowcount or 0)

    def _sql_delete_prefix(self, prefix: str) -> int:
        like_pattern = f"{prefix}%"
        with db_session(readonly=True) as s:
            has_any = s.scalar(select(KvCache.cache_key).where(KvCache.cache_key.like(like_pattern)).limit(1))
        if not has_any:
            return 0
        with db_session() as s:
            res = s.execute(delete(KvCache).where(KvCache.cache_key.like(like_pattern)))
            return int(res.rowcount or 0)

    def _sql_pop(self, key: str) -> Optional[str]:
        now = time.time()
        with db_session() as s:
            bind = s.get_bind()
            dialect = bind.dialect.name.lower() if bind else "sqlite"
            if dialect == "sqlite":
                try:
                    row = s.execute(
                        text("DELETE FROM kv_cache WHERE cache_key = :k RETURNING cache_val, expire_at"),
                        {"k": key},
                    ).first()
                    if not row:
                        return None
                    val, exp_raw = row[0], row[1]
                    exp = float(exp_raw or 0.0)
                    if exp > 0 and exp <= now:
                        return None
                    return val
                except Exception:
                    pass
            stmt = select(KvCache).where(KvCache.cache_key == key).with_for_update()
            row = s.scalar(stmt)
            if not row:
                return None
            val = row.cache_val
            exp = float(row.expire_at or 0.0)
            s.delete(row)
            if exp > 0 and exp <= now:
                return None
            return val

    def _sql_incr_with_ttl(self, key: str, ttl: int) -> int:
        now = time.time()
        new_exp = (now + ttl) if ttl > 0 else 0.0
        with db_session() as s:
            bind = s.get_bind()
            dialect = bind.dialect.name.lower() if bind else "sqlite"
            if dialect == "sqlite":
                row_val = s.execute(
                    text(
                        "INSERT INTO kv_cache (cache_key, cache_val, expire_at) "
                        "VALUES (:k, '1', :exp) "
                        "ON CONFLICT(cache_key) DO UPDATE SET "
                        "cache_val = CASE "
                        "  WHEN (kv_cache.expire_at > 0 AND kv_cache.expire_at <= :now) "
                        "    OR (kv_cache.expire_at = 0 AND :exp > 0) THEN '1' "
                        "  ELSE CAST(CAST(kv_cache.cache_val AS INTEGER) + 1 AS TEXT) "
                        "END, "
                        "expire_at = CASE "
                        "  WHEN (kv_cache.expire_at > 0 AND kv_cache.expire_at <= :now) "
                        "    OR (kv_cache.expire_at = 0 AND :exp > 0) THEN :exp "
                        "  ELSE kv_cache.expire_at "
                        "END "
                        "RETURNING cache_val"
                    ),
                    {"k": key, "exp": new_exp, "now": now},
                ).scalar()
                try:
                    return max(1, int(row_val or 1))
                except (TypeError, ValueError):
                    return 1

            # MySQL / MariaDB InnoDB 单语句原子递增
            res = s.execute(
                text(
                    "INSERT INTO kv_cache (cache_key, cache_val, expire_at) "
                    "VALUES (:k, '1', :exp) "
                    "ON DUPLICATE KEY UPDATE "
                    "cache_val = CAST(LAST_INSERT_ID("
                    "  CASE WHEN (expire_at > 0 AND expire_at <= :now) OR (expire_at = 0 AND :exp > 0) "
                    "  THEN 1 ELSE COALESCE(CAST(cache_val AS SIGNED), 0) + 1 END"
                    ") AS CHAR), "
                    "expire_at = CASE WHEN (expire_at > 0 AND expire_at <= :now) OR (expire_at = 0 AND :exp > 0) "
                    "THEN :exp ELSE expire_at END"
                ),
                {"k": key, "exp": new_exp, "now": now},
            )
            if int(res.rowcount or 0) <= 1:
                return 1
            last_id = s.execute(text("SELECT LAST_INSERT_ID()")).scalar()
            return max(1, int(last_id or 1))

    # -------------------- 统一公开接口 --------------------

    def get(self, key: str) -> Optional[str]:
        r = self._get_redis()
        if r is not None:
            try:
                val = r.get(self._prefixed(key))
                self._mark_redis_ok()
                return val
            except Exception as exc:
                self._trip_breaker(exc)
        return self._sql_get(key)

    def set(self, key: str, value: str, ttl: int = 0) -> bool:
        r = self._get_redis()
        if r is not None:
            try:
                if ttl > 0:
                    r.setex(self._prefixed(key), ttl, value)
                else:
                    r.set(self._prefixed(key), value)
                self._mark_redis_ok()
                return True
            except Exception as exc:
                self._trip_breaker(exc)
        return self._sql_set(key, value, ttl=ttl)

    def delete(self, *keys: str) -> int:
        if not keys:
            return 0
        r = self._get_redis()
        if r is not None:
            try:
                prefixed = [self._prefixed(k) for k in keys]
                res = int(r.delete(*prefixed))
                self._mark_redis_ok()
                if self._sql_dirty:
                    try:
                        self._sql_delete(*keys)
                    except Exception:
                        pass
                return res
            except Exception as exc:
                self._trip_breaker(exc)
        return self._sql_delete(*keys)

    def delete_prefix(self, prefix: str) -> int:
        r = self._get_redis()
        if r is not None:
            try:
                pattern = f"{self._prefixed(prefix)}*"
                total = 0
                batch = []
                for k in r.scan_iter(match=pattern, count=200):
                    batch.append(k)
                    if len(batch) >= 200:
                        total += int(r.delete(*batch))
                        batch.clear()
                if batch:
                    total += int(r.delete(*batch))
                self._mark_redis_ok()
                if self._sql_dirty:
                    try:
                        self._sql_delete_prefix(prefix)
                    except Exception:
                        pass
                return total
            except Exception as exc:
                self._trip_breaker(exc)
        return self._sql_delete_prefix(prefix)

    def get_json(self, key: str) -> Any:
        raw = self.get(key)
        if raw is None:
            return None
        try:
            return json.loads(raw)
        except Exception:
            return None

    def set_json(self, key: str, value: Any, ttl: int = 0) -> bool:
        return self.set(key, json.dumps(value, ensure_ascii=False), ttl=ttl)

    def pop_json(self, key: str) -> Any:
        raw: Optional[str] = None
        r = self._get_redis()
        if r is not None:
            try:
                pkey = self._prefixed(key)
                try:
                    raw = r.getdel(pkey)
                except Exception:
                    pipe = r.pipeline()
                    pipe.get(pkey)
                    pipe.delete(pkey)
                    res = pipe.execute()
                    raw = res[0] if res else None
                self._mark_redis_ok()
                if raw is None:
                    return None
                try:
                    return json.loads(raw)
                except Exception:
                    return None
            except Exception as exc:
                self._trip_breaker(exc)
        raw = self._sql_pop(key)
        if raw is None:
            return None
        try:
            return json.loads(raw)
        except Exception:
            return None

    _INCR_TTL_LUA = (
        "local v = redis.call('INCR', KEYS[1]) "
        "local ttl = tonumber(ARGV[1]) "
        "if ttl and ttl > 0 then "
        "  if v == 1 or redis.call('TTL', KEYS[1]) == -1 then "
        "    redis.call('EXPIRE', KEYS[1], ttl) "
        "  end "
        "end "
        "return v"
    )

    def incr_with_ttl(self, key: str, ttl: int) -> int:
        r = self._get_redis()
        if r is not None:
            try:
                pkey = self._prefixed(key)
                val = int(r.eval(self._INCR_TTL_LUA, 1, pkey, int(ttl or 0)))
                self._mark_redis_ok()
                return val
            except Exception as exc:
                self._trip_breaker(exc)
        return self._sql_incr_with_ttl(key, ttl)

    def get_or_set_json(self, key: str, loader: Callable[[], Any], ttl: int = 30) -> Any:
        cached = self.get_json(key)
        if cached is not None:
            return cached
        data = loader()
        if data is not None:
            try:
                self.set_json(key, data, ttl=ttl)
            except Exception:
                pass
        return data

    def cleanup_expired_sql(self) -> int:
        """定期清理数据库 kv_cache 中已过期条目"""
        now = time.time()
        try:
            with db_session() as s:
                res = s.execute(delete(KvCache).where(KvCache.expire_at > 0, KvCache.expire_at <= now))
                return int(res.rowcount or 0)
        except Exception:
            return 0

    def status(self) -> dict:
        configured = bool(redis_lib is not None and Config.effective_redis_url())
        if not configured:
            return {
                "configured": False,
                "backend": "sql_cache",
                "redis_healthy": False,
                "cooldown_remaining": 0,
                "last_error": "",
            }
        now = time.monotonic()
        url = Config.effective_redis_url()
        if url == self._last_attempted_url and now < self._cooldown_until:
            return {
                "configured": True,
                "backend": "sql_cache",
                "redis_healthy": False,
                "cooldown_remaining": max(1, int(self._cooldown_until - now)),
                "last_error": self._last_error,
            }
        healthy = self._get_redis() is not None
        return {
            "configured": True,
            "backend": "redis" if healthy else "sql_cache",
            "redis_healthy": healthy,
            "cooldown_remaining": 0 if healthy else max(0, int(self._cooldown_until - time.monotonic())),
            "last_error": "" if healthy else self._last_error,
        }

    def detailed_status(self) -> dict:
        """返回供管理后台监控面板展示的完整缓存引擎遥测状态"""
        base = self.status()
        sql_entries = 0
        try:
            now_ts = time.time()
            with db_session(readonly=True) as s:
                sql_entries = int(
                    s.scalar(
                        select(func.count(KvCache.cache_key)).where(
                            (KvCache.expire_at == 0) | (KvCache.expire_at > now_ts)
                        )
                    )
                    or 0
                )
        except Exception:
            sql_entries = 0

        details = {
            **base,
            "redis_lib_available": redis_lib is not None,
            "sql_cache_entries": sql_entries,
            "ping_ms": None,
            "redis_version": "",
            "used_memory_human": "",
            "connected_clients": None,
            "dbsize": None,
        }

        if base.get("backend") == "redis":
            r = self._get_redis()
            if r is not None:
                try:
                    t0 = time.perf_counter()
                    r.ping()
                    details["ping_ms"] = round((time.perf_counter() - t0) * 1000, 2)
                except Exception as exc:
                    self._trip_breaker(exc)
                    details["backend"] = "sql_cache"
                    details["redis_healthy"] = False
                    details["last_error"] = self._last_error
                    details["cooldown_remaining"] = max(1, int(self._cooldown_until - time.monotonic()))
                    return details
                try:
                    info_srv = r.info("server")
                    details["redis_version"] = str(info_srv.get("redis_version") or "")
                except Exception:
                    pass
                try:
                    info_mem = r.info("memory")
                    details["used_memory_human"] = str(info_mem.get("used_memory_human") or "")
                except Exception:
                    pass
                try:
                    info_cli = r.info("clients")
                    if "connected_clients" in info_cli:
                        details["connected_clients"] = int(info_cli["connected_clients"])
                except Exception:
                    pass
                try:
                    details["dbsize"] = int(r.dbsize())
                except Exception:
                    pass
        return details


def test_redis_connection(redis_url: str) -> tuple[bool, str]:
    """供安装向导与管理后台测试 Redis 连通性"""
    redis_url = Config.normalize_redis_url(redis_url)
    if not redis_url:
        return False, "请填写有效的 Redis URL 或主机地址"
    if redis_lib is None:
        return False, "当前环境未安装 redis Python 客户端库"
    client = None
    try:
        client = redis_lib.Redis.from_url(
            redis_url,
            socket_connect_timeout=2.0,
            socket_timeout=2.0,
            decode_responses=True,
        )
        t0 = time.perf_counter()
        pong = client.ping()
        rtt_ms = round((time.perf_counter() - t0) * 1000, 2)
        if not pong:
            return False, "Redis 未返回 PONG"
        ver_str = ""
        try:
            ver = client.info("server").get("redis_version")
            if ver:
                ver_str = f"，Redis {ver}"
        except Exception:
            pass
        return True, f"Redis PING 响应成功（延迟 {rtt_ms} ms{ver_str}）"
    except Exception as exc:
        err_text = str(exc)
        upper_err = err_text.upper()
        if "PROTECTED MODE" in upper_err:
            return False, (
                f"Redis 服务端处于保护模式（服务端当前未生效任何密码，且拒绝非 127.0.0.1 外部连接）: {err_text}。"
                "请在 Redis 服务端确认已实际加载密码（用 redis-cli 执行 CONFIG GET requirepass 检查是否为空；"
                "若用 Docker 启动请加 --requirepass，宿主机安装请确认 redis-server 加载了含 requirepass 的配置文件并已重启）"
            )
        if (
            "WRONGPASS" in upper_err
            or "INVALID PASSWORD" in upper_err
            or "NOAUTH" in upper_err
            or "ERR AUTH" in upper_err
            or "ERR CLIENT SENT AUTH" in upper_err
        ):
            return False, (
                f"Redis 认证失败: {err_text}（若密码含 # / ! / @，请确认 redis.conf 中 requirepass "
                "已用双引号包裹，否则 # 后的字符会被 Redis 当作注释截断）"
            )
        return False, f"Redis 连接测试失败: {err_text}"
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                pass


cache = CacheManager()
