#!/usr/bin/env bash
set -e

# ==============================================================================
# 阶段 1：Root 权限自愈与宝塔证书安全合成 (绝对不触碰宿主机 /certs 权限)
# ==============================================================================
if [ "$(id -u)" = "0" ]; then
    echo "[Init] (Root阶段) 正在执行 Kasm 权限自愈与宝塔证书扫描..."

    mkdir -p /tmp/.X11-unix /home/kasm-user/.vnc /home/kasm-user/.config /home/kasm-user/.cache /tmp/crashpad /etc/ssl/app /etc/kasmvnc
    chmod 1777 /tmp /tmp/.X11-unix /tmp/crashpad

    rm -rf /tmp/.X0-lock /tmp/.X11-unix/X0 /data/SingletonLock /data/SingletonCookie /data/SingletonSocket

    CERTS_DIR="/certs"
    SSL_OUT_DIR="/etc/ssl/app"
    CERT_FILE=""
    KEY_FILE=""

    # 扫描外部公钥证书 (支持宝塔、Certbot 等格式)
    for f in "$SSL_CERT_FILE" "$CERTS_DIR"/fullchain*.pem "$CERTS_DIR"/fullchain*.crt "$CERTS_DIR"/fullchain "$CERTS_DIR"/cert*.pem "$CERTS_DIR"/tls.crt "$CERTS_DIR"/*.crt "$CERTS_DIR"/*.pem; do
        if [ -f "$f" ] && [ "$f" != "$CERTS_DIR/privkey.pem" ] && [ "$f" != "$CERTS_DIR/key.pem" ]; then
            CERT_FILE="$f"
            break
        fi
    done

    # 扫描外部私钥 (由 Root 读取 600 权限，绝不修改宿主机权限)
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
        cp "$CERT_FILE" "$SSL_OUT_DIR/kasm.crt"
        cp "$KEY_FILE" "$SSL_OUT_DIR/kasm.key"
    else
        echo "[SSL] (Root阶段) 未检测到有效证书，自动生成 10 年 SAN 自签证书..."
        if [ ! -f "$SSL_OUT_DIR/kasm.crt" ] || [ ! -f "$SSL_OUT_DIR/kasm.key" ]; then
            openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
                -keyout "$SSL_OUT_DIR/kasm.key" \
                -out "$SSL_OUT_DIR/kasm.crt" \
                -subj "/CN=kasm-user" \
                -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:0.0.0.0" 2>/dev/null || \
            openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
                -keyout "$SSL_OUT_DIR/kasm.key" \
                -out "$SSL_OUT_DIR/kasm.crt" \
                -subj "/CN=kasm-user" 2>/dev/null
        fi
    fi

    # 核心隔离原则：只对容器自有的数据目录过户，绝对不碰宿主机 /certs
    chown -R kasm-user:kasm-user /data /home/kasm-user "$SSL_OUT_DIR" /etc/kasmvnc /opt/venv 2>/dev/null || true
    chmod 600 "$SSL_OUT_DIR/kasm.key" 2>/dev/null || true

    export HOME=/home/kasm-user
    export USER=kasm-user
    export LOGNAME=kasm-user
    exec gosu kasm-user "$0" "$@"
fi

# ==============================================================================
# 阶段 2：以普通用户 kasm-user 正式启动服务
# ==============================================================================
export HOME=/home/kasm-user
export USER=kasm-user
export LOGNAME=kasm-user
export XDG_CONFIG_HOME=/home/kasm-user/.config
export XDG_CACHE_HOME=/home/kasm-user/.cache
export NO_AT_BRIDGE=1
export PYTHONUNBUFFERED=1

RESOLUTION=${RESOLUTION:-1920x1080}
WIDTH=$(echo "$RESOLUTION" | cut -d'x' -f1)
HEIGHT=$(echo "$RESOLUTION" | cut -d'x' -f2)
CHROME_RES="${WIDTH},${HEIGHT}"
HOMEPAGE="${HOMEPAGE:-about:blank}"
CHROME_ARGS="${CHROME_ARGS:-}"

FINAL_CERT="/etc/ssl/app/kasm.crt"
FINAL_KEY="/etc/ssl/app/kasm.key"

# 1. 动态生成 KasmVNC 运行时 YAML 配置
mkdir -p "$HOME/.vnc"
cat <<EOF > "$HOME/.vnc/kasmvnc.yaml"
network:
  websocket_port: 6901
  ssl:
    require_ssl: true
    pem_certificate: "$FINAL_CERT"
    pem_key: "$FINAL_KEY"
client:
  clipboard:
    allow_server_to_client: true
    allow_client_to_server: true
EOF

# 2. 密码配置 (支持免密启动)
AUTH_FLAG="-SecurityTypes None"
if [ -n "$VNC_PASSWORD" ]; then
    if command -v kasmvncpasswd >/dev/null 2>&1; then
        echo -e "${VNC_PASSWORD}\n${VNC_PASSWORD}" | kasmvncpasswd -u kasm-user
        AUTH_FLAG="-SecurityTypes VncAuth"
        echo "[KasmVNC] 密码认证已成功启用"
    fi
fi

# 3. 启动 KasmVNC Server (:0)
echo "[KasmVNC] 正在拉起 Xvnc 服务 (:0)..."
Xvnc :0 \
    -geometry "$RESOLUTION" \
    -depth 24 \
    $AUTH_FLAG \
    -websocketPort 6901 \
    -cert "$FINAL_CERT" \
    -key "$FINAL_KEY" \
    -AcceptCutText=1 \
    -SendCutText=1 \
    -FrameRate 30 \
    &

export DISPLAY=:0

for i in {1..30}; do
    if [ -e /tmp/.X11-unix/X0 ]; then
        break
    fi
    sleep 0.1
done

# 4. 强制开启 Num Lock (小键盘 ON)
if command -v numlockx >/dev/null 2>&1; then
    DISPLAY=:0 numlockx on || true
fi

# 5. 启动轻量窗口管理器 Openbox
openbox &

# 6. 【本地调试备用通道】：socat 监听 9223 转发至原生 9222
socat TCP-LISTEN:9223,fork,reuseaddr TCP:127.0.0.1:9222 &

echo "[Ready] KasmVNC Web 端运行于 :6901 (HTTPS), CDP 调试端点 :9222"

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

echo "Starting Chromium under Kasm with native CDP 9222..."
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