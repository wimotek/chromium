#!/bin/sh
set -e

TEMPLATE_FILE="/etc/xray/config.template.json"
CONFIG_FILE="/data/config.json"
CLIENT_INFO_FILE="/data/client_info.txt"
PUBLIC_KEY_FILE="/data/public_key.txt"
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

# 2. 基础变量清洗
[ -n "$PANEL_URL" ] && PANEL_URL=$(echo "$PANEL_URL" | tr -d '"'\'' ' | sed 's|/*$||')
[ -n "$NODE_KEY" ] && NODE_KEY=$(echo "$NODE_KEY" | tr -d '"'\'' ')

PORT="${PORT:-443}"
DEST="${DEST:-www.microsoft.com:443}"
SERVER_NAMES="${SERVER_NAMES:-www.microsoft.com,microsoft.com}"

FIRST_SERVER_NAME=$(echo "$SERVER_NAMES" | cut -d',' -f1 | cut -d':' -f1 | tr -d ' ')

[ -z "$SERVER_IP" ] && SERVER_IP=$(curl -s4 --max-time 3 https://api.ipify.org || echo "127.0.0.1")

SERVER_NAMES_JSON=$(echo "$SERVER_NAMES" | awk -F',' '{
    printf "["
    for(i=1; i<=NF; i++) {
        split($i, arr, ":")
        gsub(/^[ \t]+|[ \t]+$/, "", arr[1])
        if (arr[1] != "") {
            printf "\"%s\"", arr[1]
            if(i<NF) printf ","
        }
    }
    printf "]"
}')

# ================= 3. 核心优化：REALITY 密钥状态判定与公钥文件生成 =================

# 写入 public_key.txt (首行存放纯公钥，下方附带友好管理说明)
write_public_key_file() {
    cat <<EOF > "$PUBLIC_KEY_FILE"
$1

# ================================================================
# 【Xray REALITY 客户端公钥 (Public Key)】
# 1. 本文件第 1 行为客户端连接所需的真实公钥 (PublicKey)。
# 2. 服务端私钥 (PrivateKey) 已持久化保存在 /data/config.json 中。
# 3. 【彻底重置密钥对】：
#    如需更换全新私钥与公钥，请直接删除本文件 (rm -f /data/public_key.txt)
#    并重启容器，系统将自动生成全新私钥更新至 config.json 并重写本文件。
# 4. 【重新计算公钥】：
#    如公钥丢失或需重新计算，请清空本文件内容 (保留 0 字节空文件) 并重启，
#    系统将自动从 config.json 中的 privateKey 重新计算并还原公钥。
# ================================================================
EOF
}

# 彻底清理历史遗留的 private_key.txt 文件
[ -f "/data/private_key.txt" ] && rm -f "/data/private_key.txt"

if [ ! -s "$CONFIG_FILE" ]; then
    # 场景 A: 首次部署 (无 config.json)
    echo "==> [Init] 首次部署，正在生成全新 REALITY 密钥对..."
    KEY_PAIR=$(/usr/bin/xray x25519)
    PRIVATE_KEY=$(echo "$KEY_PAIR" | grep -i "Private" | head -n 1 | awk '{print $NF}' | tr -d ' \r\n')
    PUBLIC_KEY=$(echo "$KEY_PAIR" | grep -iE "Public|Password" | head -n 1 | awk '{print $NF}' | tr -d ' \r\n')
    write_public_key_file "$PUBLIC_KEY"

elif [ ! -f "$PUBLIC_KEY_FILE" ]; then
    # 场景 B: 用户删除了 public_key.txt (触发彻底重置密钥对)
    echo "==> [Key Reset] 检测到 public_key.txt 已被删除，正在生成全新密钥对并更新至 config.json..."
    KEY_PAIR=$(/usr/bin/xray x25519)
    PRIVATE_KEY=$(echo "$KEY_PAIR" | grep -i "Private" | head -n 1 | awk '{print $NF}' | tr -d ' \r\n')
    PUBLIC_KEY=$(echo "$KEY_PAIR" | grep -iE "Public|Password" | head -n 1 | awk '{print $NF}' | tr -d ' \r\n')
    write_public_key_file "$PUBLIC_KEY"

    # 同步把新生成的 privateKey 热更回 config.json
    TMP_RESET="/tmp/config.resetkey.tmp.json"
    jq --arg privkey "$PRIVATE_KEY" '
        (.inbounds[] | select(.protocol == "vless")) |= (
            .streamSettings.realitySettings.privateKey = $privkey
        )
    ' "$CONFIG_FILE" > "$TMP_RESET" && mv "$TMP_RESET" "$CONFIG_FILE"

elif [ ! -s "$PUBLIC_KEY_FILE" ]; then
    # 场景 C: public_key.txt 为空文件 (触发从 config.json 的 privateKey 重新推导)
    echo "==> [Key Re-derive] 检测到 public_key.txt 为空文件，正在从 config.json 重新计算公钥..."
    PRIVATE_KEY=$(jq -r '(.inbounds[] | select(.protocol == "vless")).streamSettings.realitySettings.privateKey // empty' "$CONFIG_FILE" | tr -d ' \r\n')

    if [ -n "$PRIVATE_KEY" ]; then
        PUBLIC_KEY=$(/usr/bin/xray x25519 -i "$PRIVATE_KEY" 2>/dev/null | grep -iE "Public|Password" | head -n 1 | awk '{print $NF}' | tr -d ' \r\n' || true)
    fi

    # 若私钥损坏无法推导，则保底重新生成全新密钥对
    if [ -z "$PUBLIC_KEY" ] || [ $(printf "%s" "$PUBLIC_KEY" | wc -c) -lt 42 ]; then
        echo "==> [Warning] config.json 中未找到有效私钥，自动生成新密钥对..."
        KEY_PAIR=$(/usr/bin/xray x25519)
        PRIVATE_KEY=$(echo "$KEY_PAIR" | grep -i "Private" | head -n 1 | awk '{print $NF}' | tr -d ' \r\n')
        PUBLIC_KEY=$(echo "$KEY_PAIR" | grep -iE "Public|Password" | head -n 1 | awk '{print $NF}' | tr -d ' \r\n')
        TMP_RESET="/tmp/config.resetkey.tmp.json"
        jq --arg privkey "$PRIVATE_KEY" '
            (.inbounds[] | select(.protocol == "vless")) |= (
                .streamSettings.realitySettings.privateKey = $privkey
            )
        ' "$CONFIG_FILE" > "$TMP_RESET" && mv "$TMP_RESET" "$CONFIG_FILE"
    fi
    write_public_key_file "$PUBLIC_KEY"

else
    # 场景 D: 正常启动，读取已有 public_key.txt
    PUBLIC_KEY=$(grep -v '^#' "$PUBLIC_KEY_FILE" | grep -oE '[A-Za-z0-9_-]{43}' | head -n 1 || true)
    PRIVATE_KEY=$(jq -r '(.inbounds[] | select(.protocol == "vless")).streamSettings.realitySettings.privateKey // empty' "$CONFIG_FILE" | tr -d ' \r\n')

    # 防御保护：若文件损坏未提取到公钥，自动重新推导
    if [ -z "$PUBLIC_KEY" ] && [ -n "$PRIVATE_KEY" ]; then
        PUBLIC_KEY=$(/usr/bin/xray x25519 -i "$PRIVATE_KEY" 2>/dev/null | grep -iE "Public|Password" | head -n 1 | awk '{print $NF}' | tr -d ' \r\n' || true)
        write_public_key_file "$PUBLIC_KEY"
    fi
fi

echo "======================================================"
echo "==> [REALITY Key] 服务端私钥已加载于 config.json！"
echo "==> [REALITY Key] 客户端真实配对公钥 (PublicKey): $PUBLIC_KEY"
echo "======================================================"

# 4. ShortId 固化与 UUID
if [ -f "$SHORT_ID_FILE" ] && [ -s "$SHORT_ID_FILE" ]; then
    SHORT_ID=$(cat "$SHORT_ID_FILE" | tr -d ' \r\n')
else
    SHORT_ID=$(openssl rand -hex 8)
    echo "$SHORT_ID" > "$SHORT_ID_FILE"
fi

UUID="${UUID:-$(/usr/bin/xray uuid)}"

# 5. 初始本地 config.json 生成 (精准指定 vless 协议入站)
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
        (.inbounds[] | select(.protocol == "vless")) |= (
            .port = ($port | tonumber) |
            .settings.clients[0].id = $uuid |
            .settings.clients[0].email = "admin@local.host" |
            .streamSettings.realitySettings.dest = $dest |
            .streamSettings.realitySettings.serverNames = $servernames |
            .streamSettings.realitySettings.privateKey = $privkey |
            .streamSettings.realitySettings.shortIds = [$shortid]
        )
        ' > "$TMP_CONFIG"
    [ -s "$TMP_CONFIG" ] && mv "$TMP_CONFIG" "$CONFIG_FILE"
fi

# ================= 6. Xray 守护进程平滑重启架构 =================
XRAY_PID=""

start_xray() {
    /usr/bin/xray run -config "$CONFIG_FILE" &
    XRAY_PID=$!
    echo "==> [Xray 守护] Xray-core 已启动 (PID: $XRAY_PID)"
}

restart_xray() {
    echo "==> [Xray 守护] 检测到配置变动，正在平滑重启 Xray-core..."
    if [ -n "$XRAY_PID" ] && kill -0 "$XRAY_PID" 2>/dev/null; then
        kill -TERM "$XRAY_PID" 2>/dev/null || true
        wait "$XRAY_PID" 2>/dev/null || true
    fi
    start_xray
}

trap 'echo "正在停止服务..."; [ -n "$XRAY_PID" ] && kill -TERM "$XRAY_PID" 2>/dev/null; exit 0' TERM INT

# ================= 7. 运行模式分流 =================

if [ -n "$PANEL_URL" ]; then
    [ -f "$CLIENT_INFO_FILE" ] && rm -f "$CLIENT_INFO_FILE"

    # 基于公网 IP 与端口生成唯一标识，绝不与其它节点冲突
    MACHINE_NODE_ID=$(printf "%s_%s" "$SERVER_IP" "$PORT" | tr -c 'a-zA-Z0-9_' '_')

    if [ -f "$NODE_ID_FILE" ] && [ -s "$NODE_ID_FILE" ]; then
        SAVED_ID=$(cat "$NODE_ID_FILE" | tr -d ' \r\n')
        if [ "$SAVED_ID" != "$MACHINE_NODE_ID" ] && [ "$SERVER_IP" != "127.0.0.1" ]; then
            echo "==> [Node ID 纠偏] 检测到拷贝的历史旧节点标识，自动绑定本机专属 ID: $MACHINE_NODE_ID"
            NODE_ID="$MACHINE_NODE_ID"
            echo "$NODE_ID" > "$NODE_ID_FILE"
            rm -f "$NODE_KEY_FILE"
        else
            NODE_ID="$SAVED_ID"
        fi
    else
        NODE_ID="$MACHINE_NODE_ID"
        echo "$NODE_ID" > "$NODE_ID_FILE"
    fi

    if [ -n "$NODE_KEY" ]; then
        echo "$NODE_KEY" > "$NODE_KEY_FILE"
    elif [ -f "$NODE_KEY_FILE" ] && [ -s "$NODE_KEY_FILE" ]; then
        NODE_KEY=$(cat "$NODE_KEY_FILE" | tr -d ' \r\n')
    else
        NODE_KEY=$(openssl rand -hex 16)
        echo "$NODE_KEY" > "$NODE_KEY_FILE"
    fi

    remote_agent_loop() {
        echo "==> [Cluster Node] 守护进程启动 (主控: $PANEL_URL | 节点ID: $NODE_ID)..."
        sleep 3

        while true; do
            # 动态读取并过滤提取 43 位合法公钥
            if [ -f "$PUBLIC_KEY_FILE" ]; then
                PUBLIC_KEY=$(grep -v '^#' "$PUBLIC_KEY_FILE" | grep -oE '[A-Za-z0-9_-]{43}' | head -n 1 || true)
            fi

            # 1. 向主控上报健康心跳
            HB_RESP=$(curl -k -s -X POST "${PANEL_URL}/api/node/heartbeat" \
                 -H "Content-Type: application/json" \
                 --connect-timeout 8 \
                 --max-time 15 \
                 -d "{\"node_id\": \"$NODE_ID\", \"node_key\": \"$NODE_KEY\", \"ip\": \"$SERVER_IP\", \"port\": $PORT, \"dest\": \"$DEST\", \"sni\": \"$FIRST_SERVER_NAME\", \"server_names\": \"$SERVER_NAMES\", \"pbk\": \"$PUBLIC_KEY\", \"sid\": \"$SHORT_ID\"}" 2>&1 || true)

            NEW_KEY=$(echo "$HB_RESP" | jq -r '.new_node_key // empty' 2>/dev/null || true)
            if [ -n "$NEW_KEY" ]; then
                NODE_KEY="$NEW_KEY"
                echo "$NODE_KEY" > "$NODE_KEY_FILE"
            fi

            # 2. 从主控全量下发用户与网络参数 (以主控后台设定为唯一权威)
            USER_RESP=$(curl -k -s --connect-timeout 8 --max-time 15 "${PANEL_URL}/api/node/sync?node_id=${NODE_ID}&token=${NODE_KEY}" 2>&1 || true)
            if echo "$USER_RESP" | grep -q '"code":200'; then
                REMOTE_USERS=$(echo "$USER_RESP" | jq '.users // []')
                REMOTE_PORT=$(echo "$USER_RESP" | jq -r '.node_config.port // empty')
                REMOTE_DEST=$(echo "$USER_RESP" | jq -r '.node_config.dest // empty')
                REMOTE_SID=$(echo "$USER_RESP" | jq -r '.node_config.sid // empty')
                REMOTE_SNI_ARRAY=$(echo "$USER_RESP" | jq -c '.node_config.server_names // []')

                if [ -n "$REMOTE_SID" ] && [ "$REMOTE_SID" != "$SHORT_ID" ]; then
                    SHORT_ID="$REMOTE_SID"
                    echo "$SHORT_ID" > "$SHORT_ID_FILE"
                fi

                TMP_SYNC="/tmp/config.agent.sync.json"

                # 精准更新 VLESS 协议入站
                jq --argjson new_clients "$REMOTE_USERS" \
                   --arg port "$REMOTE_PORT" \
                   --arg dest "$REMOTE_DEST" \
                   --argjson snis "$REMOTE_SNI_ARRAY" \
                   --arg sid "$SHORT_ID" \
                   '
                   (.inbounds[] | select(.protocol == "vless")) |= (
                       .settings.clients = $new_clients |
                       (if $port != "" then .port = ($port | tonumber) else . end) |
                       (if $dest != "" then .streamSettings.realitySettings.dest = $dest else . end) |
                       (if ($snis | length) > 0 then .streamSettings.realitySettings.serverNames = $snis else . end) |
                       (if $sid != "" then .streamSettings.realitySettings.shortIds = [$sid] else . end)
                   )
                   ' \
                   "$CONFIG_FILE" > "$TMP_SYNC"

                if [ -s "$TMP_SYNC" ]; then
                    if ! cmp -s "$TMP_SYNC" "$CONFIG_FILE"; then
                        mv "$TMP_SYNC" "$CONFIG_FILE"
                        CLIENT_COUNT=$(echo "$REMOTE_USERS" | jq 'length')
                        echo "==> [Cluster Node] 成功应用主控最新配置！(已同步 $CLIENT_COUNT 位用户)"
                        restart_xray
                    else
                        rm -f "$TMP_SYNC"
                    fi
                fi
            fi

            # 3. 统计增量流量回传主控
            TRAFFIC_RAW=$(/usr/bin/xray api statsquery --server=127.0.0.1:10085 -pattern "user>>>" -reset=true 2>/dev/null || true)
            if [ -n "$TRAFFIC_RAW" ] && echo "$TRAFFIC_RAW" | grep -q "stat"; then
                TRAFFIC_PAYLOAD=$(echo "$TRAFFIC_RAW" | jq '[.stat[]? | {email: (.name | split(">>>")[1]), bytes: (.value | tonumber)}]')
                curl -k -s -X POST "${PANEL_URL}/api/node/traffic" \
                     -H "Content-Type: application/json" \
                     --connect-timeout 8 \
                     --max-time 15 \
                     -d "{\"node_id\": \"$NODE_ID\", \"token\": \"$NODE_KEY\", \"traffic\": $TRAFFIC_PAYLOAD}" >/dev/null 2>&1 || true
            fi

            sleep 60
        done
    }

    start_xray
    remote_agent_loop &
    wait $XRAY_PID

else
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

    start_xray
    wait $XRAY_PID
fi