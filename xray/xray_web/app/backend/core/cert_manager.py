import os
import shutil
import datetime
import subprocess
import signal

# 运行期 Granian 专属唯一落地路径 (与 Dockerfile 中 granian 参数严格对齐)
CERT_DIR = "/app/certs"
CERT_PATH = os.path.join(CERT_DIR, "fullchain.pem")
KEY_PATH = os.path.join(CERT_DIR, "privkey.pem")

# 外部只读挂载候选目录 (用户通过 -v /host/certs:/certs:ro 挂载自定义证书)
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
    """确保运行时证书目录存在"""
    try:
        os.makedirs(CERT_DIR, exist_ok=True)
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
    """使用 openssl CLI 生成符合现代 TLS 1.2/1.3 规范（含 digitalSignature）的 10 年期证书至 /app/certs"""
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
O = Wimotek Edge
CN = wimotek.internal

[v3_req]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment, dataEncipherment
extendedKeyUsage = serverAuth, clientAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
DNS.2 = *.wimotek.com
DNS.3 = *.internal
DNS.4 = *
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
        print("==> [Cert Init] ✅ 现代 TLS 兼容自签证书生成完毕 (支持 TLS 1.2/1.3 digitalSignature 与全域通配符)", flush=True)
    except Exception as e:
        print(f"[Cert Error] 生成自签证书失败: {e}", flush=True)
    finally:
        if os.path.exists(tmp_cnf):
            try:
                os.remove(tmp_cnf)
            except Exception:
                pass

def _verify_private_key(key_file: str) -> bool:
    """兼容验证 RSA 与 ECC / ECDSA 格式的私钥"""
    res = subprocess.run(["openssl", "pkey", "-in", key_file, "-check", "-noout"], capture_output=True)
    if res.returncode == 0:
        return True
    res_rsa = subprocess.run(["openssl", "rsa", "-in", key_file, "-check", "-noout"], capture_output=True)
    return res_rsa.returncode == 0

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
            if chk_cert.returncode == 0 and _verify_private_key(matched_key):
                print(f"==> [SSL Import] 🟢 从外部挂载目录 {d} 成功检测到有效证书！", flush=True)
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
    2. 其次复用 /app/certs 已存在的有效证书（若为旧版自签缺 digitalSignature 则自动平滑重签）
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
        if chk_cert.returncode == 0 and _verify_private_key(KEY_PATH):
            chk_txt = subprocess.run(["openssl", "x509", "-in", CERT_PATH, "-text", "-noout"], capture_output=True, text=True)
            if "Digital Signature" not in chk_txt.stdout and "digitalSignature" not in chk_txt.stdout:
                print("==> [SSL Notice] 检测到历史自签证书缺少 Digital Signature 密钥用途，正在自动升级为标准 TLS 证书...", flush=True)
                generate_self_signed_cert()
            else:
                set_safe_permissions(CERT_PATH, KEY_PATH)
            return CERT_PATH, KEY_PATH

    # 3. 兜底自动生成自签名证书
    print("==> [SSL Notice] 未找到有效证书，自动生成 10 年期自签证书至 /app/certs...", flush=True)
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

def get_cert_info() -> dict:
    """原生 openssl 解析当前 /app/certs/fullchain.pem 证书状态与过期时间"""
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
        is_self_signed = (issuer_line == subject_line) or ("wimotek.internal" in issuer_line) or ("xray.internal" in issuer_line)

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
            "days_left": max(0, days_left),
            "cert_path": CERT_PATH,
            "key_path": KEY_PATH
        }
    except Exception as e:
        print(f"[Cert Info Error] {e}", flush=True)
        return {"status": "error", "is_self_signed": True, "issuer": "Error", "days_left": 0}