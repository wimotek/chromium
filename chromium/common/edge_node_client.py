#!/usr/bin/env python3
"""
Wimotek Edge Node Client Runner
- 架构对齐：100% 遵循 wimotek-edge-agent 的 Optional[bool] 三态定义
  * None  (默认): 触发双向回声探针智能自适应检测 (有公网走直连，NAT4/防火墙无感切穿透)
  * True  (强制): 强制建立出站 WSS 反向长连接隧道
  * False (强制): 强制执行 HTTP 直连上报登记
- 端口直连：直接操作 Chromium 原生端口 127.0.0.1:9222 (支持 CDP_PORT / DIRECT_PORT / EXTERNAL_PORT 自定义)
- 状态固化：/data/.edge_identity.json 持久化 UUID 与公钥指纹，容器重启永不产生幽灵节点
"""

import os
import sys
import json
import ssl
import asyncio
import hashlib
import uuid
import socket
from pathlib import Path
from typing import Optional, Tuple
import httpx
import websockets

from wimotek_edge_agent import Config, EdgeAgent
from wimotek_edge_agent.transport import JsonLineTransport, TunnelDialer

# 容器内部直连 Chromium 原生端口 (默认 9222)
CDP_PORT = int(os.getenv("CDP_PORT", "9222"))
LOCAL_CDP_HTTP = f"http://127.0.0.1:{CDP_PORT}"


def ensure_identity(data_dir: Path) -> Tuple[str, str]:
    """
    智能三级持久化身份机制：
    1. 优先读取持久化文件，确保容器重启指纹一致；
    2. 优先采用用户环境变量 NODE_NAME；
    3. 未指定时自动嗅探公网出口 IP 拼接 (如 Node-112.97.xx.xx)；
    4. 嗅探失败回退为主机名 (如 Node-c1a8d0)。
    """
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
    """
    对齐 wimotek_edge_agent.Config 的 Optional[bool] 三态标准：
    - 返回 None:  未指定、留空、auto、none ➔ 【智能回声自适应探测】
    - 返回 True:  显式指定 true/1/yes ➔ 【强制反向隧道穿透】
    - 返回 False: 显式指定 false/0/no ➔ 【强制直连登记】
    """
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


async def check_hub_can_reach_me(hub_url: str, cdp_port: int = 9222) -> Tuple[bool, str, int]:
    """
    【双向回声探针】：请求 Hub 尝试反向握手本机的宿主机暴露端口。
    能在 2 秒内打通说明具备真实公网/局域网直连能力；打不通判定为处于 NAT4 或防火墙后。
    """
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


async def execute_http_auto_register(hub_url: str, node_uuid: str, cdp_port: int = 9222):
    """【直连模式专享】：向 Hub 发送一次 HTTP 登记，后续由 Hub 主动直连，不占 WebSocket 隧道"""
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

    print(f"📡 [Direct Register] 正在向 Hub 发送直连登记包: {api_url} (直连端口: {cdp_port})")
    async with httpx.AsyncClient(verify=False, timeout=8.0) as client:
        try:
            res = await client.post(api_url, json=payload, headers=headers)
            print(f"✅ [Direct Register] 直连接入完成: 响应码 {res.status_code}")
        except Exception as e:
            print(f"❌ [Direct Register] 直连登记受阻: {e}")


class WebSocketTunnelDialer:
    """反向隧道拨号器：实现 wimotek_edge_agent 的 TunnelDialer 抽象协议"""

    async def dial(self, url: str, ssl_context: ssl.SSLContext, server_hostname: str):
        is_wss = url.startswith("wss://")
        ws = await websockets.connect(
            url,
            ssl=ssl_context if is_wss else None,
            max_size=100 * 1024 * 1024,
            ping_interval=20,
            ping_timeout=10,
        )
        reader = asyncio.StreamReader()

        class WSStreamWriter:
            def write(self, data: bytes):
                text = data.decode("utf-8").strip()
                if text:
                    asyncio.create_task(ws.send(text))

            async def drain(self):
                pass

            def close(self):
                asyncio.create_task(ws.close())

            async def wait_closed(self):
                pass

            def get_extra_info(self, name: str):
                return None

        async def pump_incoming():
            try:
                async for message in ws:
                    if isinstance(message, str):
                        reader.feed_data((message + "\n").encode("utf-8"))
            except Exception:
                reader.feed_eof()

        asyncio.create_task(pump_incoming())
        return reader, WSStreamWriter()


async def cdp_data_handler(transport: JsonLineTransport, ctx):
    """
    反向隧道业务处理器：
    接收 Hub 借道发来的指令，直连本地原生 127.0.0.1:CDP_PORT 操控 Chromium 并推回结果
    """
    async with httpx.AsyncClient(timeout=4.0) as client:
        while True:
            try:
                cmd = await transport.read_message()
            except Exception:
                break

            action = cmd.get("action")
            req_id = cmd.get("req_id")
            payload = cmd.get("payload", {})

            # 1. 抓取全量 Cookies
            if action == "fetch_cookies":
                try:
                    ver_res = await client.get(f"{LOCAL_CDP_HTTP}/json/version")
                    ws_url = ver_res.json()["webSocketDebuggerUrl"]
                    async with websockets.connect(ws_url, timeout=5.0) as cdp_ws:
                        await cdp_ws.send(json.dumps({"id": 1, "method": "Storage.getCookies"}))
                        raw = await asyncio.wait_for(cdp_ws.recv(), timeout=5.0)
                        cookies = json.loads(raw).get("result", {}).get("cookies", [])
                    await transport.write_message({"req_id": req_id, "status": "ok", "cookies": cookies})
                except Exception as e:
                    await transport.write_message({"req_id": req_id, "status": "error", "message": str(e)})

            # 2. 注入 Cookies (优先写入 Page 端点)
            elif action == "inject_cookies":
                to_inject = payload.get("cookies", [])
                try:
                    target_ws = None
                    try:
                        list_res = await client.get(f"{LOCAL_CDP_HTTP}/json/list")
                        targets = list_res.json()
                        page_targets = [
                            t for t in targets if t.get("type") == "page" and "webSocketDebuggerUrl" in t
                        ]
                        if page_targets:
                            target_ws = page_targets[0]["webSocketDebuggerUrl"]
                    except Exception:
                        pass

                    if not target_ws:
                        ver_res = await client.get(f"{LOCAL_CDP_HTTP}/json/version")
                        target_ws = ver_res.json()["webSocketDebuggerUrl"]

                    async with websockets.connect(target_ws, timeout=8.0) as cdp_ws:
                        await cdp_ws.send(json.dumps({"id": 1, "method": "Network.enable"}))
                        await cdp_ws.recv()
                        await cdp_ws.send(
                            json.dumps(
                                {
                                    "id": 2,
                                    "method": "Network.setCookies",
                                    "params": {"cookies": to_inject},
                                }
                            )
                        )
                        await cdp_ws.recv()

                    await transport.write_message(
                        {"req_id": req_id, "status": "ok", "injected_count": len(to_inject)}
                    )
                except Exception as e:
                    await transport.write_message({"req_id": req_id, "status": "error", "message": str(e)})

            # 3. 清理 Cookies
            elif action == "purge_cookies":
                await transport.write_message({"req_id": req_id, "status": "ok", "purged_count": 0})

            # 4. 获取本地浏览器调试版本
            elif action == "get_version":
                try:
                    res = await client.get(f"{LOCAL_CDP_HTTP}/json/version")
                    await transport.write_message({"req_id": req_id, "status": "ok", "version": res.json()})
                except Exception as e:
                    await transport.write_message({"req_id": req_id, "status": "error", "message": str(e)})

            # 5. 心跳应答
            elif cmd.get("type") == "ping" or action == "ping":
                await transport.write_message({"type": "pong"})


def main():
    hub_url = os.getenv("HUB_URL", "").strip().rstrip("/")
    if not hub_url:
        print("[Edge Client] 未配置 HUB_URL，跳过边缘入网流程。")
        return

    data_dir = Path("/data")
    node_uuid, fingerprint = ensure_identity(data_dir)

    # 动态获取宿主机暴露端口 (例如 -p 1922:9222 启动时传入 DIRECT_PORT=1922)
    ext_direct_port = int(
        os.getenv("DIRECT_PORT") or os.getenv("EXTERNAL_PORT") or os.getenv("CDP_PORT") or 9222
    )

    # 解析三态：None (智能) | True (强制穿透) | False (强制直连)
    tunnel_mode: Optional[bool] = parse_reverse_tunnel_mode()

    # -------------------------------------------------------------
    # 分支 1：False ➔ 强制直连登记
    # -------------------------------------------------------------
    if tunnel_mode is False:
        print(f"⚙️ [Edge Mode] reverse_tunnel=False ➔ 【强制直连模式 (目标端口: {ext_direct_port})】")
        asyncio.run(execute_http_auto_register(hub_url, node_uuid, cdp_port=ext_direct_port))
        return

    # -------------------------------------------------------------
    # 分支 2：True ➔ 强制反向穿透
    # -------------------------------------------------------------
    elif tunnel_mode is True:
        print("⚙️ [Edge Mode] reverse_tunnel=True ➔ 【强制反向穿透模式】(跳过网络探测)")

    # -------------------------------------------------------------
    # 分支 3：None ➔ 原生智能自动探测 (Default)
    # -------------------------------------------------------------
    else:
        print(f"🧠 [Edge Mode] reverse_tunnel=None ➔ 【智能自适应模式 (探测目标端口: {ext_direct_port})】...")
        print("   -> 正在向 Hub 发送回声探针，检测 Hub 能否直接反向连通本机的直连端口...")

        can_direct, detected_ip, rec_port = asyncio.run(
            check_hub_can_reach_me(hub_url, cdp_port=ext_direct_port)
        )

        if can_direct:
            print(f"🎯 [Smart Check] 探测成功！Hub 可直接反向连通本机 ({detected_ip}:{rec_port})")
            print("   -> 自动判定为直连网络，执行直连注册，不占用 WebSocket 反向连接池。")
            asyncio.run(execute_http_auto_register(hub_url, node_uuid, cdp_port=rec_port))
            return
        else:
            print(f"🛡️ [Smart Check] 探测确认：无法通过 {detected_ip}:{ext_direct_port} 直连 (处于 NAT4/防火墙拦截)")
            print("   -> 自动无感切换为【NAT4 出站反向长连接穿透模式】！")

    # 启动反向长连接隧道
    config = Config.from_env()
    config.data_dir = data_dir

    # 满足 EdgeAgent 实例化至少 32 字节密钥硬性要求
    if not config.token_secret:
        config.token_secret = b"wimotek-edge-node-client-secret-32b-ok"

    config.node_uuid = node_uuid
    config.public_key_fingerprint = fingerprint
    config.join_token = os.getenv("JOIN_TOKEN", "").strip() or None
    config.nat_type = "nat4_reverse"

    agent = EdgeAgent(config, data_handler=cdp_data_handler)
    tunnel_url = hub_url.replace("https://", "wss://").replace("http://", "ws://") + "/api/nodes/reverse-tunnel"

    ssl_ctx = ssl.create_default_context()
    ssl_ctx.check_hostname = False
    ssl_ctx.verify_mode = ssl.CERT_NONE

    print(f"🚀 [Edge Client] 出站反向隧道启动 -> 目标: {tunnel_url}")
    print(f"   -> 节点标识 (UUID): {node_uuid}")
    print(f"   -> 证书指纹 (FP)  : {fingerprint}")
    print(f"   -> 本地 Chromium : {LOCAL_CDP_HTTP} (原生直连)")

    # 运行反向隧道 (内置指数退避自愈重连)
    asyncio.run(agent.run_reverse_tunnel(
        url=tunnel_url,
        dialer=WebSocketTunnelDialer(),
        ssl_context=ssl_ctx
    ))


if __name__ == "__main__":
    main()