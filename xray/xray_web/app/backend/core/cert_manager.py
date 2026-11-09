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
    """使用系统原生 openssl CLI 生成带 IP SAN (包含 127.0.0.1) 的 10 年期自签名证书"""
    openssl_cnf = """
[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no

[req_distinguished_name]
C = US
ST = California
L = San Francisco
O = Xray Internal
CN = xray.internal

[v3_req]
keyUsage = keyEncipherment, dataEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
DNS.2 = xray.internal
IP.1 = 127.0.0.1
IP.2 = 0.0.0.0
"""
    tmp_cnf = "/tmp/openssl_san.cnf"
    try:
        with open(tmp_cnf, "w") as f:
            f.write(openssl_cnf)
        cmd = [
            "openssl", "req", "-x509", "-nodes",
            "-days", "3650",
            "-newkey", "rsa:2048",
            "-keyout", KEY_PATH,
            "-out", CERT_PATH,
            "-config", tmp_cnf
        ]
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:
        print(f"[Cert Error] 生成带 IP SAN 自签证书失败: {e}", flush=True)
    finally:
        if os.path.exists(tmp_cnf):
            try:
                os.remove(tmp_cnf)
            except Exception:
                pass

# 候选证书挂载目录列表 (支持 /certs 以及 /data/certs)
SEARCH_DIRS = ["/certs", "/data/certs"]

# 常见的宝塔、Nginx、Certbot 证书公钥文件名候选 (按优先级匹配)
CERT_CANDIDATES = [
    "fullchain.pem", "certificate.crt", "fullchain.crt", "server.crt", "cert.pem", "bundle.crt"
]

# 常见的私钥文件名候选
KEY_CANDIDATES = [
    "privkey.pem", "private.key", "server.key", "key.pem"
]

def find_custom_certificates() -> tuple[str, str]:
    """
    全自动扫描外部映射的自定义证书 (如宝塔面板、Nginx、Certbot):
    支持挂载到 /certs 或 /data/certs 下的任意常见命名证书文件
    """
    for d in SEARCH_DIRS:
        if not os.path.exists(d):
            continue

        matched_cert = None
        matched_key = None

        # 1. 优先匹配标准名称
        for c_name in CERT_CANDIDATES:
            c_p = os.path.join(d, c_name)
            if os.path.isfile(c_p) and os.path.getsize(c_p) > 0:
                matched_cert = c_p
                break

        for k_name in KEY_CANDIDATES:
            k_p = os.path.join(d, k_name)
            if os.path.isfile(k_p) and os.path.getsize(k_p) > 0:
                matched_key = k_p
                break

        # 2. 如果未命中，扫描目录下任何以 .crt / .pem 和 .key 结尾的配对文件
        if not matched_cert or not matched_key:
            try:
                files = os.listdir(d)
                for f in files:
                    fp = os.path.join(d, f)
                    if not os.path.isfile(fp) or os.path.getsize(fp) == 0:
                        continue
                    low = f.lower()
                    if not matched_cert and (low.endswith(".crt") or (low.endswith(".pem") and "key" not in low)):
                        matched_cert = fp
                    elif not matched_key and (low.endswith(".key") or "key" in low):
                        matched_key = fp
            except Exception:
                pass

        if matched_cert and matched_key:
            # 解决外部挂载权限问题 (如 root 映射只读，确保容器内部具备读取权限)
            try:
                os.chmod(matched_cert, 0o644)
                os.chmod(matched_key, 0o600)
            except Exception:
                pass

            # 校验私钥与公钥的有效性
            chk_cert = subprocess.run(["openssl", "x509", "-in", matched_cert, "-noout"], capture_output=True)
            chk_key = subprocess.run(["openssl", "rsa", "-in", matched_key, "-check", "-noout"], capture_output=True)
            if chk_cert.returncode == 0 and chk_key.returncode == 0:
                return matched_cert, matched_key

    return "", ""

def ensure_certificates() -> tuple[str, str]:
    """
    证书决策核心：
    1. 优先扫描 /certs 或 /data/certs 下外部挂载的自定义有效证书 (宝塔/Nginx/Certbot)
    2. 若未检测到外部自定义证书，则自动生成带 IP SAN (127.0.0.1) 的自签名证书
    """
    custom_cert, custom_key = find_custom_certificates()
    if custom_cert and custom_key:
        print(f"==> [SSL Discovery] 🟢 成功识别到外部自定义证书！", flush=True)
        print(f"    - 公钥证书: {custom_cert}", flush=True)
        print(f"    - 私钥文件: {custom_key}", flush=True)
        return custom_cert, custom_key

    # 未检测到外部自定义证书，使用自签名证书
    if not os.path.exists(CERT_PATH) or not os.path.exists(KEY_PATH):
        print("==> [SSL Notice] 未检测到外部自定义证书，自动生成 10 年期自签证书 (含 127.0.0.1 IP SAN)...", flush=True)
        generate_self_signed_cert()
    else:
        print(f"==> [SSL Notice] 使用系统默认自签名证书: {CERT_PATH}", flush=True)

    try:
        os.chmod(CERT_PATH, 0o644)
        os.chmod(KEY_PATH, 0o600)
    except Exception:
        pass

    return CERT_PATH, KEY_PATH

def get_cert_info() -> dict:
    """使用系统 openssl x509 CLI 原生解析证书信息与剩余天数"""
    if not os.path.exists(CERT_PATH):
        return {"status": "none", "is_self_signed": True, "issuer": "", "days_left": 0}

    try:
        res_issuer = subprocess.run(
            ["openssl", "x509", "-in", CERT_PATH, "-noout", "-issuer"],
            capture_output=True, text=True, timeout=5
        )
        issuer_line = res_issuer.stdout.strip() if res_issuer.returncode == 0 else ""
        issuer = issuer_line.replace("issuer=", "").strip() or "Unknown"

        res_subject = subprocess.run(
            ["openssl", "x509", "-in", CERT_PATH, "-noout", "-subject"],
            capture_output=True, text=True, timeout=5
        )
        subject_line = res_subject.stdout.strip() if res_subject.returncode == 0 else ""
        is_self_signed = (issuer_line == subject_line) or ("xray.internal" in issuer_line)

        res_date = subprocess.run(
            ["openssl", "x509", "-in", CERT_PATH, "-noout", "-enddate"],
            capture_output=True, text=True, timeout=5
        )
        enddate_line = res_date.stdout.strip()
        days_left = 0
        if "notAfter=" in enddate_line:
            date_str = enddate_line.replace("notAfter=", "").strip()
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