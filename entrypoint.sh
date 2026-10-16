
#!/bin/sh
set -e

RESOLUTION="${RESOLUTION:-1280x800}"
DEPTH="${DEPTH:-24}"
HOMEPAGE="${HOMEPAGE:-about:blank}"
CHROME_ARGS="${CHROME_ARGS:-}"

# 1. 清理可能残留的 X11 锁文件
rm -rf /tmp/.X0-lock /tmp/.X11-unix/X0

# 2. 启动 Xvfb 虚拟屏幕
Xvfb :0 -screen 0 "${RESOLUTION}x${DEPTH}" -ac +extension GLX +render -noreset &
export DISPLAY=:0

until [ -e /tmp/.X11-unix/X0 ]; do
    sleep 0.1
done

# 3. 启动 Openbox 窗口管理器
openbox &

# 4. 启动 x11vnc (支持动态密码认证)
if [ -n "$VNC_PASSWORD" ]; then
    echo "Enabling VNC password authentication..."
    x11vnc -display :0 -rfbport 5900 -passwd "$VNC_PASSWORD" -forever -shared -listen 127.0.0.1 &
else
    echo "WARNING: Running without VNC password!"
    x11vnc -display :0 -rfbport 5900 -nopw -forever -shared -listen 127.0.0.1 &
fi

# 5.1 启动 HTTP Web 访问 (端口 6080)
websockify --web=/usr/share/novnc 6080 127.0.0.1:5900 &

# 5.2 准备 SSL 证书 (若持久化目录不存在，自动生成 10 年自签名证书)
SSL_CERT="${SSL_CERT:-/data/novnc.pem}"
if [ ! -f "$SSL_CERT" ]; then
    echo "Generating self-signed SSL certificate for HTTPS..."
    openssl req -new -x509 -days 3650 -nodes \
        -out "$SSL_CERT" -keyout "$SSL_CERT" \
        -subj "/CN=localhost" 2>/dev/null
fi

# 5.3 启动 HTTPS Web 访问 (端口 6443)
websockify --cert="$SSL_CERT" --web=/usr/share/novnc 6443 127.0.0.1:5900 &

# 6. 启动 socat 端口转发 (解决 Chromium 绑定 127.0.0.1 问题)
socat TCP-LISTEN:9222,fork,reuseaddr TCP:127.0.0.1:9223 &

CHROME_RES=$(echo "$RESOLUTION" | tr 'x' ',')

# 命令行未传参时，默认打开 HOMEPAGE
if [ $# -eq 0 ]; then
    set -- "$HOMEPAGE"
fi

# 7. 循环守护启动 Chromium（防止误关窗口黑屏）
echo "Starting Chromium daemon loop with args: $CHROME_ARGS $@"
while true; do
    rm -f /data/SingletonLock /data/SingletonCookie /data/SingletonSocket

    chromium-browser \
        --no-sandbox \
        --test-type \
        --disable-infobars \
        --disable-dev-shm-usage \
        --disable-gpu \
        --remote-debugging-port=9223 \
        --remote-allow-origins=* \
        --window-size="${CHROME_RES}" \
        --window-position=0,0 \
        --start-maximized \
        --user-data-dir=/data \
        --no-first-run \
        --no-default-browser-check \
        $CHROME_ARGS \
        "$@" || true

    echo "Chromium 窗口已关闭，1 秒后自动重新拉起..."
    sleep 1
done
