import sqlite3
import secrets
from datetime import datetime
from config import DB_PATH, INIT_USERNAME, INIT_PASSWORD

def get_db_connection() -> sqlite3.Connection:
    """生产级高并发 SQLite 连接工厂：启用 WAL 预写日志与 15 秒互斥超时缓冲"""
    conn = sqlite3.connect(DB_PATH, timeout=15.0)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA busy_timeout=5000;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    return conn

def init_db_and_jwt():
    """
    服务启动初始化与一次性平滑升级补丁引擎：
    由 app.py 启动时统一调用一次，集中管理表结构热升级，业务代码严禁堆砌迁移补丁。
    """
    from core.security import hash_password

    conn = get_db_connection()
    cur = conn.cursor()
    
    # 1. 基础节点表 (标准完整架构)
    cur.execute('''CREATE TABLE IF NOT EXISTS nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        group_name TEXT DEFAULT '默认分组',
        enabled INTEGER DEFAULT 1,
        approval_status INTEGER DEFAULT 1,     -- 1: 已授权信任入网, 0: TOFU 待认领
        conn_type TEXT DEFAULT 'direct',       -- 'direct' 直连, 'ssh' 远程, 'reverse' NAT4反向隧道
        node_uuid TEXT DEFAULT '',             -- 节点容器持久化唯一标识
        fingerprint TEXT DEFAULT '',           -- wimotek-edge-agent 证书指纹
        created_at TEXT DEFAULT '',            -- 节点首见接入时间戳
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
        last_sync TEXT,
        network_mode TEXT DEFAULT '',
        recommended_endpoint TEXT DEFAULT '',
        ipv4_reachable INTEGER DEFAULT 0,
        ipv6_reachable INTEGER DEFAULT 0
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

    # 集中式一次性补丁迁移区：自动补全历史数据库缺失字段
    cur.execute("PRAGMA table_info(nodes)")
    existing_node_cols = {col[1] for col in cur.fetchall()}
    
    node_patches = [
        ("approval_status", "INTEGER DEFAULT 1"),
        ("conn_type", "TEXT DEFAULT 'direct'"),
        ("node_uuid", "TEXT DEFAULT ''"),
        ("fingerprint", "TEXT DEFAULT ''"),
        ("created_at", "TEXT DEFAULT ''"),
        ("enabled", "INTEGER DEFAULT 1"),
        ("group_name", "TEXT DEFAULT '默认分组'"),
        ("direct_host", "TEXT DEFAULT '127.0.0.1'"),
        ("auto_tunnel", "INTEGER DEFAULT 1"),
        ("cookie_count", "INTEGER DEFAULT 0"),
        ("network_mode", "TEXT DEFAULT ''"),
        ("recommended_endpoint", "TEXT DEFAULT ''"),
        ("ipv4_reachable", "INTEGER DEFAULT 0"),
        ("ipv6_reachable", "INTEGER DEFAULT 0")
    ]

    for col_name, col_def in node_patches:
        if col_name not in existing_node_cols:
            try:
                cur.execute(f"ALTER TABLE nodes ADD COLUMN {col_name} {col_def}")
            except Exception:
                pass

    # 兼容性自愈补丁：清理历史数据库遗留的 local_bind_port 显式唯一索引（若存在）
    try:
        cur.execute("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='nodes' AND sql LIKE '%local_bind_port%'")
        for (idx_name,) in cur.fetchall():
            if "autoindex" not in idx_name:
                cur.execute(f"DROP INDEX IF EXISTS {idx_name}")
    except Exception:
        pass

    cur.execute("PRAGMA table_info(sync_logs)")
    existing_log_cols = {col[1] for col in cur.fetchall()}
    for col_name, col_def in [
        ("source_node", "TEXT DEFAULT ''"),
        ("target_nodes", "TEXT DEFAULT ''"),
        ("cookie_count", "INTEGER DEFAULT 0"),
        ("duration", "TEXT DEFAULT ''")
    ]:
        if col_name not in existing_log_cols:
            try:
                cur.execute(f"ALTER TABLE sync_logs ADD COLUMN {col_name} {col_def}")
            except Exception:
                pass

    cur.execute("SELECT count(*) FROM sync_policies")
    if cur.fetchone()[0] == 0:
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        cur.execute('''INSERT INTO sync_policies 
            (name, enabled, interval_minutes, sync_type, source_type, source_id, source_group, target_type, target_ids, target_group, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
            ("默认全网智能双向合并", 1, 15, "smart_merge", "all", 0, "", "all", "[]", "", now_str))

    initial_join_token = "hub_join_" + secrets.token_urlsafe(24)

    defaults = {
        'admin_username': INIT_USERNAME,
        'admin_password': hash_password(INIT_PASSWORD),
        'jwt_secret': secrets.token_hex(32),
        'edge_agent_secret': secrets.token_urlsafe(32),
        'api_key': 'cdp_' + secrets.token_urlsafe(24),
        'cluster_join_token': initial_join_token,
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
        'tofu_enabled': '1',                  # 1: 允许无 Token 的未知设备通过 TOFU 上报接入; 0: 关闭 TOFU
        'tofu_auto_approve': '0',             # 1: 开启全自动免审放行; 0: 必须人工认领
        'tofu_timeout_notify_minutes': '10',  # 待审挂起超 10 分钟自动预警
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
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT value FROM settings WHERE key=?", (key,))
    row = cur.fetchone()
    conn.close()
    return row[0] if row else default

def set_setting(key: str, value: str):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, str(value)))
    conn.commit()
    conn.close()