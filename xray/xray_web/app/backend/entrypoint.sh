#!/bin/sh
set -e

# 解析用户传入的 WEB_PORT 环境变量，未指定时默认使用 8443
export WEB_PORT="${WEB_PORT:-8443}"

# 确保运行时证书与备份目录存在
mkdir -p /app/certs /data/backups

# 核心：在 Granian 监听绑定 SSL 套接字之前预热初始化证书
# 1. 自动从只读 /certs:ro 读取外部证书并复制到 /app/certs
# 2. 修正权限为 0644 (公钥) 与 0600 (私钥)
# 3. 若无外部证书，自动生成带 127.0.0.1 IP SAN 的自签名证书兜底至 /app/certs
# 确保 Granian 启动读取 /app/certs 时 100% 存在且有效，绝不 Crash！
python3 -m core.cert_init

# 如果未传入命令，或者传入的是默认的 granian-default 占位符
# 动态绑定用户指定的 WEB_PORT (默认 8443)，解决 Dockerfile 无法动态展开变量的问题
if [ $# -eq 0 ] || [ "$1" = "granian-default" ]; then
    echo "==> [Granian] 启动 WSGI HTTPS 服务，监听端口: ${WEB_PORT}，Workers: 2"
    exec granian --interface wsgi \
         --host 0.0.0.0 --port "${WEB_PORT}" \
         --workers 2 \
         --runtime-threads 1 \
         --blocking-threads 8 \
         --ssl-certificate /app/certs/fullchain.pem \
         --ssl-keyfile /app/certs/privkey.pem \
         app:app
fi

# 执行容器自定义主进程命令 (以 appuser 运行)
exec "$@"
