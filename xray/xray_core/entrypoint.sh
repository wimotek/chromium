#!/bin/sh
set -e

TEMPLATE_FILE="/etc/xray/config.template.json"
CONFIG_FILE="/data/config.json"
CLIENT_INFO_FILE="/data/client_info.txt"
PUBLIC_KEY_FILE="/data/public_key.txt"
PRIVATE_KEY_FILE="/data/private_key.txt"
NODE_ID_FILE="/data/node_id.txt"
NODE_KEY_FILE="/data/node_key.txt"

mkdir -p /data

# 1. 自动升级检查
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

# 密钥与公钥持久化
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

# 初始配置生成
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

# 2. 节点永久唯一标识生成
if [ -f "$NODE_ID_FILE" ] && [ -s "$NODE_ID_FILE" ]; then
    NODE_ID=$(cat "$NODE_ID_FILE" | tr -d ' \r\n')
else
    NODE_ID=$(openssl rand -hex 8)
    echo "$NODE_ID" > "$NODE_ID_FILE"
fi

# 核心清洗：剥离 PANEL_URL 里的所有实体引号与末尾斜杠
if [ -n "$PANEL_URL" ]; then
    PANEL_URL=$(echo "$PANEL_URL" | tr -d '"'\'' ' | sed 's|/*$||')
fi

# 3. 密钥处理：自动生成或清洗
if [ -n "$NODE_KEY" ]; then
    NODE_KEY=$(echo "$NODE_KEY" | tr -d '"'\'' ')
    echo "$NODE_KEY" > "$NODE_KEY_FILE"
elif [ -f "$NODE_KEY_FILE" ] && [ -s "$NODE_KEY_FILE" ]; then
    NODE_KEY=$(cat "$NODE_KEY_FILE" | tr -d ' \r\n')
else
    NODE_KEY=$(openssl rand -hex 16)
    echo "$NODE_KEY" > "$NODE_KEY_FILE"
    echo "==> [Node Key] 首次启动自动生成通信密钥: $NODE_KEY"
fi

# 4. 远程协同守护进程
remote_agent_loop() {
    echo "==> [Cluster Node] 开始连接主控 (地址: $PANEL_URL, 节点ID: $NODE_ID)..."

    while true; do
        # 发送心跳、公钥与 ShortId，带详细报错捕获
        HB_RESP=$(curl -s -X POST "${PANEL_URL}/api/node/heartbeat" \
             -H "Content-Type: application/json" \
             --connect-timeout 8 \
             --max-time 15 \
             -d "{\"node_id\": \"$NODE_ID\", \"node_key\": \"$NODE_KEY\", \"ip\": \"$SERVER_IP\", \"port\": $PORT, \"sni\": \"$DEST\", \"pbk\": \"$PUBLIC_KEY\", \"sid\": \"$SHORT_ID\"}" 2>&1 || true)

        if echo "$HB_RESP" | grep -q '"code":200'; then
            echo "==> [Heartbeat] 节点心跳正常，已同步登记公钥！"
        else
            echo "==> [Heartbeat 警告] 主控心跳响应异常: $HB_RESP"
        fi

        # 检查主控是否下发重置密钥
        NEW_KEY=$(echo "$HB_RESP" | jq -r '.new_node_key // empty' 2>/dev/null || true)
        if [ -n "$NEW_KEY" ]; then
            NODE_KEY="$NEW_KEY"
            echo "$NODE_KEY" > "$NODE_KEY_FILE"
            echo "==> [Cluster Node] 收到主控新密钥，已成功更新本地密钥！"
        fi

        # 拉取全站最新合法用户名单
        USER_RESP=$(curl -s --connect-timeout 8 --max-time 15 "${PANEL_URL}/api/node/sync?node_id=${NODE_ID}&token=${NODE_KEY}" 2>&1 || true)
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
                    echo "==> [Cluster Node] 用户名单已自动重载生效！"
                else
                    rm -f "$TMP_SYNC"
                fi
            fi
        fi

        # 统计增量流量回传主控
        TRAFFIC_RAW=$(/usr/bin/xray api statsquery --server=127.0.0.1:10085 -pattern "user>>>" -reset=true 2>/dev/null || true)
        if [ -n "$TRAFFIC_RAW" ] && echo "$TRAFFIC_RAW" | grep -q "stat"; then
            TRAFFIC_PAYLOAD=$(echo "$TRAFFIC_RAW" | jq '[.stat[]? | {username: (.name | split(">>>")[1]), bytes: (.value | tonumber)}]')
            curl -s -X POST "${PANEL_URL}/api/node/traffic" \
                 -H "Content-Type: application/json" \
                 --connect-timeout 8 \
                 --max-time 15 \
                 -d "{\"node_id\": \"$NODE_ID\", \"token\": \"$NODE_KEY\", \"traffic\": $TRAFFIC_PAYLOAD}" >/dev/null 2>&1 || true
        fi

        sleep 60
    done
}

if [ -n "$PANEL_URL" ]; then
    remote_agent_loop &
fi

echo "==> Starting Xray-core daemon using /data/config.json..."
exec /usr/bin/xray run -config /data/config.json