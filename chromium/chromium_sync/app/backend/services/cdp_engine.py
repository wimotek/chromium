import json
import inspect
import asyncio
from typing import List, Dict
from urllib.parse import urlparse, urlunparse
import httpx
import websockets
from config import ChromiumSync, logger

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

        await ws.send(json.dumps({"id": 2, "method": "Network.enable"}))
        await ws.recv()
        await ws.send(json.dumps({"id": 3, "method": "Network.getAllCookies"}))
        resp2 = await asyncio.wait_for(ws.recv(), timeout=5.0)
        data2 = json.loads(resp2)
        return data2.get("result", {}).get("cookies", [])

async def inject_cookies_native(local_port: int, cookies: List[dict], target_host: str = "127.0.0.1"):
    if ChromiumSync is not None and hasattr(ChromiumSync, 'set_cookies'):
        try:
            fn = getattr(ChromiumSync, 'set_cookies')
            if inspect.iscoroutinefunction(fn):
                await fn(cookies=cookies, port=local_port, host=target_host)
                return
            await asyncio.to_thread(fn, cookies=cookies, port=local_port, host=target_host)
            return
        except Exception as e:
            logger.debug(f"ChromiumSync.set_cookies 调用异常，回退内置写入器: {e}")

    host, ws_url = await resolve_cdp_endpoint(local_port, target_host)
    async with websockets.connect(ws_url, timeout=6.0) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Network.setCookies", "params": {"cookies": cookies}}))
        await asyncio.wait_for(ws.recv(), timeout=6.0)

async def probe_node_cookies(local_port: int, target_host: str = "127.0.0.1") -> tuple[int, str]:
    try:
        cookies = await fetch_cookies_native(local_port, target_host)
        return len(cookies), "OK"
    except ConnectionRefusedError as ce:
        return 0, str(ce)
    except Exception as e:
        return 0, f"探测异常: {str(e)[:35]}"