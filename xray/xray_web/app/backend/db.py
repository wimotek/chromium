import sqlite3
import hashlib
import datetime
import uuid
import os
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
    c.execute('''CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        uuid TEXT NOT NULL,
        email TEXT NOT NULL,
        traffic_limit_mb INTEGER DEFAULT 1024,
        expire_date TEXT NOT NULL,
        role TEXT DEFAULT 'user'
    )''')
    c.execute('''CREATE TABLE IF NOT EXISTS cards (
        code TEXT PRIMARY KEY,
        traffic_gb INTEGER NOT NULL,
        days INTEGER NOT NULL,
        is_used INTEGER DEFAULT 0,
        used_by TEXT,
        created_at TEXT NOT NULL
    )''')
    # 初始化内置管理员
    c.execute("SELECT * FROM users WHERE username='admin'")
    if not c.fetchone():
        ten_years = (datetime.datetime.now() + datetime.timedelta(days=3650)).strftime("%Y-%m-%d %H:%M:%S")
        c.execute("INSERT INTO users VALUES (NULL, ?, ?, ?, ?, 1048576, ?, 'admin')",
                  ('admin', hash_pwd('admin123456'), str(uuid.uuid4()), 'admin', ten_years))
    conn.commit()
    conn.close()