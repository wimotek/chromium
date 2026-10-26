#!/bin/sh
set -e

TEMPLATE_FILE="/etc/xray/config.template.json"
CONFIG_FILE="/data/config.json"
CLIENT_INFO_FILE="/data/client_info.txt"
PUBLIC_KEY_FILE="/data/public_key.txt"
PRIVATE_KEY_FILE="/data/private_key.txt"
SHORT_ID_FILE="/data/short_id.txt"
NODE_ID_FILE="/data/node_id.txt"
NODE_KEY_FILE="/data/node_key.txt"

mkdir -p /data

# 1. 自动升级核心检查
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

# 2. 基础变量清洗与准备
[ -n "$PANEL_URL" ] && PANEL_URL=$(echo "$PANEL_URL" | tr -d '"'\'' ' | sed 's|/*$||')
[ -n "$NODE_KEY" ] && NODE_KEY=$(echo "$NODE_KEY" | tr -d '"'\'' ')

PORT="${PORT:-443}"
DEST="${DEST:-www.microsoft.com:443}"
SERVER_NAMES="${SERVER_NAMES:-www.microsoft.com,microsoft.com}"
FIRST_SERVER_NAME=$(echo "$SERVER_NAMES" | cut -d',' -f1)

[ -z "$SERVER_IP" ] && SERVER_IP=$(curl -s4 --max-time 3 https://api.ipify.org || echo "127.0.0.1")
SERVER_NAMES_JSON=$(echo "$SERVER_NAMES" | awk -F',' '{printf "["; for(i=1; i<=NF; i++) {printf "\"%s\"", $i; if(i<NF) printf ","} printf "]"}')

# 3. 密钥持久化与 43 位公钥精准提取 (修复 Xray 26 输出 3 行被错误拼接的 Bug)
if [ -f "$PRIVATE_KEY_FILE" ] && [ -s "$PRIVATE_KEY_FILE" ]; then
    PRIVATE_KEY=$(cat "$PRIVATE_KEY_FILE" | tr -d ' \r\n')
fi

if [ -z "$PRIVATE_KEY" ] || [ $(echo -n "$PRIVATE_KEY" | wc -c) -ne 43 ]; then
    KEY_PAIR=$(/usr/bin/xray x25519)
    PRIVATE_KEY=$(echo "$KEY_PAIR" | grep -iE 'private ?key' | sed 's/.*: *//' | tr -d ' \r\n')
    echo "$PRIVATE_KEY" > "$PRIVATE_KEY_FILE"
fi

PUB_OUT=$(/usr/bin/xray x25519 -i "$PRIVATE_KEY" 2>/dev/null || true)
PUBLIC_KEY=$(echo "$PUB_OUT" | grep -iE 'public ?key|password' | sed 's/.*: *//' | tr -d ' \r\n')
echo "$PUBLIC_KEY" > "$PUBLIC_KEY_FILE"

# 4. ShortId 固化与 UUID 准备
if [ -f "$SHORT_ID_FILE" ] && [ -s "$SHORT_ID_FILE" ]; then
    SHORT_ID=$(cat "$SHORT_ID_FILE" | tr -d ' \r\n')
else
    SHORT_ID=$(openssl rand -hex 8)
    echo "$SHORT_ID" > "$SHORT_ID_FILE"
fi

UUID="${UUID:-$(/usr/bin/xray uuid)}"

# 5. 初始本地 config.json 生成
if [ ! -s "$CONFIG_FILE" ]; then
    [ ! -f "$TEMPLATE_FILE" ] && exit 1
    TMP_CONFIG="/tmp/config.init.tmp.json"
    cat "$TEMPLATE_FILE" | jq \
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
    [ -s "$TMP_CONFIG" ] && mv "$TMP_CONFIG" "$CONFIG_FILE"
fi

# ================= 6. 核心分流：集群节点模式 vs 独立单机模式 =================

if [ -n "$PANEL_URL" ]; then
    # ---------------- 场景 A：集群节点模式 (受 xray_web 远程管控) ----------------
    # 避免残留历史单机说明文件造成误导
    [ -f "$CLIENT_INFO_FILE" ] && rm -f "$CLIENT_INFO_FILE"

    if [ -f "$NODE_ID_FILE" ] && [ -s "$NODE_ID_FILE" ]; then
        NODE_ID=$(cat "$NODE_ID_FILE" | tr -d ' \r\n')
    else
        NODE_ID=$(openssl rand -hex 8)
        echo "$NODE_ID" > "$NODE_ID_FILE"
    fi

    if [ -n "$NODE_KEY" ]; then
        echo "$NODE_KEY" > "$NODE_KEY_FILE"
    elif [ -f "$NODE_KEY_FILE" ] && [ -s "$NODE_KEY_FILE" ]; then
        NODE_KEY=$(cat "$NODE_KEY_FILE" | tr -d ' \r\n')
    else
        NODE_KEY=$(openssl rand -hex 16)
        echo "$NODE_KEY" > "$NODE_KEY_FILE"
        echo "==> [Node Key] 首次接入自动生成通信凭证: $NODE_KEY"
    fi

    remote_agent_loop() {
        echo "==> [Cluster Node] 守护进程启动 (主控: $PANEL_URL | 节点ID: $NODE_ID)..."

        while true; do
            # 1. 自动上报真实 43 位公钥、真实 ShortId、端口、SNI
            HB_RESP=$(curl -k -s -X POST "${PANEL_URL}/api/node/heartbeat" \
                 -H "Content-Type: application/json" \
                 --connect-timeout 8 \
                 --max-time 15 \
                 -d "{\"node_id\": \"$NODE_ID\", \"node_key\": \"$NODE_KEY\", \"ip\": \"$SERVER_IP\", \"port\": $PORT, \"sni\": \"$DEST\", \"pbk\": \"$PUBLIC_KEY\", \"sid\": \"$SHORT_ID\"}" 2>&1 || true)

            # 检查是否有重置密钥下发
            NEW_KEY=$(echo "$HB_RESP" | jq -r '.new_node_key // empty' 2>/dev/null || true)
            if [ -n "$NEW_KEY" ]; then
                NODE_KEY="$NEW_KEY"
                echo "$NODE_KEY" > "$NODE_KEY_FILE"
            fi

            # 2. 从主控双向拉取用户与网络参数 (动态对齐 ShortId 与端口)
            USER_RESP=$(curl -k -s --connect-timeout 8 --max-time 15 "${PANEL_URL}/api/node/sync?node_id=${NODE_ID}&token=${NODE_KEY}" 2>&1 || true)
            if echo "$USER_RESP" | grep -q '"code":200'; then
                REMOTE_USERS=$(echo "$USER_RESP" | jq '.users')
                REMOTE_PORT=$(echo "$USER_RESP" | jq -r '.node_config.port // empty')
                REMOTE_DEST=$(echo "$USER_RESP" | jq -r '.node_config.dest // empty')
                REMOTE_SNI=$(echo "$USER_RESP" | jq -r '.node_config.sni // empty')
                REMOTE_SID=$(echo "$USER_RESP" | jq -r '.node_config.sid // empty')

                if [ -n "$REMOTE_SID" ] && [ "$REMOTE_SID" != "$SHORT_ID" ]; then
                    SHORT_ID="$REMOTE_SID"
                    echo "$SHORT_ID" > "$SHORT_ID_FILE"
                fi

                TMP_SYNC="/tmp/config.agent.sync.json"
                jq --argjson new_clients "$REMOTE_USERS" \
                   --arg port "$REMOTE_PORT" \
                   --arg dest "$REMOTE_DEST" \
                   --arg sni "$REMOTE_SNI" \
                   --arg sid "$SHORT_ID" \
                   '
                   .inbounds[0].settings.clients = $new_clients |
                   (if $port != "" then .inbounds[0].port = ($port | tonumber) else . end) |
                   (if $dest != "" then .inbounds[0].streamSettings.realitySettings.dest = $dest else . end) |
                   (if $sni != "" then .inbounds[0].streamSettings.realitySettings.serverNames = [$sni] else . end) |
                   (if $sid != "" then .inbounds[0].streamSettings.realitySettings.shortIds = [$sid] else . end)
                   ' \
                   "$CONFIG_FILE" > "$TMP_SYNC"

                if [ -s "$TMP_SYNC" ]; then
                    if ! cmp -s "$TMP_SYNC" "$CONFIG_FILE"; then
                        mv "$TMP_SYNC" "$CONFIG_FILE"
                        killall -HUP xray 2>/dev/null || pkill -HUP xray 2>/dev/null || true
                        echo "==> [Cluster Node] 收到主控配置/用户名单更新，已自动热重载 Xray 核心！"
                    else
                        rm -f "$TMP_SYNC"
                    fi
                fi
            fi

            # 3. 统计增量流量回传主控
            TRAFFIC_RAW=$(/usr/bin/xray api statsquery --server=127.0.0.1:10085 -pattern "user>>>" -reset=true 2>/dev/null || true)
            if [ -n "$TRAFFIC_RAW" ] && echo "$TRAFFIC_RAW" | grep -q "stat"; then
                TRAFFIC_PAYLOAD=$(echo "$TRAFFIC_RAW" | jq '[.stat[]? | {username: (.name | split(">>>")[1]), bytes: (.value | tonumber)}]')
                curl -k -s -X POST "${PANEL_URL}/api/node/traffic" \
                     -H "Content-Type: application/json" \
                     --connect-timeout 8 \
                     --max-time 15 \
                     -d "{\"node_id\": \"$NODE_ID\", \"token\": \"$NODE_KEY\", \"traffic\": $TRAFFIC_PAYLOAD}" >/dev/null 2>&1 || true
            fi

            sleep 60
        done
    }

    remote_agent_loop &

else
    # ---------------- 场景 B：独立单机模式 (恢复原生逻辑，输出完整配置) ----------------
    VLESS_URL="vless://${UUID}@${SERVER_IP}:${PORT}?security=reality&encryption=none&pbk=${PUBLIC_KEY}&headerType=none&fp=chrome&type=tcp&flow=xtls-rprx-vision&sni=${FIRST_SERVER_NAME}&sid=${SHORT_ID}#Xray-Reality"

    cat <<EOF > "$CLIENT_INFO_FILE"
======================================================
           Xray Reality 单机节点配置信息
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

    echo "==> [Standalone] 单机模式启动成功！节点连接信息如下："
    cat "$CLIENT_INFO_FILE"
fi

echo "==> Starting Xray-core daemon using /data/config.json..."
exec /usr/bin/xray run -config /data/config.json