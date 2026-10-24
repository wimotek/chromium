#!/bin/sh
set -e

TEMPLATE_FILE="/etc/xray/config.template.json"
CONFIG_FILE="/data/config.json"
CLIENT_INFO_FILE="/data/client_info.txt"
PUBLIC_KEY_FILE="/data/public_key.txt"
PRIVATE_KEY_FILE="/data/private_key.txt"

mkdir -p /data

update_xray() {
    ARCH=$(uname -m)
    case "$ARCH" in
        "x86_64") XRAY_ARCH="64" ;;
        "aarch64") XRAY_ARCH="arm64-v8a" ;;
        *) return 0 ;;
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
    fi
}

[ "${AUTO_UPDATE}" = "true" ] && update_xray

PORT="${PORT:-443}"
DEST="${DEST:-www.microsoft.com:443}"
SERVER_NAMES="${SERVER_NAMES:-www.microsoft.com,microsoft.com}"

[ -z "$SERVER_IP" ] && SERVER_IP=$(curl -s4 --max-time 3 https://api.ipify.org || echo "127.0.0.1")

SERVER_NAMES_JSON=$(echo "$SERVER_NAMES" | awk -F',' '{printf "["; for(i=1; i<=NF; i++) {printf "\"%s\"", $i; if(i<NF) printf ","} printf "]"}')

if [ -f "$PRIVATE_KEY_FILE" ] && [ -s "$PRIVATE_KEY_FILE" ]; then
    PRIVATE_KEY=$(cat "$PRIVATE_KEY_FILE" | tr -d ' \r\n')
fi

if [ -z "$PRIVATE_KEY" ]; then
    KEY_PAIR=$(/usr/bin/xray x25519)
    PRIVATE_KEY=$(echo "$KEY_PAIR" | grep -i "private" | awk '{print $NF}' | tr -d ' \r\n')
    PUBLIC_KEY=$(echo "$KEY_PAIR" | grep -i "public" | awk '{print $NF}' | tr -d ' \r\n')
    echo "$PRIVATE_KEY" > "$PRIVATE_KEY_FILE"
    echo "$PUBLIC_KEY" > "$PUBLIC_KEY_FILE"
fi

if [ ! -s "$PUBLIC_KEY_FILE" ] || [ -z "$PUBLIC_KEY" ]; then
    PUB_OUT=$(/usr/bin/xray x25519 -i "$PRIVATE_KEY")
    PUBLIC_KEY=$(echo "$PUB_OUT" | awk '{print $NF}' | tr -d ' \r\n')
    echo "$PUBLIC_KEY" > "$PUBLIC_KEY_FILE"
fi

SHORT_ID="${SHORT_ID:-$(openssl rand -hex 8)}"

# 初始 config.json 构建
if [ ! -s "$CONFIG_FILE" ]; then
    [ ! -f "$TEMPLATE_FILE" ] && exit 1
    TMP_CONFIG="/tmp/config.init.tmp.json"
    cat "$TEMPLATE_FILE" | jq \
        --arg port "$PORT" \
        --arg dest "$DEST" \
        --arg privkey "$PRIVATE_KEY" \
        --arg shortid "$SHORT_ID" \
        --argjson servernames "$SERVER_NAMES_JSON" \
        '
        .inbounds[0].port = ($port | tonumber) |
        .inbounds[0].streamSettings.realitySettings.dest = $dest |
        .inbounds[0].streamSettings.realitySettings.serverNames = $servernames |
        .inbounds[0].streamSettings.realitySettings.privateKey = $privkey |
        .inbounds[0].streamSettings.realitySettings.shortIds = [$shortid]
        ' > "$TMP_CONFIG"
    [ -s "$TMP_CONFIG" ] && mv "$TMP_CONFIG" "$CONFIG_FILE"
fi

# ================= 核心：远程主控自动注册、公钥回传与定时同步 =================
remote_agent_loop() {
    echo "==> [Cluster Node] 向主控注册上线并上报公钥 (Target: $PANEL_URL)..."
    
    # 核心：自动将真实 Public Key、ShortId、IP、端口上报给 xray_web
    curl -s -X POST "${PANEL_URL}/api/node/heartbeat?token=${NODE_KEY}" \
         -H "Content-Type: application/json" \
         -d "{\"ip\": \"$SERVER_IP\", \"port\": $PORT, \"sni\": \"$DEST\", \"pbk\": \"$PUBLIC_KEY\", \"sid\": \"$SHORT_ID\"}" || true

    while true; do
        sleep 60
        # 从主控拉取最新有效用户名单 (UUID + 用户名)
        USER_RESP=$(curl -s "${PANEL_URL}/api/node/sync?token=${NODE_KEY}" || true)
        if echo "$USER_RESP" | grep -q '"code":200'; then
            REMOTE_USERS=$(echo "$USER_RESP" | jq '.users')
            TMP_SYNC="/tmp/config.agent.sync.json"
            
            jq --argjson new_clients "$REMOTE_USERS" \
               '.inbounds[0].settings.clients = $new_clients' \
               "$CONFIG_FILE" > "$TMP_SYNC"

            if [ -s "$TMP_SYNC" ]; then
                if ! cmp -s "$TMP_SYNC" "$CONFIG_FILE"; then
                    mv "$TMP_SYNC" "$CONFIG_FILE"
                    killall -HUP xray 2>/dev/null || pkill -HUP xray 2>/dev/null || true
                    echo "==> [Cluster Node] 收到主控新用户名单，已自动重载 Xray 核心！"
                else
                    rm -f "$TMP_SYNC"
                fi
            fi
        fi

        # 抓取增量流量回传主控扣费
        TRAFFIC_RAW=$(/usr/bin/xray api statsquery --server=127.0.0.1:10085 -pattern "user>>>" -reset=true 2>/dev/null || true)
        if [ -n "$TRAFFIC_RAW" ] && echo "$TRAFFIC_RAW" | grep -q "stat"; then
            TRAFFIC_PAYLOAD=$(echo "$TRAFFIC_RAW" | jq '[.stat[]? | {username: (.name | split(">>>")[1]), bytes: (.value | tonumber)}]')
            curl -s -X POST "${PANEL_URL}/api/node/traffic?token=${NODE_KEY}" \
                 -H "Content-Type: application/json" \
                 -d "{\"traffic\": $TRAFFIC_PAYLOAD}" || true
        fi
    done
}

if [ -n "$PANEL_URL" ] && [ -n "$NODE_KEY" ]; then
    remote_agent_loop &
fi

echo "==> Starting Xray-core daemon using /data/config.json..."
exec /usr/bin/xray run -config /data/config.json