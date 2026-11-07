#!/usr/bin/env bash
set -e

# ==============================================================================
# 阶段 1：Root 权限自愈与宝塔证书安全合成 (绝对不触碰宿主机 /certs 权限)
# ==============================================================================
if [ "$(id -u)" = "0" ]; then
    echo "[Init] (Root阶段) 正在执行权限自愈与宝塔证书挂载扫描..."
    mkdir -p /tmp/.X11-unix /data /etc/ssl/app /tmp/crashpad /home/appuser/.vnc
    chmod 1777 /tmp /tmp/.X11-unix /tmp/crashpad

    rm -rf /tmp/.X0-lock /tmp/.X11-unix/X0 /data/SingletonLock /data/SingletonCookie /data/SingletonSocket

    # 1. 扫描宿主机挂载的证书 (支持宝塔、Certbot 等各种命名规则)
    CERTS_DIR="/certs"
    SSL_OUT_DIR="/etc/ssl/app"
    CERT_FILE=""
    KEY_FILE=""

    # 扫描外部公钥证书
    for f in "$SSL_CERT_FILE" "$CERTS_DIR"/fullchain*.pem "$CERTS_DIR"/fullchain*.crt "$CERTS_DIR"/fullchain "$CERTS_DIR"/cert*.pem "$CERTS_DIR"/tls.crt "$CERTS_DIR"/*.crt "$CERTS_DIR"/*.pem; do
        if [ -f "$f" ] && [ "$f" != "$CERTS_DIR/privkey.pem" ] && [ "$f" != "$CERTS_DIR/key.pem" ]; then
            CERT_FILE="$f"
            break
        fi
    done

    # 扫描外部私钥 (宝塔 600 权限由 Root 安全读取，绝不破坏宿主机属组)
    for k in "$SSL_KEY_FILE" "$CERTS_DIR"/privkey*.pem "$CERTS_DIR"/privkey*.key "$CERTS_DIR"/privkey "$CERTS_DIR"/key*.pem "$CERTS_DIR"/tls.key "$CERTS_DIR"/*.key; do
        if [ -f "$k" ]; then
            KEY_FILE="$k"
            break
        fi
    done

    if [ -n "$CERT_FILE" ] && [ -n "$KEY_FILE" ]; then
        echo "[SSL] (Root阶段) 成功检测到外部宝塔/域名证书与私钥:"
        echo "       -> 公钥 (Cert): $CERT_FILE"
        echo "       -> 私钥 (Key) : $KEY_FILE"
        # websockify 要求单文件 PEM (包含公钥 + 私钥)
        cat "$CERT_FILE" "$KEY_FILE" > "$SSL_OUT_DIR/novnc.pem"
    else
        echo "[SSL] (Root阶段) 未检测到有效证书，自动生成 10 年自签 SAN 证书..."
        if [ ! -f "$SSL_OUT_DIR/novnc.pem" ]; then
            openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
                -keyout "$SSL_OUT_DIR/novnc.key" \
                -out "$SSL_OUT_DIR/novnc.crt" \
                -subj "/CN=novnc" \
                -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:0.0.0.0" 2>/dev/null || \
            openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
                -keyout "$SSL_OUT_DIR/novnc.key" \
                -out "$SSL_OUT_DIR/novnc.crt" \
                -subj "/CN=novnc" 2>/dev/null
            cat "$SSL_OUT_DIR/novnc.crt" "$SSL_OUT_DIR/novnc.key" > "$SSL_OUT_DIR/novnc.pem"
            rm -f "$SSL_OUT_DIR/novnc.crt" "$SSL_OUT_DIR/novnc.key"
        fi
    fi

    # 核心安全准则：只对容器自有的 /data 和 /etc/ssl/app 过户，绝对不 chown 宿主机的 /certs
    chown -R appuser:appuser /data /home/appuser "$SSL_OUT_DIR" /opt/venv 2>/dev/null || true
    chmod 600 "$SSL_OUT_DIR/novnc.pem" 2>/dev/null || true

    export HOME=/home/appuser
    export USER=appuser
    export LOGNAME=appuser
    exec gosu appuser "$0" "$@"
fi

# ==============================================================================
# 阶段 2：以普通用户 appuser 启动服务
# ==============================================================================
export HOME=/home/appuser
export USER=appuser
export LOGNAME=appuser
export DISPLAY=:0
export NO_AT_BRIDGE=1
export PYTHONUNBUFFERED=1

RESOLUTION=${RESOLUTION:-1920x1080}
WIDTH=$(echo "$RESOLUTION" | cut -d'x' -f1)
HEIGHT=$(echo "$RESOLUTION" | cut -d'x' -f2)
CHROME_RES="${WIDTH},${HEIGHT}"
HOMEPAGE="${HOMEPAGE:-about:blank}"
CHROME_ARGS="${CHROME_ARGS:-}"

FINAL_PEM="/etc/ssl/app/novnc.pem"

# 1. 密码配置 (支持免密启动)
AUTH_FLAG="-SecurityTypes None"
if [ -n "$VNC_PASSWORD" ]; then
    mkdir -p "$HOME/.vnc"
    echo "$VNC_PASSWORD" | vncpasswd -f > "$HOME/.vnc/passwd"
    chmod 600 "$HOME/.vnc/passwd"
    AUTH_FLAG="-SecurityTypes VncAuth -PasswordFile $HOME/.vnc/passwd"
fi

# 2. 启动 TigerVNC Standalone Server
Xvnc :0 -geometry "$RESOLUTION" -depth 24 $AUTH_FLAG &

for i in {1..30}; do
    if [ -e /tmp/.X11-unix/X0 ]; then
        break
    fi
    sleep 0.1
done

# 3. 开启小键盘数字键
if command -v numlockx >/dev/null 2>&1; then
    DISPLAY=:0 numlockx on || true
fi

# 4. 启动窗口管理器 Openbox
openbox &

# 5. 【双端口启动】：同时启动 HTTP:6080 与 HTTPS:6443
# 5.1 启动 HTTP 端口 (6080)
/usr/share/novnc/utils/novnc_proxy --vnc 127.0.0.1:5900 --listen 6080 &

# 5.2 启动 HTTPS 端口 (6443, 挂载宝塔证书 / 自签证书)
if [ -f "$FINAL_PEM" ]; then
    /usr/share/novnc/utils/novnc_proxy --vnc 127.0.0.1:5900 --listen 6443 --cert "$FINAL_PEM" &
fi

# 6. 【本地调试备用通道】：socat 监听 9223 转发至原生 9222
socat TCP-LISTEN:9223,fork,reuseaddr TCP:127.0.0.1:9222 &

echo "[Ready] noVNC HTTP 运行于 :6080, HTTPS 运行于 :6443, CDP 调试端点 :9222"

# ==============================================================================
# 7. 启动 Wimotek Agent 守护进程 (带故障自动重生看门狗)
# ==============================================================================
if [ -n "$HUB_URL" ]; then
    echo "[Edge] 检测到 HUB_URL 配置 ($HUB_URL)，拉起 Agent 后台守护看门狗..."
    (
        while true; do
            echo "[Edge Watchdog] 正在拉起 edge_node_client 进程..."
            python3 -u /opt/edge_node_client.py || true
            echo "[Edge Watchdog] ⚠️ 警告: edge_node_client 异常退出，3 秒后自动重生拉起..."
            sleep 3
        done
    ) &
fi

# ==============================================================================
# 8. 循环守护启动 Chromium (原生使用 9222 调试端口)
# ==============================================================================
if [ $# -eq 0 ]; then
    set -- "$HOMEPAGE"
fi

echo "Starting Chromium under noVNC with native CDP 9222..."
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
        --remote-debugging-port=9222 \
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