import os
import sqlite3
import hashlib
import datetime
import uuid
import secrets
from config import Config

def get_db():
    os.makedirs(os.path.dirname(Config.DB_PATH), exist_ok=True)
    conn = sqlite3.connect(Config.DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def hash_pwd(pwd: str) -> str:
    return hashlib.sha256(pwd.encode('utf-8')).hexdigest()

def init_db():
    conn = get_db()
    c = conn.cursor()

    # 1. 用户表
    c.execute('''CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        uuid TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        traffic_limit_mb INTEGER DEFAULT 1024,
        expire_date TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        status INTEGER DEFAULT 1,
        is_verified INTEGER DEFAULT 0,
        serverchan_key TEXT DEFAULT '',
        notify_type TEXT DEFAULT 'email',
        is_monthly INTEGER DEFAULT 0,
        reset_day INTEGER DEFAULT 1
    )''')

    # 2. 节点集群表 (存储各远程节点自动回传的参数)
    c.execute('''CREATE TABLE IF NOT EXISTS nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        ip TEXT NOT NULL,
        port INTEGER NOT NULL,
        sni TEXT NOT NULL,
        pbk TEXT NOT NULL,
        sid TEXT NOT NULL,
        status INTEGER DEFAULT 1,
        last_heartbeat TEXT NOT NULL
    )''')

    # 3. 卡密表
    c.execute('''CREATE TABLE IF NOT EXISTS cards (
        code TEXT PRIMARY KEY,
        traffic_gb INTEGER NOT NULL,
        days INTEGER NOT NULL,
        is_used INTEGER DEFAULT 0,
        used_by TEXT,
        created_at TEXT NOT NULL,
        is_monthly INTEGER DEFAULT 0
    )''')

    # 4. 验证码与系统配置表
    c.execute('''CREATE TABLE IF NOT EXISTS verify_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        code TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')

    c.execute('''CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )''')

    c.execute('''CREATE TABLE IF NOT EXISTS notify_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        warn_type TEXT NOT NULL,
        sent_date TEXT NOT NULL
    )''')

    # 默认管理员引导
    c.execute("SELECT id FROM users WHERE role='admin'")
    if not c.fetchone():
        admin_user = os.getenv("ADMIN_USERNAME") or "admin"
        admin_pwd = os.getenv("ADMIN_PASSWORD") or secrets.token_urlsafe(12)
        ten_years = (datetime.datetime.now() + datetime.timedelta(days=3650)).strftime("%Y-%m-%d %H:%M:%S")
        c.execute("INSERT INTO users (username, password_hash, uuid, email, traffic_limit_mb, expire_date, role, status, is_verified) VALUES (?, ?, ?, ?, 1048576, ?, 'admin', 1, 1)",
                  (admin_user, hash_pwd(admin_pwd), str(uuid.uuid4()), f"{admin_user}@system.local", ten_years))
        conn.commit()

    conn.commit()
    conn.close()

def get_setting(key: str, default: str = "") -> str:
    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT value FROM system_settings WHERE key=?", (key,))
    row = c.fetchone()
    conn.close()
    return row["value"] if row else default

def set_setting(key: str, value: str):
    conn = get_db()
    c = conn.cursor()
    c.execute("INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)", (key, value))
    conn.commit()
    conn.close()