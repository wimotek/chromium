from datetime import datetime
import fnmatch
import json
import time
from typing import Dict, List, Optional
from config import logger


def get_cookie_signature_key(c: dict) -> tuple:
    pkey = c.get("partitionKey")
    pkey_str = json.dumps(pkey, sort_keys=True) if isinstance(pkey, dict) else str(pkey or "")
    return (
        str(c.get("name") or ""),
        str(c.get("domain") or ""),
        str(c.get("path") or "/"),
        pkey_str,
    )


def normalize_cookie_for_cdp(c: dict) -> Optional[dict]:
    name = c.get("name")
    value = c.get("value")
    if not name or value is None:
        return None

    domain = (c.get("domain") or "").strip()
    path = (c.get("path") or "/").strip()
    param: dict = {
        "name": str(name),
        "value": str(value),
        "path": path,
        "secure": bool(c.get("secure", False)),
        "httpOnly": bool(c.get("httpOnly", False)),
    }

    if domain:
        param["domain"] = domain
    elif c.get("url"):
        param["url"] = c["url"]

    expires = c.get("expires")
    now_ts = time.time()
    if expires is not None and isinstance(expires, (int, float)) and expires > now_ts:
        param["expires"] = float(expires)

    same_site = c.get("sameSite")
    if same_site in ["Strict", "Lax", "None"]:
        param["sameSite"] = same_site

    if "priority" in c and c["priority"] in ["Low", "Medium", "High"]:
        param["priority"] = c["priority"]

    if "partitionKey" in c and c["partitionKey"]:
        param["partitionKey"] = c["partitionKey"]

    return param


def parse_rule_terms(raw) -> List[str]:
    if not raw:
        return []
    if isinstance(raw, list):
        items = [str(x).strip() for x in raw]
    else:
        text = str(raw).replace("\r", "\n").replace(";", "\n").replace(",", "\n")
        items = [line.strip() for line in text.split("\n")]
    out: List[str] = []
    seen = set()
    for it in items:
        if not it:
            continue
        low = it.lower()
        if low not in seen:
            seen.add(low)
            out.append(low)
    return out


def match_domain_pattern(cookie_domain: str, pattern: str) -> bool:
    dom = (cookie_domain or "").strip().lower().lstrip(".")
    pat = (pattern or "").strip().lower()
    if not dom or not pat:
        return False
    if pat.startswith("*."):
        base = pat[2:].lstrip(".")
        return dom == base or dom.endswith("." + base)
    if "*" in pat:
        return fnmatch.fnmatch(dom, pat)
    clean_p = pat.lstrip(".")
    return dom == clean_p or dom.endswith("." + clean_p)


def match_keyword_pattern(text: str, kw: str) -> bool:
    t = (text or "").lower()
    k = (kw or "").strip().lower()
    if not t or not k:
        return False
    if "*" in k:
        return fnmatch.fnmatch(t, k)
    return k in t


def parse_cutoff_timestamp(date_str: str) -> Optional[float]:
    raw = (date_str or "").strip()
    if not raw:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(raw, fmt).timestamp()
        except ValueError:
            continue
    return None


def should_cleanup_cookie(
    cookie: dict,
    cleanup_rules: Optional[dict] = None,
    exclude_domains: Optional[List[str]] = None,
    now_ts: Optional[float] = None,
) -> tuple[bool, str]:
    now = now_ts if now_ts is not None else time.time()
    exp = cookie.get("expires")
    is_valid_exp = exp is not None and isinstance(exp, (int, float)) and exp > 0
    dom = (cookie.get("domain") or "").lower().lstrip(".")
    name = str(cookie.get("name") or "")
    val = str(cookie.get("value") or "")

    clean_exc = [exc.lower().lstrip(".") for exc in (exclude_domains or []) if exc.strip()]
    if clean_exc and any(exc in dom or match_domain_pattern(dom, exc) for exc in clean_exc):
        return True, "blacklist_domain"

    rules = cleanup_rules or {}
    if not rules.get("enabled"):
        if is_valid_exp and exp <= now:
            return True, "expired"
        return False, ""

    if rules.get("expired", True) and is_valid_exp and exp <= now:
        return True, "expired"

    for pat in parse_rule_terms(rules.get("domains")):
        if match_domain_pattern(dom, pat):
            return True, "cleanup_domain"

    if rules.get("session_only") and not is_valid_exp:
        return True, "session_only"

    cutoff_ts = parse_cutoff_timestamp(rules.get("expires_before", ""))
    if cutoff_ts is not None and is_valid_exp and exp < cutoff_ts:
        return True, "expires_before"

    within_days = rules.get("expiring_within_days") or 0
    try:
        within_days = int(within_days)
    except Exception:
        within_days = 0
    if within_days > 0 and is_valid_exp and exp <= (now + within_days * 86400):
        return True, "expiring_soon"

    kws = parse_rule_terms(rules.get("keywords"))
    if kws:
        scope = str(rules.get("keyword_scope") or "name_domain")
        fields = [name]
        if scope in ("name_domain", "all"):
            fields.append(dom)
        if scope == "all":
            fields.append(val)
        for kw in kws:
            if any(match_keyword_pattern(f, kw) for f in fields):
                return True, "keyword"

    return False, ""


def build_cleanup_targets(
    cookies: List[dict],
    exclude_domains: Optional[List[str]] = None,
    cleanup_rules: Optional[dict] = None,
) -> tuple[List[dict], Dict[str, int]]:
    now_ts = time.time()
    targets: List[dict] = []
    reasons: Dict[str, int] = {}
    for c in cookies:
        hit, reason = should_cleanup_cookie(c, cleanup_rules=cleanup_rules, exclude_domains=exclude_domains, now_ts=now_ts)
        if hit:
            reasons[reason] = reasons.get(reason, 0) + 1
            item = {
                "name": c.get("name"),
                "domain": c.get("domain"),
                "path": c.get("path", "/"),
            }
            if not item["domain"] and c.get("url"):
                item["url"] = c["url"]
            targets.append(item)
    return targets, reasons


def filter_cookies_by_domains(
    cookies: List[dict],
    include_domains: List[str],
    exclude_domains: List[str],
    cleanup_rules: Optional[dict] = None,
) -> tuple[List[dict], int, int]:
    cleanup_active = bool(cleanup_rules and cleanup_rules.get("enabled"))
    if not include_domains and not exclude_domains and not cleanup_active:
        return cookies, 0, 0

    filtered = []
    clean_inc = [inc.lower().lstrip(".") for inc in include_domains if inc.strip()]
    clean_exc = [exc.lower().lstrip(".") for exc in exclude_domains if exc.strip()]

    if clean_exc:
        clean_inc = []

    expired_dropped = 0
    blacklist_dropped = 0
    now_ts = time.time()

    for c in cookies:
        exp = c.get("expires")
        if exp is not None and isinstance(exp, (int, float)) and exp > 0 and exp <= now_ts:
            expired_dropped += 1
            continue

        domain = c.get("domain", "").lower().lstrip(".")
        if clean_exc and any(exc in domain or match_domain_pattern(domain, exc) for exc in clean_exc):
            blacklist_dropped += 1
            continue
        if cleanup_active:
            hit, _ = should_cleanup_cookie(c, cleanup_rules=cleanup_rules, exclude_domains=None, now_ts=now_ts)
            if hit:
                blacklist_dropped += 1
                continue
        if clean_inc and not any(inc in domain or match_domain_pattern(domain, inc) for inc in clean_inc):
            continue

        filtered.append(c)

    return filtered, blacklist_dropped, expired_dropped


def compute_cookie_diff(current_cookies: List[dict], target_cookies: List[dict]) -> tuple[List[dict], int]:
    curr_map = {get_cookie_signature_key(c): c.get("value") for c in current_cookies}
    diff = []
    skipped_count = 0
    for n in target_cookies:
        key = get_cookie_signature_key(n)
        if key not in curr_map or curr_map[key] != n.get("value"):
            diff.append(n)
        else:
            skipped_count += 1
    return diff, skipped_count


def smart_merge_cookies(all_cookie_lists: List[List[dict]], max_per_domain: int = 50) -> tuple[List[dict], int]:
    merged_pool: Dict[tuple, dict] = {}
    now_ts = time.time()

    for cookies in all_cookie_lists:
        for c in cookies:
            exp = c.get("expires")
            if exp is not None and isinstance(exp, (int, float)) and exp > 0 and exp <= now_ts:
                continue

            key = get_cookie_signature_key(c)
            if key not in merged_pool:
                merged_pool[key] = c
            else:
                existing = merged_pool[key]
                if existing.get("value") != c.get("value"):
                    exp_existing = existing.get("expires", -1)
                    exp_new = c.get("expires", -1)
                    if exp_new > exp_existing:
                        merged_pool[key] = c
                    elif exp_new == exp_existing and len(str(c.get("value", ""))) >= len(str(existing.get("value", ""))):
                        merged_pool[key] = c

    domain_buckets: Dict[str, List[dict]] = {}
    for c in merged_pool.values():
        d = (c.get("domain") or "").lower().lstrip(".")
        domain_buckets.setdefault(d, []).append(c)

    final_pool = []
    trimmed_count = 0
    for _, d_cookies in domain_buckets.items():
        if len(d_cookies) > max_per_domain:
            d_cookies.sort(key=lambda x: (x.get("expires") or 0), reverse=True)
            final_pool.extend(d_cookies[:max_per_domain])
            trimmed_count += len(d_cookies) - max_per_domain
        else:
            final_pool.extend(d_cookies)

    return final_pool, trimmed_count


async def fetch_cookies_native(local_port: int, target_host: str = "reverse-nat4", node_id: Optional[int] = None) -> List[dict]:
    from modules.nodes.tunnel_manager import tunnel_mgr

    session = tunnel_mgr.get_reverse_session(node_id) if node_id else None
    if not session or session.is_closed:
        raise ConnectionRefusedError(f"节点 ID:{node_id} 的 WSS 长连接未建立或已离线")
    try:
        res = await session.send_command("fetch_cookies", timeout=8.0)
        if res.get("status") == "error":
            raise RuntimeError(res.get("message", "边缘提取失败"))
        return res.get("cookies", [])
    except Exception as e:
        raise ConnectionRefusedError(f"WSS 长连抓取 Cookie 失败: {e}")


async def inject_cookies_native(
    local_port: int, cookies: List[dict], target_host: str = "reverse-nat4", node_id: Optional[int] = None
) -> int:
    if not cookies:
        return 0
    valid_params = [norm for c in cookies if (norm := normalize_cookie_for_cdp(c))]
    if not valid_params:
        return 0

    from modules.nodes.tunnel_manager import tunnel_mgr

    session = tunnel_mgr.get_reverse_session(node_id) if node_id else None
    if not session or session.is_closed:
        return 0
    try:
        res = await session.send_command("inject_cookies", {"cookies": valid_params}, timeout=10.0)
        return res.get("injected_count", len(valid_params))
    except Exception as e:
        logger.error(f"WSS 隧道注入 Cookie 失败 (Node {node_id}): {e}")
        return 0


async def purge_stale_cookies_on_node(
    local_port: int,
    target_host: str = "reverse-nat4",
    exclude_domains: List[str] = None,
    node_id: Optional[int] = None,
    cleanup_rules: Optional[dict] = None,
    pre_fetched_cookies: Optional[List[dict]] = None,
) -> int:
    from modules.nodes.tunnel_manager import tunnel_mgr

    targets_payload: List[dict] = []
    if pre_fetched_cookies is not None:
        targets_payload, _ = build_cleanup_targets(
            pre_fetched_cookies,
            exclude_domains=exclude_domains or [],
            cleanup_rules=cleanup_rules,
        )

    session = tunnel_mgr.get_reverse_session(node_id) if node_id else None
    if session and not session.is_closed:
        try:
            res = await session.send_command(
                "purge_cookies",
                {
                    "exclude_domains": exclude_domains or [],
                    "cleanup_rules": cleanup_rules or {},
                    "targets": targets_payload,
                },
                timeout=12.0,
            )
            return int(res.get("purged_count", 0))
        except Exception:
            return 0
    return 0


async def probe_node_with_latency(
    local_port: int, target_host: str = "127.0.0.1", node_id: Optional[int] = None
) -> tuple[int, str, int]:
    t0 = time.perf_counter()
    try:
        cookies = await fetch_cookies_native(local_port, target_host, node_id=node_id)
        lat_ms = max(1, int(round((time.perf_counter() - t0) * 1000)))
        return len(cookies), "OK", lat_ms
    except ConnectionRefusedError as ce:
        return 0, str(ce), 0
    except Exception as e:
        return 0, f"探测异常: {str(e)[:45]}", 0


async def probe_node_cookies(local_port: int, target_host: str = "127.0.0.1", node_id: Optional[int] = None) -> tuple[int, str]:
    cnt, msg, _ = await probe_node_with_latency(local_port, target_host, node_id=node_id)
    return cnt, msg
