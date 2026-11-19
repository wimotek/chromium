# -*- coding: utf-8 -*-
"""
WSS Reverse Tunnel Supervisor & Heartbeat Watchdog for Sing-box Edge Core
使用标准异步 WebSocket，对接到 Hub 端 /api/tunnel/bridge/{node_id}
提供：双向字节桥接、Keepalive Ping-Pong 心跳、指数退避断线重连与真实连接状态跟踪
"""
import asyncio
import logging
import ssl

from .config import AppConfig

logger = logging.getLogger("WssTunnel")


class WssTunnelSupervisor:
    def __init__(self, node_id: str, node_key: str, bridge_port: int = 10086):
        self.node_id = node_id
        self.node_key = node_key
        self.bridge_port = bridge_port
        self.is_running = True
        self.is_connected = False
        self.active_connections = 0

    async def _bridge_streams(self, ws, local_reader: asyncio.StreamReader, local_writer: asyncio.StreamWriter):
        """双向全双工字节流桥接：WS <---> 本地 Sing-box (127.0.0.1:10086)"""
        async def forward_ws_to_local():
            try:
                async for message in ws:
                    if isinstance(message, bytes):
                        local_writer.write(message)
                        await local_writer.drain()
                    elif isinstance(message, str):
                        data = message.encode("utf-8")
                        local_writer.write(data)
                        await local_writer.drain()
            except Exception:
                pass
            finally:
                local_writer.close()

        async def forward_local_to_ws():
            try:
                while True:
                    data = await local_reader.read(32768)
                    if not data:
                        break
                    await ws.send(data)
            except Exception:
                pass
            finally:
                try:
                    await ws.close()
                except Exception:
                    pass

        await asyncio.gather(forward_ws_to_local(), forward_local_to_ws(), return_exceptions=True)

    async def run_tunnel_worker(self):
        """隧道主循环：保持与 Hub 中枢的反向隧道连接，一旦断开按指数退避自动重连"""
        try:
            import websockets
        except ImportError:
            print("[WssTunnel] 提示: 未安装 websockets 库，跳过独立隧道", flush=True)
            return

        if not AppConfig.PANEL_URL:
            return

        hub_url = AppConfig.PANEL_URL
        if hub_url.startswith("https://"):
            ws_base = "wss://" + hub_url[8:]
        elif hub_url.startswith("http://"):
            ws_base = "ws://" + hub_url[7:]
        else:
            ws_base = f"wss://{hub_url}"

        tunnel_endpoint = f"{ws_base}/api/tunnel/bridge/{self.node_id}"

        ssl_ctx = ssl.create_default_context()
        ssl_ctx.check_hostname = False
        ssl_ctx.verify_mode = ssl.CERT_NONE

        backoff = 1
        print(f"[WssTunnel] 🚀 WSS 隧道守护线程就绪，反穿通道目标: {tunnel_endpoint}", flush=True)

        while self.is_running:
            try:
                headers = {
                    "X-Node-ID": self.node_id,
                    "X-Node-Key": self.node_key,
                    "User-Agent": "wimotek-edge-agent/1.0",
                }

                async with websockets.connect(
                    tunnel_endpoint,
                    extra_headers=headers,
                    ssl=ssl_ctx if ws_base.startswith("wss://") else None,
                    ping_interval=15,
                    ping_timeout=20,
                    max_size=10 * 1024 * 1024,
                ) as ws:
                    print("[WssTunnel] 🟢 已成功建立到 Hub 的反向 WebSocket 隧道通道！", flush=True)
                    backoff = 1

                    try:
                        local_reader, local_writer = await asyncio.open_connection("127.0.0.1", self.bridge_port)
                        self.is_connected = True
                        await self._bridge_streams(ws, local_reader, local_writer)
                    except Exception as e:
                        print(f"[WssTunnel] 本地 Sing-box 核心尚未就绪 ({e})，稍后重试", flush=True)
                        await asyncio.sleep(2)
                    finally:
                        self.is_connected = False

            except Exception:
                self.is_connected = False
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60)
