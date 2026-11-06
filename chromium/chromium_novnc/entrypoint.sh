#!/usr/bin/env bash
set -e

# ==============================================================================
# 阶段 1：Root 权限自愈与降权
# ==============================================================================
if [ "$(id -u)" = "0" ]; then
    echo "[Init] (Root阶段) 正在执行权限自愈..."
    mkdir -p /tmp/.X11-unix /data /certs /etc/ssl/app /tmp/crashpad /home/appuser/.vnc
    chmod 1777 /tmp /tmp/.X11-unix /tmp/crashpad

    rm -rf /tmp/.X0-lock /tmp/.X11-unix/X0 /data/SingletonLock /data/SingletonCookie /data/SingletonSocket

    chown -R appuser:appuser /data /certs /etc/ssl/app /tmp/crashpad /home/appuser /opt/venv 2>/dev/null || true

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

RESOLUTION=${RESOLUTION:-1920x1080}
WIDTH=$(echo "$RESOLUTION" | cut -d'x' -f1)
HEIGHT=$(echo "$RESOLUTION" | cut -d'x' -f2)
CHROME_RES="${WIDTH},${HEIGHT}"
HOMEPAGE="${HOMEPAGE:-about:blank}"
CHROME_ARGS="${CHROME_ARGS:-}"

# 1. 启动 TigerVNC Standalone Server
Xvnc :0 -geometry "$RESOLUTION" -depth 24 -SecurityTypes None &

# 等待虚拟屏幕 Display :0 就绪
for i in {1..30}; do
    if [ -e /tmp/.X11-unix/X0 ]; then
        break
    fi
    sleep 0.1
done

# 2. 开启小键盘锁定
if command -v numlockx >/dev/null 2>&1; then
    DISPLAY=:0 numlockx on || true
fi

# 3. 启动窗口管理器 Openbox
openbox &

# 4. 启动 noVNC 网页服务 (HTTP 6080)
/usr/share/novnc/utils/novnc_proxy --vnc 127.0.0.1:5900 --listen 6080 &

# 5. 【核心对换】：socat 作为外部备用通道，监听 9223 转发至原生 9222
socat TCP-LISTEN:9223,fork,reuseaddr TCP:127.0.0.1:9222 &

echo "[Ready] noVNC HTTP 运行于 :6080, 外部备用 CDP 映射于 :9223, 原生 CDP 位于 :9222"

# ==============================================================================
# 6 【核心增强】：启动 Wimotek Agent 守护进程 (带故障自动拉起与自愈)
# ==============================================================================
if [ -n "$HUB_URL" ]; then
    echo "[Edge] 检测到 HUB_URL 配置 ($HUB_URL)，拉起 Agent 后台守护看门狗..."
    (
        # 守护子进程独立后台运行，主进程继续向下启动 Chromium
        while true; do
            echo "[Edge Watchdog] 正在拉起 edge_node_client 进程..."
            python3 /opt/edge_node_client.py || true
            echo "[Edge Watchdog] ⚠️ 警告: edge_node_client 异常退出，3 秒后自动重生拉起..."
            sleep 3
        done
    ) &
fi
# ==============================================================================
# 7. 循环守护启动 Chromium (原生使用 9222 调试端口)
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