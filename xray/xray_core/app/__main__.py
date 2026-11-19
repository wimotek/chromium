# -*- coding: utf-8 -*-
"""
Main Application Entrypoint
纯 Python 启动引擎：
1. 采集本机公网 IPv4 / IPv6
2. 密钥管理与 Xray 初次配置构建 (默认先以 direct 监听，等待 Hub 拨测裁决)
3. 启动 Xray 核心
4. 调度异步主循环：接收 Hub wimotek-edge-agent 裁决结果，动态切入 direct 或 reverse_wss 反穿
"""
import sys
import os
import asyncio
import signal
from typing import Optional

from .config import AppConfig
from .net_detector import detect_network_profile
from .config_builder import build_xray_config
from .xray_manager import XrayManager
from .tunnel import WssTunnelSupervisor
from .hub_client import HubClient
from .health import evaluate_health, start_health_server


class EdgeCoreApplication:
    def __init__(self):
        self.xray_mgr = XrayManager()
        self.net_mode, self.ext_ipv4, self.ext_ipv6 = detect_network_profile(AppConfig.NET_MODE)
        self.ext_ip = self.ext_ipv4 or (f"[{self.ext_ipv6}]" if self.ext_ipv6 else "127.0.0.1")
        self.hub_client = HubClient(self.xray_mgr.node_id)
        self.tunnel_supervisor: Optional[WssTunnelSupervisor] = None
        self.tunnel_task: Optional[asyncio.Task] = None
        self.current_clients = []
        self.health_server = None
        self.is_running = True
        self._hub_state = ""

        print("==================================================================", flush=True)
        print("          Wimotek Edge Core (Pure Python Edition)                 ", flush=True)
        print("==================================================================", flush=True)
        print(f"[*] Node ID      : {self.xray_mgr.node_id}", flush=True)
        print(f"[*] External IPv4: {self.ext_ipv4 or '无 (None)'}", flush=True)
        print(f"[*] External IPv6: {self.ext_ipv6 or '无 (None)'}", flush=True)
        print(f"[*] Primary IP   : {self.ext_ip}", flush=True)
        print(f"[*] Initial Mode : {self.net_mode.upper()} (配置策略: {AppConfig.NET_MODE.upper()})", flush=True)
        print(f"[*] Panel Hub URL: {AppConfig.PANEL_URL or '纯单机模式 (Standalone)'}", flush=True)
        if AppConfig.PANEL_URL:
            if self.hub_client.node_key:
                auth_desc = "已持久化节点密钥 (node_key)"
            elif AppConfig.BOOTSTRAP_TOKEN:
                auth_desc = "集群引导令牌 (CLUSTER_TOKEN)"
            else:
                auth_desc = "无引导令牌 (TOFU 模式：若后台关闭免审则进入待审批隔离区)"
            print(f"[*] Auth Mode    : {auth_desc}", flush=True)
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
        is_standalone = not bool(AppConfig.PANEL_URL)
        client_uuid = os.environ.get("UUID", "11111111-2222-3333-4444-555555555555")
        if is_standalone:
            self.current_clients = [{
                "id": client_uuid,
                "flow": "xtls-rprx-vision",
                "email": "admin@local.host"
            }]
        else:
            # 集群模式未获主控准入同步前不注入任何默认兜底 UUID，仅监听端口等待 Hub 拨测与授权同步
            self.current_clients = []

        initial_cfg = build_xray_config(
            net_mode=self.net_mode,
            clients=self.current_clients,
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

    def _ensure_tunnel_worker(self):
        """按需启动 WSS 反向隧道后台协程"""
        if self.net_mode == "reverse_wss" and not self.tunnel_supervisor and self.hub_client.node_key:
            self.tunnel_supervisor = WssTunnelSupervisor(
                node_id=self.xray_mgr.node_id,
                node_key=self.hub_client.node_key,
                bridge_port=AppConfig.LOCAL_BRIDGE_PORT
            )
            self.tunnel_task = asyncio.create_task(self.tunnel_supervisor.run_tunnel_worker())

    def _stop_tunnel_worker(self):
        """若从 reverse_wss 切回 direct，安全停止反穿隧道"""
        if self.tunnel_supervisor:
            self.tunnel_supervisor.is_running = False
            self.tunnel_supervisor = None
        if self.tunnel_task and not self.tunnel_task.done():
            self.tunnel_task.cancel()
        self.tunnel_task = None

    async def sync_loop(self):
        """定期心跳、接收 Hub 拨测裁决与策略同步、回传流量"""
        while self.is_running:
            sleep_sec = 60
            try:
                # 1. 采集本地 Xray 进程与监听端口真实健康度，连同双栈 IP 上报 Hub
                _, local_health = evaluate_health(self)
                ok, hb_data = self.hub_client.send_heartbeat(
                    net_mode=self.net_mode,
                    ip=self.ext_ip,
                    port=AppConfig.PORT,
                    pbk=self.xray_mgr.public_key,
                    sid=self.xray_mgr.short_id,
                    ipv4=self.ext_ipv4,
                    ipv6=self.ext_ipv6,
                    preferred_mode=AppConfig.NET_MODE,
                    health=local_health,
                )

                if not ok or not isinstance(hb_data, dict):
                    err_detail = self.hub_client.last_error or "网络超时或主控不可达"
                    print(
                        f"[HubSync] ⚠️ 无法连接主控 Hub ({AppConfig.PANEL_URL}): {err_detail}，将在 30 秒后重试...",
                        flush=True,
                    )
                    self._hub_state = "unreachable"
                    await asyncio.sleep(30)
                    continue

                if hb_data.get("network_detection"):
                    det = hb_data["network_detection"]
                    print(
                        f"[HubProbe] 🌐 Hub 拨测完成: {det.get('network_mode')} "
                        f"(IPv4通={det.get('ipv4_reachable')}, IPv6通={det.get('ipv6_reachable')}, "
                        f"推荐端点={det.get('recommended_endpoint') or '反向隧道'})",
                        flush=True
                    )

                hb_code = int(hb_data.get("code") or 200)
                hb_msg = str(hb_data.get("msg") or "").strip()

                if self.hub_client.is_pending_approval_response(hb_data):
                    if not hb_data.get("tofu_assigned_key"):
                        print(
                            f"[HubSync] ⏳ 节点等待管理员审批上线（{hb_msg or '已进入待审隔离区'}），"
                            "请前往主控面板「节点管理 → 待审批节点隔离区」审批通过（30 秒后复查）...",
                            flush=True,
                        )
                    self._hub_state = "pending"
                    self._stop_tunnel_worker()
                    if self.current_clients:
                        self.current_clients = []
                        empty_cfg = build_xray_config(
                            net_mode=self.net_mode,
                            clients=[],
                            private_key=self.xray_mgr.private_key,
                            short_id=self.xray_mgr.short_id,
                            port=AppConfig.PORT,
                            dest=AppConfig.DEST,
                            server_names=AppConfig.get_server_name_list(),
                            is_standalone=False,
                        )
                        self.xray_mgr.apply_config(empty_cfg)
                    await asyncio.sleep(30)
                    continue

                if hb_code != 200:
                    print(
                        f"[HubSync] ❌ 主控拒绝接入 (HTTP {hb_code}): {hb_msg or '认证未通过'}，将在 60 秒后重试...",
                        flush=True,
                    )
                    self._hub_state = "rejected"
                    self._stop_tunnel_worker()
                    if self.current_clients:
                        self.current_clients = []
                        empty_cfg = build_xray_config(
                            net_mode=self.net_mode,
                            clients=[],
                            private_key=self.xray_mgr.private_key,
                            short_id=self.xray_mgr.short_id,
                            port=AppConfig.PORT,
                            dest=AppConfig.DEST,
                            server_names=AppConfig.get_server_name_list(),
                            is_standalone=False,
                        )
                        self.xray_mgr.apply_config(empty_cfg)
                    await asyncio.sleep(60)
                    continue

                if self._hub_state in ("pending", "rejected"):
                    print("[HubSync] ✅ 管理员审批已通过！节点正式接入集群并开始同步授权用户。", flush=True)
                self._hub_state = "approved"

                # 2. 拉取最新授权用户与主控权威策略
                sync_data = self.hub_client.fetch_users_and_policy()
                node_cfg = (sync_data.get("node_config") if sync_data else None) or (hb_data.get("node_config") if hb_data else None)

                # 读取 Hub 裁决的网络模式 (优先 node_config，其次首次 TOFU 响应的 net_mode)
                hub_net_mode = (
                    (node_cfg.get("net_mode") if node_cfg else None)
                    or (hb_data.get("net_mode") if hb_data else None)
                )

                mode_changed = False
                if hub_net_mode in ("direct", "reverse_wss") and hub_net_mode != self.net_mode:
                    print(f"[HubSync] 🔀 应用 Hub 裁决网络模式: {self.net_mode} -> {hub_net_mode}", flush=True)
                    self.net_mode = hub_net_mode
                    mode_changed = True

                if self.net_mode == "reverse_wss":
                    self._ensure_tunnel_worker()
                else:
                    self._stop_tunnel_worker()

                if node_cfg:
                    remote_port = int(node_cfg.get("port", AppConfig.PORT))
                    remote_dest = node_cfg.get("dest", AppConfig.DEST)
                    remote_snis = node_cfg.get("server_names", AppConfig.get_server_name_list())
                    remote_sid = node_cfg.get("sid", self.xray_mgr.short_id)

                    AppConfig.PORT = remote_port
                    AppConfig.DEST = remote_dest
                    if isinstance(remote_snis, list) and remote_snis:
                        AppConfig.SERVER_NAMES = ",".join(remote_snis)

                    if sync_data is not None:
                        self.current_clients = sync_data.get("users", [])
                    new_cfg = build_xray_config(
                        net_mode=self.net_mode,
                        clients=self.current_clients,
                        private_key=self.xray_mgr.private_key,
                        short_id=remote_sid,
                        port=remote_port,
                        dest=remote_dest,
                        server_names=remote_snis,
                        is_standalone=False
                    )

                    applied = self.xray_mgr.apply_config(new_cfg)
                    if applied or mode_changed:
                        print(f"[HubSync] ✅ 同步最新网络策略 (模式:{self.net_mode}, 端口:{remote_port}, dest:{remote_dest}, 用户数:{len(self.current_clients)})", flush=True)
                elif mode_changed:
                    new_cfg = build_xray_config(
                        net_mode=self.net_mode,
                        clients=self.current_clients,
                        private_key=self.xray_mgr.private_key,
                        short_id=self.xray_mgr.short_id,
                        port=AppConfig.PORT,
                        dest=AppConfig.DEST,
                        server_names=AppConfig.get_server_name_list(),
                        is_standalone=False
                    )
                    if self.xray_mgr.apply_config(new_cfg):
                        print(f"[HubSync] ✅ 切换运行模式生效 (模式:{self.net_mode})", flush=True)

                # 3. 统计增量流量回传结算
                self.hub_client.query_and_report_traffic()

            except Exception as e:
                print(f"[HubSync] ⚠️ 同步循环异常: {e}", flush=True)

            await asyncio.sleep(sleep_sec)

    async def watchdog_loop(self):
        """秒级看门狗轮询"""
        while self.is_running:
            self.xray_mgr.poll_watchdog()
            await asyncio.sleep(2)

    async def run(self):
        self.bootstrap_initial_config()
        self.xray_mgr.start()
        self.health_server = start_health_server(self)

        tasks = [asyncio.create_task(self.watchdog_loop())]

        if AppConfig.PANEL_URL:
            tasks.append(asyncio.create_task(self.sync_loop()))
            if self.net_mode == "reverse_wss":
                self._ensure_tunnel_worker()

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
        self._stop_tunnel_worker()
        if self.health_server:
            try:
                self.health_server.shutdown()
                self.health_server.server_close()
            except Exception:
                pass
            self.health_server = None
        if self.xray_mgr:
            self.xray_mgr.stop()
        print("[EdgeCore] ✅ Xray 核心已安全停止，进程退出完毕。", flush=True)
        sys.exit(0)


def main():
    app = EdgeCoreApplication()
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
