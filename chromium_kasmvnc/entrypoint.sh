#!/bin/bash
set -e

RESOLUTION="${RESOLUTION:-1920x1080}"
DEPTH="${DEPTH:-24}"
VNC_USER="${VNC_USER:-admin}"
VNC_PASSWORD="${VNC_PASSWORD:-admin123}"
HOMEPAGE="${HOMEPAGE:-about:blank}"
CHROME_ARGS="${CHROME_ARGS:-}"

# 1. 清理可能残留的锁文件，并创建 .Xauthority 文件消除警告
rm -rf /tmp/.X1-lock /tmp/.X11-unix/X1 /home/appuser/.vnc/*.pid /home/appuser/.vnc/*.log
mkdir -p /home/appuser/.vnc
touch /home/appuser/.Xauthority

# 2. 配置 KasmVNC 访问密码
echo -e "${VNC_PASSWORD}\n${VNC_PASSWORD}" | vncpasswd -u "${VNC_USER}" -w -r

# 3. 【核心修复】自动生成 xstartup 脚本并赋予执行权限，避免触发交互选择
cat << 'EOF' > /home/appuser/.vnc/xstartup
#!/bin/sh
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
openbox &
EOF
chmod +x /home/appuser/.vnc/xstartup

# 4. 准备 SSL 证书 (若持久化目录不存在则自动签发)
SSL_CERT="/home/appuser/.vnc/self.pem"
if [ ! -f "$SSL_CERT" ]; then
    openssl req -new -x509 -days 3650 -nodes \
        -out "$SSL_CERT" -keyout "$SSL_CERT" \
        -subj "/CN=localhost" 2>/dev/null
fi

# 5. 生成 KasmVNC 配置文件
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

# 6. 【核心修复】添加 -select-de manual，强制使用准备好的 xstartup，跳过 select-de 脚本
vncserver :1 -select-de manual -geometry "${RESOLUTION}" -depth "${DEPTH}"
export DISPLAY=:1

# 等待 X 服务就绪
until [ -e /tmp/.X11-unix/X1 ]; do
    sleep 0.1
done

# 7. 启动 CDP 9222 -> 9223 转发
socat TCP-LISTEN:9222,fork,reuseaddr TCP:127.0.0.1:9223 &

# 8. 处理首页参数逻辑
CHROME_RES=$(echo "$RESOLUTION" | tr 'x' ',')
if [ $# -eq 0 ]; then
    set -- "$HOMEPAGE"
fi

# 9. 循环守护启动 Chromium
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
