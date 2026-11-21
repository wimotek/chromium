import os
import sys
import re
import json
import time
import random
import socket
import ssl
import ipaddress
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
from core.db import db_session, get_setting, hash_pwd, set_setting
from core.models import User
from core.rate_limit import ban_ip, check_ip_ban, get_client_ip, is_whitelisted_ip

HEARTBEAT_ONLINE_SEC = 135
_HB_RECOVERABLE_PROBE_CODES = frozenset({
    "offline",
    "heartbeat_lost",
    "xray_unhealthy",
    "tunnel_disconnected",
})

# 精选更低噪音、支持 TLS 1.3 + HTTP/2 + X25519、非 Cloudflare 且避开烂大街 microsoft.com 的多 SNI REALITY 伪装目标池
SAFE_REALITY_TARGETS = [
    {
        "dest": "www.amd.com:443",
        "sni": "www.amd.com",
        "server_names": ["www.amd.com", "amd.com"],
        "label": "AMD 官网",
        "region": "全球 Akamai",
    },
    {
        "dest": "www.nvidia.com:443",
        "sni": "www.nvidia.com",
        "server_names": ["www.nvidia.com", "nvidia.com", "developer.nvidia.com"],
        "label": "NVIDIA 官网",
        "region": "全球低噪",
    },
    {
        "dest": "www.intel.com:443",
        "sni": "www.intel.com",
        "server_names": ["www.intel.com", "intel.com"],
        "label": "Intel 官网",
        "region": "欧美/全球",
    },
    {
        "dest": "www.logitech.com:443",
        "sni": "www.logitech.com",
        "server_names": ["www.logitech.com", "logitech.com"],
        "label": "Logitech 罗技",
        "region": "欧美/亚太",
    },
    {
        "dest": "www.samsung.com:443",
        "sni": "www.samsung.com",
        "server_names": ["www.samsung.com", "samsung.com"],
        "label": "Samsung 三星",
        "region": "日韩/亚太优",
    },
    {
        "dest": "www.sony.com:443",
        "sni": "www.sony.com",
        "server_names": ["www.sony.com", "sony.com"],
        "label": "Sony 索尼",
        "region": "日韩/美西优",
    },
    {
        "dest": "www.asus.com:443",
        "sni": "www.asus.com",
        "server_names": ["www.asus.com", "asus.com"],
        "label": "ASUS 华硕",
        "region": "亚太/新加坡优",
    },
    {
        "dest": "www.dell.com:443",
        "sni": "www.dell.com",
        "server_names": ["www.dell.com", "dell.com"],
        "label": "Dell 戴尔",
        "region": "北美/欧洲",
    },
    {
        "dest": "www.cisco.com:443",
        "sni": "www.cisco.com",
        "server_names": ["www.cisco.com", "cisco.com"],
        "label": "Cisco 思科",
        "region": "企业网络",
    },
    {
        "dest": "www.oracle.com:443",
        "sni": "www.oracle.com",
        "server_names": ["www.oracle.com", "oracle.com"],
        "label": "Oracle 甲骨文",
        "region": "全球云商",
    },
    {
        "dest": "www.siemens.com:443",
        "sni": "www.siemens.com",
        "server_names": ["www.siemens.com", "siemens.com"],
        "label": "Siemens 西门子",
        "region": "欧洲节点优",
    },
    {
        "dest": "www.mozilla.org:443",
        "sni": "www.mozilla.org",
        "server_names": ["www.mozilla.org", "addons.mozilla.org", "developer.mozilla.org"],
        "label": "Mozilla 官网",
        "region": "全球开源",
    },
]
DEFAULT_REALITY_DEST = SAFE_REALITY_TARGETS[0]["dest"]
DEFAULT_REALITY_SNI = SAFE_REALITY_TARGETS[0]["sni"]
REALITY_SNI_PRESETS_SETTING_KEY = "reality_sni_presets"

_SNI_DOMAIN_RE = re.compile(
    r"^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$"
)
_DEST_HOST_RE = re.compile(r"^[a-z0-9.\-:]+$")


def normalize_sni_domain(raw: str) -> str:
    """规范化并校验单个 SNI 域名（去除协议头、路径、端口与尾随点，拒绝 IP 字面量）"""
    text = str(raw or "").strip()
    if not text:
        return ""
    for sep in (",", ";", "\n"):
        if sep in text:
            text = text.split(sep, 1)[0].strip()
    if "://" in text:
        text = text.split("://", 1)[1]
    text = text.split("/", 1)[0].split("?", 1)[0].split("#", 1)[0]
    if ":" in text:
        text = text.split(":", 1)[0]
    text = text.strip().rstrip(".").lower()
    if not _SNI_DOMAIN_RE.match(text):
        return ""
    # RFC 6066: SNI 必须是 DNS 主机名，不能是纯数字 TLD 或 IPv4/IPv6 字面量
    try:
        ipaddress.ip_address(text)
        return ""
    except ValueError:
        pass
    if text.rsplit(".", 1)[-1].isdigit():
        return ""
    return text


def normalize_sni_list(raw, max_items: int = 20) -> list[str]:
    """解析并校验多 SNI 域名列表（支持数组或逗号/分号/空白分隔字符串，按顺序去重）"""
    if isinstance(raw, (list, tuple)):
        parts = [str(x or "").strip() for x in raw]
    else:
        parts = re.split(r"[,;\s]+", str(raw or "").strip())
    result: list[str] = []
    seen: set[str] = set()
    for part in parts:
        if not part:
            continue
        sni = normalize_sni_domain(part)
        if sni and sni not in seen:
            seen.add(sni)
            result.append(sni)
            if len(result) >= max_items:
                break
    return result


def normalize_reality_dest(raw_dest: str, fallback_sni: str = "") -> str:
    """规范化 REALITY 回落目标 host:port（支持域名、IPv4 或 [IPv6]:port）"""
    text = str(raw_dest or "").strip()
    if not text:
        return f"{fallback_sni}:443" if fallback_sni else ""
    if "://" in text:
        text = text.split("://", 1)[1]
    text = text.split("/", 1)[0].split("?", 1)[0].split("#", 1)[0].strip()
    if not text:
        return f"{fallback_sni}:443" if fallback_sni else ""

    host = ""
    port = 443
    if text.startswith("["):
        end_idx = text.find("]")
        if end_idx == -1:
            return ""
        host = text[1:end_idx].strip()
        rest = text[end_idx + 1:].strip()
        if rest.startswith(":"):
            try:
                port = int(rest[1:])
            except ValueError:
                return ""
        elif rest:
            return ""
        try:
            ipaddress.ip_address(host)
        except ValueError:
            return ""
        if not (1 <= port <= 65535):
            return ""
        return f"[{host}]:{port}"

    if ":" in text:
        host_part, port_part = text.rsplit(":", 1)
        host = host_part.strip().rstrip(".").lower()
        try:
            port = int(port_part.strip())
        except ValueError:
            return ""
    else:
        host = text.rstrip(".").lower()
        port = 443

    if not host or not (1 <= port <= 65535):
        return ""
    try:
        ipaddress.ip_address(host)
        return f"{host}:{port}"
    except ValueError:
        if _SNI_DOMAIN_RE.match(host) or host == "localhost":
            return f"{host}:{port}"
    return ""


def _copy_default_reality_presets() -> list[dict]:
    return [
        {
            "sni": item["sni"],
            "server_names": list(item["server_names"]),
            "dest": item["dest"],
            "label": item.get("label", ""),
            "region": item.get("region", ""),
        }
        for item in SAFE_REALITY_TARGETS
    ]


def _normalize_preset_entry(item) -> dict | None:
    if isinstance(item, str):
        snis = normalize_sni_list(item)
        if not snis:
            return None
        return {
            "sni": snis[0],
            "server_names": snis,
            "dest": f"{snis[0]}:443",
            "label": "",
            "region": "",
        }
    if not isinstance(item, dict):
        return None
    raw_list = item.get("server_names")
    snis = normalize_sni_list(raw_list if raw_list else (item.get("sni") or item.get("dest") or ""))
    if not snis:
        return None
    dest = normalize_reality_dest(item.get("dest") or "", fallback_sni=snis[0]) or f"{snis[0]}:443"
    return {
        "sni": snis[0],
        "server_names": snis,
        "dest": dest,
        "label": str(item.get("label") or "").strip()[:48],
        "region": str(item.get("region") or "").strip()[:32],
    }


def get_reality_presets() -> list[dict]:
    """读取持久化 REALITY 多 SNI 目标池（为空时自动回退内置安全默认池）"""
    raw = get_setting(REALITY_SNI_PRESETS_SETTING_KEY, "").strip()
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list) and parsed:
                cleaned: list[dict] = []
                seen: set[str] = set()
                for item in parsed:
                    norm = _normalize_preset_entry(item)
                    if not norm:
                        continue
                    dedup_key = f"{norm['dest']}|{','.join(norm['server_names'])}"
                    if dedup_key in seen:
                        continue
                    seen.add(dedup_key)
                    cleaned.append(norm)
                if cleaned:
                    return cleaned
        except Exception:
            pass
    return _copy_default_reality_presets()


def save_reality_presets(presets: list[dict]) -> list[dict]:
    """规范化并持久化保存 REALITY 多 SNI 预设列表"""
    cleaned: list[dict] = []
    seen: set[str] = set()
    for item in presets or []:
        norm = _normalize_preset_entry(item)
        if not norm:
            continue
        dedup_key = f"{norm['dest']}|{','.join(norm['server_names'])}"
        if dedup_key in seen:
            continue
        seen.add(dedup_key)
        cleaned.append(norm)
        if len(cleaned) >= 200:
            break
    if not cleaned:
        cleaned = _copy_default_reality_presets()
    set_setting(REALITY_SNI_PRESETS_SETTING_KEY, json.dumps(cleaned, ensure_ascii=False))
    return cleaned


_PLACEHOLDER_REALITY_HOSTS = frozenset({"www.microsoft.com", "microsoft.com"})


def is_placeholder_reality_target(dest: str, snis: list[str] | str) -> bool:
    """判断节点上报的 REALITY 目标是否为默认占位值（如 www.microsoft.com 或空）"""
    sni_list = normalize_sni_list(snis) if not isinstance(snis, list) else [str(x or "").strip().lower() for x in snis if str(x or "").strip()]
    dest_host = ""
    raw_dest = str(dest or "").strip().lower()
    if raw_dest:
        dest_host, _ = _split_dest_host_port(raw_dest)
        dest_host = dest_host.strip().rstrip(".").lower()
    if not sni_list:
        return not dest_host or dest_host in _PLACEHOLDER_REALITY_HOSTS
    all_sni_placeholder = all(s in _PLACEHOLDER_REALITY_HOSTS for s in sni_list)
    dest_is_placeholder = (not dest_host) or (dest_host in _PLACEHOLDER_REALITY_HOSTS)
    return all_sni_placeholder and dest_is_placeholder


def pick_random_reality_preset() -> tuple[str, str, str, list[str]]:
    """从 Hub 全局多 SNI 预设池中随机抽取一组目标，返回 (dest, primary_sni, server_names_str, snis_list)"""
    presets = get_reality_presets()
    picked = random.choice(presets) if presets else _copy_default_reality_presets()[0]
    snis = normalize_sni_list(picked.get("server_names") or picked.get("sni") or DEFAULT_REALITY_SNI)
    if not snis:
        snis = [DEFAULT_REALITY_SNI]
    primary_sni = snis[0]
    dest = normalize_reality_dest(picked.get("dest") or "", fallback_sni=primary_sni) or f"{primary_sni}:443"
    return dest, primary_sni, ",".join(snis), snis


def _split_dest_host_port(dest: str) -> tuple[str, int]:
    if dest.startswith("["):
        end_idx = dest.find("]")
        host = dest[1:end_idx]
        port = int(dest[end_idx + 2:]) if len(dest) > end_idx + 2 else 443
        return host, port
    if ":" in dest:
        h, p = dest.rsplit(":", 1)
        return h, int(p)
    return dest, 443


def _is_non_public_ip(ip_str: str) -> bool:
    try:
        ip_obj = ipaddress.ip_address(ip_str)
        return bool(
            ip_obj.is_private
            or ip_obj.is_loopback
            or ip_obj.is_link_local
            or ip_obj.is_multicast
            or ip_obj.is_reserved
            or ip_obj.is_unspecified
        )
    except ValueError:
        return True


def _verify_single_sni_on_addrs(
    sni: str,
    dest: str,
    public_addrs: list,
    timeout: float = 4.0,
) -> dict:
    """对已解析的公网地址执行单 SNI 的 TLS 1.3 + ALPN(h2) + 证书校验"""
    def _run_tls_handshake(verify_cert: bool):
        ctx = ssl.create_default_context() if verify_cert else ssl._create_unverified_context()
        try:
            ctx.set_alpn_protocols(["h2", "http/1.1"])
        except Exception:
            pass
        if not verify_cert:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE

        last_exc = None
        for family, socktype, proto, sockaddr in public_addrs[:3]:
            raw_sock = None
            try:
                t0 = time.perf_counter()
                raw_sock = socket.socket(family, socktype, proto)
                raw_sock.settimeout(timeout)
                raw_sock.connect(sockaddr)
                with ctx.wrap_socket(raw_sock, server_hostname=sni) as ssock:
                    rtt_ms = int(round((time.perf_counter() - t0) * 1000))
                    tls_ver = ssock.version() or ""
                    alpn = ssock.selected_alpn_protocol() or ""
                    cipher_info = ssock.cipher()
                    cipher_name = cipher_info[0] if cipher_info else ""
                    peer_cert = ssock.getpeercert() if verify_cert else {}
                    return {
                        "ok": True,
                        "rtt_ms": rtt_ms,
                        "tls_version": tls_ver,
                        "alpn": alpn,
                        "cipher": cipher_name,
                        "peer_cert": peer_cert or {},
                        "resolved_ip": sockaddr[0],
                    }
            except Exception as exc:
                last_exc = exc
                if raw_sock is not None:
                    try:
                        raw_sock.close()
                    except Exception:
                        pass
        raise last_exc or RuntimeError("TCP/TLS 连接失败")

    cert_valid = True
    cert_err = ""
    try:
        probe = _run_tls_handshake(verify_cert=True)
    except ssl.SSLCertVerificationError as cert_exc:
        cert_valid = False
        cert_err = getattr(cert_exc, "verify_message", "") or str(cert_exc)
        try:
            probe = _run_tls_handshake(verify_cert=False)
        except Exception:
            return {
                "valid": False,
                "grade": "invalid",
                "sni": sni,
                "dest": dest,
                "tls_version": "",
                "alpn": "",
                "cipher": "",
                "rtt_ms": None,
                "cert_valid": False,
                "cert_issuer": "",
                "cert_days_left": None,
                "is_cloudflare": False,
                "warnings": [cert_err],
                "summary": f"证书校验失败: {cert_err}",
            }
    except Exception as exc:
        err_str = str(exc)
        if isinstance(exc, socket.timeout) or "timed out" in err_str.lower():
            reason = f"连接超时 (>{int(timeout)}s)，目标不可达或端口被防火墙阻断"
        else:
            reason = f"TCP/TLS 握手失败: {err_str[:120]}"
        return {
            "valid": False,
            "grade": "invalid",
            "sni": sni,
            "dest": dest,
            "tls_version": "",
            "alpn": "",
            "cipher": "",
            "rtt_ms": None,
            "cert_valid": False,
            "cert_issuer": "",
            "cert_days_left": None,
            "is_cloudflare": False,
            "warnings": [],
            "summary": reason,
        }

    tls_version = probe["tls_version"]
    alpn = probe["alpn"]
    rtt_ms = probe["rtt_ms"]
    cipher = probe["cipher"]
    peer_cert = probe["peer_cert"]

    issuer_parts = []
    for rdn in peer_cert.get("issuer") or ():
        for k, v in rdn:
            if k in ("organizationName", "commonName") and v:
                issuer_parts.append(str(v))
    cert_issuer = " / ".join(dict.fromkeys(issuer_parts))[:80]

    cert_days_left = None
    not_after = peer_cert.get("notAfter")
    if not_after:
        try:
            exp_dt = datetime.datetime.strptime(not_after, "%b %d %H:%M:%S %Y %Z")
            cert_days_left = max(0, (exp_dt - datetime.datetime.utcnow()).days)
        except Exception:
            cert_days_left = None

    san_values = [str(v).lower() for _, v in (peer_cert.get("subjectAltName") or ())]
    issuer_low = cert_issuer.lower()
    is_cloudflare = (
        "cloudflare" in issuer_low
        or any("cloudflare" in sv for sv in san_values)
    )

    warnings: list[str] = []
    is_tls13 = tls_version == "TLSv1.3"
    is_h2 = alpn == "h2"

    if not cert_valid:
        warnings.append(f"证书不受信任或域名与 dest 不匹配 ({cert_err})")
    if not is_tls13:
        warnings.append(f"仅协商到 {tls_version or '未知TLS版本'}，REALITY 强制要求 TLS 1.3")
    if not is_h2:
        warnings.append(f"未协商到 HTTP/2 (ALPN={alpn or 'none'})，REALITY 推荐同时支持 H2")
    if is_cloudflare:
        warnings.append("检测到 Cloudflare 证书特征，建议改用非 CF 大厂直连站点降低指纹风险")
    if cert_days_left is not None and cert_days_left < 7:
        warnings.append(f"目标证书即将过期（剩余 {cert_days_left} 天）")

    if not cert_valid or not is_tls13:
        valid = False
        grade = "invalid"
        summary = f"不可用于 REALITY · {warnings[0]}"
    elif warnings:
        valid = True
        grade = "warn"
        alpn_tag = alpn or "无H2"
        summary = f"基本可用(有提醒) · {tls_version} / {alpn_tag} · {rtt_ms}ms"
    else:
        valid = True
        grade = "excellent"
        days_part = f" · 证书剩余{cert_days_left}天" if cert_days_left is not None else ""
        summary = f"验证通过 · {tls_version} + H2 · {rtt_ms}ms{days_part}"

    return {
        "valid": valid,
        "grade": grade,
        "sni": sni,
        "dest": dest,
        "tls_version": tls_version,
        "alpn": alpn,
        "cipher": cipher,
        "rtt_ms": rtt_ms,
        "cert_valid": cert_valid,
        "cert_issuer": cert_issuer,
        "cert_days_left": cert_days_left,
        "is_cloudflare": is_cloudflare,
        "warnings": warnings,
        "summary": summary,
    }


def verify_reality_sni_target(raw_sni, raw_dest: str = "", timeout: float = 4.0) -> dict:
    """
    真实 TLS 1.3 + ALPN(h2) + 证书链探测，支持单 SNI 或逗号分隔的多 SNI 组并发验证。
    内置内网/回环 IP 拦截，防止 SSRF 探测 Hub 所在宿主机内网。
    """
    snis = normalize_sni_list(raw_sni, max_items=12)
    if not snis:
        return {
            "valid": False,
            "grade": "invalid",
            "sni": str(raw_sni or "").strip(),
            "server_names": [],
            "dest": str(raw_dest or "").strip(),
            "tls_version": "",
            "alpn": "",
            "cipher": "",
            "rtt_ms": None,
            "cert_valid": False,
            "cert_issuer": "",
            "cert_days_left": None,
            "is_cloudflare": False,
            "passed_count": 0,
            "total_count": 0,
            "passed_snis": [],
            "failed_snis": [],
            "items": [],
            "warnings": [],
            "summary": "SNI 域名格式无效（请输入标准域名，多 SNI 请用逗号分隔，如 www.amd.com,amd.com）",
        }

    primary_sni = snis[0]
    dest = normalize_reality_dest(raw_dest, fallback_sni=primary_sni)
    if not dest:
        return {
            "valid": False,
            "grade": "invalid",
            "sni": primary_sni,
            "server_names": snis,
            "dest": str(raw_dest or "").strip(),
            "tls_version": "",
            "alpn": "",
            "cipher": "",
            "rtt_ms": None,
            "cert_valid": False,
            "cert_issuer": "",
            "cert_days_left": None,
            "is_cloudflare": False,
            "passed_count": 0,
            "total_count": len(snis),
            "passed_snis": [],
            "failed_snis": snis,
            "items": [],
            "warnings": [],
            "summary": "回落目标 (dest) 格式无效（应为 域名:端口 或 IP:端口）",
        }

    target_host, target_port = _split_dest_host_port(dest)

    # DNS 解析与 SSRF 防护（拦截回环/私网地址）
    try:
        addr_infos = socket.getaddrinfo(target_host, target_port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        return {
            "valid": False,
            "grade": "invalid",
            "sni": primary_sni,
            "server_names": snis,
            "dest": dest,
            "tls_version": "",
            "alpn": "",
            "cipher": "",
            "rtt_ms": None,
            "cert_valid": False,
            "cert_issuer": "",
            "cert_days_left": None,
            "is_cloudflare": False,
            "passed_count": 0,
            "total_count": len(snis),
            "passed_snis": [],
            "failed_snis": snis,
            "items": [],
            "warnings": [],
            "summary": f"回落目标 {dest} DNS 解析失败: {exc}",
        }

    public_addrs = []
    first_ip = ""
    for family, socktype, proto, canonname, sockaddr in addr_infos:
        ip_str = sockaddr[0]
        if not first_ip:
            first_ip = ip_str
        if not _is_non_public_ip(ip_str):
            public_addrs.append((family, socktype, proto, sockaddr))

    if not public_addrs:
        return {
            "valid": False,
            "grade": "local",
            "sni": primary_sni,
            "server_names": snis,
            "dest": dest,
            "tls_version": "",
            "alpn": "",
            "cipher": "",
            "rtt_ms": None,
            "cert_valid": False,
            "cert_issuer": "",
            "cert_days_left": None,
            "is_cloudflare": False,
            "passed_count": 0,
            "total_count": len(snis),
            "passed_snis": [],
            "failed_snis": snis,
            "items": [],
            "warnings": ["内网/本机回落目标无法从主控端远程验证"],
            "summary": f"目标解析为本机/内网地址 ({first_ip})，请确认目标服务已在对应节点本机监听 TLS 1.3 + H2",
        }

    if len(snis) == 1:
        single = _verify_single_sni_on_addrs(primary_sni, dest, public_addrs, timeout=timeout)
        single["server_names"] = snis
        single["passed_count"] = 1 if single["valid"] else 0
        single["total_count"] = 1
        single["passed_snis"] = [primary_sni] if single["valid"] else []
        single["failed_snis"] = [] if single["valid"] else [primary_sni]
        single["items"] = [dict(single)]
        return single

    # 多 SNI 并发探测，总耗时接近单次握手
    from concurrent.futures import ThreadPoolExecutor

    with ThreadPoolExecutor(max_workers=min(5, len(snis))) as pool:
        items = list(pool.map(lambda s: _verify_single_sni_on_addrs(s, dest, public_addrs, timeout=timeout), snis))

    passed_items = [it for it in items if it["valid"]]
    failed_items = [it for it in items if not it["valid"]]
    passed_snis = [it["sni"] for it in passed_items]
    failed_snis = [it["sni"] for it in failed_items]
    total = len(items)
    passed_cnt = len(passed_items)

    primary_res = passed_items[0] if passed_items else items[0]
    merged_warnings: list[str] = []
    for it in items:
        for w in it.get("warnings") or []:
            tag = f"[{it['sni']}] {w}"
            if tag not in merged_warnings:
                merged_warnings.append(tag)

    if passed_cnt == 0:
        valid = False
        grade = "invalid"
        summary = f"全部 {total} 个 SNI 均未通过验证（目标 {dest}）"
    elif failed_items:
        valid = True
        grade = "warn"
        summary = f"{passed_cnt}/{total} 个 SNI 验证通过，{len(failed_items)} 个不可用（建议剔除失效项）"
    elif any(it["grade"] == "warn" for it in passed_items):
        valid = True
        grade = "warn"
        summary = f"全部 {total}/{total} 个 SNI 基本可用（存在部分提醒）"
    else:
        valid = True
        grade = "excellent"
        avg_rtt = int(round(sum(it["rtt_ms"] for it in passed_items if it["rtt_ms"] is not None) / max(1, passed_cnt)))
        summary = f"全部 {total}/{total} 个 SNI 验证通过 · TLSv1.3 + H2 · 平均 {avg_rtt}ms"

    return {
        "valid": valid,
        "grade": grade,
        "sni": primary_sni,
        "server_names": snis,
        "dest": dest,
        "tls_version": primary_res["tls_version"],
        "alpn": primary_res["alpn"],
        "cipher": primary_res["cipher"],
        "rtt_ms": primary_res["rtt_ms"],
        "cert_valid": all(it["cert_valid"] for it in items),
        "cert_issuer": primary_res["cert_issuer"],
        "cert_days_left": primary_res["cert_days_left"],
        "is_cloudflare": any(it["is_cloudflare"] for it in items),
        "passed_count": passed_cnt,
        "total_count": total,
        "passed_snis": passed_snis,
        "failed_snis": failed_snis,
        "items": items,
        "warnings": merged_warnings[:6],
        "summary": summary,
    }


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
    raw = node.get("server_names") or node.get("sni") or DEFAULT_REALITY_SNI
    snis = []
    for part in re.split(r'[,;\s]+', str(raw)):
        clean = part.strip().split(":")[0]
        if clean and clean not in snis:
            snis.append(clean)
    return snis if snis else [DEFAULT_REALITY_SNI]


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


def pick_node_sni(node: dict, forced_sni: str = None) -> str:
    """选择节点下发给客户端的 REALITY SNI：sing-box 仅校验主 server_name（首个 SNI），xray_core 支持多 SNI 随机挑选"""
    snis = get_node_snis(node)
    if str(node.get("core_type") or "xray").lower() == "singbox":
        return snis[0]
    if forced_sni and forced_sni in snis:
        return forced_sni
    return random.choice(snis)


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

    sni = pick_node_sni(node, forced_sni=chosen_sni)
    clean_sni = sni.split(":")[0]
    raw_host = str(node['ip']).strip()
    formatted_host = f"[{raw_host}]" if (":" in raw_host and not raw_host.startswith("[")) else raw_host
    return (
        f"vless://{uuid_str}@{formatted_host}:{node['port']}"
        f"?security=reality&encryption=none&pbk={node['pbk']}&headerType=none&fp=chrome"
        f"&type=tcp&flow=xtls-rprx-vision&sni={clean_sni}&sid={node['sid']}#{urllib.parse.quote(remark)}"
    )


def normalize_hy2_mport(raw) -> str:
    """规范化并校验 Hysteria2 跳跃端口范围，如 '20000-30000' 或 '20000-25000,30000-35000'"""
    s = str(raw or "").strip()
    if not s:
        return ""
    s = s.replace("，", ",").replace(";", ",").replace(" ", "")
    valid_parts: list[str] = []
    for part in s.split(","):
        if not part:
            continue
        if "-" in part:
            segs = part.split("-")
            if len(segs) != 2 or not segs[0].isdigit() or not segs[1].isdigit():
                return ""
            p1, p2 = int(segs[0]), int(segs[1])
            if not (1 <= p1 < p2 <= 65535):
                return ""
            valid_parts.append(f"{p1}-{p2}")
        else:
            if not part.isdigit():
                return ""
            p = int(part)
            if not (1 <= p <= 65535):
                return ""
            valid_parts.append(str(p))
    return ",".join(valid_parts)[:128]


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
    cert_pin = re.sub(r"[^0-9a-fA-F]", "", str(node.get("hy2_cert_sha256") or "")).lower()
    mport = normalize_hy2_mport(node.get("hy2_mport"))

    query_parts = [f"sni={urllib.parse.quote(hy2_sni, safe='')}"]
    if mport:
        query_parts.append(f"mport={mport}")
    if insecure == 1 and len(cert_pin) == 64:
        # 自签证书优先下发 pinSHA256 证书指纹固定 + insecure=0，原生兼容 Xray 26.2.6+ / v2rayNG / v2rayN / Clash / Shadowrocket
        query_parts.append(f"pinSHA256={cert_pin}")
        query_parts.append("insecure=0")
    else:
        query_parts.append(f"insecure={insecure}")

    return (
        f"hysteria2://{uuid_str}@{formatted_host}:{hy2_port}"
        f"?{'&'.join(query_parts)}"
        f"#{urllib.parse.quote(remark + ' [Hy2-UDP]')}"
    )
