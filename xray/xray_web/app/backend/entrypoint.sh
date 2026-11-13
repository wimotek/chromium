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

# 确保运行时证书与持久化数据目录存在；若以 Root-Init 启动，先修复属主并导入宝塔等 0600 外部只读证书
if [ "$(id -u)" = "0" ]; then
    mkdir -p /app/certs /data /data/backups
    chown -R appuser:appgroup /app/certs /data
    python3 -m core.cert_init
    chown -R appuser:appgroup /app/certs /data
else
    mkdir -p /app/certs /data/backups 2>/dev/null || true
    python3 -m core.cert_init
fi

# 如果未传入命令，或者传入的是默认的 granian-default 占位符
# 动态绑定用户指定的 WEB_HOST / WEB_PORT，并通过 gosu 不可逆降权至非特权用户 appuser (10001)
if [ $# -eq 0 ] || [ "$1" = "granian-default" ]; then
    echo "==> [Granian] 启动 WSGI HTTPS 服务 (UID=$(id -u)->appuser)，监听: [${WEB_HOST}]:${WEB_PORT}，Workers: 2"
    if [ "$(id -u)" = "0" ]; then
        exec gosu appuser:appgroup granian --interface wsgi \
             --host "${WEB_HOST}" --port "${WEB_PORT}" \
             --workers 2 \
             --runtime-threads 1 \
             --blocking-threads 8 \
             --ssl-certificate /app/certs/fullchain.pem \
             --ssl-keyfile /app/certs/privkey.pem \
             app:app
    else
        exec granian --interface wsgi \
             --host "${WEB_HOST}" --port "${WEB_PORT}" \
             --workers 2 \
             --runtime-threads 1 \
             --blocking-threads 8 \
             --ssl-certificate /app/certs/fullchain.pem \
             --ssl-keyfile /app/certs/privkey.pem \
             app:app
    fi
fi

# 执行容器自定义命令 (以 appuser 运行)
if [ "$(id -u)" = "0" ]; then
    exec gosu appuser:appgroup "$@"
fi
exec "$@"
