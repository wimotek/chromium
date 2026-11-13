"""
Xray-Web 容器启动预热证书初始化工具 (cert_init)
在 Root-Init 阶段（gosu 降权至 appuser 之前）运行：
1. 以 root 身份兼容读取宝塔/Certbot 等只读挂载 /certs:ro 中 0600 权限的证书并复制到 /app/certs
2. 修正 /app/certs 文件属主为 appuser (10001:10001)，权限为 0644 (公钥) 与 0600 (私钥)，绝不修改宿主机原文件
3. 若无任何外部证书，自动生成 10 年期带 IPv4/IPv6 SAN 的自签名证书
4. 确保 Granian 降权后读取 /app/certs/fullchain.pem --ssl-keyfile /app/certs/privkey.pem 100% 就绪！
"""
import sys
import os

CURRENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if CURRENT_DIR not in sys.path:
    sys.path.insert(0, CURRENT_DIR)

from core.cert_manager import ensure_certificates, CERT_PATH, KEY_PATH

def main():
    print("==> [Cert Init] 正在预热初始化 SSL/TLS 证书到 /app/certs...", flush=True)
    c, k = ensure_certificates()
    if os.path.exists(c) and os.path.exists(k):
        print(f"==> [Cert Init] ✅ 证书就绪: {c} ({oct(os.stat(c).st_mode)[-3:]}) | 私钥: {k} ({oct(os.stat(k).st_mode)[-3:]})", flush=True)
        return 0
    else:
        print(f"==> [Cert Init] ❌ 严重错误: /app/certs 证书未能成功就绪！", flush=True)
        return 1

if __name__ == '__main__':
    sys.exit(main())
