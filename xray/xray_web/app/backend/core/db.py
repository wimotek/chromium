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
        used_mb REAL DEFAULT 0,
        expire_date TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        status INTEGER DEFAULT 1,
        is_verified INTEGER DEFAULT 0,
        serverchan_key TEXT DEFAULT '',
        notify_type TEXT DEFAULT 'email',
        is_monthly INTEGER DEFAULT 0,
        reset_day INTEGER DEFAULT 1,
        user_group TEXT DEFAULT 'default'
    )''')

    # 2. 节点集群表 (新增 is_approved 隔离审批字段)
    c.execute('''CREATE TABLE IF NOT EXISTS nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id TEXT UNIQUE NOT NULL,
        node_key TEXT NOT NULL,
        pending_key TEXT DEFAULT '',
        name TEXT NOT NULL,
        ip TEXT NOT NULL,
        port INTEGER NOT NULL,
        dest TEXT DEFAULT 'www.microsoft.com:443',
        sni TEXT NOT NULL,
        server_names TEXT DEFAULT '',
        pbk TEXT NOT NULL,
        sid TEXT NOT NULL,
        status INTEGER DEFAULT 1,
        last_heartbeat TEXT NOT NULL,
        allow_all INTEGER DEFAULT 1,
        allowed_groups TEXT DEFAULT '',
        allowed_users TEXT DEFAULT '',
        is_approved INTEGER DEFAULT 1
    )''')

    # 3. 卡密表
    c.execute('''CREATE TABLE IF NOT EXISTS cards (
        code TEXT PRIMARY KEY,
        traffic_gb INTEGER NOT NULL,
        days INTEGER NOT NULL,
        is_used INTEGER DEFAULT 0,
        used_by TEXT,
        created_at TEXT NOT NULL,
        used_at TEXT DEFAULT '',
        is_monthly INTEGER DEFAULT 0
    )''')

    # 4. 系统设置表
    c.execute('''CREATE TABLE IF NOT EXISTS verify_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        code TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')

    c.execute('''CREATE TABLE IF NOT EXISTS captchas (
        id TEXT PRIMARY KEY,
        answer TEXT NOT NULL,
        expire_at REAL NOT NULL
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

    # 5. 安全审计与通信流水表 (生产级无污染日志表)
    c.execute('''CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        event_type TEXT NOT NULL,
        node_id TEXT DEFAULT '',
        node_name TEXT DEFAULT '',
        ip TEXT DEFAULT '',
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')

    def try_add_column(sql):
        try:
            c.execute(sql)
            conn.commit()
        except Exception:
            pass

    try_add_column("ALTER TABLE nodes ADD COLUMN node_key TEXT DEFAULT ''")
    try_add_column("ALTER TABLE nodes ADD COLUMN pending_key TEXT DEFAULT ''")
    try_add_column("ALTER TABLE nodes ADD COLUMN dest TEXT DEFAULT 'www.microsoft.com:443'")
    try_add_column("ALTER TABLE nodes ADD COLUMN server_names TEXT DEFAULT ''")
    try_add_column("ALTER TABLE nodes ADD COLUMN allow_all INTEGER DEFAULT 1")
    try_add_column("ALTER TABLE nodes ADD COLUMN allowed_groups TEXT DEFAULT ''")
    try_add_column("ALTER TABLE nodes ADD COLUMN allowed_users TEXT DEFAULT ''")
    try_add_column("ALTER TABLE nodes ADD COLUMN is_approved INTEGER DEFAULT 1")
    try_add_column("ALTER TABLE nodes ADD COLUMN node_public_key TEXT DEFAULT ''")
    try_add_column("ALTER TABLE nodes ADD COLUMN key_lock_status TEXT DEFAULT 'unlocked'")
    try_add_column("ALTER TABLE nodes ADD COLUMN last_challenge_nonce TEXT DEFAULT ''")
    try_add_column("ALTER TABLE nodes ADD COLUMN last_nonce_created_at REAL DEFAULT 0")
    try_add_column("ALTER TABLE nodes ADD COLUMN net_mode TEXT DEFAULT 'direct'")
    try_add_column("ALTER TABLE nodes ADD COLUMN tunnel_uuid TEXT DEFAULT ''")
    try_add_column("ALTER TABLE nodes ADD COLUMN tunnel_status TEXT DEFAULT 'disconnected'")
    try_add_column("ALTER TABLE users ADD COLUMN user_group TEXT DEFAULT 'default'")

    # 初始化全局 TOFU 首次信任总开关、引导令牌 (Cluster Token) 与自动审批开关
    c.execute("SELECT value FROM system_settings WHERE key='tofu_enabled'")
    if not c.fetchone():
        c.execute("INSERT INTO system_settings (key, value) VALUES ('tofu_enabled', 'true')")

    c.execute("SELECT value FROM system_settings WHERE key='cluster_token'")
    if not c.fetchone():
        init_cluster_token = "ctk_" + secrets.token_hex(16)
        c.execute("INSERT INTO system_settings (key, value) VALUES ('cluster_token', ?)", (init_cluster_token,))

    c.execute("SELECT value FROM system_settings WHERE key='node_auto_approve'")
    if not c.fetchone():
        c.execute("INSERT INTO system_settings (key, value) VALUES ('node_auto_approve', 'true')")

    c.execute("SELECT value FROM system_settings WHERE key='crypto_key_lock_enforced'")
    if not c.fetchone():
        c.execute("INSERT INTO system_settings (key, value) VALUES ('crypto_key_lock_enforced', 'true')")

    c.execute("SELECT id FROM users WHERE role='admin'")
    if not c.fetchone():
        admin_user = os.getenv("ADMIN_USERNAME") or "admin"
        admin_pwd = os.getenv("ADMIN_PASSWORD") or secrets.token_urlsafe(12)
        ten_years = (datetime.datetime.now() + datetime.timedelta(days=3650)).strftime("%Y-%m-%d %H:%M:%S")
        c.execute("""
            INSERT INTO users (username, password_hash, uuid, email, traffic_limit_mb, used_mb, expire_date, role, status, is_verified, user_group) 
            VALUES (?, ?, ?, ?, 1048576, 0, ?, 'admin', 1, 1, 'admin')
        """, (admin_user, hash_pwd(admin_pwd), str(uuid.uuid4()), f"{admin_user}@system.local", ten_years))
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