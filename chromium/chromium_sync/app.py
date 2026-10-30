import os
import sys
import time
import json
import uuid
import random
import inspect
import secrets
import sqlite3
import logging
import asyncio
import subprocess
from typing import Optional, List, Dict
from datetime import datetime, timedelta

import bcrypt
import httpx
import websockets
import jwt
from sshtunnel import SSHTunnelForwarder
from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI, HTTPException, Depends, Header, UploadFile, File, Request
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# 日志规范化配置
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("CDP_Sync")

# 核心路径常量（固定在 /data 与 /certs）
DATA_DIR = "/data"
KEYS_DIR = os.path.join(DATA_DIR, "keys")
DB_PATH = os.path.join(DATA_DIR, "app.db")
CERTS_DIR = "/certs"
SSL_CERT_FILE = os.path.join(CERTS_DIR, "fullchain.pem")
SSL_KEY_FILE = os.path.join(CERTS_DIR, "privkey.pem")

os.makedirs(KEYS_DIR, exist_ok=True)
os.makedirs(CERTS_DIR, exist_ok=True)

INIT_PASSWORD = os.getenv("ADMIN_INIT_PASS", "Admin@123456")

# ==================== 1. 原生直接导入 ChromiumSync ====================
ChromiumSync = None
try:
    from chromium_sync import ChromiumSync
    logger.info("已成功加载并就绪 chromium_sync 核心模块！")
except Exception as e:
    logger.warning(f"未能引入外部 ChromiumSync ({e})，将启用内置原生 CDP WebSocket 引擎。")

# ==================== 2. 原生 bcrypt 安全密码处理 ====================
def hash_password(password: str) -> str:
    # 严格截断 72 字节，彻底杜绝 bcrypt 长度越界报错
    pwd_bytes = password.encode('utf-8')[:72]
    return bcrypt.hashpw(pwd_bytes, bcrypt.gensalt()).decode('utf-8')

def verify_password(password: str, hashed: str) -> bool:
    try:
        pwd_bytes = password.encode('utf-8')[:72]
        return bcrypt.checkpw(pwd_bytes, hashed.encode('utf-8'))
    except Exception:
        return False

# ==================== 3. SSL 证书自签与环境检测 ====================
def ensure_ssl_certificates():
    has_cert = os.path.exists(SSL_CERT_FILE) and os.path.getsize(SSL_CERT_FILE) > 0
    has_key = os.path.exists(SSL_KEY_FILE) and os.path.getsize(SSL_KEY_FILE) > 0

    if not (has_cert and has_key):
        logger.warning("未检测到有效挂载证书，正在自动生成自签名 SSL 证书 (10 年期)...")
        try:
            cmd = [
                "openssl", "req", "-x509", "-nodes", "-days", "3650",
                "-newkey", "rsa:2048",
                "-keyout", SSL_KEY_FILE,
                "-out", SSL_CERT_FILE,
                "-subj", "/C=CN/ST=Global/L=CDP/O=ChromiumSync/CN=localhost"
            ]
            subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            os.chmod(SSL_KEY_FILE, 0o600)
            logger.info("自签名 SSL 证书已成功就绪。")
        except Exception as e:
            logger.error(f"生成自签证书失败: {e}")
            raise RuntimeError("SSL 初始化异常")

# ==================== 4. 数据库初始化与热更新迁移 ====================
def init_db_and_jwt():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    # 节点清单表（包含 cookie_count）
    cur.execute('''CREATE TABLE IF NOT EXISTS nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        is_source INTEGER DEFAULT 0,
        ssh_host TEXT NOT NULL,
        ssh_port INTEGER DEFAULT 22,
        ssh_user TEXT NOT NULL,
        ssh_key_filename TEXT,
        ssh_password TEXT,
        remote_cdp_port INTEGER DEFAULT 9222,
        local_bind_port INTEGER UNIQUE NOT NULL,
        cookie_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'stopped',
        last_sync TEXT
    )''')

    # 为已存在的历史数据库平滑热迁移添加 cookie_count 列
    try:
        cur.execute("ALTER TABLE nodes ADD COLUMN cookie_count INTEGER DEFAULT 0")
    except Exception:
        pass

    cur.execute('''CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)''')
    cur.execute('''CREATE TABLE IF NOT EXISTS sync_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT,
        status TEXT,
        details TEXT
    )''')

    # 初始化管理员密码
    cur.execute("SELECT value FROM settings WHERE key='admin_password'")
    if not cur.fetchone():
        cur.execute("INSERT INTO settings (key, value) VALUES ('admin_password', ?)", (hash_password(INIT_PASSWORD),))

    # 自动生成 64 位 JWT 随机私钥并固化
    cur.execute("SELECT value FROM settings WHERE key='jwt_secret'")
    jwt_row = cur.fetchone()
    if jwt_row:
        secret = jwt_row[0]
    else:
        secret = secrets.token_hex(32)
        cur.execute("INSERT INTO settings (key, value) VALUES ('jwt_secret', ?)", (secret,))

    conn.commit()
    conn.close()
    return secret

JWT_SECRET = init_db_and_jwt()

# ==================== 5. SSH 隧道运行池管理 ====================
class TunnelManager:
    def __init__(self):
        self.tunnels: Dict[int, SSHTunnelForwarder] = {}

    def start_tunnel(self, node: dict):
        node_id = node['id']
        self.stop_tunnel(node_id)

        ssh_kwargs = {
            "ssh_address_or_host": (node['ssh_host'], int(node['ssh_port'])),
            "ssh_username": node['ssh_user'],
            "remote_bind_address": ('127.0.0.1', int(node['remote_cdp_port'])),
            "local_bind_address": ('0.0.0.0', int(node['local_bind_port'])),
            "set_keepalive": 30.0
        }

        if node.get('ssh_key_filename'):
            key_path = os.path.join(KEYS_DIR, node['ssh_key_filename'])
            if os.path.exists(key_path):
                ssh_kwargs["ssh_pkey"] = key_path
        elif node.get('ssh_password'):
            ssh_kwargs["ssh_password"] = node['ssh_password']

        try:
            tunnel = SSHTunnelForwarder(**ssh_kwargs)
            tunnel.start()
            self.tunnels[node_id] = tunnel
            self._update_node_status(node_id, "connected")
            logger.info(f"节点 [{node['name']}] SSH 穿透成功 -> 绑定端口 {node['local_bind_port']}")
            return True, "Connected"
        except Exception as e:
            self._update_node_status(node_id, f"error: {str(e)[:30]}")
            return False, str(e)

    def stop_tunnel(self, node_id: int):
        if node_id in self.tunnels:
            try:
                self.tunnels[node_id].stop()
            except Exception:
                pass
            del self.tunnels[node_id]
        self._update_node_status(node_id, "stopped")

    def _update_node_status(self, node_id: int, status: str):
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()
        cur.execute("UPDATE nodes SET status=? WHERE id=?", (status, node_id))
        conn.commit()
        conn.close()

tunnel_mgr = TunnelManager()

# ==================== 6. 原生 WebSocket CDP 引擎 (兼 Cookie 探测器) ====================
async def get_cdp_ws_url(local_port: int) -> str:
    url = f"http://127.0.0.1:{local_port}/json/version"
    async with httpx.AsyncClient(timeout=4.0) as client:
        res = await client.get(url)
        return res.json()["webSocketDebuggerUrl"]

async def fetch_cookies_native(local_port: int) -> List[dict]:
    ws_url = await get_cdp_ws_url(local_port)
    async with websockets.connect(ws_url) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Storage.getCookies"}))
        resp = await ws.recv()
        return json.loads(resp).get("result", {}).get("cookies", [])

async def inject_cookies_native(local_port: int, cookies: List[dict]):
    ws_url = await get_cdp_ws_url(local_port)
    async with websockets.connect(ws_url) as ws:
        await ws.send(json.dumps({"id": 2, "method": "Network.setCookies", "params": {"cookies": cookies}}))
        await ws.recv()

# ==================== 7. 同步任务调度核心 ====================
def sync_single_node_with_module(node: dict, default_source_port: int) -> str:
    """调用 ChromiumSync 模块执行穿透与智能同步"""
    remote_ssh = f"{node['ssh_user']}@{node['ssh_host']}"

    sig = inspect.signature(ChromiumSync.__init__)
    kwargs = {
        "remote_ssh": remote_ssh,
        "remote_ssh_port": int(node['ssh_port']),
        "local_cdp_port": default_source_port,
        "remote_cdp_port": int(node['remote_cdp_port']),
        "remote_tunnel_port": int(node['remote_cdp_port']),
        "direction": "auto",
        "timeout": 0
    }

    filtered_kwargs = {k: v for k, v in kwargs.items() if k in sig.parameters}

    if node.get('ssh_key_filename'):
        key_path = os.path.join(KEYS_DIR, node['ssh_key_filename'])
        for key_arg in ['ssh_key', 'key_file', 'key_filename', 'pkey', 'identity_file']:
            if key_arg in sig.parameters:
                filtered_kwargs[key_arg] = key_path
                break
        os.environ["GIT_SSH_COMMAND"] = f"ssh -i {key_path} -o StrictHostKeyChecking=no"

    syncer = ChromiumSync(**filtered_kwargs)
    syncer.run()
    return f"ChromiumSync 成功同步节点 [{node['name']}]"

async def execute_sync_task():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM nodes")
    nodes = [dict(row) for row in cur.fetchall()]
    conn.close()

    source = next((n for n in nodes if n["is_source"] == 1), None)
    if not source:
        logger.warning("未配置默认源节点 (Source)，跳过同步。")
        return

    targets = [n for n in nodes if n["is_source"] == 0]
    sync_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    log_detail = []

    try:
        if ChromiumSync is not None:
            # 模式 A：直接调度 ChromiumSync
            for target in targets:
                try:
                    res_msg = await asyncio.to_thread(sync_single_node_with_module, target, source["local_bind_port"])
                    log_detail.append(f"-> {res_msg}")
                except Exception as ex:
                    log_detail.append(f"-> 节点 [{target['name']}] 模块同步失败: {str(ex)}")
            status = "SUCCESS"
        else:
            # 模式 B：原生 CDP WebSocket 提取并批量下发
            cookies = await fetch_cookies_native(source["local_bind_port"])
            log_detail.append(f"原生模式：从源节点 [{source['name']}] 提取到 {len(cookies)} 个 Cookie")
            for target in targets:
                try:
                    await inject_cookies_native(target["local_bind_port"], cookies)
                    log_detail.append(f"-> 原生节点 [{target['name']}] 注入成功")
                except Exception as ex:
                    log_detail.append(f"-> 原生节点 [{target['name']}] 注入失败: {str(ex)}")
            status = "SUCCESS"

        # 同步完成后，探测源节点的当前最新 Cookie 总量并写入数据库
        try:
            curr_cookies = await fetch_cookies_native(source["local_bind_port"])
            cookie_count = len(curr_cookies)
        except Exception:
            cookie_count = 0

        # 回写 Cookie 数量统计
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()
        cur.execute("UPDATE nodes SET cookie_count=?, last_sync=? WHERE id=?", (cookie_count, sync_time, source['id']))
        for target in targets:
            cur.execute("UPDATE nodes SET cookie_count=?, last_sync=? WHERE id=?", (cookie_count, sync_time, target['id']))
        conn.commit()
        conn.close()

    except Exception as e:
        status = "FAILED"
        log_detail.append(f"同步执行中断: {str(e)}")

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("INSERT INTO sync_logs (timestamp, status, details) VALUES (?, ?, ?)",
                (sync_time, status, "\n".join(log_detail)))
    conn.commit()
    conn.close()

# ==================== 8. 防机器人人机验证与 Web API ====================
CAPTCHA_STORE = {}
LOGIN_ATTEMPTS = {}

def check_ip_rate_limit(ip: str):
    record = LOGIN_ATTEMPTS.get(ip, {"count": 0, "lock_until": 0})
    if time.time() < record["lock_until"]:
        raise HTTPException(status_code=429, detail="尝试次数过多，IP 已暂时锁定 15 分钟")

app = FastAPI(title="CDP Sync Control Hub (Obsidian HUD)")

def verify_token(authorization: Optional[str] = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="凭证无效")
    try:
        return jwt.decode(authorization.split(" ")[1], JWT_SECRET, algorithms=["HS256"])
    except Exception:
        raise HTTPException(status_code=401, detail="登录凭证失效")

@app.get("/api/captcha")
def get_captcha():
    a, b = random.randint(10, 50), random.randint(1, 9)
    token = str(uuid.uuid4())
    CAPTCHA_STORE[token] = {"ans": a + b, "exp": time.time() + 180}
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40" viewBox="0 0 120 40">
        <rect width="100%" height="100%" fill="#0f172a" rx="6"/>
        <line x1="5" y1="{random.randint(5,35)}" x2="115" y2="{random.randint(5,35)}" stroke="#334155" stroke-width="2"/>
        <text x="18" y="26" font-family="monospace" font-size="18" font-weight="bold" fill="#38bdf8">{a} + {b} = ?</text>
    </svg>'''
    return {"token": token, "svg": svg}

class LoginDTO(BaseModel):
    password: str
    captcha_token: str
    captcha_answer: str

@app.post("/api/login")
def login(data: LoginDTO, req: Request):
    ip = req.client.host
    check_ip_rate_limit(ip)

    cap = CAPTCHA_STORE.get(data.captcha_token)
    if not cap or time.time() > cap["exp"] or str(cap["ans"]) != data.captcha_answer.strip():
        LOGIN_ATTEMPTS[ip] = {"count": LOGIN_ATTEMPTS.get(ip, {}).get("count", 0) + 1, "lock_until": time.time() + 900 if LOGIN_ATTEMPTS.get(ip, {}).get("count", 0) >= 4 else 0}
        raise HTTPException(status_code=400, detail="验证码错误或已过期")

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("SELECT value FROM settings WHERE key='admin_password'")
    hashed = cur.fetchone()[0]
    conn.close()

    if not verify_password(data.password, hashed):
        LOGIN_ATTEMPTS[ip] = {"count": LOGIN_ATTEMPTS.get(ip, {}).get("count", 0) + 1, "lock_until": time.time() + 900 if LOGIN_ATTEMPTS.get(ip, {}).get("count", 0) >= 4 else 0}
        raise HTTPException(status_code=401, detail="密码不正确")

    LOGIN_ATTEMPTS.pop(ip, None)
    return {"token": jwt.encode({"sub": "admin", "exp": datetime.utcnow() + timedelta(days=7)}, JWT_SECRET, algorithm="HS256")}

@app.post("/api/change-password")
def change_password(data: dict, user: dict = Depends(verify_token)):
    new_pass = data.get("new_password")
    if not new_pass or len(new_pass) < 6:
        raise HTTPException(status_code=400, detail="密码长度必须至少6位")
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("UPDATE settings SET value=? WHERE key='admin_password'", (hash_password(new_pass),))
    conn.commit()
    conn.close()
    return {"message": "密码修改成功"}

@app.get("/api/nodes")
def list_nodes(user: dict = Depends(verify_token)):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM nodes")
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows

@app.post("/api/nodes")
def create_node(data: dict, user: dict = Depends(verify_token)):
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute('''INSERT INTO nodes (name, is_source, ssh_host, ssh_port, ssh_user, ssh_key_filename, ssh_password, remote_cdp_port, local_bind_port, cookie_count)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)''',
                (data['name'], 1 if data.get('is_source') else 0, data['ssh_host'], data.get('ssh_port', 22),
                 data['ssh_user'], data.get('ssh_key_filename'), data.get('ssh_password'),
                 data.get('remote_cdp_port', 9222), data['local_bind_port']))
    conn.commit()
    conn.close()
    return {"message": "节点添加成功"}

@app.delete("/api/nodes/{node_id}")
def delete_node(node_id: int, user: dict = Depends(verify_token)):
    tunnel_mgr.stop_tunnel(node_id)
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("DELETE FROM nodes WHERE id=?", (node_id,))
    conn.commit()
    conn.close()
    return {"message": "节点已删除"}

@app.post("/api/nodes/{node_id}/toggle-tunnel")
def toggle_tunnel(node_id: int, user: dict = Depends(verify_token)):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM nodes WHERE id=?", (node_id,))
    node = dict(cur.fetchone())
    conn.close()

    if node_id in tunnel_mgr.tunnels:
        tunnel_mgr.stop_tunnel(node_id)
        return {"status": "stopped"}
    else:
        ok, msg = tunnel_mgr.start_tunnel(node)
        if not ok:
            raise HTTPException(status_code=500, detail=msg)
        return {"status": "connected"}

@app.post("/api/nodes/{node_id}/set-source")
def set_source(node_id: int, user: dict = Depends(verify_token)):
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("UPDATE nodes SET is_source = 0")
    cur.execute("UPDATE nodes SET is_source = 1 WHERE id=?", (node_id,))
    conn.commit()
    conn.close()
    return {"message": "已设置为默认源节点"}

@app.get("/api/ssh-keys")
def list_keys(user: dict = Depends(verify_token)):
    return [{"filename": f, "size": os.path.getsize(os.path.join(KEYS_DIR, f))} for f in os.listdir(KEYS_DIR)]

@app.post("/api/ssh-keys")
async def upload_key(file: UploadFile = File(...), user: dict = Depends(verify_token)):
    path = os.path.join(KEYS_DIR, file.filename)
    content = await file.read()
    with open(path, "wb") as f:
        f.write(content)
    os.chmod(path, 0o600)
    return {"message": f"证书 {file.filename} 上传完成"}

@app.delete("/api/ssh-keys/{filename}")
def delete_key(filename: str, user: dict = Depends(verify_token)):
    p = os.path.join(KEYS_DIR, filename)
    if os.path.exists(p):
        os.remove(p)
    return {"message": "证书已删除"}

@app.post("/api/sync/trigger")
async def trigger_sync(user: dict = Depends(verify_token)):
    await execute_sync_task()
    return {"message": "同步任务执行完毕"}

@app.get("/api/sync/logs")
def get_logs(user: dict = Depends(verify_token)):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM sync_logs ORDER BY id DESC LIMIT 50")
    logs = [dict(r) for r in cur.fetchall()]
    conn.close()
    return logs

# 调度器：每 15 分钟触发一次自动同步
scheduler = BackgroundScheduler()
scheduler.add_job(lambda: asyncio.run(execute_sync_task()), 'interval', minutes=15)
scheduler.start()

# 静态托管由 Vite 编译生成的 dist 产物
if os.path.exists("dist"):
    app.mount("/assets", StaticFiles(directory="dist/assets"), name="assets")
    @app.get("/{full_path:path}")
    def serve_spa(full_path: str):
        return FileResponse("dist/index.html")

# ==================== 9. 服务启动入口 ====================
if __name__ == "__main__":
    ensure_ssl_certificates()
    import uvicorn
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8443,
        ssl_certfile=SSL_CERT_FILE,
        ssl_keyfile=SSL_KEY_FILE
    )