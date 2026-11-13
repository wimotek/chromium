# -*- coding: utf-8 -*-
"""
Hub Client & Sync Worker
负责向 Hub 端上报双栈公网 IP 与端口、执行 TOFU 准入协商、同步最新网络模式/用户列表、采集上报增量流量
"""
import os
import json
import urllib.request
import urllib.error
import ssl
import subprocess
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

    def _load_node_key(self) -> str:
        if os.path.exists(AppConfig.NODE_KEY_FILE):
            with open(AppConfig.NODE_KEY_FILE, "r") as f:
                k = f.read().strip()
                if k:
                    return k
        return ""

    def save_node_key(self, key: str):
        self.node_key = key
        with open(AppConfig.NODE_KEY_FILE, "w") as f:
            f.write(key + "\n")
        self.is_bootstrapping = False

    def post_json(self, url: str, payload: Dict[str, Any], timeout: int = 12) -> Optional[Dict[str, Any]]:
        try:
            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "User-Agent": "wimotek-edge-agent/1.0"
                }
            )
            with urllib.request.urlopen(req, timeout=timeout, context=_ssl_unverified_context()) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                body = e.read().decode("utf-8")
                return json.loads(body)
            except Exception:
                return {"code": e.code, "msg": str(e)}
        except Exception:
            return None

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
    ) -> Tuple[bool, Optional[Dict[str, Any]]]:
        """向 Hub 上报自身公网 IPv4 / IPv6 与端口，交由 Hub 端 wimotek-edge-agent 拨测判定网络模式"""
        if not AppConfig.PANEL_URL:
            return False, None

        url = f"{AppConfig.PANEL_URL}/api/node/heartbeat"
        payload: Dict[str, Any] = {
            "node_id": self.node_id,
            "node_uuid": self.node_id,
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
        }

        if self.is_bootstrapping:
            payload["bootstrap_token"] = AppConfig.BOOTSTRAP_TOKEN
        else:
            payload["node_key"] = self.node_key

        resp = self.post_json(url, payload)
        if not resp:
            return False, None

        # 若本地固化 node_key 与 Hub 不一致被 403 拒绝且配了引导令牌，自动携 bootstrap_token 重试协商恢复
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
            print(f"[HubSync] 🎉 TOFU 信任协商成功！已固化专属密钥: {assigned_key[:6]}...{assigned_key[-4:]}", flush=True)

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
        """采集 Xray 本地 10085 Stats API 增量流量并上报给 Hub 结算"""
        if not AppConfig.PANEL_URL or not self.node_key:
            return

        try:
            cmd = [
                "/usr/bin/xray", "api", "statsquery",
                f"--server=127.0.0.1:{AppConfig.STATS_PORT}",
                "-pattern=user>>>",
                "-reset=true"
            ]
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=4)
            if res.returncode == 0 and '"value"' in res.stdout:
                data = json.loads(res.stdout)
                traffic_items = []
                for item in data.get("stat", []):
                    val = int(item.get("value", 0))
                    if val > 0:
                        parts = item.get("name", "").split(">>>")
                        if len(parts) > 1:
                            traffic_items.append({"email": parts[1], "bytes": val})

                if traffic_items:
                    self.post_json(f"{AppConfig.PANEL_URL}/api/node/traffic", {
                        "node_id": self.node_id,
                        "token": self.node_key,
                        "traffic": traffic_items
                    })
                    print(f"[Traffic] 📊 成功回传结算 {len(traffic_items)} 位用户增量流量", flush=True)
        except Exception:
            pass
