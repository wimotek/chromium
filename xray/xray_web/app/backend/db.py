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
        email TEXT NOT NULL,
        traffic_limit_mb INTEGER DEFAULT 1024,
        expire_date TEXT NOT NULL,
        role TEXT DEFAULT 'user'
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
    
    # 3. 检查系统是否已有管理员
    c.execute("SELECT id FROM users WHERE role='admin'")
    existing_admin = c.fetchone()
    
    # 仅当库内完全没有管理员时，才触发首次生成
    if not existing_admin:
        # 如果环境变量指定了就用指定的，否则自动随机生成
        admin_user = os.getenv("ADMIN_USERNAME") or "admin"
        admin_pwd = os.getenv("ADMIN_PASSWORD") or secrets.token_urlsafe(12)
        
        ten_years = (datetime.datetime.now() + datetime.timedelta(days=3650)).strftime("%Y-%m-%d %H:%M:%S")
        c.execute("INSERT INTO users VALUES (NULL, ?, ?, ?, ?, 1048576, ?, 'admin')",
                  (admin_user, hash_pwd(admin_pwd), str(uuid.uuid4()), admin_user, ten_years))
        conn.commit()
        
        # 格式化打印到控制台日志，方便 docker compose logs 随时查看
        info_banner = f"""
======================================================
🎉 [Init] 首次部署完成！已为您自动生成初始管理员凭据：
管理后台账号: {admin_user}
管理后台密码: {admin_pwd}
======================================================
"""
        print(info_banner, flush=True)
        
        # 同时追加写入 /data/client_info.txt 持久化备查
        try:
            with open("/data/client_info.txt", "a", encoding="utf-8") as f:
                f.write(f"\nWeb 管理后台初始账号: {admin_user}\nWeb 管理后台初始密码: {admin_pwd}\n")
        except Exception:
            pass

    conn.commit()
    conn.close()