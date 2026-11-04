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
    """
    CDP 终极清洗器：
    严格遵守 Chrome DevTools Protocol 规范：
    1. 若有 domain，绝对不传 url (防止跨域域名前导点与 URL 校验冲突导致静默拒收)
    2. 只有有效的未来时间戳才传 expires，负数与会话绝对不传
    3. 过滤掉 size, session, sourcePort 等只读字段
    """
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

    # 过期时间必须是未来的有效时间戳，会话 Cookie 绝不带 expires
    expires = c.get("expires")
    now_ts = time.time()
    if expires is not None and isinstance(expires, (int, float)) and expires > now_ts:
        param["expires"] = float(expires)

    same_site = c.get("sameSite")
    if same_site in ["Strict", "Lax", "None"]:
        param["sameSite"] = same_site

    if "priority" in c and c["priority"] in ["Low", "Medium", "High"]:
        param["priority"] = c["priority"]

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
    """提取当前所有 Cookies"""
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

async def inject_cookies_native(local_port: int, cookies: List[dict], target_host: str = "127.0.0.1") -> int:
    """
    两级加速写入通道：
    1. 优先尝试极速批量合流注入 (Network.setCookies) -> 1 次网络往返，几毫秒内搞定；
    2. 若遇异常，秒级降级为异步流水线 (Pipelining，一口气发射所有单条，不串行等待) -> 依然仅需 1 次网络往返！
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

    host, ws_url = await resolve_cdp_endpoint(local_port, target_host)
    start_t = time.time()

    async with websockets.connect(ws_url, timeout=10.0, max_size=100 * 1024 * 1024) as ws:
        # 激活 Network 域
        await ws.send(json.dumps({"id": 1, "method": "Network.enable"}))
        await asyncio.wait_for(ws.recv(), timeout=3.0)

        # ==================== 优先策略：极速批量注入 (单次 RTT，毫秒级) ====================
        batch_success = False
        try:
            await ws.send(json.dumps({
                "id": 2,
                "method": "Network.setCookies",
                "params": {"cookies": valid_params}
            }))
            resp_batch = json.loads(await asyncio.wait_for(ws.recv(), timeout=5.0))
            if "error" not in resp_batch:
                batch_success = True
                elapsed = f"{(time.time() - start_t)*1000:.1f}ms"
                logger.info(f"⚡ [批量极速通道] 目标 [{target_host}:{local_port}] 一次性注入 {len(valid_params)} 条 Cookies 完成 (耗时: {elapsed})")
                return len(valid_params)
        except Exception as e:
            logger.debug(f"批量通道不可用 ({e})，自动切入流水线模式")

        # ==================== 容灾策略：全异步流水线模式 (Pipelining，绝不发一条等一条) ====================
        logger.info(f"🚀 [异步流水线] 正在为目标 [{target_host}:{local_port}] 流水线并发推送 {len(valid_params)} 条 Cookies...")
        
        # 1. 瞬间将全部请求连环打入 Socket 发送队列 (耗时 < 1ms)
        for i, p in enumerate(valid_params):
            await ws.send(json.dumps({
                "id": 1000 + i,
                "method": "Network.setCookie",
                "params": p
            }))

        # 2. 一次性接收全部 ACK 回执
        success_count = 0
        for _ in range(len(valid_params)):
            try:
                resp_text = await asyncio.wait_for(ws.recv(), timeout=2.0)
                resp = json.loads(resp_text)
                if resp.get("result", {}).get("success") is True:
                    success_count += 1
            except Exception:
                pass

        elapsed = f"{(time.time() - start_t)*1000:.1f}ms"
        logger.info(f"✨ [流水线完成] 目标 [{target_host}:{local_port}] 成功写入: {success_count}/{len(valid_params)} 条 (总耗时: {elapsed})")
        return success_count

async def probe_node_cookies(local_port: int, target_host: str = "127.0.0.1") -> tuple[int, str]:
    try:
        cookies = await fetch_cookies_native(local_port, target_host)
        return len(cookies), "OK"
    except ConnectionRefusedError as ce:
        return 0, str(ce)
    except Exception as e:
        return 0, f"探测异常: {str(e)[:35]}"