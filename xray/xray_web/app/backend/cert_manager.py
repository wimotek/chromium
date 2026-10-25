import os
import subprocess
import datetime
from db import get_setting, set_setting

CERTS_DIR = "/data/certs"
CERT_FILE = os.path.join(CERTS_DIR, "cert.pem")
KEY_FILE = os.path.join(CERTS_DIR, "key.pem")
CHALLENGE_DIR = "/data/acme-challenges"

def ensure_certificates() -> tuple[str, str]:
    """
    检查证书是否存在；若不存在或为空，则自动生成 10 年期自签证书兜底
    """
    os.makedirs(CERTS_DIR, exist_ok=True)
    os.makedirs(CHALLENGE_DIR, exist_ok=True)

    has_cert = os.path.exists(CERT_FILE) and os.path.getsize(CERT_FILE) > 0
    has_key = os.path.exists(KEY_FILE) and os.path.getsize(KEY_FILE) > 0

    if not (has_cert and has_key):
        print("==> [HTTPS] 未检测到有效证书，正在自动生成 10 年期自签证书 (Self-Signed)...", flush=True)
        generate_self_signed_cert()
    else:
        print(f"==> [HTTPS] 正在载入证书: {CERT_FILE}", flush=True)

    return CERT_FILE, KEY_FILE

def generate_self_signed_cert():
    """生成自签名证书 (RSA 2048, 3650 天)"""
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
        print("==> [HTTPS] 自签名证书已成功生成至 /data/certs/", flush=True)
    except Exception as e:
        print(f"[HTTPS Error] 生成自签名证书失败: {e}", flush=True)

def get_cert_info() -> dict:
    """解析当前证书的签发者、到期时间与状态"""
    if not (os.path.exists(CERT_FILE) and os.path.getsize(CERT_FILE) > 0):
        return {"status": "none", "msg": "未安装证书"}

    try:
        # 读取证书签发者与主题
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

        # 计算剩余天数
        is_self_signed = "SelfSigned" in info.get("issuer", "") or info.get("issuer") == info.get("subject")
        days_left = 0
        if "not_after" in info:
            try:
                # OpenSSL 日期格式通常为: "Oct 25 10:00:00 2036 GMT"
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
    """保存用户在后台手动粘贴的第三方自定义证书"""
    os.makedirs(CERTS_DIR, exist_ok=True)
    tmp_cert = CERT_FILE + ".tmp"
    tmp_key = KEY_FILE + ".tmp"

    try:
        with open(tmp_cert, "w", encoding="utf-8") as f:
            f.write(cert_content.strip() + "\n")
        with open(tmp_key, "w", encoding="utf-8") as f:
            f.write(key_content.strip() + "\n")

        # 校验证书与密钥是否合法有效
        subprocess.check_output(["openssl", "x509", "-in", tmp_cert, "-noout"], stderr=subprocess.STDOUT)
        subprocess.check_output(["openssl", "rsa", "-in", tmp_key, "-check", "-noout"], stderr=subprocess.STDOUT)

        os.replace(tmp_cert, CERT_FILE)
        os.replace(tmp_key, KEY_FILE)
        return True, "自定义证书已成功安装！重启面板或热更即可生效。"
    except Exception as e:
        if os.path.exists(tmp_cert): os.remove(tmp_cert)
        if os.path.exists(tmp_key): os.remove(tmp_key)
        return False, f"证书校验失败，请检查 PEM 内容是否完整: {str(e)}"

def issue_acme_certificate(domain: str, email: str) -> tuple[bool, str]:
    """使用 acme.sh 通过 Webroot 方式向 Let's Encrypt 申请真实证书"""
    if not domain or "." not in domain:
        return False, "请输入合法的解析域名"

    os.makedirs(CHALLENGE_DIR, exist_ok=True)
    acme_sh = "/root/.acme.sh/acme.sh"

    # 1. 检查并自动安装 acme.sh
    if not os.path.exists(acme_sh):
        print("==> [ACME] 首次运行，正在自动部署 acme.sh 脚本引擎...", flush=True)
        install_cmd = f"curl -s https://get.acme.sh | sh -s email={email or 'admin@example.com'}"
        res = subprocess.run(install_cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        if not os.path.exists(acme_sh):
            return False, f"acme.sh 引擎安装失败: {res.stdout[-300:]}"

    # 2. 调用 acme.sh 执行 Webroot 签发
    cmd_issue = (
        f"{acme_sh} --issue -d {domain} -w {CHALLENGE_DIR} "
        f"--server letsencrypt --force"
    )
    print(f"==> [ACME] 正在为 {domain} 申请 Let's Encrypt 证书...", flush=True)
    res_issue = subprocess.run(cmd_issue, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

    if res_issue.returncode != 0:
        return False, f"证书签发失败，请确认域名已正确解析到本机 IP，且 80/3000 端口未被阻断。\n详情: {res_issue.stdout[-400:]}"

    # 3. 安装证书至 /data/certs/ 目录
    cmd_install = (
        f"{acme_sh} --install-cert -d {domain} "
        f"--cert-file {CERT_FILE} "
        f"--key-file {KEY_FILE} "
        f"--fullchain-file {CERT_FILE}"
    )
    subprocess.run(cmd_install, shell=True, check=True)
    return True, f"域名 {domain} 的正式证书已成功签发并安装！"