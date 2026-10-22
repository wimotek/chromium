#!/bin/sh
set -e

TEMPLATE_FILE="/etc/xray/config.template.json"
CONFIG_FILE="/data/config.json"
CLIENT_INFO_FILE="/data/client_info.txt"

mkdir -p /data

update_xray() {
    echo "==> Checking for latest Xray-core..."
    ARCH=$(uname -m)
    case "$ARCH" in
        "x86_64")  XRAY_ARCH="64" ;;
        "aarch64") XRAY_ARCH="arm64-v8a" ;;
        "armv7l")  XRAY_ARCH="arm32-v7a" ;;
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

PORT="${PORT:-443}"
DEST="${DEST:-www.microsoft.com:443}"
SERVER_NAMES="${SERVER_NAMES:-www.microsoft.com,microsoft.com}"
FIRST_SERVER_NAME=$(echo "$SERVER_NAMES" | cut -d',' -f1)
USER_COUNT="${USER_COUNT:-2}"
WEB_ENABLE="${WEB_ENABLE:-true}"
WEB_PORT="${WEB_PORT:-8080}"
WEB_PASSWORD="${WEB_PASSWORD:-$(openssl rand -hex 6)}"

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

# ================= 核心防暴毙逻辑：0 字节检查 =================
# 使用 ! -s 判断。若文件不存在 或 大小为 0 字节，均必须重新渲染！
if [ ! -s "$CONFIG_FILE" ]; then
    echo "==> [Init] /data/config.json is missing or 0 bytes, generating..."

    if [ -z "$PRIVATE_KEY" ] || [ -z "$PUBLIC_KEY" ]; then
        KEY_PAIR=$(/usr/bin/xray x25519)
        PRIVATE_KEY=$(echo "$KEY_PAIR" | grep "PrivateKey:" | awk '{print $2}')
        PUBLIC_KEY=$(echo "$KEY_PAIR" | grep "PublicKey:" | awk '{print $2}')
    fi
    SHORT_ID="${SHORT_ID:-$(openssl rand -hex 8)}"

    CLIENTS_JSON="["
    for i in $(seq 1 "$USER_COUNT"); do
        U_ID=$(/usr/bin/xray uuid)
        CLIENTS_JSON="${CLIENTS_JSON}{\"id\":\"${U_ID}\",\"flow\":\"xtls-rprx-vision\",\"email\":\"user${i}\"}"
        [ "$i" -lt "$USER_COUNT" ] && CLIENTS_JSON="${CLIENTS_JSON},"
    done
    CLIENTS_JSON="${CLIENTS_JSON}]"

    # 若模板丢失，启用内置兜底模板
    if [ ! -f "$TEMPLATE_FILE" ]; then
        echo "[WARN] $TEMPLATE_FILE missing, using internal fallback template."
        TEMPLATE_DATA='{"log":{"loglevel":"warning"},"inbounds":[{"port":443,"protocol":"vless","settings":{"clients":[],"decryption":"none"},"streamSettings":{"network":"tcp","security":"reality","realitySettings":{"show":false,"dest":"www.microsoft.com:443","xver":0,"serverNames":["www.microsoft.com"],"privateKey":"","shortIds":[""]}},"sniffing":{"enabled":true,"destOverride":["http","tls","quic"],"routeOnly":true}}],"outbounds":[{"protocol":"freedom","tag":"direct"},{"protocol":"blackhole","tag":"block"}],"routing":{"domainStrategy":"IPIfNonMatch","rules":[{"type":"field","ip":["geoip:private"],"outboundTag":"block"}]}}'
    else
        TEMPLATE_DATA=$(cat "$TEMPLATE_FILE")
    fi

    # 原子写入：输出至临时文件，确认大小非 0 后才移动，绝不留下 0 字节文件
    TMP_CONFIG="/tmp/config.init.tmp.json"
    echo "$TEMPLATE_DATA" | jq \
      --arg port "$PORT" \
      --argjson clients "$CLIENTS_JSON" \
      --arg dest "$DEST" \
      --arg privkey "$PRIVATE_KEY" \
      --arg shortid "$SHORT_ID" \
      --argjson servernames "$SERVER_NAMES_JSON" \
      '
      .inbounds[0].port = ($port | tonumber) |
      .inbounds[0].settings.clients = $clients |
      .inbounds[0].streamSettings.realitySettings.dest = $dest |
      .inbounds[0].streamSettings.realitySettings.serverNames = $servernames |
      .inbounds[0].streamSettings.realitySettings.privateKey = $privkey |
      .inbounds[0].streamSettings.realitySettings.shortIds = [$shortid]
      ' > "$TMP_CONFIG"

    if [ -s "$TMP_CONFIG" ]; then
        mv "$TMP_CONFIG" "$CONFIG_FILE"
        echo "==> [Init] /data/config.json successfully generated."
    else
        echo "[FATAL] Failed to render valid JSON config!"
        exit 1
    fi

    FIRST_UUID=$(jq -r '.inbounds[0].settings.clients[0].id' "$CONFIG_FILE")
    VLESS_URL="vless://${FIRST_UUID}@${SERVER_IP}:${PORT}?security=reality&encryption=none&pbk=${PUBLIC_KEY}&headerType=none&fp=chrome&type=tcp&flow=xtls-rprx-vision&sni=${FIRST_SERVER_NAME}&sid=${SHORT_ID}#user1"

    cat <<EOF > "$CLIENT_INFO_FILE"
======================================================
              Xray Reality 节点配置信息
======================================================
IP / 地址:        ${SERVER_IP}
端口:             ${PORT}
用户数:           ${USER_COUNT}
流控 (flow):      xtls-rprx-vision
安全类型:         reality
SNI / 伪装域名:   ${FIRST_SERVER_NAME}
公钥 (PublicKey): ${PUBLIC_KEY}
ShortId:          ${SHORT_ID}

Vue 3 管理面板:   http://${SERVER_IP}:${WEB_PORT}
管理登录密码:     ${WEB_PASSWORD}

默认用户 (user1) 导入链接:
${VLESS_URL}
======================================================
EOF

# ================= 核心自动更新逻辑：改端口免删 data =================
else
    echo "==> [Sync] Existing config detected. Syncing PORT and SNI from environment..."
    TMP_SYNC="/tmp/config.sync.tmp.json"
    jq \
      --arg port "$PORT" \
      --arg dest "$DEST" \
      --argjson servernames "$SERVER_NAMES_JSON" \
      '
      .inbounds[0].port = ($port | tonumber) |
      .inbounds[0].streamSettings.realitySettings.dest = $dest |
      .inbounds[0].streamSettings.realitySettings.serverNames = $servernames
      ' "$CONFIG_FILE" > "$TMP_SYNC"

    if [ -s "$TMP_SYNC" ]; then
        mv "$TMP_SYNC" "$CONFIG_FILE"
        echo "==> [Sync] Configuration successfully updated with port: $PORT."
    fi

    if [ -f "$CLIENT_INFO_FILE" ]; then
        sed -i "s/^端口:.*/端口:             ${PORT}/" "$CLIENT_INFO_FILE"
    fi
fi

if [ -f "$CLIENT_INFO_FILE" ]; then
    cat "$CLIENT_INFO_FILE"
fi

export PUBLIC_KEY
export SERVER_IP
export WEB_PASSWORD
export WEB_PORT

# 启动 Web 后端服务
if [ "$WEB_ENABLE" = "true" ]; then
    uvicorn backend.main:app --host 0.0.0.0 --port "$WEB_PORT" --app-dir /app &
    WEB_PID=$!
    echo "$WEB_PID" > /var/run/web_admin.pid
fi

trap 'kill $(cat /var/run/xray.pid 2>/dev/null); kill $(cat /var/run/web_admin.pid 2>/dev/null); exit 0' TERM INT

echo "==> Starting Xray-core daemon using /data/config.json..."
while true; do
    /usr/bin/xray run -config /data/config.json &
    XRAY_PID=$!
    echo "$XRAY_PID" > /var/run/xray.pid
    wait "$XRAY_PID" || true
    sleep 0.5
done