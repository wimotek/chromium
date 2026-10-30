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

# 宿主机挂载的自定义模板路径检测 (严格匹配大小写与目录结构)
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

def get_latest_v2rayn_selfcontained_url() -> tuple[str, str]:
    """通过 GitHub API 动态检索【自包含独立包 SelfContained】(自带完整 .NET 运行库 + Xray 内核)"""
    api_url = "https://api.github.com/repos/2dust/v2rayN/releases/latest"
    try:
        req = urllib.request.Request(api_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=8) as response:
            data = json.loads(response.read().decode())
            tag = data.get("tag_name", "latest")
            assets = data.get("assets", [])

            # 优先级 1: 独立自包含包 (SelfContained，自带完整 .NET 8 运行时，免装环境) + 64位 Windows + zip
            for a in assets:
                name = a.get("name", "")
                if "selfcontained" in name.lower() and ("windows-64" in name.lower() or "win64" in name.lower()) and name.endswith(".zip"):
                    print(f"==> [v2rayN Asset] 成功匹配到官方最新独立自包含包: {name}", flush=True)
                    return tag, a.get("browser_download_url")

            # 优先级 2: 任意 SelfContained .zip 独立包
            for a in assets:
                name = a.get("name", "")
                if "selfcontained" in name.lower() and name.endswith(".zip"):
                    return tag, a.get("browser_download_url")

            # 优先级 3: 包含 Core 的 With-Core 包 (次选)
            for a in assets:
                name = a.get("name", "")
                if "with-core" in name.lower() and ("windows-64" in name.lower() or "win64" in name.lower()) and name.endswith(".zip"):
                    return tag, a.get("browser_download_url")
    except Exception as e:
        print(f"[v2rayN Release Check] GitHub 资产列表查询异常: {e}", flush=True)

    # 兜底官方 SelfContained 标准直链
    return "latest", "https://github.com/2dust/v2rayN/releases/latest/download/v2rayN-windows-64-SelfContained.zip"

def ensure_base_v2rayn_client() -> str:
    """确保本地已缓存官方 SelfContained 独立包 (通常体积在 100MB~160MB 左右，因内置完整 .NET 8 虚拟机)"""
    os.makedirs(CACHE_DIR, exist_ok=True)
    if os.path.exists(V2RAYN_CACHE_FILE) and os.path.getsize(V2RAYN_CACHE_FILE) > 40 * 1024 * 1024:
        return V2RAYN_CACHE_FILE

    tag, download_url = get_latest_v2rayn_selfcontained_url()
    tmp_download = os.path.join(CACHE_DIR, "v2rayn_selfcontained.tmp.zip")

    try:
        print(f"==> [v2rayN Pack] 正在从 GitHub 下载【SelfContained 自带运行时独立全集成包】({tag})...", flush=True)
        req = urllib.request.Request(download_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=180) as resp, open(tmp_download, 'wb') as out_f:
            shutil.copyfileobj(resp, out_f)

        if os.path.exists(tmp_download) and os.path.getsize(tmp_download) > 40 * 1024 * 1024:
            os.replace(tmp_download, V2RAYN_CACHE_FILE)
            print("==> [v2rayN Pack] 官方 SelfContained 独立全集成包已成功缓存至本地！", flush=True)
            return V2RAYN_CACHE_FILE
    except Exception as e:
        print(f"[v2rayN Pack Error] 独立包下载异常: {e}", flush=True)
        if os.path.exists(tmp_download):
            os.remove(tmp_download)

    if not os.path.exists(V2RAYN_CACHE_FILE):
        raise RuntimeError("无法从 GitHub 下载 v2rayN-windows-64-SelfContained.zip，请手动将此包上传放置于 /data/cache 目录下！")
    return V2RAYN_CACHE_FILE

def build_v2rayn_db_bytes(sub_url: str, username: str) -> bytes:
    """
    构建 guiDB.db：
    最高优先级：读取宿主机 /data/ 下用户已有的真实 guidb.db 母版，完全继承所有自定义黑名单和分流规则，仅更新订阅 URL；
    兜底方案：纯 Python 采用超集 Schema 构建，无缝对齐 v6/v7 全版本。
    """
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as tmp_db:
        tmp_db_path = tmp_db.name

    try:
        custom_db = find_custom_template(CUSTOM_GUIDB_CANDIDATES)

        # 策略 1：宿主机 /data/ 存在用户放置的真实配置文件母版 (完全零风险，百分百原汁原味)
        if custom_db:
            print(f"==> [v2rayN DB] 成功检测并优先挂载宿主机母版数据库: {custom_db}", flush=True)
            shutil.copyfile(custom_db, tmp_db_path)
            conn = sqlite3.connect(tmp_db_path)
            c = conn.cursor()
            try:
                # 覆写已有已启用的订阅记录
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
                print(f"[v2rayN DB Patch Warning] 母版数据库订阅覆写: {e}", flush=True)
            finally:
                conn.close()

        # 策略 2：本地 Python 动态超集 Schema 构建 (完全向下兼容上游)
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
    """
    构建 guiConfig.json：
    最高优先级：读取宿主机 /data/ 下已有的 guiconfig.json 母版，继承全部高级黑名单分流参数；
    兜底方案：自适应生成默认配置。
    """
    custom_json = find_custom_template(CUSTOM_GUICONFIG_CANDIDATES)

    if custom_json:
        try:
            print(f"==> [v2rayN Config] 成功检测并优先挂载宿主机母版 JSON: {custom_json}", flush=True)
            with open(custom_json, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            cfg["sysProxyType"] = 1  # 确保开启自动系统代理
            cfg["autoUpdateSub"] = True
            return json.dumps(cfg, indent=2, ensure_ascii=False)
        except Exception:
            pass

    # 兜底生成标准全局配置
    config = {
        "autoRun": False,
        "enableStatistics": False,
        "keepOlderDns": False,
        "autoUpdateSub": True,
        "sysProxyType": 1,         # 启动时自动开启 Windows 系统代理
        "routingMode": 1,          # 默认绕过大陆 / 黑名单路由模式
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

def generate_windows_package(user: dict, node: dict = None, chosen_sni: str = None) -> io.BytesIO:
    """打包专属于该用户的【v2rayN SelfContained 免环境独立便携包】"""
    base_zip_path = ensure_base_v2rayn_client()
    username = user.get("username", "user")
    uuid_str = user.get("uuid", "")

    # 获取用户专属订阅链接
    host_prefix = os.getenv("PANEL_URL", "").rstrip('/')
    if not host_prefix:
        host_prefix = "https://127.0.0.1:3000"
    sub_url = f"{host_prefix}/api/sub?token={uuid_str}"

    readme_txt = (
        "======================================================\r\n"
        f"      Xray Reality v2rayN 免环境独立客户端使用说明\r\n"
        f"      授权账号: {username}\r\n"
        "======================================================\r\n\r\n"
        "【本包为官方 SelfContained 独立包，免装任何运行库，解压即用】：\r\n"
        "1. 将本压缩包全部解压到电脑任意文件夹；\r\n"
        "2. 双击打开 [v2rayN.exe]；\r\n"
        "3. 点击顶部菜单 [订阅分组] -> [更新全部订阅(不通过代理)]；\r\n"
        "   所有高速节点将立即自动同步并呈现！\r\n\r\n"
        "【特性说明】：\r\n"
        "- 自包含运行环境：内置完整 .NET 运行时与 Xray 内核，绝无“缺少运行库”报错；\r\n"
        "- 预设订阅：已内置您的专属账号凭据，无需手动寻找和复制链接；\r\n"
        "- 自动代理：软件启动已预设自动配置 Windows 系统代理，开箱即用；\r\n"
        "- 智能分流：已预置绕过大陆/黑名单分流规则，国内网站秒开且不消耗流量；\r\n"
        "- 测速测延迟：全选节点按 Ctrl+R 可测试真连接延迟，双击即可切换线路。\r\n\r\n"
        "退出方法：在右下角任务栏小图标右键选择 [退出] 即可。\r\n"
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

        # 写入预设好的数据库与配置文件 (同时兼容 v6/v7 的 guiConfigs 目录与根目录)
        dst_zf.writestr("guiConfigs/guiDB.db", db_bytes)
        dst_zf.writestr("guiConfigs/guiConfig.json", config_json_str.encode('utf-8'))
        dst_zf.writestr("guiConfig.json", config_json_str.encode('utf-8'))
        dst_zf.writestr("使用说明.txt", readme_txt.encode('gbk'))

    mem_zip.seek(0)
    return mem_zip