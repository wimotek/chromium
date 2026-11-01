import os
import sys
import re
import random
import datetime
import calendar

# 确保 backend 根路径优先被 Python 解释器识别
BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

# 核心修正：严格按照分层目录从 core.db 引入
from core.db import get_db, hash_pwd

def check_admin(u: str, p: str) -> bool:
    if not u or not p:
        return False
    conn = get_db()
    c = conn.cursor()
    c.execute("SELECT role FROM users WHERE (username=? OR email=?) AND password_hash=?", (u, u, hash_pwd(p)))
    r = c.fetchone()
    conn.close()
    return bool(r and r['role'] == 'admin')

def normalize_expire_date(raw_str: str) -> str:
    s = (raw_str or "").strip()
    if not s or s.startswith("2099"):
        return "2099-12-31 23:59:59"

    s = re.sub(r'[./_年月份]', '-', s)
    s = s.replace('日', '')
    s = re.sub(r'\s+', ' ', s).strip()

    match = re.search(r'(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?', s)
    if not match:
        return (datetime.datetime.now() + datetime.timedelta(days=30)).strftime("%Y-%m-%d 23:59:59")

    year = int(match.group(1))
    month = max(1, min(12, int(match.group(2))))
    max_days = calendar.monthrange(year, month)[1]
    day = max(1, min(max_days, int(match.group(3))))

    if match.group(4) is not None:
        hh = max(0, min(23, int(match.group(4))))
        mm = max(0, min(59, int(match.group(5) or 0)))
        ss = max(0, min(59, int(match.group(6) or 0)))
    else:
        hh, mm, ss = 23, 59, 59

    return f"{year:04d}-{month:02d}-{day:02d} {hh:02d}:{mm:02d}:{ss:02d}"

def get_node_snis(node: dict) -> list[str]:
    raw = node.get("server_names") or node.get("sni") or "www.microsoft.com"
    snis = []
    for part in re.split(r'[,;\s]+', str(raw)):
        clean = part.strip().split(":")[0]
        if clean and clean not in snis:
            snis.append(clean)
    return snis if snis else ["www.microsoft.com"]

def build_node_link(uuid_str: str, node: dict, remark: str, chosen_sni: str = None) -> str:
    snis = get_node_snis(node)
    sni = chosen_sni if (chosen_sni and chosen_sni in snis) else random.choice(snis)
    clean_sni = sni.split(":")[0]
    return (
        f"vless://{uuid_str}@{node['ip']}:{node['port']}"
        f"?security=reality&encryption=none&pbk={node['pbk']}&headerType=none&fp=chrome"
        f"&type=tcp&flow=xtls-rprx-vision&sni={clean_sni}&sid={node['sid']}#{remark}"
    )