import os
import bcrypt
import jwt
import ipaddress
from datetime import datetime, timedelta, timezone
from typing import Optional
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException, Header as ReqHeader, Security
from fastapi.security.api_key import APIKeyHeader, APIKeyQuery
from core.config import CERTS_DIR, DATA_DIR, SSL_CERT_FILE, SSL_KEY_FILE, logger
from core.database import get_setting

api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)
api_key_query = APIKeyQuery(name="api_key", auto_error=False)

CAPTCHA_STORE = {}

def hash_password(password: str) -> str:
    pwd_bytes = password.encode('utf-8')[:72]
    return bcrypt.hashpw(pwd_bytes, bcrypt.gensalt()).decode('utf-8')

def verify_password(password: str, hashed: str) -> bool:
    try:
        pwd_bytes = password.encode('utf-8')[:72]
        return bcrypt.checkpw(pwd_bytes, hashed.encode('utf-8'))
    except Exception:
        return False

def generate_self_signed_cert(cert_file: str, key_file: str):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, "CN"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "ChromiumSync"),
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
    has_cert = os.path.exists(SSL_CERT_FILE) and os.path.getsize(SSL_CERT_FILE) > 0
    has_key = os.path.exists(SSL_KEY_FILE) and os.path.getsize(SSL_KEY_FILE) > 0

    if not (has_cert and has_key):
        logger.warning("未检测到有效证书，正在生成自签 SSL 证书...")
        try:
            os.makedirs(CERTS_DIR, exist_ok=True)
            generate_self_signed_cert(SSL_CERT_FILE, SSL_KEY_FILE)
        except Exception as e:
            fallback_dir = os.path.join(DATA_DIR, "certs")
            os.makedirs(fallback_dir, exist_ok=True)
            SSL_CERT_FILE = os.path.join(fallback_dir, "fullchain.pem")
            SSL_KEY_FILE = os.path.join(fallback_dir, "privkey.pem")
            generate_self_signed_cert(SSL_CERT_FILE, SSL_KEY_FILE)

def verify_token(authorization: Optional[str] = ReqHeader(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="凭证无效")
    jwt_secret = get_setting('jwt_secret')
    try:
        return jwt.decode(authorization.split(" ")[1], jwt_secret, algorithms=["HS256"])
    except Exception:
        raise HTTPException(status_code=401, detail="登录凭证失效")

def verify_agent_access(
    header_key: Optional[str] = Security(api_key_header),
    query_key: Optional[str] = Security(api_key_query),
    authorization: Optional[str] = ReqHeader(None)
):
    valid_key = get_setting('api_key')
    if (header_key and header_key == valid_key) or (query_key and query_key == valid_key):
        return {"sub": "external_agent"}
    if authorization and authorization.startswith("Bearer "):
        try:
            jwt_secret = get_setting('jwt_secret')
            return jwt.decode(authorization.split(" ")[1], jwt_secret, algorithms=["HS256"])
        except Exception:
            pass
    raise HTTPException(status_code=403, detail="未授权调用: 请在 Header 提供 X-API-Key 或 ?api_key=")