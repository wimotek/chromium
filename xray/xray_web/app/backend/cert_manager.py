import os
import subprocess
import datetime
from db import get_setting

CERTS_DIR = "/data/certs"
CERT_FILE = os.path.join(CERTS_DIR, "fullchain.pem")  # 统一标准：完整证书链
KEY_FILE = os.path.join(CERTS_DIR, "privkey.pem")     # 统一标准：私钥文件
CHALLENGE_DIR = "/data/acme-challenges"

def cleanup_legacy_files():
    """自动清理并迁移历史遗留的旧命名，避免混淆"""
    old_cert = os.path.join(CERTS_DIR, "cert.pem")
    old_key = os.path.join(CERTS_DIR, "key.pem")

    try:
        if os.path.exists(old_cert) and not os.path.exists(CERT_FILE):
            os.replace(old_cert, CERT_FILE)
        elif os.path.exists(old_cert):
            os.remove(old_cert)

        if os.path.exists(old_key) and not os.path.exists(KEY_FILE):
            os.replace(old_key, KEY_FILE)
        elif os.path.exists(old_key):
            os.remove(old_key)
    except Exception:
        pass

def ensure_certificates() -> tuple[str, str]:
    """
    检查证书：仅认准 fullchain.pem 和 privkey.pem；缺失时自动生成自签名证书
    """
    os.makedirs(CERTS_DIR, exist_ok=True)
    os.makedirs(CHALLENGE_DIR, exist_ok=True)
    cleanup_legacy_files()

    has_cert = os.path.exists(CERT_FILE) and os.path.getsize(CERT_FILE) > 0
    has_key = os.path.exists(KEY_FILE) and os.path.getsize(KEY_FILE) > 0

    if not (has_cert and has_key):
        print("==> [HTTPS] 未检测到证书，正在自动生成自签名证书 (fullchain.pem & privkey.pem)...", flush=True)
        generate_self_signed_cert()
    else:
        print(f"==> [HTTPS] 正在载入正式证书: fullchain.pem 和 privkey.pem", flush=True)

    return CERT_FILE, KEY_FILE

def generate_self_signed_cert():
    """生成 10 年期自签名证书并直接命名为 fullchain.pem 和 privkey.pem"""
    os.makedirs(CERTS_DIR, exist_ok=True)
    cmd = [
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", KEY_FILE,
        "-out", CERT_FILE,
        "-days", "3650",
        "-subj", "/CN=Xray-Web-Master/O=SelfSigned",
        "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"
    ]
    try:
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        print("==> [HTTPS] 自签名证书已就绪: /data/certs/fullchain.pem", flush=True)
    except Exception as e:
        print(f"[HTTPS Error] 生成自签名证书失败: {e}", flush=True)

def get_cert_info() -> dict:
    """动态读取并解析当前 fullchain.pem 的证书信息"""
    cleanup_legacy_files()
    if not (os.path.exists(CERT_FILE) and os.path.getsize(CERT_FILE) > 0):
        return {"status": "none", "msg": "未安装证书"}

    try:
        cmd_info = ["openssl", "x509", "-in", CERT_FILE, "-noout", "-issuer", "-subject", "-dates"]
        res = subprocess.check_output(cmd_info, text=True, stderr=subprocess.DEVNULL)
        
        info = {}
        for line in res.splitlines():
            if line.startswith("issuer="):
                info["issuer"] = line.split("=", 1)[1].strip()
            elif line.startswith("subject="):
                info["subject"] = line.split("=", 1)[1].strip()
            elif line.startswith("notAfter="):
                info["not_after"] = line.split("=", 1)[1].strip()

        is_self_signed = "SelfSigned" in info.get("issuer", "") or info.get("issuer") == info.get("subject")
        days_left = 0
        if "not_after" in info:
            try:
                exp_date = datetime.datetime.strptime(info["not_after"], "%b %d %H:%M:%S %Y %Z")
                days_left = (exp_date - datetime.datetime.utcnow()).days
            except Exception:
                pass

        return {
            "status": "valid",
            "is_self_signed": is_self_signed,
            "issuer": info.get("issuer", "Unknown"),
            "subject": info.get("subject", "Unknown"),
            "expire_date": info.get("not_after", "Unknown"),
            "days_left": days_left,
            "cert_path": CERT_FILE,
            "key_path": KEY_FILE
        }
    except Exception as e:
        return {"status": "error", "msg": f"解析证书失败: {str(e)}"}

def save_custom_certificate(cert_content: str, key_content: str) -> tuple[bool, str]:
    """保存第三方证书，强制写入 fullchain.pem 与 privkey.pem"""
    os.makedirs(CERTS_DIR, exist_ok=True)
    tmp_cert = CERT_FILE + ".tmp"
    tmp_key = KEY_FILE + ".tmp"

    try:
        with open(tmp_cert, "w", encoding="utf-8") as f:
            f.write(cert_content.strip() + "\n")
        with open(tmp_key, "w", encoding="utf-8") as f:
            f.write(key_content.strip() + "\n")

        subprocess.check_output(["openssl", "x509", "-in", tmp_cert, "-noout"], stderr=subprocess.STDOUT)
        subprocess.check_output(["openssl", "rsa", "-in", tmp_key, "-check", "-noout"], stderr=subprocess.STDOUT)

        os.replace(tmp_cert, CERT_FILE)
        os.replace(tmp_key, KEY_FILE)
        cleanup_legacy_files()
        return True, "证书已安装并保存为 fullchain.pem 和 privkey.pem！"
    except Exception as e:
        if os.path.exists(tmp_cert): os.remove(tmp_cert)
        if os.path.exists(tmp_key): os.remove(tmp_key)
        return False, f"证书校验失败: {str(e)}"

def ensure_acme_installed(email: str = "") -> bool:
    acme_sh = "/root/.acme.sh/acme.sh"
    if os.path.exists(acme_sh):
        return True

    print("==> [ACME] 正在自动安装 acme.sh 引擎...", flush=True)
    install_cmd = f"curl -s https://get.acme.sh | sh -s email={email or 'admin@example.com'} --force"
    subprocess.run(install_cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    return os.path.exists(acme_sh)

def issue_acme_certificate(domain: str, email: str) -> tuple[bool, str]:
    if not domain or "." not in domain:
        return False, "请输入合法的解析域名"

    if not ensure_acme_installed(email):
        return False, "acme.sh 引擎安装失败，请检查网络"

    acme_sh = "/root/.acme.sh/acme.sh"
    os.makedirs(CHALLENGE_DIR, exist_ok=True)

    print(f"==> [ACME] 正在为 {domain} 申请 Let's Encrypt 证书...", flush=True)
    cmd_issue = (
        f"{acme_sh} --issue -d {domain} --standalone --httpport 80 "
        f"--server letsencrypt --force"
    )
    res = subprocess.run(cmd_issue, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    
    if res.returncode != 0:
        cmd_webroot = (
            f"{acme_sh} --issue -d {domain} -w {CHALLENGE_DIR} "
            f"--server letsencrypt --force"
        )
        res = subprocess.run(cmd_webroot, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

    if res.returncode != 0:
        return False, f"证书申请失败，请确认域名已解析到本机 IP 且 80 端口未被占用。\n详情: {res.stdout[-350:]}"

    # 核心安装：严格指定生成 privkey.pem 与 fullchain.pem
    cmd_install = (
        f"{acme_sh} --install-cert -d {domain} "
        f"--key-file {KEY_FILE} "
        f"--fullchain-file {CERT_FILE}"
    )
    subprocess.run(cmd_install, shell=True, check=True)
    cleanup_legacy_files()
    return True, f"域名 {domain} 证书已成功安装为 fullchain.pem 和 privkey.pem！"

def auto_renew_acme_job():
    acme_enable = get_setting("acme_enable", "false").lower() == "true"
    if not acme_enable:
        return

    cert = get_cert_info()
    if cert.get("status") == "valid" and not cert.get("is_self_signed"):
        if cert.get("days_left", 999) <= 20:
            domain = get_setting("acme_domain", "").strip()
            email = get_setting("acme_email", "").strip()
            if domain:
                print(f"==> [ACME 自动续签] 证书剩余 {cert.get('days_left')} 天，触发后台自动续期: {domain}...", flush=True)
                ok, msg = issue_acme_certificate(domain, email)
                print(f"==> [ACME 自动续签结果]: {msg}", flush=True)