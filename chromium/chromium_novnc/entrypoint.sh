#!/usr/bin/env bash
set -e

# ==============================================================================
# 阶段 1：Root 权限自愈、证书合成/授权与降权 (由 gosu 调度)
# ==============================================================================
if [ "$(id -u)" = "0" ]; then
    echo "[Init] (Root阶段) 正在执行权限自愈与锁清理..."

    # 1. 创建必要目录并设置 X11 运行环境权限
    mkdir -p /tmp/.X11-unix /home/appuser/.vnc /home/appuser/.config /home/appuser/.cache /tmp/crashpad /etc/ssl/app
    chmod 1777 /tmp /tmp/.X11-unix /tmp/crashpad

    # 【仅在此处增加 1 行软链接：彻底解决 noVNC 目录列表 Directory listing 问题】
    ln -sf /usr/share/novnc/vnc.html /usr/share/novnc/index.html 2>/dev/null || true

    # 2. 清理历史残留的锁文件
    rm -rf /tmp/.X0-lock /tmp/.X11-unix/X0 /data/SingletonLock /data/SingletonCookie /data/SingletonSocket

    # 3. 【核心修复】：以 Root 身份扫描证书与私钥（解决宝塔 600 root:root 外部挂载权限问题）
    CERTS_DIR="/certs"
    SSL_OUT_DIR="/etc/ssl/app"
    CERT_FILE=""
    KEY_FILE=""

    # 扫描证书公钥
    for f in "$SSL_CERT_FILE" "$CERTS_DIR"/fullchain*.pem "$CERTS_DIR"/fullchain*.crt "$CERTS_DIR"/fullchain "$CERTS_DIR"/cert*.pem "$CERTS_DIR"/tls.crt "$CERTS_DIR"/*.crt "$CERTS_DIR"/*.pem; do
        if [ -f "$f" ] && [ "$f" != "$CERTS_DIR/privkey.pem" ] && [ "$f" != "$CERTS_DIR/key.pem" ]; then
            CERT_FILE="$f"
            break
        fi
    done

    # 扫描私钥
    for k in "$SSL_KEY_FILE" "$CERTS_DIR"/privkey*.pem "$CERTS_DIR"/privkey*.key "$CERTS_DIR"/privkey "$CERTS_DIR"/key*.pem "$CERTS_DIR"/tls.key "$CERTS_DIR"/*.key; do
        if [ -f "$k" ]; then
            KEY_FILE="$k"
            break
        fi
    done

    if [ -n "$CERT_FILE" ] && [ -n "$KEY_FILE" ]; then
        echo "[SSL] (Root阶段) 检测到外部映射证书与私钥:"
        echo "       -> Cert: $CERT_FILE"
        echo "       -> Key : $KEY_FILE"
        cp "$CERT_FILE" "$SSL_OUT_DIR/server.crt"
        cp "$KEY_FILE" "$SSL_OUT_DIR/server.key"
        cat "$CERT_FILE" "$KEY_FILE" > /tmp/novnc_combined.pem
    else
        echo "[SSL] (Root阶段) 未检测到有效证书，生成标准 SAN 自签名证书..."
        if [ ! -f "$SSL_OUT_DIR/server.crt" ] || [ ! -f "$SSL_OUT_DIR/server.key" ]; then
            openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
                -keyout "$SSL_OUT_DIR/server.key" \
                -out "$SSL_OUT_DIR/server.crt" \
                -subj "/CN=localhost" \
                -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:0.0.0.0" 2>/dev/null || \
            openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
                -keyout "$SSL_OUT_DIR/server.key" \
                -out "$SSL_OUT_DIR/server.crt" \
                -subj "/CN=localhost" 2>/dev/null
            cat "$SSL_OUT_DIR/server.crt" "$SSL_OUT_DIR/server.key" > /tmp/novnc_combined.pem
        fi
    fi

    # 4. 彻底将证书及工作目录所有权过户给普通用户 appuser
    chown -R appuser:appuser /data /home/appuser "$SSL_OUT_DIR" /tmp/novnc_combined.pem 2>/dev/null || true
    chmod 600 "$SSL_OUT_DIR/server.key" /tmp/novnc_combined.pem 2>/dev/null || true

    # 5. 导出环境变量并降权切换为 appuser 重新执行此脚本
    export HOME=/home/appuser
    export USER=appuser
    export LOGNAME=appuser
    exec gosu appuser "$0" "$@"
fi

# ==============================================================================
# 阶段 2：以普通用户 appuser 正式启动所有桌面与后台服务
# ==============================================================================
export HOME=/home/appuser
export USER=appuser
export LOGNAME=appuser
export XDG_CONFIG_HOME=/home/appuser/.config
export XDG_CACHE_HOME=/home/appuser/.cache
export NO_AT_BRIDGE=1

RESOLUTION=${RESOLUTION:-1920x1080}
WIDTH=$(echo "$RESOLUTION" | cut -d'x' -f1)
HEIGHT=$(echo "$RESOLUTION" | cut -d'x' -f2)
CHROME_RES="${WIDTH},${HEIGHT}"
HOMEPAGE="${HOMEPAGE:-about:blank}"
CHROME_ARGS="${CHROME_ARGS:-}"

# 1. 配置 VNC 密码 (优先使用 vncpasswd，备用 tigervncpasswd)
VNC_AUTH_ARGS=("-SecurityTypes" "None")
if [ -n "$VNC_PASSWORD" ]; then
    mkdir -p "$HOME/.vnc"
    if command -v vncpasswd >/dev/null 2>&1; then
        echo "$VNC_PASSWORD" | vncpasswd -f > "$HOME/.vnc/passwd"
    elif command -v tigervncpasswd >/dev/null 2>&1; then
        echo "$VNC_PASSWORD" | tigervncpasswd -f > "$HOME/.vnc/passwd"
    fi
    chmod 600 "$HOME/.vnc/passwd"
    VNC_AUTH_ARGS=("-SecurityTypes" "VncAuth" "-PasswordFile" "$HOME/.vnc/passwd")
    echo "[TigerVNC] VNC 密码验证已启用"
fi

# 2. 启动 TigerVNC Standalone Server (原生 UTF-8 剪贴板协议杜绝乱码，帧率优化 30 FPS)
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

# 等待虚拟显示器 Display :0 就绪
for i in {1..30}; do
    if [ -e /tmp/.X11-unix/X0 ]; then
        break
    fi
    sleep 0.1
done

# 3. 强制开启 Num Lock (小键盘数字键保持 ON)
if command -v numlockx >/dev/null 2>&1; then
    DISPLAY=:0 numlockx on || true
    echo "[Keyboard] Num Lock 已成功开启 (Num Lock ON)"
fi

# 4. 启动轻量窗口管理器 Openbox
openbox &

# 双向桥接 CLIPBOARD 与 PRIMARY 选择区，保证剪贴板数据无缝同步给 Chromium
if command -v autocutsel >/dev/null 2>&1; then
    autocutsel -fork -selection CLIPBOARD
    autocutsel -fork -selection PRIMARY
fi


# 5. 启动 WebUI 访问端
# 5.1 noVNC HTTP 端 (端口 6080)
websockify --web=/usr/share/novnc 6080 127.0.0.1:5900 &

# 5.2 noVNC HTTPS 端 (端口 6443) -> 读取 Root 阶段授权好的证书
FINAL_CERT="/etc/ssl/app/server.crt"
FINAL_KEY="/etc/ssl/app/server.key"
websockify --web=/usr/share/novnc --cert="$FINAL_CERT" --key="$FINAL_KEY" 6443 127.0.0.1:5900 &

# 6. CDP 端口穿透转发 (将外部 9222 流量转发至 Chromium 内部 127.0.0.1:9223)
socat TCP-LISTEN:9222,fork,reuseaddr TCP:127.0.0.1:9223 &

echo "[Ready] noVNC HTTP 运行于 :6080, HTTPS 运行于 :6443, CDP 穿透转发至 :9222"

# 7. 循环守护启动 Chromium (支持 CMD [] 外部附加参数 "$@")
if [ $# -eq 0 ]; then
    set -- "$HOMEPAGE"
fi

echo "Starting Chromium under noVNC with args: $CHROME_ARGS $@"
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