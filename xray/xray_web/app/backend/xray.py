import subprocess
import json
import os
from config import Config

def get_cached_public_key() -> str:
    key_path = "/data/public_key.txt"
    if os.path.exists(key_path):
        with open(key_path, "r", encoding="utf-8") as f:
            pk = f.read().strip()
            if pk:
                return pk
    return "公钥生成中或未挂载/data"

def query_user_traffic(email: str) -> float:
    try:
        cmd = ["xray", "api", "statsquery", f"--server={Config.XRAY_API_SERVER}", "-pattern", f"user>>>{email}>>>traffic"]
        output = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, text=True)
        data = json.loads(output)
        total_bytes = sum(int(item.get("value", 0)) for item in data.get("stat", []))
        return round(total_bytes / (1024 * 1024), 2)
    except Exception:
        return 0.0

def build_vless_link(uuid_str: str, pbk: str, name: str) -> str:
    return (
        f"vless://{uuid_str}@{Config.SERVER_HOST}:{Config.SERVER_PORT}"
        f"?security=reality&encryption=none&pbk={pbk}&headerType=none"
        f"&type=tcp&flow=xtls-rprx-vision&sni={Config.SNI}&sid={Config.SHORT_ID}#{name}"
    )