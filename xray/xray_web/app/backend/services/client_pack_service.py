import os
import io
import json
import zipfile
import sqlite3
import uuid
import tempfile
import urllib.request
import shutil
import time

CACHE_DIR = "/data/cache"
V2RAYN_CACHE_FILE = os.path.join(CACHE_DIR, "v2rayN-windows-64-SelfContained.zip")
V2RAYNG_CACHE_FILE = os.path.join(CACHE_DIR, "v2rayNG.apk")

CUSTOM_GUIDB_CANDIDATES = [
    "/data/guidb.db",
    "/data/guiDB.db",
    "/data/guiConfigs/guiDB.db",
    "/data/guiConfigs/guidb.db"
]

CUSTOM_GUICONFIG_CANDIDATES = [
    "/data/guiconfig.json",
    "/data/guiConfig.json",
    "/data/guiConfigs/guiConfig.json",
    "/data/guiConfigs/guiconfig.json"
]

def find_custom_template(candidates: list) -> str:
    for path in candidates:
        if os.path.exists(path) and os.path.getsize(path) > 0:
            return path
    return ""

# ==================== Windows v2rayN 打包部分 ====================

def get_latest_v2rayn_selfcontained_url() -> tuple[str, str]:
    api_url = "https://api.github.com/repos/2dust/v2rayN/releases/latest"
    try:
        req = urllib.request.Request(api_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=8) as response:
            data = json.loads(response.read().decode())
            tag = data.get("tag_name", "latest")
            assets = data.get("assets", [])

            for a in assets:
                name = a.get("name", "")
                if "selfcontained" in name.lower() and ("windows-64" in name.lower() or "win64" in name.lower()) and name.endswith(".zip"):
                    return tag, a.get("browser_download_url")

            for a in assets:
                name = a.get("name", "")
                if "selfcontained" in name.lower() and name.endswith(".zip"):
                    return tag, a.get("browser_download_url")

            for a in assets:
                name = a.get("name", "")
                if "with-core" in name.lower() and ("windows-64" in name.lower() or "win64" in name.lower()) and name.endswith(".zip"):
                    return tag, a.get("browser_download_url")
    except Exception as e:
        print(f"[v2rayN Release Check Error] {e}", flush=True)

    return "latest", "https://github.com/2dust/v2rayN/releases/latest/download/v2rayN-windows-64-SelfContained.zip"

def ensure_base_v2rayn_client() -> str:
    os.makedirs(CACHE_DIR, exist_ok=True)
    if os.path.exists(V2RAYN_CACHE_FILE) and os.path.getsize(V2RAYN_CACHE_FILE) > 40 * 1024 * 1024:
        return V2RAYN_CACHE_FILE

    tag, download_url = get_latest_v2rayn_selfcontained_url()
    tmp_download = os.path.join(CACHE_DIR, "v2rayn_selfcontained.tmp.zip")

    try:
        print(f"==> [v2rayN Pack] 正在下载官方 SelfContained 独立包 ({tag})...", flush=True)
        req = urllib.request.Request(download_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=180) as resp, open(tmp_download, 'wb') as out_f:
            shutil.copyfileobj(resp, out_f)

        if os.path.exists(tmp_download) and os.path.getsize(tmp_download) > 40 * 1024 * 1024:
            os.replace(tmp_download, V2RAYN_CACHE_FILE)
            return V2RAYN_CACHE_FILE
    except Exception as e:
        print(f"[v2rayN Download Error] {e}", flush=True)
        if os.path.exists(tmp_download):
            os.remove(tmp_download)

    if not os.path.exists(V2RAYN_CACHE_FILE):
        raise RuntimeError("无法下载 v2rayN-windows-64-SelfContained.zip，请手动上传至 /data/cache 目录！")
    return V2RAYN_CACHE_FILE

def build_v2rayn_db_bytes(sub_url: str, username: str) -> bytes:
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as tmp_db:
        tmp_db_path = tmp_db.name

    try:
        custom_db = find_custom_template(CUSTOM_GUIDB_CANDIDATES)

        if custom_db:
            shutil.copyfile(custom_db, tmp_db_path)
            conn = sqlite3.connect(tmp_db_path)
            c = conn.cursor()
            try:
                c.execute("UPDATE SubItem SET url=?, remarks=? WHERE enabled=1", (sub_url, f"⚡ {username} 专属加速订阅"))
                if c.rowcount == 0:
                    sub_id = str(uuid.uuid4())
                    now_ts = int(time.time())
                    c.execute("""
                        INSERT INTO SubItem (id, remarks, url, moreUrl, enabled, autoUpdateInterval, updateTime, filter, convertTarget, sort) 
                        VALUES (?, ?, ?, '', 1, 720, ?, '', '', 1)
                    """, (sub_id, f"⚡ {username} 专属加速订阅", sub_url, now_ts))
                conn.commit()
            except Exception as e:
                print(f"[v2rayN DB Patch Warning] {e}", flush=True)
            finally:
                conn.close()
        else:
            conn = sqlite3.connect(tmp_db_path)
            c = conn.cursor()
            c.execute('''
                CREATE TABLE IF NOT EXISTS "SubItem" (
                    "id" text PRIMARY KEY NOT NULL,
                    "remarks" text,
                    "url" text,
                    "moreUrl" text,
                    "enabled" integer,
                    "autoUpdateInterval" integer,
                    "updateTime" integer,
                    "filter" text,
                    "convertTarget" text,
                    "prevNodeIndex" integer,
                    "sort" integer
                )
            ''')
            sub_id = str(uuid.uuid4())
            now_ts = int(time.time())
            c.execute('''
                INSERT INTO SubItem (id, remarks, url, moreUrl, enabled, autoUpdateInterval, updateTime, filter, convertTarget, sort)
                VALUES (?, ?, ?, '', 1, 720, ?, '', '', 1)
            ''', (sub_id, f"⚡ {username} 专属加速订阅", sub_url, now_ts))
            conn.commit()
            conn.close()

        with open(tmp_db_path, "rb") as f:
            data = f.read()
        return data
    finally:
        if os.path.exists(tmp_db_path):
            os.remove(tmp_db_path)

def build_v2rayn_guiconfig_json(sub_url: str, username: str) -> str:
    custom_json = find_custom_template(CUSTOM_GUICONFIG_CANDIDATES)

    if custom_json:
        try:
            with open(custom_json, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            cfg["sysProxyType"] = 1
            cfg["autoUpdateSub"] = True
            return json.dumps(cfg, indent=2, ensure_ascii=False)
        except Exception:
            pass

    config = {
        "autoRun": False,
        "enableStatistics": False,
        "keepOlderDns": False,
        "autoUpdateSub": True,
        "sysProxyType": 1,
        "routingMode": 1,
        "listenerType": 1,
        "speedTestTimeout": 10,
        "muxEnabled": False,
        "coreTypeItem": [],
        "uiItem": {
            "mainSize": "1000, 650",
            "speedTestDelay": 1
        }
    }
    return json.dumps(config, indent=2, ensure_ascii=False)

def generate_windows_package(user: dict, host_prefix: str) -> io.BytesIO:
    base_zip_path = ensure_base_v2rayn_client()
    username = user.get("username", "user")
    uuid_str = user.get("uuid", "")
    sub_url = f"{host_prefix}/api/sub?token={uuid_str}"

    readme_txt = (
        "======================================================\r\n"
        f"      Xray Reality v2rayN 免环境专属客户端说明\r\n"
        f"      授权账号: {username}\r\n"
        "======================================================\r\n\r\n"
        "1. 解压本压缩包到电脑任意文件夹，双击运行 [v2rayN.exe]；\r\n"
        "2. 顶部菜单点击 [订阅分组] -> [更新全部订阅(不通过代理)]；\r\n"
        "   全套加速节点将自动呈现！\r\n\r\n"
        "【特性】：\r\n"
        "- 内置 .NET 8 运行环境，绝无缺失运行库报错；\r\n"
        "- 已预置开启系统代理，打开浏览器即可秒开海外站点；\r\n"
        "- 预置黑名单规则，国内网站秒开且不消耗流量。\r\n"
    )

    db_bytes = build_v2rayn_db_bytes(sub_url, username)
    config_json_str = build_v2rayn_guiconfig_json(sub_url, username)

    mem_zip = io.BytesIO()
    with zipfile.ZipFile(base_zip_path, 'r') as src_zf, zipfile.ZipFile(mem_zip, 'w', compression=zipfile.ZIP_DEFLATED) as dst_zf:
        for item in src_zf.infolist():
            fname = item.filename
            if fname.endswith("guiDB.db") or fname.endswith("guidb.db") or fname.endswith("guiConfig.json") or fname.endswith("guiconfig.json"):
                continue
            dst_zf.writestr(item, src_zf.read(item.filename))

        dst_zf.writestr("guiConfigs/guiDB.db", db_bytes)
        dst_zf.writestr("guiConfigs/guiConfig.json", config_json_str.encode('utf-8'))
        dst_zf.writestr("guiConfig.json", config_json_str.encode('utf-8'))
        dst_zf.writestr("使用说明.txt", readme_txt.encode('gbk'))

    mem_zip.seek(0)
    return mem_zip

# ==================== Android v2rayNG 官方 APK 通道 ====================

def get_latest_v2rayng_apk_url() -> tuple[str, str]:
    api_url = "https://api.github.com/repos/2dust/v2rayNG/releases/latest"
    try:
        req = urllib.request.Request(api_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=8) as response:
            data = json.loads(response.read().decode())
            tag = data.get("tag_name", "latest")
            assets = data.get("assets", [])

            # 优先匹配通用的 Universal 或 arm64-v8a APK
            for a in assets:
                name = a.get("name", "")
                if name.endswith(".apk") and "universal" in name.lower():
                    return tag, a.get("browser_download_url")

            for a in assets:
                name = a.get("name", "")
                if name.endswith(".apk") and "arm64" in name.lower():
                    return tag, a.get("browser_download_url")

            for a in assets:
                name = a.get("name", "")
                if name.endswith(".apk"):
                    return tag, a.get("browser_download_url")
    except Exception as e:
        print(f"[v2rayNG Check Error] {e}", flush=True)

    return "latest", "https://github.com/2dust/v2rayNG/releases/latest/download/v2rayNG.apk"

def ensure_base_v2rayng_apk() -> str:
    os.makedirs(CACHE_DIR, exist_ok=True)
    if os.path.exists(V2RAYNG_CACHE_FILE) and os.path.getsize(V2RAYNG_CACHE_FILE) > 15 * 1024 * 1024:
        return V2RAYNG_CACHE_FILE

    tag, download_url = get_latest_v2rayng_apk_url()
    tmp_download = os.path.join(CACHE_DIR, "v2rayng_download.tmp.apk")

    try:
        print(f"==> [v2rayNG APK] 正在拉取官方最新 APK ({tag})...", flush=True)
        req = urllib.request.Request(download_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=120) as resp, open(tmp_download, 'wb') as out_f:
            shutil.copyfileobj(resp, out_f)

        if os.path.exists(tmp_download) and os.path.getsize(tmp_download) > 15 * 1024 * 1024:
            os.replace(tmp_download, V2RAYNG_CACHE_FILE)
            return V2RAYNG_CACHE_FILE
    except Exception as e:
        print(f"[v2rayNG APK Download Error] {e}", flush=True)
        if os.path.exists(tmp_download):
            os.remove(tmp_download)

    if not os.path.exists(V2RAYNG_CACHE_FILE):
        raise RuntimeError("无法下载官方 v2rayNG.apk，请手动放置该安装包至 /data/cache 目录！")
    return V2RAYNG_CACHE_FILE