#!/bin/bash
set -e

CONFIG_FILE="/etc/xray/config.json"

echo "========================================================"
echo "  ⚡ Xray Zero-Config Container Starting...            "
echo "========================================================"

# 若不存在配置文件，则执行免配置自动初始化
if [ ! -f "$CONFIG_FILE" ]; then
    echo "[!] 未检测到配置文件，正在自动生成高强度免配置参数..."

    # 1. 自动生成客户端 UUID
    UUID=$(xray uuid)
    echo "[+] 自动生成租户 UUID: $UUID"

    # 2. 自动生成 X25519 密钥对
    X25519_OUTPUT=$(xray x25519)
    PRIV_KEY=$(echo "$X25519_OUTPUT" | grep -i "Private key" | awk -F ': ' '{print $2}' | tr -d ' \r\n')
    PUB_KEY=$(echo "$X25519_OUTPUT" | grep -i "Public key" | awk -F ': ' '{print $2}' | tr -d ' \r\n')
    
    if [ -z "$PRIV_KEY" ]; then
        PRIV_KEY="mH2_R_vj5cdsdTcGW1X7hSOh03RUwO4ufXLk0JQffAw"
        PUB_KEY="uMHXUmaq0myzdh3SGjzdlSvzdAY3uStNKspuoFDuCGo"
    fi

    # 3. 自动生成 16 进制 Short ID
    SHORT_ID=$(openssl rand -hex 8)
    echo "[+] 自动生成 Short ID: $SHORT_ID"

    # 4. 生成双层 dokodemo 443 + reality 4431 配置
    mkdir -p /etc/xray
    cat <<EOF > "$CONFIG_FILE"
{
  "log": {
    "loglevel": "info"
  },
  "inbounds": [
    {
      "tag": "dokodemo-in",
      "port": 443,
      "protocol": "dokodemo-door",
      "settings": {
        "address": "0.0.0.0",
        "port": 4431,
        "network": "tcp"
      },
      "sniffing": {
        "enabled": true,
        "destOverride": ["tls"],
        "routeOnly": true
      }
    },
    {
      "listen": "0.0.0.0",
      "port": 4431,
      "protocol": "vless",
      "settings": {
        "clients": [
          {
            "id": "$UUID",
            "flow": "xtls-rprx-vision",
            "email": "admin@xray.node"
          }
        ],
        "decryption": "none"
      },
      "streamSettings": {
        "network": "tcp",
        "security": "reality",
        "realitySettings": {
          "dest": "www.samsung.com:443",
          "serverNames": [
            "www.samsung.com"
          ],
          "privateKey": "$PRIV_KEY",
          "shortIds": [
            "",
            "$SHORT_ID"
          ]
        }
      },
      "sniffing": {
        "enabled": true,
        "destOverride": ["http", "tls", "quic"],
        "routeOnly": true
      }
    }
  ],
  "outbounds": [
    {
      "protocol": "freedom",
      "tag": "direct"
    },
    {
      "protocol": "blackhole",
      "tag": "block"
    }
  ],
  "routing": {
    "rules": [
      {
        "inboundTag": ["dokodemo-in"],
        "domain": ["www.samsung.com"],
        "outboundTag": "direct"
      },
      {
        "inboundTag": ["dokodemo-in"],
        "outboundTag": "block"
      }
    ]
  }
}
EOF

    echo "========================================================"
    echo "🎉 免配置初始化完成！默认管理员节点连接信息:"
    SERVER_IP=$(curl -s https://api.ipify.org || echo "YOUR_SERVER_IP")
    echo "VLESS Reality 链接:"
    echo "vless://$UUID@$SERVER_IP:443?security=reality&encryption=none&pbk=$PUB_KEY&headerType=none&type=tcp&flow=xtls-rprx-vision&sni=www.samsung.com&sid=$SHORT_ID&fp=chrome#Xray-Reality-Default"
    echo "========================================================"
else
    echo "[✓] 检测到现有配置文件: $CONFIG_FILE"
fi

# 启动 Xray 核心代理
echo "[*] 启动 Xray-core 守护进程..."
exec /usr/local/bin/xray run -config "$CONFIG_FILE"
