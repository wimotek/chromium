import json
import inspect
import asyncio
import time
from typing import List, Dict
from urllib.parse import urlparse, urlunparse
import httpx
import websockets
from config import ChromiumSync, logger

def normalize_cookie_for_cdp(c: dict) -> dict:
    """清洗 CookieParam 参数，确保 Chromium 严格接收"""
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

    return param

def filter_cookies_by_domains(cookies: List[dict], include_domains: List[str], exclude_domains: List[str]) -> tuple[List[dict], int]:
    if not include_domains and not exclude_domains:
        return cookies, 0

    original_len = len(cookies)
    filtered = []
    clean_inc = [inc.lower().lstrip('.') for inc in include_domains if inc.strip()]
    clean_exc = [exc.lower().lstrip('.') for exc in exclude_domains if exc.strip()]

    for c in cookies:
        domain = c.get('domain', '').lower().lstrip('.')
        if clean_exc and any(exc in domain for exc in clean_exc):
            continue
        if clean_inc and not any(inc in domain for inc in clean_inc):
            continue
        filtered.append(c)

    dropped_count = original_len - len(filtered)
    return filtered, dropped_count

def compute_cookie_diff(current_cookies: List[dict], target_cookies: List[dict]) -> tuple[List[dict], int]:
    curr_map = {
        (c.get('name'), c.get('domain'), c.get('path', '/')): c.get('value')
        for c in current_cookies
    }
    diff = []
    skipped_count = 0
    for n in target_cookies:
        key = (n.get('name'), n.get('domain'), n.get('path', '/'))
        if key not in curr_map or curr_map[key] != n.get('value'):
            diff.append(n)
        else:
            skipped_count += 1
    return diff, skipped_count

def smart_merge_cookies(all_cookie_lists: List[List[dict]]) -> List[dict]:
    merged_pool: Dict[tuple, dict] = {}
    for cookies in all_cookie_lists:
        for c in cookies:
            key = (c.get('name'), c.get('domain'), c.get('path', '/'))
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
    return list(merged_pool.values())

async def resolve_cdp_endpoint(local_port: int, target_host: str = "127.0.0.1", prefer_page: bool = False) -> tuple[str, str]:
    """
    智能解析 CDP 端点：
    当 prefer_page=True 时，优先寻找真实的 Page 目标，确保 Network.setCookies 能够真正写入浏览器！
    """
    host_clean = target_host.strip() if target_host else "127.0.0.1"
    if host_clean in ["127.0.0.1", "localhost"]:
        candidate_hosts = ["127.0.0.1", "host.docker.internal", "172.17.0.1"]
    else:
        candidate_hosts = [host_clean]

    async with httpx.AsyncClient(timeout=3.0) as client:
        for host in candidate_hosts:
            try:
                # 若需要写入，优先连接活跃的 Page 目标
                if prefer_page:
                    list_res = await client.get(f"http://{host}:{local_port}/json/list")
                    if list_res.status_code == 200:
                        targets = list_res.json()
                        page_targets = [t for t in targets if t.get("type") == "page" and "webSocketDebuggerUrl" in t]
                        if page_targets:
                            raw_ws = page_targets[0]["webSocketDebuggerUrl"]
                            parsed = urlparse(raw_ws)
                            return host, urlunparse(parsed._replace(netloc=f"{host}:{local_port}"))

                # 兜底连接 Browser 根目标
                ver_res = await client.get(f"http://{host}:{local_port}/json/version")
                if ver_res.status_code == 200:
                    raw_ws = ver_res.json()["webSocketDebuggerUrl"]
                    parsed = urlparse(raw_ws)
                    return host, urlunparse(parsed._replace(netloc=f"{host}:{local_port}"))
            except Exception:
                continue
    raise ConnectionRefusedError(f"无法连通主机 {host_clean}:{local_port} 的 CDP 调试端口")

async def fetch_cookies_native(local_port: int, target_host: str = "127.0.0.1") -> List[dict]:
    """提取全局 Cookies (Storage 域可在 Browser 根端点全局提取)"""
    host, ws_url = await resolve_cdp_endpoint(local_port, target_host, prefer_page=False)
    async with websockets.connect(ws_url, timeout=5.0) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Storage.getCookies"}))
        resp = await asyncio.wait_for(ws.recv(), timeout=5.0)
        data = json.loads(resp)
        cookies = data.get("result", {}).get("cookies", [])
        if cookies:
            return cookies

        # 回退 Network.getAllCookies
        await ws.send(json.dumps({"id": 2, "method": "Network.enable"}))
        await ws.recv()
        await ws.send(json.dumps({"id": 3, "method": "Network.getAllCookies"}))
        resp2 = await asyncio.wait_for(ws.recv(), timeout=5.0)
        data2 = json.loads(resp2)
        return data2.get("result", {}).get("cookies", [])

async def inject_cookies_native(local_port: int, cookies: List[dict], target_host: str = "127.0.0.1") -> int:
    """
    核心修复：连接真实的 Page 页面目标进行 Cookie 写入，确保落盘成功！
    """
    if not cookies:
        return 0

    valid_params = []
    for c in cookies:
        norm = normalize_cookie_for_cdp(c)
        if norm:
            valid_params.append(norm)

    if not valid_params:
        return 0

    # 1. 优先获取 Page 级别的 WebSocket 调试端点
    try:
        host, ws_url = await resolve_cdp_endpoint(local_port, target_host, prefer_page=True)
    except Exception as e:
        logger.error(f"无法获取注入端点: {e}")
        return 0

    async with websockets.connect(ws_url, timeout=10.0, max_size=100 * 1024 * 1024) as ws:
        # 激活 Network 域
        await ws.send(json.dumps({"id": 1, "method": "Network.enable"}))
        await asyncio.wait_for(ws.recv(), timeout=3.0)

        # 批量设置 Cookies
        await ws.send(json.dumps({
            "id": 2,
            "method": "Network.setCookies",
            "params": {"cookies": valid_params}
        }))
        resp = json.loads(await asyncio.wait_for(ws.recv(), timeout=6.0))
        
        if "error" in resp:
            logger.error(f"Network.setCookies 批量写入报错: {resp['error']}")
            # 降级：逐条写入
            success_cnt = 0
            for idx, p in enumerate(valid_params):
                await ws.send(json.dumps({"id": 100 + idx, "method": "Network.setCookie", "params": p}))
                r = json.loads(await asyncio.wait_for(ws.recv(), timeout=2.0))
                if r.get("result", {}).get("success") is True:
                    success_cnt += 1
            return success_cnt

    # 留出 0.3 秒缓冲落盘
    await asyncio.sleep(0.3)
    logger.info(f"目标 [{target_host}:{local_port}] 成功注入 {len(valid_params)} 条 Cookies")
    return len(valid_params)

async def probe_node_cookies(local_port: int, target_host: str = "127.0.0.1") -> tuple[int, str]:
    try:
        cookies = await fetch_cookies_native(local_port, target_host)
        return len(cookies), "OK"
    except ConnectionRefusedError as ce:
        return 0, str(ce)
    except Exception as e:
        return 0, f"探测异常: {str(e)[:35]}"