#!/usr/bin/env python3
"""
Wimotek Universal Edge Agent
A lightweight, clean reverse tunnel & service bridge client.

State File Logic:
- User specified path (param / UUID_FILE env) > Default (/data/node_machine.id)
- If permission denied, logs clear error instructions for the user to resolve.
"""

import os
import sys
import time
import json
import uuid
import socket
import asyncio
import argparse
import urllib.parse
from pathlib import Path
from typing import Dict, Optional, Callable
import httpx


def resolve_state_file(filename: str = "node_machine.id", custom_path: Optional[str] = None) -> Path:
    """
    极简文件路径解析：
    1. 显式入参 / 环境变量 UUID_FILE
    2. 默认 /data/<filename>
    """
    if custom_path:
        return Path(custom_path).expanduser().resolve()
    
    env_override = os.getenv("UUID_FILE") or os.getenv("STATE_FILE")
    if env_override:
        return Path(env_override).expanduser().resolve()
    
    return Path("/data") / filename


class EdgeAgent:
    def __init__(
        self,
        hub_url: Optional[str] = None,
        join_token: Optional[str] = None,
        node_name: Optional[str] = None,
        node_group: Optional[str] = None,
        target_port: Optional[int] = None,
        target_host: Optional[str] = None,
        services: Optional[Dict[str, int]] = None,
        reverse_tunnel: Optional[bool] = None,
        uuid_file: Optional[str] = None,
    ):
        self.hub_url = (hub_url or os.getenv("HUB_URL", "")).rstrip("/")
        self.join_token = (join_token or os.getenv("JOIN_TOKEN", "")).strip()
        self.node_group = (node_group or os.getenv("NODE_GROUP", "默认分组")).strip()
        self.target_host = (target_host or os.getenv("TARGET_HOST") or os.getenv("LOCAL_HOST") or "127.0.0.1").strip()

        # 端口默认 9222
        raw_port = target_port if target_port is not None else (os.getenv("TARGET_PORT") or os.getenv("CDP_PORT") or "9222")
        try:
            self.target_port = int(raw_port)
        except ValueError:
            self.target_port = 9222

        self.services: Dict[str, int] = services or self._parse_services()
        self.services["default"] = self.target_port

        # 默认 false (直连上报)，显式为 true 时走反向隧道
        if reverse_tunnel is not None:
            self.reverse_tunnel = bool(reverse_tunnel)
        else:
            self.reverse_tunnel = os.getenv("REVERSE_TUNNEL", "false").lower() in ["true", "1", "yes"]

        # 节点名默认按出口 IP 或主机名拼接
        env_name = (node_name or os.getenv("NODE_NAME", "")).strip()
        self.node_name = env_name if env_name else self._auto_detect_name()

        # 极简指纹路径定位：显式指定 > /data/node_machine.id
        self.uuid_path = resolve_state_file("node_machine.id", custom_path=uuid_file)
        self.node_uuid = self._load_or_create_uuid()

        # 通信协议端点解析
        self.http_base = ""
        self.ws_base = ""
        if self.hub_url:
            parsed = urllib.parse.urlparse(self.hub_url)
            self.http_base = f"{parsed.scheme}://{parsed.netloc}"
            ws_scheme = "wss" if parsed.scheme == "https" else "ws"
            self.ws_base = f"{ws_scheme}://{parsed.netloc}"

        self._action_handlers: Dict[str, Callable] = {}

    def register_action(self, action_name: str, handler: Callable):
        """注册自定义业务动作"""
        self._action_handlers[action_name] = handler

    def _parse_services(self) -> Dict[str, int]:
        services = {}
        raw = os.getenv("SERVICES", "").strip()
        if raw:
            for item in raw.split(","):
                if ":" in item:
                    name, p = item.split(":", 1)
                    try:
                        services[name.strip()] = int(p.strip())
                    except ValueError:
                        pass
        return services

    def _auto_detect_name(self) -> str:
        try:
            with httpx.Client(timeout=1.5) as client:
                res = client.get("https://api.ipify.org")
                if res.status_code == 200 and res.text.strip():
                    return f"Node-{res.text.strip()}"
        except Exception:
            pass

        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            s.close()
            if ip and ip != "127.0.0.1":
                return f"Node-{ip}"
        except Exception:
            pass

        return f"Node-{socket.gethostname()[:12]}"

    def _load_or_create_uuid(self) -> str:
        """读取或创建指纹，遇无权限/目录不存在直接清晰报错输出指导"""
        # 1. 尝试读取已有文件
        if self.uuid_path.is_file():
            try:
                content = self.uuid_path.read_text().strip()
                if content:
                    return content
            except Exception as e:
                print(f"⚠️ [指纹读取失败] 无法读取已有指纹文件 ({self.uuid_path}): {e}")

        # 2. 首次写入持久化
        new_id = str(uuid.uuid4())
        try:
            self.uuid_path.parent.mkdir(parents=True, exist_ok=True)
            self.uuid_path.write_text(new_id)
            return new_id
        except PermissionError:
            print(f"❌ [权限错误] 无权限写入指纹文件: {self.uuid_path}")
            print(f"👉 解决方案：请检查容器挂载目录写权限，或指定环境变量 UUID_FILE 改为可写路径，例如: -e UUID_FILE=/my_path/{self.uuid_path.name}")
        except Exception as e:
            print(f"❌ [目录错误] 无法保存指纹文件 ({self.uuid_path}): {e}")
            print(f"👉 解决方案：请确认目录是否存在并具备写权限，或通过环境变量 UUID_FILE 指定有效路径。")

        # 仅在严重报错时使用内存 UUID，避免脚本崩溃打断主业务
        return new_id

    def run_direct_report(self):
        """直连上报模式：轻量 HTTP 登记 + 心跳"""
        print(f"📡 [Direct-Mode] 正在向主控中心登记: {self.http_base} ...")
        headers = {"Content-Type": "application/json"}
        if self.join_token:
            headers["X-Join-Token"] = self.join_token

        payload = {
            "node_uuid": self.node_uuid,
            "name": self.node_name,
            "group_name": self.node_group,
            "cdp_port": self.target_port,
            "services": self.services,
        }

        while True:
            try:
                with httpx.Client(timeout=10.0, verify=False) as client:
                    res = client.post(f"{self.http_base}/api/nodes/auto-register", json=payload, headers=headers)
                    print(f"✅ [{time.strftime('%X')}] 节点上报/心跳成功: {res.text}")
            except Exception as e:
                print(f"⚠️ [{time.strftime('%X')}] 上报失败，60秒后重试: {e}")
            time.sleep(60)

    async def run_reverse_tunnel(self):
        """反向长连接隧道模式：全双工出站连接穿透 NAT4"""
        import websockets

        params = urllib.parse.urlencode({
            "uuid": self.node_uuid,
            "name": self.node_name,
            "group": self.node_group,
            "token": self.join_token,
            "port": self.target_port,
        })
        ws_endpoint = f"{self.ws_base}/api/nodes/reverse-tunnel?{params}"
        is_ssl = self.ws_base.startswith("wss://")

        while True:
            try:
                print(f"📡 [Tunnel-Mode] 正在建立反向长连接 -> {self.hub_url} ...")
                async with websockets.connect(ws_endpoint, timeout=10.0, ssl=False if not is_ssl else None) as ws:
                    print(f"✅ [Tunnel-Connected] 隧道就绪！指纹存储于: {self.uuid_path}")

                    while True:
                        msg_text = await ws.recv()
                        req = json.loads(msg_text)
                        req_id = req.get("req_id")
                        action = req.get("action", "http_proxy")
                        payload = req.get("payload", {})

                        # 1. 自定义扩展指令
                        if action in self._action_handlers:
                            try:
                                handler = self._action_handlers[action]
                                if asyncio.iscoroutinefunction(handler):
                                    resp_data = await handler(payload)
                                else:
                                    resp_data = handler(payload)
                                await ws.send(json.dumps({"req_id": req_id, "data": resp_data}))
                            except Exception as ex:
                                await ws.send(json.dumps({"req_id": req_id, "error": str(ex)}))

                        # 2. 通用透明 HTTP 反向中继
                        elif action in ["http_proxy", "service_proxy"]:
                            port = payload.get("port") or self.services.get(payload.get("service", "default"), self.target_port)
                            path = payload.get("path", "/")
                            method = payload.get("method", "GET")
                            body = payload.get("body")
                            headers = payload.get("headers", {})

                            try:
                                async with httpx.AsyncClient(timeout=15.0) as client:
                                    resp = await client.request(
                                        method=method,
                                        url=f"http://{self.target_host}:{port}{path}",
                                        headers=headers,
                                        content=body,
                                    )
                                await ws.send(json.dumps({
                                    "req_id": req_id,
                                    "status_code": resp.status_code,
                                    "headers": dict(resp.headers),
                                    "body": resp.text,
                                }))
                            except Exception as ex:
                                await ws.send(json.dumps({
                                    "req_id": req_id,
                                    "status_code": 502,
                                    "error": str(ex),
                                }))

                        # 3. 通用透明 WebSocket 管道转发
                        elif action == "ws_proxy":
                            port = payload.get("port") or self.services.get("default", self.target_port)
                            ws_path = payload.get("path", "")
                            local_ws_url = f"ws://{self.target_host}:{port}{ws_path}"
                            send_data = payload.get("data")

                            try:
                                async with websockets.connect(local_ws_url, timeout=5.0) as local_ws:
                                    if send_data:
                                        await local_ws.send(send_data)
                                    reply = await local_ws.recv()
                                await ws.send(json.dumps({
                                    "req_id": req_id,
                                    "success": True,
                                    "data": reply,
                                }))
                            except Exception as ex:
                                await ws.send(json.dumps({
                                    "req_id": req_id,
                                    "success": False,
                                    "error": str(ex),
                                }))

                        # 4. 心跳响应
                        elif action == "ping":
                            await ws.send(json.dumps({"req_id": req_id, "action": "pong", "time": time.time()}))

            except (websockets.ConnectionClosed, Exception) as e:
                print(f"⚠️ 反向连接断开，5秒后自动重连: {e}")
                await asyncio.sleep(5)

    def run(self):
        """运行入口"""
        if not self.hub_url:
            print("ℹ️ 未配置 HUB_URL，Agent 停止运行。")
            return

        print(f"🚀 [Edge-Agent] 启动节点: {self.node_name} | 模式: {'反向穿透(NAT4)' if self.reverse_tunnel else '直连上报'} | 主端口: {self.target_port} | 指纹位置: {self.uuid_path}")
        if self.reverse_tunnel:
            asyncio.run(self.run_reverse_tunnel())
        else:
            self.run_direct_report()


def main():
    parser = argparse.ArgumentParser(description="Wimotek Universal Edge Agent")
    parser.add_argument("--hub-url", type=str, help="中心管理端 URL (如 https://hub.domain.com:8443)")
    parser.add_argument("--join-token", type=str, help="入网认证 Token (可选)")
    parser.add_argument("--node-name", type=str, help="节点名称 (默认自动嗅探 IP)")
    parser.add_argument("--group", type=str, help="所属集群分组")
    parser.add_argument("--port", type=int, help="要代理的主端口 (默认: 9222)")
    parser.add_argument("--host", type=str, help="本地服务绑定地址 (默认: 127.0.0.1)")
    parser.add_argument("--services", type=str, help="多端口代理定义, 如: cdp:9222,vnc:6080")
    parser.add_argument("--state-file", type=str, help="指纹文件存储路径 (默认: /data/node_machine.id)")
    parser.add_argument("--reverse", action="store_true", help="强制开启出站反向长连接隧道")
    parser.add_argument("--direct", action="store_true", help="强制开启直连上报心跳模式")
    args = parser.parse_args()

    rev_mode = None
    if args.reverse:
        rev_mode = True
    elif args.direct:
        rev_mode = False

    agent = EdgeAgent(
        hub_url=args.hub_url,
        join_token=args.join_token,
        node_name=args.node_name,
        node_group=args.group,
        target_port=args.port,
        target_host=args.host,
        reverse_tunnel=rev_mode,
        uuid_file=args.state_file,
    )
    agent.run()


if __name__ == "__main__":
    main()