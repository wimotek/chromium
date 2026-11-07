#!/usr/bin/env python3
"""
Wimotek Edge Node Client Runner
- 架构对齐：wimotek-edge-agent Optional[bool] 三态标准 (None/True/False)
- 主动心跳：每 5 秒推送应用层 ping，彻底终结 no close frame 闪断重连
- 真实抓取：Network.enable + Network.getAllCookies 穿透提取 CookieJar
- 端口直连：内部直连 127.0.0.1:9222，本地调试通道 9223 严格物理隔离
"""

import os
import sys

# 开启全局实时输出，避免 Docker 日志缓冲滞后
sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)

import json
import ssl
import time       # 【关键修复】补齐遗漏的 time 模块，杜绝 NameError
import asyncio
import hashlib
import uuid
import socket
from urllib.parse import quote
from pathlib import Path
from typing import Optional, Tuple, List
import httpx
import websockets

from wimotek_edge_agent import Config, EdgeAgent

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
        sniffed_ip = None
        for ip_api in ["http://api.ipify.org", "http://icanhazip.com"]:
            try:
                import urllib.request
                with urllib.request.urlopen(ip_api, timeout=1.5) as resp:
                    ip = resp.read().decode("utf-8").strip()
                    if ip:
                        sniffed_ip = ip
                        break
            except Exception:
                continue

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
    except Exception:
        pass

    return node_uuid, fingerprint


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


async def check_hub_can_reach_me(hub_url: str, cdp_port: int) -> Tuple[bool, str, int]:
    """回声探针：检测 Hub 是否能直接连入"""
    detect_api = f"{hub_url}/api/nodes/detect-mode?cdp_port={cdp_port}"
    async with httpx.AsyncClient(verify=False, timeout=3.5) as client:
        try:
            res = await client.get(detect_api)
            if res.status_code == 200:
                data = res.json()
                return (
                    data.get("can_direct", False),
                    data.get("detected_ip", ""),
                    data.get("recommended_port", cdp_port),
                )
        except Exception:
            pass
    return False, "", cdp_port


async def execute_http_auto_register(hub_url: str, node_uuid: str, cdp_port: int):
    """直连登记模式"""
    api_url = f"{hub_url}/api/nodes/auto-register"
    join_token = os.getenv("JOIN_TOKEN", "").strip()
    node_name = os.getenv("NODE_NAME", "").strip() or node_uuid
    group_name = os.getenv("NODE_GROUP", "默认分组").strip()

    headers = {}
    if join_token:
        headers["X-Join-Token"] = join_token

    payload = {
        "node_uuid": node_uuid,
        "name": node_name,
        "group_name": group_name,
        "cdp_port": cdp_port,
    }

    print(f"📡 [Direct Register] 正在向 Hub 发送直连登记包: {api_url} (端口: {cdp_port})", flush=True)
    async with httpx.AsyncClient(verify=False, timeout=8.0) as client:
        try:
            res = await client.post(api_url, json=payload, headers=headers)
            print(f"✅ [Direct Register] 直连接入响应: {res.status_code}", flush=True)
        except Exception as e:
            print(f"❌ [Direct Register] 直连登记受阻: {e}", flush=True)


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
            async with websockets.connect(page_ws_url, timeout=5.0) as page_ws:
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
        async with websockets.connect(ws_url, timeout=5.0) as ws:
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


async def handle_cdp_command(ws, http_client: httpx.AsyncClient, cmd_text: str):
    """业务指令调度执行器"""
    try:
        cmd = json.loads(cmd_text)
    except Exception:
        return

    action = cmd.get("action")
    req_id = cmd.get("req_id")
    payload = cmd.get("payload", {})

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

            async with websockets.connect(target_ws, timeout=8.0) as cdp_ws:
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

    elif cmd.get("type") == "ping" or action == "ping":
        await ws.send(json.dumps({"type": "pong"}))


async def keep_alive_heartbeat(ws):
    """
    核心心跳守护：每 5 秒主动向 Hub 发送一次应用层 ping
    彻底防止网络中间网关超时断开连接
    """
    while True:
        await asyncio.sleep(5)
        try:
            await ws.send(json.dumps({"action": "ping"}))
        except Exception:
            break


async def run_tunnel_client(tunnel_url: str, headers: dict, handshake_payload: dict):
    """全双工反向长连接隧道"""
    is_wss = tunnel_url.startswith("wss://")
    ssl_ctx = ssl.create_default_context()
    ssl_ctx.check_hostname = False
    ssl_ctx.verify_mode = ssl.CERT_NONE

    common_kwargs = {
        "ssl": ssl_ctx if is_wss else None,
        "max_size": 100 * 1024 * 1024,
        "ping_interval": 20,
        "ping_timeout": 10,
    }

    backoff = 2
    while True:
        try:
            print(f"🔌 [Tunnel] 正在建立反向 WebSocket 隧道: {tunnel_url} ...", flush=True)

            ws = None
            try:
                ws = await websockets.connect(tunnel_url, additional_headers=headers, **common_kwargs)
            except TypeError:
                ws = await websockets.connect(tunnel_url, extra_headers=headers, **common_kwargs)

            print("✅ [Tunnel] 底层隧道建立成功！正在发送握手包...", flush=True)
            await ws.send(json.dumps(handshake_payload))

            raw_resp = await asyncio.wait_for(ws.recv(), timeout=8.0)
            print(f"📥 [Hub 握手应答] {raw_resp}", flush=True)

            resp = json.loads(raw_resp)
            status = resp.get("status")

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

            # 激活后台 5 秒主动心跳任务
            heartbeat_task = asyncio.create_task(keep_alive_heartbeat(ws))

            try:
                async with httpx.AsyncClient(timeout=4.0) as http_client:
                    async for msg_text in ws:
                        if '"status":"approved"' in msg_text or '"status": "approved"' in msg_text:
                            print("✨ [TOFU 审核通过] 管理员已在后台批准该节点，正式激活业务通信！", flush=True)
                            continue
                        if msg_text == "pong" or '"type":"pong"' in msg_text:
                            continue
                        asyncio.create_task(handle_cdp_command(ws, http_client, msg_text))
            finally:
                heartbeat_task.cancel()

        except Exception as e:
            print(f"⚠️ [Tunnel 异常中断] {type(e).__name__}: {e}，将在 {backoff} 秒后自动重连...", flush=True)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)


def main():
    hub_url = os.getenv("HUB_URL", "").strip().rstrip("/")
    if not hub_url:
        print("[Edge Client] 未配置 HUB_URL，跳过边缘入网流程。", flush=True)
        return

    data_dir = Path("/data")
    node_uuid, fingerprint = ensure_identity(data_dir)
    join_token = os.getenv("JOIN_TOKEN", "").strip() or None
    node_name = os.getenv("NODE_NAME", "").strip() or node_uuid
    group_name = os.getenv("NODE_GROUP", "默认分组").strip()

    ext_direct_port = int(
        os.getenv("DIRECT_PORT") or os.getenv("EXTERNAL_PORT") or os.getenv("CDP_PORT") or 9222
    )

    tunnel_mode: Optional[bool] = parse_reverse_tunnel_mode()

    print(f"📋 [节点参数] 名称: {node_name} | DIRECT_PORT: {ext_direct_port} | 模式: {tunnel_mode}", flush=True)

    # 1. 强制直连
    if tunnel_mode is False:
        print(f"⚙️ [Edge Mode] reverse_tunnel=False ➔ 【强制直连登记 (端口: {ext_direct_port})】", flush=True)
        asyncio.run(execute_http_auto_register(hub_url, node_uuid, cdp_port=ext_direct_port))
        return

    # 2. 强制穿透
    elif tunnel_mode is True:
        print(f"⚙️ [Edge Mode] reverse_tunnel=True ➔ 【强制反向穿透 (端口: {ext_direct_port})】", flush=True)

    # 3. 智能自适应
    else:
        print(f"🧠 [Edge Mode] reverse_tunnel=None ➔ 【智能自适应探测 (测试端口: {ext_direct_port})】...", flush=True)
        can_direct, detected_ip, rec_port = asyncio.run(
            check_hub_can_reach_me(hub_url, cdp_port=ext_direct_port)
        )

        if can_direct:
            print(f"🎯 [Smart Check] 探测成功！Hub 可直接反向连通本机 ({detected_ip}:{rec_port})")
            print("   -> 自动判定为直连网络，执行直连注册，不占用 WebSocket 反向连接池。", flush=True)
            asyncio.run(execute_http_auto_register(hub_url, node_uuid, cdp_port=rec_port))
            return
        else:
            print(f"🛡️ [Smart Check] 探测确认：无法通过 {detected_ip}:{ext_direct_port} 直连 (处于 NAT4/防火墙拦截)")
            print("   -> 自动无感切换为【NAT4 出站反向长连接穿透模式】！", flush=True)

    # 预先等待 Chromium 内部 9222 端口完全就绪
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

    headers = {
        "X-Node-UUID": node_uuid,
        "X-Node-Fingerprint": fingerprint,
        "X-Node-Name": quote(node_name),
        "X-Node-Group": quote(group_name),
        "X-CDP-Port": str(ext_direct_port),
    }
    if join_token:
        headers["X-Join-Token"] = join_token

    handshake_payload = {
        "node_uuid": node_uuid,
        "public_key_fingerprint": fingerprint,
        "join_token": join_token,
        "name": node_name,
        "group": group_name,
        "port": ext_direct_port,
        "nat_type": "nat4_reverse",
        "reverse_tunnel": True,
    }

    base_ws_url = hub_url.replace("https://", "wss://").replace("http://", "ws://")
    tunnel_url = f"{base_ws_url}/api/nodes/reverse-tunnel"

    print(f"🚀 [Edge Client] 启动隧道主循环 -> 目标: {tunnel_url}", flush=True)
    asyncio.run(run_tunnel_client(tunnel_url, headers, handshake_payload))


if __name__ == "__main__":
    main()