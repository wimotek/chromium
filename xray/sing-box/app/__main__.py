# -*- coding: utf-8 -*-
"""
Main Application Entrypoint for Sing-box Edge Core
纯 Python 启动引擎（与 xray_core 架构 100% 对齐）：
1. 采集本机公网 IPv4 / IPv6
2. REALITY X25519 密钥 + Hysteria2 TLS 证书管理与 sing-box 配置构建
3. 启动 sing-box 核心并暴露纯回环 /healthz
4. 调度异步主循环：接收 Hub 拨测裁决与权威策略，动态切换 direct / reverse_wss，精准上报双协议增量流量
"""
import asyncio
import os
import signal
import sys
import urllib.parse
from typing import Optional

from .config import AppConfig
from .config_builder import build_singbox_config
from .health import evaluate_health, start_health_server
from .hub_client import HubClient
from .net_detector import detect_network_profile
from .singbox_manager import SingboxManager
from .tunnel import WssTunnelSupervisor


class SingboxEdgeApplication:
    def __init__(self):
        self.sb_mgr = SingboxManager()
        self.net_mode, self.ext_ipv4, self.ext_ipv6 = detect_network_profile(AppConfig.NET_MODE)
        self.ext_ip = self.ext_ipv4 or (f"[{self.ext_ipv6}]" if self.ext_ipv6 else "127.0.0.1")
        self.hub_client = HubClient(self.sb_mgr.node_id)
        self.tunnel_supervisor: Optional[WssTunnelSupervisor] = None
        self.tunnel_task: Optional[asyncio.Task] = None
        self.current_clients = []
        self.health_server = None
        self.is_running = True

        hy2_desc = (
            f"开启 (UDP:{AppConfig.HY2_PORT}, SNI:{AppConfig.HY2_SNI}, insecure={AppConfig.HY2_INSECURE})"
            if AppConfig.HY2_ENABLED
            else "关闭"
        )
        print("==================================================================", flush=True)
        print("      Wimotek Sing-box Edge Core (VLESS-REALITY + Hysteria2)      ", flush=True)
        print("==================================================================", flush=True)
        print(f"[*] Node ID      : {self.sb_mgr.node_id}", flush=True)
        print(f"[*] External IPv4: {self.ext_ipv4 or '无 (None)'}", flush=True)
        print(f"[*] External IPv6: {self.ext_ipv6 or '无 (None)'}", flush=True)
        print(f"[*] Primary IP   : {self.ext_ip}", flush=True)
        print(f"[*] Initial Mode : {self.net_mode.upper()} (配置策略: {AppConfig.NET_MODE.upper()})", flush=True)
        print(f"[*] Hysteria2 UDP: {hy2_desc}", flush=True)
        print(f"[*] Panel Hub URL: {AppConfig.PANEL_URL or '纯单机模式 (Standalone)'}", flush=True)
        print("==================================================================", flush=True)

    def _build_current_config(self, is_standalone: bool, short_id: Optional[str] = None):
        self.sb_mgr.hy2_cert_path, self.sb_mgr.hy2_key_path = self.sb_mgr.ensure_hy2_certificates(AppConfig.HY2_SNI)
        return build_singbox_config(
            net_mode=self.net_mode,
            clients=self.current_clients,
            private_key=self.sb_mgr.private_key,
            short_id=short_id or self.sb_mgr.short_id,
            port=AppConfig.PORT,
            dest=AppConfig.DEST,
            server_names=AppConfig.get_server_name_list(),
            is_standalone=is_standalone,
            hy2_enabled=AppConfig.HY2_ENABLED,
            hy2_port=AppConfig.HY2_PORT,
            hy2_cert_path=self.sb_mgr.hy2_cert_path,
            hy2_key_path=self.sb_mgr.hy2_key_path,
            hy2_masquerade=AppConfig.HY2_MASQUERADE,
            hy2_up_mbps=AppConfig.HY2_UP_MBPS,
            hy2_down_mbps=AppConfig.HY2_DOWN_MBPS,
        )

    def write_standalone_client_info(self, client_uuid: str):
        """生成单机模式下的双协议连接导入信息 (VLESS-REALITY + Hysteria2)"""
        first_sni = AppConfig.get_first_server_name()
        vless_link = (
            f"vless://{client_uuid}@{self.ext_ip}:{AppConfig.PORT}?"
            f"security=reality&encryption=none&pbk={self.sb_mgr.public_key}&"
            f"headerType=none&fp=chrome&type=tcp&flow=xtls-rprx-vision&"
            f"sni={first_sni}&sid={self.sb_mgr.short_id}#SingBox-Reality-Standalone"
        )

        hy2_section = ""
        if AppConfig.HY2_ENABLED and self.net_mode == "direct" and AppConfig.HY2_PORT > 0:
            insecure_val = 1 if AppConfig.HY2_INSECURE else 0
            hy2_sni_q = urllib.parse.quote(AppConfig.HY2_SNI, safe="")
            hy2_link = (
                f"hysteria2://{client_uuid}@{self.ext_ip}:{AppConfig.HY2_PORT}?"
                f"sni={hy2_sni_q}&insecure={insecure_val}#SingBox-Hysteria2-Standalone"
            )
            hy2_section = f"""
--- Hysteria2 (原生 UDP/QUIC) ---
UDP 端口: {AppConfig.HY2_PORT}
认证密码: {client_uuid}
TLS SNI: {AppConfig.HY2_SNI}
跳过证书校验 (insecure): {insecure_val}
Hysteria2 导入链接:
{hy2_link}
"""

        info_content = f"""======================================================
     Sing-box 双协议单机节点配置信息 (REALITY + Hy2)
======================================================
IP / 地址: {self.ext_ip}
VLESS TCP 端口: {AppConfig.PORT}
UUID / 凭证: {client_uuid}
流控 (flow): xtls-rprx-vision
安全类型: reality
SNI / 伪装域名: {first_sni}
公钥 (PublicKey): {self.sb_mgr.public_key}
ShortId: {self.sb_mgr.short_id}

VLESS-REALITY 导入链接:
{vless_link}
{hy2_section}======================================================
"""
        with open(AppConfig.CLIENT_INFO_FILE, "w", encoding="utf-8") as f:
            f.write(info_content)
        print(info_content, flush=True)

    def bootstrap_initial_config(self):
        """生成初版 config.json 并通过 sing-box check 预检"""
        client_uuid = os.environ.get("UUID", "11111111-2222-3333-4444-555555555555")
        default_clients = [
            {
                "id": client_uuid,
                "flow": "xtls-rprx-vision",
                "email": "admin@local.host",
            }
        ]
        self.current_clients = default_clients

        is_standalone = not bool(AppConfig.PANEL_URL)
        initial_cfg = self._build_current_config(is_standalone=is_standalone)
        self.sb_mgr.apply_config(initial_cfg)
        if is_standalone:
            self.write_standalone_client_info(client_uuid)

    def _ensure_tunnel_worker(self):
        """按需启动 WSS 反向隧道后台协程"""
        if self.net_mode == "reverse_wss" and not self.tunnel_supervisor and self.hub_client.node_key:
            self.tunnel_supervisor = WssTunnelSupervisor(
                node_id=self.sb_mgr.node_id,
                node_key=self.hub_client.node_key,
                bridge_port=AppConfig.LOCAL_BRIDGE_PORT,
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
        """定期心跳、接收 Hub 拨测裁决与双协议策略同步、回传增量流量"""
        while self.is_running:
            try:
                _, local_health = evaluate_health(self)
                ok, hb_data = self.hub_client.send_heartbeat(
                    net_mode=self.net_mode,
                    ip=self.ext_ip,
                    port=AppConfig.PORT,
                    pbk=self.sb_mgr.public_key,
                    sid=self.sb_mgr.short_id,
                    ipv4=self.ext_ipv4,
                    ipv6=self.ext_ipv6,
                    preferred_mode=AppConfig.NET_MODE,
                    health=local_health,
                )

                if hb_data and hb_data.get("network_detection"):
                    det = hb_data["network_detection"]
                    print(
                        f"[HubProbe] 🌐 Hub 拨测完成: {det.get('network_mode')} "
                        f"(IPv4通={det.get('ipv4_reachable')}, IPv6通={det.get('ipv6_reachable')}, "
                        f"推荐端点={det.get('recommended_endpoint') or '反向隧道'})",
                        flush=True,
                    )

                sync_data = self.hub_client.fetch_users_and_policy()
                node_cfg = (sync_data.get("node_config") if sync_data else None) or (
                    hb_data.get("node_config") if hb_data else None
                )

                hub_net_mode = (node_cfg.get("net_mode") if node_cfg else None) or (
                    hb_data.get("net_mode") if hb_data else None
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
                    remote_sid = node_cfg.get("sid", self.sb_mgr.short_id)

                    AppConfig.PORT = remote_port
                    AppConfig.DEST = remote_dest
                    if isinstance(remote_snis, list) and remote_snis:
                        AppConfig.SERVER_NAMES = ",".join(remote_snis)

                    # 同步 Hub 下发的 Hysteria2 配置（若 Hub 已支持并下发）
                    if "hy2_enabled" in node_cfg and node_cfg["hy2_enabled"] is not None:
                        AppConfig.HY2_ENABLED = bool(int(node_cfg["hy2_enabled"]))
                    if node_cfg.get("hy2_port"):
                        AppConfig.HY2_PORT = int(node_cfg["hy2_port"])
                    if node_cfg.get("hy2_sni"):
                        AppConfig.HY2_SNI = str(node_cfg["hy2_sni"]).strip()
                    if "hy2_insecure" in node_cfg and node_cfg["hy2_insecure"] is not None:
                        AppConfig.HY2_INSECURE = bool(int(node_cfg["hy2_insecure"]))

                    if sync_data is not None:
                        self.current_clients = sync_data.get("users", [])

                    new_cfg = self._build_current_config(is_standalone=False, short_id=remote_sid)
                    applied = self.sb_mgr.apply_config(new_cfg)
                    if applied or mode_changed:
                        hy2_info = f"Hy2=UDP:{AppConfig.HY2_PORT}" if (self.net_mode == "direct" and AppConfig.HY2_ENABLED) else "Hy2=关闭"
                        print(
                            f"[HubSync] ✅ 同步最新网络策略 (模式:{self.net_mode}, TCP:{remote_port}, {hy2_info}, 用户数:{len(self.current_clients)})",
                            flush=True,
                        )
                elif mode_changed:
                    new_cfg = self._build_current_config(is_standalone=False)
                    if self.sb_mgr.apply_config(new_cfg):
                        print(f"[HubSync] ✅ 切换运行模式生效 (模式:{self.net_mode})", flush=True)

                # 统计双协议用户增量流量并回传结算
                self.hub_client.query_and_report_traffic()

            except Exception:
                pass

            await asyncio.sleep(60)

    async def watchdog_loop(self):
        """秒级看门狗轮询"""
        while self.is_running:
            self.sb_mgr.poll_watchdog()
            await asyncio.sleep(2)

    async def run(self):
        self.bootstrap_initial_config()
        self.sb_mgr.start()
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
        if self.sb_mgr:
            self.sb_mgr.stop()
        print("[EdgeCore] ✅ Sing-box 核心已安全停止，进程退出完毕。", flush=True)
        sys.exit(0)


def main():
    app = SingboxEdgeApplication()
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
