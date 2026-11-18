# -*- coding: utf-8 -*-
"""
增强版防刷限流与风控拦截引擎（基于 core.cache 统一抽象：Redis Lua + SQLite/MySQL 原子 SQL 自动回退）
核心防护能力：
1. 可信代理校验 (Trusted Proxy Guard)：仅当直连来源为受信任回环/内网代理或 TRUST_PROXY=always 时解析 X-Forwarded-For，彻底堵死公网直连伪造请求头绕过限流
2. 滑动时间窗口限流 (Sliding Window Counter)：消除固定窗口边界“双倍突发”漏洞，并输出标准 X-RateLimit-* 响应头
3. 蜜罐即刻封禁 (Honeypot Auto-Ban) & 黑名单缓存：触发隐藏诱饵字段立即全域封禁 IP 30 分钟
4. 账号/目标邮箱多维度限流：即使攻击者使用代理池更换 IP，依然受目标账号锁定与目标邮箱日上限约束
"""
import functools
import ipaddress
import math
import time
from typing import Callable, Optional

from flask import g, has_request_context, jsonify, request

from config import Config
from core.cache import cache


_CF_CIDRS = (
    "173.245.48.0/20",
    "103.21.244.0/22",
    "103.22.200.0/22",
    "103.31.4.0/22",
    "141.101.64.0/18",
    "108.162.192.0/18",
    "190.93.240.0/20",
    "188.114.96.0/20",
    "197.234.240.0/22",
    "198.41.128.0/17",
    "162.158.0.0/15",
    "104.16.0.0/13",
    "104.24.0.0/14",
    "172.64.0.0/13",
    "131.0.72.0/22",
    "2400:cb00::/32",
    "2606:4700::/32",
    "2803:f800::/32",
    "2405:b500::/32",
    "2405:8100::/32",
    "2a06:98c0::/29",
    "2c0f:f248::/32",
)
_CF_NETWORKS = tuple(ipaddress.ip_network(c) for c in _CF_CIDRS)


def is_cloudflare_ip(ip_str: str) -> bool:
    clean = (ip_str or "").strip().strip("[]")
    if not clean:
        return False
    try:
        addr = ipaddress.ip_address(clean)
        return any(addr in net for net in _CF_NETWORKS)
    except ValueError:
        return False


def is_trusted_proxy_peer(peer_ip: str) -> bool:
    """判定底层 TCP 连接对端是否为可信反向代理或 Cloudflare 边缘节点（防止公网直连伪造 X-Forwarded-For）"""
    mode = (Config.TRUST_PROXY or "auto").strip().lower()
    if mode in ("always", "true", "1", "yes", "all"):
        return True
    if mode in ("never", "false", "0", "no"):
        return False

    clean = (peer_ip or "").strip().strip("[]")
    if not clean:
        return False
    try:
        addr = ipaddress.ip_address(clean)
        if mode in ("cloudflare", "cf"):
            return addr.is_loopback or addr.is_private or addr.is_link_local or is_cloudflare_ip(clean)
        return addr.is_loopback or addr.is_private or addr.is_link_local or is_cloudflare_ip(clean)
    except ValueError:
        return False


def is_valid_ip_literal(ip_str: str) -> bool:
    clean = (ip_str or "").strip().strip("[]")
    if not clean:
        return False
    try:
        ipaddress.ip_address(clean)
        return True
    except ValueError:
        return False


def get_client_ip(req=None) -> str:
    """安全提取客户端真实 IP：仅对受信任代理/Cloudflare 解包 CF-Connecting-IP 与透传头，防伪造绕过"""
    target_req = req
    if target_req is None:
        if not has_request_context():
            return "127.0.0.1"
        cached_ip = getattr(g, "_cached_client_ip", None)
        if cached_ip:
            return cached_ip
        target_req = request

    peer_ip = (target_req.remote_addr or "").strip() or "127.0.0.1"
    if not is_trusted_proxy_peer(peer_ip):
        if req is None and has_request_context():
            g._cached_client_ip = peer_ip
        return peer_ip

    forwarded = (target_req.headers.get("X-Forwarded-For") or "").strip()
    rightmost_fwd = ""
    if forwarded:
        for cand in reversed(forwarded.split(",")):
            cand_ip = cand.strip()
            if is_valid_ip_literal(cand_ip):
                rightmost_fwd = cand_ip
                break

    mode = (Config.TRUST_PROXY or "auto").strip().lower()
    cf_ip = (target_req.headers.get("CF-Connecting-IP") or "").strip()
    if cf_ip and is_valid_ip_literal(cf_ip):
        if mode in ("always", "cloudflare", "cf") or is_cloudflare_ip(peer_ip) or is_cloudflare_ip(rightmost_fwd):
            return cf_ip

    if rightmost_fwd:
        if req is None and has_request_context():
            g._cached_client_ip = rightmost_fwd
        return rightmost_fwd

    real_ip = (target_req.headers.get("X-Real-IP") or "").strip()
    if is_valid_ip_literal(real_ip):
        if req is None and has_request_context():
            g._cached_client_ip = real_ip
        return real_ip

    if req is None and has_request_context():
        g._cached_client_ip = peer_ip
    return peer_ip


def is_whitelisted_ip(ip: str) -> bool:
    clean = (ip or "").strip().strip("[]")
    return bool(clean and clean in Config.RATE_LIMIT_WHITELIST)


def ban_ip(ip: str, duration_seconds: int = 1800, reason: str = "异常高频请求"):
    """将恶意 IP 加入短期全域黑名单"""
    if not Config.RATE_LIMIT_ENABLE or not ip or is_whitelisted_ip(ip):
        return
    clean = ip.strip()[:120]
    try:
        cache.set_json(
            f"ip_ban:{clean}",
            {"until": time.time() + duration_seconds, "reason": reason},
            ttl=max(60, int(duration_seconds)),
        )
        if has_request_context():
            ban_cache = getattr(g, "_ip_ban_cache", None)
            if isinstance(ban_cache, dict):
                ban_cache[clean] = (True, max(1, int(duration_seconds)), reason)
    except Exception:
        pass


def check_ip_ban(ip: str) -> tuple[bool, int, str]:
    """检查 IP 是否处于全域封禁黑名单中，返回 (is_banned, remaining_seconds, reason)"""
    if not Config.RATE_LIMIT_ENABLE or not ip or is_whitelisted_ip(ip):
        return False, 0, ""
    clean = ip.strip()[:120]
    if has_request_context():
        ban_cache = getattr(g, "_ip_ban_cache", None)
        if isinstance(ban_cache, dict) and clean in ban_cache:
            return ban_cache[clean]

    result = (False, 0, "")
    try:
        data = cache.get_json(f"ip_ban:{clean}")
        if isinstance(data, dict):
            until = float(data.get("until") or 0.0)
            now = time.time()
            if until > now:
                result = (True, max(1, int(math.ceil(until - now))), str(data.get("reason") or "异常请求拦截"))
    except Exception:
        pass
    if has_request_context():
        ban_cache = getattr(g, "_ip_ban_cache", None)
        if not isinstance(ban_cache, dict):
            ban_cache = {}
            g._ip_ban_cache = ban_cache
        ban_cache[clean] = result
    return result


def consume_rate_limit(
    scope: str,
    identifier: str,
    limit: int,
    window_seconds: int,
    sliding: bool = True,
) -> tuple[bool, int, int]:
    """
    原子限流判定（默认启用滑动时间窗口，彻底消除固定窗口边界双倍突发）：
    返回: (allowed, current_effective_count, remaining)
    """
    if not Config.RATE_LIMIT_ENABLE or limit <= 0 or window_seconds <= 0:
        return True, 0, limit

    safe_id = (identifier or "unknown").strip()[:120]
    if is_whitelisted_ip(safe_id):
        return True, 0, limit

    if not sliding or window_seconds >= 3600:
        # 24小时级日封顶直接用原子计数器更省存储
        key = f"rl:{scope}:{safe_id}"
        try:
            current = int(cache.incr_with_ttl(key, ttl=window_seconds))
            return (current <= limit), current, max(0, limit - current)
        except Exception:
            return True, 0, limit

    now = time.time()
    curr_bucket = int(now // window_seconds)
    prev_bucket = curr_bucket - 1
    elapsed = now - (curr_bucket * window_seconds)
    prev_weight = max(0.0, 1.0 - (elapsed / float(window_seconds)))

    curr_key = f"rl:{scope}:{safe_id}:{curr_bucket}"
    prev_key = f"rl:{scope}:{safe_id}:{prev_bucket}"

    try:
        curr_count = int(cache.incr_with_ttl(curr_key, ttl=window_seconds * 2))
        prev_raw = cache.get(prev_key)
        prev_count = int(prev_raw) if prev_raw and str(prev_raw).isdigit() else 0
        est_count = (prev_count * prev_weight) + curr_count
        allowed = est_count <= float(limit)
        effective_int = int(math.ceil(est_count))
        remaining = max(0, int(math.floor(float(limit) - est_count)))
        return allowed, effective_int, remaining
    except Exception:
        return True, 0, limit


def check_cooldown(scope: str, identifier: str) -> tuple[bool, int]:
    """检查固定冷却时间（如同一邮箱 60 秒内禁止重复发信）"""
    if not Config.RATE_LIMIT_ENABLE:
        return True, 0

    safe_id = (identifier or "unknown").strip()[:120]
    try:
        data = cache.get_json(f"cd:{scope}:{safe_id}")
        if isinstance(data, dict):
            until = float(data.get("until") or 0.0)
            now = time.time()
            if until > now:
                return False, max(1, int(math.ceil(until - now)))
    except Exception:
        pass
    return True, 0


def set_cooldown(scope: str, identifier: str, seconds: int):
    if not Config.RATE_LIMIT_ENABLE or seconds <= 0:
        return
    safe_id = (identifier or "unknown").strip()[:120]
    try:
        cache.set_json(f"cd:{scope}:{safe_id}", {"until": time.time() + seconds}, ttl=seconds)
    except Exception:
        pass


def reset_rate_counter(scope: str, identifier: str, sliding: bool = True):
    safe_id = (identifier or "unknown").strip()[:120]
    try:
        if not sliding:
            cache.delete(f"rl:{scope}:{safe_id}")
        else:
            cache.delete_prefix(f"rl:{scope}:{safe_id}")
    except Exception:
        pass


def rate_limit_response(
    msg: str = "请求过于频繁，请稍后再试",
    retry_after: int = 60,
    limit: Optional[int] = None,
    remaining: int = 0,
):
    wait_sec = max(1, int(retry_after or 60))
    headers = {"Retry-After": str(wait_sec)}
    if limit is not None:
        headers["X-RateLimit-Limit"] = str(limit)
        headers["X-RateLimit-Remaining"] = str(max(0, int(remaining)))
        headers["X-RateLimit-Reset"] = str(int(time.time()) + wait_sec)
    return jsonify({"code": 429, "msg": msg, "retry_after": wait_sec}), 429, headers


def rate_limit(
    scope: str,
    limit: int,
    window_seconds: int,
    msg: str = "请求过于频繁，触发安全限流保护，请稍后再试",
    key_fn: Optional[Callable[[], str]] = None,
    check_ban: bool = True,
):
    """通用路由防刷装饰器（支持滑动窗口、全域黑名单预拦截与标准限流头）"""
    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            if Config.RATE_LIMIT_ENABLE:
                ip = get_client_ip()
                if check_ban:
                    banned, ban_wait, ban_reason = check_ip_ban(ip)
                    if banned:
                        return rate_limit_response(
                            msg=f"安全拦截（{ban_reason}），该 IP 已被临时限制访问，请 {ban_wait} 秒后再试",
                            retry_after=ban_wait,
                            limit=limit,
                            remaining=0,
                        )
                ident = key_fn() if key_fn else ip
                allowed, _, remaining = consume_rate_limit(scope, ident, limit=limit, window_seconds=window_seconds)
                if not allowed:
                    return rate_limit_response(msg=msg, retry_after=window_seconds, limit=limit, remaining=remaining)
            return fn(*args, **kwargs)

        return wrapper

    return decorator
