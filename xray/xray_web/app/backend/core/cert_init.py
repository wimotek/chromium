"""
Xray-Web 容器启动预热证书初始化工具 (cert_init)
在 Web 容器启动 (Granian 启动监听) 前以 appuser 运行：
1. 检测并从只读外部映射目录 /certs:ro 复制证书至 /app/certs
2. 修复 Linux 权限为 0644 (公钥) 与 0600 (私钥)
3. 若无任何外部证书，自动生成 10 年期带 IP SAN 的自签名证书
4. 确保 Granian --ssl-certfile /app/certs/fullchain.pem --ssl-keyfile /app/certs/privkey.pem 启动时 100% 存在且有效！
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
