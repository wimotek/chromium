import os
import sys
import re
import random
import datetime
import calendar

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

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

# 核心：节点权限判定器 (判断某个用户是否有权限连接或看到该节点)
def is_user_allowed_for_node(user: dict, node: dict) -> bool:
    # 1. 节点若被禁用 (status=0)，对任何普通用户彻底关闭且不显示
    if int(node.get("status", 1)) != 1:
        return False

    # 2. 若设为“全部用户可用” (allow_all=1)
    if int(node.get("allow_all", 1)) == 1:
        return True

    # 3. 检查特定用户组匹配
    raw_groups = str(node.get("allowed_groups") or "")
    allowed_groups = [g.strip().lower() for g in re.split(r'[,;\s]+', raw_groups) if g.strip()]
    u_group = str(user.get("user_group") or "default").strip().lower()
    if u_group and u_group in allowed_groups:
        return True

    # 4. 检查特定单个用户匹配 (用户名 或 邮箱)
    raw_users = str(node.get("allowed_users") or "")
    allowed_users = [u.strip().lower() for u in re.split(r'[,;\s]+', raw_users) if u.strip()]
    uname = str(user.get("username") or "").strip().lower()
    uemail = str(user.get("email") or "").strip().lower()

    if uname and uname in allowed_users:
        return True
    if uemail and uemail in allowed_users:
        return True

    # 5. 管理员账号拥有穿透调试权限
    if str(user.get("role", "")).lower() == "admin":
        return True

    return False

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

import urllib.parse

def build_node_link(uuid_str: str, node: dict, remark: str, chosen_sni: str = None, hub_domain: str = None) -> str:
    # 模式判断：如果是 NAT4 WSS 反向穿透节点，客户端连接 Hub 的域名与 WSS 路径
    if node.get("net_mode") == "reverse_wss":
        hub_host = (hub_domain or "hub.example.com").split(":")[0]
        ws_path = urllib.parse.quote(f"/api/tunnel/bridge/{node['node_id']}")
        return (
            f"vless://{uuid_str}@{hub_host}:443"
            f"?security=tls&encryption=none&headerType=none&type=ws&host={hub_host}&path={ws_path}&sni={hub_host}#{urllib.parse.quote(remark + ' [WSS反穿]')}"
        )

    # 默认模式：公网直连 (Reality)
    snis = get_node_snis(node)
    sni = chosen_sni if (chosen_sni and chosen_sni in snis) else random.choice(snis)
    clean_sni = sni.split(":")[0]
    return (
        f"vless://{uuid_str}@{node['ip']}:{node['port']}"
        f"?security=reality&encryption=none&pbk={node['pbk']}&headerType=none&fp=chrome"
        f"&type=tcp&flow=xtls-rprx-vision&sni={clean_sni}&sid={node['sid']}#{urllib.parse.quote(remark)}"
    )