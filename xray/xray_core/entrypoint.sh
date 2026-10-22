#!/bin/sh
set -e

TEMPLATE_FILE="/etc/xray/config.template.json"
CONFIG_FILE="/data/config.json"
CLIENT_INFO_FILE="/data/client_info.txt"

mkdir -p /data

# 核心自动更新检查
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

# ================= 核心防暴毙逻辑：0 字节检查与原子写入 =================
# 使用 ! -s 判断：文件不存在 或 大小为 0 字节，均重新渲染生成！
if [ ! -s "$CONFIG_FILE" ]; then
    echo "==> [Init] /data/config.json is missing or 0 bytes, generating..."

    UUID="${UUID:-$(/usr/bin/xray uuid)}"

    if [ -z "$PRIVATE_KEY" ] || [ -z "$PUBLIC_KEY" ]; then
        KEY_PAIR=$(/usr/bin/xray x25519)
        PRIVATE_KEY=$(echo "$KEY_PAIR" | grep -i "private" | awk -F': ' '{print $2}' | tr -d ' \r\n')
        PUBLIC_KEY=$(echo "$KEY_PAIR" | grep -i "public" | awk -F': ' '{print $2}' | tr -d ' \r\n')
    fi
    SHORT_ID="${SHORT_ID:-$(openssl rand -hex 8)}"

    # 若容器内模板丢失，自动使用内存中的内置模板兜底
    if [ ! -f "$TEMPLATE_FILE" ]; then
        echo "[WARN] $TEMPLATE_FILE not found, using embedded fallback template."
        TEMPLATE_DATA='{"log":{"loglevel":"warning"},"inbounds":[{"port":443,"protocol":"vless","settings":{"clients":[{"id":"CHANGE_UUID","flow":"xtls-rprx-vision"}],"decryption":"none"},"streamSettings":{"network":"tcp","security":"reality","realitySettings":{"show":false,"dest":"www.microsoft.com:443","xver":0,"serverNames":["www.microsoft.com"],"privateKey":"CHANGE_PRIVATE_KEY","shortIds":["CHANGE_SHORT_ID"]}},"sniffing":{"enabled":true,"destOverride":["http","tls","quic"],"routeOnly":true}}],"outbounds":[{"protocol":"freedom","tag":"direct"},{"protocol":"blackhole","tag":"block"}],"routing":{"domainStrategy":"IPIfNonMatch","rules":[{"type":"field","ip":["geoip:private"],"outboundTag":"block"}]}}'
    else
        TEMPLATE_DATA=$(cat "$TEMPLATE_FILE")
    fi

    # 原子写入：先写入临时文件，确认文件非空再 mv，绝不产生 0 字节空文件
    TMP_CONFIG="/tmp/config.init.tmp.json"
    echo "$TEMPLATE_DATA" | jq \
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
      ' > "$TMP_CONFIG"

    if [ -s "$TMP_CONFIG" ]; then
        mv "$TMP_CONFIG" "$CONFIG_FILE"
        echo "==> [Init] /data/config.json successfully created."
    else
        echo "[FATAL] jq generation failed, aborting!"
        exit 1
    fi

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

# ================= 核心自动更新逻辑：改端口/域名免删 data =================
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

echo "==> Starting Xray-core daemon using /data/config.json..."
exec /usr/bin/xray run -config /data/config.json