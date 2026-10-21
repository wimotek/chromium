#!/bin/sh
set -e

# 模板读取容器内部原位
TEMPLATE_FILE="/etc/xray/config.template.json"
# 运行配置与节点信息写入 /data
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

if [ -z "$SERVER_IP" ]; then
    SERVER_IP=$(curl -s4 --max-time 3 https://api.ipify.org || curl -s4 --max-time 3 https://ifconfig.me || echo "YOUR_SERVER_IP")
fi

if [ ! -f "$CONFIG_FILE" ]; then
    echo "==> [Init] /data/config.json not found, generating from template..."

    UUID="${UUID:-$(/usr/bin/xray uuid)}"

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

    jq \
      --arg port "$PORT" \
      --arg uuid "$UUID" \
      --arg dest "$DEST" \
      --arg privkey "$PRIVATE_KEY" \
      --arg shortid "$SHORT_ID" \
      --argjson servernames "$SERVER_NAMES_JSON" \
      '
      .inbounds[0].port = ($port | tonumber) |
      .inbounds[0].settings.clients[0].id = $uuid |
      .inbounds[0].streamSettings.realitySettings.dest = $dest |
      .inbounds[0].streamSettings.realitySettings.serverNames = $servernames |
      .inbounds[0].streamSettings.realitySettings.privateKey = $privkey |
      .inbounds[0].streamSettings.realitySettings.shortIds = [$shortid]
      ' "$TEMPLATE_FILE" > "$CONFIG_FILE"

    VLESS_URL="vless://${UUID}@${SERVER_IP}:${PORT}?security=reality&encryption=none&pbk=${PUBLIC_KEY}&headerType=none&fp=chrome&type=tcp&flow=xtls-rprx-vision&sni=${FIRST_SERVER_NAME}&sid=${SHORT_ID}#Xray-Core"

    cat <<EOF > "$CLIENT_INFO_FILE"
======================================================
              Xray Reality 节点配置信息
======================================================
IP / 地址:        ${SERVER_IP}
端口:             ${PORT}
UUID:             ${UUID}
流控 (flow):      xtls-rprx-vision
安全类型:         reality
SNI / 伪装域名:   ${FIRST_SERVER_NAME}
公钥 (PublicKey): ${PUBLIC_KEY}
ShortId:          ${SHORT_ID}

客户端导入链接:
${VLESS_URL}
======================================================
EOF
fi

if [ -f "$CLIENT_INFO_FILE" ]; then
    cat "$CLIENT_INFO_FILE"
fi

echo "==> Starting Xray-core daemon using /data/config.json..."
exec /usr/bin/xray run -config /data/config.json