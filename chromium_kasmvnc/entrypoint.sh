#!/bin/bash
set -e

RESOLUTION="${RESOLUTION:-1920x1080}"
DEPTH="${DEPTH:-24}"
VNC_USER="${VNC_USER:-admin}"
VNC_PASSWORD="${VNC_PASSWORD:-admin123}"
HOMEPAGE="${HOMEPAGE:-about:blank}"
CHROME_ARGS="${CHROME_ARGS:-}"

# 1. 配置 KasmVNC 访问密码
mkdir -p /home/appuser/.vnc
echo -e "${VNC_PASSWORD}\n${VNC_PASSWORD}" | vncpasswd -u "${VNC_USER}" -w -r

# 2. 准备自签名证书（如用户未挂载，自动生成）
SSL_CERT="/home/appuser/.vnc/self.pem"
if [ ! -f "$SSL_CERT" ]; then
    openssl req -new -x509 -days 3650 -nodes \
        -out "$SSL_CERT" -keyout "$SSL_CERT" \
        -subj "/CN=localhost" 2>/dev/null
fi

# 3. 准备 KasmVNC 最小化配置文件
cat <<EOF > /home/appuser/.vnc/kasmvnc.yaml
network:
  ssl:
    require_ssl: true
    pem_certificate: ${SSL_CERT}
    pem_key: ${SSL_CERT}
  websocket_port: 8444
desktop:
  allow_resize: true
EOF

# 4. 启动 KasmVNC 服务（作为后台 X-Server 运行在 :1）
vncserver :1 -geometry "${RESOLUTION}" -depth "${DEPTH}"

export DISPLAY=:1

# 等待 X 服务就绪
until [ -e /tmp/.X11-unix/X1 ]; do
    sleep 0.1
done

# 5. 启动极简窗口管理器 Openbox
openbox &

# 6. 启动 CDP 9222 -> 9223 转发（隔离网络，解决 127.0.0.1 访问问题）
socat TCP-LISTEN:9222,fork,reuseaddr TCP:127.0.0.1:9223 &

# 7. 处理首页参数逻辑
CHROME_RES=$(echo "$RESOLUTION" | tr 'x' ',')
if [ $# -eq 0 ]; then
    set -- "$HOMEPAGE"
fi

# 8. 循环守护启动 Chromium（关闭后 1 秒自愈，防止黑屏）
echo "Starting Chromium under KasmVNC with args: $CHROME_ARGS $@"
while true; do
    rm -f /data/SingletonLock /data/SingletonCookie /data/SingletonSocket

    chromium \
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

    echo "Chromium 窗口已关闭，1 秒后自动拉起..."
    sleep 1
done
