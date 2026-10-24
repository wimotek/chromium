import os
import io
import json
import zipfile
import urllib.request
import shutil

CACHE_DIR = "/data/cache"
CLIENT_CACHE_FILE = os.path.join(CACHE_DIR, "Xray-windows-64.zip")

def get_latest_xray_version() -> str:
    api_url = "https://api.github.com/repos/XTLS/Xray-core/releases/latest"
    try:
        req = urllib.request.Request(api_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=4) as response:
            data = json.loads(response.read().decode())
            return data.get("tag_name", "v24.11.30")
    except Exception:
        return "v24.11.30"

def ensure_base_windows_client() -> str:
    os.makedirs(CACHE_DIR, exist_ok=True)
    if os.path.exists(CLIENT_CACHE_FILE) and os.path.getsize(CLIENT_CACHE_FILE) > 10 * 1024 * 1024:
        return CLIENT_CACHE_FILE

    version = get_latest_xray_version()
    download_url = f"https://github.com/XTLS/Xray-core/releases/download/{version}/Xray-windows-64.zip"
    tmp_download = os.path.join(CACHE_DIR, "download.tmp.zip")

    try:
        req = urllib.request.Request(download_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=60) as resp, open(tmp_download, 'wb') as out_f:
            shutil.copyfileobj(resp, out_f)

        if os.path.exists(tmp_download) and os.path.getsize(tmp_download) > 10 * 1024 * 1024:
            os.replace(tmp_download, CLIENT_CACHE_FILE)
            return CLIENT_CACHE_FILE
    except Exception as e:
        if os.path.exists(tmp_download):
            os.remove(tmp_download)

    if not os.path.exists(CLIENT_CACHE_FILE):
        raise RuntimeError("无法连接 GitHub 下载基础客户端包，请手动放置 Xray-windows-64.zip 至 ./data/cache")
    return CLIENT_CACHE_FILE

def build_windows_client_config(user_uuid: str, node: dict) -> str:
    config = {
        "log": { "loglevel": "warning" },
        "inbounds": [
            {
                "listen": "127.0.0.1", "port": 10808, "protocol": "socks",
                "sniffing": { "enabled": True, "destOverride": ["http", "tls"] },
                "settings": { "auth": "noauth", "udp": True }
            },
            {
                "listen": "127.0.0.1", "port": 10809, "protocol": "http",
                "sniffing": { "enabled": True, "destOverride": ["http", "tls"] }
            }
        ],
        "outbounds": [
            {
                "protocol": "vless",
                "settings": {
                    "vnext": [{
                        "address": node["ip"],
                        "port": node["port"],
                        "users": [{ "id": user_uuid, "encryption": "none", "flow": "xtls-rprx-vision" }]
                    }]
                },
                "streamSettings": {
                    "network": "tcp", "security": "reality",
                    "realitySettings": {
                        "show": False, "fingerprint": "chrome",
                        "serverName": node["sni"],
                        "publicKey": node["pbk"],
                        "shortId": node["sid"],
                        "spiderX": ""
                    }
                },
                "tag": "proxy"
            },
            { "protocol": "freedom", "tag": "direct" },
            { "protocol": "blackhole", "tag": "block" }
        ],
        "routing": {
            "domainStrategy": "IPIfNonMatch",
            "rules": [
                { "type": "field", "ip": ["geoip:private", "geoip:cn"], "outboundTag": "direct" },
                { "type": "field", "domain": ["geosite:cn"], "outboundTag": "direct" },
                { "type": "field", "network": "tcp,udp", "outboundTag": "proxy" }
            ]
        }
    }
    return json.dumps(config, indent=2, ensure_ascii=False)

def generate_windows_package(user: dict, node: dict) -> io.BytesIO:
    base_zip_path = ensure_base_windows_client()
    user_uuid = user.get("uuid", "")
    username = user.get("username", "user")
    node_name = node.get("name", "默认节点")

    start_bat = (
        "@echo off\r\n"
        "chcp 65001 >nul\r\n"
        f"title Xray Windows Client - [{node_name}]\r\n"
        "echo ======================================================\r\n"
        f"echo        正在启动 Xray 客户端 [用户: {username} | 节点: {node_name}]\r\n"
        "echo ======================================================\r\n"
        "reg add \"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\" /v ProxyEnable /t REG_DWORD /d 1 /f >nul\r\n"
        "reg add \"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\" /v ProxyServer /d \"127.0.0.1:10809\" /f >nul\r\n"
        "reg add \"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\" /v ProxyOverride /d \"localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;<local>\" /f >nul\r\n"
        "echo [√] 系统代理已成功激活！(国内直连，海外加速)\r\n"
        "echo [√] Xray 核心运行中... 请保持本窗口开启！\r\n"
        "echo ------------------------------------------------------\r\n"
        "echo 如需退出，请直接关闭本黑框，或运行 [停止代理.bat]\r\n"
        "echo ======================================================\r\n"
        "xray.exe run -c config.json\r\n"
        "reg add \"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\" /v ProxyEnable /t REG_DWORD /d 0 /f >nul\r\n"
    )

    stop_bat = (
        "@echo off\r\n"
        "chcp 65001 >nul\r\n"
        "echo 正在停止 Xray 进程并关闭 Windows 系统代理...\r\n"
        "taskkill /f /im xray.exe >nul 2>&1\r\n"
        "reg add \"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\" /v ProxyEnable /t REG_DWORD /d 0 /f >nul\r\n"
        "echo [√] 系统代理已安全关闭，网络恢复正常。\r\n"
        "timeout /t 2 >nul\r\n"
    )

    readme_txt = (
        "======================================================\r\n"
        f"      Xray REALITY Windows 专属客户端使用说明\r\n"
        f"      授权账号: {username} | 当前预设节点: {node_name}\r\n"
        "======================================================\r\n\r\n"
        "1. 将本压缩包解压到任意文件夹；\r\n"
        "2. 双击运行 [一键启动代理(自动配置系统代理).bat]；\r\n"
        "3. 打开浏览器即可畅快访问 Google、YouTube 等海外站点！\r\n"
        "4. 本配置已内置智能分流，访问国内网站不消耗流量。\r\n\r\n"
        "退出方法：直接关闭黑框窗口，或运行 [一键停止代理(关闭系统代理).bat] 即可。\r\n"
    )

    client_config_json = build_windows_client_config(user_uuid, node)
    mem_zip = io.BytesIO()
    with zipfile.ZipFile(base_zip_path, 'r') as src_zf, zipfile.ZipFile(mem_zip, 'w', compression=zipfile.ZIP_DEFLATED) as dst_zf:
        for item in src_zf.infolist():
            if item.filename not in ["config.json"]:
                dst_zf.writestr(item, src_zf.read(item.filename))

        dst_zf.writestr("config.json", client_config_json)
        dst_zf.writestr("一键启动代理(自动配置系统代理).bat", start_bat.encode('gbk'))
        dst_zf.writestr("一键停止代理(关闭系统代理).bat", stop_bat.encode('gbk'))
        dst_zf.writestr("使用说明.txt", readme_txt.encode('gbk'))

    mem_zip.seek(0)
    return mem_zip