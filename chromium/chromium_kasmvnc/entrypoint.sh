#!/usr/bin/env bash
set -e

# ==============================================================================
# 阶段 1：Root 权限初始化、/data 权限自愈与宝塔证书安全副本合成 (绝不修改宿主机 /certs)
# ==============================================================================
if [ "$(id -u)" = "0" ]; then
    echo "[Init] (Root阶段) 正在执行 Kasm 权限自愈与宝塔证书扫描，随后立即降权至 kasm-user..."
    mkdir -p /tmp/.X11-unix /data /home/kasm-user/.vnc /home/kasm-user/.config /home/kasm-user/.cache/openbox /home/kasm-user/.cache/fontconfig /tmp/crashpad /etc/ssl/app /etc/kasmvnc
    chmod 1777 /tmp /tmp/.X11-unix /tmp/crashpad

    rm -f /tmp/.X0-lock /tmp/.X11-unix/X0 /data/SingletonLock /data/SingletonCookie /data/SingletonSocket 2>/dev/null || true

    CERTS_DIR="/certs"
    SSL_OUT_DIR="/etc/ssl/app"
    CERT_FILE=""
    KEY_FILE=""

    for f in "$SSL_CERT_FILE" "$CERTS_DIR"/fullchain*.pem "$CERTS_DIR"/fullchain*.crt "$CERTS_DIR"/fullchain "$CERTS_DIR"/cert*.pem "$CERTS_DIR"/tls.crt "$CERTS_DIR"/*.crt "$CERTS_DIR"/*.pem; do
        if [ -n "$f" ] && [ -f "$f" ] && [ "$f" != "$CERTS_DIR/privkey.pem" ] && [ "$f" != "$CERTS_DIR/key.pem" ]; then
            CERT_FILE="$f"
            break
        fi
    done

    for k in "$SSL_KEY_FILE" "$CERTS_DIR"/privkey*.pem "$CERTS_DIR"/privkey*.key "$CERTS_DIR"/privkey "$CERTS_DIR"/key*.pem "$CERTS_DIR"/tls.key "$CERTS_DIR"/*.key; do
        if [ -n "$k" ] && [ -f "$k" ]; then
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
        echo "[SSL] (Root阶段) 未检测到有效证书，生成/复用 10 年 SAN 自签证书..."
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

    # 仅调整容器自有目录与证书副本属主，绝对不触碰宿主机 /certs
    if ! chown -R kasm-user:kasm-user /data /home/kasm-user "$SSL_OUT_DIR" /etc/kasmvnc; then
        echo "[WARN] (Root阶段) 部分目录 chown 失败（如 NFS root_squash、只读挂载或磁盘已满），将在降权后执行真实写入探测"
    fi
    chmod 600 "$SSL_OUT_DIR/kasm.key" 2>/dev/null || true

    export HOME=/home/kasm-user
    export USER=kasm-user
    export LOGNAME=kasm-user
    exec gosu kasm-user "$0" "$@"
fi

# ==============================================================================
# 阶段 2：以非 root 普通用户 kasm-user 运行所有业务进程
# ==============================================================================
UID_NOW="$(id -u)"
GID_NOW="$(id -g)"

export HOME=/home/kasm-user
export USER=kasm-user
export LOGNAME=kasm-user
export XDG_CONFIG_HOME=/home/kasm-user/.config
export XDG_CACHE_HOME=/home/kasm-user/.cache
export NO_AT_BRIDGE=1
export PYTHONUNBUFFERED=1

if [ ! -d "/data" ] || ! touch /data/.rw_probe 2>/tmp/.rw_err; then
    ERR_MSG="$(cat /tmp/.rw_err 2>/dev/null || true)"
    rm -f /tmp/.rw_err 2>/dev/null || true
    echo "[ERROR] /data 无法写入 (UID=${UID_NOW}, GID=${GID_NOW}): ${ERR_MSG}"
    echo "[ERROR] 若使用宿主机挂载，请确保挂载专属子目录（如 -v /home/docker/chromium_kasm:/data），检查宿主磁盘空间/inode (df -h / df -i) 与权限 (chown -R ${UID_NOW}:${GID_NOW} / SELinux :Z)"
    df -h /data /tmp /dev/shm 2>/dev/null || true
    exit 1
fi
rm -f /data/.rw_probe /tmp/.rw_err 2>/dev/null || true

if ! mkdir -p "$HOME/.vnc" "$HOME/.config/openbox" "$HOME/.config/tint2" "$HOME/.cache/openbox" "$HOME/.cache/fontconfig" /etc/ssl/app /tmp/crashpad; then
    echo "[WARN] 容器内部缓存目录创建异常，请检查宿主机 Docker 存储盘空间 (df -h / df -i / docker system df)："
    df -h "$HOME" /tmp /dev/shm 2>/dev/null || true
fi
[ -f "$HOME/.config/openbox/rc.xml" ] || cp /etc/xdg/openbox/rc.xml "$HOME/.config/openbox/rc.xml" 2>/dev/null || true
[ -f "$HOME/.config/openbox/menu.xml" ] || cp /etc/xdg/openbox/menu.xml "$HOME/.config/openbox/menu.xml" 2>/dev/null || true
[ -f "$HOME/.config/tint2/tint2rc" ] || cp /etc/xdg/tint2/tint2rc "$HOME/.config/tint2/tint2rc" 2>/dev/null || true
rm -f /tmp/.X0-lock /tmp/.X11-unix/X0 /data/SingletonLock /data/SingletonCookie /data/SingletonSocket 2>/dev/null || true

RESOLUTION=${RESOLUTION:-1920x1080}
WIDTH=$(echo "$RESOLUTION" | cut -d'x' -f1)
HEIGHT=$(echo "$RESOLUTION" | cut -d'x' -f2)
CHROME_RES="${WIDTH},${HEIGHT}"
HOMEPAGE="${HOMEPAGE:-about:blank}"
CHROME_ARGS="${CHROME_ARGS:-}"
VNC_USER="${VNC_USER:-kasm-user}"

FINAL_CERT="/etc/ssl/app/kasm.crt"
FINAL_KEY="/etc/ssl/app/kasm.key"

if [ ! -f "$FINAL_CERT" ] || [ ! -f "$FINAL_KEY" ]; then
    openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
        -keyout "$FINAL_KEY" \
        -out "$FINAL_CERT" \
        -subj "/CN=kasm-user" \
        -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:0.0.0.0" 2>/dev/null || \
    openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
        -keyout "$FINAL_KEY" \
        -out "$FINAL_CERT" \
        -subj "/CN=kasm-user" 2>/dev/null
    chmod 600 "$FINAL_KEY"
fi

cleanup() {
    echo "[Shutdown] 收到退出信号，正在优雅停止子进程..."
    pkill -P $$ 2>/dev/null || true
    exit 0
}
trap cleanup TERM INT

# 1. 动态生成 KasmVNC 运行时 YAML 配置 (使用 KasmVNC 1.3.3 标准 data_loss_prevention.clipboard 架构)
cat <<EOF > "$HOME/.vnc/kasmvnc.yaml"
network:
  websocket_port: 6901
  ssl:
    require_ssl: true
    pem_certificate: "$FINAL_CERT"
    pem_key: "$FINAL_KEY"
data_loss_prevention:
  clipboard:
    server_to_client:
      enabled: true
      size: unlimited
      primary_clipboard_enabled: false
    client_to_server:
      enabled: true
      size: unlimited
EOF

# 2. 密码配置 (支持免密启动)
AUTH_FLAG="-SecurityTypes None"
if [ -n "$VNC_PASSWORD" ]; then
    if command -v kasmvncpasswd >/dev/null 2>&1; then
        printf '%s\n%s\n' "$VNC_PASSWORD" "$VNC_PASSWORD" | kasmvncpasswd -u "$VNC_USER" -w >/dev/null 2>&1 || \
        printf '%s\n%s\n' "$VNC_PASSWORD" "$VNC_PASSWORD" | kasmvncpasswd -u "$VNC_USER" || true
        AUTH_FLAG="-SecurityTypes VncAuth"
        echo "[KasmVNC] 密码认证已成功启用 (User=${VNC_USER})"
    fi
fi

# 3. 启动 KasmVNC Server (:0)
echo "[KasmVNC] 正在拉起 Xvnc 服务 (:0, UID=${UID_NOW})..."
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

for i in $(seq 1 30); do
    if [ -e /tmp/.X11-unix/X0 ]; then
        break
    fi
    sleep 0.1
done

# 4. 桌面背景、Num Lock 与 X11 剪贴板守护同步 (autocutsel)
if command -v xsetroot >/dev/null 2>&1; then
    DISPLAY=:0 xsetroot -solid "#0b1120" >/dev/null 2>&1 || true
fi
if command -v numlockx >/dev/null 2>&1; then
    DISPLAY=:0 numlockx on || true
fi
if command -v autocutsel >/dev/null 2>&1; then
    DISPLAY=:0 autocutsel -fork >/dev/null 2>&1 &
fi

# 5. 启动定制化 Openbox 窗口管理器与 tint2 底部工具栏
openbox &
sleep 0.4
if command -v tint2 >/dev/null 2>&1; then
    tint2 >/dev/null 2>&1 &
fi

# 6. CDP 安全隔离：Chromium 原生仅绑定 127.0.0.1:9222，绝不直接暴露到公网；外部由 edge_node_client 的 WSS (默认 9443) 鉴权代理
# 仅当显式设置 CDP_FORWARD_PORT 或 ENABLE_CDP_FORWARD=true 时，才使用 socat 将变量端口（默认 9223）转发至 127.0.0.1:9222
EDGE_WSS_PORT="${EDGE_WSS_PORT:-9443}"
export EDGE_WSS_PORT

SOCAT_LISTEN_PORT=""
if [ -n "${CDP_FORWARD_PORT:-}" ]; then
    case "${CDP_FORWARD_PORT}" in
        1|true|TRUE|yes|YES|on|ON) SOCAT_LISTEN_PORT="9223" ;;
        0|false|FALSE|no|NO|off|OFF) SOCAT_LISTEN_PORT="" ;;
        *[!0-9]*)
            echo "[WARN] 忽略无效的 CDP_FORWARD_PORT='${CDP_FORWARD_PORT}'，未启用 socat CDP 转发"
            SOCAT_LISTEN_PORT=""
            ;;
        *)
            if [ "${CDP_FORWARD_PORT}" -ge 1 ] 2>/dev/null && [ "${CDP_FORWARD_PORT}" -le 65535 ] 2>/dev/null; then
                SOCAT_LISTEN_PORT="${CDP_FORWARD_PORT}"
            else
                echo "[WARN] CDP_FORWARD_PORT='${CDP_FORWARD_PORT}' 超出端口范围 (1-65535)，未启用 socat CDP 转发"
            fi
            ;;
    esac
elif [ -n "${ENABLE_CDP_FORWARD:-}" ]; then
    case "${ENABLE_CDP_FORWARD}" in
        1|true|TRUE|yes|YES|on|ON) SOCAT_LISTEN_PORT="9223" ;;
    esac
fi

if [ -n "$SOCAT_LISTEN_PORT" ]; then
    echo "[CDP Forward] 变量已启用，启动 socat 转发: 0.0.0.0:${SOCAT_LISTEN_PORT} -> 127.0.0.1:9222"
    socat TCP-LISTEN:"${SOCAT_LISTEN_PORT}",fork,reuseaddr TCP:127.0.0.1:9222 &
    echo "[Ready] KasmVNC(UID=${UID_NOW}) Web HTTPS :6901, Local CDP 127.0.0.1:9222, Socat Forward :${SOCAT_LISTEN_PORT}, Edge WSS :${EDGE_WSS_PORT}"
else
    echo "[Ready] KasmVNC(UID=${UID_NOW}) Web HTTPS :6901, Local CDP 127.0.0.1:9222 (socat 未启用), Edge WSS :${EDGE_WSS_PORT}"
fi

# 7. 启动 Wimotek Agent 守护进程 (带故障自动重生看门狗)
if [ -n "$HUB_URL" ]; then
    echo "[Edge] 检测到 HUB_URL 配置 ($HUB_URL)，拉起 Agent 后台守护看门狗..."
    (
        while true; do
            echo "[Edge Watchdog] 正在拉起 edge_node_client 进程..."
            python3 -u /opt/edge_node_client.py || true
            echo "[Edge Watchdog] ⚠️ edge_node_client 异常退出，3 秒后自动重生..."
            sleep 3
        done
    ) &
fi

# 8. 循环守护启动 Chromium (原生使用 9222 调试端口)
if [ $# -eq 0 ]; then
    set -- "$HOMEPAGE"
fi

# 自动检测 /dev/shm 容量：未设置 --shm-size="2gb" (默认仅 64MB) 时自动启用 --disable-dev-shm-usage 防止崩溃循环
SHM_KB="$(df -Pk /dev/shm 2>/dev/null | awk 'NR==2 {print $2}')"
EXTRA_SHM_FLAG=""
if [ -n "$SHM_KB" ] && [ "$SHM_KB" -lt 524288 ] 2>/dev/null; then
    case " $CHROME_ARGS " in
        *" --disable-dev-shm-usage "*) ;;
        *)
            echo "[WARN] 检测到 /dev/shm 仅 $((SHM_KB / 1024))MB (< 512MB)，自动追加 --disable-dev-shm-usage（建议启动时配置 --shm-size=\"2gb\"）"
            EXTRA_SHM_FLAG="--disable-dev-shm-usage"
            ;;
    esac
fi

echo "Starting Chromium under KasmVNC (non-root UID=${UID_NOW}) with local-only CDP 127.0.0.1:9222..."
while true; do
    rm -f /data/SingletonLock /data/SingletonCookie /data/SingletonSocket 2>/dev/null || true

    set +e
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
        $EXTRA_SHM_FLAG \
        $CHROME_ARGS \
        "$@"
    CHROME_EXIT=$?
    set -e

    echo "[Chromium] 进程已退出 (exit=${CHROME_EXIT})，2 秒后自动拉起..."
    sleep 2
done