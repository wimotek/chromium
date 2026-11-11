import os
import shutil
import datetime
import subprocess
import signal
from core.db import get_setting

# 运行期 Granian 专属唯一落地路径 (与 Dockerfile 中 granian 参数严格对齐)
CERT_DIR = "/app/certs"
CERT_PATH = os.path.join(CERT_DIR, "fullchain.pem")
KEY_PATH = os.path.join(CERT_DIR, "privkey.pem")

CHALLENGE_DIR = "/data/acme-challenge"

# 外部只读挂载候选目录 (用户通过 -v /host/path:/certs:ro 挂载)
EXTERNAL_CERT_DIRS = ["/certs"]

# 常见的公钥证书候选文件名
CERT_CANDIDATES = [
    "fullchain.pem", "certificate.crt", "fullchain.crt", "server.crt", "cert.pem", "bundle.crt"
]

# 常见的私钥候选文件名
KEY_CANDIDATES = [
    "privkey.pem", "private.key", "server.key", "key.pem"
]

def ensure_dirs():
    """确保运行时证书与 ACME 挑战目录存在"""
    for d in [CERT_DIR, CHALLENGE_DIR]:
        try:
            os.makedirs(d, exist_ok=True)
        except Exception:
            pass

ensure_dirs()

def set_safe_permissions(cert_file: str, key_file: str):
    """
    为目标证书与私钥设置严格安全的 Linux 权限:
    - 公钥证书: 0644 (所有组可读)
    - 私钥文件: 0600 (仅属主 appuser 可读写)
    """
    try:
        if os.path.exists(cert_file):
            os.chmod(cert_file, 0o644)
    except Exception:
        pass
    try:
        if os.path.exists(key_file):
            os.chmod(key_file, 0o600)
    except Exception:
        pass

def generate_self_signed_cert(target_cert: str = CERT_PATH, target_key: str = KEY_PATH):
    """使用 openssl CLI 生成带 IP SAN (含 127.0.0.1, 0.0.0.0, localhost) 的 10 年期自签证书至 /app/certs"""
    ensure_dirs()
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
        with open(tmp_cnf, "w", encoding="utf-8") as f:
            f.write(openssl_cnf)
        cmd = [
            "openssl", "req", "-x509", "-nodes",
            "-days", "3650",
            "-newkey", "rsa:2048",
            "-keyout", target_key,
            "-out", target_cert,
            "-config", tmp_cnf
        ]
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        set_safe_permissions(target_cert, target_key)
    except Exception as e:
        print(f"[Cert Error] 生成自签证书失败: {e}", flush=True)
    finally:
        if os.path.exists(tmp_cnf):
            try:
                os.remove(tmp_cnf)
            except Exception:
                pass

def find_and_import_external_certs() -> bool:
    """
    全自动扫描外部挂载的只读证书目录 (/certs:ro):
    若识别到有效的证书与私钥，安全复制到 /app/certs 并赋予正确的属主与 0644/0600 权限
    """
    ensure_dirs()
    for d in EXTERNAL_CERT_DIRS:
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

        # 2. 如果未命名标准，按文件扩展名智能推断
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
            chk_cert = subprocess.run(["openssl", "x509", "-in", matched_cert, "-noout"], capture_output=True)
            chk_key = subprocess.run(["openssl", "rsa", "-in", matched_key, "-check", "-noout"], capture_output=True)
            if chk_cert.returncode == 0 and chk_key.returncode == 0:
                print(f"==> [SSL Import] 🟢 从外部只读目录 {d} 成功检测到有效证书！", flush=True)
                shutil.copyfile(matched_cert, CERT_PATH)
                shutil.copyfile(matched_key, KEY_PATH)
                set_safe_permissions(CERT_PATH, KEY_PATH)
                print(f"==> [SSL Import] 证书已成功导入至 {CERT_PATH}，权限已设为 0644/0600", flush=True)
                return True
    return False

def ensure_certificates() -> tuple[str, str]:
    """
    容器启动及运行期证书落地总入口：
    1. 优先扫描并对齐 /certs:ro 外部挂载证书，拷贝至 /app/certs
    2. 其次复用 /app/certs 已存在的有效证书
    3. 兜底自动生成带 127.0.0.1 IP SAN 的自签名证书
    确保 /app/certs/fullchain.pem 与 /app/certs/privkey.pem 百分之百就绪！
    """
    ensure_dirs()

    # 1. 尝试导入外部挂载证书
    if find_and_import_external_certs():
        return CERT_PATH, KEY_PATH

    # 2. 如果 /app/certs 已存在且有效
    if os.path.exists(CERT_PATH) and os.path.exists(KEY_PATH):
        chk_cert = subprocess.run(["openssl", "x509", "-in", CERT_PATH, "-noout"], capture_output=True)
        if chk_cert.returncode == 0:
            set_safe_permissions(CERT_PATH, KEY_PATH)
            return CERT_PATH, KEY_PATH

    # 3. 兜底自动生成自签名证书
    print("==> [SSL Notice] 未找到有效证书，自动生成 10 年期自签证书 (含 127.0.0.1 IP SAN) 至 /app/certs...", flush=True)
    generate_self_signed_cert()
    return CERT_PATH, KEY_PATH

def reload_granian_server() -> bool:
    """通过向 Granian 主进程发送 SIGHUP 信号，实现内存中 TLS 证书的平滑零宕机重载"""
    try:
        ppid = os.getppid()
        if ppid > 1:
            os.kill(ppid, signal.SIGHUP)
            print(f"[SSL Reload] 已向 Granian 主进程 (PID: {ppid}) 发送 SIGHUP 信号完成平滑重载！", flush=True)
            return True
    except Exception as e:
        print(f"[SSL Reload Warn] 无法向父进程发送 SIGHUP: {e}", flush=True)
    return False

def save_custom_certificate(cert_pem: str, key_pem: str) -> tuple[bool, str]:
    """后台手动粘贴证书 PEM 后的保存逻辑：写入 /app/certs 并触发重载"""
    cert_str = cert_pem.strip()
    key_str = key_pem.strip()
    if not cert_str or not key_str:
        return False, "证书或私钥内容不能为空"

    ensure_dirs()
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

        # 直接写入 /app/certs
        shutil.copyfile(tmp_cert, CERT_PATH)
        shutil.copyfile(tmp_key, KEY_PATH)
        set_safe_permissions(CERT_PATH, KEY_PATH)

        # 触发 Granian 平滑热重载
        reload_granian_server()
        return True, "第三方 SSL 证书已成功保存至 /app/certs，并已通知服务平滑重载！"
    except Exception as e:
        return False, f"证书处理异常: {str(e)}"
    finally:
        if os.path.exists(tmp_cert):
            try: os.remove(tmp_cert)
            except Exception: pass
        if os.path.exists(tmp_key):
            try: os.remove(tmp_key)
            except Exception: pass

def get_cert_info() -> dict:
    """原生 openssl 解析当前 /app/certs/fullchain.pem 证书信息"""
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

def issue_acme_certificate(domain: str, email: str) -> tuple[bool, str]:
    """ACME 自动签发并直接落地至 /app/certs"""
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
                set_safe_permissions(CERT_PATH, KEY_PATH)

                reload_granian_server()
                return True, f"ACME 证书为 [{domain}] 自动签发成功！已落地至 /app/certs 并平滑生效。"
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