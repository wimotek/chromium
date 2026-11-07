#!/usr/bin/env python3
"""
Wimotek Edge Node Client Runner (全透明诊断与加固终极版)
- 全透明：收发握手帧明文打印，彻底消灭静默断开死循环；
- 端口直透：启动强制打印 DIRECT_PORT，并将 3030 端口同步报给 Hub；
- 原生直连：内部直连 127.0.0.1:9222，与本地调试 socat 9223 严格物理隔离。
"""

import os
import sys

# 开启全局实时输出，日志秒推 docker logs
sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)

import json
import ssl
import asyncio
import hashlib
import uuid
import socket
from urllib.parse import quote
from pathlib import Path
from typing import Optional, Tuple
import httpx
import websockets

from wimotek_edge_agent import Config, EdgeAgent

# 容器内部原生直连端口
CDP_PORT = int(os.getenv("CDP_PORT", "9222"))
LOCAL_CDP_HTTP = f"http://127.0.0.1:{CDP_PORT}"


def ensure_identity(data_dir: Path) -> Tuple[str, str]:
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

    print(f"📡 [Direct Register] 正在向 Hub 发送直连登记包: {api_url} (直连端口: {cdp_port})", flush=True)
    async with httpx.AsyncClient(verify=False, timeout=8.0) as client:
        try:
            res = await client.post(api_url, json=payload, headers=headers)
            print(f"✅ [Direct Register] 直连接入响应: {res.status_code} | {res.text}", flush=True)
        except Exception as e:
            print(f"❌ [Direct Register] 直连登记异常: {e}", flush=True)


async def handle_cdp_command(ws, http_client, cmd_text: str):
    """就地操纵 127.0.0.1:9222 执行指令并将结果推回 Hub"""
    try:
        cmd = json.loads(cmd_text)
    except Exception:
        return

    action = cmd.get("action")
    req_id = cmd.get("req_id")
    payload = cmd.get("payload", {})

    if action == "fetch_cookies":
        try:
            ver_res = await http_client.get(f"{LOCAL_CDP_HTTP}/json/version")
            ws_url = ver_res.json()["webSocketDebuggerUrl"]
            async with websockets.connect(ws_url, timeout=5.0) as cdp_ws:
                await cdp_ws.send(json.dumps({"id": 1, "method": "Storage.getCookies"}))
                raw = await asyncio.wait_for(cdp_ws.recv(), timeout=5.0)
                cookies = json.loads(raw).get("result", {}).get("cookies", [])
            await ws.send(json.dumps({"req_id": req_id, "status": "ok", "cookies": cookies}))
        except Exception as e:
            await ws.send(json.dumps({"req_id": req_id, "status": "error", "message": str(e)}))

    elif action == "inject_cookies":
        to_inject = payload.get("cookies", [])
        try:
            target_ws = None
            try:
                list_res = await http_client.get(f"{LOCAL_CDP_HTTP}/json/list")
                targets = list_res.json()
                page_targets = [t for t in targets if t.get("type") == "page" and "webSocketDebuggerUrl" in t]
                if page_targets:
                    target_ws = page_targets[0]["webSocketDebuggerUrl"]
            except Exception:
                pass

            if not target_ws:
                ver_res = await http_client.get(f"{LOCAL_CDP_HTTP}/json/version")
                target_ws = ver_res.json()["webSocketDebuggerUrl"]

            async with websockets.connect(target_ws, timeout=8.0) as cdp_ws:
                await cdp_ws.send(json.dumps({"id": 1, "method": "Network.enable"}))
                await cdp_ws.recv()
                await cdp_ws.send(json.dumps({
                    "id": 2,
                    "method": "Network.setCookies",
                    "params": {"cookies": to_inject}
                }))
                await cdp_ws.recv()

            await ws.send(json.dumps({"req_id": req_id, "status": "ok", "injected_count": len(to_inject)}))
        except Exception as e:
            await ws.send(json.dumps({"req_id": req_id, "status": "error", "message": str(e)}))

    elif action == "purge_cookies":
        await ws.send(json.dumps({"req_id": req_id, "status": "ok", "purged_count": 0}))

    elif action == "get_version":
        try:
            res = await http_client.get(f"{LOCAL_CDP_HTTP}/json/version")
            await ws.send(json.dumps({"req_id": req_id, "status": "ok", "version": res.json()}))
        except Exception as e:
            await ws.send(json.dumps({"req_id": req_id, "status": "error", "message": str(e)}))

    elif cmd.get("type") == "ping" or action == "ping":
        await ws.send(json.dumps({"type": "pong"}))


async def run_tunnel_client(tunnel_url: str, headers: dict, handshake_payload: dict):
    """透明双向反向隧道执行器 (带全量日志追踪)"""
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
            print(f"🔌 [Tunnel] 正在建立 WebSocket 隧道连接: {tunnel_url} ...", flush=True)

            ws = None
            try:
                ws = await websockets.connect(tunnel_url, additional_headers=headers, **common_kwargs)
            except TypeError:
                ws = await websockets.connect(tunnel_url, extra_headers=headers, **common_kwargs)

            print("✅ [Tunnel] 底层 WebSocket 连接建立成功！正在发送身份握手包...", flush=True)
            await ws.send(json.dumps(handshake_payload))

            # 接收 Hub 握手响应
            raw_resp = await asyncio.wait_for(ws.recv(), timeout=8.0)
            print(f"📥 [Hub 握手应答] {raw_resp}", flush=True)

            resp = json.loads(raw_resp)
            status = resp.get("status")

            if status == "ok":
                print("🎉 [认证放行] 节点已被 Hub 信任放行！全双工隧道正式就绪！", flush=True)
                backoff = 2
            elif status == "pending_tofu":
                print("⏳ [TOFU 隔离] 节点已接入待审队列，等待管理员在 Hub 后台点击 [认领并信任] ...", flush=True)
            elif status == "denied":
                print(f"❌ [准入拒绝] Hub 拒绝接入: {resp.get('reason')}，10 秒后重试...", flush=True)
                await ws.close()
                await asyncio.sleep(10)
                continue

            # 开始全双工双向指令监听
            async with httpx.AsyncClient(timeout=4.0) as http_client:
                async for msg_text in ws:
                    # 收到 approved 唤醒通知
                    if '"status":"approved"' in msg_text or '"status": "approved"' in msg_text:
                        print("✨ [TOFU 审核通过] 管理员已在后台批准该节点，正式激活业务通信！", flush=True)
                        continue
                    # 收到业务指令
                    asyncio.create_task(handle_cdp_command(ws, http_client, msg_text))

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

    # 关键加固：读取 DIRECT_PORT 并在日志中明确展示
    ext_direct_port = int(
        os.getenv("DIRECT_PORT") or os.getenv("EXTERNAL_PORT") or os.getenv("CDP_PORT") or 9222
    )

    tunnel_mode: Optional[bool] = parse_reverse_tunnel_mode()

    print(f"📋 [节点参数] 名称: {node_name} | DIRECT_PORT: {ext_direct_port} | 模式: {tunnel_mode}", flush=True)

    # 1. 强制直连模式
    if tunnel_mode is False:
        print(f"⚙️ [Edge Mode] reverse_tunnel=False ➔ 【强制直连登记 (目标端口: {ext_direct_port})】", flush=True)
        asyncio.run(execute_http_auto_register(hub_url, node_uuid, cdp_port=ext_direct_port))
        return

    # 2. 强制穿透模式
    elif tunnel_mode is True:
        print(f"⚙️ [Edge Mode] reverse_tunnel=True ➔ 【强制反向穿透 (携带端口: {ext_direct_port})】", flush=True)

    # 3. 智能自适应模式
    else:
        print(f"🧠 [Edge Mode] reverse_tunnel=None ➔ 【智能自适应探测 (测试端口: {ext_direct_port})】...", flush=True)
        can_direct, detected_ip, rec_port = asyncio.run(
            check_hub_can_reach_me(hub_url, cdp_port=ext_direct_port)
        )

        if can_direct:
            print(f"🎯 [Smart Check] 探测成功！Hub 可直接反向连通本机 ({detected_ip}:{rec_port})", flush=True)
            print("   -> 自动判定为直连网络，执行直连注册，不占用 WebSocket 反向连接池。", flush=True)
            asyncio.run(execute_http_auto_register(hub_url, node_uuid, cdp_port=rec_port))
            return
        else:
            print(f"🛡️ [Smart Check] 探测确认：无法通过 {detected_ip}:{ext_direct_port} 直连 (处于 NAT4/防火墙拦截)", flush=True)
            print("   -> 自动无感切换为【NAT4 出站反向长连接穿透模式】！", flush=True)

    # 组装 Headers 与握手包 (携带真实的 3030 端口)
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