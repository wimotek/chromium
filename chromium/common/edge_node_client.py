#!/usr/bin/env python3
"""
Wimotek Edge Node Client Runner (Aligned with wimotek-edge-agent >= 1.0.17)
- 端点上报：主动采集并上传节点公网 IPv4/IPv6 与映射端口，由 Hub 端执行并发 TCP 三次握手探测
- 权威回传：接收 Hub 回传的 network_mode (direct_dual/direct_ipv4/direct_ipv6/reverse_tunnel) 与 session_ticket
- 主动心跳：每 5 秒推送应用层 ping，彻底终结 no close frame 闪断重连
- 真实抓取：Network.enable + Network.getAllCookies 穿透提取 CookieJar
- CDP 中继：支持直连与 NAT4 反向 WebSocket CDP 全双工透传
"""

import os
import sys

# 开启全局实时输出，避免 Docker 日志缓冲滞后
sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)

import json
import ssl
import time
import asyncio
import hashlib
import uuid
import socket
from urllib.parse import quote
from pathlib import Path
from typing import Optional, Tuple, List, Dict, Any
import httpx
import websockets

# 容器内部 Chromium 原生监听标准端口
CDP_PORT = int(os.getenv("CDP_PORT", "9222"))


async def get_local_cdp_base() -> str:
    """智能嗅探本地 Chromium 调试端口 (容器内优先 9222 回环)"""
    candidate_ports = [9222]
    if CDP_PORT != 9222:
        candidate_ports.append(CDP_PORT)

    for p in candidate_ports:
        url = f"http://127.0.0.1:{p}"
        try:
            async with httpx.AsyncClient(timeout=1.2) as client:
                res = await client.get(f"{url}/json/version")
                if res.status_code == 200:
                    return url
        except Exception:
            continue
    return "http://127.0.0.1:9222"


def ensure_identity(data_dir: Path) -> Tuple[str, str]:
    """生成或读取持久化的 node_uuid 与 fingerprint"""
    data_dir.mkdir(parents=True, exist_ok=True)
    id_file = data_dir / ".edge_identity.json"
    env_name = os.getenv("NODE_NAME", "").strip()

    if id_file.exists():
        try:
            with open(id_file, "r", encoding="utf-8") as f:
                d = json.load(f)
                if env_name and d.get("node_uuid") != env_name:
                    pass
                else:
                    return d["node_uuid"], d["fingerprint"]
        except Exception:
            pass

    if env_name:
        node_uuid = env_name
    else:
        sniffed_ip = _detect_egress_ip(socket.AF_INET, "8.8.8.8")
        if sniffed_ip:
            node_uuid = f"Node-{sniffed_ip}"
        else:
            hostname = socket.gethostname() or uuid.uuid4().hex[:8]
            node_uuid = f"Node-{hostname[:8]}"

    raw_key = f"{node_uuid}-{uuid.uuid4()}"
    fingerprint = f"sha256:{hashlib.sha256(raw_key.encode()).hexdigest()[:32]}"

    try:
        with open(id_file, "w", encoding="utf-8") as f:
            json.dump({"node_uuid": node_uuid, "fingerprint": fingerprint}, f)
        os.chmod(id_file, 0o600)
    except Exception:
        pass

    return node_uuid, fingerprint


def load_session_ticket(data_dir: Path) -> Optional[str]:
    ticket_file = data_dir / ".edge_session_ticket"
    if ticket_file.exists():
        try:
            val = ticket_file.read_text(encoding="utf-8").strip()
            return val or None
        except Exception:
            return None
    return None


def save_session_ticket(data_dir: Path, ticket: Optional[str]) -> None:
    if not ticket:
        return
    ticket_file = data_dir / ".edge_session_ticket"
    try:
        ticket_file.write_text(ticket.strip(), encoding="utf-8")
        os.chmod(ticket_file, 0o600)
    except Exception:
        pass


def _detect_egress_ip(family: socket.AddressFamily, probe_target: str) -> Optional[str]:
    """本地非阻塞出站路由 IP 嗅探 (不发包，仅内核路由查询)"""
    sock = socket.socket(family, socket.SOCK_DGRAM)
    try:
        sock.settimeout(0.5)
        sock.connect((probe_target, 80))
        ip = sock.getsockname()[0]
        if ip and not ip.startswith("127.") and ip != "::1":
            return ip
    except Exception:
        return None
    finally:
        sock.close()
    return None


def _detect_public_ipv4_http() -> Optional[str]:
    for ip_api in ("https://api.ipify.org", "http://icanhazip.com"):
        try:
            import urllib.request
            with urllib.request.urlopen(ip_api, timeout=1.5) as resp:
                ip = resp.read().decode("utf-8").strip()
                if ip:
                    return ip
        except Exception:
            continue
    return None


def collect_node_endpoints(default_port: int) -> Dict[str, Any]:
    """
    收集节点上报的 IPv4 / IPv6 与端口 (对齐 wimotek-edge-agent 1.0.17 协议)：
    优先读取显式环境变量 PUBLIC_IPV4 / EDGE_AGENT_PUBLIC_IPV4 与 PUBLIC_IPV6 / EDGE_AGENT_PUBLIC_IPV6；
    若未配置且开启 AUTO_DETECT_PUBLIC_IP (默认 true)，自动嗅探本机可用地址。
    """
    public_ipv4 = (
        os.getenv("EDGE_AGENT_PUBLIC_IPV4", "").strip()
        or os.getenv("PUBLIC_IPV4", "").strip()
        or None
    )
    public_ipv4_port = int(
        os.getenv("EDGE_AGENT_PUBLIC_IPV4_PORT")
        or os.getenv("PUBLIC_IPV4_PORT")
        or default_port
    )

    public_ipv6 = (
        os.getenv("EDGE_AGENT_PUBLIC_IPV6", "").strip()
        or os.getenv("PUBLIC_IPV6", "").strip()
        or None
    )
    public_ipv6_port = int(
        os.getenv("EDGE_AGENT_PUBLIC_IPV6_PORT")
        or os.getenv("PUBLIC_IPV6_PORT")
        or default_port
    )

    auto_detect = os.getenv("AUTO_DETECT_PUBLIC_IP", "true").strip().lower() in {
        "1", "true", "yes", "on"
    }
    if auto_detect:
        if not public_ipv4:
            public_ipv4 = _detect_public_ipv4_http() or _detect_egress_ip(socket.AF_INET, "8.8.8.8")
        if not public_ipv6:
            public_ipv6 = _detect_egress_ip(socket.AF_INET6, "2001:4860:4860::8888")

    return {
        "public_ipv4": public_ipv4,
        "public_ipv4_port": public_ipv4_port if public_ipv4 else None,
        "public_ipv6": public_ipv6,
        "public_ipv6_port": public_ipv6_port if public_ipv6 else None,
    }


def parse_reverse_tunnel_mode() -> Optional[bool]:
    """解析运行模式: None (智能) | True (穿透) | False (直连)"""
    val = os.getenv("REVERSE_TUNNEL")
    if val is None:
        val = os.getenv("EDGE_AGENT_REVERSE_TUNNEL")

    if val is None or val.strip() == "" or val.strip().lower() in {"auto", "none"}:
        return None

    v = val.strip().lower()
    if v in {"1", "true", "yes", "on", "y"}:
        return True
    if v in {"0", "false", "no", "off", "n"}:
        return False

    return None


async def check_hub_can_reach_me(
    hub_url: str,
    cdp_port: int,
    endpoints: Dict[str, Any],
    node_uuid: str,
) -> Dict[str, Any]:
    """
    上传节点 IPv4 / IPv6 与端口，由 Hub 调用 wimotek-edge-agent 执行并发 TCP 三次握手探测，
    并返回权威网络类型 (network_mode, network_profile, recommended_endpoint, probe_results)。
    """
    detect_api = f"{hub_url}/api/nodes/detect-mode"
    payload = {
        "node_uuid": node_uuid,
        "cdp_port": cdp_port,
        "public_ipv4": endpoints.get("public_ipv4"),
        "public_ipv4_port": endpoints.get("public_ipv4_port"),
        "public_ipv6": endpoints.get("public_ipv6"),
        "public_ipv6_port": endpoints.get("public_ipv6_port"),
    }

    async with httpx.AsyncClient(verify=False, timeout=6.0) as client:
        try:
            res = await client.post(detect_api, json=payload)
            if res.status_code == 200:
                return res.json()
            if res.status_code == 405:
                # 兼容旧版 Hub GET 接口
                res_get = await client.get(f"{detect_api}?cdp_port={cdp_port}")
                if res_get.status_code == 200:
                    return res_get.json()
        except Exception as e:
            print(f"⚠️ [Network Detect] Hub 探测接口调用异常: {e}", flush=True)

    return {
        "can_direct": False,
        "network_mode": "reverse_tunnel",
        "network_profile": "nat4_reverse",
        "detected_ip": endpoints.get("public_ipv4") or "",
        "recommended_port": cdp_port,
        "recommended_endpoint": None,
    }


async def execute_http_auto_register(
    hub_url: str,
    node_uuid: str,
    fingerprint: str,
    cdp_port: int,
    endpoints: Dict[str, Any],
    detect_result: Optional[Dict[str, Any]] = None,
    data_dir: Path = Path("/data"),
) -> Optional[Dict[str, Any]]:
    """直连登记模式 (携带节点 IP/端口与探测到的 network_mode)"""
    api_url = f"{hub_url}/api/nodes/auto-register"
    join_token = os.getenv("JOIN_TOKEN", "").strip()
    node_name = os.getenv("NODE_NAME", "").strip() or node_uuid
    group_name = os.getenv("NODE_GROUP", "默认分组").strip()
    session_ticket = load_session_ticket(data_dir)

    headers = {}
    if join_token:
        headers["X-Join-Token"] = join_token

    det = detect_result or {}
    payload = {
        "node_uuid": node_uuid,
        "public_key_fingerprint": fingerprint,
        "name": node_name,
        "group_name": group_name,
        "cdp_port": cdp_port,
        "public_ipv4": endpoints.get("public_ipv4"),
        "public_ipv4_port": endpoints.get("public_ipv4_port"),
        "public_ipv6": endpoints.get("public_ipv6"),
        "public_ipv6_port": endpoints.get("public_ipv6_port"),
        "network_mode": det.get("network_mode"),
        "recommended_endpoint": det.get("recommended_endpoint"),
        "ipv4_reachable": det.get("ipv4_reachable"),
        "ipv6_reachable": det.get("ipv6_reachable"),
        "session_ticket": session_ticket,
    }

    print(
        f"📡 [Direct Register] 正在向 Hub 发送直连登记包: {api_url} "
        f"(端口: {cdp_port}, mode={det.get('network_mode', 'direct')})",
        flush=True,
    )
    async with httpx.AsyncClient(verify=False, timeout=8.0) as client:
        try:
            res = await client.post(api_url, json=payload, headers=headers)
            print(f"✅ [Direct Register] 直连接入响应: {res.status_code}", flush=True)
            if res.status_code == 200:
                body = res.json()
                if body.get("session_ticket"):
                    save_session_ticket(data_dir, body["session_ticket"])
                return body
        except Exception as e:
            print(f"❌ [Direct Register] 直连登记受阻: {e}", flush=True)
    return None


async def direct_keepalive_loop(
    hub_url: str,
    node_uuid: str,
    fingerprint: str,
    cdp_port: int,
    endpoints: Dict[str, Any],
    detect_result: Dict[str, Any],
    data_dir: Path,
):
    """直连模式下定期心跳保活，防止节点退出触发 Watchdog 反复重注册"""
    interval = int(os.getenv("DIRECT_HEARTBEAT_SECONDS", "60"))
    await execute_http_auto_register(
        hub_url, node_uuid, fingerprint, cdp_port, endpoints, detect_result, data_dir
    )
    while True:
        await asyncio.sleep(interval)
        await execute_http_auto_register(
            hub_url, node_uuid, fingerprint, cdp_port, endpoints, detect_result, data_dir
        )


async def send_cdp_json_command(ws, method: str, params: dict = None, req_id: int = 1) -> dict:
    """发送 CDP 命令并过滤匹配 ID 响应 (忽略异步事件噪音)"""
    msg = {"id": req_id, "method": method}
    if params:
        msg["params"] = params
    await ws.send(json.dumps(msg))

    start_t = time.time()
    while time.time() - start_t < 4.0:
        raw_msg = await asyncio.wait_for(ws.recv(), timeout=4.0)
        resp = json.loads(raw_msg)
        if resp.get("id") == req_id:
            return resp.get("result", {})
    return {}


async def extract_all_cookies(http_client: httpx.AsyncClient) -> List[dict]:
    """真实穿透提取 Chromium 全量 CookieJar"""
    local_base = await get_local_cdp_base()

    # 策略 1: 优先从活跃 Page 端点抓取 (全量 CookieJar)
    try:
        list_res = await http_client.get(f"{local_base}/json/list", timeout=3.0)
        pages = [t for t in list_res.json() if t.get("type") == "page" and "webSocketDebuggerUrl" in t]
        if pages:
            page_ws_url = pages[0]["webSocketDebuggerUrl"]
            ws_conn = websockets.connect(page_ws_url, open_timeout=5.0)
            async with ws_conn as page_ws:
                await send_cdp_json_command(page_ws, "Network.enable", req_id=201)
                res_page = await send_cdp_json_command(page_ws, "Network.getAllCookies", req_id=202)
                cookies_p = res_page.get("cookies", [])
                if cookies_p:
                    return cookies_p
    except Exception as e:
        print(f"⚠️ [CDP 探针] 策略 1 (Page 端点) 未捕获到 Cookie: {e}", flush=True)

    # 策略 2: 兜底从主端点 /json/version 抓取
    try:
        ver_res = await http_client.get(f"{local_base}/json/version", timeout=3.0)
        ws_url = ver_res.json()["webSocketDebuggerUrl"]
        ws_conn = websockets.connect(ws_url, open_timeout=5.0)
        async with ws_conn as ws:
            await send_cdp_json_command(ws, "Network.enable", req_id=101)
            res_all = await send_cdp_json_command(ws, "Network.getAllCookies", req_id=102)
            cookies = res_all.get("cookies", [])
            if cookies:
                return cookies
            res_storage = await send_cdp_json_command(ws, "Storage.getCookies", req_id=103)
            cookies_s = res_storage.get("cookies", [])
            if cookies_s:
                return cookies_s
    except Exception as e:
        print(f"⚠️ [CDP 探针] 策略 2 (Version 端点) 未捕获到 Cookie: {e}", flush=True)

    return []


async def bridge_cdp_ws_stream(tunnel_ws, stream_id: str, inbound_queue: asyncio.Queue):
    """通过反向隧道多路复用透传 Playwright / Puppeteer CDP WebSocket 会话"""
    try:
        local_base = await get_local_cdp_base()
        async with httpx.AsyncClient(timeout=3.0) as client:
            ver_res = await client.get(f"{local_base}/json/version")
            local_ws_url = ver_res.json()["webSocketDebuggerUrl"]

        async with websockets.connect(local_ws_url, open_timeout=5.0, max_size=100 * 1024 * 1024) as cdp_ws:
            async def _cdp_to_hub():
                async for msg in cdp_ws:
                    await tunnel_ws.send(json.dumps({
                        "type": "cdp_ws_frame",
                        "stream_id": stream_id,
                        "data": msg if isinstance(msg, str) else msg.decode("utf-8", errors="replace"),
                    }))

            async def _hub_to_cdp():
                while True:
                    payload = await inbound_queue.get()
                    if payload is None:
                        break
                    await cdp_ws.send(payload)

            done, pending = await asyncio.wait(
                [asyncio.create_task(_cdp_to_hub()), asyncio.create_task(_hub_to_cdp())],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for t in pending:
                t.cancel()
    except Exception as e:
        try:
            await tunnel_ws.send(json.dumps({
                "type": "cdp_ws_error",
                "stream_id": stream_id,
                "error": str(e),
            }))
        except Exception:
            pass
    finally:
        try:
            await tunnel_ws.send(json.dumps({"type": "cdp_ws_close", "stream_id": stream_id}))
        except Exception:
            pass


async def handle_cdp_command(
    ws,
    http_client: httpx.AsyncClient,
    cmd_text: str,
    ws_streams: Dict[str, asyncio.Queue],
):
    """业务指令调度执行器"""
    try:
        cmd = json.loads(cmd_text)
    except Exception:
        return

    msg_type = cmd.get("type")
    action = cmd.get("action")
    req_id = cmd.get("req_id")
    payload = cmd.get("payload", {})

    # Hub 下发网络模式变更 / 重探结果
    if msg_type in {"network_update", "network_probe_result"}:
        print(
            f"🌐 [Hub 网络回传] network_mode={cmd.get('network_mode')} | "
            f"profile={cmd.get('network_profile')} | endpoint={cmd.get('recommended_endpoint')}",
            flush=True,
        )
        return

    if msg_type == "cdp_ws_open":
        stream_id = cmd["stream_id"]
        q: asyncio.Queue = asyncio.Queue()
        ws_streams[stream_id] = q
        asyncio.create_task(bridge_cdp_ws_stream(ws, stream_id, q))
        return

    if msg_type == "cdp_ws_frame":
        stream_id = cmd.get("stream_id")
        if stream_id in ws_streams:
            await ws_streams[stream_id].put(cmd.get("data", ""))
        return

    if msg_type == "cdp_ws_close":
        stream_id = cmd.get("stream_id")
        q = ws_streams.pop(stream_id, None)
        if q is not None:
            await q.put(None)
        return

    if action == "fetch_cookies":
        try:
            cookies = await extract_all_cookies(http_client)
            print(f"🍪 [CDP] 捕获并推回 {len(cookies)} 条真实 Cookie", flush=True)
            await ws.send(json.dumps({"req_id": req_id, "status": "ok", "cookies": cookies}))
        except Exception as e:
            print(f"❌ [CDP] 抓取失败: {e}", flush=True)
            await ws.send(json.dumps({"req_id": req_id, "status": "error", "message": str(e)}))

    elif action == "inject_cookies":
        to_inject = payload.get("cookies", [])
        try:
            local_base = await get_local_cdp_base()
            target_ws = None
            try:
                list_res = await http_client.get(f"{local_base}/json/list", timeout=3.0)
                targets = list_res.json()
                page_targets = [t for t in targets if t.get("type") == "page" and "webSocketDebuggerUrl" in t]
                if page_targets:
                    target_ws = page_targets[0]["webSocketDebuggerUrl"]
            except Exception:
                pass

            if not target_ws:
                ver_res = await http_client.get(f"{local_base}/json/version", timeout=3.0)
                target_ws = ver_res.json()["webSocketDebuggerUrl"]

            async with websockets.connect(target_ws, open_timeout=8.0) as cdp_ws:
                await send_cdp_json_command(cdp_ws, "Network.enable", req_id=301)
                await send_cdp_json_command(cdp_ws, "Network.setCookies", {"cookies": to_inject}, req_id=302)

            await ws.send(json.dumps({"req_id": req_id, "status": "ok", "injected_count": len(to_inject)}))
        except Exception as e:
            await ws.send(json.dumps({"req_id": req_id, "status": "error", "message": str(e)}))

    elif action == "purge_cookies":
        await ws.send(json.dumps({"req_id": req_id, "status": "ok", "purged_count": 0}))

    elif action == "get_version":
        try:
            local_base = await get_local_cdp_base()
            res = await http_client.get(f"{local_base}/json/version", timeout=3.0)
            await ws.send(json.dumps({"req_id": req_id, "status": "ok", "version": res.json()}))
        except Exception as e:
            await ws.send(json.dumps({"req_id": req_id, "status": "error", "message": str(e)}))

    elif msg_type == "ping" or action == "ping":
        await ws.send(json.dumps({"type": "pong"}))


async def keep_alive_heartbeat(ws):
    """每 5 秒主动向 Hub 发送一次应用层 ping，防止中间网关断连"""
    while True:
        await asyncio.sleep(5)
        try:
            await ws.send(json.dumps({"action": "ping"}))
        except Exception:
            break


async def run_tunnel_client(
    tunnel_url: str,
    headers: dict,
    handshake_payload: dict,
    data_dir: Path = Path("/data"),
):
    """全双工反向长连接隧道 (接收 Hub 网络判定回传与 session_ticket)"""
    is_wss = tunnel_url.startswith("wss://")
    ssl_ctx = ssl.create_default_context()
    ssl_ctx.check_hostname = False
    ssl_ctx.verify_mode = ssl.CERT_NONE

    common_kwargs = {
        "ssl": ssl_ctx if is_wss else None,
        "max_size": 100 * 1024 * 1024,
        "ping_interval": 20,
        "ping_timeout": 10,
        "open_timeout": 10,
    }

    backoff = 2
    while True:
        ws_streams: Dict[str, asyncio.Queue] = {}
        try:
            # 每次重连尝试刷新本地保存的 session_ticket
            latest_ticket = load_session_ticket(data_dir)
            if latest_ticket:
                handshake_payload["session_ticket"] = latest_ticket

            print(f"🔌 [Tunnel] 正在建立反向 WebSocket 隧道: {tunnel_url} ...", flush=True)

            try:
                ws = await websockets.connect(tunnel_url, additional_headers=headers, **common_kwargs)
            except TypeError:
                ws = await websockets.connect(tunnel_url, extra_headers=headers, **common_kwargs)

            print("✅ [Tunnel] 底层隧道建立成功！正在上传节点 IP/端口与身份握手包...", flush=True)
            await ws.send(json.dumps(handshake_payload))

            raw_resp = await asyncio.wait_for(ws.recv(), timeout=10.0)
            print(f"📥 [Hub 握手应答] {raw_resp}", flush=True)

            resp = json.loads(raw_resp)
            status = resp.get("status")
            if resp.get("session_ticket"):
                save_session_ticket(data_dir, resp["session_ticket"])

            if "network_mode" in resp:
                print(
                    f"🧭 [网络判定回传] network_mode={resp.get('network_mode')} | "
                    f"profile={resp.get('network_profile')} | "
                    f"recommended={resp.get('recommended_endpoint')}",
                    flush=True,
                )

            if status == "ok":
                print("🎉 [认证放行] 节点已被 Hub 信任放行！全双工长连通道就绪！", flush=True)
                backoff = 2
            elif status == "pending_tofu":
                print("⏳ [TOFU 隔离] 节点已接入待审队列，等待管理员在后台点击 [认领并信任] ...", flush=True)
            elif status == "denied":
                print(f"❌ [准入拒绝] Hub 拒绝接入: {resp.get('reason')}，10 秒后重试...", flush=True)
                await ws.close()
                await asyncio.sleep(10)
                continue

            heartbeat_task = asyncio.create_task(keep_alive_heartbeat(ws))

            try:
                async with httpx.AsyncClient(timeout=4.0) as http_client:
                    async for msg_text in ws:
                        if '"status":"approved"' in msg_text or '"status": "approved"' in msg_text:
                            try:
                                app_msg = json.loads(msg_text)
                                if app_msg.get("session_ticket"):
                                    save_session_ticket(data_dir, app_msg["session_ticket"])
                            except Exception:
                                pass
                            print("✨ [TOFU 审核通过] 管理员已在后台批准该节点，正式激活业务通信！", flush=True)
                            continue
                        if msg_text == "pong" or '"type":"pong"' in msg_text:
                            continue
                        asyncio.create_task(handle_cdp_command(ws, http_client, msg_text, ws_streams))
            finally:
                heartbeat_task.cancel()
                for q in ws_streams.values():
                    await q.put(None)
                ws_streams.clear()

        except Exception as e:
            print(f"⚠️ [Tunnel 异常中断] {type(e).__name__}: {e}，将在 {backoff} 秒后自动重连...", flush=True)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)


def main():
    hub_url = os.getenv("HUB_URL", "").strip().rstrip("/")
    if not hub_url:
        print("[Edge Client] 未配置 HUB_URL，跳过边缘入网流程。", flush=True)
        return

    data_dir = Path(os.getenv("DATA_DIR", "/data"))
    node_uuid, fingerprint = ensure_identity(data_dir)
    join_token = os.getenv("JOIN_TOKEN", "").strip() or None
    node_name = os.getenv("NODE_NAME", "").strip() or node_uuid
    group_name = os.getenv("NODE_GROUP", "默认分组").strip()

    ext_direct_port = int(
        os.getenv("DIRECT_PORT") or os.getenv("EXTERNAL_PORT") or os.getenv("CDP_PORT") or 9222
    )
    endpoints = collect_node_endpoints(ext_direct_port)
    tunnel_mode: Optional[bool] = parse_reverse_tunnel_mode()

    print(
        f"📋 [节点参数] 名称: {node_name} | IPv4: {endpoints.get('public_ipv4')}:{endpoints.get('public_ipv4_port')} | "
        f"IPv6: {endpoints.get('public_ipv6')}:{endpoints.get('public_ipv6_port')} | 模式: {tunnel_mode}",
        flush=True,
    )

    # 预先等待 Chromium 内部 9222 端口完全就绪，确保 TCP 探测前端口已监听
    async def _wait_cdp_ready():
        async with httpx.AsyncClient(timeout=2.0) as client:
            for _ in range(15):
                try:
                    local_url = await get_local_cdp_base()
                    res = await client.get(f"{local_url}/json/version")
                    if res.status_code == 200:
                        print(f"✅ [CDP Ready] 本地 Chromium 调试端口已就绪 ({local_url})！", flush=True)
                        return
                except Exception:
                    pass
                await asyncio.sleep(1.0)

    asyncio.run(_wait_cdp_ready())

    # 1. 强制直连
    if tunnel_mode is False:
        print(f"⚙️ [Edge Mode] reverse_tunnel=False ➔ 【强制直连登记 (端口: {ext_direct_port})】", flush=True)
        detect_res = {
            "network_mode": "direct",
            "network_profile": "direct",
            "recommended_endpoint": f"{endpoints['public_ipv4']}:{ext_direct_port}" if endpoints.get("public_ipv4") else None,
        }
        asyncio.run(
            direct_keepalive_loop(hub_url, node_uuid, fingerprint, ext_direct_port, endpoints, detect_res, data_dir)
        )
        return

    # 2. 强制穿透
    elif tunnel_mode is True:
        print(f"⚙️ [Edge Mode] reverse_tunnel=True ➔ 【强制反向穿透 (端口: {ext_direct_port})】", flush=True)

    # 3. 智能自适应：上传节点 IP + 端口给 Hub 执行 TCP 三次握手判定
    else:
        print(
            f"🧠 [Edge Mode] reverse_tunnel=None ➔ 【上传 IP/端口由 Hub TCP 三次握手判定】...",
            flush=True,
        )
        detect_res = asyncio.run(
            check_hub_can_reach_me(hub_url, cdp_port=ext_direct_port, endpoints=endpoints, node_uuid=node_uuid)
        )
        network_mode = detect_res.get("network_mode", "reverse_tunnel")
        can_direct = bool(detect_res.get("can_direct")) or network_mode in {"direct_dual", "direct_ipv4", "direct_ipv6", "direct"}

        if can_direct:
            rec_ep = detect_res.get("recommended_endpoint") or f"{detect_res.get('detected_ip', '')}:{detect_res.get('recommended_port', ext_direct_port)}"
            print(
                f"🎯 [Smart Check] Hub 探测成功！network_mode={network_mode}, recommended_endpoint={rec_ep}",
                flush=True,
            )
            print("   -> 自动判定为直连网络，执行直连登记并维持轻量保活。", flush=True)
            asyncio.run(
                direct_keepalive_loop(
                    hub_url,
                    node_uuid,
                    fingerprint,
                    detect_res.get("recommended_port", ext_direct_port),
                    endpoints,
                    detect_res,
                    data_dir,
                )
            )
            return
        else:
            print(
                f"🛡️ [Smart Check] Hub 探测回传: network_mode={network_mode} (公网不可直连 / 处于 NAT4 或防火墙后)",
                flush=True,
            )
            print("   -> 自动无感切换为【NAT4 出站反向长连接穿透模式】！", flush=True)

    headers = {
        "X-Node-UUID": node_uuid,
        "X-Node-Fingerprint": fingerprint,
        "X-Node-Name": quote(node_name),
        "X-Node-Group": quote(group_name),
        "X-CDP-Port": str(ext_direct_port),
    }
    if join_token:
        headers["X-Join-Token"] = join_token

    handshake_payload: Dict[str, Any] = {
        "node_uuid": node_uuid,
        "public_key_fingerprint": fingerprint,
        "join_token": join_token,
        "session_ticket": load_session_ticket(data_dir),
        "name": node_name,
        "group": group_name,
        "port": ext_direct_port,
        "nat_type": "nat4" if tunnel_mode is True else "unknown",
    }
    if tunnel_mode is True:
        handshake_payload["reverse_tunnel"] = True
    if endpoints.get("public_ipv4"):
        handshake_payload["public_ipv4"] = endpoints["public_ipv4"]
        handshake_payload["public_ipv4_port"] = endpoints["public_ipv4_port"]
    if endpoints.get("public_ipv6"):
        handshake_payload["public_ipv6"] = endpoints["public_ipv6"]
        handshake_payload["public_ipv6_port"] = endpoints["public_ipv6_port"]

    base_ws_url = hub_url.replace("https://", "wss://").replace("http://", "ws://")
    tunnel_url = f"{base_ws_url}/api/nodes/reverse-tunnel"

    print(f"🚀 [Edge Client] 启动隧道主循环 -> 目标: {tunnel_url}", flush=True)
    asyncio.run(run_tunnel_client(tunnel_url, headers, handshake_payload, data_dir))


if __name__ == "__main__":
    main()