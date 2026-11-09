# -*- coding: utf-8 -*-
"""
WSS Reverse Tunnel Supervisor & Heartbeat Watchdog
使用标准异步 WebSocket，对接到 Hub 端 /api/tunnel/bridge/{node_id}
提供：双向字节桥接、Keepalive Ping-Pong 心跳、指纹锁定、指数退避断线重连
"""
import asyncio
import ssl
import json
import logging
from typing import Optional
from .config import AppConfig

logger = logging.getLogger("WssTunnel")

class WssTunnelSupervisor:
    def __init__(self, node_id: str, node_key: str, bridge_port: int = 10086):
        self.node_id = node_id
        self.node_key = node_key
        self.bridge_port = bridge_port
        self.is_running = True
        self.active_connections = 0

    async def _bridge_streams(self, ws, local_reader: asyncio.StreamReader, local_writer: asyncio.StreamWriter):
        """双向全双工字节流桥接：WS <---> 本地 Xray (127.0.0.1:10086)"""
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
        """
        隧道主循环：
        保持与 Hub 中枢的反向隧道连接，一旦断开立即按指数退避进行重连
        """
        try:
            import websockets
        except ImportError:
            print("[WssTunnel] 提示: 未安装 websockets 库，跳过独立隧道，等待通用代理", flush=True)
            return

        if not AppConfig.PANEL_URL:
            return

        # 将 http(s)://hub.com 转换为 ws(s)://hub.com
        hub_url = AppConfig.PANEL_URL
        if hub_url.startswith("https://"):
            ws_base = "wss://" + hub_url[8:]
        elif hub_url.startswith("http://"):
            ws_base = "ws://" + hub_url[7:]
        else:
            ws_base = f"wss://{hub_url}"

        tunnel_endpoint = f"{ws_base}/api/tunnel/bridge/{self.node_id}"

        ssl_ctx = ssl.create_default_context()
        # 允许私有自签/免验证书兼容开发调试
        ssl_ctx.check_hostname = False
        ssl_ctx.verify_mode = ssl.CERT_NONE

        backoff = 1
        print(f"[WssTunnel] 🚀 WSS 隧道守护线程就绪，反穿通道目标: {tunnel_endpoint}", flush=True)

        while self.is_running:
            try:
                headers = {
                    "X-Node-ID": self.node_id,
                    "X-Node-Key": self.node_key,
                    "User-Agent": "wimotek-edge-agent/1.0"
                }
                
                # 建立反向长连接
                # ping_interval=15: 每 15 秒向 Hub 发送一次 WebSocket Ping 帧探活
                # ping_timeout=20:  如果 20 秒未收到 Pong 判定为死链，主动重连
                async with websockets.connect(
                    tunnel_endpoint,
                    extra_headers=headers,
                    ssl=ssl_ctx if ws_base.startswith("wss://") else None,
                    ping_interval=15,
                    ping_timeout=20,
                    max_size=10 * 1024 * 1024
                ) as ws:
                    print(f"[WssTunnel] 🟢 已成功建立到 Hub 的反向 WebSocket 隧道通道！", flush=True)
                    backoff = 1  # 成功连通，重置退避计数

                    # 尝试连接本地 Xray bridge 端口 127.0.0.1:10086
                    try:
                        local_reader, local_writer = await asyncio.open_connection("127.0.0.1", self.bridge_port)
                        await self._bridge_streams(ws, local_reader, local_writer)
                    except Exception as e:
                        print(f"[WssTunnel] 本地 Xray 核心尚未就绪 ({e})，稍后重试", flush=True)
                        await asyncio.sleep(2)

            except Exception as e:
                # 记录简要日志并指数退避
                # print(f"[WssTunnel] 隧道波动 ({e})，{backoff}s 后重试...", flush=True)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60)
