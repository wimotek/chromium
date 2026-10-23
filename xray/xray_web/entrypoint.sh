#!/bin/sh
set -e

TEMPLATE_FILE="/etc/xray/config.template.json"
CONFIG_FILE="/data/config.json"
CLIENT_INFO_FILE="/data/client_info.txt"
PUBLIC_KEY_FILE="/data/public_key.txt"
PRIVATE_KEY_FILE="/data/private_key.txt"

mkdir -p /data

# ================= 1. 核心自动更新检查 =================
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

# ================= 2. 基础变量与网络参数解析 =================
PORT="${PORT:-443}"
DEST="${DEST:-www.microsoft.com:443}"
SERVER_NAMES="${SERVER_NAMES:-www.microsoft.com,microsoft.com}"
FIRST_SERVER_NAME=$(echo "$SERVER_NAMES" | cut -d',' -f1)

export APP_MODE="${APP_MODE:-user}"
export WEB_ENABLE="${WEB_ENABLE:-true}"
export WEB_PORT="${WEB_PORT:-3000}"
export PORT="${PORT}"

if [ -z "$SERVER_IP" ]; then
    SERVER_IP=$(curl -s4 --max-time 3 https://api.ipify.org || curl -s4 --max-time 3 https://ifconfig.me || echo "127.0.0.1")
fi

SERVER_NAMES_JSON=$(echo "$SERVER_NAMES" | awk -F',' '{
    printf "["
    for(i=1; i<=NF; i++) {
        printf "\"%s\"", $i
        if(i<NF) printf ","
    }
    printf "]"
}')

# ================= 3. 密钥生成与强制自愈逻辑 (使用 $NF 确保 100% 抓出真实密钥) =================
if [ -f "$PRIVATE_KEY_FILE" ] && [ -s "$PRIVATE_KEY_FILE" ]; then
    PRIVATE_KEY=$(cat "$PRIVATE_KEY_FILE" | tr -d ' \r\n')
fi

# 如果私钥丢失，生成全新密钥对
if [ -z "$PRIVATE_KEY" ]; then
    echo "==> [Key] Generating fresh X25519 key pair..."
    KEY_PAIR=$(/usr/bin/xray x25519)
    # 核心修复点：使用 $NF 打印最后一个字段，兼容任何空格或制表符
    PRIVATE_KEY=$(echo "$KEY_PAIR" | grep -i "private" | awk '{print $NF}' | tr -d ' \r\n')
    PUBLIC_KEY=$(echo "$KEY_PAIR" | grep -i "public" | awk '{print $NF}' | tr -d ' \r\n')
    echo "$PRIVATE_KEY" > "$PRIVATE_KEY_FILE"
    echo "$PUBLIC_KEY" > "$PUBLIC_KEY_FILE"
fi

# 核心自愈：如果公钥文件不存在或为空，从已有私钥现场反推公钥
if [ ! -s "$PUBLIC_KEY_FILE" ] || [ -z "$PUBLIC_KEY" ]; then
    echo "==> [Key] Deriving Public Key from Private Key..."
    PUB_OUT=$(/usr/bin/xray x25519 -i "$PRIVATE_KEY")
    PUBLIC_KEY=$(echo "$PUB_OUT" | awk '{print $NF}' | tr -d ' \r\n')
    echo "$PUBLIC_KEY" > "$PUBLIC_KEY_FILE"
fi

echo "==> [Key Success] Private Key: $PRIVATE_KEY"
echo "==> [Key Success] Public Key : $PUBLIC_KEY"

UUID="${UUID:-$(/usr/bin/xray uuid)}"
SHORT_ID="${SHORT_ID:-$(openssl rand -hex 8)}"

# ================= 4. 配置初始化与参数同步 =================
if [ ! -s "$CONFIG_FILE" ]; then
    echo "==> [Init] /data/config.json is missing or 0 bytes, generating..."

    if [ ! -f "$TEMPLATE_FILE" ]; then
        TEMPLATE_DATA='{"log":{"loglevel":"warning"},"inbounds":[{"port":443,"protocol":"vless","settings":{"clients":[{"id":"CHANGE_UUID","flow":"xtls-rprx-vision"}],"decryption":"none"},"streamSettings":{"network":"tcp","security":"reality","realitySettings":{"show":false,"dest":"www.microsoft.com:443","xver":0,"serverNames":["www.microsoft.com"],"privateKey":"CHANGE_PRIVATE_KEY","shortIds":["CHANGE_SHORT_ID"]}},"sniffing":{"enabled":true,"destOverride":["http","tls","quic"],"routeOnly":true}}],"outbounds":[{"protocol":"freedom","tag":"direct"},{"protocol":"blackhole","tag":"block"}],"routing":{"domainStrategy":"IPIfNonMatch","rules":[{"type":"field","ip":["geoip:private"],"outboundTag":"block"}]}}'
    else
        TEMPLATE_DATA=$(cat "$TEMPLATE_FILE")
    fi

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
    fi
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
    fi
fi

# ================= 5. 写入并更新 client_info.txt =================
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

cat "$CLIENT_INFO_FILE"

# ================= 6. 进程守护与优雅退出 =================
if [ "$APP_MODE" != "admin" ]; then
    echo "==> Starting Xray-core daemon using /data/config.json..."
    /usr/bin/xray run -config /data/config.json &
    XRAY_PID=$!
fi

if [ "$WEB_ENABLE" = "true" ] || [ "$WEB_ENABLE" = "1" ]; then
    echo "==> Starting Web Management Console (Mode: $APP_MODE, Port: $WEB_PORT)..."
    cd /app/backend && python3 app.py &
    WEB_PID=$!
fi

trap 'echo "Stopping services..."; [ -n "$XRAY_PID" ] && kill $XRAY_PID 2>/dev/null; [ -n "$WEB_PID" ] && kill $WEB_PID 2>/dev/null; exit 0' TERM INT

if [ -n "$XRAY_PID" ]; then
    wait $XRAY_PID
elif [ -n "$WEB_PID" ]; then
    wait $WEB_PID
fi