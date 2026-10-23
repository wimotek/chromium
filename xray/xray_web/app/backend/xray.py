import subprocess
import json
import os
import urllib.request
from config import Config
from db import get_db

CONFIG_PATH = "/data/config.json"
CLIENT_INFO_PATH = "/data/client_info.txt"

def get_server_public_ip() -> str:
    """获取服务器真实公网 IP"""
    if Config.SERVER_HOST and Config.SERVER_HOST != "127.0.0.1" and Config.SERVER_HOST != "YOUR_SERVER_IP":
        return Config.SERVER_HOST
    if os.path.exists(CLIENT_INFO_PATH):
        try:
            with open(CLIENT_INFO_PATH, "r", encoding="utf-8") as f:
                for line in f:
                    if "IP / 地址:" in line:
                        ip = line.split(":")[-1].strip()
                        if ip and ip != "YOUR_SERVER_IP":
                            return ip
        except Exception:
            pass
    try:
        req = urllib.request.Request("https://api.ipify.org", headers={'User-Agent': 'curl/7.68.0'})
        with urllib.request.urlopen(req, timeout=3) as response:
            return response.read().decode('utf-8').strip()
    except Exception:
        pass
    return "127.0.0.1"

def get_xray_reality_params() -> dict:
    """直接从 /data/config.json 抓取 Xray 正在运行的真实 Reality 核心参数"""
    params = {
        "port": 443,
        "sni": "www.microsoft.com",
        "sid": "123456",
        "pbk": "",
        "ip": get_server_public_ip()
    }
    
    if not os.path.exists(CONFIG_PATH):
        return params

    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)

        for inbound in cfg.get("inbounds", []):
            if inbound.get("protocol") == "vless":
                params["port"] = inbound.get("port", 443)
                r_settings = inbound.get("streamSettings", {}).get("realitySettings", {})
                
                server_names = r_settings.get("serverNames", [])
                if server_names:
                    params["sni"] = server_names[0]
                
                short_ids = r_settings.get("shortIds", [])
                if short_ids:
                    params["sid"] = short_ids[0]

                priv_key = r_settings.get("privateKey", "")
                if priv_key and "CHANGE" not in priv_key:
                    try:
                        cmd = ["/usr/bin/xray", "x25519", "-i", priv_key]
                        res = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, text=True)
                        for line in res.splitlines():
                            if "Public key:" in line:
                                params["pbk"] = line.split("Public key:")[1].strip()
                                break
                    except Exception:
                        pass
                break
    except Exception as e:
        print(f"[Error] 解析 config.json 失败: {e}", flush=True)

    return params

def get_reality_public_key() -> str:
    return get_xray_reality_params().get("pbk", "")

def query_user_traffic(username: str) -> float:
    try:
        cmd = [
            "/usr/bin/xray", "api", "statsquery",
            f"--server={Config.XRAY_API_SERVER}",
            "-pattern", f"user>>>{username}>>>traffic"
        ]
        output = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, text=True)
        data = json.loads(output)
        total_bytes = sum(int(item.get("value", 0)) for item in data.get("stat", []))
        return round(total_bytes / (1024 * 1024), 2)
    except Exception:
        return 0.0

get_user_traffic = query_user_traffic

def build_vless_link(uuid_str: str, pbk: str, name: str) -> str:
    params = get_xray_reality_params()
    real_pbk = pbk if pbk else params["pbk"]
    return (
        f"vless://{uuid_str}@{params['ip']}:{params['port']}"
        f"?security=reality&encryption=none&pbk={real_pbk}&headerType=none&fp=chrome"
        f"&type=tcp&flow=xtls-rprx-vision&sni={params['sni']}&sid={params['sid']}#{name}"
    )

def sync_users_to_xray():
    """将 SQLite 中的所有活跃用户全量同步写入 /data/config.json"""
    if not os.path.exists(CONFIG_PATH):
        return False, "config.json 不存在"

    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT username, uuid FROM users WHERE status=1 AND is_verified=1")
    active_users = c.fetchall()
    conn.close()

    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)

        cfg["stats"] = {}
        cfg["policy"] = {
            "levels": {
                "0": {
                    "statsUserUplink": True,
                    "statsUserDownlink": True
                }
            },
            "system": {
                "statsInboundUplink": True,
                "statsInboundDownlink": True
            }
        }

        cfg["api"] = {
            "tag": "api",
            "services": ["StatsService"]
        }

        has_api_inbound = any(ib.get("tag") == "api" for ib in cfg.get("inbounds", []))
        if not has_api_inbound:
            cfg.setdefault("inbounds", []).insert(0, {
                "listen": "127.0.0.1",
                "port": 10085,
                "protocol": "dokodemo-door",
                "settings": {"address": "127.0.0.1"},
                "tag": "api"
            })

        cfg.setdefault("routing", {}).setdefault("rules", [])
        if not any(r.get("inboundTag") == ["api"] for r in cfg["routing"]["rules"]):
            cfg["routing"]["rules"].insert(0, {
                "inboundTag": ["api"],
                "outboundTag": "api",
                "type": "field"
            })

        clients_list = []
        for u in active_users:
            clients_list.append({
                "id": u["uuid"],
                "flow": "xtls-rprx-vision",
                "email": u["username"]
            })

        if not clients_list:
            clients_list.append({
                "id": "11111111-2222-3333-4444-555555555555",
                "flow": "xtls-rprx-vision",
                "email": "default_user"
            })

        vless_found = False
        for inbound in cfg.get("inbounds", []):
            if inbound.get("protocol") == "vless":
                inbound.setdefault("settings", {})["clients"] = clients_list
                vless_found = True
                break

        if not vless_found:
            return False, "未在 config.json 中找到 vless 协议入站"

        tmp_path = "/data/config.json.tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)
        os.replace(tmp_path, CONFIG_PATH)

        reload_xray_process()
        print(f"[Xray Sync] 成功将 {len(active_users)} 位用户同步写入 Xray 核心并热重载生效！", flush=True)
        return True, "同步成功"

    except Exception as e:
        print(f"[Xray Sync Error] 同步失败: {e}", flush=True)
        return False, str(e)

def reload_xray_process():
    try:
        subprocess.run(["pkill", "-HUP", "xray"], check=False)
    except Exception:
        pass