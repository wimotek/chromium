import os
import sys
import re
import json
import time
import random
import datetime
import calendar
import urllib.parse

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from flask import g, has_request_context
from sqlalchemy import or_, select
from config import Config
from core.cache import cache
from core.db import db_session, hash_pwd
from core.models import User
from core.rate_limit import ban_ip, check_ip_ban, get_client_ip, is_whitelisted_ip

HEARTBEAT_ONLINE_SEC = 135
_HB_RECOVERABLE_PROBE_CODES = frozenset({
    "offline",
    "heartbeat_lost",
    "xray_unhealthy",
    "tunnel_disconnected",
})


def parse_agent_health(raw) -> dict | None:
    if isinstance(raw, dict):
        return raw
    if not raw or not isinstance(raw, str):
        return None
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        return None


def parse_last_probe(raw) -> dict | None:
    if isinstance(raw, dict):
        return raw
    if not raw or not isinstance(raw, str):
        return None
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        return None


def compute_heartbeat_age_sec(
    node_dict: dict,
    now_ts: float | None = None,
    now_dt: datetime.datetime | None = None,
) -> int | None:
    if now_ts is None:
        now_ts = time.time()
    hb_ts = float(node_dict.get("last_heartbeat_ts") or 0.0)
    if hb_ts > 0:
        return max(0, int(now_ts - hb_ts))

    last_hb = (node_dict.get("last_heartbeat") or "").strip()
    if not last_hb or "等待" in last_hb or "下线" in last_hb:
        return None
    try:
        if now_dt is None:
            now_dt = datetime.datetime.now()
        hb_dt = datetime.datetime.strptime(last_hb, "%Y-%m-%d %H:%M:%S")
        return max(0, int((now_dt - hb_dt).total_seconds()))
    except Exception:
        return None


def evaluate_node_sub_health(
    node_dict: dict,
    now_ts: float | None = None,
    now_dt: datetime.datetime | None = None,
) -> tuple[bool, str, str]:
    """
    判定节点是否满足订阅下发健康条件（仅基于心跳新鲜度、节点自检状态、手动测活记录）：
    返回 (eligible, status_code, reason)。
    """
    if now_ts is None:
        now_ts = time.time()
    if now_dt is None:
        now_dt = datetime.datetime.now()

    if int(node_dict.get("status", 1)) != 1:
        return False, "disabled", "节点已被管理员停用"
    if int(node_dict.get("is_approved", 1)) != 1:
        return False, "pending", "节点尚未审批通过"

    hb_age = compute_heartbeat_age_sec(node_dict, now_ts, now_dt)
    if hb_age is None:
        return False, "heartbeat_lost", "节点尚未上报有效心跳"
    if hb_age > HEARTBEAT_ONLINE_SEC:
        return False, "heartbeat_lost", f"节点心跳超时 ({hb_age}秒未响应)"

    net_mode = node_dict.get("net_mode") or "direct"
    core_label = "Sing-box" if str(node_dict.get("core_type") or "xray").lower() == "singbox" else "Xray"
    agent_health = parse_agent_health(node_dict.get("agent_health"))
    if agent_health:
        if agent_health.get("xray_alive") is False or agent_health.get("core_alive") is False:
            return False, "xray_unhealthy", f"节点自检上报 {core_label} 进程未运行"
        if agent_health.get("port_ready") is False:
            return False, "xray_unhealthy", "节点自检上报代理监听端口未就绪"
        if net_mode == "reverse_wss" and agent_health.get("tunnel_connected") is False:
            return False, "tunnel_disconnected", "节点自检上报 WSS 反向隧道未连接"

    if net_mode == "reverse_wss" and str(node_dict.get("tunnel_status") or "").lower() == "disconnected":
        return False, "tunnel_disconnected", "WSS 反向隧道已断开"

    last_probe = parse_last_probe(node_dict.get("last_probe"))
    if last_probe and last_probe.get("healthy") is False:
        probe_code = str(last_probe.get("status_code") or "offline")
        probe_ts = float(last_probe.get("ts") or 0.0)
        hb_ts = float(node_dict.get("last_heartbeat_ts") or 0.0)
        # 若此前测活失败原因是心跳/进程/隧道类，且在测活之后又收到了新的健康心跳，则自动视为已恢复
        if probe_code in _HB_RECOVERABLE_PROBE_CODES and hb_ts > probe_ts:
            return True, "online", "正常"
        probe_reason = str(last_probe.get("reason") or "手动测活未通过")
        return False, probe_code, f"手动测活异常：{probe_reason}"

    return True, "online", "正常"


def is_node_healthy_for_sub(
    node_dict: dict,
    now_ts: float | None = None,
    now_dt: datetime.datetime | None = None,
) -> bool:
    eligible, _, _ = evaluate_node_sub_health(node_dict, now_ts=now_ts, now_dt=now_dt)
    return eligible


def check_admin(u: str, p: str) -> bool:
    if not u or not p:
        return False

    if has_request_context():
        admin_cache = getattr(g, "_admin_auth_cache", None)
        if isinstance(admin_cache, dict) and (u, p) in admin_cache:
            return admin_cache[(u, p)]

    ip = get_client_ip() if has_request_context() else ""
    whitelisted = bool(ip and is_whitelisted_ip(ip))
    if ip and not whitelisted:
        banned, _, _ = check_ip_ban(ip)
        if banned:
            return False

    fail_key = f"rl:admin_auth_fail:{ip}" if (ip and not whitelisted) else ""
    if fail_key:
        try:
            fails = cache.get(fail_key)
            if fails is not None and int(fails) >= 20:
                return False
        except Exception:
            pass

    with db_session(readonly=True) as s:
        role = s.scalar(
            select(User.role).where(
                or_(User.username == u, User.email == u),
                User.password_hash == hash_pwd(p),
            )
        )
    ok = role == "admin"
    if fail_key:
        try:
            if ok:
                cache.delete(fail_key)
            else:
                new_fails = int(cache.incr_with_ttl(fail_key, ttl=600))
                if new_fails >= 20:
                    ban_ip(ip, duration_seconds=1800, reason="后台管理接口高频鉴权失败")
        except Exception:
            pass
    if has_request_context():
        admin_cache = getattr(g, "_admin_auth_cache", None)
        if not isinstance(admin_cache, dict):
            admin_cache = {}
            g._admin_auth_cache = admin_cache
        admin_cache[(u, p)] = ok
    return ok


def is_user_allowed_for_node(user: dict, node: dict) -> bool:
    if int(node.get("status", 1)) != 1:
        return False

    if int(node.get("allow_all", 1)) == 1:
        return True

    raw_groups = str(node.get("allowed_groups") or "")
    allowed_groups = [g.strip().lower() for g in re.split(r'[,;\s]+', raw_groups) if g.strip()]
    u_group = str(user.get("user_group") or "default").strip().lower()
    if u_group and u_group in allowed_groups:
        return True

    raw_users = str(node.get("allowed_users") or "")
    allowed_users = [u.strip().lower() for u in re.split(r'[,;\s]+', raw_users) if u.strip()]
    uname = str(user.get("username") or "").strip().lower()
    uemail = str(user.get("email") or "").strip().lower()

    if uname and uname in allowed_users:
        return True
    if uemail and uemail in allowed_users:
        return True

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
    Config.reload_if_changed()
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
    if node.get("net_mode") == "reverse_wss":
        default_p = Config.PUBLIC_PORT if Config.PUBLIC_PORT > 0 else 443
        hub_host, parsed_port = extract_host_and_port(hub_domain or "hub.example.com", default_port=default_p)
        effective_port = int(hub_port) if hub_port else (Config.PUBLIC_PORT if Config.PUBLIC_PORT > 0 else parsed_port)
        ws_path = urllib.parse.quote(f"/api/tunnel/bridge/{node['node_id']}")
        return (
            f"vless://{uuid_str}@{hub_host}:{effective_port}"
            f"?security=tls&encryption=none&headerType=none&type=ws&host={hub_host}&path={ws_path}&sni={hub_host}#{urllib.parse.quote(remark + ' [WSS反穿]')}"
        )

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


def build_hy2_link(uuid_str: str, node: dict, remark: str) -> str | None:
    """为启用了 Hysteria2 UDP 的 sing-box 公网直连节点生成 hysteria2:// 分享链接"""
    if (node.get("net_mode") or "direct") == "reverse_wss":
        return None
    if str(node.get("core_type") or "xray").lower() != "singbox":
        return None
    if int(node.get("hy2_enabled") or 0) != 1:
        return None

    hy2_port = int(node.get("hy2_port") or 0)
    if hy2_port <= 0 or hy2_port > 65535:
        return None

    agent_health = parse_agent_health(node.get("agent_health"))
    if agent_health and agent_health.get("hy2_ready") is False:
        return None

    raw_host = str(node.get("ip") or "").strip()
    if not raw_host:
        return None
    formatted_host = f"[{raw_host}]" if (":" in raw_host and not raw_host.startswith("[")) else raw_host
    snis = get_node_snis(node)
    hy2_sni = str(node.get("hy2_sni") or "").strip() or (snis[0] if snis else "www.bing.com")
    insecure = 1 if int(node.get("hy2_insecure", 1) or 0) != 0 else 0
    return (
        f"hysteria2://{uuid_str}@{formatted_host}:{hy2_port}"
        f"?sni={urllib.parse.quote(hy2_sni, safe='')}&insecure={insecure}"
        f"#{urllib.parse.quote(remark + ' [Hy2-UDP]')}"
    )
