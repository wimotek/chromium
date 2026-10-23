import subprocess
import json
import os
from config import Config

def get_reality_public_key() -> str:
    """三重保险获取 REALITY Public Key"""
    
    # 保险 1: 直接从 entrypoint 生成的 /data/client_info.txt 中秒级精准提取
    info_path = "/data/client_info.txt"
    if os.path.exists(info_path):
        try:
            with open(info_path, "r", encoding="utf-8") as f:
                for line in f:
                    if "公钥" in line and ":" in line:
                        pk = line.split(":")[-1].strip()
                        if len(pk) > 25 and not pk.startswith("(") and " " not in pk:
                            return pk
        except Exception:
            pass

    # 保险 2: 尝试读取已写入的 /data/public_key.txt
    key_path = "/data/public_key.txt"
    if os.path.exists(key_path):
        try:
            with open(key_path, "r", encoding="utf-8") as f:
                pk = f.read().strip()
                if pk and len(pk) > 25 and not pk.startswith("(") and " " not in pk:
                    return pk
        except Exception:
            pass

    # 保险 3: 从 /data/config.json 获取私钥现场动态计算
    config_path = "/data/config.json"
    if os.path.exists(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            priv_key = ""
            for inbound in cfg.get("inbounds", []):
                reality = inbound.get("streamSettings", {}).get("realitySettings", {})
                if reality.get("privateKey"):
                    priv_key = reality["privateKey"]
                    break

            if priv_key and "CHANGE" not in priv_key:
                cmd = ["/usr/bin/xray", "x25519", "-i", priv_key]
                res = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, text=True)
                for line in res.splitlines():
                    if "Public key:" in line:
                        return line.split("Public key:")[1].strip()
        except Exception:
            pass

    return ""

def query_user_traffic(email: str) -> float:
    try:
        cmd = [
            "/usr/bin/xray", "api", "statsquery",
            f"--server={Config.XRAY_API_SERVER}",
            "-pattern", f"user>>>{email}>>>traffic"
        ]
        output = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, text=True)
        data = json.loads(output)
        total_bytes = sum(int(item.get("value", 0)) for item in data.get("stat", []))
        return round(total_bytes / (1024 * 1024), 2)
    except Exception:
        return 0.0

get_user_traffic = query_user_traffic

def build_vless_link(uuid_str: str, pbk: str, name: str) -> str:
    return (
        f"vless://{uuid_str}@{Config.SERVER_HOST}:{Config.SERVER_PORT}"
        f"?security=reality&encryption=none&pbk={pbk}&headerType=none"
        f"&type=tcp&flow=xtls-rprx-vision&sni={Config.SNI}&sid={Config.SHORT_ID}#{name}"
    )