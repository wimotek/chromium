import ipaddress
import os
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional, Tuple

import bcrypt
import jwt
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from fastapi import Depends, HTTPException, Header as ReqHeader, Request, Security
from fastapi.security.api_key import APIKeyHeader, APIKeyQuery

from config import CERTS_DIR, DATA_DIR, SSL_CERT_FILE, SSL_KEY_FILE
from core.cache import cache_mgr
from core.db import get_setting, session_scope
from core.models import User
from core.rate_limit import (
    API_KEY_BLOCK_SECONDS,
    API_KEY_FAIL_WINDOW_SEC,
    API_KEY_MAX_FAILURES,
    check_block,
    clear_auth_failures,
    get_client_ip,
    record_auth_failure,
)

api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)
api_key_query = APIKeyQuery(name="api_key", auto_error=False)

_CAPTCHA_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
_CAPTCHA_COLORS = ["#38bdf8", "#34d399", "#f472b6", "#facc15", "#a78bfa", "#fb923c"]


def generate_strong_captcha(length: int = 5) -> Tuple[str, str]:
    """生成抗 OCR 干扰图形验证码 (code, svg_markup)"""
    chars = [secrets.choice(_CAPTCHA_ALPHABET) for _ in range(length)]
    code = "".join(chars)

    width, height = 168, 48
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        '<defs>',
        '<linearGradient id="capBg" x1="0%" y1="0%" x2="100%" y2="100%">',
        '<stop offset="0%" stop-color="#090f1e"/>',
        '<stop offset="100%" stop-color="#13213c"/>',
        '</linearGradient>',
        '</defs>',
        '<rect width="100%" height="100%" fill="url(#capBg)" rx="6"/>',
    ]

    # Subtle background grid
    for gx in range(12, width, 18):
        parts.append(f'<line x1="{gx}" y1="0" x2="{gx}" y2="{height}" stroke="#1e293b" stroke-width="0.8"/>')
    for gy in range(10, height, 12):
        parts.append(f'<line x1="0" y1="{gy}" x2="{width}" y2="{gy}" stroke="#1e293b" stroke-width="0.8"/>')

    # Random Bezier interference waves
    for _ in range(5):
        x1 = secrets.randbelow(25)
        y1 = 6 + secrets.randbelow(height - 12)
        cx1 = 35 + secrets.randbelow(55)
        cy1 = 2 + secrets.randbelow(height - 4)
        cx2 = 90 + secrets.randbelow(50)
        cy2 = 2 + secrets.randbelow(height - 4)
        x2 = width - secrets.randbelow(20)
        y2 = 6 + secrets.randbelow(height - 12)
        c = secrets.choice(_CAPTCHA_COLORS)
        sw = round(1.0 + secrets.randbelow(10) / 10.0, 1)
        parts.append(
            f'<path d="M{x1},{y1} C{cx1},{cy1} {cx2},{cy2} {x2},{y2}" '
            f'fill="none" stroke="{c}" stroke-opacity="0.38" stroke-width="{sw}"/>'
        )

    # Random interference dots
    for _ in range(36):
        dx = 4 + secrets.randbelow(width - 8)
        dy = 4 + secrets.randbelow(height - 8)
        dr = 1 + secrets.randbelow(2)
        c = secrets.choice(_CAPTCHA_COLORS)
        parts.append(f'<circle cx="{dx}" cy="{dy}" r="{dr}" fill="{c}" fill-opacity="0.45"/>')

    # Distorted, rotated, skewed, multi-colored glyphs
    start_x = 18
    step_x = 28
    for idx, ch in enumerate(chars):
        tx = start_x + idx * step_x + (secrets.randbelow(7) - 3)
        ty = 31 + (secrets.randbelow(9) - 4)
        rot = secrets.randbelow(45) - 22
        skew = secrets.randbelow(21) - 10
        fsize = 21 + secrets.randbelow(5)
        c = secrets.choice(_CAPTCHA_COLORS)
        parts.append(
            f'<text x="0" y="0" transform="translate({tx},{ty}) rotate({rot}) skewX({skew})" '
            f'font-family="JetBrains Mono, Consolas, monospace" font-size="{fsize}" font-weight="800" '
            f'fill="{c}" stroke="#020617" stroke-width="0.6">{ch}</text>'
        )

    parts.append("</svg>")
    return code, "".join(parts)


def store_captcha(token: str, answer: Any, ttl_seconds: int = 180):
    payload = {"ans": str(answer).strip().upper(), "exp": time.time() + ttl_seconds}
    cache_mgr.set_json(f"auth:captcha:{token}", payload, ttl=ttl_seconds)


def verify_and_pop_captcha(token: str, user_answer: str) -> bool:
    if not token:
        return False
    key = f"auth:captcha:{token}"
    cap = cache_mgr.get_json(key)
    cache_mgr.delete(key)
    if not cap:
        return False
    if time.time() > float(cap.get("exp", 0)):
        return False
    expected = str(cap.get("ans", "")).strip().upper()
    presented = (user_answer or "").strip().upper()
    if not expected or not presented:
        return False
    return secrets.compare_digest(expected, presented)


def get_email_code_cooldown(email: str) -> int:
    norm = (email or "").strip().lower()
    if not norm:
        return 0
    raw = cache_mgr.get(f"auth:email_cd:{norm}")
    if not raw:
        return 0
    try:
        rem = int(float(raw) - time.time())
        return max(0, rem)
    except (TypeError, ValueError):
        return 0


def store_email_code(email: str, code: str, ttl_seconds: int = 600, cooldown_seconds: int = 60):
    norm = (email or "").strip().lower()
    now = time.time()
    cache_mgr.set_json(
        f"auth:email_otp:{norm}",
        {"code": str(code).strip(), "attempts": 0, "exp": now + ttl_seconds},
        ttl=ttl_seconds,
    )
    cache_mgr.set(f"auth:email_cd:{norm}", f"{now + cooldown_seconds:.2f}", ttl=cooldown_seconds)


def verify_and_pop_email_code(email: str, user_code: str) -> Tuple[bool, str]:
    norm = (email or "").strip().lower()
    presented = (user_code or "").strip()
    if not norm or not presented:
        return False, "请输入邮箱验证码"

    otp_key = f"auth:email_otp:{norm}"
    rec = cache_mgr.get_json(otp_key)
    if not rec:
        return False, "邮箱验证码不存在或已过期，请重新发送"
    if time.time() > float(rec.get("exp", 0)):
        cache_mgr.delete(otp_key)
        return False, "邮箱验证码已过期，请重新获取"

    expected = str(rec.get("code", "")).strip()
    if secrets.compare_digest(expected, presented):
        cache_mgr.delete(otp_key)
        return True, ""

    attempts = int(rec.get("attempts", 0)) + 1
    if attempts >= 5:
        cache_mgr.delete(otp_key)
        return False, "邮箱验证码连续错误 5 次，已作废，请重新发送"

    rem_ttl = max(10, int(float(rec.get("exp", 0)) - time.time()))
    rec["attempts"] = attempts
    cache_mgr.set_json(otp_key, rec, ttl=rem_ttl)
    return False, f"邮箱验证码错误（剩余 {5 - attempts} 次机会）"


def hash_password(password: str) -> str:
    pwd_bytes = password.encode("utf-8")[:72]
    return bcrypt.hashpw(pwd_bytes, bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, hashed: str) -> bool:
    try:
        pwd_bytes = password.encode("utf-8")[:72]
        return bcrypt.checkpw(pwd_bytes, hashed.encode("utf-8"))
    except Exception:
        return False


def issue_user_jwt(user_or_dict: Any, expire_hours: int = 24) -> str:
    jwt_secret = get_setting("jwt_secret")
    if isinstance(user_or_dict, dict):
        uid = int(user_or_dict.get("id") or user_or_dict.get("uid") or 0)
        username = str(user_or_dict.get("username") or user_or_dict.get("sub") or "")
        role = str(user_or_dict.get("role") or "user")
    else:
        uid = int(user_or_dict.id)
        username = str(user_or_dict.username)
        role = str(user_or_dict.role)

    payload = {
        "sub": username,
        "uid": uid,
        "role": role,
        "exp": datetime.now(timezone.utc) + timedelta(hours=expire_hours),
    }
    return jwt.encode(payload, jwt_secret, algorithm="HS256")


def generate_self_signed_cert(cert_file: str, key_file: str):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, "CN"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "WimotekSaaS"),
        x509.NameAttribute(NameOID.COMMON_NAME, "localhost"),
    ])
    now = datetime.now(timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + timedelta(days=3650))
        .add_extension(
            x509.SubjectAlternativeName([
                x509.DNSName("localhost"),
                x509.IPAddress(ipaddress.IPv4Address("127.0.0.1")),
                x509.IPAddress(ipaddress.IPv6Address("::1")),
            ]),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )

    with open(key_file, "wb") as f:
        f.write(key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        ))
    os.chmod(key_file, 0o600)
    with open(cert_file, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))


def ensure_ssl_certificates():
    global SSL_CERT_FILE, SSL_KEY_FILE
    candidates = [
        ("/etc/ssl/app/fullchain.pem", "/etc/ssl/app/privkey.pem"),
        (SSL_CERT_FILE, SSL_KEY_FILE),
    ]
    for cert_path, key_path in candidates:
        cert_exists = os.path.exists(cert_path) and os.path.getsize(cert_path) > 0
        key_exists = os.path.exists(key_path) and os.path.getsize(key_path) > 0
        if cert_exists and key_exists and os.access(cert_path, os.R_OK) and os.access(key_path, os.R_OK):
            SSL_CERT_FILE = cert_path
            SSL_KEY_FILE = key_path
            return cert_path, key_path

    try:
        os.makedirs(CERTS_DIR, exist_ok=True)
        generate_self_signed_cert(SSL_CERT_FILE, SSL_KEY_FILE)
        return SSL_CERT_FILE, SSL_KEY_FILE
    except Exception:
        fallback_dir = os.path.join(DATA_DIR, "certs")
        os.makedirs(fallback_dir, exist_ok=True)
        fallback_cert = os.path.join(fallback_dir, "fullchain.pem")
        fallback_key = os.path.join(fallback_dir, "privkey.pem")
        if not (os.path.exists(fallback_cert) and os.path.exists(fallback_key)):
            generate_self_signed_cert(fallback_cert, fallback_key)
        SSL_CERT_FILE = fallback_cert
        SSL_KEY_FILE = fallback_key
        return fallback_cert, fallback_key


def _load_active_user_by_id(uid: int) -> Optional[Dict[str, Any]]:
    with session_scope() as db:
        u = db.get(User, int(uid))
        if u is None:
            return None
        return u.to_dict(include_secrets=True)


def resolve_user_by_api_key(presented: Optional[str]) -> Optional[Dict[str, Any]]:
    key = (presented or "").strip()
    if not key:
        return None
    with session_scope() as db:
        u = db.query(User).filter(User.api_key == key).first()
        if u is None:
            return None
        if not secrets.compare_digest(key, u.api_key):
            return None
        if u.status != "active":
            return None
        return u.to_dict(include_secrets=True)


def verify_token(request: Request, authorization: Optional[str] = ReqHeader(None)) -> Dict[str, Any]:
    ip = get_client_ip(request)
    check_block("jwt_auth", ip)
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="凭证无效")
    jwt_secret = get_setting("jwt_secret")
    try:
        payload = jwt.decode(authorization.split(" ")[1], jwt_secret, algorithms=["HS256"])
        uid = int(payload.get("uid") or 0)
        if not uid:
            raise ValueError("missing uid")
    except Exception:
        record_auth_failure("jwt_auth", ip, max_failures=30, fail_window_sec=300, block_sec=300)
        raise HTTPException(status_code=401, detail="登录凭证失效")

    user_dict = _load_active_user_by_id(uid)
    if user_dict is None:
        raise HTTPException(status_code=401, detail="账户不存在或已被移除")
    if user_dict.get("status") != "active":
        raise HTTPException(status_code=403, detail="账户已被管理员停用，禁止访问")
    user_dict["uid"] = user_dict["id"]
    user_dict["sub"] = user_dict["username"]
    return user_dict


def require_admin(user: Dict[str, Any] = Depends(verify_token)) -> Dict[str, Any]:
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="仅平台超级管理员可执行此操作")
    return user


def verify_agent_access(
    request: Request,
    header_key: Optional[str] = Security(api_key_header),
    query_key: Optional[str] = Security(api_key_query),
    authorization: Optional[str] = ReqHeader(None),
) -> Dict[str, Any]:
    ip = get_client_ip(request)
    check_block("api_key", ip)

    token_query = request.query_params.get("token")
    for candidate in (header_key, query_key, token_query):
        if candidate:
            u = resolve_user_by_api_key(candidate)
            if u is not None:
                clear_auth_failures("api_key", ip)
                u["uid"] = u["id"]
                u["sub"] = u["username"]
                return u

    if authorization and authorization.startswith("Bearer "):
        bearer_val = authorization[7:].strip()
        u_key = resolve_user_by_api_key(bearer_val)
        if u_key is not None:
            clear_auth_failures("api_key", ip)
            u_key["uid"] = u_key["id"]
            u_key["sub"] = u_key["username"]
            return u_key
        try:
            jwt_secret = get_setting("jwt_secret")
            payload = jwt.decode(bearer_val, jwt_secret, algorithms=["HS256"])
            uid = int(payload.get("uid") or 0)
            if uid:
                u = _load_active_user_by_id(uid)
                if u is not None and u.get("status") == "active":
                    u["uid"] = u["id"]
                    u["sub"] = u["username"]
                    return u
        except Exception:
            pass

    _, blk_sec = record_auth_failure(
        "api_key",
        ip,
        max_failures=API_KEY_MAX_FAILURES,
        fail_window_sec=API_KEY_FAIL_WINDOW_SEC,
        block_sec=API_KEY_BLOCK_SECONDS,
    )
    if blk_sec > 0:
        raise HTTPException(
            status_code=429,
            detail=f"无效 API-Key 尝试过多，已临时封禁 {blk_sec} 秒",
            headers={"Retry-After": str(blk_sec)},
        )
    raise HTTPException(status_code=403, detail="未授权调用: 请提供租户个人有效的 X-API-Key 或 ?api_key=")
