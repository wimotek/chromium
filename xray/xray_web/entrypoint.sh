#!/bin/sh
set -e

# 确保持久化目录存在
mkdir -p /data

# 默认变量
export SERVER_PORT=${SERVER_PORT:-443}
export REALITY_SNI=${REALITY_SNI:-itunes.apple.com}
export REALITY_SHORT_ID=${REALITY_SHORT_ID:-123456}
export DEFAULT_UUID=${DEFAULT_UUID:-$(xray uuid 2>/dev/null || echo "11111111-2222-3333-4444-555555555555")}
export APP_MODE=${APP_MODE:-user}       # user (默认仅用户端) | admin (仅后台) | all (全开)
export ENABLE_WEB=${ENABLE_WEB:-true}   # 总开关

# 密钥处理与公钥持久化到 /data
if [ -z "$REALITY_PRIVATE_KEY" ]; then
    if [ -f "/data/private_key.txt" ] && [ -f "/data/public_key.txt" ]; then
        export REALITY_PRIVATE_KEY=$(cat /data/private_key.txt)
        export REALITY_PUBLIC_KEY=$(cat /data/public_key.txt)
    else
        echo "[Init] 正在生成 Reality 密钥对并持久化至 /data ..."
        KEYS=$(xray x25519)
        export REALITY_PRIVATE_KEY=$(echo "$KEYS" | awk '/Private key:/{print $3}')
        export REALITY_PUBLIC_KEY=$(echo "$KEYS" | awk '/Public key:/{print $3}')
        echo "$REALITY_PRIVATE_KEY" > /data/private_key.txt
        echo "$REALITY_PUBLIC_KEY" > /data/public_key.txt
    fi
else
    export REALITY_PUBLIC_KEY=$(echo "$REALITY_PRIVATE_KEY" | xray x25519 -i | awk '/Public key:/{print $3}')
    echo "$REALITY_PRIVATE_KEY" > /data/private_key.txt
    echo "$REALITY_PUBLIC_KEY" > /data/public_key.txt
fi

echo "[Init] REALITY Public Key 为: $REALITY_PUBLIC_KEY"

# 动态渲染配置文件
echo "[Init] 正在通过 config.template.json 渲染 /etc/xray/config.json ..."
python3 -c "
import os, string
with open('config.template.json', 'r', encoding='utf-8') as f:
    template = string.Template(f.read())
rendered = template.safe_substitute(os.environ)
os.makedirs('/etc/xray', exist_ok=True)
with open('/etc/xray/config.json', 'w', encoding='utf-8') as f:
    f.write(rendered)
"

# 启动流程控制
if [ "$APP_MODE" != "admin" ]; then
    echo "⚡ [Xray] 启动核心代理网络服务..."
    xray run -c /etc/xray/config.json &
    XRAY_PID=$!
fi

if [ "$ENABLE_WEB" = "true" ] || [ "$ENABLE_WEB" = "1" ]; then
    echo "🚀 [Web] 启动 Web 服务 (模式: $APP_MODE, 端口: ${PORT:-8080})..."
    cd /app/backend && python3 app.py &
    WEB_PID=$!
else
    echo "🛑 [Web] ENABLE_WEB=false，已禁用 Web 服务。"
fi

trap 'echo "正在停止容器..."; [ -n "$XRAY_PID" ] && kill $XRAY_PID 2>/dev/null; [ -n "$WEB_PID" ] && kill $WEB_PID 2>/dev/null; exit 0' SIGTERM SIGINT

if [ -n "$XRAY_PID" ]; then
    wait $XRAY_PID
elif [ -n "$WEB_PID" ]; then
    wait $WEB_PID
fi