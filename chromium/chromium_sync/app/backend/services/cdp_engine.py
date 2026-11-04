import json
import inspect
import asyncio
from typing import List, Dict
from urllib.parse import urlparse, urlunparse
import httpx
import websockets
from config import ChromiumSync, logger

def sanitize_cookie_for_cdp(c: dict) -> dict:
    """
    核心转换器：将 CDP 读出的原始 Cookie 转换为 Network.setCookies 合规的 CookieParam
    1. 剔除 size, session 等非法只读字段
    2. 针对 expires <= 0 的会话凭证，必须剔除 expires 字段，否则会被浏览器当场作为过期垃圾丢弃
    3. 自动根据 domain + path + secure 计算补齐 url，确保 Chromium CookieJar 能够落盘
    """
    name = c.get("name")
    value = c.get("value")
    if not name or value is None:
        return None

    path = c.get("path") or "/"
    secure = bool(c.get("secure", False))
    http_only = bool(c.get("httpOnly", False))

    clean_item = {
        "name": str(name),
        "value": str(value),
        "path": path,
        "secure": secure,
        "httpOnly": http_only
    }

    # 处理 domain 与 url
    domain = c.get("domain", "").strip()
    if domain:
        clean_item["domain"] = domain
        clean_domain = domain.lstrip(".")
        scheme = "https" if secure else "http"
        clean_item["url"] = f"{scheme}://{clean_domain}{path}"
    elif c.get("url"):
        clean_item["url"] = c["url"]
    else:
        # 兜底构造 URL
        clean_item["url"] = f"https://localhost{path}"

    # 处理过期时间：只有大于当前时间戳的有效值才传入，会话 Cookie 绝不传 expires
    expires = c.get("expires")
    if expires is not None and isinstance(expires, (int, float)) and expires > 0:
        clean_item["expires"] = float(expires)

    # 传递合规的 SameSite 属性
    same_site = c.get("sameSite")
    if same_site in ["Strict", "Lax", "None"]:
        clean_item["sameSite"] = same_site

    if "priority" in c and c["priority"] in ["Low", "Medium", "High"]:
        clean_item["priority"] = c["priority"]

    return clean_item

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
    """比对指纹，找出目标端没有或者值已发生变化的 Cookie"""
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

async def resolve_cdp_endpoint(local_port: int, target_host: str = "127.0.0.1") -> tuple[str, str]:
    host_clean = target_host.strip() if target_host else "127.0.0.1"
    if host_clean in ["127.0.0.1", "localhost"]:
        candidate_hosts = ["127.0.0.1", "host.docker.internal", "172.17.0.1"]
    else:
        candidate_hosts = [host_clean]

    async with httpx.AsyncClient(timeout=2.5) as client:
        for host in candidate_hosts:
            try:
                url = f"http://{host}:{local_port}/json/version"
                res = await client.get(url)
                if res.status_code == 200:
                    raw_ws = res.json()["webSocketDebuggerUrl"]
                    parsed = urlparse(raw_ws)
                    corrected_ws = urlunparse(parsed._replace(netloc=f"{host}:{local_port}"))
                    return host, corrected_ws
            except Exception:
                continue
    raise ConnectionRefusedError(f"无法连通主机 {host_clean}:{local_port} 的 CDP 调试服务")

async def fetch_cookies_native(local_port: int, target_host: str = "127.0.0.1") -> List[dict]:
    if ChromiumSync is not None and hasattr(ChromiumSync, 'get_cookies'):
        try:
            fn = getattr(ChromiumSync, 'get_cookies')
            if inspect.iscoroutinefunction(fn):
                return await fn(port=local_port, host=target_host)
            return await asyncio.to_thread(fn, port=local_port, host=target_host)
        except Exception as e:
            logger.debug(f"ChromiumSync.get_cookies 调用异常，回退内置提取器: {e}")

    host, ws_url = await resolve_cdp_endpoint(local_port, target_host)
    async with websockets.connect(ws_url, timeout=5.0) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Storage.getCookies"}))
        resp = await asyncio.wait_for(ws.recv(), timeout=5.0)
        data = json.loads(resp)
        cookies = data.get("result", {}).get("cookies", [])
        if cookies:
            return cookies

        # 回退 Network 域抓取
        await ws.send(json.dumps({"id": 2, "method": "Network.enable"}))
        await ws.recv()
        await ws.send(json.dumps({"id": 3, "method": "Network.getAllCookies"}))
        resp2 = await asyncio.wait_for(ws.recv(), timeout=5.0)
        data2 = json.loads(resp2)
        return data2.get("result", {}).get("cookies", [])

async def inject_cookies_native(local_port: int, cookies: List[dict], target_host: str = "127.0.0.1"):
    """
    写入 Cookies：
    1. 严格使用 sanitize_cookie_for_cdp 清洗每一条凭证，剔除只读字段，纠正负数 expires
    2. 先开启 Network.enable 再批量 setCookies，确保 Chromium 真正保存到 CookieJar
    """
    if not cookies:
        return

    # 清洗为合规的 CookieParam 数组
    clean_params = []
    for c in cookies:
        cleaned = sanitize_cookie_for_cdp(c)
        if cleaned:
            clean_params.append(cleaned)

    if not clean_params:
        return

    # 若第三方模块支持直接写入
    if ChromiumSync is not None and hasattr(ChromiumSync, 'set_cookies'):
        try:
            fn = getattr(ChromiumSync, 'set_cookies')
            if inspect.iscoroutinefunction(fn):
                await fn(cookies=clean_params, port=local_port, host=target_host)
                return
            await asyncio.to_thread(fn, cookies=clean_params, port=local_port, host=target_host)
            return
        except Exception as e:
            logger.debug(f"ChromiumSync.set_cookies 调用异常，使用内置注入器: {e}")

    host, ws_url = await resolve_cdp_endpoint(local_port, target_host)
    async with websockets.connect(ws_url, timeout=8.0) as ws:
        # 必须先激活 Network 域
        await ws.send(json.dumps({"id": 100, "method": "Network.enable"}))
        await asyncio.wait_for(ws.recv(), timeout=5.0)

        # 批量注入合规的 Cookies 参数
        await ws.send(json.dumps({
            "id": 101,
            "method": "Network.setCookies",
            "params": {"cookies": clean_params}
        }))
        resp = await asyncio.wait_for(ws.recv(), timeout=8.0)
        data = json.loads(resp)
        if "error" in data:
            logger.error(f"CDP 注入 Cookies 被拒绝: {data['error']}")
        else:
            logger.info(f"CDP 成功写入 {len(clean_params)} 条 Cookies 到目标主机 {target_host}:{local_port}")

async def probe_node_cookies(local_port: int, target_host: str = "127.0.0.1") -> tuple[int, str]:
    try:
        cookies = await fetch_cookies_native(local_port, target_host)
        return len(cookies), "OK"
    except ConnectionRefusedError as ce:
        return 0, str(ce)
    except Exception as e:
        return 0, f"探测异常: {str(e)[:35]}"