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

# 全局与分场景阈值（均可通过环境变量热调，兼顾 300+ 节点集群高并发与防刷安全）
RATE_LIMIT_GLOBAL_PER_MIN = _env_int("RATE_LIMIT_GLOBAL_PER_MIN", 360)
RATE_LIMIT_CAPTCHA_PER_MIN = _env_int("RATE_LIMIT_CAPTCHA_PER_MIN", 30)
RATE_LIMIT_LOGIN_PER_MIN = _env_int("RATE_LIMIT_LOGIN_PER_MIN", 15)
RATE_LIMIT_SETUP_PER_MIN = _env_int("RATE_LIMIT_SETUP_PER_MIN", 15)
RATE_LIMIT_DETECT_PER_MIN = _env_int("RATE_LIMIT_DETECT_PER_MIN", 20)
RATE_LIMIT_REGISTER_PER_MIN = _env_int("RATE_LIMIT_REGISTER_PER_MIN", 40)
RATE_LIMIT_API_V1_PER_MIN = _env_int("RATE_LIMIT_API_V1_PER_MIN", 240)
RATE_LIMIT_CDP_PER_MIN = _env_int("RATE_LIMIT_CDP_PER_MIN", 120)

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
MAX_PENDING_TOFU_NODES = _env_int("MAX_PENDING_TOFU_NODES", 200)
MAX_PENDING_TOFU_PER_IP = _env_int("MAX_PENDING_TOFU_PER_IP", 10)

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
            stale = [k for k, ts in _last_log_ts.items() if ts < cutoff]
            for k in stale:
                _last_log_ts.pop(k, None)
    logger.warning(msg)


def normalize_ip(raw_ip: Optional[str]) -> str:
    txt = (raw_ip or "").strip()
    if not txt:
        return "unknown"
    if txt.startswith("[") and "]" in txt:
        txt = txt[1:txt.index("]")]
    elif txt.count(":") == 1 and "." in txt:
        # IPv4:port
        txt = txt.rsplit(":", 1)[0]
    try:
        ip_obj = ipaddress.ip_address(txt)
        if isinstance(ip_obj, ipaddress.IPv6Address) and ip_obj.ipv4_mapped:
            return str(ip_obj.ipv4_mapped)
        return str(ip_obj)
    except ValueError:
        return txt[:64] or "unknown"


def get_client_ip(conn: Any) -> str:
    """统一提取真实客户端 IP（适配直连、IPv6 及 Nginx/宝塔反代透传头）"""
    if conn is None:
        return "unknown"
    headers = getattr(conn, "headers", None)
    if headers is not None:
        x_real = (headers.get("x-real-ip") or "").strip()
        if x_real:
            return normalize_ip(x_real)
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
    """检查固定时间窗口是否超限，返回 (是否放行, 当前计数, 剩余重置秒数)"""
    if not RATE_LIMIT_ENABLED or limit <= 0:
        return True, 0, 0
    key = f"rl:{scope}:{subject}"
    count, retry_after = cache_mgr.incr_window(key, window_sec, 1)
    if count > limit:
        _record_stat(f"rl:{scope}")
        _throttled_warn(
            f"rl:{scope}:{subject}",
            f"🛡️ [防刷限流] scope={scope} subject={subject} 触发频率限制 ({count}/{limit} in {window_sec}s)",
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
    """
    记录一次认证/校验失败；达到阈值自动临时封禁，若多次触发阈值则翻倍封禁时长（上限 1 小时）。
    返回 (累计失败次数, 当前剩余封禁秒数)。
    """
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
            f"🚫 [防爆破封禁] scope={scope} subject={subject} 连续失败 {fails} 次，已封禁 {actual_block}s",
            cooldown_sec=10.0,
        )
        return fails, actual_block
    return fails, 0


def clear_auth_failures(scope: str, subject: str):
    cache_mgr.delete(f"fail:{scope}:{subject}")
    cache_mgr.delete(f"blk:{scope}:{subject}")


def check_tofu_quota(pending_global_count: int, client_ip: str) -> Tuple[bool, str]:
    """
    TOFU 待审队列防洪水保护：
    1. 全局待审队列达到上限 (默认 200) 时拒绝陌生无 Token 节点入库；
    2. 单 IP 短时待审建档超过上限 (默认 10) 时拦截恶意 UUID 洪水攻击。
    """
    if not RATE_LIMIT_ENABLED:
        return True, ""
    if pending_global_count >= MAX_PENDING_TOFU_NODES:
        _record_stat("tofu_global_cap")
        _throttled_warn(
            "tofu_global_cap",
            f"🛡️ [TOFU 防洪水] 全局待审批节点已达上限 ({pending_global_count}/{MAX_PENDING_TOFU_NODES})，已拒绝新陌生节点入队",
        )
        return False, "待审批队列已满，请先由管理员清理或配置有效 JOIN_TOKEN"

    allowed, _, _ = check_rate_limit(
        "tofu_ip_pending",
        client_ip,
        MAX_PENDING_TOFU_PER_IP,
        window_sec=1800,
    )
    if not allowed:
        _record_stat("tofu_ip_cap")
        return False, "当前来源 IP 待审节点申请过多，请使用 JOIN_TOKEN 接入或稍后再试"

    return True, ""


class WebSocketConcurrencyGuard:
    """进程内 WebSocket 单 IP 并发连接槽位控制，防止恶意建连打爆文件描述符"""

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
                _throttled_warn(
                    f"ws_cap:{scope}:{client_ip}",
                    f"🛡️ [WS 并发拦截] scope={scope} ip={client_ip} 并发连接已达上限 ({curr}/{max_concurrent})",
                )
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
            "login_max_failures": LOGIN_MAX_FAILURES,
            "detect_per_min": RATE_LIMIT_DETECT_PER_MIN,
            "register_per_min": RATE_LIMIT_REGISTER_PER_MIN,
            "api_v1_per_min": RATE_LIMIT_API_V1_PER_MIN,
            "cdp_per_min": RATE_LIMIT_CDP_PER_MIN,
            "max_ws_tunnels_per_ip": MAX_WS_TUNNELS_PER_IP,
            "max_ws_cdp_per_ip": MAX_WS_CDP_PER_IP,
            "max_pending_tofu_nodes": MAX_PENDING_TOFU_NODES,
            "max_pending_tofu_per_ip": MAX_PENDING_TOFU_PER_IP,
        },
        "active_ws_connections": ws_guard.snapshot(),
        "blocked_events": raw_stats,
    }
