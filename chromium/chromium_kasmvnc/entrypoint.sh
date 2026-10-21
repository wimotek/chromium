#!/bin/bash
set -e

# ========================================================
# 阶段 1：Root 权限自愈、证书合成与降权 (由 gosu 调度)
# ========================================================
if [ "$(id -u)" = "0" ]; then
    # 1. 自动修复挂载目录所有权，清理可能残留的 X11 锁文件与浏览器单例锁
    chown -R appuser:appuser /data /home/appuser /tmp/.X11-unix 2>/dev/null || true
    rm -rf /tmp/.X1-lock /tmp/.X11-unix/X1 /home/appuser/.vnc/*.pid /home/appuser/.vnc/*.log
    rm -rf /data/SingletonLock /data/SingletonCookie /data/SingletonSocket

    # 2. 【核心修复】：以 Root 身份扫描并合成证书（彻底解决宝塔 600 root:root 权限问题）
    mkdir -p /home/appuser/.vnc
    CUSTOM_CERT=""
    CUSTOM_KEY=""

    for f in "$SSL_CERT_FILE" /certs/fullchain.pem /certs/cert.pem /certs/tls.crt /certs/*.crt /certs/*.pem; do
        if [ -f "$f" ] && [ "$f" != "/certs/privkey.pem" ] && [ "$f" != "/certs/key.pem" ]; then
            CUSTOM_CERT="$f"
            break
        fi
    done

    for f in "$SSL_KEY_FILE" /certs/privkey.pem /certs/key.pem /certs/tls.key /certs/*.key; do
        if [ -f "$f" ]; then
            CUSTOM_KEY="$f"
            break
        fi
    done

    if [ -n "$CUSTOM_CERT" ] && [ -n "$CUSTOM_KEY" ]; then
        echo "[SSL] (Root阶段) 成功检测到外部证书: $CUSTOM_CERT 与私钥: $CUSTOM_KEY"
        cat "$CUSTOM_CERT" "$CUSTOM_KEY" > /home/appuser/.vnc/self.pem
        chown appuser:appuser /home/appuser/.vnc/self.pem
        chmod 600 /home/appuser/.vnc/self.pem
        echo "[SSL] (Root阶段) 证书已成功合成至 /home/appuser/.vnc/self.pem"
    else
        echo "[SSL] (Root阶段) 未检测到外部有效证书，将使用自签证书"
    fi

    # 3. 重设环境变量并降权
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
export NO_AT_BRIDGE=1

mkdir -p /home/appuser/.vnc /home/appuser/.config /home/appuser/.cache /tmp/crashpad
touch /home/appuser/.Xauthority

RESOLUTION="${RESOLUTION:-1920x1080}"
DEPTH="${DEPTH:-24}"
VNC_USER="${VNC_USER:-admin}"
VNC_PASSWORD="${VNC_PASSWORD:-admin123}"
HOMEPAGE="${HOMEPAGE:-about:blank}"
CHROME_ARGS="${CHROME_ARGS:-}"

# 1. 配置 KasmVNC 访问密码
echo -e "${VNC_PASSWORD}\n${VNC_PASSWORD}" | vncpasswd -u "${VNC_USER}" -w -r

# 2. 准备 xstartup 脚本 (使用 Openbox 窗口管理器)
cat << 'EOF' > /home/appuser/.vnc/xstartup
#!/bin/sh
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
openbox &
EOF
chmod +x /home/appuser/.vnc/xstartup

# 3. 证书处理：若 Root 阶段未合成自定义证书，自动生成 10 年 SAN 自签证书
SSL_CERT="/home/appuser/.vnc/self.pem"
if [ -f "$SSL_CERT" ]; then
    echo "[SSL] 正在加载证书: $SSL_CERT"
else
    echo "[SSL] 回退生成标准 SAN 自签名证书..."
    openssl req -new -x509 -days 3650 -nodes \
        -out "$SSL_CERT" -keyout "$SSL_CERT" \
        -subj "/CN=KasmVNC" \
        -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:0.0.0.0" 2>/dev/null || \
    openssl req -new -x509 -days 3650 -nodes \
        -out "$SSL_CERT" -keyout "$SSL_CERT" \
        -subj "/CN=localhost" 2>/dev/null
    chmod 600 "$SSL_CERT"
fi

# 4. 生成 KasmVNC 配置文件 (侧边栏设为图标折叠模式，启用 WebP 流媒体高帧率压缩)
cat <<EOF > /home/appuser/.vnc/kasmvnc.yaml
network:
  ssl:
    require_ssl: true
    pem_certificate: ${SSL_CERT}
    pem_key: ${SSL_CERT}
  websocket_port: 8444
desktop:
  allow_resize: true
client:
  control_bar:
    visible: true
    auto_hide: true
  video:
    preferred_encoding: webp
EOF

# 5. 启动 KasmVNC 服务（运行于 X 显示口 :1）
vncserver :1 -select-de manual -geometry "${RESOLUTION}" -depth "${DEPTH}"
export DISPLAY=:1

until [ -e /tmp/.X11-unix/X1 ]; do
    sleep 0.1
done

# 6. 启动 CDP 9222 -> 9223 端口穿透
socat TCP-LISTEN:9222,fork,reuseaddr TCP:127.0.0.1:9223 &

CHROME_RES=$(echo "$RESOLUTION" | tr 'x' ',')

if [ $# -eq 0 ]; then
    set -- "$HOMEPAGE"
fi

# 7. 循环守护启动 Chromium (全方位速度调优与抗崩溃版)
echo "Starting Chromium under KasmVNC with args: $CHROME_ARGS $@"
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
