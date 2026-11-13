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
from config import Config

def extract_host_and_port(raw_host: str, default_host: str = "hub.example.com", default_port: int = 443) -> tuple[str, int]:
    """Safely parse host[:port] supporting hostnames, IPv4, [IPv6]:port, and bare IPv6."""
    s = (raw_host or "").strip()
    if not s:
        return default_host, default_port
    if s.startswith("["):
        end_idx = s.find("]")
        if end_idx != -1:
            host_part = s[:end_idx + 1]
            rest = s[end_idx + 1:].strip()
            if rest.startswith(":") and rest[1:].isdigit():
                return host_part, int(rest[1:])
            return host_part, default_port
    if s.count(":") == 1:
        h, p = s.split(":", 1)
        if p.isdigit():
            return h or default_host, int(p)
        return h or default_host, default_port
    if ":" in s:
        return f"[{s}]", default_port
    return s, default_port

def extract_host(raw_host: str, default: str = "hub.example.com") -> str:
    """Safely extract hostname or bracketed IPv6 literal from a host[:port] header."""
    host, _ = extract_host_and_port(raw_host, default_host=default)
    return host

def resolve_public_endpoint(req=None) -> tuple[str, int, str]:
    """
    智能解析主控对外可访问的 (hub_host, hub_port, base_url):
    1. 若显式配置 PUBLIC_URL (如 https://panel.example.com:3000)，直接以其为准
    2. 否则自动从 X-Forwarded-* / request.host 中提取用户实际访问的主机与映射端口 (如 -p 3000:8443 场景下的 3000)
    3. 若设置了 PUBLIC_PORT > 0，强制覆盖对外端口号
    """
    if Config.PUBLIC_URL:
        parsed = urllib.parse.urlsplit(Config.PUBLIC_URL)
        scheme = parsed.scheme or "https"
        default_p = 443 if scheme == "https" else 80
        host, port = extract_host_and_port(parsed.netloc, default_port=default_p)
        if Config.PUBLIC_PORT > 0:
            port = Config.PUBLIC_PORT
        base_url = f"{scheme}://{host}" if ((scheme == "https" and port == 443) or (scheme == "http" and port == 80)) else f"{scheme}://{host}:{port}"
        return host, port, base_url

    scheme = (req.scheme if req else "https") or "https"
    default_p = 443 if scheme == "https" else 80
    raw_host = (req.host if req else "") or ""

    if req is not None:
        fwd_host = (req.headers.get("X-Forwarded-Host") or "").split(",")[0].strip()
        if fwd_host:
            raw_host = fwd_host
        fwd_port = (req.headers.get("X-Forwarded-Port") or "").split(",")[0].strip()
        if fwd_port.isdigit():
            default_p = int(fwd_port)

    host, port = extract_host_and_port(raw_host, default_port=default_p)
    if Config.PUBLIC_PORT > 0:
        port = Config.PUBLIC_PORT

    is_standard = (scheme == "https" and port == 443) or (scheme == "http" and port == 80)
    base_url = f"{scheme}://{host}" if is_standard else f"{scheme}://{host}:{port}"
    return host, port, base_url

def build_node_link(uuid_str: str, node: dict, remark: str, chosen_sni: str = None, hub_domain: str = None, hub_port: int = None) -> str:
    # 模式判断：如果是 NAT4 WSS 反向穿透节点，客户端连接 Hub 的对外域名与映射端口
    if node.get("net_mode") == "reverse_wss":
        default_p = Config.PUBLIC_PORT if Config.PUBLIC_PORT > 0 else 443
        hub_host, parsed_port = extract_host_and_port(hub_domain or "hub.example.com", default_port=default_p)
        effective_port = int(hub_port) if hub_port else (Config.PUBLIC_PORT if Config.PUBLIC_PORT > 0 else parsed_port)
        ws_path = urllib.parse.quote(f"/api/tunnel/bridge/{node['node_id']}")
        return (
            f"vless://{uuid_str}@{hub_host}:{effective_port}"
            f"?security=tls&encryption=none&headerType=none&type=ws&host={hub_host}&path={ws_path}&sni={hub_host}#{urllib.parse.quote(remark + ' [WSS反穿]')}"
        )

    # 默认模式：公网直连 (Reality)
    snis = get_node_snis(node)
    sni = chosen_sni if (chosen_sni and chosen_sni in snis) else random.choice(snis)
    clean_sni = sni.split(":")[0]
    raw_host = str(node['ip']).strip()
    formatted_host = f"[{raw_host}]" if (":" in raw_host and not raw_host.startswith("[")) else raw_host
    return (
        f"vless://{uuid_str}@{formatted_host}:{node['port']}"
        f"?security=reality&encryption=none&pbk={node['pbk']}&headerType=none&fp=chrome"
        f"&type=tcp&flow=xtls-rprx-vision&sni={clean_sni}&sid={node['sid']}#{urllib.parse.quote(remark)}"
    )