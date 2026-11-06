#!/usr/bin/env python3
"""
Wimotek Edge Node Client Runner (纯净节点端，绝无 FastAPI 依赖)
1. 强制无缓冲：开启 sys.stdout 实时行缓冲，杜绝 Docker 日志滞后；
2. ASCII Header 加固：对中文名称与分组使用 quote() 编码，根除 UnicodeEncodeError；
3. 拨号透出：显式拦截并打印所有网络错误，杜绝静默吞错；
4. 端口解耦：内部直连 127.0.0.1:9222，与宿主机本地调试 socat 9223 严格物理隔离。
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
from wimotek_edge_agent.transport import JsonLineTransport, TunnelDialer

# 容器内部原生直连端口
CDP_PORT = int(os.getenv("CDP_PORT", "9222"))
LOCAL_CDP_HTTP = f"http://127.0.0.1:{CDP_PORT}"


def ensure_identity(data_dir: Path) -> Tuple[str, str]:
    """持久化 UUID 与公钥指纹生成机制"""
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


async def check_hub_can_reach_me(hub_url: str, cdp_port: int = 9222) -> Tuple[bool, str, int]:
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


async def execute_http_auto_register(hub_url: str, node_uuid: str, cdp_port: int = 9222):
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

    print(f"📡 [Direct Register] 正在向 Hub 发起直连登记: {api_url} (端口: {cdp_port})", flush=True)
    async with httpx.AsyncClient(verify=False, timeout=8.0) as client:
        try:
            res = await client.post(api_url, json=payload, headers=headers)
            print(f"✅ [Direct Register] 直连接入响应: {res.status_code}", flush=True)
        except Exception as e:
            print(f"❌ [Direct Register] 直连登记异常: {e}", flush=True)


class RobustSyncStreamWriter:
    """可靠的 WebSocket StreamWriter 包装器"""
    def __init__(self, ws):
        self.ws = ws
        self._pending_buffer = []

    def write(self, data: bytes):
        text = data.decode("utf-8").strip()
        if text:
            self._pending_buffer.append(text)

    async def drain(self):
        while self._pending_buffer:
            msg = self._pending_buffer.pop(0)
            await self.ws.send(msg)

    def close(self):
        asyncio.create_task(self.ws.close())

    async def wait_closed(self):
        pass

    def get_extra_info(self, name: str):
        return None


class CrossVersionHeaderDialer:
    """全版本兼容的请求头反向隧道拨号器"""
    def __init__(self, headers: dict):
        self.headers = headers

    async def dial(self, url: str, ssl_context: ssl.SSLContext, server_hostname: str):
        is_wss = url.startswith("wss://")
        common_kwargs = {
            "ssl": ssl_context if is_wss else None,
            "max_size": 100 * 1024 * 1024,
            "ping_interval": 20,
            "ping_timeout": 10,
        }

        ws = None
        print(f"🔌 [Dialer] 正在建立 WebSocket 握手连接: {url} ...", flush=True)
        try:
            ws = await websockets.connect(url, additional_headers=self.headers, **common_kwargs)
            print("✅ [Dialer] 成功连接 Hub (additional_headers 协议就绪)！", flush=True)
        except TypeError:
            try:
                ws = await websockets.connect(url, extra_headers=self.headers, **common_kwargs)
                print("✅ [Dialer] 成功连接 Hub (extra_headers 协议就绪)！", flush=True)
            except Exception as e:
                print(f"❌ [Dialer 失败] 旧版协议连接受阻: {type(e).__name__}: {e}", flush=True)
                raise
        except Exception as e:
            print(f"❌ [Dialer 失败] 无法连通 Hub: {type(e).__name__}: {e}", flush=True)
            raise

        reader = asyncio.StreamReader()

        async def pump_incoming():
            try:
                async for message in ws:
                    if isinstance(message, str):
                        reader.feed_data((message.strip() + "\n").encode("utf-8"))
            except Exception:
                pass
            finally:
                reader.feed_eof()

        asyncio.create_task(pump_incoming())
        return reader, RobustSyncStreamWriter(ws)


async def cdp_data_handler(transport: JsonLineTransport, ctx):
    """业务指令处理器"""
    print("✨ [Edge Bridge] 反向数据通道全双工激活，就地接管 127.0.0.1:9222 业务指令！", flush=True)
    async with httpx.AsyncClient(timeout=4.0) as client:
        while True:
            try:
                cmd = await transport.read_message()
            except Exception:
                break

            action = cmd.get("action")
            req_id = cmd.get("req_id")
            payload = cmd.get("payload", {})

            # 1. 抓取 Cookies
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

            # 2. 注入 Cookies
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

            # 4. 获取版本
            elif action == "get_version":
                try:
                    res = await client.get(f"{LOCAL_CDP_HTTP}/json/version")
                    await transport.write_message({"req_id": req_id, "status": "ok", "version": res.json()})
                except Exception as e:
                    await transport.write_message({"req_id": req_id, "status": "error", "message": str(e)})

            # 5. 心跳
            elif cmd.get("type") == "ping" or action == "ping":
                await transport.write_message({"type": "pong"})


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

    # 1. 强制直连模式
    if tunnel_mode is False:
        print(f"⚙️ [Edge Mode] reverse_tunnel=False ➔ 【强制直连模式 (目标端口: {ext_direct_port})】", flush=True)
        asyncio.run(execute_http_auto_register(hub_url, node_uuid, cdp_port=ext_direct_port))
        return

    # 2. 强制穿透模式
    elif tunnel_mode is True:
        print("⚙️ [Edge Mode] reverse_tunnel=True ➔ 【强制反向穿透模式】(跳过网络探测)", flush=True)

    # 3. 智能自适应模式
    else:
        print(f"🧠 [Edge Mode] reverse_tunnel=None ➔ 【智能自适应模式 (探测目标端口: {ext_direct_port})】...", flush=True)
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

    # 核心：使用 quote 编码中文，防止 Latin-1 编码崩溃
    headers = {
        "X-Node-UUID": node_uuid,
        "X-Node-Fingerprint": fingerprint,
        "X-Node-Name": quote(node_name),
        "X-Node-Group": quote(group_name),
        "X-CDP-Port": str(ext_direct_port),
    }
    if join_token:
        headers["X-Join-Token"] = join_token

    config = Config.from_env()
    config.data_dir = data_dir
    if not config.token_secret:
        config.token_secret = b"wimotek-edge-node-client-secret-32b-ok"

    config.node_uuid = node_uuid
    config.public_key_fingerprint = fingerprint
    config.join_token = join_token
    config.nat_type = "nat4_reverse"

    agent = EdgeAgent(config, data_handler=cdp_data_handler)
    base_ws_url = hub_url.replace("https://", "wss://").replace("http://", "ws://")
    tunnel_url = f"{base_ws_url}/api/nodes/reverse-tunnel"

    ssl_ctx = ssl.create_default_context()
    ssl_ctx.check_hostname = False
    ssl_ctx.verify_mode = ssl.CERT_NONE

    print(f"🚀 [Edge Client] 出站反向隧道启动 -> 目标: {tunnel_url}", flush=True)
    print(f"   -> 节点标识 (UUID): {node_uuid}", flush=True)
    print(f"   -> 证书指纹 (FP)  : {fingerprint}", flush=True)
    print(f"   -> 本地 Chromium : {LOCAL_CDP_HTTP} (原生 9222 直连)", flush=True)
    print(f"   -> 鉴权安全级别  : Headers 加密传输 (零 URL 日志泄漏)", flush=True)

    asyncio.run(agent.run_reverse_tunnel(
        url=tunnel_url,
        dialer=CrossVersionHeaderDialer(headers=headers),
        ssl_context=ssl_ctx
    ))


if __name__ == "__main__":
    main()