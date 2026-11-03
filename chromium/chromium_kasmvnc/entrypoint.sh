#!/usr/bin/env bash
set -e

# ==============================================================================
# 0. 环境与分辨率初始化
# ==============================================================================
RESOLUTION=${RESOLUTION:-1920x1080}
WIDTH=$(echo "$RESOLUTION" | cut -d'x' -f1)
HEIGHT=$(echo "$RESOLUTION" | cut -d'x' -f2)
CHROME_RES="${WIDTH},${HEIGHT}"

VNC_USER="${VNC_USER:-admin}"
VNC_PASSWORD="${VNC_PASSWORD:-admin}"

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
chmod 644 "$FINAL_CERT"
chmod 600 "$FINAL_KEY"

# ==============================================================================
# 2. 用户与 KasmVNC 权限配置
# ==============================================================================
if ! id -u "$VNC_USER" >/dev/null 2>&1; then
    useradd -m -s /bin/bash "$VNC_USER"
    adduser "$VNC_USER" sudo 2>/dev/null || true
fi
echo "$VNC_USER:$VNC_PASSWORD" | chpasswd

# 设置 KasmVNC Web 认证密码
mkdir -p "/home/$VNC_USER/.vnc" "/etc/kasmvnc"
echo "$VNC_PASSWORD" | kasmvncpasswd -u "$VNC_USER" -wo

# 写入 KasmVNC 全局 SSL 与 WebSocket 配置
cat <<EOF > /etc/kasmvnc/kasmvnc.yaml
network:
  ssl:
    require_ssl: true
    pem_certificate: $FINAL_CERT
    pem_key: $FINAL_KEY
  websocket:
    port: 8444
EOF

# 配置桌面启动项 (集成 numlockx on 确保进入桌面时小键盘处于激活状态)
cat << 'EOF' > "/home/$VNC_USER/.vnc/xstartup"
#!/bin/sh
numlockx on &
exec openbox
EOF
chmod +x "/home/$VNC_USER/.vnc/xstartup"

chown -R "$VNC_USER:$VNC_USER" "/home/$VNC_USER" "$SSL_OUT_DIR" /data /tmp/crashpad 2>/dev/null || true

# ==============================================================================
# 3. 启动 KasmVNC Server 与 Num Lock 锁定
# ==============================================================================
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 2>/dev/null

echo "[KasmVNC] 正在拉起 KasmVNC 服务 (:1)..."
su - "$VNC_USER" -c "vncserver :1 \
    -geometry $RESOLUTION \
    -depth 24 \
    -websocketPort 8444 \
    -cert $FINAL_CERT \
    -key $FINAL_KEY" &

export DISPLAY=:1

# 等待显示服务就绪
for i in {1..30}; do
    if su - "$VNC_USER" -c "DISPLAY=:1 xset q" >/dev/null 2>&1; then
        break
    fi
    sleep 0.2
done

# 允许本地进程连接 X11 Display
su - "$VNC_USER" -c "DISPLAY=:1 xhost +local:" >/dev/null 2>&1 || true

# 开启 Num Lock (需求: 小键盘数字键保持 ON)
if command -v numlockx >/dev/null 2>&1; then
    DISPLAY=:1 numlockx on || true
    echo "[Keyboard] Num Lock 已成功开启 (Num Lock ON)"
fi

# ==============================================================================
# 4. CDP 端口穿透转发 (0.0.0.0:9222 -> 127.0.0.1:9223)
# ==============================================================================
socat TCP-LISTEN:9222,fork,reuseaddr TCP:127.0.0.1:9223 &

echo "[Ready] KasmVNC HTTPS 运行于 :8444, CDP 穿透运行于 :9222"

# ==============================================================================
# 5. 原版 Chromium 看门狗自愈守护进程 (支持 CMD 与附加参数 "$@")
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