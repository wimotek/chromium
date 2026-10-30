import os
import sys
import time
import json
import uuid
import random
import inspect
import secrets
import sqlite3
import smtplib
import logging
import asyncio
import subprocess
import ipaddress
from datetime import datetime, timedelta, timezone
from email.mime.text import MIMEText
from email.header import Header
from urllib.parse import urlparse, urlunparse
from typing import Optional, List, Dict

from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
import bcrypt
import httpx
import websockets
import jwt
from sshtunnel import SSHTunnelForwarder
from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI, HTTPException, Depends, Header as ReqHeader, UploadFile, File, Request
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# 日志输出配置
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
    logger.info("已成功载入 chromium_sync 核心模块！")
except Exception as e:
    logger.warning(f"外部 ChromiumSync 模块未激活 ({e})，启用内置 WebSocket 探测引擎。")

# ==================== 2. 原生 bcrypt 安全密码处理 ====================
def hash_password(password: str) -> str:
    pwd_bytes = password.encode('utf-8')[:72]
    return bcrypt.hashpw(pwd_bytes, bcrypt.gensalt()).decode('utf-8')

def verify_password(password: str, hashed: str) -> bool:
    try:
        pwd_bytes = password.encode('utf-8')[:72]
        return bcrypt.checkpw(pwd_bytes, hashed.encode('utf-8'))
    except Exception:
        return False

# ==================== 3. 纯 Python 原生生成 10 年期自签 SSL 证书 ====================
def generate_self_signed_cert(cert_file: str, key_file: str):
    """使用 cryptography 纯内存生成，带标准 SAN 扩展，不依赖任何命令行"""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, "CN"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "ChromiumSync"),
        x509.NameAttribute(NameOID.COMMON_NAME, "localhost"),
    ])
    now = datetime.now(timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + timedelta(days=3650))
        .add_extension(
            x509.SubjectAlternativeName([
                x509.DNSName("localhost"),
                x509.IPAddress(ipaddress.IPv4Address("127.0.0.1")),
                x509.IPAddress(ipaddress.IPv6Address("::1")),
            ]),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )

    with open(key_file, "wb") as f:
        f.write(key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        ))
    os.chmod(key_file, 0o600)

    with open(cert_file, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))

def ensure_ssl_certificates():
    global SSL_CERT_FILE, SSL_KEY_FILE

    has_cert = os.path.exists(SSL_CERT_FILE) and os.path.getsize(SSL_CERT_FILE) > 0
    has_key = os.path.exists(SSL_KEY_FILE) and os.path.getsize(SSL_KEY_FILE) > 0

    if not (has_cert and has_key):
        logger.warning("未检测到有效证书，正在通过原生引擎生成 10 年期自签名 SSL 证书...")
        try:
            os.makedirs(CERTS_DIR, exist_ok=True)
            generate_self_signed_cert(SSL_CERT_FILE, SSL_KEY_FILE)
            logger.info(f"自签名证书已成功保存至: {CERTS_DIR}")
        except Exception as e:
            logger.warning(f"目录 {CERTS_DIR} 写入受限 ({e})，正在自动容灾写入 /data/certs ...")
            fallback_dir = os.path.join(DATA_DIR, "certs")
            os.makedirs(fallback_dir, exist_ok=True)
            SSL_CERT_FILE = os.path.join(fallback_dir, "fullchain.pem")
            SSL_KEY_FILE = os.path.join(fallback_dir, "privkey.pem")
            generate_self_signed_cert(SSL_CERT_FILE, SSL_KEY_FILE)
            logger.info(f"自签名证书已成功降级生成于: {fallback_dir}")
    else:
        logger.info(f"已成功加载已有证书: {SSL_CERT_FILE}")

# ==================== 4. 数据库与通知设置初始化 ====================
def init_db_and_jwt():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
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

    defaults = {
        'admin_username': 'admin',
        'admin_email': 'admin@wimotek.com',
        'admin_password': hash_password(INIT_PASSWORD),
        'jwt_secret': secrets.token_hex(32),
        'smtp_host': '',
        'smtp_port': '465',
        'smtp_ssl': '1',
        'smtp_user': '',
        'smtp_pass': '',
        'smtp_to': '',
        'serverchan_key': '',
        'serverchan_enabled': '0'
    }

    for k, v in defaults.items():
        cur.execute("SELECT value FROM settings WHERE key=?", (k,))
        if not cur.fetchone():
            cur.execute("INSERT INTO settings (key, value) VALUES (?, ?)", (k, v))

    conn.commit()
    conn.close()

init_db_and_jwt()

def get_setting(key: str, default: str = "") -> str:
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("SELECT value FROM settings WHERE key=?", (key,))
    row = cur.fetchone()
    conn.close()
    return row[0] if row else default

def set_setting(key: str, value: str):
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, str(value)))
    conn.commit()
    conn.close()

JWT_SECRET = get_setting('jwt_secret')

# ==================== 5. 通知渠道服务 (Email SMTP & Server酱) ====================
def send_email_notification(title: str, content: str) -> bool:
    host = get_setting('smtp_host')
    port = int(get_setting('smtp_port') or '465')
    use_ssl = get_setting('smtp_ssl') == '1'
    user = get_setting('smtp_user')
    password = get_setting('smtp_pass')
    to_email = get_setting('smtp_to') or get_setting('admin_email')

    if not (host and user and password and to_email):
        return False

    try:
        msg = MIMEText(content, 'plain', 'utf-8')
        msg['From'] = Header(f"CDP-Sync Manager <{user}>", 'utf-8')
        msg['To'] = Header(to_email, 'utf-8')
        msg['Subject'] = Header(f"[CDP通知] {title}", 'utf-8')

        if use_ssl:
            server = smtplib.SMTP_SSL(host, port, timeout=10)
        else:
            server = smtplib.SMTP(host, port, timeout=10)
            server.starttls()

        server.login(user, password)
        server.sendmail(user, [to_email], msg.as_string())
        server.quit()
        return True
    except Exception as e:
        logger.error(f"邮件通知发送失败: {e}")
        return False

async def send_serverchan_notification(title: str, content: str) -> bool:
    key = get_setting('serverchan_key')
    enabled = get_setting('serverchan_enabled') == '1'
    if not (enabled and key):
        return False

    url = f"https://sctapi.ftqq.com/{key}.send"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.post(url, data={"title": title, "desp": content})
            return res.status_code == 200
    except Exception as e:
        logger.error(f"Server酱推送失败: {e}")
        return False

async def dispatch_notification(title: str, content: str):
    send_email_notification(title, content)
    await send_serverchan_notification(title, content)

# ==================== 6. CDP 端口重写与实时 Cookie 探针 ====================
async def get_cdp_ws_url(local_port: int) -> str:
    url = f"http://127.0.0.1:{local_port}/json/version"
    async with httpx.AsyncClient(timeout=4.0) as client:
        res = await client.get(url)
        raw_ws = res.json()["webSocketDebuggerUrl"]
        # 核心修复：远程机器返回的 9222 需强制替换为本地映射端口 local_port
        parsed = urlparse(raw_ws)
        corrected_ws = urlunparse(parsed._replace(netloc=f"127.0.0.1:{local_port}"))
        return corrected_ws

async def probe_node_cookies(local_port: int) -> int:
    """实时探针：探测指定本地映射端口节点上的实际 Cookie 数量"""
    try:
        ws_url = await get_cdp_ws_url(local_port)
        async with websockets.connect(ws_url, timeout=5.0) as ws:
            await ws.send(json.dumps({"id": 1, "method": "Storage.getCookies"}))
            resp = await asyncio.wait_for(ws.recv(), timeout=5.0)
            data = json.loads(resp)
            cookies = data.get("result", {}).get("cookies", [])
            return len(cookies)
    except Exception as e:
        logger.warning(f"探测本地端口 {local_port} Cookie 失败: {e}")
        return 0

# ==================== 7. SSH 隧道管理 (联动 Cookie 自动嗅探) ====================
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
            logger.info(f"节点 [{node['name']}] SSH 穿透成功 -> 本地端口 {node['local_bind_port']}")

            # 隧道建立后，延迟 1.5 秒自动进行一次 Cookie 探针嗅探
            asyncio.create_task(self._auto_probe(node))
            return True, "Connected"
        except Exception as e:
            self._update_node_status(node_id, f"error: {str(e)[:30]}")
            return False, str(e)

    async def _auto_probe(self, node: dict):
        await asyncio.sleep(1.5)
        count = await probe_node_cookies(node['local_bind_port'])
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()
        cur.execute("UPDATE nodes SET cookie_count=? WHERE id=?", (count, node['id']))
        conn.commit()
        conn.close()

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

# ==================== 8. 同步调度主任务 ====================
async def execute_sync_task():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM nodes")
    nodes = [dict(row) for row in cur.fetchall()]
    conn.close()

    source = next((n for n in nodes if n["is_source"] == 1), None)
    if not source:
        return

    targets = [n for n in nodes if n["is_source"] == 0]
    sync_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    log_detail = []

    try:
        source_count = await probe_node_cookies(source['local_bind_port'])
        log_detail.append(f"源节点 [{source['name']}] 捕获到 {source_count} 个 Cookies")

        if ChromiumSync is not None:
            for target in targets:
                try:
                    remote_ssh = f"{target['ssh_user']}@{target['ssh_host']}"
                    syncer = ChromiumSync(
                        remote_ssh=remote_ssh,
                        remote_ssh_port=int(target['ssh_port']),
                        local_cdp_port=source['local_bind_port'],
                        remote_cdp_port=int(target['remote_cdp_port']),
                        remote_tunnel_port=int(target['remote_cdp_port']),
                        direction="auto",
                        timeout=0
                    )
                    await asyncio.to_thread(syncer.run)
                    target_count = await probe_node_cookies(target['local_bind_port'])
                    log_detail.append(f"-> 节点 [{target['name']}] 同步完成，当前 Cookie: {target_count}")
                except Exception as ex:
                    log_detail.append(f"-> 节点 [{target['name']}] 同步异常: {str(ex)}")
        status = "SUCCESS"
    except Exception as e:
        status = "FAILED"
        log_detail.append(f"同步流程中断: {str(e)}")

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("INSERT INTO sync_logs (timestamp, status, details) VALUES (?, ?, ?)",
                (sync_time, status, "\n".join(log_detail)))
    cur.execute("UPDATE nodes SET last_sync=? WHERE id=?", (sync_time, source['id']))
    conn.commit()
    conn.close()

    if status == "FAILED":
        await dispatch_notification("Cookie 同步失败预警", f"时间: {sync_time}\n详情:\n" + "\n".join(log_detail))

# ==================== 9. API 路由与鉴权 ====================
CAPTCHA_STORE = {}
LOGIN_ATTEMPTS = {}
app = FastAPI(title="CDP Hub Manager")

def verify_token(authorization: Optional[str] = ReqHeader(None)):
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
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="120" height="38" viewBox="0 0 120 38">
        <rect width="100%" height="100%" fill="#1f2937" rx="6"/>
        <text x="20" y="25" font-family="system-ui" font-size="17" font-weight="bold" fill="#60a5fa">{a} + {b} = ?</text>
    </svg>'''
    return {"token": token, "svg": svg}

class LoginDTO(BaseModel):
    account: str
    password: str
    captcha_token: str
    captcha_answer: str

@app.post("/api/login")
def login(data: LoginDTO, req: Request):
    ip = req.client.host
    cap = CAPTCHA_STORE.get(data.captcha_token)
    if not cap or time.time() > cap["exp"] or str(cap["ans"]) != data.captcha_answer.strip():
        raise HTTPException(status_code=400, detail="验证码错误或已失效")

    admin_user = get_setting('admin_username', 'admin')
    admin_email = get_setting('admin_email', 'admin@wimotek.com')
    hashed_pwd = get_setting('admin_password')

    input_acc = data.account.strip().lower()
    if input_acc != admin_user.lower() and input_acc != admin_email.lower():
        raise HTTPException(status_code=401, detail="账号或密码错误")

    if not verify_password(data.password, hashed_pwd):
        raise HTTPException(status_code=401, detail="账号或密码错误")

    return {"token": jwt.encode({"sub": admin_user, "exp": datetime.utcnow() + timedelta(days=7)}, JWT_SECRET, algorithm="HS256")}

@app.get("/api/profile")
def get_profile(user: dict = Depends(verify_token)):
    return {
        "username": get_setting("admin_username"),
        "email": get_setting("admin_email")
    }

@app.post("/api/profile")
def update_profile(data: dict, user: dict = Depends(verify_token)):
    if data.get("username"):
        set_setting("admin_username", data["username"].strip())
    if data.get("email"):
        set_setting("admin_email", data["email"].strip())
    if data.get("new_password"):
        set_setting("admin_password", hash_password(data["new_password"]))
    return {"message": "个人安全设置已更新"}

@app.get("/api/notifications/settings")
def get_notification_settings(user: dict = Depends(verify_token)):
    return {
        "smtp_host": get_setting("smtp_host"),
        "smtp_port": get_setting("smtp_port", "465"),
        "smtp_ssl": get_setting("smtp_ssl", "1") == "1",
        "smtp_user": get_setting("smtp_user"),
        "smtp_pass": get_setting("smtp_pass"),
        "smtp_to": get_setting("smtp_to"),
        "serverchan_key": get_setting("serverchan_key"),
        "serverchan_enabled": get_setting("serverchan_enabled", "0") == "1"
    }

@app.post("/api/notifications/settings")
def save_notification_settings(data: dict, user: dict = Depends(verify_token)):
    for k in ["smtp_host", "smtp_port", "smtp_user", "smtp_pass", "smtp_to", "serverchan_key"]:
        if k in data:
            set_setting(k, data[k])
    if "smtp_ssl" in data:
        set_setting("smtp_ssl", "1" if data["smtp_ssl"] else "0")
    if "serverchan_enabled" in data:
        set_setting("serverchan_enabled", "1" if data["serverchan_enabled"] else "0")
    return {"message": "通知设置已保存"}

@app.post("/api/notifications/test-email")
def test_email(user: dict = Depends(verify_token)):
    ok = send_email_notification("测试邮件", "这是一封来自 CDP Sync 系统的测试通知邮件，表明 SMTP 发信功能配置正常。")
    if not ok:
        raise HTTPException(status_code=500, detail="邮件发送失败，请检查 SMTP 配置及密码授权码")
    return {"message": "测试邮件已成功发出，请检查收件箱"}

@app.post("/api/notifications/test-serverchan")
async def test_serverchan(user: dict = Depends(verify_token)):
    ok = await send_serverchan_notification("CDP 测试推送", "Server酱微信通道通讯正常。")
    if not ok:
        raise HTTPException(status_code=500, detail="Server酱推送失败，请检查 SendKey 是否填写无误")
    return {"message": "Server酱微信推送触发成功"}

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
    return {"message": "节点配置已写入"}

@app.delete("/api/nodes/{node_id}")
def delete_node(node_id: int, user: dict = Depends(verify_token)):
    tunnel_mgr.stop_tunnel(node_id)
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("DELETE FROM nodes WHERE id=?", (node_id,))
    conn.commit()
    conn.close()
    return {"message": "节点已删除"}

@app.post("/api/nodes/{node_id}/probe")
async def probe_node(node_id: int, user: dict = Depends(verify_token)):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM nodes WHERE id=?", (node_id,))
    node = dict(cur.fetchone())
    conn.close()

    count = await probe_node_cookies(node['local_bind_port'])
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("UPDATE nodes SET cookie_count=? WHERE id=?", (count, node_id))
    conn.commit()
    conn.close()
    return {"cookie_count": count}

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
    return {"message": "源节点已设定"}

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
    return {"message": f"私钥 {file.filename} 上传完成"}

@app.delete("/api/ssh-keys/{filename}")
def delete_key(filename: str, user: dict = Depends(verify_token)):
    p = os.path.join(KEYS_DIR, filename)
    if os.path.exists(p):
        os.remove(p)
    return {"message": "私钥已销毁"}

@app.post("/api/sync/trigger")
async def trigger_sync(user: dict = Depends(verify_token)):
    await execute_sync_task()
    return {"message": "同步指令下发完成"}

@app.get("/api/sync/logs")
def get_logs(user: dict = Depends(verify_token)):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM sync_logs ORDER BY id DESC LIMIT 50")
    logs = [dict(r) for r in cur.fetchall()]
    conn.close()
    return logs

scheduler = BackgroundScheduler()
scheduler.add_job(lambda: asyncio.run(execute_sync_task()), 'interval', minutes=15)
scheduler.start()

if os.path.exists("dist"):
    app.mount("/assets", StaticFiles(directory="dist/assets"), name="assets")
    @app.get("/{full_path:path}")
    def serve_spa(full_path: str):
        return FileResponse("dist/index.html")

# ==================== 10. 服务入口 ====================
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