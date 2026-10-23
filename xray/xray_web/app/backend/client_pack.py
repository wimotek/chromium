import os
import io
import json
import zipfile
import urllib.request
import shutil
from xray import get_xray_reality_params

CACHE_DIR = "/data/cache"
CLIENT_CACHE_FILE = os.path.join(CACHE_DIR, "Xray-windows-64.zip")

def get_latest_xray_version() -> str:
    """获取 GitHub 最新官方版本号 (失败时安全回退)"""
    api_url = "https://api.github.com/repos/XTLS/Xray-core/releases/latest"
    try:
        req = urllib.request.Request(api_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=4) as response:
            data = json.loads(response.read().decode())
            return data.get("tag_name", "v24.11.30")
    except Exception:
        return "v24.11.30"

def ensure_base_windows_client() -> str:
    """
    检查本地 /data/cache 目录是否存在缓存包；
    若无缓存，则自动从官方 GitHub Releases 下载并固化
    """
    os.makedirs(CACHE_DIR, exist_ok=True)

    # 1. 如果本地缓存存在且大小正常 (>10MB)，直接复用
    if os.path.exists(CLIENT_CACHE_FILE) and os.path.getsize(CLIENT_CACHE_FILE) > 10 * 1024 * 1024:
        return CLIENT_CACHE_FILE

    # 2. 从官方源下载最新包并写入缓存
    version = get_latest_xray_version()
    download_url = f"https://github.com/XTLS/Xray-core/releases/download/{version}/Xray-windows-64.zip"
    tmp_download = os.path.join(CACHE_DIR, "download.tmp.zip")

    print(f"[Client Pack] 正在下载官方最新 Windows 核心包 ({version}): {download_url} ...", flush=True)
    try:
        req = urllib.request.Request(download_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=60) as resp, open(tmp_download, 'wb') as out_f:
            shutil.copyfileobj(resp, out_f)

        if os.path.exists(tmp_download) and os.path.getsize(tmp_download) > 10 * 1024 * 1024:
            os.replace(tmp_download, CLIENT_CACHE_FILE)
            print("[Client Pack] Windows 基础核心包缓存成功！", flush=True)
            return CLIENT_CACHE_FILE
    except Exception as e:
        print(f"[Client Pack Error] 官方包下载失败: {e}", flush=True)
        if os.path.exists(tmp_download):
            os.remove(tmp_download)

    # 若下载异常且无缓存则报错
    if not os.path.exists(CLIENT_CACHE_FILE):
        raise RuntimeError("无法连接 GitHub 获取 Windows 客户端基础包，请检查网络或手动放置 Xray-windows-64.zip 至 ./data/cache 目录")
    return CLIENT_CACHE_FILE

def build_windows_client_config(user_uuid: str) -> str:
    """构造专属于该用户的 Windows 客户端开箱即用 config.json"""
    params = get_xray_reality_params()
    
    config = {
        "log": {
            "loglevel": "warning"
        },
        "inbounds": [
            {
                "listen": "127.0.0.1",
                "port": 10808,
                "protocol": "socks",
                "sniffing": {
                    "enabled": True,
                    "destOverride": ["http", "tls"]
                },
                "settings": {
                    "auth": "noauth",
                    "udp": True
                }
            },
            {
                "listen": "127.0.0.1",
                "port": 10809,
                "protocol": "http",
                "sniffing": {
                    "enabled": True,
                    "destOverride": ["http", "tls"]
                }
            }
        ],
        "outbounds": [
            {
                "protocol": "vless",
                "settings": {
                    "vnext": [
                        {
                            "address": params["host"],
                            "port": params["port"],
                            "users": [
                                {
                                    "id": user_uuid,
                                    "encryption": "none",
                                    "flow": "xtls-rprx-vision"
                                }
                            ]
                        }
                    ]
                },
                "streamSettings": {
                    "network": "tcp",
                    "security": "reality",
                    "realitySettings": {
                        "show": False,
                        "fingerprint": "chrome",
                        "serverName": params["sni"],
                        "publicKey": params["pbk"],
                        "shortId": params["sid"],
                        "spiderX": ""
                    }
                },
                "tag": "proxy"
            },
            {
                "protocol": "freedom",
                "tag": "direct"
            },
            {
                "protocol": "blackhole",
                "tag": "block"
            }
        ],
        "routing": {
            "domainStrategy": "IPIfNonMatch",
            "rules": [
                {
                    "type": "field",
                    "ip": ["geoip:private", "geoip:cn"],
                    "outboundTag": "direct"
                },
                {
                    "type": "field",
                    "domain": ["geosite:cn"],
                    "outboundTag": "direct"
                },
                {
                    "type": "field",
                    "network": "tcp,udp",
                    "outboundTag": "proxy"
                }
            ]
        }
    }
    return json.dumps(config, indent=2, ensure_ascii=False)

def generate_windows_package(user: dict) -> io.BytesIO:
    """动态为指定用户注入配置、启动脚本并打包为 zip 二进制流"""
    base_zip_path = ensure_base_windows_client()
    user_uuid = user.get("uuid", "")
    username = user.get("username", "user")

    # 启动代理批处理（自动开启 Windows 系统代理）
    start_bat = (
        "@echo off\r\n"
        "chcp 65001 >nul\r\n"
        "title Xray Windows Client - Powered by Xray Reality\r\n"
        "echo ======================================================\r\n"
        f"echo        正在启动 Xray 客户端 [用户: {username}]\r\n"
        "echo ======================================================\r\n"
        ":: 1. 开启 Windows 系统代理 (127.0.0.1:10809)\r\n"
        "reg add \"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\" /v ProxyEnable /t REG_DWORD /d 1 /f >nul\r\n"
        "reg add \"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\" /v ProxyServer /d \"127.0.0.1:10809\" /f >nul\r\n"
        "reg add \"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\" /v ProxyOverride /d \"localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;<local>\" /f >nul\r\n"
        "echo [√] Windows 系统代理已成功激活！(国内网站直连，海外网站加速)\r\n"
        "echo [√] Xray 核心运行中... 请保持本窗口开启！\r\n"
        "echo ------------------------------------------------------\r\n"
        "echo 如需退出，请直接关闭本黑框窗口，或双击 [停止代理.bat]\r\n"
        "echo ======================================================\r\n"
        "xray.exe run -c config.json\r\n"
        ":: 窗口意外被关闭时保底自动清除系统代理\r\n"
        "reg add \"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\" /v ProxyEnable /t REG_DWORD /d 0 /f >nul\r\n"
    )

    # 停止代理批处理（自动恢复网络）
    stop_bat = (
        "@echo off\r\n"
        "chcp 65001 >nul\r\n"
        "echo 正在停止 Xray 进程并关闭 Windows 系统代理...\r\n"
        "taskkill /f /im xray.exe >nul 2>&1\r\n"
        "reg add \"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\" /v ProxyEnable /t REG_DWORD /d 0 /f >nul\r\n"
        "echo [√] 系统代理已安全关闭，网络已完全恢复初始状态。\r\n"
        "timeout /t 2 >nul\r\n"
    )

    readme_txt = (
        "======================================================\r\n"
        f"      Xray REALITY Windows 专属客户端使用说明\r\n"
        f"      授权账号: {username}\r\n"
        "======================================================\r\n\r\n"
        "【使用方法】\r\n"
        "1. 将本压缩包解压到任意文件夹；\r\n"
        "2. 双击运行 [一键启动代理(自动配置系统代理).bat]；\r\n"
        "3. 打开浏览器即可畅快访问 Google、YouTube 等海外站点！\r\n"
        "4. 本配置已内置智能分流，访问国内网站（百度、淘宝等）不消耗流量且速度不受影响。\r\n\r\n"
        "【退出方法】\r\n"
        "直接关闭黑框窗口，或者双击 [一键停止代理(关闭系统代理).bat] 即可。\r\n"
    )

    client_config_json = build_windows_client_config(user_uuid)

    # 内存动态重组与打包
    mem_zip = io.BytesIO()
    with zipfile.ZipFile(base_zip_path, 'r') as src_zf, zipfile.ZipFile(mem_zip, 'w', compression=zipfile.ZIP_DEFLATED) as dst_zf:
        # 复制基础包内所有二进制与规则文件 (xray.exe, geoip.dat, geosite.dat 等)
        for item in src_zf.infolist():
            if item.filename not in ["config.json"]:
                dst_zf.writestr(item, src_zf.read(item.filename))

        # 写入用户专属定制文件
        dst_zf.writestr("config.json", client_config_json)
        dst_zf.writestr("一键启动代理(自动配置系统代理).bat", start_bat.encode('gbk'))
        dst_zf.writestr("一键停止代理(关闭系统代理).bat", stop_bat.encode('gbk'))
        dst_zf.writestr("使用说明.txt", readme_txt.encode('gbk'))

    mem_zip.seek(0)
    return mem_zip