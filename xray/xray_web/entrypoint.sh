#!/bin/sh
set -e

TEMPLATE_FILE="/etc/xray/config.template.json"
CONFIG_FILE="/data/config.json"
CLIENT_INFO_FILE="/data/client_info.txt"
PUBLIC_KEY_FILE="/data/public_key.txt"

mkdir -p /data /tmp

# ================= 1. 核心自动更新检查 (与 xray_core 100% 保持一致) =================
update_xray() {
    echo "==> Checking for latest Xray-core..."
    ARCH=$(uname -m)
    case "$ARCH" in
        "x86_64") XRAY_ARCH="64" ;;
        "aarch64") XRAY_ARCH="arm64-v8a" ;;
        "armv7l") XRAY_ARCH="arm32-v7a" ;;
        "i386"|"i686") XRAY_ARCH="32" ;;
        *) echo "[!] Unsupported arch: $ARCH, skip."; return 0 ;;
    esac

    TMP_DIR=$(mktemp -d)
    DOWNLOAD_URL="https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-${XRAY_ARCH}.zip"
    if curl -fSL "$DOWNLOAD_URL" -o "$TMP_DIR/xray.zip"; then
        unzip -q -o "$TMP_DIR/xray.zip" -d "$TMP_DIR"
        chmod +x "$TMP_DIR/xray"
        mv "$TMP_DIR/xray" /usr/bin/xray
        [ -f "$TMP_DIR/geosite.dat" ] && mv "$TMP_DIR/geosite.dat" /usr/share/xray/geosite.dat
        [ -f "$TMP_DIR/geoip.dat" ] && mv "$TMP_DIR/geoip.dat" /usr/share/xray/geoip.dat
        rm -rf "$TMP_DIR"
        echo "==> [Success] Updated to: $(/usr/bin/xray version | head -n 1)"
    else
        echo "[!] Update failed, keeping current."
        rm -rf "$TMP_DIR"
    fi
}

if [ "$1" = "update" ] || [ "$(basename "$0")" = "update-xray" ]; then
    update_xray
    exit 0
fi

if [ "${AUTO_UPDATE}" = "true" ] || [ "${AUTO_UPDATE}" = "1" ]; then
    update_xray
fi

echo "==> Current version: $(/usr/bin/xray version | head -n 1)"

# ================= 2. 基础变量与网络参数解析 =================
PORT="${PORT:-443}"
DEST="${DEST:-www.microsoft.com:443}"
SERVER_NAMES="${SERVER_NAMES:-www.microsoft.com,microsoft.com}"
FIRST_SERVER_NAME=$(echo "$SERVER_NAMES" | cut -d',' -f1)

# Web 运营控制变量
export APP_MODE="${APP_MODE:-user}"        # user (默认纯用户端防扫) | admin (仅后台) | all (全开)
export WEB_ENABLE="${WEB_ENABLE:-true}"    # 是否启动 Web 面板
export WEB_PORT="${WEB_PORT:-3000}"        # Web 端口
export PORT="${PORT}"

if [ -z "$SERVER_IP" ]; then
    SERVER_IP=$(curl -s4 --max-time 3 https://api.ipify.org || curl -s4 --max-time 3 https://ifconfig.me || echo "YOUR_SERVER_IP")
fi

SERVER_NAMES_JSON=$(echo "$SERVER_NAMES" | awk -F',' '{
    printf "["
    for(i=1; i<=NF; i++) {
        printf "\"%s\"", $i
        if(i<NF) printf ","
    }
    printf "]"
}')

# ================= 3. 核心防暴毙逻辑：0 字节检查与原子写入 =================
if [ ! -s "$CONFIG_FILE" ]; then
    echo "==> [Init] /data/config.json is missing or 0 bytes, generating..."

    UUID="${UUID:-$(/usr/bin/xray uuid)}"

    if [ -z "$PRIVATE_KEY" ] || [ -z "$PUBLIC_KEY" ]; then
        KEY_PAIR=$(/usr/bin/xray x25519)
        PRIVATE_KEY=$(echo "$KEY_PAIR" | grep -i "private" | awk -F': ' '{print $2}' | tr -d ' \r\n')
        PUBLIC_KEY=$(echo "$KEY_PAIR" | grep -i "public" | awk -F': ' '{print $2}' | tr -d ' \r\n')
    fi
    SHORT_ID="${SHORT_ID:-$(openssl rand -hex 8)}"

    # 导出并固化公钥供 Web 后端 100% 稳定读取
    echo "$PUBLIC_KEY" > "$PUBLIC_KEY_FILE"

    # 若模板丢失，使用支持 stats API 的兜底内置模板
    if [ ! -f "$TEMPLATE_FILE" ]; then
        echo "[WARN] $TEMPLATE_FILE not found, using embedded fallback template."
        TEMPLATE_DATA='{"log":{"loglevel":"warning"},"api":{"tag":"api","services":["StatsService"]},"stats":{},"policy":{"levels":{"0":{"statsUserUplink":true,"statsUserDownlink":true}},"system":{"statsInboundUplink":true,"statsInboundDownlink":true}},"inbounds":[{"listen":"127.0.0.1","port":10085,"protocol":"dokodemo-door","settings":{"address":"127.0.0.1"},"tag":"api"},{"port":443,"protocol":"vless","settings":{"clients":[{"id":"CHANGE_UUID","flow":"xtls-rprx-vision"}],"decryption":"none"},"streamSettings":{"network":"tcp","security":"reality","realitySettings":{"show":false,"dest":"www.microsoft.com:443","xver":0,"serverNames":["www.microsoft.com"],"privateKey":"CHANGE_PRIVATE_KEY","shortIds":["CHANGE_SHORT_ID"]}},"sniffing":{"enabled":true,"destOverride":["http","tls","quic"],"routeOnly":true}}],"outbounds":[{"protocol":"freedom","tag":"direct"},{"protocol":"blackhole","tag":"block"}],"routing":{"rules":[{"inboundTag":["api"],"outboundTag":"api","type":"field"},{"type":"field","ip":["geoip:private"],"outboundTag":"block"}]}}'
    else
        TEMPLATE_DATA=$(cat "$TEMPLATE_FILE")
    fi

    # 原子写入：使用 jq 写入 /tmp 临时文件，严格检查 ! -s 绝不产生 0 字节文件
    TMP_CONFIG="/tmp/config.init.tmp.json"
    echo "$TEMPLATE_DATA" | jq \
        --arg port "$PORT" \
        --arg uuid "$UUID" \
        --arg dest "$DEST" \
        --arg privkey "$PRIVATE_KEY" \
        --arg shortid "$SHORT_ID" \
        --argjson servernames "$SERVER_NAMES_JSON" \
        '
        (if .inbounds[0].tag == "api" then .inbounds[1] else .inbounds[0] end) |= (
            .port = ($port | tonumber) |
            .settings.clients[0].id = $uuid |
            .streamSettings.realitySettings.dest = $dest |
            .streamSettings.realitySettings.serverNames = $servernames |
            .streamSettings.realitySettings.privateKey = $privkey |
            .streamSettings.realitySettings.shortIds = [$shortid]
        )
        ' > "$TMP_CONFIG"

    if [ -s "$TMP_CONFIG" ]; then
        mv "$TMP_CONFIG" "$CONFIG_FILE"
        echo "==> [Init] /data/config.json successfully created."
    else
        echo "[FATAL] jq generation failed, aborting!"
        exit 1
    fi

    VLESS_URL="vless://${UUID}@${SERVER_IP}:${PORT}?security=reality&encryption=none&pbk=${PUBLIC_KEY}&headerType=none&fp=chrome&type=tcp&flow=xtls-rprx-vision&sni=${FIRST_SERVER_NAME}&sid=${SHORT_ID}#Xray-Reality"

    cat <<EOF > "$CLIENT_INFO_FILE"
======================================================
           Xray Reality 节点配置信息
======================================================
IP / 地址: ${SERVER_IP}
端口: ${PORT}
UUID: ${UUID}
流控 (flow): xtls-rprx-vision
安全类型: reality
SNI / 伪装域名: ${FIRST_SERVER_NAME}
公钥 (PublicKey): ${PUBLIC_KEY}
ShortId: ${SHORT_ID}

客户端导入链接:
${VLESS_URL}
======================================================
EOF

# ================= 4. 核心自动更新逻辑：改端口/域名免删 data =================
else
    echo "==> [Sync] Existing config detected. Syncing PORT and SNI from environment..."
    TMP_SYNC="/tmp/config.sync.tmp.json"
    jq \
        --arg port "$PORT" \
        --arg dest "$DEST" \
        --argjson servernames "$SERVER_NAMES_JSON" \
        '
        (if .inbounds[0].tag == "api" then .inbounds[1] else .inbounds[0] end) |= (
            .port = ($port | tonumber) |
            .streamSettings.realitySettings.dest = $dest |
            .streamSettings.realitySettings.serverNames = $servernames
        )
        ' "$CONFIG_FILE" > "$TMP_SYNC"

    if [ -s "$TMP_SYNC" ]; then
        mv "$TMP_SYNC" "$CONFIG_FILE"
        echo "==> [Sync] Configuration successfully updated with port: $PORT."
    fi

    if [ -f "$CLIENT_INFO_FILE" ]; then
        sed -i "s/^端口:.*/端口: ${PORT}/" "$CLIENT_INFO_FILE"
        sed -i "s/@\([^:]*\):[0-9]*/@\1:${PORT}/" "$CLIENT_INFO_FILE"
    fi

    # 提取已有的 Public Key 保持同步
    if [ -f "$CLIENT_INFO_FILE" ]; then
        grep "公钥 (PublicKey):" "$CLIENT_INFO_FILE" | awk '{print $2}' | tr -d ' \r\n' > "$PUBLIC_KEY_FILE"
    fi
fi

if [ -f "$CLIENT_INFO_FILE" ]; then
    cat "$CLIENT_INFO_FILE"
fi

# ================= 5. 进程控制与调度 (统一双进程) =================
# 如果不是纯管理端模式，启动 Xray 核心守护进程
if [ "$APP_MODE" != "admin" ]; then
    echo "==> Starting Xray-core daemon using /data/config.json..."
    /usr/bin/xray run -config /data/config.json &
    XRAY_PID=$!
fi

# 根据 WEB_ENABLE 控制是否拉起 Web 控制台 (默认开启)
if [ "$WEB_ENABLE" = "true" ] || [ "$WEB_ENABLE" = "1" ]; then
    echo "==> Starting Web Management Console (Mode: $APP_MODE, Port: $WEB_PORT)..."
    cd /app/backend && python3 app.py &
    WEB_PID=$!
else
    echo "==> [Web] WEB_ENABLE=false, Web console is disabled."
fi

# 信号捕获与平滑退出
trap 'echo "Stopping services..."; [ -n "$XRAY_PID" ] && kill $XRAY_PID 2>/dev/null; [ -n "$WEB_PID" ] && kill $WEB_PID 2>/dev/null; exit 0' SIGTERM SIGINT

if [ -n "$XRAY_PID" ]; then
    wait $XRAY_PID
elif [ -n "$WEB_PID" ]; then
    wait $WEB_PID
fi