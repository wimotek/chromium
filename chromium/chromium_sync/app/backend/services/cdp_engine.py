import json
import inspect
import asyncio
import time
from typing import List, Dict, Optional
from urllib.parse import urlparse, urlunparse
import httpx
import websockets
from config import ChromiumSync, logger

def get_cookie_signature_key(c: dict) -> tuple:
    """四元组全局唯一签名 (兼容普通 Cookie 与 Chrome 115+ 分区 Cookie)"""
    pkey = c.get('partitionKey')
    pkey_str = json.dumps(pkey, sort_keys=True) if isinstance(pkey, dict) else str(pkey or '')
    return (
        str(c.get('name') or ''),
        str(c.get('domain') or ''),
        str(c.get('path') or '/'),
        pkey_str
    )

def normalize_cookie_for_cdp(c: dict) -> dict:
    """清洗合规参数"""
    name = c.get("name")
    value = c.get("value")
    if not name or value is None:
        return None

    domain = (c.get("domain") or "").strip()
    path = (c.get("path") or "/").strip()
    secure = bool(c.get("secure", False))
    http_only = bool(c.get("httpOnly", False))

    param = {
        "name": str(name),
        "value": str(value),
        "path": path,
        "secure": secure,
        "httpOnly": http_only
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

def filter_cookies_by_domains(cookies: List[dict], include_domains: List[str], exclude_domains: List[str]) -> tuple[List[dict], int, int]:
    if not include_domains and not exclude_domains:
        return cookies, 0, 0

    filtered = []
    clean_inc = [inc.lower().lstrip('.') for inc in include_domains if inc.strip()]
    clean_exc = [exc.lower().lstrip('.') for exc in exclude_domains if exc.strip()]

    expired_dropped = 0
    blacklist_dropped = 0
    now_ts = time.time()

    for c in cookies:
        exp = c.get('expires')
        if exp is not None and isinstance(exp, (int, float)) and exp > 0 and exp <= now_ts:
            expired_dropped += 1
            continue

        domain = c.get('domain', '').lower().lstrip('.')
        if clean_exc and any(exc in domain for exc in clean_exc):
            blacklist_dropped += 1
            continue
        if clean_inc and not any(inc in domain for inc in clean_inc):
            continue

        filtered.append(c)

    return filtered, blacklist_dropped, expired_dropped

def compute_cookie_diff(current_cookies: List[dict], target_cookies: List[dict]) -> tuple[List[dict], int]:
    curr_map = {
        get_cookie_signature_key(c): c.get('value')
        for c in current_cookies
    }
    diff = []
    skipped_count = 0
    for n in target_cookies:
        key = get_cookie_signature_key(n)
        if key not in curr_map or curr_map[key] != n.get('value'):
            diff.append(n)
        else:
            skipped_count += 1
    return diff, skipped_count

def smart_merge_cookies(all_cookie_lists: List[List[dict]], max_per_domain: int = 50) -> tuple[List[dict], int]:
    merged_pool: Dict[tuple, dict] = {}
    now_ts = time.time()

    for cookies in all_cookie_lists:
        for c in cookies:
            exp = c.get('expires')
            if exp is not None and isinstance(exp, (int, float)) and exp > 0 and exp <= now_ts:
                continue

            key = get_cookie_signature_key(c)
            if key not in merged_pool:
                merged_pool[key] = c
            else:
                existing = merged_pool[key]
                if existing.get('value') != c.get('value'):
                    exp_existing = existing.get('expires', -1)
                    exp_new = c.get('expires', -1)
                    if exp_new > exp_existing:
                        merged_pool[key] = c
                    elif exp_new == exp_existing:
                        if len(str(c.get('value', ''))) >= len(str(existing.get('value', ''))):
                            merged_pool[key] = c

    domain_buckets: Dict[str, List[dict]] = {}
    for c in merged_pool.values():
        d = (c.get('domain') or '').lower().lstrip('.')
        domain_buckets.setdefault(d, []).append(c)

    final_pool = []
    trimmed_count = 0
    for d, d_cookies in domain_buckets.items():
        if len(d_cookies) > max_per_domain:
            d_cookies.sort(key=lambda x: (x.get('expires') or 0), reverse=True)
            final_pool.extend(d_cookies[:max_per_domain])
            trimmed_count += (len(d_cookies) - max_per_domain)
        else:
            final_pool.extend(d_cookies)

    return final_pool, trimmed_count

async def resolve_cdp_endpoint(local_port: int, target_host: str = "127.0.0.1", prefer_page: bool = False) -> tuple[str, str]:
    """直连/SSH 节点专用：探测并解析 CDP WebSocket 调试端点"""
    host_clean = target_host.strip() if target_host else "127.0.0.1"
    if host_clean in ["127.0.0.1", "localhost"]:
        candidate_hosts = ["127.0.0.1", "host.docker.internal", "172.17.0.1"]
    else:
        candidate_hosts = [host_clean]

    def _fmt_host_port(h: str, p: int) -> str:
        clean = h.strip("[]")
        return f"[{clean}]:{p}" if ":" in clean else f"{clean}:{p}"

    async with httpx.AsyncClient(timeout=3.0) as client:
        for host in candidate_hosts:
            netloc = _fmt_host_port(host, local_port)
            try:
                if prefer_page:
                    list_res = await client.get(f"http://{netloc}/json/list")
                    if list_res.status_code == 200:
                        targets = list_res.json()
                        page_targets = [t for t in targets if t.get("type") == "page" and "webSocketDebuggerUrl" in t]
                        if page_targets:
                            raw_ws = page_targets[0]["webSocketDebuggerUrl"]
                            parsed = urlparse(raw_ws)
                            return host, urlunparse(parsed._replace(netloc=netloc))

                ver_res = await client.get(f"http://{netloc}/json/version")
                if ver_res.status_code == 200:
                    raw_ws = ver_res.json()["webSocketDebuggerUrl"]
                    parsed = urlparse(raw_ws)
                    return host, urlunparse(parsed._replace(netloc=netloc))
            except Exception:
                continue
    raise ConnectionRefusedError(f"无法连通主机 {host_clean}:{local_port} 的 CDP 调试端口")

# ==================== 核心穿透分支：严格区分反向长连与直连 ====================
async def fetch_cookies_native(local_port: int, target_host: str = "127.0.0.1", node_id: Optional[int] = None) -> List[dict]:
    """提取 Cookies：反向节点严格走隧道，彻底杜绝尝试访问 reverse-nat4 伪域名"""
    from services.tunnel_manager import tunnel_mgr

    # 判定为反向长连节点
    is_reverse = (target_host in ["reverse-nat4", "reverse"]) or (node_id and tunnel_mgr.get_reverse_session(node_id))
    if is_reverse:
        session = tunnel_mgr.get_reverse_session(node_id) if node_id else None
        if not session or session.is_closed:
            raise ConnectionRefusedError(f"节点 ID:{node_id} 的 WSS 反向长连接未建立或已离线")
        try:
            res = await session.send_command("fetch_cookies", timeout=8.0)
            if res.get("status") == "error":
                raise RuntimeError(res.get("message", "边缘提取失败"))
            return res.get("cookies", [])
        except Exception as e:
            raise ConnectionRefusedError(f"反向长连抓取 Cookie 失败: {e}")

    # 常规直连/SSH 节点分支
    host, ws_url = await resolve_cdp_endpoint(local_port, target_host, prefer_page=False)
    async with websockets.connect(ws_url, open_timeout=5.0) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Network.enable"}))
        await ws.recv()
        await ws.send(json.dumps({"id": 2, "method": "Network.getAllCookies"}))
        resp = await asyncio.wait_for(ws.recv(), timeout=5.0)
        cookies = json.loads(resp).get("result", {}).get("cookies", [])
        if cookies:
            return cookies

        await ws.send(json.dumps({"id": 3, "method": "Storage.getCookies"}))
        resp2 = await asyncio.wait_for(ws.recv(), timeout=5.0)
        return json.loads(resp2).get("result", {}).get("cookies", [])

async def inject_cookies_native(local_port: int, cookies: List[dict], target_host: str = "127.0.0.1", node_id: Optional[int] = None) -> int:
    """写入 Cookies"""
    if not cookies:
        return 0

    valid_params = [norm for c in cookies if (norm := normalize_cookie_for_cdp(c))]
    if not valid_params:
        return 0

    from services.tunnel_manager import tunnel_mgr
    is_reverse = (target_host in ["reverse-nat4", "reverse"]) or (node_id and tunnel_mgr.get_reverse_session(node_id))
    if is_reverse:
        session = tunnel_mgr.get_reverse_session(node_id) if node_id else None
        if not session or session.is_closed:
            logger.error(f"反向长连接已断开 (Node {node_id})")
            return 0
        try:
            res = await session.send_command("inject_cookies", {"cookies": valid_params}, timeout=10.0)
            return res.get("injected_count", len(valid_params))
        except Exception as e:
            logger.error(f"反向隧道注入 Cookie 失败 (Node {node_id}): {e}")
            return 0

    try:
        host, ws_url = await resolve_cdp_endpoint(local_port, target_host, prefer_page=True)
    except Exception as e:
        logger.error(f"无法获取 Page 注入端点: {e}")
        return 0

    async with websockets.connect(ws_url, open_timeout=10.0, max_size=100 * 1024 * 1024) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Network.enable"}))
        await asyncio.wait_for(ws.recv(), timeout=3.0)

        try:
            await ws.send(json.dumps({
                "id": 2,
                "method": "Network.setCookies",
                "params": {"cookies": valid_params}
            }))
            resp_batch = json.loads(await asyncio.wait_for(ws.recv(), timeout=6.0))
            if "error" not in resp_batch:
                await asyncio.sleep(0.3)
                return len(valid_params)
        except Exception:
            pass

        # 流水线模式逐条写入
        for i, p in enumerate(valid_params):
            await ws.send(json.dumps({
                "id": 1000 + i,
                "method": "Network.setCookie",
                "params": p
            }))

        success_count = 0
        for _ in range(len(valid_params)):
            try:
                resp_text = await asyncio.wait_for(ws.recv(), timeout=2.0)
                resp = json.loads(resp_text)
                if resp.get("result", {}).get("success") is True:
                    success_count += 1
            except Exception:
                pass

        await asyncio.sleep(0.3)
        return success_count

async def purge_stale_cookies_on_node(local_port: int, target_host: str = "127.0.0.1", exclude_domains: List[str] = None, node_id: Optional[int] = None) -> int:
    """清理过期与黑名单 Cookies"""
    from services.tunnel_manager import tunnel_mgr
    is_reverse = (target_host in ["reverse-nat4", "reverse"]) or (node_id and tunnel_mgr.get_reverse_session(node_id))
    if is_reverse:
        session = tunnel_mgr.get_reverse_session(node_id) if node_id else None
        if session and not session.is_closed:
            try:
                res = await session.send_command("purge_cookies", {"exclude_domains": exclude_domains or []})
                return res.get("purged_count", 0)
            except Exception:
                return 0
        return 0

    try:
        raw_cookies = await fetch_cookies_native(local_port, target_host)
        now_ts = time.time()
        clean_exc = [exc.lower().lstrip('.') for exc in (exclude_domains or []) if exc.strip()]

        to_delete = []
        for c in raw_cookies:
            exp = c.get('expires')
            is_expired = (exp is not None and isinstance(exp, (int, float)) and exp > 0 and exp <= now_ts)
            domain = (c.get('domain') or '').lower().lstrip('.')
            is_blacklisted = bool(clean_exc and any(exc in domain for exc in clean_exc))

            if is_expired or is_blacklisted:
                to_delete.append({
                    "name": c.get("name"),
                    "domain": c.get("domain"),
                    "path": c.get("path", "/")
                })

        if not to_delete:
            return 0

        host, ws_url = await resolve_cdp_endpoint(local_port, target_host, prefer_page=True)
        async with websockets.connect(ws_url, open_timeout=8.0) as ws:
            for i, d in enumerate(to_delete):
                await ws.send(json.dumps({
                    "id": 8000 + i,
                    "method": "Network.deleteCookies",
                    "params": d
                }))
        return len(to_delete)
    except Exception:
        return 0

async def probe_node_cookies(local_port: int, target_host: str = "127.0.0.1", node_id: Optional[int] = None) -> tuple[int, str]:
    try:
        cookies = await fetch_cookies_native(local_port, target_host, node_id=node_id)
        return len(cookies), "OK"
    except ConnectionRefusedError as ce:
        return 0, str(ce)
    except Exception as e:
        return 0, f"探测异常: {str(e)[:45]}"