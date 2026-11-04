import sqlite3
import secrets
from datetime import datetime
from config import DB_PATH, INIT_USERNAME, INIT_PASSWORD

def init_db_and_jwt():
    from core.security import hash_password

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    
    # 1. 节点表 (包含 enabled 开关)
    cur.execute('''CREATE TABLE IF NOT EXISTS nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        group_name TEXT DEFAULT '默认分组',
        enabled INTEGER DEFAULT 1,
        is_source INTEGER DEFAULT 0,
        is_local INTEGER DEFAULT 0,
        direct_host TEXT DEFAULT '127.0.0.1',
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

    # 2. 多策略管理表
    cur.execute('''CREATE TABLE IF NOT EXISTS sync_policies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        interval_minutes INTEGER DEFAULT 15,
        sync_type TEXT DEFAULT 'smart_merge',
        source_type TEXT DEFAULT 'node',
        source_id INTEGER DEFAULT 0,
        source_group TEXT DEFAULT '',
        target_type TEXT DEFAULT 'all',
        target_ids TEXT DEFAULT '[]',
        target_group TEXT DEFAULT '',
        last_run TEXT,
        created_at TEXT
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

    # 增量字段平滑自动迁移
    for col, col_type in [
        ("enabled", "INTEGER DEFAULT 1"),
        ("group_name", "TEXT DEFAULT '默认分组'"),
        ("direct_host", "TEXT DEFAULT '127.0.0.1'"),
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

    # 首次自动补齐默认策略
    cur.execute("SELECT count(*) FROM sync_policies")
    if cur.fetchone()[0] == 0:
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        cur.execute('''INSERT INTO sync_policies 
            (name, enabled, interval_minutes, sync_type, source_type, source_id, source_group, target_type, target_ids, target_group, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
            ("默认全网智能双向合并", 1, 15, "smart_merge", "all", 0, "", "all", "[]", "", now_str))

    defaults = {
        'admin_username': INIT_USERNAME,
        'admin_password': hash_password(INIT_PASSWORD),
        'jwt_secret': secrets.token_hex(32),
        'api_key': 'cdp_' + secrets.token_urlsafe(24),
        'direct_port_access_enabled': '1',
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