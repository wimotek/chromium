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
import warnings
from datetime import datetime, timedelta, timezone
from email.mime.text import MIMEText
from email.header import Header
from urllib.parse import urlparse, urlunparse
from typing import Optional, List, Dict

# 消除 Paramiko 与 Cryptography 的 TripleDES 废弃警告日志
from cryptography.utils import CryptographyDeprecationWarning
warnings.filterwarnings("ignore", category=CryptographyDeprecationWarning)
warnings.filterwarnings("ignore", module="paramiko")

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
from fastapi import FastAPI, HTTPException, Depends, Header as ReqHeader, UploadFile, File, Request, Query, Security
from fastapi.security.api_key import APIKeyHeader, APIKeyQuery
from fastapi.responses import JSONResponse, FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("CDP_Sync")

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))

# 智能探测前端编译产物 dist 真实路径
CANDIDATE_DIST_DIRS = [
    os.path.abspath(os.path.join(CURRENT_DIR, "../frontend/dist")),
    os.path.abspath(os.path.join(CURRENT_DIR, "frontend/dist")),
    os.path.abspath(os.path.join(CURRENT_DIR, "dist")),
    "/app/frontend/dist",
    "/app/dist"
]

DIST_DIR = None
for candidate in CANDIDATE_DIST_DIRS:
    if os.path.exists(candidate) and os.path.exists(os.path.join(candidate, "index.html")):
        DIST_DIR = candidate
        logger.info(f"✅ 成功定位前端静态资源目录: {DIST_DIR}")
        break

if not DIST_DIR:
    logger.warning(f"⚠️ 未检测到前端 dist 编译产物，已检索路径: {CANDIDATE_DIST_DIRS}")

DATA_DIR = "/data"
KEYS_DIR = os.path.join(DATA_DIR, "keys")
DB_PATH = os.path.join(DATA_DIR, "app.db")
CERTS_DIR = "/certs"
SSL_CERT_FILE = os.path.join(CERTS_DIR, "fullchain.pem")
SSL_KEY_FILE = os.path.join(CERTS_DIR, "privkey.pem")

os.makedirs(KEYS_DIR, exist_ok=True)
os.makedirs(CERTS_DIR, exist_ok=True)

INIT_PASSWORD = os.getenv("ADMIN_INIT_PASS", "Admin@123456")

# 引入 ChromiumSync 模块
ChromiumSync = None
try:
    from chromium_sync import ChromiumSync
    logger.info("已成功加载外部 ChromiumSync 模块！")
except Exception as e:
    logger.warning(f"外部 ChromiumSync 模块未激活 ({e})，启用内置 WebSocket 探测引擎。")

def hash_password(password: str) -> str:
    pwd_bytes = password.encode('utf-8')[:72]
    return bcrypt.hashpw(pwd_bytes, bcrypt.gensalt()).decode('utf-8')

def verify_password(password: str, hashed: str) -> bool:
    try:
        pwd_bytes = password.encode('utf-8')[:72]
        return bcrypt.checkpw(pwd_bytes, hashed.encode('utf-8'))
    except Exception:
        return False

# ==================== 1. SSL 证书原生纯内存生成 ====================
def generate_self_signed_cert(cert_file: str, key_file: str):
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
        logger.warning("未检测到有效证书，正在通过原生引擎生成自签 SSL 证书...")
        try:
            os.makedirs(CERTS_DIR, exist_ok=True)
            generate_self_signed_cert(SSL_CERT_FILE, SSL_KEY_FILE)
            logger.info(f"自签名证书已保存至: {CERTS_DIR}")
        except Exception as e:
            logger.warning(f"目录 {CERTS_DIR} 写入受限 ({e})，正在自动容灾写入 /data/certs ...")
            fallback_dir = os.path.join(DATA_DIR, "certs")
            os.makedirs(fallback_dir, exist_ok=True)
            SSL_CERT_FILE = os.path.join(fallback_dir, "fullchain.pem")
            SSL_KEY_FILE = os.path.join(fallback_dir, "privkey.pem")
            generate_self_signed_cert(SSL_CERT_FILE, SSL_KEY_FILE)
            logger.info(f"自签名证书已成功降级生成于: {fallback_dir}")

# ==================== 2. 数据库与通知初始化 ====================
def init_db_and_jwt():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute('''CREATE TABLE IF NOT EXISTS nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        is_source INTEGER DEFAULT 0,
        is_local INTEGER DEFAULT 0,
        ssh_host TEXT DEFAULT '',
        ssh_port INTEGER DEFAULT 22,
        ssh_user TEXT DEFAULT '',
        ssh_key_filename TEXT DEFAULT '',
        ssh_password TEXT DEFAULT '',
        remote_cdp_port INTEGER DEFAULT 9222,
        local_bind_port INTEGER NOT NULL,
        cookie_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'stopped',
        last_sync TEXT
    )''')

    for col, col_type in [("is_local", "INTEGER DEFAULT 0"), ("cookie_count", "INTEGER DEFAULT 0")]:
        try:
            cur.execute(f"ALTER TABLE nodes ADD COLUMN {col} {col_type}")
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
        'admin_password': hash_password(INIT_PASSWORD),
        'jwt_secret': secrets.token_hex(32),
        'api_key': 'cdp_' + secrets.token_urlsafe(24),
        'smtp_host': 'smtp.yeah.net',
        'smtp_port': '465',
        'smtp_ssl': '1',
        'smtp_sender_name': 'CDP 节点中心',
        'smtp_user': '',
        'smtp_pass': '',
        'smtp_status': 'untested',
        'serverchan_enabled': '0',
        'serverchan_key': ''
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

# ==================== 3. 增强型 SMTP 发信与 Server酱通知 ====================
def send_email_notification(title: str, content: str, override_to: Optional[str] = None) -> tuple[bool, str]:
    host = get_setting('smtp_host')
    port = int(get_setting('smtp_port') or '465')
    use_ssl = get_setting('smtp_ssl') == '1'
    user = get_setting('smtp_user')
    password = get_setting('smtp_pass')
    sender_name = get_setting('smtp_sender_name', 'CDP 节点中心')
    to_email = override_to if override_to else user

    if not (host and user and password and to_email):
        return False, "SMTP 配置不完整 (缺少主机、发件账号或密码)"

    try:
        msg = MIMEText(content, 'plain', 'utf-8')
        msg['From'] = Header(f"{sender_name} <{user}>", 'utf-8')
        msg['To'] = Header(to_email, 'utf-8')
        msg['Subject'] = Header(f"[CDP 集群告警] {title}", 'utf-8')

        if use_ssl:
            server = smtplib.SMTP_SSL(host, port, timeout=10)
        else:
            server = smtplib.SMTP(host, port, timeout=10)
            server.starttls()

        server.login(user, password)
        server.sendmail(user, [to_email], msg.as_string())
        server.quit()
        return True, "发信正常"
    except Exception as e:
        err_msg = str(e)
        logger.error(f"邮件发送失败: {err_msg}")
        return False, err_msg

async def send_serverchan_notification(title: str, content: str) -> bool:
    if get_setting('serverchan_enabled', '0') != '1':
        return False

    key = get_setting('serverchan_key')
    if not key:
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

# ==================== 4. CDP 探测引擎 ====================
async def resolve_cdp_endpoint(local_port: int) -> tuple[str, str]:
    candidate_hosts = ["127.0.0.1", "host.docker.internal", "172.17.0.1"]
    async with httpx.AsyncClient(timeout=2.0) as client:
        for host in candidate_hosts:
            try:
                url = f"http://{host}:{local_port}/json/version"
                res = await client.get(url)
                if res.status_code == 200:
                    raw_ws = res.json()["webSocketDebuggerUrl"]
                    parsed = urlparse(raw_ws)
                    corrected_ws = urlunparse(parsed._replace(netloc=f"{host}:{local_port}"))
                    return host, corrected_ws
            except Exception:
                continue
    raise ConnectionRefusedError(f"无法连通本地/宿主机端口 {local_port} 的 CDP 服务")

async def fetch_cookies_native(local_port: int) -> List[dict]:
    host, ws_url = await resolve_cdp_endpoint(local_port)
    async with websockets.connect(ws_url, timeout=5.0) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Storage.getCookies"}))
        resp = await asyncio.wait_for(ws.recv(), timeout=5.0)
        data = json.loads(resp)
        cookies = data.get("result", {}).get("cookies", [])
        if cookies:
            return cookies

        await ws.send(json.dumps({"id": 2, "method": "Network.enable"}))
        await ws.recv()
        await ws.send(json.dumps({"id": 3, "method": "Network.getAllCookies"}))
        resp2 = await asyncio.wait_for(ws.recv(), timeout=5.0)
        data2 = json.loads(resp2)
        return data2.get("result", {}).get("cookies", [])

async def inject_cookies_native(local_port: int, cookies: List[dict]):
    host, ws_url = await resolve_cdp_endpoint(local_port)
    async with websockets.connect(ws_url, timeout=6.0) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Network.setCookies", "params": {"cookies": cookies}}))
        await asyncio.wait_for(ws.recv(), timeout=6.0)

async def probe_node_cookies(local_port: int) -> tuple[int, str]:
    try:
        cookies = await fetch_cookies_native(local_port)
        return len(cookies), "OK"
    except ConnectionRefusedError as ce:
        return 0, str(ce)
    except Exception as e:
        return 0, f"探测异常: {str(e)[:35]}"

# ==================== 5. SSH 隧道管理 ====================
class TunnelManager:
    def __init__(self):
        self.tunnels: Dict[int, SSHTunnelForwarder] = {}

    async def start_tunnel(self, node: dict):
        node_id = node['id']
        self.stop_tunnel(node_id)

        # 本地直连节点：真实探测连通性
        if node.get('is_local') == 1:
            try:
                count, msg = await probe_node_cookies(node['local_bind_port'])
                if msg == "OK":
                    self._update_node_status(node_id, "connected", count)
                    return True, f"连通正常，嗅探到 {count} 条 Cookies"
                else:
                    self._update_node_status(node_id, "error: refused", 0)
                    return False, f"本地CDP未响应: {msg}"
            except Exception as e:
                self._update_node_status(node_id, "error: offline", 0)
                return False, f"连接异常: {e}"

        # 远程节点：启动 SSH 隧道
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
            logger.info(f"节点 [{node['name']}] SSH 隧道建立成功 -> 映射端口 {node['local_bind_port']}")

            await asyncio.sleep(1.0)
            count, _ = await probe_node_cookies(node['local_bind_port'])
            self._update_node_status(node_id, "connected", count)
            return True, f"穿透成功，探测到 {count} 条 Cookies"
        except Exception as e:
            self._update_node_status(node_id, f"error: {str(e)[:25]}")
            return False, str(e)

    def stop_tunnel(self, node_id: int):
        if node_id in self.tunnels:
            try:
                self.tunnels[node_id].stop()
            except Exception:
                pass
            del self.tunnels[node_id]
        self._update_node_status(node_id, "stopped")

    def _update_node_status(self, node_id: int, status: str, cookie_count: Optional[int] = None):
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()
        if cookie_count is not None:
            cur.execute("UPDATE nodes SET status=?, cookie_count=? WHERE id=?", (status, cookie_count, node_id))
        else:
            cur.execute("UPDATE nodes SET status=? WHERE id=?", (status, node_id))
        conn.commit()
        conn.close()

tunnel_mgr = TunnelManager()

# ==================== 6. 同步调度引擎 ====================
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
        cookies = await fetch_cookies_native(source['local_bind_port'])
        source_count = len(cookies)
        log_detail.append(f"源节点 [{source['name']}] 捕获到 {source_count} 个 Cookies")

        for target in targets:
            try:
                if target.get('is_local') == 1:
                    await inject_cookies_native(target['local_bind_port'], cookies)
                    target_count, _ = await probe_node_cookies(target['local_bind_port'])
                    log_detail.append(f"-> 本地直连 [{target['name']}] 注入完成，当前: {target_count}")
                else:
                    if ChromiumSync is not None:
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
                    else:
                        await inject_cookies_native(target['local_bind_port'], cookies)

                    target_count, _ = await probe_node_cookies(target['local_bind_port'])
                    log_detail.append(f"-> 远程节点 [{target['name']}] 同步完成，当前: {target_count}")
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
        await dispatch_notification("Cookie 同步告警", f"时间: {sync_time}\n详情:\n" + "\n".join(log_detail))

# ==================== 7. API 路由 ====================
CAPTCHA_STORE = {}
app = FastAPI(title="CDP Cluster Hub")

api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)
api_key_query = APIKeyQuery(name="api_key", auto_error=False)

def verify_token(authorization: Optional[str] = ReqHeader(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="凭证无效")
    try:
        return jwt.decode(authorization.split(" ")[1], JWT_SECRET, algorithms=["HS256"])
    except Exception:
        raise HTTPException(status_code=401, detail="登录凭证失效")

def verify_agent_access(
    header_key: Optional[str] = Security(api_key_header),
    query_key: Optional[str] = Security(api_key_query),
    authorization: Optional[str] = ReqHeader(None)
):
    valid_key = get_setting('api_key')
    if (header_key and header_key == valid_key) or (query_key and query_key == valid_key):
        return {"sub": "external_agent"}
    if authorization and authorization.startswith("Bearer "):
        try:
            return jwt.decode(authorization.split(" ")[1], JWT_SECRET, algorithms=["HS256"])
        except Exception:
            pass
    raise HTTPException(status_code=403, detail="未授权调用: 请在 Header 提供 X-API-Key 或在 URL 提供 ?api_key=")

@app.get("/api/captcha")
def get_captcha():
    a, b = random.randint(10, 50), random.randint(1, 9)
    token = str(uuid.uuid4())
    CAPTCHA_STORE[token] = {"ans": a + b, "exp": time.time() + 180}
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="120" height="38" viewBox="0 0 120 38">
        <rect width="100%" height="100%" fill="#09122a" rx="4"/>
        <text x="18" y="25" font-family="-apple-system, system-ui" font-size="16" font-weight="bold" fill="#00f0ff">{a} + {b} = ?</text>
    </svg>'''
    return {"token": token, "svg": svg}

# 1. 登录逻辑
class LoginDTO(BaseModel):
    username: str
    password: str
    captcha_token: str
    captcha_answer: str

@app.post("/api/login")
def login(data: LoginDTO, req: Request):
    cap = CAPTCHA_STORE.get(data.captcha_token)
    if not cap or time.time() > cap["exp"] or str(cap["ans"]) != data.captcha_answer.strip():
        raise HTTPException(status_code=400, detail="验证码计算错误或已过期")

    admin_user = get_setting('admin_username', 'admin')
    hashed_pwd = get_setting('admin_password')

    if data.username.strip() != admin_user:
        raise HTTPException(status_code=401, detail="用户名或密码错误")

    if not verify_password(data.password, hashed_pwd):
        raise HTTPException(status_code=401, detail="用户名或密码错误")

    return {"token": jwt.encode({"sub": admin_user, "exp": datetime.utcnow() + timedelta(days=7)}, JWT_SECRET, algorithm="HS256")}

@app.get("/api/profile")
def get_profile(user: dict = Depends(verify_token)):
    return {
        "username": get_setting("admin_username"),
        "api_key": get_setting("api_key")
    }

@app.post("/api/profile")
def update_profile(data: dict, user: dict = Depends(verify_token)):
    if data.get("username"):
        set_setting("admin_username", data["username"].strip())
    if data.get("new_password"):
        set_setting("admin_password", hash_password(data["new_password"]))
    if data.get("regenerate_key"):
        set_setting("api_key", 'cdp_' + secrets.token_urlsafe(24))
    return {"message": "配置更新成功"}

# 2. 通知设置
@app.get("/api/notifications/settings")
def get_notification_settings(user: dict = Depends(verify_token)):
    return {
        "smtp_host": get_setting("smtp_host", "smtp.yeah.net"),
        "smtp_port": get_setting("smtp_port", "465"),
        "smtp_ssl": get_setting("smtp_ssl", "1") == "1",
        "smtp_sender_name": get_setting("smtp_sender_name", "CDP 节点中心"),
        "smtp_user": get_setting("smtp_user"),
        "smtp_pass": "",
        "smtp_status": get_setting("smtp_status", "untested"),
        "serverchan_enabled": get_setting("serverchan_enabled", "0") == "1",
        "serverchan_key": get_setting("serverchan_key")
    }

@app.post("/api/notifications/settings")
def save_notification_settings(data: dict, user: dict = Depends(verify_token)):
    for k in ["smtp_host", "smtp_port", "smtp_sender_name", "smtp_user", "serverchan_key"]:
        if k in data:
            set_setting(k, data[k])
    if data.get("smtp_pass"):
        set_setting("smtp_pass", data["smtp_pass"].strip())
    if "smtp_ssl" in data:
        set_setting("smtp_ssl", "1" if data["smtp_ssl"] else "0")
    if "serverchan_enabled" in data:
        set_setting("serverchan_enabled", "1" if data["serverchan_enabled"] else "0")
    return {"message": "发信参数已保存"}

class TestEmailDTO(BaseModel):
    test_email: Optional[str] = None

@app.post("/api/notifications/test-email")
def test_email(data: TestEmailDTO, user: dict = Depends(verify_token)):
    target = data.test_email.strip() if data.test_email else None
    ok, info = send_email_notification("发信测试", "这是一封来自 CDP Sync 系统的测试邮件，SMTP 配置工作正常。", override_to=target)
    if ok:
        set_setting("smtp_status", "ready")
        dest = target if target else get_setting('smtp_user')
        return {"message": f"测试邮件已成功投递至: {dest}", "smtp_status": "ready"}
    else:
        set_setting("smtp_status", f"error: {info[:30]}")
        raise HTTPException(status_code=500, detail=f"发信失败: {info}")

@app.post("/api/notifications/test-serverchan")
async def test_serverchan(user: dict = Depends(verify_token)):
    ok = await send_serverchan_notification("CDP 测试推送", "Server酱微信通道运行正常。")
    if not ok:
        raise HTTPException(status_code=500, detail="Server酱推送失败，请检查 SendKey")
    return {"message": "Server酱微信测试推送成功"}

# 3. 节点管理
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
    is_local = 1 if data.get('is_local') else 0
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute('''INSERT INTO nodes (
        name, is_source, is_local, ssh_host, ssh_port, ssh_user, ssh_key_filename,
        ssh_password, remote_cdp_port, local_bind_port, cookie_count, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'stopped')''',
    (
        data['name'],
        1 if data.get('is_source') else 0,
        is_local,
        "" if is_local else data.get('ssh_host', ''),
        22 if is_local else data.get('ssh_port', 22),
        "" if is_local else data.get('ssh_user', ''),
        "" if is_local else data.get('ssh_key_filename', ''),
        "" if is_local else data.get('ssh_password', ''),
        9222 if is_local else data.get('remote_cdp_port', 9222),
        data['local_bind_port']
    ))
    conn.commit()
    conn.close()
    return {"message": "节点配置已写入 (初始状态为离线，请点击连通测试)"}

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

    count, msg = await probe_node_cookies(node['local_bind_port'])
    new_status = "connected" if msg == "OK" else "error: refused"

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("UPDATE nodes SET cookie_count=?, status=? WHERE id=?", (count, new_status, node_id))
    conn.commit()
    conn.close()

    if msg != "OK":
        raise HTTPException(status_code=502, detail=f"探针失败: {msg}")
    return {"cookie_count": count, "message": f"探测成功: 捕获到 {count} 条 Cookies"}

@app.post("/api/nodes/{node_id}/toggle-tunnel")
async def toggle_tunnel(node_id: int, user: dict = Depends(verify_token)):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM nodes WHERE id=?", (node_id,))
    node = dict(cur.fetchone())
    conn.close()

    if node.get('is_local') != 1 and node_id in tunnel_mgr.tunnels:
        tunnel_mgr.stop_tunnel(node_id)
        return {"status": "stopped", "message": "隧道已断开"}

    ok, msg = await tunnel_mgr.start_tunnel(node)
    if not ok:
        raise HTTPException(status_code=500, detail=msg)
    return {"status": "connected", "message": msg}

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
    return {"message": "同步指令已下发"}

@app.get("/api/sync/logs")
def get_logs(user: dict = Depends(verify_token)):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM sync_logs ORDER BY id DESC LIMIT 50")
    logs = [dict(r) for r in cur.fetchall()]
    conn.close()
    return logs

# ==================== 4. 外部开放 API ====================
@app.get("/api/v1/nodes", summary="获取所有在线 CDP 节点列表")
def external_list_nodes(auth: dict = Depends(verify_agent_access)):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM nodes")
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()

    online_nodes = []
    for r in rows:
        online_nodes.append({
            "id": r["id"],
            "name": r["name"],
            "is_source": bool(r["is_source"]),
            "is_local": bool(r["is_local"]),
            "status": r["status"],
            "local_port": r["local_bind_port"],
            "cdp_http_endpoint": f"http://127.0.0.1:{r['local_bind_port']}",
            "cookie_count": r["cookie_count"],
            "last_sync": r["last_sync"],
            "cookies_export_url": f"/api/v1/nodes/{r['id']}/cookies"
        })
    return {
        "code": 200,
        "total": len(rows),
        "online_count": len([n for n in rows if n["status"] == "connected"]),
        "nodes": online_nodes
    }

@app.get("/api/v1/nodes/{node_id}/cookies", summary="提取目标节点全量 Cookies")
async def external_get_cookies(node_id: int, auth: dict = Depends(verify_agent_access)):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM nodes WHERE id=?", (node_id,))
    row = cur.fetchone()
    conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="目标节点不存在")
    node = dict(row)

    try:
        cookies = await fetch_cookies_native(node['local_bind_port'])
        return {
            "code": 200,
            "node_id": node_id,
            "node_name": node["name"],
            "total_cookies": len(cookies),
            "cookies": cookies
        }
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"提取 Cookies 失败: {e}")

@app.post("/api/v1/sync", summary="外部自动化触发全网同步")
async def external_trigger_sync(auth: dict = Depends(verify_agent_access)):
    await execute_sync_task()
    return {"code": 200, "message": "全网 Cookie 同步任务已触发"}

scheduler = BackgroundScheduler()
scheduler.add_job(lambda: asyncio.run(execute_sync_task()), 'interval', minutes=15)
scheduler.start()

# ==================== 5. 彻底解决 404：挂载静态资源与根路径兜底 ====================
if DIST_DIR:
    assets_dir = os.path.join(DIST_DIR, "assets")
    if os.path.exists(assets_dir):
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    # 关键修复 1：显式注册根路径 GET /
    @app.get("/")
    async def serve_index():
        return FileResponse(os.path.join(DIST_DIR, "index.html"))

    # 关键修复 2：处理 SPA 刷新时的前端子路由
    @app.get("/{full_path:path}")
    async def serve_vue(full_path: str):
        target_file = os.path.join(DIST_DIR, full_path)
        if full_path and os.path.exists(target_file) and os.path.isfile(target_file):
            return FileResponse(target_file)
        return FileResponse(os.path.join(DIST_DIR, "index.html"))
else:
    @app.get("/")
    async def fallback_error():
        return HTMLResponse("<h3>❌ 前端静态文件未生成，请检查前端编译。</h3>", status_code=500)

if __name__ == "__main__":
    ensure_ssl_certificates()
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8443, ssl_certfile=SSL_CERT_FILE, ssl_keyfile=SSL_KEY_FILE)