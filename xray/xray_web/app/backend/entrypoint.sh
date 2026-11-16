#!/bin/sh
set -e

# 解析用户传入的 WEB_PORT / WEB_HOST / 并发参数 / 前后端分离开关
export WEB_PORT="${WEB_PORT:-8443}"
export WEB_WORKERS="${WEB_WORKERS:-2}"
export WEB_RUNTIME_THREADS="${WEB_RUNTIME_THREADS:-1}"
export WEB_BLOCKING_THREADS="${WEB_BLOCKING_THREADS:-16}"
export WEB_BACKLOG="${WEB_BACKLOG:-2048}"

SEPARATE_NORM=$(printf '%s' "${SEPARATE_FRONTEND:-false}" | tr '[:upper:]' '[:lower:]')
IS_SEPARATED=0
case "${SEPARATE_NORM}" in
    true|1|yes)
        IS_SEPARATED=1
        ;;
esac

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

# 确保持久化数据目录存在；仅在非分离模式下初始化 /app/certs 与自签/宝塔证书导入
if [ "$(id -u)" = "0" ]; then
    mkdir -p /data /data/backups
    chown -R appuser:appgroup /data
    if [ "${IS_SEPARATED}" -eq 0 ]; then
        mkdir -p /app/certs
        chown -R appuser:appgroup /app/certs
        python3 -c 'import sys; from core.cert_init import main; sys.exit(main())'
        chown -R appuser:appgroup /app/certs /data
    else
        echo "==> [Sep Mode] SEPARATE_FRONTEND=true：已跳过容器内 TLS 证书初始化，证书与静态资源交由 Nginx 负责"
    fi
else
    mkdir -p /data/backups 2>/dev/null || true
    if [ "${IS_SEPARATED}" -eq 0 ]; then
        mkdir -p /app/certs 2>/dev/null || true
        python3 -c 'import sys; from core.cert_init import main; sys.exit(main())'
    else
        echo "==> [Sep Mode] SEPARATE_FRONTEND=true：已跳过容器内 TLS 证书初始化，证书与静态资源交由 Nginx 负责"
    fi
fi

# 如果未传入命令，或者传入的是默认的 granian-default 占位符
# 动态绑定用户指定的 WEB_HOST / WEB_PORT，并通过 gosu 不可逆降权至非特权用户 appuser (10001)
if [ $# -eq 0 ] || [ "$1" = "granian-default" ]; then
    if [ "${IS_SEPARATED}" -eq 1 ]; then
        echo "==> [Granian] 启动前后端分离纯 HTTP API 服务 (UID=$(id -u)->appuser)，监听: http://[${WEB_HOST}]:${WEB_PORT}，Workers=${WEB_WORKERS}, BlockingThreads=${WEB_BLOCKING_THREADS}, Backlog=${WEB_BACKLOG}"
        if [ "$(id -u)" = "0" ]; then
            exec gosu appuser:appgroup granian --interface wsgi \
                 --host "${WEB_HOST}" --port "${WEB_PORT}" \
                 --workers "${WEB_WORKERS}" \
                 --runtime-threads "${WEB_RUNTIME_THREADS}" \
                 --blocking-threads "${WEB_BLOCKING_THREADS}" \
                 --backlog "${WEB_BACKLOG}" \
                 app:app
        else
            exec granian --interface wsgi \
                 --host "${WEB_HOST}" --port "${WEB_PORT}" \
                 --workers "${WEB_WORKERS}" \
                 --runtime-threads "${WEB_RUNTIME_THREADS}" \
                 --blocking-threads "${WEB_BLOCKING_THREADS}" \
                 --backlog "${WEB_BACKLOG}" \
                 app:app
        fi
    else
        echo "==> [Granian] 启动一体式 WSGI HTTPS 服务 (UID=$(id -u)->appuser)，监听: https://[${WEB_HOST}]:${WEB_PORT}，Workers=${WEB_WORKERS}, BlockingThreads=${WEB_BLOCKING_THREADS}, Backlog=${WEB_BACKLOG}"
        if [ "$(id -u)" = "0" ]; then
            exec gosu appuser:appgroup granian --interface wsgi \
                 --host "${WEB_HOST}" --port "${WEB_PORT}" \
                 --workers "${WEB_WORKERS}" \
                 --runtime-threads "${WEB_RUNTIME_THREADS}" \
                 --blocking-threads "${WEB_BLOCKING_THREADS}" \
                 --backlog "${WEB_BACKLOG}" \
                 --ssl-certificate /app/certs/fullchain.pem \
                 --ssl-keyfile /app/certs/privkey.pem \
                 app:app
        else
            exec granian --interface wsgi \
                 --host "${WEB_HOST}" --port "${WEB_PORT}" \
                 --workers "${WEB_WORKERS}" \
                 --runtime-threads "${WEB_RUNTIME_THREADS}" \
                 --blocking-threads "${WEB_BLOCKING_THREADS}" \
                 --backlog "${WEB_BACKLOG}" \
                 --ssl-certificate /app/certs/fullchain.pem \
                 --ssl-keyfile /app/certs/privkey.pem \
                 app:app
        fi
    fi
fi

# 执行容器自定义命令 (以 appuser 运行)
if [ "$(id -u)" = "0" ]; then
    exec gosu appuser:appgroup "$@"
fi
exec "$@"
