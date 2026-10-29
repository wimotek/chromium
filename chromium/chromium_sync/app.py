import os
import time
import json
import uuid
import random
import secrets
import sqlite3
import logging
import asyncio
from typing import Optional, List, Dict
from datetime import datetime, timedelta

import httpx
import websockets
import jwt
from passlib.hash import bcrypt
from sshtunnel import SSHTunnelForwarder
from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI, HTTPException, Depends, Header, UploadFile, File, Request
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("CDP_Sync")

# 根目录与证书存储路径
DATA_DIR = "/data"
KEYS_DIR = os.path.join(DATA_DIR, "keys")
DB_PATH = os.path.join(DATA_DIR, "app.db")
os.makedirs(KEYS_DIR, exist_ok=True)

INIT_PASSWORD = os.getenv("ADMIN_INIT_PASS", "Admin@123456")

# 引入 chromium_sync_module 模块
MODULE_AVAILABLE = False
try:
    from chromium_sync_module import sync_cdp_cookies
    MODULE_AVAILABLE = True
    logger.info("成功加载本地 chromium_sync_module 模块！")
except Exception:
    logger.warning("未检测到外部 chromium_sync_module，将启用内置原生 CDP Cookie 同步引擎。")

# 数据库与 JWT 秘钥初始化
def init_db_and_jwt():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    # 节点表
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
        status TEXT DEFAULT 'stopped',
        last_sync TEXT
    )''')
    cur.execute('''CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)''')
    cur.execute('''CREATE TABLE IF NOT EXISTS sync_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT,
        status TEXT,
        details TEXT
    )''')
    
    # 初始化密码
    cur.execute("SELECT value FROM settings WHERE key='admin_password'")
    if not cur.fetchone():
        hashed = bcrypt.hash(INIT_PASSWORD)
        cur.execute("INSERT INTO settings (key, value) VALUES ('admin_password', ?)", (hashed,))
    
    # 自动生成 64 位 JWT 签名秘钥并持久化
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

# SSH 隧道管理器
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
        
        # 区分并挂载证书
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
            logger.info(f"节点 [{node['name']}] SSH 映射成功 -> 本地端口 {node['local_bind_port']}")
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

# 原生 CDP Cookie 交互
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

# 同步执行主流程
async def execute_sync_task():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM nodes")
    nodes = [dict(row) for row in cur.fetchall()]
    conn.close()

    source = next((n for n in nodes if n["is_source"] == 1), None)
    if not source:
        logger.warning("未设定源节点 (Source)，跳过同步。")
        return

    targets = [n for n in nodes if n["is_source"] == 0]
    sync_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    log_detail = []

    try:
        if MODULE_AVAILABLE:
            cookies = sync_cdp_cookies.extract(source["local_bind_port"])
        else:
            cookies = await fetch_cookies_native(source["local_bind_port"])

        log_detail.append(f"从源节点 [{source['name']}] 捕获到 {len(cookies)} 个 Cookie")

        for target in targets:
            try:
                if MODULE_AVAILABLE:
                    sync_cdp_cookies.inject(target["local_bind_port"], cookies)
                else:
                    await inject_cookies_native(target["local_bind_port"], cookies)
                log_detail.append(f"-> 节点 [{target['name']}] 写入成功")
            except Exception as ex:
                log_detail.append(f"-> 节点 [{target['name']}] 失败: {str(ex)}")
        status = "SUCCESS"
    except Exception as e:
        status = "FAILED"
        log_detail.append(f"源节点读取中断: {str(e)}")

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("INSERT INTO sync_logs (timestamp, status, details) VALUES (?, ?, ?)",
                (sync_time, status, "\n".join(log_detail)))
    cur.execute("UPDATE nodes SET last_sync=? WHERE id=?", (sync_time, source['id']))
    conn.commit()
    conn.close()

# 验证码与 IP 爆破防护
CAPTCHA_STORE = {}
LOGIN_ATTEMPTS = {}

def check_ip_rate_limit(ip: str):
    record = LOGIN_ATTEMPTS.get(ip, {"count": 0, "lock_until": 0})
    if time.time() < record["lock_until"]:
        raise HTTPException(status_code=429, detail="尝试次数过多，IP 已暂时锁定 15 分钟")

app = FastAPI(title="CDP Sync System")

def verify_token(authorization: Optional[str] = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="凭证无效")
    try:
        return jwt.decode(authorization.split(" ")[1], JWT_SECRET, algorithms=["HS256"])
    except Exception:
        raise HTTPException(status_code=401, detail="登录已过期")

@app.get("/api/captcha")
def get_captcha():
    a, b = random.randint(10, 50), random.randint(1, 9)
    token = str(uuid.uuid4())
    CAPTCHA_STORE[token] = {"ans": a + b, "exp": time.time() + 180}
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40" viewBox="0 0 120 40">
        <rect width="100%" height="100%" fill="#1e293b" rx="6"/>
        <line x1="5" y1="{random.randint(5,35)}" x2="115" y2="{random.randint(5,35)}" stroke="#475569" stroke-width="2"/>
        <text x="18" y="26" font-family="Arial" font-size="18" font-weight="bold" fill="#38bdf8">{a} + {b} = ?</text>
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

    if not bcrypt.verify(data.password, hashed):
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
    cur.execute("UPDATE settings SET value=? WHERE key='admin_password'", (bcrypt.hash(new_pass),))
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
    cur.execute('''INSERT INTO nodes (name, is_source, ssh_host, ssh_port, ssh_user, ssh_key_filename, ssh_password, remote_cdp_port, local_bind_port)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)''',
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
    os.chmod(path, 0o600)  # SSH 严格要求 600 私钥权限
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
    return {"message": "手动同步任务完成"}

@app.get("/api/sync/logs")
def get_logs(user: dict = Depends(verify_token)):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM sync_logs ORDER BY id DESC LIMIT 50")
    logs = [dict(r) for r in cur.fetchall()]
    conn.close()
    return logs

# 启动 15 分钟间隔定时调度器
scheduler = BackgroundScheduler()
scheduler.add_job(lambda: asyncio.run(execute_sync_task()), 'interval', minutes=15)
scheduler.start()

# 静态托管由 Vite 打包编译生成的 dist 产物
if os.path.exists("dist"):
    app.mount("/assets", StaticFiles(directory="dist/assets"), name="assets")
    @app.get("/{full_path:path}")
    def serve_spa(full_path: str):
        return FileResponse("dist/index.html")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)