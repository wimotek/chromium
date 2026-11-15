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

from sqlalchemy import delete, select

from config import Config
from core.db import db_session, upsert_kv_cache
from core.models import KvCache

try:
    import redis as redis_lib
except ImportError:
    redis_lib = None


class CacheManager:
    def __init__(self):
        self._lock = threading.Lock()
        self._client = None
        self._client_url: str = ""
        self._cooldown_until: float = 0.0
        self._was_degraded: bool = False

    def _prefixed(self, key: str) -> str:
        return f"{Config.REDIS_KEY_PREFIX}{key}"

    def reset_client(self):
        with self._lock:
            self._client = None
            self._client_url = ""
            self._cooldown_until = 0.0
            self._was_degraded = False

    def _get_redis(self):
        if redis_lib is None:
            return None
        url = Config.effective_redis_url()
        if not url:
            return None
        now = time.monotonic()
        if now < self._cooldown_until:
            return None

        with self._lock:
            url = Config.effective_redis_url()
            if not url:
                return None
            now = time.monotonic()
            if now < self._cooldown_until:
                return None
            if self._client is not None and self._client_url == url:
                return self._client
            try:
                client = redis_lib.Redis.from_url(
                    url,
                    socket_connect_timeout=Config.REDIS_TIMEOUT,
                    socket_timeout=Config.REDIS_TIMEOUT,
                    decode_responses=True,
                    health_check_interval=30,
                )
                client.ping()
                self._client = client
                self._client_url = url
                if self._was_degraded:
                    print("==> [Cache] Redis 连接已恢复，重新启用 Redis 加速！", flush=True)
                    self._was_degraded = False
                return self._client
            except Exception as exc:
                self._trip_breaker(exc)
                return None

    def _trip_breaker(self, exc: Exception):
        with self._lock:
            self._client = None
            self._cooldown_until = time.monotonic() + max(5, Config.REDIS_COOLDOWN_SECONDS)
            if not self._was_degraded:
                print(f"==> [Cache] Redis 不可用 ({exc})，已自动降级回退至 SQL Cache", flush=True)
                self._was_degraded = True

    def _mark_redis_ok(self):
        if self._was_degraded:
            with self._lock:
                if self._was_degraded:
                    print("==> [Cache] Redis 连接已恢复，重新启用 Redis 加速！", flush=True)
                    self._was_degraded = False

    # -------------------- SQLAlchemy kv_cache 回退实现 (兼容 SQLite + MySQL) --------------------

    def _sql_get(self, key: str) -> Optional[str]:
        now = time.time()
        with db_session() as s:
            row = s.get(KvCache, key)
            if not row:
                return None
            exp = float(row.expire_at or 0.0)
            if exp > 0 and exp <= now:
                s.delete(row)
                return None
            return row.cache_val

    def _sql_set(self, key: str, value: str, ttl: int = 0) -> bool:
        expire_at = (time.time() + ttl) if ttl > 0 else 0.0
        with db_session() as s:
            upsert_kv_cache(s, key, value, expire_at)
        return True

    def _sql_delete(self, *keys: str) -> int:
        if not keys:
            return 0
        with db_session() as s:
            res = s.execute(delete(KvCache).where(KvCache.cache_key.in_(list(keys))))
            return int(res.rowcount or 0)

    def _sql_delete_prefix(self, prefix: str) -> int:
        with db_session() as s:
            res = s.execute(delete(KvCache).where(KvCache.cache_key.like(f"{prefix}%")))
            return int(res.rowcount or 0)

    def _sql_pop(self, key: str) -> Optional[str]:
        now = time.time()
        with db_session() as s:
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
            stmt = select(KvCache).where(KvCache.cache_key == key).with_for_update()
            row = s.scalar(stmt)
            if row and ((row.expire_at or 0.0) == 0.0 or float(row.expire_at) > now):
                try:
                    val = int(row.cache_val) + 1
                except ValueError:
                    val = 1
                row.cache_val = str(val)
            else:
                val = 1
                upsert_kv_cache(s, key, str(val), new_exp)
            return val

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

    def incr_with_ttl(self, key: str, ttl: int) -> int:
        r = self._get_redis()
        if r is not None:
            try:
                pkey = self._prefixed(key)
                val = int(r.incr(pkey))
                if val == 1 and ttl > 0:
                    r.expire(pkey, ttl)
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
            }
        now = time.monotonic()
        if now < self._cooldown_until:
            return {
                "configured": True,
                "backend": "sql_cache",
                "redis_healthy": False,
                "cooldown_remaining": max(1, int(self._cooldown_until - now)),
            }
        healthy = self._get_redis() is not None
        return {
            "configured": True,
            "backend": "redis" if healthy else "sql_cache",
            "redis_healthy": healthy,
            "cooldown_remaining": 0 if healthy else max(0, int(self._cooldown_until - time.monotonic())),
        }


def test_redis_connection(redis_url: str) -> tuple[bool, str]:
    """供首次安装向导测试 Redis 连通性"""
    if not redis_url:
        return False, "请填写有效的 Redis URL 或主机地址"
    if redis_lib is None:
        return False, "当前环境未安装 redis Python 客户端库"
    try:
        client = redis_lib.Redis.from_url(
            redis_url,
            socket_connect_timeout=2.0,
            socket_timeout=2.0,
            decode_responses=True,
        )
        pong = client.ping()
        return (True, "Redis PING 响应成功") if pong else (False, "Redis 未返回 PONG")
    except Exception as exc:
        return False, f"Redis 连接测试失败: {exc}"


cache = CacheManager()
