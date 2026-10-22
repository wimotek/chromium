import subprocess
import json
import os
from config import Config

def get_reality_public_key() -> str:
    """获取 REALITY Public Key (优先读取文件，若异常则从 config.json 私钥动态反推)"""
    key_path = "/data/public_key.txt"
    
    # 1. 尝试直接读取已缓存的公钥
    if os.path.exists(key_path):
        try:
            with open(key_path, "r", encoding="utf-8") as f:
                pk = f.read().strip()
                # 过滤掉以前可能存在的脏数据 (PublicKey):
                if pk and len(pk) > 30 and not pk.startswith("(") and " " not in pk:
                    return pk
        except Exception:
            pass

    # 2. 兜底自愈：直接从 /data/config.json 读取私钥反推公钥
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
                # 修复核心：私钥作为参数直接跟在 -i 后面
                cmd = ["/usr/bin/xray", "x25519", "-i", priv_key]
                res = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, text=True)
                for line in res.splitlines():
                    if "Public key:" in line:
                        pk = line.split("Public key:")[1].strip()
                        with open(key_path, "w", encoding="utf-8") as fw:
                            fw.write(pk)
                        return pk
        except Exception:
            pass

    return ""

def query_user_traffic(email: str) -> float:
    """从 Xray 内部 API 统计用户的上行与下行总流量（单位：MB）"""
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

# 兼容旧版本调用别名
get_user_traffic = query_user_traffic

def build_vless_link(uuid_str: str, pbk: str, name: str) -> str:
    """生成标准 VLESS Reality 分享链接"""
    return (
        f"vless://{uuid_str}@{Config.SERVER_HOST}:{Config.SERVER_PORT}"
        f"?security=reality&encryption=none&pbk={pbk}&headerType=none"
        f"&type=tcp&flow=xtls-rprx-vision&sni={Config.SNI}&sid={Config.SHORT_ID}#{name}"
    )