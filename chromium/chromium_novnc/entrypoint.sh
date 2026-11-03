#!/bin/bash
set -e

# ========================================================
# 阶段 1：Root 权限自愈、证书合成与降权 (保持原样)
# ========================================================
if [ "$(id -u)" = "0" ]; then
    chown -R appuser:appuser /data /home/appuser /tmp/.X11-unix 2>/dev/null || true
    rm -rf /tmp/.X0-lock /tmp/.X11-unix/X0 /data/SingletonLock /data/SingletonCookie /data/SingletonSocket
    mkdir -p /home/appuser/.vnc

    CUSTOM_CERT=""
    CUSTOM_KEY=""
    for f in "$SSL_CERT_FILE" /certs/fullchain.pem /certs/cert.pem /certs/tls.crt /certs/*.crt /certs/*.pem; do
        if [ -f "$f" ] && [ "$f" != "/certs/privkey.pem" ] && [ "$f" != "/certs/key.pem" ]; then
            CUSTOM_CERT="$f"; break
        fi
    done
    for f in "$SSL_KEY_FILE" /certs/privkey.pem /certs/key.pem /certs/tls.key /certs/*.key; do
        if [ -f "$f" ]; then CUSTOM_KEY="$f"; break; fi
    done

    if [ -n "$CUSTOM_CERT" ] && [ -n "$CUSTOM_KEY" ]; then
        echo "[SSL] 成功检测到外部证书，组合装载..."
        cat "$CUSTOM_CERT" "$CUSTOM_KEY" > /tmp/novnc_combined.pem
        chown appuser:appuser /tmp/novnc_combined.pem
        chmod 600 /tmp/novnc_combined.pem
    fi

    export HOME=/home/appuser
    export USER=appuser
    export LOGNAME=appuser
    exec gosu appuser "$0" "$@"
fi

# ========================================================
# 阶段 2：以普通用户 appuser 启动服务 (使用 TigerVNC Xvnc)
# ========================================================
export HOME=/home/appuser
export USER=appuser
export LOGNAME=appuser
export XDG_CONFIG_HOME=/home/appuser/.config
export XDG_CACHE_HOME=/home/appuser/.cache
export NO_AT_BRIDGE=1

mkdir -p /home/appuser/.vnc /home/appuser/.config /home/appuser/.cache /tmp/crashpad

RESOLUTION="${RESOLUTION:-1920x1080}"
DEPTH="${DEPTH:-24}"
HOMEPAGE="${HOMEPAGE:-about:blank}"
CHROME_ARGS="${CHROME_ARGS:-}"

# 1. 配置 VNC 密码安全参数
mkdir -p /home/appuser/.vnc
if [ -n "$VNC_PASSWORD" ]; then
    echo "$VNC_PASSWORD" | vncpasswd -f > /home/appuser/.vnc/passwd
    chmod 600 /home/appuser/.vnc/passwd
    SECURITY_ARGS="-SecurityTypes VncAuth -PasswordFile /home/appuser/.vnc/passwd"
else
    SECURITY_ARGS="-SecurityTypes None"
fi

# 2. 【核心替换】：启动原生支持 UTF-8 剪贴板的 Xvnc (集成了虚拟显卡与 VNC)
Xvnc :0 -geometry "${RESOLUTION}" -depth "${DEPTH}" -rfbport 5900 $SECURITY_ARGS -pn &
export DISPLAY=:0

until [ -e /tmp/.X11-unix/X0 ]; do
    sleep 0.1
done

# 3. 启动 Openbox 并激活小键盘数字状态
openbox &
numlockx on || true

# 4.1 启动 HTTP 纯 Web 访问 (端口 6080)
websockify --web=/usr/share/novnc 6080 127.0.0.1:5900 &

# 4.2 证书与 HTTPS 启动 (端口 6443)
if [ -f /tmp/novnc_combined.pem ]; then
    FINAL_SSL_CERT="/tmp/novnc_combined.pem"
else
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
websockify --cert="$FINAL_SSL_CERT" --web=/usr/share/novnc 6443 127.0.0.1:5900 &

# 5. 启动 CDP 9222 -> 9223 端口穿透
socat TCP-LISTEN:9222,fork,reuseaddr TCP:127.0.0.1:9223 &

CHROME_RES=$(echo "$RESOLUTION" | tr 'x' ',')
if [ $# -eq 0 ]; then
    set -- "$HOMEPAGE"
fi

# 6. 循环守护启动 Chromium
echo "Starting Chromium under TigerVNC with args: $CHROME_ARGS $@"
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