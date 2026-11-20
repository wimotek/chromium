# -*- coding: utf-8 -*-
"""
Hub Client & Sync Worker for Sing-box Edge Core
负责向 Hub 端上报双栈公网 IP、核心类型 (singbox)、Hysteria2 能力参数与本地健康自检，
执行 TOFU 准入协商、同步最新策略/用户列表、并通过 sb-helper stats 采集上报增量流量
"""
import json
import os
import ssl
import subprocess
import urllib.error
import urllib.request
from typing import Dict, Any, Optional, Tuple

from .config import AppConfig


def _ssl_unverified_context():
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


class HubClient:
    def __init__(self, node_id: str):
        self.node_id = node_id
        self.node_key = self._load_node_key()
        self.is_bootstrapping = not bool(self.node_key)
        self.last_error = ""

    def _load_node_key(self) -> str:
        if os.path.exists(AppConfig.NODE_KEY_FILE):
            with open(AppConfig.NODE_KEY_FILE, "r", encoding="utf-8") as f:
                k = f.read().strip()
                if k:
                    return k
        return ""

    def save_node_key(self, key: str):
        self.node_key = key
        with open(AppConfig.NODE_KEY_FILE, "w", encoding="utf-8") as f:
            f.write(key + "\n")
        self.is_bootstrapping = False

    def post_json(self, url: str, payload: Dict[str, Any], timeout: int = 12) -> Optional[Dict[str, Any]]:
        try:
            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "User-Agent": "wimotek-edge-agent/1.0",
                },
            )
            with urllib.request.urlopen(req, timeout=timeout, context=_ssl_unverified_context()) as resp:
                self.last_error = ""
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            self.last_error = f"HTTP {e.code}"
            try:
                body = e.read().decode("utf-8")
                data = json.loads(body)
                if isinstance(data, dict) and "code" not in data:
                    data["code"] = e.code
                return data
            except Exception:
                return {"code": e.code, "msg": str(e)}
        except Exception as e:
            self.last_error = str(e)
            return None

    @staticmethod
    def is_pending_approval_response(resp: Optional[Dict[str, Any]]) -> bool:
        if not isinstance(resp, dict):
            return False
        if resp.get("pending_approval") is True:
            return True
        if resp.get("is_approved") == 0 or str(resp.get("is_approved", "")).strip() == "0":
            return True
        msg = str(resp.get("msg") or "")
        return any(k in msg for k in ("隔离拦截", "待审隔离", "待审批", "尚未获得管理员批准"))

    def send_heartbeat(
        self,
        net_mode: str,
        ip: str,
        port: int,
        pbk: str,
        sid: str,
        ipv4: str = "",
        ipv6: str = "",
        preferred_mode: str = "auto",
        health: Optional[Dict[str, Any]] = None,
        hy2_cert_sha256: str = "",
    ) -> Tuple[bool, Optional[Dict[str, Any]]]:
        """向 Hub 上报公网双栈地址、Sing-box 内核标识、Hysteria2 UDP 参数及真实健康状态"""
        if not AppConfig.PANEL_URL:
            return False, None

        url = f"{AppConfig.PANEL_URL}/api/node/heartbeat"
        payload: Dict[str, Any] = {
            "node_id": self.node_id,
            "node_uuid": self.node_id,
            "core_type": AppConfig.CORE_TYPE,
            "ip": ip,
            "port": port,
            "public_ipv4": ipv4 or None,
            "public_ipv4_port": port if ipv4 else None,
            "public_ipv6": ipv6 or None,
            "public_ipv6_port": port if ipv6 else None,
            "dest": AppConfig.DEST,
            "sni": AppConfig.get_first_server_name(),
            "server_names": AppConfig.SERVER_NAMES,
            "pbk": pbk,
            "sid": sid,
            "public_key_fingerprint": pbk,
            "net_mode": preferred_mode if preferred_mode in ("direct", "reverse_wss") else "auto",
            "active_net_mode": net_mode,
            # Hysteria2 原生 UDP 双协议上报字段（老版 Hub 会自动忽略，新版 Hub 无缝联动订阅）
            "hy2_enabled": 1 if AppConfig.HY2_ENABLED else 0,
            "hy2_port": int(AppConfig.HY2_PORT or 0),
            "hy2_sni": AppConfig.HY2_SNI,
            "hy2_mport": AppConfig.HY2_MPORT,
            "hy2_insecure": 1 if AppConfig.HY2_INSECURE else 0,
            "hy2_cert_sha256": (hy2_cert_sha256 or "").strip().lower(),
            "block_cn": 1 if AppConfig.BLOCK_CN else 0,
        }
        if isinstance(health, dict):
            payload["health"] = health

        if self.is_bootstrapping:
            payload["bootstrap_token"] = AppConfig.BOOTSTRAP_TOKEN
        else:
            payload["node_key"] = self.node_key

        resp = self.post_json(url, payload)
        if not resp:
            return False, None

        if resp.get("code") == 403 and not self.is_bootstrapping and AppConfig.BOOTSTRAP_TOKEN:
            retry_payload = dict(payload)
            retry_payload.pop("node_key", None)
            retry_payload["bootstrap_token"] = AppConfig.BOOTSTRAP_TOKEN
            retry_resp = self.post_json(url, retry_payload)
            if retry_resp:
                resp = retry_resp

        assigned_key = resp.get("tofu_assigned_key")
        if assigned_key:
            self.save_node_key(assigned_key)
            if self.is_pending_approval_response(resp):
                print(
                    f"[HubSync] ⏳ TOFU 首次建档完成，节点已进入【待审批隔离区】"
                    f"（已固化节点凭证: {assigned_key[:6]}...{assigned_key[-4:]}），等待管理员在控制面板审批通过...",
                    flush=True,
                )
            else:
                print(f"[HubSync] 🎉 TOFU 信任协商成功并已准入上线！已固化专属密钥: {assigned_key[:6]}...{assigned_key[-4:]}", flush=True)

        new_key = resp.get("new_node_key")
        if new_key:
            self.save_node_key(new_key)
            print("[HubSync] 🔄 主控下发轮换密钥，新密钥已固化存盘。", flush=True)

        return True, resp

    def fetch_users_and_policy(self) -> Optional[Dict[str, Any]]:
        """从 Hub 拉取最新授权用户列表与权威策略"""
        if not AppConfig.PANEL_URL or not self.node_key:
            return None

        url = f"{AppConfig.PANEL_URL}/api/node/sync?node_id={self.node_id}&token={self.node_key}"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "wimotek-edge-agent/1.0"})
            with urllib.request.urlopen(req, timeout=10, context=_ssl_unverified_context()) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                if data.get("code") == 200:
                    return data
        except Exception:
            pass
        return None

    def query_and_report_traffic(self):
        """通过 sb-helper stats 查询 sing-box v2ray_api (10085) 增量流量并上报 Hub 结算"""
        if not AppConfig.PANEL_URL or not self.node_key:
            return

        try:
            cmd = [
                "/usr/bin/sb-helper",
                "stats",
                f"--server=127.0.0.1:{AppConfig.STATS_PORT}",
                "--pattern=user>>>",
                "--reset=true",
            ]
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
            if res.returncode == 0 and '"stat"' in res.stdout:
                data = json.loads(res.stdout)
                agg: Dict[str, int] = {}
                for item in data.get("stat", []):
                    val = int(item.get("value", 0))
                    if val > 0:
                        parts = item.get("name", "").split(">>>")
                        if len(parts) > 1 and parts[1]:
                            agg[parts[1]] = agg.get(parts[1], 0) + val

                traffic_items = [{"email": email, "bytes": total} for email, total in agg.items() if total > 0]
                if traffic_items:
                    self.post_json(
                        f"{AppConfig.PANEL_URL}/api/node/traffic",
                        {
                            "node_id": self.node_id,
                            "token": self.node_key,
                            "traffic": traffic_items,
                        },
                    )
                    print(f"[Traffic] 📊 成功回传结算 {len(traffic_items)} 位用户双协议增量流量", flush=True)
        except Exception:
            pass
