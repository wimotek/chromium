import os
import datetime
import subprocess
from OpenSSL import crypto
from core.db import get_setting

CERT_DIR = "/data/certs"
CERT_PATH = os.path.join(CERT_DIR, "fullchain.pem")
KEY_PATH = os.path.join(CERT_DIR, "privkey.pem")
CHALLENGE_DIR = "/data/acme-challenge"

os.makedirs(CERT_DIR, exist_ok=True)
os.makedirs(CHALLENGE_DIR, exist_ok=True)

def generate_self_signed_cert():
    k = crypto.PKey()
    k.generate_key(crypto.TYPE_RSA, 2048)
    cert = crypto.X509()
    cert.get_subject().C = "US"
    cert.get_subject().ST = "California"
    cert.get_subject().L = "San Francisco"
    cert.get_subject().O = "Xray Core"
    cert.get_subject().CN = "xray.internal"
    cert.set_serial_number(1000)
    cert.gmtime_adj_notBefore(0)
    cert.gmtime_adj_notAfter(10 * 365 * 24 * 60 * 60)
    cert.set_issuer(cert.get_subject())
    cert.set_pubkey(k)
    cert.sign(k, 'sha256')

    with open(CERT_PATH, "wb") as f:
        f.write(crypto.dump_certificate(crypto.FILETYPE_PEM, cert))
    with open(KEY_PATH, "wb") as f:
        f.write(crypto.dump_privatekey(crypto.FILETYPE_PEM, k))

def ensure_certificates():
    if not os.path.exists(CERT_PATH) or not os.path.exists(KEY_PATH):
        generate_self_signed_cert()
    return CERT_PATH, KEY_PATH

def get_cert_info() -> dict:
    if not os.path.exists(CERT_PATH):
        return {"status": "none", "is_self_signed": True, "issuer": "", "days_left": 0}
    try:
        with open(CERT_PATH, "rb") as f:
            cert = crypto.load_certificate(crypto.FILETYPE_PEM, f.read())
        issuer = cert.get_issuer().CN or cert.get_issuer().O or "Unknown"
        not_after_bytes = cert.get_notAfter()
        if not_after_bytes:
            not_after = datetime.datetime.strptime(not_after_bytes.decode('ascii'), "%Y%m%d%H%M%SZ")
            days_left = (not_after - datetime.datetime.utcnow()).days
        else:
            days_left = 0
        is_self_signed = (cert.get_issuer().CN == cert.get_subject().CN)
        return {
            "status": "valid" if days_left > 0 else "expired",
            "is_self_signed": is_self_signed,
            "issuer": issuer,
            "days_left": max(0, days_left)
        }
    except Exception:
        return {"status": "error", "is_self_signed": True, "issuer": "Error", "days_left": 0}

def save_custom_certificate(cert_pem: str, key_pem: str) -> tuple[bool, str]:
    cert_str = cert_pem.strip()
    key_str = key_pem.strip()
    if not cert_str or not key_str:
        return False, "证书或私钥内容不能为空"

    try:
        crypto.load_certificate(crypto.FILETYPE_PEM, cert_str.encode('utf-8'))
        crypto.load_privatekey(crypto.FILETYPE_PEM, key_str.encode('utf-8'))
    except Exception as e:
        return False, f"证书格式解析校验失败: {str(e)}"

    with open(CERT_PATH, "w", encoding="utf-8") as f:
        f.write(cert_str + "\n")
    with open(KEY_PATH, "w", encoding="utf-8") as f:
        f.write(key_str + "\n")

    return True, "第三方 SSL 证书导入保存成功！"

def issue_acme_certificate(domain: str, email: str) -> tuple[bool, str]:
    if not domain:
        return False, "申请域名不能为空"
    cmd = [
        "certbot", "certonly", "--webroot",
        "-w", CHALLENGE_DIR,
        "-d", domain,
        "--agree-tos", "--non-interactive"
    ]
    if email:
        cmd.extend(["-m", email])
    else:
        cmd.append("--register-unsafely-without-email")

    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
        if res.returncode == 0:
            live_dir = f"/etc/letsencrypt/live/{domain}"
            live_cert = f"{live_dir}/fullchain.pem"
            live_key = f"{live_dir}/privkey.pem"
            if os.path.exists(live_cert) and os.path.exists(live_key):
                shutil_copy(live_cert, CERT_PATH)
                shutil_copy(live_key, KEY_PATH)
                return True, f"ACME 证书为 [{domain}] 自动签发成功！已更新至系统。"
            return False, "证书签发成功但无法定位 fullchain.pem"
        else:
            return False, f"Certbot 验证失败: {res.stderr or res.stdout}"
    except Exception as e:
        return False, f"执行 ACME 签发异常: {str(e)}"

def shutil_copy(src, dst):
    with open(src, 'rb') as fsrc, open(dst, 'wb') as fdst:
        fdst.write(fsrc.read())

def auto_renew_acme_job():
    acme_enable = get_setting("acme_enable", "false").lower() == "true"
    acme_domain = get_setting("acme_domain", "")
    if not acme_enable or not acme_domain:
        return
    info = get_cert_info()
    if info.get("status") == "valid" and not info.get("is_self_signed") and info.get("days_left", 0) > 30:
        return
    email = get_setting("acme_email", "")
    issue_acme_certificate(acme_domain, email)