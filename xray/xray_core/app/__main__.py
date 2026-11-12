# -*- coding: utf-8 -*-
"""
Main Application Entrypoint
纯 Python 启动引擎：
1. 智能网络探测 (direct vs reverse_wss)
2. 密钥管理与 Xray 初次配置构建
3. 启动 Xray 核心
4. 调度异步主循环：看门狗自愈、WSS 反向隧道探活守护、Hub 周期心跳与用户同步
"""
import sys
import os
import time
import asyncio
import signal
from typing import List, Dict, Any

from .config import AppConfig
from .net_detector import detect_network_profile
from .config_builder import build_xray_config
from .xray_manager import XrayManager
from .tunnel import WssTunnelSupervisor
from .hub_client import HubClient

class EdgeCoreApplication:
    def __init__(self):
        self.xray_mgr = XrayManager()
        self.net_mode, self.ext_ipv4, self.ext_ipv6 = detect_network_profile(AppConfig.NET_MODE)
        self.ext_ip = self.ext_ipv4 or (f"[{self.ext_ipv6}]" if self.ext_ipv6 else "127.0.0.1")
        self.hub_client = HubClient(self.xray_mgr.node_id)
        self.tunnel_supervisor = None
        self.is_running = True

        print("==================================================================", flush=True)
        print("          Wimotek Edge Core (Pure Python Edition)                 ", flush=True)
        print("==================================================================", flush=True)
        print(f"[*] Node ID      : {self.xray_mgr.node_id}", flush=True)
        print(f"[*] External IPv4: {self.ext_ipv4 or '无 (None)'}", flush=True)
        print(f"[*] External IPv6: {self.ext_ipv6 or '无 (None)'}", flush=True)
        print(f"[*] Primary IP   : {self.ext_ip}", flush=True)
        print(f"[*] Network Mode : {self.net_mode.upper()} ({'🌐 公网直连 REALITY' if self.net_mode == 'direct' else '🔀 NAT4 WSS 反向打洞'})", flush=True)
        print(f"[*] Panel Hub URL: {AppConfig.PANEL_URL or '纯单机模式 (Standalone)'}", flush=True)
        print("==================================================================", flush=True)

    def write_standalone_client_info(self, client_uuid: str):
        """生成单机模式下的连接导入信息"""
        first_sni = AppConfig.get_first_server_name()
        vless_link = (
            f"vless://{client_uuid}@{self.ext_ip}:{AppConfig.PORT}?"
            f"security=reality&encryption=none&pbk={self.xray_mgr.public_key}&"
            f"headerType=none&fp=chrome&type=tcp&flow=xtls-rprx-vision&"
            f"sni={first_sni}&sid={self.xray_mgr.short_id}#Xray-Reality-Standalone"
        )
        info_content = f"""======================================================
           Xray Reality 单机节点配置信息
======================================================
IP / 地址: {self.ext_ip}
端口: {AppConfig.PORT}
UUID: {client_uuid}
流控 (flow): xtls-rprx-vision
安全类型: reality
SNI / 伪装域名: {first_sni}
公钥 (PublicKey): {self.xray_mgr.public_key}
ShortId: {self.xray_mgr.short_id}

客户端导入链接:
{vless_link}
======================================================
"""
        with open(AppConfig.CLIENT_INFO_FILE, "w") as f:
            f.write(info_content)
        print(info_content, flush=True)

    def bootstrap_initial_config(self):
        """生成初版 config.json 并预检"""
        client_uuid = os.environ.get("UUID", "11111111-2222-3333-4444-555555555555")
        default_clients = [{
            "id": client_uuid,
            "flow": "xtls-rprx-vision",
            "email": "admin@local.host"
        }]

        is_standalone = not bool(AppConfig.PANEL_URL)
        initial_cfg = build_xray_config(
            net_mode=self.net_mode,
            clients=default_clients,
            private_key=self.xray_mgr.private_key,
            short_id=self.xray_mgr.short_id,
            port=AppConfig.PORT,
            dest=AppConfig.DEST,
            server_names=AppConfig.get_server_name_list(),
            is_standalone=is_standalone
        )

        self.xray_mgr.apply_config(initial_cfg)
        if is_standalone:
            self.write_standalone_client_info(client_uuid)

    async def sync_loop(self):
        """定期心跳、拉取最新用户与策略、回传流量"""
        while self.is_running:
            try:
                # 1. 发送心跳到 Hub
                ok, hb_data = self.hub_client.send_heartbeat(
                    net_mode=self.net_mode,
                    ip=self.ext_ip,
                    port=AppConfig.PORT,
                    pbk=self.xray_mgr.public_key,
                    sid=self.xray_mgr.short_id
                )

                # 2. 如果 Hub 下发了新的节点配置或用户同步指令
                sync_data = self.hub_client.fetch_users_and_policy()
                node_cfg = (sync_data.get("node_config") if sync_data else None) or (hb_data.get("node_config") if hb_data else None)

                if node_cfg:
                    remote_port = int(node_cfg.get("port", AppConfig.PORT))
                    remote_dest = node_cfg.get("dest", AppConfig.DEST)
                    remote_snis = node_cfg.get("server_names", AppConfig.get_server_name_list())
                    remote_sid = node_cfg.get("sid", self.xray_mgr.short_id)

                    # 动态更新节点内存全局配置，确保后续心跳上报匹配主控设定的权威参数
                    AppConfig.PORT = remote_port
                    AppConfig.DEST = remote_dest
                    if isinstance(remote_snis, list) and remote_snis:
                        AppConfig.SERVER_NAMES = ",".join(remote_snis)

                    remote_users = sync_data.get("users", []) if sync_data else []
                    new_cfg = build_xray_config(
                        net_mode=self.net_mode,
                        clients=remote_users,
                        private_key=self.xray_mgr.private_key,
                        short_id=remote_sid,
                        port=remote_port,
                        dest=remote_dest,
                        server_names=remote_snis,
                        is_standalone=False
                    )

                    applied = self.xray_mgr.apply_config(new_cfg)
                    if applied:
                        print(f"[HubSync] ✅ 成功同步并生效最新网络策略 (端口:{remote_port}, dest:{remote_dest}, 用户数:{len(remote_users)})", flush=True)

                # 3. 统计增量流量回传结算
                self.hub_client.query_and_report_traffic()

            except Exception as e:
                # 避免任何单次网络波动阻断主线程
                pass

            await asyncio.sleep(60)

    async def watchdog_loop(self):
        """秒级看门狗轮询"""
        while self.is_running:
            self.xray_mgr.poll_watchdog()
            await asyncio.sleep(2)

    async def run(self):
        # 1. 初始化初版配置与启动 Xray
        self.bootstrap_initial_config()
        self.xray_mgr.start()

        tasks = [asyncio.create_task(self.watchdog_loop())]

        # 2. 如果是集群模式，启动与 Hub 的协同循环
        if AppConfig.PANEL_URL:
            tasks.append(asyncio.create_task(self.sync_loop()))

            # 3. 如果是反穿模式，启动 WSS 异步隧道
            if self.net_mode == "reverse_wss":
                self.tunnel_supervisor = WssTunnelSupervisor(
                    node_id=self.xray_mgr.node_id,
                    node_key=self.hub_client.node_key,
                    bridge_port=AppConfig.LOCAL_BRIDGE_PORT
                )
                tasks.append(asyncio.create_task(self.tunnel_supervisor.run_tunnel_worker()))

        # 监听优雅停机信号 (确保 dumb-init 转发的 SIGTERM / SIGINT 立即响应)
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(sig, self.shutdown)
            except NotImplementedError:
                signal.signal(sig, lambda s, f: self.shutdown())

        await asyncio.gather(*tasks, return_exceptions=True)

    def shutdown(self):
        if not self.is_running:
            return
        print("\n[EdgeCore] 接收到退出信号，正在执行全链路优雅停机...", flush=True)
        self.is_running = False
        if self.tunnel_supervisor:
            self.tunnel_supervisor.is_running = False
        if self.xray_mgr:
            self.xray_mgr.stop()
        print("[EdgeCore] ✅ Xray 核心已安全停止，进程退出完毕。", flush=True)
        sys.exit(0)

def main():
    app = EdgeCoreApplication()
    # 注册同步信号兜底，确保在事件循环就绪前后均能捕获 SIGTERM
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, lambda s, f: app.shutdown())
        except Exception:
            pass
    try:
        asyncio.run(app.run())
    except (KeyboardInterrupt, SystemExit):
        app.shutdown()

if __name__ == "__main__":
    main()
