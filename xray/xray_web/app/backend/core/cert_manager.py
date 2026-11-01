import os
import shutil
import datetime
import subprocess
from core.db import get_setting

CERT_DIR = "/data/certs"
CERT_PATH = os.path.join(CERT_DIR, "fullchain.pem")
KEY_PATH = os.path.join(CERT_DIR, "privkey.pem")
CHALLENGE_DIR = "/data/acme-challenge"

os.makedirs(CERT_DIR, exist_ok=True)
os.makedirs(CHALLENGE_DIR, exist_ok=True)

def generate_self_signed_cert():
    """纯原生调用系统 openssl 命令行生成 10 年期自签名证书，零 Python 第三方依赖"""
    cmd = [
        "openssl", "req", "-x509", "-nodes",
        "-days", "3650",
        "-newkey", "rsa:2048",
        "-keyout", KEY_PATH,
        "-out", CERT_PATH,
        "-subj", "/C=US/ST=California/L=San Francisco/O=Xray Internal/CN=xray.internal"
    ]
    try:
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:
        print(f"[Cert Error] 生成自签证书失败: {e}", flush=True)

def ensure_certificates() -> tuple[str, str]:
    if not os.path.exists(CERT_PATH) or not os.path.exists(KEY_PATH):
        generate_self_signed_cert()
    return CERT_PATH, KEY_PATH

def get_cert_info() -> dict:
    """使用 openssl x509 CLI 原生解析证书信息与剩余天数"""
    if not os.path.exists(CERT_PATH):
        return {"status": "none", "is_self_signed": True, "issuer": "", "days_left": 0}

    try:
        # 获取颁发者
        res_issuer = subprocess.run(
            ["openssl", "x509", "-in", CERT_PATH, "-noout", "-issuer"],
            capture_output=True, text=True, timeout=5
        )
        issuer_line = res_issuer.stdout.strip() if res_issuer.returncode == 0 else ""
        issuer = issuer_line.replace("issuer=", "").strip() or "Unknown"

        # 获取主体
        res_subject = subprocess.run(
            ["openssl", "x509", "-in", CERT_PATH, "-noout", "-subject"],
            capture_output=True, text=True, timeout=5
        )
        subject_line = res_subject.stdout.strip() if res_subject.returncode == 0 else ""
        is_self_signed = (issuer_line == subject_line) or ("xray.internal" in issuer_line)

        # 获取过期时间
        res_date = subprocess.run(
            ["openssl", "x509", "-in", CERT_PATH, "-noout", "-enddate"],
            capture_output=True, text=True, timeout=5
        )
        enddate_line = res_date.stdout.strip()
        days_left = 0
        if "notAfter=" in enddate_line:
            date_str = enddate_line.replace("notAfter=", "").strip()
            # 常见格式如: Nov 15 12:00:00 2034 GMT
            try:
                exp_date = datetime.datetime.strptime(date_str, "%b %d %H:%M:%S %Y %Z")
                days_left = (exp_date - datetime.datetime.utcnow()).days
            except Exception:
                days_left = 365

        return {
            "status": "valid" if days_left > 0 else "expired",
            "is_self_signed": is_self_signed,
            "issuer": issuer,
            "days_left": max(0, days_left)
        }
    except Exception as e:
        print(f"[Cert Info Error] {e}", flush=True)
        return {"status": "error", "is_self_signed": True, "issuer": "Error", "days_left": 0}

def save_custom_certificate(cert_pem: str, key_pem: str) -> tuple[bool, str]:
    cert_str = cert_pem.strip()
    key_str = key_pem.strip()
    if not cert_str or not key_str:
        return False, "证书或私钥内容不能为空"

    # 写入临时文件校验格式
    tmp_cert = "/tmp/test_cert.pem"
    tmp_key = "/tmp/test_key.pem"
    try:
        with open(tmp_cert, "w", encoding="utf-8") as f:
            f.write(cert_str + "\n")
        with open(tmp_key, "w", encoding="utf-8") as f:
            f.write(key_str + "\n")

        chk_cert = subprocess.run(["openssl", "x509", "-in", tmp_cert, "-noout"], capture_output=True)
        chk_key = subprocess.run(["openssl", "rsa", "-in", tmp_key, "-check", "-noout"], capture_output=True)

        if chk_cert.returncode != 0:
            return False, "证书内容格式无效，无法通过 openssl 验证"
        if chk_key.returncode != 0:
            return False, "私钥内容格式无效，无法通过 openssl 验证"

        shutil.move(tmp_cert, CERT_PATH)
        shutil.move(tmp_key, KEY_PATH)
        return True, "第三方 SSL 证书导入保存成功！"
    except Exception as e:
        return False, f"证书处理异常: {str(e)}"
    finally:
        if os.path.exists(tmp_cert): os.remove(tmp_cert)
        if os.path.exists(tmp_key): os.remove(tmp_key)

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
                shutil.copyfile(live_cert, CERT_PATH)
                shutil.copyfile(live_key, KEY_PATH)
                return True, f"ACME 证书为 [{domain}] 自动签发成功！已生效。"
            return False, "证书签发成功但无法定位 fullchain.pem"
        else:
            return False, f"Certbot 验证失败: {res.stderr or res.stdout}"
    except Exception as e:
        return False, f"执行 ACME 签发异常: {str(e)}"

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