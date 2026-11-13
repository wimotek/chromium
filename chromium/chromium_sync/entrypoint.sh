#!/usr/bin/env bash
set -e

# ==============================================================================
# 阶段 1：Root 权限初始化、/data 权限自愈与宝塔证书安全副本合成 (绝不修改宿主机 /certs)
# ==============================================================================
if [ "$(id -u)" = "0" ]; then
    echo "[Init] (Root阶段) 正在校准 /data 权限与扫描 /certs 证书，随后降权至 hubuser..."
    mkdir -p /data/keys /data/certs /etc/ssl/app

    CERTS_DIR="/certs"
    SSL_OUT_DIR="/etc/ssl/app"
    CERT_FILE=""
    KEY_FILE=""

    for f in "$SSL_CERT_FILE" "$CERTS_DIR"/fullchain*.pem "$CERTS_DIR"/fullchain*.crt "$CERTS_DIR"/fullchain "$CERTS_DIR"/cert*.pem "$CERTS_DIR"/tls.crt "$CERTS_DIR"/*.crt "$CERTS_DIR"/*.pem; do
        if [ -n "$f" ] && [ -f "$f" ] && [ "$f" != "$CERTS_DIR/privkey.pem" ] && [ "$f" != "$CERTS_DIR/key.pem" ]; then
            CERT_FILE="$f"
            break
        fi
    done

    for k in "$SSL_KEY_FILE" "$CERTS_DIR"/privkey*.pem "$CERTS_DIR"/privkey*.key "$CERTS_DIR"/privkey "$CERTS_DIR"/key*.pem "$CERTS_DIR"/tls.key "$CERTS_DIR"/*.key; do
        if [ -n "$k" ] && [ -f "$k" ]; then
            KEY_FILE="$k"
            break
        fi
    done

    if [ -n "$CERT_FILE" ] && [ -n "$KEY_FILE" ]; then
        echo "[SSL] (Root阶段) 成功载入外部域名证书副本 (不触碰宿主机 /certs):"
        echo "       -> 公钥 (Cert): $CERT_FILE"
        echo "       -> 私钥 (Key) : $KEY_FILE"
        cp "$CERT_FILE" "$SSL_OUT_DIR/fullchain.pem"
        cp "$KEY_FILE" "$SSL_OUT_DIR/privkey.pem"
        chmod 644 "$SSL_OUT_DIR/fullchain.pem"
        chmod 600 "$SSL_OUT_DIR/privkey.pem"
    fi

    # 仅调整容器自有目录与证书副本属主，绝对不触碰宿主机 /certs
    chown -R hubuser:hubuser /data "$SSL_OUT_DIR" 2>/dev/null || true

    export HOME=/home/hubuser
    export USER=hubuser
    export LOGNAME=hubuser
    exec gosu hubuser "$@"
fi

# ==============================================================================
# 阶段 2：以非 root 普通用户 hubuser 运行主控服务
# ==============================================================================
exec "$@"
