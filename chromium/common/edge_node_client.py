#!/usr/bin/env python3
"""
Wimotek Edge Node Client Runner (Aligned with wimotek-edge-agent >= 1.0.17)
- 安全隔离：Chromium CDP 9222 仅监听容器内 127.0.0.1，绝不直接暴露到公网
- 双栈鉴权 WSS 直连：内置 IPv4/IPv6 双栈 TLS WebSocket 服务 (默认 EDGE_WSS_PORT=9443)
- 智能自适应选路：启动后由 Hub 对节点 WSS 端口执行 TCP 三次握手（兼容 Oracle/云主机的内网网卡 1:1 NAT）
  * 握手成功 -> 公网 WSS 直连 (conn_type="public_wss")，Hub 主动连 wss://<节点IP>:9443
  * 握手失败 -> NAT4 反向穿透 (conn_type="reverse")，节点出站连 wss://<Hub>/api/nodes/reverse-tunnel
- 主动心跳与复用：每 5 秒应用层 ping，全双工 CDP WebSocket 多路复用与 SessionTicket 持久化
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
import secrets
import subprocess
import uuid
import socket
from urllib.parse import quote
from pathlib import Path
from typing import Optional, Tuple, List, Dict, Any
import httpx
import websockets

# Chromium 原生仅监听容器内 127.0.0.1:9222
CDP_PORT = int(os.getenv("CDP_PORT", "9222"))

# 节点内置鉴权 WSS 服务监听地址与端口 (默认 "::" 双栈 + 9443)
EDGE_WSS_HOST = (os.getenv("EDGE_WSS_HOST") or "::").strip()
EDGE_WSS_PORT = int(os.getenv("EDGE_WSS_PORT") or "9443")


async def get_local_cdp_base() -> str:
    """获取容器本地 Chromium 回环调试地址 (仅 127.0.0.1)"""
    candidate_ports = [9222]
    if CDP_PORT not in candidate_ports:
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
    return f"http://127.0.0.1:{CDP_PORT}"


def ensure_identity(data_dir: Path) -> Tuple[str, str, str]:
    """生成或读取持久化的 node_uuid、fingerprint 与入站 WSS 鉴权密钥 edge_wss_secret"""
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
                    sec = (d.get("edge_wss_secret") or "").strip()
                    if not sec:
                        sec = secrets.token_urlsafe(32)
                        d["edge_wss_secret"] = sec
                        with open(id_file, "w", encoding="utf-8") as wf:
                            json.dump(d, wf)
                        os.chmod(id_file, 0o600)
                    return d["node_uuid"], d["fingerprint"], sec
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
    edge_wss_secret = secrets.token_urlsafe(32)

    try:
        with open(id_file, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "node_uuid": node_uuid,
                    "fingerprint": fingerprint,
                    "edge_wss_secret": edge_wss_secret,
                },
                f,
            )
        os.chmod(id_file, 0o600)
    except Exception:
        pass

    return node_uuid, fingerprint, edge_wss_secret


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
    收集节点上报的公网 IPv4 / IPv6 与对外 WSS 端口 (默认 EDGE_WSS_PORT=9443)。
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
    """解析运行模式: None (智能自适应) | True (强制反向穿透) | False (强制公网 WSS 直连)"""
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


def _resolve_node_ssl_context(data_dir: Path) -> ssl.SSLContext:
    """加载节点 TLS 证书用于内置 WSS 服务（复用宝塔/entrypoint 证书或自动自签）"""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)

    novnc_pem = Path("/etc/ssl/app/novnc.pem")
    kasm_crt = Path("/etc/ssl/app/kasm.crt")
    kasm_key = Path("/etc/ssl/app/kasm.key")

    if novnc_pem.exists() and novnc_pem.stat().st_size > 0:
        ctx.load_cert_chain(certfile=str(novnc_pem))
        return ctx

    if kasm_crt.exists() and kasm_key.exists() and kasm_crt.stat().st_size > 0 and kasm_key.stat().st_size > 0:
        ctx.load_cert_chain(certfile=str(kasm_crt), keyfile=str(kasm_key))
        return ctx

    fallback_pem = data_dir / ".edge_wss.pem"
    if not fallback_pem.exists() or fallback_pem.stat().st_size == 0:
        key_tmp = data_dir / ".edge_wss.key"
        crt_tmp = data_dir / ".edge_wss.crt"
        try:
            subprocess.run(
                [
                    "openssl", "req", "-x509", "-nodes", "-days", "3650",
                    "-newkey", "rsa:2048",
                    "-keyout", str(key_tmp),
                    "-out", str(crt_tmp),
                    "-subj", "/CN=edge-wss",
                ],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            fallback_pem.write_text(
                crt_tmp.read_text(encoding="utf-8") + key_tmp.read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            os.chmod(fallback_pem, 0o600)
        finally:
            for tmp_p in (key_tmp, crt_tmp):
                try:
                    if tmp_p.exists():
                        tmp_p.unlink()
                except OSError:
                    pass

    ctx.load_cert_chain(certfile=str(fallback_pem))
    return ctx


def _create_dualstack_wss_sockets(host: str, port: int) -> List[socket.socket]:
    """创建 IPv4/IPv6 双栈监听 Socket（纯 IPv4 容器环境自动回退 0.0.0.0）"""
    normalized = (host or "::").strip().strip("[]")
    if normalized not in {"::", "auto", "dual", ""}:
        family = socket.AF_INET6 if ":" in normalized else socket.AF_INET
        s = socket.socket(family, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind((normalized, port))
        s.listen(1024)
        s.setblocking(False)
        return [s]

    if getattr(socket, "has_ipv6", False):
        s6 = None
        try:
            s6 = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
            s6.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s6.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
            s6.bind(("::", port))
            s6.listen(1024)
            s6.setblocking(False)
            return [s6]
        except OSError:
            if s6 is not None:
                try:
                    s6.close()
                except OSError:
                    pass
            socks: List[socket.socket] = []
            try:
                s4 = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s4.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s4.bind(("0.0.0.0", port))
                s4.listen(1024)
                s4.setblocking(False)
                socks.append(s4)

                s6_only = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
                s6_only.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s6_only.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
                s6_only.bind(("::", port))
                s6_only.listen(1024)
                s6_only.setblocking(False)
                socks.append(s6_only)
                return socks
            except OSError:
                for sock_item in socks:
                    try:
                        sock_item.close()
                    except OSError:
                        pass

    s4_fb = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s4_fb.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s4_fb.bind(("0.0.0.0", port))
    s4_fb.listen(1024)
    s4_fb.setblocking(False)
    return [s4_fb]


async def check_hub_can_reach_me(
    hub_url: str,
    probe_port: int,
    endpoints: Dict[str, Any],
    node_uuid: str,
) -> Dict[str, Any]:
    """
    上传节点 IPv4 / IPv6 与 WSS 服务端口，由 Hub 调用 wimotek-edge-agent 执行并发 TCP 三次握手探测，
    并返回权威网络类型 (network_mode, network_profile, recommended_endpoint, probe_results)。
    """
    detect_api = f"{hub_url}/api/nodes/detect-mode"
    payload = {
        "node_uuid": node_uuid,
        "cdp_port": probe_port,
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
                res_get = await client.get(f"{detect_api}?cdp_port={probe_port}")
                if res_get.status_code == 200:
                    return res_get.json()
        except Exception as e:
            print(f"⚠️ [Network Detect] Hub 探测接口调用异常: {e}", flush=True)

    return {
        "can_direct": False,
        "network_mode": "reverse_tunnel",
        "network_profile": "nat4_reverse",
        "detected_ip": endpoints.get("public_ipv4") or "",
        "recommended_port": probe_port,
        "recommended_endpoint": None,
    }


async def execute_http_auto_register(
    hub_url: str,
    node_uuid: str,
    fingerprint: str,
    wss_port: int,
    edge_wss_secret: str,
    endpoints: Dict[str, Any],
    detect_result: Optional[Dict[str, Any]] = None,
    data_dir: Path = Path("/data"),
) -> Optional[Dict[str, Any]]:
    """公网 WSS 直连登记模式 (携带节点 WSS 端口、鉴权密钥与探测到的 network_mode)"""
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
        "conn_type": "public_wss",
        "cdp_port": CDP_PORT,
        "wss_port": wss_port,
        "edge_wss_secret": edge_wss_secret,
        "public_ipv4": endpoints.get("public_ipv4"),
        "public_ipv4_port": endpoints.get("public_ipv4_port"),
        "public_ipv6": endpoints.get("public_ipv6"),
        "public_ipv6_port": endpoints.get("public_ipv6_port"),
        "network_mode": det.get("network_mode") or "direct",
        "recommended_endpoint": det.get("recommended_endpoint"),
        "ipv4_reachable": det.get("ipv4_reachable"),
        "ipv6_reachable": det.get("ipv6_reachable"),
        "session_ticket": session_ticket,
    }

    print(
        f"📡 [WSS Direct Register] 正在向 Hub 上报公网 WSS 直连节点: {api_url} "
        f"(WSS端口: {wss_port}, mode={det.get('network_mode', 'direct')})",
        flush=True,
    )
    async with httpx.AsyncClient(verify=False, timeout=8.0) as client:
        try:
            res = await client.post(api_url, json=payload, headers=headers)
            print(f"✅ [WSS Direct Register] 登记响应: {res.status_code}", flush=True)
            if res.status_code == 200:
                body = res.json()
                if body.get("session_ticket"):
                    save_session_ticket(data_dir, body["session_ticket"])
                return body
        except Exception as e:
            print(f"❌ [WSS Direct Register] 登记受阻: {e}", flush=True)
    return None


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
    """真实穿透提取本地 Chromium (127.0.0.1:9222) 全量 CookieJar"""
    local_base = await get_local_cdp_base()

    # 策略 1: 优先从活跃 Page 端点抓取
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
    """通过 WSS 通道多路复用透传 Playwright / Puppeteer CDP WebSocket 会话至本地 127.0.0.1:9222"""
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

            _, pending = await asyncio.wait(
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
    """业务指令调度执行器 (所有指令均对接本地 127.0.0.1:9222)"""
    try:
        cmd = json.loads(cmd_text)
    except Exception:
        return

    msg_type = cmd.get("type")
    action = cmd.get("action")
    req_id = cmd.get("req_id")
    payload = cmd.get("payload", {})

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


async def start_public_wss_servers(
    edge_wss_secret: str,
    data_dir: Path,
    activity_tracker: Dict[str, float],
) -> Tuple[List[Any], List[socket.socket]]:
    """启动节点双栈鉴权 WSS 服务端，供有公网可达的 Hub 主动直连"""
    ssl_ctx = _resolve_node_ssl_context(data_dir)
    join_token = os.getenv("JOIN_TOKEN", "").strip()
    socks = _create_dualstack_wss_sockets(EDGE_WSS_HOST, EDGE_WSS_PORT)

    def _get_header(headers_obj, name: str) -> str:
        if not headers_obj:
            return ""
        try:
            val = headers_obj.get(name)
            return str(val or "").strip()
        except Exception:
            return ""

    async def _ws_handler(websocket, *_unused):
        req = getattr(websocket, "request", None)
        req_headers = getattr(req, "headers", None) if req is not None else getattr(websocket, "request_headers", {})

        presented_edge = _get_header(req_headers, "x-edge-auth")
        presented_bearer = _get_header(req_headers, "authorization")
        if presented_bearer.lower().startswith("bearer "):
            presented_bearer = presented_bearer[7:].strip()
        presented_join = _get_header(req_headers, "x-join-token")

        authorized = False
        if presented_edge and secrets.compare_digest(presented_edge, edge_wss_secret):
            authorized = True
        elif presented_bearer and secrets.compare_digest(presented_bearer, edge_wss_secret):
            authorized = True
        elif join_token and presented_join and secrets.compare_digest(presented_join, join_token):
            authorized = True

        if not authorized:
            await websocket.close(code=1008, reason="Unauthorized Edge WSS Client")
            return

        activity_tracker["last_inbound"] = time.monotonic()
        print("🔐 [Edge WSS Server] Hub 鉴权直连已建立！正在桥接本地 127.0.0.1:9222 ...", flush=True)
        ws_streams: Dict[str, asyncio.Queue] = {}
        try:
            async with httpx.AsyncClient(timeout=4.0) as http_client:
                async for msg_text in websocket:
                    activity_tracker["last_inbound"] = time.monotonic()
                    if msg_text == "pong" or '"type":"pong"' in msg_text:
                        continue
                    asyncio.create_task(handle_cdp_command(websocket, http_client, msg_text, ws_streams))
        except Exception as e:
            print(f"ℹ️ [Edge WSS Server] Hub 直连会话断开: {type(e).__name__}", flush=True)
        finally:
            for q in ws_streams.values():
                await q.put(None)
            ws_streams.clear()

    servers = []
    for sock_obj in socks:
        srv = await websockets.serve(
            _ws_handler,
            sock=sock_obj,
            ssl=ssl_ctx,
            max_size=100 * 1024 * 1024,
            ping_interval=20,
            ping_timeout=10,
        )
        servers.append(srv)

    addr_desc = [(s.family.name, s.getsockname()) for s in socks]
    print(f"🛡️ [Edge WSS Server] 已就绪（双栈 TLS+密钥鉴权）: {addr_desc}", flush=True)
    return servers, socks


async def stop_public_wss_servers(servers: List[Any], socks: List[socket.socket]):
    for srv in servers:
        try:
            srv.close()
            await srv.wait_closed()
        except Exception:
            pass
    for sock_obj in socks:
        try:
            sock_obj.close()
        except OSError:
            pass


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
    """全双工反向长连接隧道 (NAT4/无公网回落通道)"""
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
            latest_ticket = load_session_ticket(data_dir)
            if latest_ticket:
                handshake_payload["session_ticket"] = latest_ticket

            print(f"🔌 [Tunnel] 正在建立反向 WebSocket 隧道: {tunnel_url} ...", flush=True)

            try:
                ws = await websockets.connect(tunnel_url, additional_headers=headers, **common_kwargs)
            except TypeError:
                ws = await websockets.connect(tunnel_url, extra_headers=headers, **common_kwargs)

            print("✅ [Tunnel] 底层隧道建立成功！正在上传节点身份与网络信息...", flush=True)
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
                print("🎉 [认证放行] 节点已被 Hub 信任放行！WSS 反向长连通道就绪！", flush=True)
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


async def run_edge_lifecycle():
    hub_url = os.getenv("HUB_URL", "").strip().rstrip("/")
    if not hub_url:
        print("[Edge Client] 未配置 HUB_URL，跳过边缘入网流程。", flush=True)
        return

    data_dir = Path(os.getenv("DATA_DIR", "/data"))
    node_uuid, fingerprint, edge_wss_secret = ensure_identity(data_dir)
    join_token = os.getenv("JOIN_TOKEN", "").strip() or None
    node_name = os.getenv("NODE_NAME", "").strip() or node_uuid
    group_name = os.getenv("NODE_GROUP", "默认分组").strip()

    ext_wss_port = int(
        os.getenv("EDGE_WSS_EXTERNAL_PORT")
        or os.getenv("DIRECT_PORT")
        or os.getenv("EXTERNAL_PORT")
        or EDGE_WSS_PORT
    )
    endpoints = collect_node_endpoints(ext_wss_port)
    tunnel_mode: Optional[bool] = parse_reverse_tunnel_mode()

    print(
        f"📋 [节点参数] 名称: {node_name} | 本地CDP: 127.0.0.1:{CDP_PORT} | "
        f"对外WSS端口: {ext_wss_port} | IPv4: {endpoints.get('public_ipv4')}:{endpoints.get('public_ipv4_port')} | "
        f"IPv6: {endpoints.get('public_ipv6')}:{endpoints.get('public_ipv6_port')} | 模式: {tunnel_mode}",
        flush=True,
    )

    # 等待本地 127.0.0.1:9222 Chromium 就绪
    async with httpx.AsyncClient(timeout=2.0) as client:
        for _ in range(15):
            try:
                local_url = await get_local_cdp_base()
                res = await client.get(f"{local_url}/json/version")
                if res.status_code == 200:
                    print(f"✅ [CDP Ready] 本地 Chromium 调试端口已就绪 ({local_url})！", flush=True)
                    break
            except Exception:
                pass
            await asyncio.sleep(1.0)

    use_public_wss = False
    detect_res: Dict[str, Any] = {}
    wss_servers: List[Any] = []
    wss_socks: List[socket.socket] = []
    activity_tracker = {"last_inbound": time.monotonic()}

    if tunnel_mode is True:
        print("⚙️ [Edge Mode] reverse_tunnel=True ➔ 【强制 WSS 反向穿透】", flush=True)
    else:
        # 先启动节点双栈鉴权 WSS 服务端，再让 Hub 探测 EDGE_WSS_PORT (9443)，彻底绕开 9222 隔离限制
        wss_servers, wss_socks = await start_public_wss_servers(edge_wss_secret, data_dir, activity_tracker)

        if tunnel_mode is False:
            print(f"⚙️ [Edge Mode] reverse_tunnel=False ➔ 【强制公网 WSS 直连 (端口: {ext_wss_port})】", flush=True)
            v6 = endpoints.get("public_ipv6")
            v4 = endpoints.get("public_ipv4")
            rec_ep = f"[{v6}]:{ext_wss_port}" if v6 and not v4 else (f"{v4}:{ext_wss_port}" if v4 else None)
            detect_res = {
                "network_mode": "direct_ipv6" if (v6 and not v4) else "direct_ipv4",
                "network_profile": "direct",
                "ipv4_reachable": bool(v4),
                "ipv6_reachable": bool(v6),
                "recommended_endpoint": rec_ep,
            }
            use_public_wss = True
        else:
            print(
                f"🧠 [Edge Mode] 自动网络检测 ➔ 上传 IP 与 WSS 端口 :{ext_wss_port}，由 Hub 执行 TCP 三次握手判定...",
                flush=True,
            )
            detect_res = await check_hub_can_reach_me(
                hub_url, probe_port=ext_wss_port, endpoints=endpoints, node_uuid=node_uuid
            )
            network_mode = detect_res.get("network_mode", "reverse_tunnel")
            can_direct = bool(detect_res.get("can_direct")) or network_mode in {
                "direct_dual", "direct_ipv4", "direct_ipv6", "direct"
            }
            if can_direct:
                rec_ep = detect_res.get("recommended_endpoint") or f"{detect_res.get('detected_ip', '')}:{ext_wss_port}"
                print(
                    f"🎯 [Smart Check] Hub 探测成功！network_mode={network_mode}, recommended_wss={rec_ep}",
                    flush=True,
                )
                print("   -> 自动判定为【公网 WSS 直连模式】：Hub 将主动直连本节点加密 WSS 端口！", flush=True)
                use_public_wss = True
            else:
                print(
                    f"🛡️ [Smart Check] Hub 探测不可达: network_mode={network_mode} (无公网/NAT4/防火墙未放行 :{ext_wss_port})",
                    flush=True,
                )
                print("   -> 关闭入站监听，自动切换为【NAT4 出站 WSS 反向穿透模式】！", flush=True)
                await stop_public_wss_servers(wss_servers, wss_socks)
                wss_servers, wss_socks = [], []

    # 1. 公网 WSS 直连保活主循环
    if use_public_wss:
        hb_interval = int(os.getenv("DIRECT_HEARTBEAT_SECONDS", "60"))
        try:
            while True:
                reg_res = await execute_http_auto_register(
                    hub_url,
                    node_uuid,
                    fingerprint,
                    ext_wss_port,
                    edge_wss_secret,
                    endpoints,
                    detect_res,
                    data_dir,
                )
                pending_tofu = bool(reg_res and reg_res.get("approval_status") == 0)
                sleep_sec = 5 if pending_tofu else hb_interval
                await asyncio.sleep(sleep_sec)

                # 自愈降级检查：若处于 auto 模式且长时间未收到 Hub 入站连接，重探是否已变为 NAT4
                if tunnel_mode is None and not pending_tofu and (time.monotonic() - activity_tracker["last_inbound"]) > 180:
                    re_det = await check_hub_can_reach_me(
                        hub_url, probe_port=ext_wss_port, endpoints=endpoints, node_uuid=node_uuid
                    )
                    re_ok = bool(re_det.get("can_direct")) or re_det.get("network_mode") in {
                        "direct_dual", "direct_ipv4", "direct_ipv6", "direct"
                    }
                    if not re_ok:
                        print("⚠️ [Auto Fallback] 节点 WSS 端口已不可达，自动降级为 WSS 反向穿透！", flush=True)
                        break
                    detect_res = re_det
        finally:
            await stop_public_wss_servers(wss_servers, wss_socks)

    # 2. NAT4 / 强制反向穿透主循环
    headers = {
        "X-Node-UUID": node_uuid,
        "X-Node-Fingerprint": fingerprint,
        "X-Node-Name": quote(node_name),
        "X-Node-Group": quote(group_name),
        "X-CDP-Port": str(CDP_PORT),
        "X-External-Port": str(ext_wss_port),
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
        "port": CDP_PORT,
        "wss_port": ext_wss_port,
        "external_port": ext_wss_port,
        "nat_type": "nat4" if tunnel_mode is True else "unknown",
    }
    if tunnel_mode is True:
        handshake_payload["reverse_tunnel"] = True
    else:
        # 通知 Hub 本节点已探测为反向模式，避免 Hub 握手阶段二次探测失败覆盖或误报
        if endpoints.get("public_ipv4"):
            handshake_payload["public_ipv4"] = endpoints["public_ipv4"]
            handshake_payload["public_ipv4_port"] = endpoints["public_ipv4_port"]
        if endpoints.get("public_ipv6"):
            handshake_payload["public_ipv6"] = endpoints["public_ipv6"]
            handshake_payload["public_ipv6_port"] = endpoints["public_ipv6_port"]

    base_ws_url = hub_url.replace("https://", "wss://").replace("http://", "ws://")
    tunnel_url = f"{base_ws_url}/api/nodes/reverse-tunnel"

    print(f"🚀 [Edge Client] 启动反向 WSS 隧道主循环 -> 目标: {tunnel_url}", flush=True)
    await run_tunnel_client(tunnel_url, headers, handshake_payload, data_dir)


def main():
    asyncio.run(run_edge_lifecycle())


if __name__ == "__main__":
    main()