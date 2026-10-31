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
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from email.mime.text import MIMEText
from email.header import Header
from urllib.parse import urlparse, urlunparse
from typing import Optional, List, Dict

# 消除 Paramiko 与 Cryptography 废弃警告
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
from fastapi import (
    FastAPI,
    HTTPException,
    Depends,
    Header as ReqHeader,
    UploadFile,
    File,
    Form,
    Request,
    Query,
    Security
)
from fastapi.security.api_key import APIKeyHeader, APIKeyQuery
from fastapi.responses import JSONResponse, FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("CDP_Sync")

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
CANDIDATE_DIST_DIRS = [
    os.path.abspath(os.path.join(CURRENT_DIR, "../frontend/dist")),
    os.path.abspath(os.path.join(CURRENT_DIR, "frontend/dist")),
    os.path.abspath(os.path.join(CURRENT_DIR, "dist")),
    "/app/frontend/dist"
]

DIST_DIR = None
for candidate in CANDIDATE_DIST_DIRS:
    if os.path.exists(candidate) and os.path.exists(os.path.join(candidate, "index.html")):
        DIST_DIR = candidate
        break

DATA_DIR = "/data"
KEYS_DIR = os.path.join(DATA_DIR, "keys")
DB_PATH = os.path.join(DATA_DIR, "app.db")
CERTS_DIR = "/certs"
SSL_CERT_FILE = os.path.join(CERTS_DIR, "fullchain.pem")
SSL_KEY_FILE = os.path.join(CERTS_DIR, "privkey.pem")

os.makedirs(KEYS_DIR, exist_ok=True)
os.makedirs(CERTS_DIR, exist_ok=True)

INIT_PASSWORD = os.getenv("ADMIN_INIT_PASS", "Admin@123456")

# 引入已升级的 wimotek-chromium-sync 模块
ChromiumSync = None
try:
    from chromium_sync import ChromiumSync
    logger.info("✅ 成功载入已升级的 wimotek-chromium-sync (ChromiumSync) 核心模块！")
except ImportError as e:
    logger.warning(f"⚠️ 外部 ChromiumSync 模块未激活 ({e})，启用内置高并发 WebSocket 探测与合并引擎。")

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
        logger.warning("未检测到有效证书，正在生成自签 SSL 证书...")
        try:
            os.makedirs(CERTS_DIR, exist_ok=True)
            generate_self_signed_cert(SSL_CERT_FILE, SSL_KEY_FILE)
        except Exception as e:
            fallback_dir = os.path.join(DATA_DIR, "certs")
            os.makedirs(fallback_dir, exist_ok=True)
            SSL_CERT_FILE = os.path.join(fallback_dir, "fullchain.pem")
            SSL_KEY_FILE = os.path.join(fallback_dir, "privkey.pem")
            generate_self_signed_cert(SSL_CERT_FILE, SSL_KEY_FILE)

# ==================== 2. 数据库扩展与热迁移 (增量黑白名单与差量字段) ====================
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
        auto_tunnel INTEGER DEFAULT 1,
        status TEXT DEFAULT 'stopped',
        last_sync TEXT
    )''')

    cur.execute('''CREATE TABLE IF NOT EXISTS ssh_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT UNIQUE NOT NULL,
        remark TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        size INTEGER DEFAULT 0
    )''')

    cur.execute('''CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)''')
    cur.execute('''CREATE TABLE IF NOT EXISTS sync_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT,
        source_node TEXT DEFAULT '',
        target_nodes TEXT DEFAULT '',
        cookie_count INTEGER DEFAULT 0,
        duration TEXT DEFAULT '',
        status TEXT,
        details TEXT
    )''')

    for col, col_type in [
        ("auto_tunnel", "INTEGER DEFAULT 1"),
        ("cookie_count", "INTEGER DEFAULT 0")
    ]:
        try:
            cur.execute(f"ALTER TABLE nodes ADD COLUMN {col} {col_type}")
        except Exception:
            pass

    for col, col_type in [
        ("source_node", "TEXT DEFAULT ''"),
        ("target_nodes", "TEXT DEFAULT ''"),
        ("cookie_count", "INTEGER DEFAULT 0"),
        ("duration", "TEXT DEFAULT ''")
    ]:
        try:
            cur.execute(f"ALTER TABLE sync_logs ADD COLUMN {col} {col_type}")
        except Exception:
            pass

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
        'email_notify_enabled': '0',
        'email_notify_to': '',
        'serverchan_enabled': '0',
        'serverchan_key': '',
        # 同步中心设置：新增黑白名单过滤与差量同步
        'sync_interval_minutes': '15',
        'sync_mode': 'smart_merge',
        'sync_source_id': '0',
        'sync_target_ids': '[]',
        'sync_diff_enabled': '1',
        'sync_include_domains': '',
        'sync_exclude_domains': 'doubleclick.net,google-analytics.com'
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

# ==================== 3. 增强型通知系统 ====================
def send_email_notification(title: str, content: str, override_to: Optional[str] = None) -> tuple[bool, str]:
    if get_setting('email_notify_enabled', '0') != '1' and not override_to:
        return False, "邮件推送未启用"

    host = get_setting('smtp_host')
    port = int(get_setting('smtp_port') or '465')
    use_ssl = get_setting('smtp_ssl') == '1'
    user = get_setting('smtp_user')
    password = get_setting('smtp_pass')
    sender_name = get_setting('smtp_sender_name', 'CDP 节点中心')
    to_email = override_to if override_to else (get_setting('email_notify_to') or user)

    if not (host and user and password and to_email):
        return False, "SMTP 配置不完整"

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
        return False, str(e)

async def send_serverchan_notification(title: str, content: str) -> bool:
    if get_setting('serverchan_enabled', '0') != '1':
        return False
    key = get_setting('serverchan_key')
    if not key:
        return False
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.post(f"https://sctapi.ftqq.com/{key}.send", data={"title": title, "desp": content})
            return res.status_code == 200
    except Exception:
        return False

async def dispatch_notification(title: str, content: str):
    send_email_notification(title, content)
    await send_serverchan_notification(title, content)

# ==================== 4. 域名过滤与差量指纹计算 ====================
def filter_cookies_by_domains(cookies: List[dict], include_domains: List[str], exclude_domains: List[str]) -> tuple[List[dict], int]:
    """根据黑名单和白名单过滤 Cookie，返回 (过滤后的列表, 剔除数量)"""
    if not include_domains and not exclude_domains:
        return cookies, 0

    original_len = len(cookies)
    filtered = []
    clean_inc = [inc.lower().lstrip('.') for inc in include_domains if inc.strip()]
    clean_exc = [exc.lower().lstrip('.') for exc in exclude_domains if exc.strip()]

    for c in cookies:
        domain = c.get('domain', '').lower().lstrip('.')
        # 1. 黑名单过滤（若命中黑名单规则直接丢弃）
        if clean_exc and any(exc in domain for exc in clean_exc):
            continue
        # 2. 白名单过滤（若配置了白名单，必须匹配白名单才保留）
        if clean_inc and not any(inc in domain for inc in clean_inc):
            continue
        filtered.append(c)

    dropped_count = original_len - len(filtered)
    return filtered, dropped_count

def compute_cookie_diff(current_cookies: List[dict], target_cookies: List[dict]) -> tuple[List[dict], int]:
    """差量计算：仅提取真正变更或新增的 Cookie，跳过无需变动的项"""
    curr_map = {
        (c.get('name'), c.get('domain'), c.get('path', '/')): c.get('value')
        for c in current_cookies
    }
    diff = []
    skipped_count = 0
    for n in target_cookies:
        key = (n.get('name'), n.get('domain'), n.get('path', '/'))
        if key not in curr_map or curr_map[key] != n.get('value'):
            diff.append(n)
        else:
            skipped_count += 1
    return diff, skipped_count

def smart_merge_cookies(all_cookie_lists: List[List[dict]]) -> List[dict]:
    merged_pool: Dict[tuple, dict] = {}
    for cookies in all_cookie_lists:
        for c in cookies:
            key = (c.get('name'), c.get('domain'), c.get('path', '/'))
            if key not in merged_pool:
                merged_pool[key] = c
            else:
                existing = merged_pool[key]
                if existing.get('value') != c.get('value'):
                    exp_existing = existing.get('expires', -1)
                    exp_new = c.get('expires', -1)
                    if exp_new > exp_existing:
                        merged_pool[key] = c
                    elif exp_new == exp_existing:
                        if len(str(c.get('value', ''))) >= len(str(existing.get('value', ''))):
                            merged_pool[key] = c
    return list(merged_pool.values())

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
    raise ConnectionRefusedError(f"无法连通端口 {local_port} 的 CDP 服务")

async def fetch_cookies_native(local_port: int) -> List[dict]:
    """优先委派模块静态工具提取，若无则使用内置 CDP 引擎"""
    if ChromiumSync is not None and hasattr(ChromiumSync, 'get_cookies'):
        try:
            fn = getattr(ChromiumSync, 'get_cookies')
            if inspect.iscoroutinefunction(fn):
                return await fn(port=local_port, host="127.0.0.1")
            return await asyncio.to_thread(fn, port=local_port, host="127.0.0.1")
        except Exception as e:
            logger.debug(f"ChromiumSync.get_cookies 调用异常，回退内置提取器: {e}")

    host, ws_url = await resolve_cdp_endpoint(local_port)
    async with websockets.connect(ws_url, timeout=5.0) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Storage.getCookies"}))
        resp = await asyncio.wait_for(ws.recv(), timeout=5.0)
        data = json.loads(resp)
        cookies = data.get("result", {}).get("cookies", [])
        if cookies:
            return cookies

        # 回退 Network 域
        await ws.send(json.dumps({"id": 2, "method": "Network.enable"}))
        await ws.recv()
        await ws.send(json.dumps({"id": 3, "method": "Network.getAllCookies"}))
        resp2 = await asyncio.wait_for(ws.recv(), timeout=5.0)
        data2 = json.loads(resp2)
        return data2.get("result", {}).get("cookies", [])

async def inject_cookies_native(local_port: int, cookies: List[dict]):
    """优先委派模块静态工具写入，若无则使用内置 CDP 引擎"""
    if ChromiumSync is not None and hasattr(ChromiumSync, 'set_cookies'):
        try:
            fn = getattr(ChromiumSync, 'set_cookies')
            if inspect.iscoroutinefunction(fn):
                await fn(cookies=cookies, port=local_port, host="127.0.0.1")
                return
            await asyncio.to_thread(fn, cookies=cookies, port=local_port, host="127.0.0.1")
            return
        except Exception as e:
            logger.debug(f"ChromiumSync.set_cookies 调用异常，回退内置写入器: {e}")

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

# ==================== 5. SSH 隧道管理 (默认全量穿透 + 守护看门狗) ====================
class TunnelManager:
    def __init__(self):
        self.tunnels: Dict[int, SSHTunnelForwarder] = {}

    async def start_tunnel(self, node: dict):
        node_id = node['id']
        self.stop_tunnel(node_id)

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
            logger.info(f"节点 [{node['name']}] SSH 隧道启动成功 -> 映射端口 {node['local_bind_port']}")

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

async def tunnel_watchdog_loop():
    logger.info("启动 SSH 隧道守护看门狗：自动穿透并维持节点在线...")
    while True:
        try:
            conn = sqlite3.connect(DB_PATH)
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()
            cur.execute("SELECT * FROM nodes")
            nodes = [dict(r) for r in cur.fetchall()]
            conn.close()

            for node in nodes:
                if node.get('auto_tunnel', 1) == 1:
                    is_running = False
                    if node['is_local'] == 1:
                        c, msg = await probe_node_cookies(node['local_bind_port'])
                        is_running = (msg == "OK")
                    else:
                        is_running = (node['id'] in tunnel_mgr.tunnels and tunnel_mgr.tunnels[node['id']].is_active)

                    if not is_running:
                        await tunnel_mgr.start_tunnel(node)
        except Exception as e:
            logger.debug(f"看门狗巡检异常: {e}")
        await asyncio.sleep(30)

# ==================== 6. 同步调度引擎 (结合黑白名单、差量检测与 ChromiumSync) ====================
async def run_chromium_sync_instance(source_node: dict, target_node: dict, include_domains: List[str], exclude_domains: List[str], diff_enabled: bool) -> dict:
    """实例化 wimotek-chromium-sync 执行同步任务"""
    if ChromiumSync is None:
        raise ImportError("未安装 wimotek-chromium-sync 模块")

    sig = inspect.signature(ChromiumSync.__init__)
    kwargs = {
        "remote_ssh": f"{target_node['ssh_user']}@{target_node['ssh_host']}",
        "remote_ssh_port": int(target_node['ssh_port']),
        "local_cdp_port": int(source_node['local_bind_port']),
        "remote_cdp_port": int(target_node['remote_cdp_port']),
        "remote_tunnel_port": int(target_node['local_bind_port']),
        "direction": "push",
        "timeout": 10
    }

    # 动态匹配新升级的私钥、密码形参
    if target_node.get('ssh_key_filename'):
        key_path = os.path.join(KEYS_DIR, target_node['ssh_key_filename'])
        for k_param in ['ssh_key', 'key_file', 'key_filename', 'pkey']:
            if k_param in sig.parameters:
                kwargs[k_param] = key_path
                break
        os.environ["GIT_SSH_COMMAND"] = f"ssh -i {key_path} -o StrictHostKeyChecking=no"

    if target_node.get('ssh_password'):
        for p_param in ['ssh_password', 'password']:
            if p_param in sig.parameters:
                kwargs[p_param] = target_node['ssh_password']
                break

    # 动态匹配新升级的黑白名单与差量形参
    if "include_domains" in sig.parameters:
        kwargs["include_domains"] = include_domains
    if "exclude_domains" in sig.parameters:
        kwargs["exclude_domains"] = exclude_domains
    for diff_arg in ["diff", "diff_enabled", "delta"]:
        if diff_arg in sig.parameters:
            kwargs[diff_arg] = diff_enabled
            break

    filtered = {k: v for k, v in kwargs.items() if k in sig.parameters}
    syncer = ChromiumSync(**filtered)

    if hasattr(syncer, 'run_async') and inspect.iscoroutinefunction(getattr(syncer, 'run_async')):
        res = await syncer.run_async()
    else:
        res = await asyncio.to_thread(syncer.run)

    if isinstance(res, dict):
        return res
    return {"status": "success", "message": str(res) if res else "OK"}

async def execute_sync_task(custom_source_id: Optional[int] = None, custom_target_ids: Optional[List[int]] = None):
    start_ts = time.time()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM nodes")
    nodes = [dict(row) for row in cur.fetchall()]
    conn.close()

    if not nodes:
        return

    sync_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    log_detail = []
    sync_mode = get_setting("sync_mode", "smart_merge")
    diff_enabled = (get_setting("sync_diff_enabled", "1") == "1")
    include_domains = [d.strip() for d in get_setting("sync_include_domains", "").split(",") if d.strip()]
    exclude_domains = [d.strip() for d in get_setting("sync_exclude_domains", "doubleclick.net,google-analytics.com").split(",") if d.strip()]

    source_node_desc = ""
    target_nodes_desc = ""
    cookie_count_metric = 0

    log_detail.append(f"📋 规则审计：差量检测=[{'开启' if diff_enabled else '关闭'}] | 白名单=[{len(include_domains)}项] | 黑名单=[{len(exclude_domains)}项]")

    # 场景 A: 默认首选【智能全局最新值合并 (Smart Merge)】
    if not custom_source_id and sync_mode == "smart_merge":
        source_node_desc = "🌟 全网智能汇聚"
        try:
            log_detail.append("🚀 触发【智能全局最新值合并 (Smart Merge)】：并发嗅探所有节点...")
            
            fetch_tasks = [fetch_cookies_native(n['local_bind_port']) for n in nodes]
            fetched_results = await asyncio.gather(*fetch_tasks, return_exceptions=True)
            
            valid_cookie_lists = []
            for idx, res in enumerate(fetched_results):
                n_name = nodes[idx]['name']
                if isinstance(res, list):
                    # 抓取后即刻进行黑白名单清洗
                    cleaned_c, dropped = filter_cookies_by_domains(res, include_domains, exclude_domains)
                    valid_cookie_lists.append(cleaned_c)
                    drop_info = f" (已过滤 {dropped} 个黑名单/非白名单项)" if dropped > 0 else ""
                    log_detail.append(f"• 节点 [{n_name}] 贡献 {len(cleaned_c)} 条有效凭据{drop_info}")
                else:
                    log_detail.append(f"• 节点 [{n_name}] 暂时无法连接 ({res})")

            golden_pool = smart_merge_cookies(valid_cookie_lists)
            cookie_count_metric = len(golden_pool)
            target_nodes_desc = f"全网对齐 ({len(nodes)} 个节点)"
            log_detail.append(f"✨ 智能裁决融合完成：生成全网黄金凭据池 (共 {cookie_count_metric} 条唯一最新 Cookies)")

            # 并发写入对齐各节点
            async def _push_golden(node):
                try:
                    # 若开启差量检测，先比对当前节点已有 Cookie，仅注入变更项
                    if diff_enabled:
                        curr_c = await fetch_cookies_native(node['local_bind_port'])
                        diff_cookies, skipped = compute_cookie_diff(curr_c, golden_pool)
                        if diff_cookies:
                            await inject_cookies_native(node['local_bind_port'], diff_cookies)
                        c_cnt, _ = await probe_node_cookies(node['local_bind_port'])
                        action_desc = f"差量注入 {len(diff_cookies)} 条更新项 (跳过 {skipped} 个无变化项)"
                    else:
                        await inject_cookies_native(node['local_bind_port'], golden_pool)
                        c_cnt, _ = await probe_node_cookies(node['local_bind_port'])
                        action_desc = f"全量写入 {len(golden_pool)} 条凭据"

                    conn = sqlite3.connect(DB_PATH)
                    cur = conn.cursor()
                    cur.execute("UPDATE nodes SET cookie_count=?, last_sync=? WHERE id=?", (c_cnt, sync_time, node['id']))
                    conn.commit()
                    conn.close()
                    return f"-> 节点 [{node['name']}] 对齐成功 ({action_desc}，现存 {c_cnt} 条)"
                except Exception as ex:
                    return f"-> 节点 [{node['name']}] 回写异常: {ex}"

            push_tasks = [_push_golden(n) for n in nodes]
            push_results = await asyncio.gather(*push_tasks)
            log_detail.extend(push_results)
            status = "SUCCESS"
        except Exception as e:
            status = "FAILED"
            log_detail.append(f"智能合并调度中断: {e}")

    # 场景 B: 传统指定主节点单向广播 (Master-Worker / 定向)
    else:
        source = None
        if custom_source_id:
            source = next((n for n in nodes if n["id"] == custom_source_id), None)
        if not source:
            rule_source_id = int(get_setting("sync_source_id", "0"))
            if rule_source_id > 0:
                source = next((n for n in nodes if n["id"] == rule_source_id), None)
            if not source:
                source = next((n for n in nodes if n["is_source"] == 1), None)

        if not source:
            logger.warning("未配置或无法找到源节点，跳过主从分发。")
            return

        source_node_desc = f"{source['name']} ({'本地' if source['is_local'] else source['ssh_host']})"

        targets = []
        if custom_target_ids is not None:
            targets = [n for n in nodes if n["id"] in custom_target_ids and n["id"] != source["id"]]
        else:
            target_ids_cfg = json.loads(get_setting("sync_target_ids", "[]"))
            if target_ids_cfg:
                targets = [n for n in nodes if n["id"] in target_ids_cfg and n["id"] != source["id"]]
            else:
                targets = [n for n in nodes if n["id"] != source["id"]]

        target_nodes_desc = ", ".join([t['name'] for t in targets]) if targets else "无分发目标"

        try:
            raw_cookies = await fetch_cookies_native(source['local_bind_port'])
            cookies, dropped = filter_cookies_by_domains(raw_cookies, include_domains, exclude_domains)
            cookie_count_metric = len(cookies)
            drop_info = f" (已过滤 {dropped} 个黑名单/非白名单项)" if dropped > 0 else ""
            log_detail.append(f"主从广播：从源节点 [{source['name']}] 捕获到 {cookie_count_metric} 个有效 Cookies{drop_info}")

            for target in targets:
                try:
                    if ChromiumSync is not None and not target['is_local']:
                        sync_res = await run_chromium_sync_instance(source, target, include_domains, exclude_domains, diff_enabled)
                        target_count, _ = await probe_node_cookies(target['local_bind_port'])
                        msg = sync_res.get("message", "OK") if isinstance(sync_res, dict) else sync_res
                        log_detail.append(f"-> 目标节点 [{target['name']}] 模块同步完成 ({msg})，现存: {target_count}")
                    else:
                        if diff_enabled:
                            curr_c = await fetch_cookies_native(target['local_bind_port'])
                            diff_c, skipped = compute_cookie_diff(curr_c, cookies)
                            if diff_c:
                                await inject_cookies_native(target['local_bind_port'], diff_c)
                            act = f"差量注入 {len(diff_c)} 条 (跳过 {skipped} 个无变化项)"
                        else:
                            await inject_cookies_native(target['local_bind_port'], cookies)
                            act = f"全量写入 {len(cookies)} 条"

                        target_count, _ = await probe_node_cookies(target['local_bind_port'])
                        log_detail.append(f"-> 目标节点 [{target['name']}] 写入完成 ({act})，现存: {target_count}")
                except Exception as ex:
                    log_detail.append(f"-> 目标节点 [{target['name']}] 写入异常: {ex}")
            status = "SUCCESS"
        except Exception as e:
            status = "FAILED"
            log_detail.append(f"主从分发中断: {e}")

    duration_str = f"{time.time() - start_ts:.2f}s"

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO sync_logs (timestamp, source_node, target_nodes, cookie_count, duration, status, details)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (sync_time, source_node_desc, target_nodes_desc, cookie_count_metric, duration_str, status, "\n".join(log_detail)))
    conn.commit()
    conn.close()

    if status == "FAILED":
        await dispatch_notification("Cookie 同步告警", f"时间: {sync_time} (耗时: {duration_str})\n详情:\n" + "\n".join(log_detail))

# ==================== 7. 定时调度器与生命周期 ====================
scheduler = BackgroundScheduler()

def reschedule_sync_job(minutes: int):
    try:
        if scheduler.get_job('cookie_sync_job'):
            scheduler.remove_job('cookie_sync_job')
        scheduler.add_job(
            lambda: asyncio.run(execute_sync_task()),
            'interval',
            minutes=max(1, minutes),
            id='cookie_sync_job'
        )
        logger.info(f"Cookie 同步定时调度任务已更新为每 {minutes} 分钟执行一次")
    except Exception as e:
        logger.error(f"更新定时调度异常: {e}")

@asynccontextmanager
async def lifespan(app: FastAPI):
    minutes = int(get_setting("sync_interval_minutes", "15"))
    scheduler.start()
    reschedule_sync_job(minutes)
    watchdog_task = asyncio.create_task(tunnel_watchdog_loop())
    yield
    try:
        watchdog_task.cancel()
        scheduler.shutdown(wait=False)
        for t in list(tunnel_mgr.tunnels.values()):
            try:
                t.stop()
            except Exception:
                pass
    except Exception:
        pass

app = FastAPI(title="CDP Cluster Hub", lifespan=lifespan)

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
    raise HTTPException(status_code=403, detail="未授权调用: 请在 Header 提供 X-API-Key 或 ?api_key=")

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

# 登录
class LoginDTO(BaseModel):
    username: str
    password: str
    captcha_token: str
    captcha_answer: str

@app.post("/api/login")
def login(data: LoginDTO, req: Request):
    cap = CAPTCHA_STORE.get(data.captcha_token)
    if not cap or time.time() > cap["exp"] or str(cap["ans"]) != data.captcha_answer.strip():
        raise HTTPException(status_code=400, detail="验证码错误或已过期")

    admin_user = get_setting('admin_username', 'admin')
    hashed_pwd = get_setting('admin_password')

    if data.username.strip() != admin_user or not verify_password(data.password, hashed_pwd):
        raise HTTPException(status_code=401, detail="用户名或密码错误")

    return {"token": jwt.encode({"sub": admin_user, "exp": datetime.utcnow() + timedelta(days=7)}, JWT_SECRET, algorithm="HS256")}

# 账号与 Agent Key
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

# 节点管理
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
        ssh_password, remote_cdp_port, local_bind_port, cookie_count, auto_tunnel, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 'stopped')''',
    (
        data['name'], 1 if data.get('is_source') else 0, is_local,
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
    return {"message": "节点配置已写入，后台已自动激活默认穿透"}

@app.put("/api/nodes/{node_id}")
async def update_node(node_id: int, data: dict, user: dict = Depends(verify_token)):
    is_local = 1 if data.get('is_local') else 0
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute('''UPDATE nodes SET 
        name=?, is_local=?, ssh_host=?, ssh_port=?, ssh_user=?, 
        ssh_key_filename=?, ssh_password=?, remote_cdp_port=?, local_bind_port=?
        WHERE id=?''',
    (
        data['name'], is_local,
        "" if is_local else data.get('ssh_host', ''),
        22 if is_local else data.get('ssh_port', 22),
        "" if is_local else data.get('ssh_user', ''),
        "" if is_local else data.get('ssh_key_filename', ''),
        "" if is_local else data.get('ssh_password', ''),
        9222 if is_local else data.get('remote_cdp_port', 9222),
        data['local_bind_port'],
        node_id
    ))
    conn.commit()
    conn.close()

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM nodes WHERE id=?", (node_id,))
    updated_node = dict(cur.fetchone())
    conn.close()
    await tunnel_mgr.start_tunnel(updated_node)

    return {"message": "节点配置已更新并重新载入穿透通道"}

@app.delete("/api/nodes/{node_id}")
def delete_node(node_id: int, user: dict = Depends(verify_token)):
    tunnel_mgr.stop_tunnel(node_id)
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("DELETE FROM nodes WHERE id=?", (node_id,))
    conn.commit()
    conn.close()
    return {"message": "节点已删除"}

@app.get("/api/nodes/{node_id}/cookie-details")
async def get_node_cookie_details(node_id: int, user: dict = Depends(verify_token)):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM nodes WHERE id=?", (node_id,))
    row = cur.fetchone()
    conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="节点不存在")
    node = dict(row)

    now_ts = time.time()
    try:
        raw_cookies = await fetch_cookies_native(node['local_bind_port'])
        analyzed = []
        valid_count = 0
        session_count = 0
        expired_count = 0

        for c in raw_cookies:
            expires = c.get('expires', -1)
            is_session = c.get('session', False) or (expires <= 0)
            status = "valid"
            expires_desc = "会话凭证 (浏览器关闭失效)"

            if is_session:
                session_count += 1
                status = "session"
            else:
                if expires > now_ts:
                    valid_count += 1
                    status = "valid"
                    exp_dt = datetime.fromtimestamp(expires).strftime("%Y-%m-%d %H:%M:%S")
                    days_left = max(0, int((expires - now_ts) / 86400))
                    expires_desc = f"{exp_dt} (剩余 {days_left} 天)"
                else:
                    expired_count += 1
                    status = "expired"
                    exp_dt = datetime.fromtimestamp(expires).strftime("%Y-%m-%d %H:%M:%S")
                    expires_desc = f"已失效 (于 {exp_dt})"

            analyzed.append({
                "name": c.get("name"),
                "domain": c.get("domain"),
                "path": c.get("path"),
                "value_masked": c.get("value", "")[:6] + "..." + c.get("value", "")[-4:] if len(c.get("value", "")) > 10 else "***",
                "value_full": c.get("value"),
                "status": status,
                "expires_desc": expires_desc,
                "secure": c.get("secure", False),
                "httpOnly": c.get("httpOnly", False)
            })

        return {
            "node_name": node["name"],
            "total": len(raw_cookies),
            "valid_count": valid_count,
            "session_count": session_count,
            "expired_count": expired_count,
            "cookies": analyzed
        }
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"无法从目标节点读取 Cookie 详情: {e}")

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
        raise HTTPException(status_code=502, detail=f"探针未就绪: {msg}")
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
        return {"status": "stopped", "message": "隧道已手动切断"}

    ok, msg = await tunnel_mgr.start_tunnel(node)
    if not ok:
        raise HTTPException(status_code=500, detail=msg)
    return {"status": "connected", "message": msg}

@app.post("/api/nodes/{node_id}/toggle-source")
def toggle_source(node_id: int, user: dict = Depends(verify_token)):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT is_source FROM nodes WHERE id=?", (node_id,))
    row = cur.fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="节点不存在")
    
    curr = row["is_source"]
    if curr == 1:
        cur.execute("UPDATE nodes SET is_source = 0 WHERE id=?", (node_id,))
        msg = "已取消该节点的默认源状态"
        is_src = 0
    else:
        cur.execute("UPDATE nodes SET is_source = 0")
        cur.execute("UPDATE nodes SET is_source = 1 WHERE id=?", (node_id,))
        msg = "已设为全网默认源节点"
        is_src = 1

    conn.commit()
    conn.close()
    return {"message": msg, "is_source": is_src}

@app.post("/api/nodes/{node_id}/set-source")
def set_source_compat(node_id: int, user: dict = Depends(verify_token)):
    return toggle_source(node_id, user)

# 密钥存储库
@app.get("/api/ssh-keys")
def list_keys(user: dict = Depends(verify_token)):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT * FROM ssh_keys ORDER BY id DESC")
    db_keys = {r["filename"]: dict(r) for r in cur.fetchall()}

    result = []
    for fn in os.listdir(KEYS_DIR):
        fp = os.path.join(KEYS_DIR, fn)
        if os.path.isfile(fp):
            meta = db_keys.get(fn)
            if meta:
                result.append({
                    "id": meta.get("id"),
                    "filename": fn,
                    "remark": meta.get("remark", ""),
                    "created_at": meta.get("created_at"),
                    "size": meta.get("size", os.path.getsize(fp))
                })
            else:
                c_time = datetime.fromtimestamp(os.path.getctime(fp)).strftime("%Y-%m-%d %H:%M:%S")
                sz = os.path.getsize(fp)
                cur.execute("INSERT OR IGNORE INTO ssh_keys (filename, remark, created_at, size) VALUES (?, '', ?, ?)",
                            (fn, c_time, sz))
                conn.commit()
                result.append({
                    "id": None,
                    "filename": fn,
                    "remark": "",
                    "created_at": c_time,
                    "size": sz
                })
    conn.close()
    return result

@app.post("/api/ssh-keys")
async def upload_key(
    file: UploadFile = File(...),
    remark: str = Form(""),
    user: dict = Depends(verify_token)
):
    path = os.path.join(KEYS_DIR, file.filename)
    content = await file.read()
    with open(path, "wb") as f:
        f.write(content)
    os.chmod(path, 0o600)

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("INSERT OR REPLACE INTO ssh_keys (filename, remark, created_at, size) VALUES (?, ?, ?, ?)",
                (file.filename, remark.strip(), now_str, len(content)))
    conn.commit()
    conn.close()
    return {"message": f"证书 {file.filename} 上传完成"}

@app.put("/api/ssh-keys/{filename:path}")
def update_key_remark(filename: str, data: dict, user: dict = Depends(verify_token)):
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("SELECT id FROM ssh_keys WHERE filename=?", (filename,))
    row = cur.fetchone()
    new_remark = data.get("remark", "").strip()

    fp = os.path.join(KEYS_DIR, filename)
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    file_time = datetime.fromtimestamp(os.path.getctime(fp)).strftime("%Y-%m-%d %H:%M:%S") if os.path.exists(fp) else now_str
    file_size = os.path.getsize(fp) if os.path.exists(fp) else 0

    if row:
        cur.execute("UPDATE ssh_keys SET remark=? WHERE filename=?", (new_remark, filename))
    else:
        cur.execute("INSERT INTO ssh_keys (filename, remark, created_at, size) VALUES (?, ?, ?, ?)",
                    (filename, new_remark, file_time, file_size))
    conn.commit()
    conn.close()
    return {"message": "备注更新成功", "remark": new_remark}

@app.delete("/api/ssh-keys/{filename:path}")
def delete_key(filename: str, user: dict = Depends(verify_token)):
    p = os.path.join(KEYS_DIR, filename)
    if os.path.exists(p):
        os.remove(p)
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("DELETE FROM ssh_keys WHERE filename=?", (filename,))
    conn.commit()
    conn.close()
    return {"message": "证书已销毁"}

# 同步中心调度与设置 (支持差量开关、黑白名单)
@app.get("/api/sync/settings")
def get_sync_settings(user: dict = Depends(verify_token)):
    return {
        "sync_interval_minutes": int(get_setting("sync_interval_minutes", "15")),
        "sync_mode": get_setting("sync_mode", "smart_merge"),
        "sync_source_id": int(get_setting("sync_source_id", "0")),
        "sync_target_ids": json.loads(get_setting("sync_target_ids", "[]")),
        "sync_diff_enabled": get_setting("sync_diff_enabled", "1") == "1",
        "sync_include_domains": get_setting("sync_include_domains", ""),
        "sync_exclude_domains": get_setting("sync_exclude_domains", "doubleclick.net,google-analytics.com")
    }

@app.post("/api/sync/settings")
def save_sync_settings(data: dict, user: dict = Depends(verify_token)):
    if "sync_interval_minutes" in data:
        mins = int(data["sync_interval_minutes"])
        set_setting("sync_interval_minutes", str(mins))
        reschedule_sync_job(mins)
    if "sync_mode" in data:
        set_setting("sync_mode", data["sync_mode"])
    if "sync_source_id" in data:
        set_setting("sync_source_id", str(data["sync_source_id"]))
    if "sync_target_ids" in data:
        set_setting("sync_target_ids", json.dumps(data["sync_target_ids"]))
    if "sync_diff_enabled" in data:
        set_setting("sync_diff_enabled", "1" if data["sync_diff_enabled"] else "0")
    if "sync_include_domains" in data:
        set_setting("sync_include_domains", data["sync_include_domains"].strip())
    if "sync_exclude_domains" in data:
        set_setting("sync_exclude_domains", data["sync_exclude_domains"].strip())
    return {"message": "同步策略配置已生效"}

class TriggerSyncDTO(BaseModel):
    source_id: Optional[int] = None
    target_ids: Optional[List[int]] = None

@app.post("/api/sync/trigger")
async def trigger_sync(data: TriggerSyncDTO = TriggerSyncDTO(), user: dict = Depends(verify_token)):
    await execute_sync_task(custom_source_id=data.source_id, custom_target_ids=data.target_ids)
    return {"message": "同步任务指令已下发执行"}

@app.get("/api/sync/logs")
def get_logs(user: dict = Depends(verify_token)):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("""
        SELECT id, timestamp, source_node, target_nodes, cookie_count, duration, status, details 
        FROM sync_logs 
        ORDER BY id DESC LIMIT 50
    """)
    logs = [dict(r) for r in cur.fetchall()]
    conn.close()
    return logs

# 告警设置
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
        "email_notify_enabled": get_setting("email_notify_enabled", "0") == "1",
        "email_notify_to": get_setting("email_notify_to", ""),
        "serverchan_enabled": get_setting("serverchan_enabled", "0") == "1",
        "serverchan_key": get_setting("serverchan_key")
    }

@app.post("/api/notifications/settings")
def save_notification_settings(data: dict, user: dict = Depends(verify_token)):
    for k in ["smtp_host", "smtp_port", "smtp_sender_name", "smtp_user", "email_notify_to", "serverchan_key"]:
        if k in data:
            set_setting(k, data[k])
    if data.get("smtp_pass"):
        set_setting("smtp_pass", data["smtp_pass"].strip())
    if "smtp_ssl" in data:
        set_setting("smtp_ssl", "1" if data["smtp_ssl"] else "0")
    if "email_notify_enabled" in data:
        set_setting("email_notify_enabled", "1" if data["email_notify_enabled"] else "0")
    if "serverchan_enabled" in data:
        set_setting("serverchan_enabled", "1" if data["serverchan_enabled"] else "0")
    return {"message": "通知设置已保存"}

class TestEmailDTO(BaseModel):
    test_email: Optional[str] = None

@app.post("/api/notifications/test-email")
def test_email(data: TestEmailDTO, user: dict = Depends(verify_token)):
    target = data.test_email.strip() if data.test_email else None
    ok, info = send_email_notification("发信测试", "这是一封来自 CDP Sync 系统的测试邮件，SMTP 配置工作正常。", override_to=target)
    if ok:
        set_setting("smtp_status", "ready")
        dest = target if target else (get_setting('email_notify_to') or get_setting('smtp_user'))
        return {"message": f"测试邮件已成功投递至: {dest}", "smtp_status": "ready"}
    else:
        set_setting("smtp_status", f"error: {info[:30]}")
        raise HTTPException(status_code=500, detail=f"发信受阻: {info}")

@app.post("/api/notifications/test-serverchan")
async def test_serverchan(user: dict = Depends(verify_token)):
    ok = await send_serverchan_notification("CDP 测试推送", "Server酱微信通道运行正常。")
    if not ok:
        raise HTTPException(status_code=500, detail="Server酱推送失败，请检查 SendKey")
    return {"message": "Server酱微信测试推送成功"}

# 外部 Agent 开放 API
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

# 静态托管
if DIST_DIR:
    assets_dir = os.path.join(DIST_DIR, "assets")
    if os.path.exists(assets_dir):
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/")
    async def serve_index():
        return FileResponse(os.path.join(DIST_DIR, "index.html"))

    @app.get("/{full_path:path}")
    async def serve_vue(full_path: str):
        target_file = os.path.join(DIST_DIR, full_path)
        if full_path and os.path.exists(target_file) and os.path.isfile(target_file):
            return FileResponse(target_file)
        return FileResponse(os.path.join(DIST_DIR, "index.html"))
else:
    @app.get("/")
    async def fallback_error():
        return HTMLResponse("<h3>❌ 前端静态资源尚未生成，请检查前端打包。</h3>", status_code=500)

if __name__ == "__main__":
    ensure_ssl_certificates()
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8443, ssl_certfile=SSL_CERT_FILE, ssl_keyfile=SSL_KEY_FILE)