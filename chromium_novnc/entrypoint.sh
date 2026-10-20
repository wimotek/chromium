#!/bin/bash
set -e

# ========================================================
# 阶段 1：Root 权限自愈与降权 (由 gosu 调度)
# ========================================================
if [ "$(id -u)" = "0" ]; then
    # 自动将外部挂载的 /data 卷所有权过户给 appuser，清理历史残留锁文件
    chown -R appuser:appuser /data /home/appuser /tmp/.X11-unix 2>/dev/null || true
    rm -rf /tmp/.X0-lock /tmp/.X11-unix/X0 /data/SingletonLock /data/SingletonCookie /data/SingletonSocket
    
    # 核心：重设 HOME 与用户环境变量，避免降权后残留 /root 引发权限报错
    export HOME=/home/appuser
    export USER=appuser
    export LOGNAME=appuser
    exec gosu appuser "$0" "$@"
fi

# ========================================================
# 阶段 2：以普通用户 appuser 正式启动所有服务
# ========================================================
export HOME=/home/appuser
export USER=appuser
export LOGNAME=appuser
export XDG_CONFIG_HOME=/home/appuser/.config
export XDG_CACHE_HOME=/home/appuser/.cache
# 禁用 Linux 无障碍总线等待，消除 D-Bus 超时阻塞
export NO_AT_BRIDGE=1

mkdir -p /home/appuser/.config /home/appuser/.cache /tmp/crashpad

RESOLUTION="${RESOLUTION:-1920x1080}"
DEPTH="${DEPTH:-24}"
HOMEPAGE="${HOMEPAGE:-about:blank}"
CHROME_ARGS="${CHROME_ARGS:-}"

# 1. 启动 Xvfb 虚拟屏幕
Xvfb :0 -screen 0 "${RESOLUTION}x${DEPTH}" -ac +extension GLX +render -noreset &
export DISPLAY=:0

until [ -e /tmp/.X11-unix/X0 ]; do
    sleep 0.1
done

# 2. 启动轻量窗口管理器 Openbox
openbox &

# 3. 启动 x11vnc 服务 (支持动态密码验证)
if [ -n "$VNC_PASSWORD" ]; then
    echo "[VNC] 已开启密码认证模式"
    x11vnc -display :0 -rfbport 5900 -passwd "$VNC_PASSWORD" -forever -shared -listen 127.0.0.1 &
else
    echo "[VNC] 警告：当前未设置 VNC_PASSWORD，运行在免密模式"
    x11vnc -display :0 -rfbport 5900 -nopw -forever -shared -listen 127.0.0.1 &
fi

# 4.1 启动 HTTP 纯 Web 访问 (端口 6080)
websockify --web=/usr/share/novnc 6080 127.0.0.1:5900 &

# 4.2 智能证书处理：优先检测自定义证书，无则回退至自签名
CUSTOM_CERT=""
CUSTOM_KEY=""

# 自动扫描挂载到 /certs 下的各种常见格式证书与私钥
for f in "$SSL_CERT_FILE" /certs/fullchain.pem /certs/cert.pem /certs/tls.crt /certs/*.crt; do
    if [ -f "$f" ]; then CUSTOM_CERT="$f"; break; fi
done

for f in "$SSL_KEY_FILE" /certs/privkey.pem /certs/key.pem /certs/tls.key /certs/*.key; do
    if [ -f "$f" ]; then CUSTOM_KEY="$f"; break; fi
done

if [ -n "$CUSTOM_CERT" ] && [ -n "$CUSTOM_KEY" ]; then
    echo "[SSL] 检测到外部自定义证书: $CUSTOM_CERT 与私钥: $CUSTOM_KEY，自动组合装载..."
    cat "$CUSTOM_CERT" "$CUSTOM_KEY" > /tmp/novnc_combined.pem
    FINAL_SSL_CERT="/tmp/novnc_combined.pem"
else
    echo "[SSL] 未检测到自定义证书，回退使用标准 SAN 自签名证书..."
    FINAL_SSL_CERT="${SSL_CERT:-/data/novnc.pem}"
    if [ ! -f "$FINAL_SSL_CERT" ]; then
        openssl req -new -x509 -days 3650 -nodes \
            -out "$FINAL_SSL_CERT" -keyout "$FINAL_SSL_CERT" \
            -subj "/CN=noVNC" \
            -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:0.0.0.0" 2>/dev/null || \
        openssl req -new -x509 -days 3650 -nodes \
            -out "$FINAL_SSL_CERT" -keyout "$FINAL_SSL_CERT" \
            -subj "/CN=localhost" 2>/dev/null
    fi
fi

# 4.3 启动 HTTPS Web 访问 (端口 6443)
websockify --cert="$FINAL_SSL_CERT" --web=/usr/share/novnc 6443 127.0.0.1:5900 &

# 5. 启动 CDP 9222 -> 9223 端口穿透
socat TCP-LISTEN:9222,fork,reuseaddr TCP:127.0.0.1:9223 &

CHROME_RES=$(echo "$RESOLUTION" | tr 'x' ',')

# 命令行未传网址参数时，默认打开 HOMEPAGE
if [ $# -eq 0 ]; then
    set -- "$HOMEPAGE"
fi

# 6. 循环守护启动 Chromium (全方位速度调优与防崩溃版)
echo "Starting Chromium under noVNC with args: $CHROME_ARGS $@"
while true; do
    rm -f /data/SingletonLock /data/SingletonCookie /data/SingletonSocket

    chromium \
        --no-sandbox \
        --test-type \
        --disable-infobars \
        --disable-gpu \
        --crash-dumps-dir=/tmp/crashpad \
        --password-store=basic \
        --num-raster-threads=4 \
        --enable-zero-copy \
        --ignore-certificate-errors \
        --allow-running-insecure-content \
        --disable-sync \
        --disable-background-networking \
        --disable-default-apps \
        --disable-extensions \
        --disable-component-extensions-with-background-pages \
        --no-first-run \
        --no-default-browser-check \
        --remote-debugging-port=9223 \
        --remote-allow-origins=* \
        --window-size="${CHROME_RES}" \
        --window-position=0,0 \
        --start-maximized \
        --user-data-dir=/data \
        $CHROME_ARGS \
        "$@" || true

    echo "Chromium 窗口已关闭，1 秒后自动拉起..."
    sleep 1
done
