#!/usr/bin/env bash
set -e

# ==============================================================================
# 0. 环境与分辨率初始化
# ==============================================================================
RESOLUTION=${RESOLUTION:-1920x1080}
WIDTH=$(echo "$RESOLUTION" | cut -d'x' -f1)
HEIGHT=$(echo "$RESOLUTION" | cut -d'x' -f2)
CHROME_RES="${WIDTH},${HEIGHT}"

# ==============================================================================
# 1. 证书检测逻辑 (优先 /certs 的 fullchain + privkey，检测到才使用，否则自签)
# ==============================================================================
CERTS_DIR="/certs"
SSL_OUT_DIR="/etc/ssl/app"
mkdir -p "$SSL_OUT_DIR"

CERT_FILE=""
KEY_FILE=""

# 检测挂载目录中的 fullchain 文件
for f in "$CERTS_DIR"/fullchain*.pem "$CERTS_DIR"/fullchain*.crt "$CERTS_DIR"/fullchain "$CERTS_DIR"/cert*.pem; do
    if [ -f "$f" ]; then
        CERT_FILE="$f"
        break
    fi
done

# 检测挂载目录中的 privkey 文件
for k in "$CERTS_DIR"/privkey*.pem "$CERTS_DIR"/privkey*.key "$CERTS_DIR"/privkey "$CERTS_DIR"/key*.pem; do
    if [ -f "$k" ]; then
        KEY_FILE="$k"
        break
    fi
done

if [ -n "$CERT_FILE" ] && [ -n "$KEY_FILE" ]; then
    echo "[SSL] 检测到外部映射证书，优先启用自有证书:"
    echo "       -> Cert (fullchain): $CERT_FILE"
    echo "       -> Key  (privkey)  : $KEY_FILE"
    cp "$CERT_FILE" "$SSL_OUT_DIR/server.crt"
    cp "$KEY_FILE" "$SSL_OUT_DIR/server.key"
else
    echo "[SSL] 未检测到有效的映射证书 (需同时具备 fullchain 与 privkey)，回退使用自签证书..."
    if [ ! -f "$SSL_OUT_DIR/server.crt" ] || [ ! -f "$SSL_OUT_DIR/server.key" ]; then
        openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
            -keyout "$SSL_OUT_DIR/server.key" \
            -out "$SSL_OUT_DIR/server.crt" \
            -subj "/C=US/ST=State/L=City/O=Chromium/CN=localhost" 2>/dev/null
    fi
fi

FINAL_CERT="$SSL_OUT_DIR/server.crt"
FINAL_KEY="$SSL_OUT_DIR/server.key"
chmod 600 "$FINAL_KEY"

# ==============================================================================
# 2. 启动 TigerVNC Standalone Server (Xvnc)
#    原生 UTF-8 剪贴板协议支持，杜绝粘贴乱码
# ==============================================================================
rm -f /tmp/.X0-lock /tmp/.X11-unix/X0 2>/dev/null

VNC_AUTH_ARGS=("-SecurityTypes" "None")
if [ -n "$VNC_PASSWORD" ]; then
    mkdir -p /root/.vnc
    echo "$VNC_PASSWORD" | vncpasswd -f > /root/.vnc/passwd
    chmod 600 /root/.vnc/passwd
    VNC_AUTH_ARGS=("-SecurityTypes" "VncAuth" "-PasswordFile" "/root/.vnc/passwd")
fi

echo "[TigerVNC] 正在拉起 Xvnc 服务 (:0)..."
Xvnc :0 \
    -geometry "$RESOLUTION" \
    -depth 24 \
    -rfbport 5900 \
    "${VNC_AUTH_ARGS[@]}" \
    -pn \
    -ac \
    -FrameRate 30 \
    -AcceptCutText=1 \
    -SendCutText=1 \
    &

export DISPLAY=:0

# 等待 X11 Display 就绪
for i in {1..30}; do
    if xset q >/dev/null 2>&1; then
        break
    fi
    sleep 0.2
done

# ==============================================================================
# 3. 强制开启 Num Lock (小键盘数字键保持 ON)
# ==============================================================================
if command -v numlockx >/dev/null 2>&1; then
    DISPLAY=:0 numlockx on || true
    echo "[Keyboard] Num Lock 已成功开启 (Num Lock ON)"
fi

# 启动窗口管理器
openbox &

# ==============================================================================
# 4. WebUI 服务与 CDP 端口穿透转发
# ==============================================================================
# 4.1 noVNC HTTP 端 (6080)
websockify --web=/usr/share/novnc 6080 localhost:5900 &

# 4.2 noVNC HTTPS 端 (6443) -> 载入自有/自签证书
websockify --web=/usr/share/novnc --cert="$FINAL_CERT" --key="$FINAL_KEY" 6443 localhost:5900 &

# 4.3 CDP 端口穿透转发: 将 0.0.0.0:9222 流量转至 Chromium 本地 127.0.0.1:9223
socat TCP-LISTEN:9222,fork,reuseaddr TCP:127.0.0.1:9223 &

echo "[Ready] noVNC HTTP 运行于 :6080, HTTPS 运行于 :6443, CDP 穿透运行于 :9222"

# ==============================================================================
# 5. 原版 Chromium 看门狗自愈守护进程 (支持 CMD [] 外部附加参数 "$@")
# ==============================================================================
while true; do
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