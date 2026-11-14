"""
Windows 边缘节点 WSS 代理核心引擎 (兼容 chromium_sync Hub 协议):
- 纯 Python (cryptography) 生成自签名 TLS 证书，无需系统预装 OpenSSL CLI
- 集成 CookieGuard 边缘防火墙：在 Cookie 离开本机前按 all / whitelist / blacklist / block_export 过滤
- 完整支持 public_wss (双栈/IPv4 加密 WSS 入站) 与 reverse (/api/nodes/reverse-tunnel 出站穿透)
- 支持多路复用 CDP WebSocket 流、SessionTicket 持久化与结构化滚动日志
"""

import asyncio
import datetime
import fnmatch
import hashlib
import ipaddress
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import secrets
import socket
import ssl
import time
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import quote
import uuid

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
import httpx
import websockets

from cookie_guard import CookieGuard, CookieGuardConfig


def get_app_data_dir() -> Path:
    base = os.getenv("APPDATA") or os.getenv("LOCALAPPDATA") or str(Path.home())
    if os.name != "nt":
        d = Path.home() / ".wimotek_edge_node"
    else:
        d = Path(base) / "WimotekEdgeNode"
    d.mkdir(parents=True, exist_ok=True)
    return d


def get_log_file_path() -> Path:
    log_dir = get_app_data_dir() / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    return log_dir / "agent.log"


def read_recent_logs(max_lines: int = 300) -> List[Tuple[str, str]]:
    log_file = get_log_file_path()
    if not log_file.exists():
        return []
    try:
        lines = log_file.read_text(encoding="utf-8", errors="replace").splitlines()
        out: List[Tuple[str, str]] = []
        for ln in lines[-max_lines:]:
            lvl = "INFO"
            if "[GUARD]" in ln:
                lvl = "GUARD"
            elif "[ERROR]" in ln:
                lvl = "ERROR"
            elif "[WARNING]" in ln or "[WARN]" in ln:
                lvl = "WARNING"
            out.append((lvl, ln))
        return out
    except Exception:
        return []


def clear_log_file() -> None:
    log_file = get_log_file_path()
    try:
        if log_file.exists():
            log_file.write_text("", encoding="utf-8")
    except Exception:
        pass


def append_disk_log(level: str, message: str) -> str:
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    lvl = level.upper()
    line = f"{ts} [{lvl}] {message}"
    try:
        log_file = get_log_file_path()
        with log_file.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass
    return line


def build_agent_logger(
    log_callback: Optional[Callable[[str, str], None]] = None,
) -> logging.Logger:
    log_file = get_log_file_path()

    logger = logging.getLogger("WimotekWinEdge")
    logger.setLevel(logging.INFO)
    logger.propagate = False
    logger.handlers.clear()

    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", "%Y-%m-%d %H:%M:%S")
    fh = RotatingFileHandler(str(log_file), maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8")
    fh.setFormatter(fmt)
    logger.addHandler(fh)

    if log_callback is not None:
        class _UiHandler(logging.Handler):
            def emit(self, record: logging.LogRecord):
                try:
                    msg = self.format(record)
                    log_callback(record.levelname, msg)
                except Exception:
                    pass

        uh = _UiHandler()
        uh.setFormatter(fmt)
        logger.addHandler(uh)

    return logger


def ensure_identity(data_dir: Path, configured_name: str = "") -> Tuple[str, str, str]:
    data_dir.mkdir(parents=True, exist_ok=True)
    id_file = data_dir / "identity.json"
    env_name = (configured_name or "").strip()

    if id_file.exists():
        try:
            d = json.loads(id_file.read_text(encoding="utf-8"))
            if not env_name or d.get("node_uuid") == env_name:
                sec = (d.get("edge_wss_secret") or "").strip()
                if not sec:
                    sec = secrets.token_urlsafe(32)
                    d["edge_wss_secret"] = sec
                    id_file.write_text(json.dumps(d, indent=2), encoding="utf-8")
                return d["node_uuid"], d["fingerprint"], sec
        except Exception:
            pass

    if env_name:
        node_uuid = env_name
    else:
        host = socket.gethostname() or uuid.uuid4().hex[:8]
        node_uuid = f"Win-{host}"

    raw_key = f"{node_uuid}-{uuid.uuid4()}"
    fingerprint = f"sha256:{hashlib.sha256(raw_key.encode('utf-8')).hexdigest()[:32]}"
    edge_wss_secret = secrets.token_urlsafe(32)

    try:
        id_file.write_text(
            json.dumps(
                {
                    "node_uuid": node_uuid,
                    "fingerprint": fingerprint,
                    "edge_wss_secret": edge_wss_secret,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
    except Exception:
        pass

    return node_uuid, fingerprint, edge_wss_secret


def load_session_ticket(data_dir: Path) -> Optional[str]:
    tf = data_dir / "session_ticket.txt"
    if tf.exists():
        try:
            val = tf.read_text(encoding="utf-8").strip()
            return val or None
        except Exception:
            return None
    return None


def save_session_ticket(data_dir: Path, ticket: Optional[str]) -> None:
    if not ticket:
        return
    tf = data_dir / "session_ticket.txt"
    try:
        tf.write_text(ticket.strip(), encoding="utf-8")
    except Exception:
        pass


def _ensure_self_signed_tls(data_dir: Path, extra_dns_names: Optional[List[str]] = None) -> ssl.SSLContext:
    cert_dir = data_dir / "certs"
    cert_dir.mkdir(parents=True, exist_ok=True)
    cert_file = cert_dir / "edge_wss.crt"
    key_file = cert_dir / "edge_wss.key"
    san_meta = cert_dir / "san_domains.txt"

    clean_dns = sorted({d.strip().lower() for d in (extra_dns_names or []) if d and d.strip()})
    want_meta = ",".join(clean_dns)
    prev_meta = san_meta.read_text(encoding="utf-8").strip() if san_meta.exists() else ""

    if not cert_file.exists() or not key_file.exists() or (clean_dns and prev_meta != want_meta):
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        subject = issuer = x509.Name([
            x509.NameAttribute(NameOID.COMMON_NAME, clean_dns[0] if clean_dns else "wimotek-win-edge"),
        ])
        now = datetime.datetime.now(datetime.timezone.utc)
        san_entries: List[Any] = [
            x509.DNSName("localhost"),
            x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
            x509.IPAddress(ipaddress.ip_address("::1")),
        ]
        for dns_name in clean_dns:
            if dns_name != "localhost":
                san_entries.append(x509.DNSName(dns_name))
        san = x509.SubjectAlternativeName(san_entries)
        cert = (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(issuer)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=3650))
            .add_extension(san, critical=False)
            .sign(key, hashes.SHA256())
        )
        key_file.write_bytes(
            key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.TraditionalOpenSSL,
                encryption_algorithm=serialization.NoEncryption(),
            )
        )
        cert_file.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        san_meta.write_text(want_meta, encoding="utf-8")

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certfile=str(cert_file), keyfile=str(key_file))
    return ctx


def _parse_ip_version(val: str) -> Optional[int]:
    try:
        return ipaddress.ip_address((val or "").strip().strip("[]")).version
    except ValueError:
        return None


def _resolve_domain_ips(domain: str) -> Tuple[Optional[str], Optional[str]]:
    """解析 DDNS/域名对应的 IPv4 与 IPv6 地址"""
    v4: Optional[str] = None
    v6: Optional[str] = None
    try:
        infos = socket.getaddrinfo(domain, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
        for family, _, _, _, sockaddr in infos:
            addr = sockaddr[0]
            if family == socket.AF_INET and not v4:
                v4 = addr
            elif family == socket.AF_INET6 and not v6 and not addr.startswith("fe80:"):
                v6 = addr
    except Exception:
        pass
    return v4, v6


def _detect_egress_ip(family: socket.AddressFamily, probe_target: str) -> Optional[str]:
    sock = socket.socket(family, socket.SOCK_DGRAM)
    try:
        sock.settimeout(0.5)
        sock.connect((probe_target, 80))
        ip = sock.getsockname()[0]
        if ip and not ip.startswith("127.") and ip != "::1":
            return ip
    except Exception:
        return None
    finally:
        sock.close()
    return None


def _detect_public_ipv4_http() -> Optional[str]:
    import urllib.request
    for api in ("https://api.ipify.org", "http://icanhazip.com"):
        try:
            with urllib.request.urlopen(api, timeout=2.0) as resp:
                val = resp.read().decode("utf-8").strip()
                if val and "." in val:
                    return val
        except Exception:
            continue
    return None


def collect_node_endpoints(hub_cfg: Dict[str, Any], ext_wss_port: int) -> Dict[str, Any]:
    raw_host = (hub_cfg.get("public_host") or hub_cfg.get("public_ipv4") or "").strip()
    raw_v6 = (hub_cfg.get("public_ipv6") or "").strip()

    pub_domain: Optional[str] = None
    pub_v4: Optional[str] = None
    pub_v6: Optional[str] = None

    if raw_host:
        ver = _parse_ip_version(raw_host)
        if ver == 4:
            pub_v4 = raw_host.strip("[]")
        elif ver == 6:
            pub_v6 = raw_host.strip("[]")
        else:
            pub_domain = raw_host
            pub_v4, resolved_v6 = _resolve_domain_ips(raw_host)
            if not raw_v6 and resolved_v6:
                pub_v6 = resolved_v6

    if raw_v6:
        ver6 = _parse_ip_version(raw_v6)
        if ver6 == 6:
            pub_v6 = raw_v6.strip("[]")
        elif not pub_domain and ver6 is None:
            pub_domain = raw_v6
            _, res6 = _resolve_domain_ips(raw_v6)
            pub_v6 = res6

    if not pub_v4 and not pub_domain:
        local_v4 = _detect_egress_ip(socket.AF_INET, "8.8.8.8")
        if local_v4:
            try:
                ip_obj = ipaddress.ip_address(local_v4)
                pub_v4 = local_v4 if not (ip_obj.is_private or ip_obj.is_loopback) else (_detect_public_ipv4_http() or local_v4)
            except ValueError:
                pub_v4 = _detect_public_ipv4_http() or local_v4
        else:
            pub_v4 = _detect_public_ipv4_http()

    if not pub_v6 and not pub_domain:
        local_v6 = _detect_egress_ip(socket.AF_INET6, "2001:4860:4860::8888")
        if local_v6 and not local_v6.startswith("fe80:"):
            pub_v6 = local_v6

    return {
        "public_domain": pub_domain,
        "public_ipv4": pub_v4,
        "public_ipv4_port": ext_wss_port if pub_v4 else None,
        "public_ipv6": pub_v6,
        "public_ipv6_port": ext_wss_port if pub_v6 else None,
    }


async def send_cdp_json_command(ws, method: str, params: Optional[dict] = None, req_id: int = 1) -> dict:
    msg: Dict[str, Any] = {"id": req_id, "method": method}
    if params:
        msg["params"] = params
    await ws.send(json.dumps(msg))

    start_t = time.time()
    while time.time() - start_t < 4.0:
        raw_msg = await asyncio.wait_for(ws.recv(), timeout=4.0)
        resp = json.loads(raw_msg)
        if resp.get("id") == req_id:
            return resp.get("result", {})
    return {}


def _ws_connect_local(ws_url: str, **kwargs):
    """连接本机 127.0.0.1 CDP WebSocket，显式绕过系统代理环境变量"""
    try:
        return websockets.connect(ws_url, proxy=None, **kwargs)
    except TypeError:
        return websockets.connect(ws_url, **kwargs)


async def extract_raw_local_cookies(http_client: httpx.AsyncClient, cdp_port: int) -> List[dict]:
    base = f"http://127.0.0.1:{int(cdp_port)}"
    try:
        list_res = await http_client.get(f"{base}/json/list", timeout=3.0)
        pages = [t for t in list_res.json() if t.get("type") == "page" and "webSocketDebuggerUrl" in t]
        if pages:
            async with _ws_connect_local(pages[0]["webSocketDebuggerUrl"], open_timeout=5.0) as page_ws:
                await send_cdp_json_command(page_ws, "Network.enable", req_id=201)
                res_page = await send_cdp_json_command(page_ws, "Network.getAllCookies", req_id=202)
                cookies_p = res_page.get("cookies", [])
                if cookies_p:
                    return cookies_p
    except Exception:
        pass

    try:
        ver_res = await http_client.get(f"{base}/json/version", timeout=3.0)
        ws_url = ver_res.json()["webSocketDebuggerUrl"]
    except httpx.ConnectError as exc:
        raise ConnectionRefusedError(
            f"无法连接本地浏览器 CDP 127.0.0.1:{int(cdp_port)}，请确认调试浏览器已启动且保持独立 Profile 模式"
        ) from exc

    async with _ws_connect_local(ws_url, open_timeout=5.0) as ws:
        try:
            res_storage = await send_cdp_json_command(ws, "Storage.getCookies", req_id=103)
            cookies_s = res_storage.get("cookies", [])
            if cookies_s:
                return cookies_s
        except Exception:
            pass
        await send_cdp_json_command(ws, "Network.enable", req_id=101)
        res_all = await send_cdp_json_command(ws, "Network.getAllCookies", req_id=102)
        return res_all.get("cookies", [])


def _parse_cleanup_terms(raw: Any) -> List[str]:
    if not raw:
        return []
    if isinstance(raw, list):
        items = [str(x).strip() for x in raw]
    else:
        text = str(raw).replace("\r", "\n").replace(";", "\n").replace(",", "\n")
        items = [line.strip() for line in text.split("\n")]
    return list(dict.fromkeys(x.lower() for x in items if x))


def _match_cleanup_domain(dom: str, pat: str) -> bool:
    d = (dom or "").strip().lower().lstrip(".")
    p = (pat or "").strip().lower()
    if not d or not p:
        return False
    if p.startswith("*."):
        base = p[2:].lstrip(".")
        return d == base or d.endswith("." + base)
    if "*" in p:
        return fnmatch.fnmatch(d, p)
    cp = p.lstrip(".")
    return d == cp or d.endswith("." + cp)


def _match_cleanup_kw(text: str, kw: str) -> bool:
    t = (text or "").lower()
    k = (kw or "").strip().lower()
    if not t or not k:
        return False
    return fnmatch.fnmatch(t, k) if "*" in k else (k in t)


def _select_local_cleanup_targets(
    raw_cookies: List[dict],
    exclude_domains: List[str],
    cleanup_rules: Dict[str, Any],
    explicit_targets: List[dict],
) -> List[dict]:
    now = time.time()
    cutoff_ts: Optional[float] = None
    cutoff_raw = str(cleanup_rules.get("expires_before") or "").strip()
    if cutoff_raw:
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d"):
            try:
                cutoff_ts = datetime.datetime.strptime(cutoff_raw, fmt).timestamp()
                break
            except ValueError:
                continue

    try:
        within_days = max(0, int(cleanup_rules.get("expiring_within_days") or 0))
    except Exception:
        within_days = 0

    clean_exc = _parse_cleanup_terms(exclude_domains)
    cleanup_enabled = bool(cleanup_rules.get("enabled"))
    cleanup_doms = _parse_cleanup_terms(cleanup_rules.get("domains")) if cleanup_enabled else []
    cleanup_kws = _parse_cleanup_terms(cleanup_rules.get("keywords")) if cleanup_enabled else []
    kw_scope = str(cleanup_rules.get("keyword_scope") or "name_domain")

    selected: Dict[Tuple[str, str, str], dict] = {}
    for t in explicit_targets or []:
        name = str(t.get("name") or "")
        dom = str(t.get("domain") or "")
        path = str(t.get("path") or "/")
        if name and (dom or t.get("url")):
            item = {"name": name, "path": path}
            if dom:
                item["domain"] = dom
            else:
                item["url"] = str(t.get("url"))
            selected[(name, dom, path)] = item

    for c in raw_cookies:
        name = str(c.get("name") or "")
        dom = str(c.get("domain") or "")
        low_dom = dom.lower().lstrip(".")
        path = str(c.get("path") or "/")
        val = str(c.get("value") or "")
        exp = c.get("expires")
        has_exp = exp is not None and isinstance(exp, (int, float)) and exp > 0

        hit = False
        if clean_exc and any(exc in low_dom or _match_cleanup_domain(low_dom, exc) for exc in clean_exc):
            hit = True
        elif has_exp and exp <= now and cleanup_rules.get("expired", True):
            hit = True
        elif cleanup_enabled:
            if cleanup_doms and any(_match_cleanup_domain(low_dom, pat) for pat in cleanup_doms):
                hit = True
            elif cleanup_rules.get("session_only") and not has_exp:
                hit = True
            elif cutoff_ts is not None and has_exp and exp < cutoff_ts:
                hit = True
            elif within_days > 0 and has_exp and exp <= (now + within_days * 86400):
                hit = True
            elif cleanup_kws:
                fields = [name]
                if kw_scope in ("name_domain", "all"):
                    fields.append(low_dom)
                if kw_scope == "all":
                    fields.append(val)
                if any(_match_cleanup_kw(f, kw) for kw in cleanup_kws for f in fields):
                    hit = True

        if hit and name and dom:
            selected[(name, dom, path)] = {"name": name, "domain": dom, "path": path}

    return list(selected.values())


class WinEdgeAgent:
    """Windows 端 Hub WSS 接入生命周期控制器"""

    def __init__(
        self,
        config: Dict[str, Any],
        log_callback: Optional[Callable[[str, str], None]] = None,
        status_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
    ):
        self.config = config
        self.logger = build_agent_logger(log_callback)
        self.status_callback = status_callback
        self.data_dir = get_app_data_dir()
        self.cookie_guard = CookieGuard(CookieGuardConfig.from_dict(config.get("cookie_guard")))
        self._stop_event: Optional[asyncio.Event] = None

    def update_cookie_guard(self, guard_cfg: Dict[str, Any]):
        self.cookie_guard = CookieGuard(CookieGuardConfig.from_dict(guard_cfg))
        self.logger.info(
            f"[GUARD] Cookie 保护策略已热更新: mode={self.cookie_guard.config.mode}, "
            f"whitelist={len(self.cookie_guard.config.whitelist_domains)}, "
            f"blacklist={len(self.cookie_guard.config.blacklist_domains)}"
        )

    def _emit_status(self, **kwargs):
        if self.status_callback:
            try:
                self.status_callback(kwargs)
            except Exception:
                pass

    async def _handle_cdp_command(
        self,
        ws,
        http_client: httpx.AsyncClient,
        cmd_text: str,
        ws_streams: Dict[str, asyncio.Queue],
        cdp_port: int,
    ):
        try:
            cmd = json.loads(cmd_text)
        except Exception:
            return

        msg_type = cmd.get("type")
        action = cmd.get("action")
        req_id = cmd.get("req_id")
        payload = cmd.get("payload", {})

        if msg_type in {"network_update", "network_probe_result"}:
            self.logger.info(
                f"Hub 网络回传: network_mode={cmd.get('network_mode')}, endpoint={cmd.get('recommended_endpoint')}"
            )
            return

        if msg_type == "cdp_ws_open":
            stream_id = cmd["stream_id"]
            q: asyncio.Queue = asyncio.Queue()
            ws_streams[stream_id] = q
            asyncio.create_task(self._bridge_cdp_ws_stream(ws, stream_id, q, cdp_port))
            return

        if msg_type == "cdp_ws_frame":
            stream_id = cmd.get("stream_id")
            if stream_id in ws_streams:
                await ws_streams[stream_id].put(cmd.get("data", ""))
            return

        if msg_type == "cdp_ws_close":
            stream_id = cmd.get("stream_id")
            q = ws_streams.pop(stream_id, None)
            if q is not None:
                await q.put(None)
            return

        if action == "fetch_cookies":
            try:
                raw_cookies = await extract_raw_local_cookies(http_client, cdp_port)
                filtered, stats = self.cookie_guard.filter_for_export(raw_cookies)
                top_doms = ", ".join(
                    f"{k}({v})" for k, v in sorted(stats.allowed_domains.items(), key=lambda x: -x[1])[:5]
                )
                if self.cookie_guard.config.mode == "whitelist" and not self.cookie_guard.config.whitelist_domains:
                    self.logger.warning(
                        f"[GUARD] 当前为严格白名单模式且白名单为空，已拦截全部 {stats.total} 条本机 Cookie（Hub 同步与探测显示为 0）"
                    )
                else:
                    self.logger.info(
                        f"[GUARD] fetch_cookies | 模式={self.cookie_guard.config.mode} | 原始={stats.total} | "
                        f"放行={stats.allowed} | 本地拦截={stats.blocked_by_policy} | 过期剔除={stats.expired_dropped}"
                        + (f" | 放行域={top_doms}" if top_doms else "")
                    )
                self._emit_status(
                    last_guard=f"放行 {stats.allowed} / 拦截 {stats.blocked_by_policy} ({self.cookie_guard.config.mode})"
                )
                await ws.send(json.dumps({"req_id": req_id, "status": "ok", "cookies": filtered}))
            except Exception as e:
                self.logger.error(f"提取本地 Cookie 失败: {e}")
                await ws.send(json.dumps({"req_id": req_id, "status": "error", "message": str(e)}))

        elif action == "inject_cookies":
            to_inject = payload.get("cookies", [])
            allowed_inject, stats = self.cookie_guard.filter_for_inject(to_inject)
            if stats.blocked_by_policy > 0 or stats.expired_dropped > 0:
                self.logger.info(
                    f"[GUARD] inject_cookies 校验 | 收到={stats.total} | 允许写入={stats.allowed} | "
                    f"拒绝={stats.blocked_by_policy}"
                )
            try:
                base = f"http://127.0.0.1:{int(cdp_port)}"
                target_ws = None
                try:
                    list_res = await http_client.get(f"{base}/json/list", timeout=3.0)
                    pages = [t for t in list_res.json() if t.get("type") == "page" and "webSocketDebuggerUrl" in t]
                    if pages:
                        target_ws = pages[0]["webSocketDebuggerUrl"]
                except Exception:
                    pass
                if not target_ws:
                    ver_res = await http_client.get(f"{base}/json/version", timeout=3.0)
                    target_ws = ver_res.json()["webSocketDebuggerUrl"]

                if allowed_inject:
                    async with _ws_connect_local(target_ws, open_timeout=8.0) as cdp_ws:
                        await send_cdp_json_command(cdp_ws, "Network.enable", req_id=301)
                        await send_cdp_json_command(cdp_ws, "Network.setCookies", {"cookies": allowed_inject}, req_id=302)
                self.logger.info(f"同步注入 Cookie 完成: 写入 {len(allowed_inject)} 条")
                await ws.send(json.dumps({"req_id": req_id, "status": "ok", "injected_count": len(allowed_inject)}))
            except Exception as e:
                self.logger.error(f"写入本地 Cookie 失败: {e}")
                await ws.send(json.dumps({"req_id": req_id, "status": "error", "message": str(e)}))

        elif action == "purge_cookies":
            if self.cookie_guard.config.mode == "block_export":
                self.logger.info("[GUARD] 当前为 block_export 模式，跳过远端 Cookie 清理指令")
                await ws.send(json.dumps({"req_id": req_id, "status": "ok", "purged_count": 0}))
                return
            try:
                exclude_domains = payload.get("exclude_domains") or []
                cleanup_rules = payload.get("cleanup_rules") or {}
                explicit_targets = payload.get("targets") or []

                raw_cookies = await extract_raw_local_cookies(http_client, cdp_port)
                to_delete = _select_local_cleanup_targets(
                    raw_cookies, exclude_domains, cleanup_rules, explicit_targets
                )
                deleted_cnt = 0
                if to_delete:
                    base = f"http://127.0.0.1:{int(cdp_port)}"
                    target_ws = None
                    try:
                        list_res = await http_client.get(f"{base}/json/list", timeout=3.0)
                        pages = [t for t in list_res.json() if t.get("type") == "page" and "webSocketDebuggerUrl" in t]
                        if pages:
                            target_ws = pages[0]["webSocketDebuggerUrl"]
                    except Exception:
                        pass
                    if not target_ws:
                        ver_res = await http_client.get(f"{base}/json/version", timeout=3.0)
                        target_ws = ver_res.json()["webSocketDebuggerUrl"]

                    async with _ws_connect_local(target_ws, open_timeout=8.0) as cdp_ws:
                        await send_cdp_json_command(cdp_ws, "Network.enable", req_id=401)
                        for idx, item in enumerate(to_delete):
                            await send_cdp_json_command(cdp_ws, "Network.deleteCookies", item, req_id=500 + idx)
                            deleted_cnt += 1
                    self.logger.info(f"[GUARD] 已执行 Hub 全局清理策略: 删除 {deleted_cnt} 条本机 Cookie")
                await ws.send(json.dumps({"req_id": req_id, "status": "ok", "purged_count": deleted_cnt}))
            except Exception as e:
                self.logger.error(f"清理本地 Cookie 失败: {e}")
                await ws.send(json.dumps({"req_id": req_id, "status": "error", "message": str(e)}))

        elif action == "get_version":
            try:
                ver_res = await http_client.get(f"http://127.0.0.1:{int(cdp_port)}/json/version", timeout=3.0)
                await ws.send(json.dumps({"req_id": req_id, "status": "ok", "version": ver_res.json()}))
            except Exception as e:
                await ws.send(json.dumps({"req_id": req_id, "status": "error", "message": str(e)}))

        elif msg_type == "ping" or action == "ping":
            await ws.send(json.dumps({"type": "pong"}))

    async def _bridge_cdp_ws_stream(self, tunnel_ws, stream_id: str, inbound_queue: asyncio.Queue, cdp_port: int):
        try:
            async with httpx.AsyncClient(timeout=3.0, trust_env=False) as client:
                ver_res = await client.get(f"http://127.0.0.1:{int(cdp_port)}/json/version")
                local_ws_url = ver_res.json()["webSocketDebuggerUrl"]

            async with _ws_connect_local(local_ws_url, open_timeout=5.0, max_size=100 * 1024 * 1024) as cdp_ws:
                async def _cdp_to_hub():
                    async for msg in cdp_ws:
                        await tunnel_ws.send(json.dumps({
                            "type": "cdp_ws_frame",
                            "stream_id": stream_id,
                            "data": msg if isinstance(msg, str) else msg.decode("utf-8", errors="replace"),
                        }))

                async def _hub_to_cdp():
                    while True:
                        payload = await inbound_queue.get()
                        if payload is None:
                            break
                        await cdp_ws.send(payload)

                _, pending = await asyncio.wait(
                    [asyncio.create_task(_cdp_to_hub()), asyncio.create_task(_hub_to_cdp())],
                    return_when=asyncio.FIRST_COMPLETED,
                )
                for t in pending:
                    t.cancel()
        except Exception as e:
            try:
                await tunnel_ws.send(json.dumps({"type": "cdp_ws_error", "stream_id": stream_id, "error": str(e)}))
            except Exception:
                pass
        finally:
            try:
                await tunnel_ws.send(json.dumps({"type": "cdp_ws_close", "stream_id": stream_id}))
            except Exception:
                pass

    async def _start_wss_server(
        self,
        wss_port: int,
        edge_wss_secret: str,
        join_token: str,
        cdp_port: int,
        activity: Dict[str, float],
        extra_dns_names: Optional[List[str]] = None,
    ) -> Tuple[List[Any], List[socket.socket]]:
        ssl_ctx = _ensure_self_signed_tls(self.data_dir, extra_dns_names=extra_dns_names)
        socks: List[socket.socket] = []

        if getattr(socket, "has_ipv6", False):
            try:
                s6 = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
                s6.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s6.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
                s6.bind(("::", wss_port))
                s6.listen(128)
                s6.setblocking(False)
                socks.append(s6)
            except OSError:
                pass

        if not socks:
            s4 = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s4.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s4.bind(("0.0.0.0", wss_port))
            s4.listen(128)
            s4.setblocking(False)
            socks.append(s4)

        async def _ws_handler(websocket, *_unused):
            req = getattr(websocket, "request", None)
            headers_obj = getattr(req, "headers", None) if req is not None else getattr(websocket, "request_headers", {})
            presented = str((headers_obj.get("x-edge-auth") if headers_obj else "") or "").strip()
            presented_join = str((headers_obj.get("x-join-token") if headers_obj else "") or "").strip()

            authorized = False
            if presented and secrets.compare_digest(presented, edge_wss_secret):
                authorized = True
            elif join_token and presented_join and secrets.compare_digest(presented_join, join_token):
                authorized = True

            if not authorized:
                await websocket.close(code=1008, reason="Unauthorized Edge WSS Client")
                return

            activity["last_inbound"] = time.monotonic()
            self.logger.info(f"Hub 加密 WSS 直连已建立，桥接本地 127.0.0.1:{cdp_port}")
            self._emit_status(hub_status="connected", hub_mode="public_wss")
            ws_streams: Dict[str, asyncio.Queue] = {}
            try:
                async with httpx.AsyncClient(timeout=4.0, trust_env=False) as http_client:
                    async for msg_text in websocket:
                        activity["last_inbound"] = time.monotonic()
                        if msg_text == "pong" or '"type":"pong"' in msg_text:
                            continue
                        asyncio.create_task(self._handle_cdp_command(websocket, http_client, msg_text, ws_streams, cdp_port))
            except Exception as e:
                self.logger.info(f"Hub WSS 直连会话断开: {type(e).__name__}")
            finally:
                for q in ws_streams.values():
                    await q.put(None)
                ws_streams.clear()

        servers = []
        for s in socks:
            srv = await websockets.serve(_ws_handler, sock=s, ssl=ssl_ctx, max_size=100 * 1024 * 1024, ping_interval=20, ping_timeout=10)
            servers.append(srv)

        self.logger.info(f"本地加密 WSS 服务监听就绪 (端口: {wss_port})")
        return servers, socks

    async def _stop_wss_server(self, servers: List[Any], socks: List[socket.socket]):
        for srv in servers:
            try:
                srv.close()
                await srv.wait_closed()
            except Exception:
                pass
        for s in socks:
            try:
                s.close()
            except OSError:
                pass

    async def run(self):
        self._stop_event = asyncio.Event()
        hub_cfg = self.config.get("hub", {})
        hub_url = (hub_cfg.get("hub_url") or "").strip().rstrip("/")
        if not hub_url:
            self.logger.error("未配置 HUB_URL，无法接入 Hub")
            self._emit_status(hub_status="error")
            return

        join_token = (hub_cfg.get("join_token") or "").strip()
        cdp_port = int(hub_cfg.get("cdp_port") or 9222)
        wss_port = int(hub_cfg.get("edge_wss_port") or 9443)
        ext_wss_port = int(hub_cfg.get("edge_wss_external_port") or wss_port)
        node_name_cfg = (hub_cfg.get("node_name") or "").strip()
        group_name = (hub_cfg.get("group_name") or "Windows节点").strip() or "Windows节点"
        rev_cfg = str(hub_cfg.get("reverse_tunnel") or "auto").strip().lower()
        hb_interval = max(10, int(hub_cfg.get("heartbeat_seconds") or 60))

        node_uuid, fingerprint, edge_wss_secret = ensure_identity(self.data_dir, node_name_cfg)
        node_name = node_name_cfg or node_uuid
        endpoints = collect_node_endpoints(hub_cfg, ext_wss_port)
        pub_domain = endpoints.get("public_domain")

        if pub_domain and not endpoints.get("public_ipv4") and not endpoints.get("public_ipv6"):
            self.logger.warning(f"配置的域名 {pub_domain} 暂未解析出公网 IP，将尝试由 Hub 按源地址探测或回退反向隧道")

        self.logger.info(
            f"启动节点代理 | UUID={node_uuid} | 分组={group_name} | 本地CDP=127.0.0.1:{cdp_port} | "
            f"WSS={wss_port}(外部:{ext_wss_port})"
            + (f" | 公网域名={pub_domain}" if pub_domain else "")
            + f" | Cookie保护={self.cookie_guard.config.mode}"
        )

        # 等待本地浏览器 CDP 就绪
        self._emit_status(hub_status="probing", cdp_status="waiting")
        async with httpx.AsyncClient(timeout=2.0, trust_env=False) as client:
            cdp_ok = False
            for _ in range(15):
                if self._stop_event.is_set():
                    return
                try:
                    r = await client.get(f"http://127.0.0.1:{cdp_port}/json/version")
                    if r.status_code == 200:
                        self.logger.info(f"本地浏览器 CDP 已就绪: 127.0.0.1:{cdp_port}")
                        self._emit_status(cdp_status="ready")
                        cdp_ok = True
                        break
                except Exception:
                    pass
                await asyncio.sleep(1.0)
            if not cdp_ok:
                self.logger.warning(f"暂未检测到 127.0.0.1:{cdp_port} 响应，将继续接入 Hub 并等待浏览器就绪")
                self._emit_status(cdp_status="offline")

        use_public_wss = False
        detect_res: Dict[str, Any] = {}
        servers: List[Any] = []
        socks: List[socket.socket] = []
        activity = {"last_inbound": time.monotonic()}

        if rev_cfg == "true":
            self.logger.info("接入模式=强制 WSS 反向穿透 (reverse_tunnel=true)")
        else:
            dns_sans = [pub_domain] if pub_domain else None
            servers, socks = await self._start_wss_server(
                wss_port, edge_wss_secret, join_token, cdp_port, activity, extra_dns_names=dns_sans
            )
            if rev_cfg == "false":
                v4, v6 = endpoints.get("public_ipv4"), endpoints.get("public_ipv6")
                if pub_domain:
                    rec_ep = f"{pub_domain}:{ext_wss_port}"
                else:
                    rec_ep = f"[{v6}]:{ext_wss_port}" if v6 and not v4 else (f"{v4}:{ext_wss_port}" if v4 else None)
                detect_res = {
                    "network_mode": "direct_ipv6" if (v6 and not v4 and not pub_domain) else "direct_ipv4",
                    "network_profile": "direct",
                    "ipv4_reachable": bool(v4 or pub_domain),
                    "ipv6_reachable": bool(v6),
                    "recommended_endpoint": rec_ep,
                }
                use_public_wss = True
            else:
                self.logger.info(
                    f"正在向 Hub 上报公网端点并执行 TCP 三次握手探测 (WSS端口 :{ext_wss_port}"
                    + (f", 域名={pub_domain} -> IPv4={endpoints.get('public_ipv4') or '-'}" if pub_domain else "")
                    + ")..."
                )
                async with httpx.AsyncClient(verify=False, timeout=6.0) as client:
                    try:
                        res = await client.post(
                            f"{hub_url}/api/nodes/detect-mode",
                            json={
                                "node_uuid": node_uuid,
                                "cdp_port": ext_wss_port,
                                "public_ipv4": endpoints.get("public_ipv4"),
                                "public_ipv4_port": endpoints.get("public_ipv4_port"),
                                "public_ipv6": endpoints.get("public_ipv6"),
                                "public_ipv6_port": endpoints.get("public_ipv6_port"),
                            },
                        )
                        if res.status_code == 200:
                            detect_res = res.json()
                    except Exception as e:
                        self.logger.warning(f"Hub 网络探测请求失败: {e}")

                net_mode = detect_res.get("network_mode", "reverse_tunnel")
                can_direct = bool(detect_res.get("can_direct")) or net_mode in {
                    "direct_dual", "direct_ipv4", "direct_ipv6", "direct"
                }
                if can_direct:
                    if pub_domain:
                        detect_res["recommended_endpoint"] = f"{pub_domain}:{ext_wss_port}"
                    self.logger.info(f"Hub 探测可达: network_mode={net_mode}, endpoint={detect_res.get('recommended_endpoint')}")
                    use_public_wss = True
                else:
                    self.logger.info(f"Hub 探测不可达 (network_mode={net_mode})，自动切换为出站 WSS 反向穿透模式")
                    await self._stop_wss_server(servers, socks)
                    servers, socks = [], []

        if use_public_wss:
            self._emit_status(hub_mode="public_wss", hub_status="registering")
            try:
                while not self._stop_event.is_set():
                    headers = {"X-Join-Token": join_token} if join_token else {}
                    payload = {
                        "node_uuid": node_uuid,
                        "public_key_fingerprint": fingerprint,
                        "name": node_name,
                        "group_name": group_name,
                        "conn_type": "public_wss",
                        "cdp_port": cdp_port,
                        "wss_port": ext_wss_port,
                        "edge_wss_secret": edge_wss_secret,
                        "public_ipv4": endpoints.get("public_ipv4"),
                        "public_ipv4_port": endpoints.get("public_ipv4_port"),
                        "public_ipv6": endpoints.get("public_ipv6"),
                        "public_ipv6_port": endpoints.get("public_ipv6_port"),
                        "network_mode": detect_res.get("network_mode") or "direct",
                        "recommended_endpoint": detect_res.get("recommended_endpoint"),
                        "ipv4_reachable": detect_res.get("ipv4_reachable"),
                        "ipv6_reachable": detect_res.get("ipv6_reachable"),
                        "session_ticket": load_session_ticket(self.data_dir),
                    }
                    pending_tofu = False
                    async with httpx.AsyncClient(verify=False, timeout=8.0) as client:
                        try:
                            r = await client.post(f"{hub_url}/api/nodes/auto-register", json=payload, headers=headers)
                            if r.status_code == 200:
                                body = r.json()
                                save_session_ticket(self.data_dir, body.get("session_ticket"))
                                appr = body.get("approval_status")
                                pending_tofu = (appr == 0)
                                self.logger.info(
                                    f"WSS 直连登记响应 200 | node_id={body.get('node_id')} | "
                                    f"conn_type={body.get('conn_type')} | approval_status={appr}"
                                )
                                self._emit_status(
                                    hub_status="pending_tofu" if pending_tofu else "connected",
                                    hub_mode="public_wss",
                                )
                            else:
                                self.logger.warning(f"WSS 直连登记返回 HTTP {r.status_code}: {r.text[:160]}")
                        except Exception as e:
                            self.logger.warning(f"WSS 直连登记异常: {e}")

                    sleep_sec = 5 if pending_tofu else hb_interval
                    try:
                        await asyncio.wait_for(self._stop_event.wait(), timeout=sleep_sec)
                        return
                    except asyncio.TimeoutError:
                        pass
            finally:
                await self._stop_wss_server(servers, socks)

        # 反向穿透主循环
        self._emit_status(hub_mode="reverse", hub_status="connecting")
        base_ws_url = hub_url.replace("https://", "wss://").replace("http://", "ws://")
        tunnel_url = f"{base_ws_url}/api/nodes/reverse-tunnel"
        headers = {
            "X-Node-UUID": node_uuid,
            "X-Node-Fingerprint": fingerprint,
            "X-Node-Name": quote(node_name),
            "X-Node-Group": quote(group_name),
            "X-CDP-Port": str(cdp_port),
            "X-External-Port": str(ext_wss_port),
        }
        if join_token:
            headers["X-Join-Token"] = join_token

        ssl_ctx = ssl.create_default_context()
        ssl_ctx.check_hostname = False
        ssl_ctx.verify_mode = ssl.CERT_NONE

        backoff = 2
        while not self._stop_event.is_set():
            try:
                ws_kwargs: Dict[str, Any] = {
                    "ssl": ssl_ctx if tunnel_url.startswith("wss://") else None,
                    "max_size": 100 * 1024 * 1024,
                    "ping_interval": 20,
                    "ping_timeout": 10,
                    "open_timeout": 10,
                }
                try:
                    ws_ctx = websockets.connect(tunnel_url, additional_headers=headers, **ws_kwargs)
                except TypeError:
                    ws_ctx = websockets.connect(tunnel_url, extra_headers=headers, **ws_kwargs)

                async with ws_ctx as ws:
                    handshake = {
                        "node_uuid": node_uuid,
                        "public_key_fingerprint": fingerprint,
                        "join_token": join_token or None,
                        "session_ticket": load_session_ticket(self.data_dir),
                        "name": node_name,
                        "group": group_name,
                        "port": cdp_port,
                        "wss_port": ext_wss_port,
                        "external_port": ext_wss_port,
                        "nat_type": "nat4" if rev_cfg == "true" else "unknown",
                    }
                    if rev_cfg == "true":
                        handshake["reverse_tunnel"] = True
                    await ws.send(json.dumps(handshake))

                    auth_raw = await asyncio.wait_for(ws.recv(), timeout=10.0)
                    auth_data = json.loads(auth_raw)
                    status_val = auth_data.get("status")
                    if status_val == "denied":
                        self.logger.error(f"Hub 拒绝接入: {auth_data.get('reason')}")
                        self._emit_status(hub_status="denied")
                        return

                    if auth_data.get("session_ticket"):
                        save_session_ticket(self.data_dir, auth_data["session_ticket"])

                    if status_val == "pending_tofu":
                        self.logger.warning("节点已进入 Hub「待审批隔离区」，等待管理员批准...")
                        self._emit_status(hub_status="pending_tofu", hub_mode="reverse")
                    else:
                        self.logger.info(f"反向 WSS 隧道已建立 -> {tunnel_url}")
                        self._emit_status(hub_status="connected", hub_mode="reverse")

                    backoff = 2
                    ws_streams: Dict[str, asyncio.Queue] = {}

                    async def _hb_loop():
                        while not self._stop_event.is_set():
                            await asyncio.sleep(5)
                            try:
                                await ws.send(json.dumps({"action": "ping"}))
                            except Exception:
                                break

                    hb_task = asyncio.create_task(_hb_loop())
                    try:
                        async with httpx.AsyncClient(timeout=4.0, trust_env=False) as http_client:
                            async for msg_text in ws:
                                if self._stop_event.is_set():
                                    break
                                if '"status":"approved"' in msg_text or '"status": "approved"' in msg_text:
                                    try:
                                        app_msg = json.loads(msg_text)
                                        save_session_ticket(self.data_dir, app_msg.get("session_ticket"))
                                    except Exception:
                                        pass
                                    self.logger.info("TOFU 审批已通过，正式激活通信！")
                                    self._emit_status(hub_status="connected")
                                    continue
                                if msg_text == "pong" or '"type":"pong"' in msg_text:
                                    continue
                                asyncio.create_task(
                                    self._handle_cdp_command(ws, http_client, msg_text, ws_streams, cdp_port)
                                )
                    finally:
                        hb_task.cancel()
                        for q in ws_streams.values():
                            await q.put(None)
                        ws_streams.clear()

            except asyncio.CancelledError:
                raise
            except Exception as e:
                if self._stop_event.is_set():
                    break
                self._emit_status(hub_status="reconnecting")
                self.logger.warning(f"反向 WSS 隧道断开 ({type(e).__name__}: {e})，{backoff}s 后重连...")
                try:
                    await asyncio.wait_for(self._stop_event.wait(), timeout=backoff)
                    break
                except asyncio.TimeoutError:
                    pass
                backoff = min(backoff * 2, 30)

    def request_stop(self):
        if self._stop_event is not None:
            self._stop_event.set()
