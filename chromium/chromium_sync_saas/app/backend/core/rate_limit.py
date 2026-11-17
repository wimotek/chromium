import ipaddress
import os
import threading
import time
from typing import Any, Dict, Optional, Tuple

from fastapi import HTTPException

from config import logger
from core.cache import cache_mgr


def _env_bool(name: str, default: bool = True) -> bool:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off"}


def _env_int(name: str, default: int, min_val: int = 1) -> int:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        return max(min_val, int(raw))
    except ValueError:
        return default


RATE_LIMIT_ENABLED = _env_bool("HUB_RATE_LIMIT_ENABLED", True)

# SaaS 公共运营场景限流与防爆破阈值（已彻底剔除任何 TOFU 配额逻辑）
RATE_LIMIT_GLOBAL_PER_MIN = _env_int("RATE_LIMIT_GLOBAL_PER_MIN", 360)
RATE_LIMIT_CAPTCHA_PER_MIN = _env_int("RATE_LIMIT_CAPTCHA_PER_MIN", 30)
RATE_LIMIT_LOGIN_PER_MIN = _env_int("RATE_LIMIT_LOGIN_PER_MIN", 15)
RATE_LIMIT_ACCOUNT_REGISTER_PER_MIN = _env_int("RATE_LIMIT_ACCOUNT_REGISTER_PER_MIN", 6)
RATE_LIMIT_SETUP_PER_MIN = _env_int("RATE_LIMIT_SETUP_PER_MIN", 15)
RATE_LIMIT_DETECT_PER_MIN = _env_int("RATE_LIMIT_DETECT_PER_MIN", 20)
RATE_LIMIT_REGISTER_PER_MIN = _env_int("RATE_LIMIT_REGISTER_PER_MIN", 40)
RATE_LIMIT_API_V1_PER_MIN = _env_int("RATE_LIMIT_API_V1_PER_MIN", 240)
RATE_LIMIT_CDP_PER_MIN = _env_int("RATE_LIMIT_CDP_PER_MIN", 120)
RATE_LIMIT_MARKET_PER_MIN = _env_int("RATE_LIMIT_MARKET_PER_MIN", 60)

LOGIN_MAX_FAILURES = _env_int("LOGIN_MAX_FAILURES", 5)
LOGIN_FAIL_WINDOW_SEC = _env_int("LOGIN_FAIL_WINDOW_SEC", 600)
LOGIN_BLOCK_SECONDS = _env_int("LOGIN_BLOCK_SECONDS", 300)

API_KEY_MAX_FAILURES = _env_int("API_KEY_MAX_FAILURES", 15)
API_KEY_FAIL_WINDOW_SEC = _env_int("API_KEY_FAIL_WINDOW_SEC", 300)
API_KEY_BLOCK_SECONDS = _env_int("API_KEY_BLOCK_SECONDS", 600)

JOIN_TOKEN_MAX_FAILURES = _env_int("JOIN_TOKEN_MAX_FAILURES", 8)
JOIN_TOKEN_FAIL_WINDOW_SEC = _env_int("JOIN_TOKEN_FAIL_WINDOW_SEC", 600)
JOIN_TOKEN_BLOCK_SECONDS = _env_int("JOIN_TOKEN_BLOCK_SECONDS", 900)

MAX_WS_TUNNELS_PER_IP = _env_int("MAX_WS_TUNNELS_PER_IP", 60)
MAX_WS_CDP_PER_IP = _env_int("MAX_WS_CDP_PER_IP", 60)

_STATS_HKEY = "hub:antispam:stats"

_log_throttle_lock = threading.Lock()
_last_log_ts: Dict[str, float] = {}


def _throttled_warn(tag: str, msg: str, cooldown_sec: float = 15.0):
    now = time.monotonic()
    with _log_throttle_lock:
        prev = _last_log_ts.get(tag, 0.0)
        if now - prev < cooldown_sec:
            return
        _last_log_ts[tag] = now
        if len(_last_log_ts) > 512:
            cutoff = now - cooldown_sec * 4
            for k in [k for k, ts in _last_log_ts.items() if ts < cutoff]:
                _last_log_ts.pop(k, None)
    logger.warning(msg)


def normalize_ip(raw_ip: Optional[str]) -> str:
    txt = (raw_ip or "").strip()
    if not txt:
        return "unknown"
    if txt.startswith("[") and "]" in txt:
        txt = txt[1 : txt.index("]")]
    elif txt.count(":") == 1 and "." in txt:
        txt = txt.rsplit(":", 1)[0]
    try:
        ip_obj = ipaddress.ip_address(txt)
        if isinstance(ip_obj, ipaddress.IPv6Address) and ip_obj.ipv4_mapped:
            return str(ip_obj.ipv4_mapped)
        return str(ip_obj)
    except ValueError:
        return txt[:64] or "unknown"


def get_client_ip(conn: Any) -> str:
    if conn is None:
        return "unknown"
    headers = getattr(conn, "headers", None)
    if headers is not None:
        for hdr_name in ("cf-connecting-ip", "true-client-ip", "x-real-ip"):
            val = (headers.get(hdr_name) or "").split(",")[0].strip()
            if val:
                return normalize_ip(val)
        x_fwd = (headers.get("x-forwarded-for") or "").split(",")[0].strip()
        if x_fwd:
            return normalize_ip(x_fwd)
    client = getattr(conn, "client", None)
    host = getattr(client, "host", None) if client else None
    return normalize_ip(host)


def is_loopback_ip(ip: str) -> bool:
    norm = normalize_ip(ip)
    if norm in {"127.0.0.1", "::1", "localhost"}:
        return True
    try:
        return ipaddress.ip_address(norm).is_loopback
    except ValueError:
        return False


def _record_stat(metric: str):
    try:
        cache_mgr.hincrby(_STATS_HKEY, metric, 1)
    except Exception:
        pass


def check_rate_limit(scope: str, subject: str, limit: int, window_sec: int = 60) -> Tuple[bool, int, int]:
    if not RATE_LIMIT_ENABLED or limit <= 0:
        return True, 0, 0
    key = f"rl:{scope}:{subject}"
    count, retry_after = cache_mgr.incr_window(key, window_sec, 1)
    if count > limit:
        _record_stat(f"rl:{scope}")
        _throttled_warn(
            f"rl:{scope}:{subject}",
            f"🛡️ [SaaS 防刷限流] scope={scope} subject={subject} ({count}/{limit} in {window_sec}s)",
        )
        return False, count, retry_after
    return True, count, retry_after


def enforce_rate_limit(
    scope: str,
    subject: str,
    limit: int,
    window_sec: int = 60,
    message: Optional[str] = None,
):
    allowed, _, retry_after = check_rate_limit(scope, subject, limit, window_sec)
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail=message or f"请求过于频繁，请 {retry_after} 秒后再试",
            headers={"Retry-After": str(max(1, retry_after))},
        )


def get_block_ttl(scope: str, subject: str) -> int:
    if not RATE_LIMIT_ENABLED:
        return 0
    raw = cache_mgr.get(f"blk:{scope}:{subject}")
    if not raw:
        return 0
    try:
        until_ts = float(raw)
        rem = int(until_ts - time.time())
        if rem > 0:
            return rem
    except (TypeError, ValueError):
        pass
    cache_mgr.delete(f"blk:{scope}:{subject}")
    return 0


def check_block(scope: str, subject: str, message: Optional[str] = None):
    rem = get_block_ttl(scope, subject)
    if rem > 0:
        _record_stat(f"blk_hit:{scope}")
        raise HTTPException(
            status_code=429,
            detail=message or f"失败次数过多，已被临时封禁，请 {rem} 秒后再试",
            headers={"Retry-After": str(rem)},
        )


def record_auth_failure(
    scope: str,
    subject: str,
    max_failures: int,
    fail_window_sec: int,
    block_sec: int,
) -> Tuple[int, int]:
    if not RATE_LIMIT_ENABLED:
        return 0, 0
    fails, _ = cache_mgr.incr_window(f"fail:{scope}:{subject}", fail_window_sec, 1)
    if fails >= max_failures:
        multiplier = min(4, max(1, fails // max_failures))
        actual_block = min(3600, block_sec * multiplier)
        until_ts = time.time() + actual_block
        cache_mgr.set(f"blk:{scope}:{subject}", f"{until_ts:.3f}", ttl=actual_block)
        _record_stat(f"blk_set:{scope}")
        _throttled_warn(
            f"blk:{scope}:{subject}",
            f"🚫 [SaaS 防爆破封禁] scope={scope} subject={subject} 连续失败 {fails} 次，封禁 {actual_block}s",
            cooldown_sec=10.0,
        )
        return fails, actual_block
    return fails, 0


def clear_auth_failures(scope: str, subject: str):
    cache_mgr.delete(f"fail:{scope}:{subject}")
    cache_mgr.delete(f"blk:{scope}:{subject}")


class WebSocketConcurrencyGuard:
    def __init__(self):
        self._lock = threading.Lock()
        self._counts: Dict[Tuple[str, str], int] = {}

    def acquire(self, scope: str, client_ip: str, max_concurrent: int) -> bool:
        if not RATE_LIMIT_ENABLED or max_concurrent <= 0:
            return True
        k = (scope, client_ip)
        with self._lock:
            curr = self._counts.get(k, 0)
            if curr >= max_concurrent:
                _record_stat(f"ws_cap:{scope}")
                return False
            self._counts[k] = curr + 1
            return True

    def release(self, scope: str, client_ip: str):
        if not RATE_LIMIT_ENABLED:
            return
        k = (scope, client_ip)
        with self._lock:
            curr = self._counts.get(k, 0)
            if curr <= 1:
                self._counts.pop(k, None)
            else:
                self._counts[k] = curr - 1

    def snapshot(self) -> Dict[str, int]:
        with self._lock:
            by_scope: Dict[str, int] = {}
            for (scope, _), cnt in self._counts.items():
                by_scope[scope] = by_scope.get(scope, 0) + cnt
            return by_scope


ws_guard = WebSocketConcurrencyGuard()


def get_antispam_stats() -> dict:
    raw_stats = cache_mgr.hgetall_readonly(_STATS_HKEY)
    return {
        "enabled": RATE_LIMIT_ENABLED,
        "limits": {
            "global_per_min": RATE_LIMIT_GLOBAL_PER_MIN,
            "login_per_min": RATE_LIMIT_LOGIN_PER_MIN,
            "account_register_per_min": RATE_LIMIT_ACCOUNT_REGISTER_PER_MIN,
            "login_max_failures": LOGIN_MAX_FAILURES,
            "detect_per_min": RATE_LIMIT_DETECT_PER_MIN,
            "register_per_min": RATE_LIMIT_REGISTER_PER_MIN,
            "api_v1_per_min": RATE_LIMIT_API_V1_PER_MIN,
            "cdp_per_min": RATE_LIMIT_CDP_PER_MIN,
            "market_per_min": RATE_LIMIT_MARKET_PER_MIN,
            "max_ws_tunnels_per_ip": MAX_WS_TUNNELS_PER_IP,
            "max_ws_cdp_per_ip": MAX_WS_CDP_PER_IP,
        },
        "active_ws_connections": ws_guard.snapshot(),
        "blocked_events": raw_stats,
    }
