#!/bin/bash
set -e

# ==========================================
# 阶段 1：Root 权限自愈与降权 (由 gosu 处理)
# ==========================================
if [ "$(id -u)" = "0" ]; then
    # 自动将宿主机挂载的 /data 目录过户给 appuser，清理锁文件
    chown -R appuser:appuser /data /home/appuser /tmp/.X11-unix 2>/dev/null || true
    rm -rf /tmp/.X0-lock /tmp/.X11-unix/X0 /data/SingletonLock /data/SingletonCookie /data/SingletonSocket
    
    # 降权为 appuser (UID 1000) 执行本脚本
    exec gosu appuser "$0" "$@"
fi

# ==========================================
# 阶段 2：以普通用户 appuser 正式启动服务
# ==========================================
RESOLUTION="${RESOLUTION:-1280x800}"
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

# 3. 启动 x11vnc (支持密码认证)
if [ -n "$VNC_PASSWORD" ]; then
    echo "Enabling VNC password authentication..."
    x11vnc -display :0 -rfbport 5900 -passwd "$VNC_PASSWORD" -forever -shared -listen 127.0.0.1 &
else
    echo "WARNING: Running without VNC password!"
    x11vnc -display :0 -rfbport 5900 -nopw -forever -shared -listen 127.0.0.1 &
fi

# 4.1 启动 HTTP Web 访问 (端口 6080)
websockify --web=/usr/share/novnc 6080 127.0.0.1:5900 &

# 4.2 准备带 SAN 扩展的标准证书，启动 HTTPS (端口 6443)
SSL_CERT="${SSL_CERT:-/data/novnc.pem}"
if [ ! -f "$SSL_CERT" ]; then
    echo "Generating standard SAN self-signed certificate for HTTPS..."
    openssl req -new -x509 -days 3650 -nodes \
        -out "$SSL_CERT" -keyout "$SSL_CERT" \
        -subj "/CN=noVNC" \
        -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:0.0.0.0" 2>/dev/null || \
    openssl req -new -x509 -days 3650 -nodes \
        -out "$SSL_CERT" -keyout "$SSL_CERT" \
        -subj "/CN=localhost" 2>/dev/null
fi
websockify --cert="$SSL_CERT" --web=/usr/share/novnc 6443 127.0.0.1:5900 &

# 5. 启动 CDP 9222 -> 9223 端口穿透
socat TCP-LISTEN:9222,fork,reuseaddr TCP:127.0.0.1:9223 &

CHROME_RES=$(echo "$RESOLUTION" | tr 'x' ',')

# 命令行未传参时，默认打开 HOMEPAGE
if [ $# -eq 0 ]; then
    set -- "$HOMEPAGE"
fi

# 6. 循环守护启动 Chromium (Debian glibc 版，天生兼容标准 Seccomp)
echo "Starting Chromium under noVNC with args: $CHROME_ARGS $@"
while true; do
    rm -f /data/SingletonLock /data/SingletonCookie /data/SingletonSocket

    chromium \
        --no-sandbox \
        --test-type \
        --disable-infobars \
        --disable-dev-shm-usage \
        --disable-gpu \
        --ignore-certificate-errors \
        --allow-running-insecure-content \
        --disable-sync \
        --disable-background-networking \
        --disable-default-apps \
        --disable-extensions \
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
