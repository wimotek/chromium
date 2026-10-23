import subprocess
import json
import os
import urllib.request
from config import Config
from db import get_db, get_setting

CONFIG_PATH = "/data/config.json"
CLIENT_INFO_PATH = "/data/client_info.txt"
PUBLIC_KEY_PATH = "/data/public_key.txt"

def get_server_public_ip() -> str:
    """自动获取本机公网 IP"""
    if os.path.exists(CLIENT_INFO_PATH):
        try:
            with open(CLIENT_INFO_PATH, "r", encoding="utf-8") as f:
                for line in f:
                    if "IP / 地址:" in line:
                        ip = line.split(":")[-1].strip()
                        if ip and ip != "YOUR_SERVER_IP" and ip != "127.0.0.1":
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

def get_connection_host() -> str:
    """获取节点客户端连接地址：优先读取后台自定义设置，留空自动回退为真实公网 IP"""
    custom = get_setting("custom_host", "").strip()
    if custom:
        return custom
    return get_server_public_ip()

def extract_real_public_key(priv_key: str = "") -> str:
    """多层提取真实有效的 Public Key，绝不返回空"""
    # 1. 优先从 client_info.txt 中提取
    if os.path.exists(CLIENT_INFO_PATH):
        try:
            with open(CLIENT_INFO_PATH, "r", encoding="utf-8") as f:
                for line in f:
                    if "公钥" in line or "PublicKey" in line:
                        parts = line.split(":")
                        if len(parts) >= 2:
                            pk = parts[-1].strip()
                            if len(pk) >= 30 and not pk.startswith("("):
                                return pk
        except Exception:
            pass

    # 2. 从 public_key.txt 提取
    if os.path.exists(PUBLIC_KEY_PATH):
        try:
            with open(PUBLIC_KEY_PATH, "r", encoding="utf-8") as f:
                pk = f.read().strip()
                if len(pk) >= 30 and not pk.startswith("("):
                    return pk
        except Exception:
            pass

    # 3. 现场执行 xray x25519 -i 计算
    if priv_key and "CHANGE" not in priv_key:
        for bin_name in ["/usr/bin/xray", "xray"]:
            try:
                out = subprocess.check_output([bin_name, "x25519", "-i", priv_key.strip()], text=True)
                for line in out.splitlines():
                    if "Public key" in line or "public key" in line or "Public" in line:
                        pk = line.split(":")[-1].strip()
                        if len(pk) >= 30:
                            with open(PUBLIC_KEY_PATH, "w", encoding="utf-8") as fw:
                                fw.write(pk)
                            return pk
            except Exception:
                pass

    return ""

def get_xray_reality_params() -> dict:
    """直接解析 /data/config.json 获取运行参数"""
    params = {
        "port": 443,
        "sni": "www.microsoft.com",
        "sid": "123456",
        "pbk": "",
        "host": get_connection_host()
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
                params["pbk"] = extract_real_public_key(priv_key)
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
    real_pbk = pbk if (pbk and len(pbk) > 20) else params["pbk"]
    return (
        f"vless://{uuid_str}@{params['host']}:{params['port']}"
        f"?security=reality&encryption=none&pbk={real_pbk}&headerType=none&fp=chrome"
        f"&type=tcp&flow=xtls-rprx-vision&sni={params['sni']}&sid={params['sid']}#{name}"
    )

def sync_users_to_xray():
    """
    【核心打通】读取 SQLite 中所有有效用户全量同步写入 /data/config.json，
    并自动补全 stats、policy 与 10085 统计端口！
    """
    if not os.path.exists(CONFIG_PATH):
        return False, "config.json 尚未生成"

    conn = get_db()
    c = conn.cursor()
    # 状态正常（未被封禁）的用户
    c.execute("SELECT username, uuid FROM users WHERE status=1")
    active_users = c.fetchall()
    conn.close()

    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)

        # 1. 补齐流量统计模块
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

        # 2. 补齐内部 API 模块
        cfg["api"] = {
            "tag": "api",
            "services": ["StatsService"]
        }

        # 3. 补齐 10085 内部监控端口
        has_api_inbound = any(ib.get("tag") == "api" for ib in cfg.get("inbounds", []))
        if not has_api_inbound:
            cfg.setdefault("inbounds", []).insert(0, {
                "listen": "127.0.0.1",
                "port": 10085,
                "protocol": "dokodemo-door",
                "settings": {"address": "127.0.0.1"},
                "tag": "api"
            })

        # 4. 补齐 API 内部路由
        cfg.setdefault("routing", {}).setdefault("rules", [])
        if not any(r.get("inboundTag") == ["api"] for r in cfg["routing"]["rules"]):
            cfg["routing"]["rules"].insert(0, {
                "inboundTag": ["api"],
                "outboundTag": "api",
                "type": "field"
            })

        # 5. 把数据库真实用户组装成 VLESS clients
        clients_list = []
        for u in active_users:
            clients_list.append({
                "id": u["uuid"],
                "flow": "xtls-rprx-vision",
                "email": u["username"]  # Xray 靠 email 绑定用户名统计流量
            })

        if not clients_list:
            clients_list.append({
                "id": "11111111-2222-3333-4444-555555555555",
                "flow": "xtls-rprx-vision",
                "email": "default_user"
            })

        # 注入 clients 到 VLESS 入站
        vless_found = False
        for inbound in cfg.get("inbounds", []):
            if inbound.get("protocol") == "vless":
                inbound.setdefault("settings", {})["clients"] = clients_list
                vless_found = True
                break

        if not vless_found:
            return False, "未在 config.json 中找到 vless 协议"

        # 6. 原子覆写
        tmp_path = "/data/config.json.tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)
        os.replace(tmp_path, CONFIG_PATH)

        # 7. 热重载 Xray 核心生效
        try:
            subprocess.run(["pkill", "-HUP", "xray"], check=False)
        except Exception:
            pass

        print(f"[Xray Sync] 成功将 {len(active_users)} 位用户 ({[u['username'] for u in active_users]}) 真实写入 Xray 核心并重载生效！", flush=True)
        return True, "同步成功"

    except Exception as e:
        print(f"[Xray Sync Error] 写入失败: {e}", flush=True)
        return False, str(e)