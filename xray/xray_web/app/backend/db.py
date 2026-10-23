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
        notify_type TEXT DEFAULT 'email'
    )''')

    # 2. 卡密表
    c.execute('''CREATE TABLE IF NOT EXISTS cards (
        code TEXT PRIMARY KEY,
        traffic_gb INTEGER NOT NULL,
        days INTEGER NOT NULL,
        is_used INTEGER DEFAULT 0,
        used_by TEXT,
        created_at TEXT NOT NULL
    )''')

    # 3. 邮箱验证码缓存表
    c.execute('''CREATE TABLE IF NOT EXISTS verify_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        code TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')

    # 4. 全局系统配置表 (SMTP 服务器参数等)
    c.execute('''CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )''')

    # 平滑热补丁已有数据表字段（防止旧数据库报错）
    def try_add_column(sql):
        try:
            c.execute(sql)
            conn.commit()
        except Exception:
            pass

    try_add_column("ALTER TABLE users ADD COLUMN status INTEGER DEFAULT 1")
    try_add_column("ALTER TABLE users ADD COLUMN is_verified INTEGER DEFAULT 1")
    try_add_column("ALTER TABLE users ADD COLUMN serverchan_key TEXT DEFAULT ''")
    try_add_column("ALTER TABLE users ADD COLUMN notify_type TEXT DEFAULT 'email'")

    # 默认管理员种子逻辑
    c.execute("SELECT id FROM users WHERE role='admin'")
    existing_admin = c.fetchone()
    if not existing_admin:
        admin_user = os.getenv("ADMIN_USERNAME") or "admin"
        admin_pwd = os.getenv("ADMIN_PASSWORD") or secrets.token_urlsafe(12)
        ten_years = (datetime.datetime.now() + datetime.timedelta(days=3650)).strftime("%Y-%m-%d %H:%M:%S")
        c.execute("INSERT INTO users (username, password_hash, uuid, email, traffic_limit_mb, expire_date, role, status, is_verified) VALUES (?, ?, ?, ?, 1048576, ?, 'admin', 1, 1)",
                  (admin_user, hash_pwd(admin_pwd), str(uuid.uuid4()), f"{admin_user}@system.local", ten_years))
        conn.commit()
        print(f"[Init] 首次部署完成！已为您自动生成初始管理员凭据：\n账号: {admin_user}\n密码: {admin_pwd}\n", flush=True)

    conn.commit()
    conn.close()

# 系统设置存取辅助函数
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