#!/bin/sh
set -e

# 解析用户传入的 WEB_PORT / WEB_HOST 环境变量
export WEB_PORT="${WEB_PORT:-8443}"

# 若未显式指定 WEB_HOST，自动探测内核是否支持双栈监听 (:: 且 IPV6_V6ONLY=0)
# 支持则绑定 "::" 同时监听 IPv4 与 IPv6；若宿主机禁用 IPv6 或开启了 bindv6only=1 则安全回退 "0.0.0.0"
if [ -z "${WEB_HOST}" ]; then
    WEB_HOST=$(python3 -c '
import socket
try:
    s = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
    v6only = s.getsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY)
    s.bind(("::", 0))
    s.close()
    print("::" if v6only == 0 else "0.0.0.0")
except Exception:
    print("0.0.0.0")
')
fi
export WEB_HOST

# 确保运行时证书与备份目录存在
mkdir -p /app/certs /data/backups

# 核心：在 Granian 监听绑定 SSL 套接字之前预热初始化证书
# 1. 自动从只读 /certs:ro 读取外部证书并复制到 /app/certs
# 2. 修正权限为 0644 (公钥) 与 0600 (私钥)
# 3. 若无外部证书，自动生成带 127.0.0.1 IP SAN 的自签名证书兜底至 /app/certs
# 确保 Granian 启动读取 /app/certs 时 100% 存在且有效，绝不 Crash！
python3 -m core.cert_init

# 如果未传入命令，或者传入的是默认的 granian-default 占位符
# 动态绑定用户指定的 WEB_HOST / WEB_PORT，解决 Dockerfile 无法动态展开变量的问题
if [ $# -eq 0 ] || [ "$1" = "granian-default" ]; then
    echo "==> [Granian] 启动 WSGI HTTPS 服务，监听: [${WEB_HOST}]:${WEB_PORT}，Workers: 2"
    exec granian --interface wsgi \
         --host "${WEB_HOST}" --port "${WEB_PORT}" \
         --workers 2 \
         --runtime-threads 1 \
         --blocking-threads 8 \
         --ssl-certificate /app/certs/fullchain.pem \
         --ssl-keyfile /app/certs/privkey.pem \
         app:app
fi

# 执行容器自定义主进程命令 (以 appuser 运行)
exec "$@"
