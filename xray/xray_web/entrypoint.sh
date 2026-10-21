#!/bin/sh
set -e

# 模板读取原位（容器内部只读，外部看不见也覆盖不到）
TEMPLATE_FILE="/etc/xray/config.template.json"
# 运行时数据与账密信息存放在 /data（映射到宿主机）
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
DEST="${DEST:-www.apple.com:443}"
SERVER_NAMES="${SERVER_NAMES:-www.apple.com,apple.com}"
FIRST_SERVER_NAME=$(echo "$SERVER_NAMES" | cut -d',' -f1)
USER_COUNT="${USER_COUNT:-2}"
WEB_ENABLE="${WEB_ENABLE:-true}"
WEB_PORT="${WEB_PORT:-8080}"
WEB_PASSWORD="${WEB_PASSWORD:-$(openssl rand -hex 6)}"

if [ -z "$SERVER_IP" ]; then
    SERVER_IP=$(curl -s4 --max-time 3 https://api.ipify.org || curl -s4 --max-time 3 https://ifconfig.me || echo "YOUR_SERVER_IP")
fi

# 检查 /data/config.json 是否存在，不存在则现场生成
if [ ! -f "$CONFIG_FILE" ]; then
    echo "==> [Init] /data/config.json not found, generating from template..."

    if [ -z "$PRIVATE_KEY" ] || [ -z "$PUBLIC_KEY" ]; then
        KEY_PAIR=$(/usr/bin/xray x25519)
        PRIVATE_KEY=$(echo "$KEY_PAIR" | grep "PrivateKey:" | awk '{print $2}')
        PUBLIC_KEY=$(echo "$KEY_PAIR" | grep "PublicKey:" | awk '{print $2}')
    fi
    SHORT_ID="${SHORT_ID:-$(openssl rand -hex 8)}"

    SERVER_NAMES_JSON=$(echo "$SERVER_NAMES" | awk -F',' '{
        printf "["
        for(i=1; i<=NF; i++) {
            printf "\"%s\"", $i
            if(i<NF) printf ","
        }
        printf "]"
    }')

    CLIENTS_JSON="["
    for i in $(seq 1 "$USER_COUNT"); do
        U_ID=$(/usr/bin/xray uuid)
        CLIENTS_JSON="${CLIENTS_JSON}{\"id\":\"${U_ID}\",\"flow\":\"xtls-rprx-vision\",\"email\":\"user${i}\"}"
        [ "$i" -lt "$USER_COUNT" ] && CLIENTS_JSON="${CLIENTS_JSON},"
    done
    CLIENTS_JSON="${CLIENTS_JSON}]"

    jq \
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
      ' "$TEMPLATE_FILE" > "$CONFIG_FILE"

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

# Xray 启动读取 /data/config.json
echo "==> Starting Xray-core daemon using /data/config.json..."
while true; do
    /usr/bin/xray run -config /data/config.json &
    XRAY_PID=$!
    echo "$XRAY_PID" > /var/run/xray.pid
    wait "$XRAY_PID" || true
    sleep 0.5
done