#!/usr/bin/env bash
set -e

SERVE_FRONTEND_RAW="$(printf '%s' "${HUB_SERVE_FRONTEND:-true}" | tr '[:upper:]' '[:lower:]' | xargs)"

# ==============================================================================
# 阶段 1：Root 权限初始化与 /data 权限自愈
# 前后端分离模式 (HUB_SERVE_FRONTEND=false) 下跳过 TLS 证书处理，后端以明文 HTTP/WS 运行
# ==============================================================================
if [ "$(id -u)" = "0" ]; then
    echo "[Init] (Root阶段) 正在校准 /data 权限，随后降权至 hubuser..."
    mkdir -p /data/keys

    case "$SERVE_FRONTEND_RAW" in
        0|false|no|off)
            echo "[Init] HUB_SERVE_FRONTEND=$SERVE_FRONTEND_RAW（前后端分离），跳过证书处理，后端仅运行 HTTP/WS"
            ;;
        *)
            mkdir -p /data/certs /etc/ssl/app
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
                echo "[SSL] (Root阶段) 载入 /certs 证书副本:"
                echo "       -> Cert: $CERT_FILE"
                echo "       -> Key : $KEY_FILE"
                cp "$CERT_FILE" "$SSL_OUT_DIR/fullchain.pem"
                cp "$KEY_FILE" "$SSL_OUT_DIR/privkey.pem"
                chmod 644 "$SSL_OUT_DIR/fullchain.pem"
                chmod 600 "$SSL_OUT_DIR/privkey.pem"
            elif [ ! -s "$SSL_OUT_DIR/fullchain.pem" ] || [ ! -s "$SSL_OUT_DIR/privkey.pem" ]; then
                if [ -s "/data/certs/fullchain.pem" ] && [ -s "/data/certs/privkey.pem" ]; then
                    cp /data/certs/fullchain.pem "$SSL_OUT_DIR/fullchain.pem"
                    cp /data/certs/privkey.pem "$SSL_OUT_DIR/privkey.pem"
                    chmod 644 "$SSL_OUT_DIR/fullchain.pem"
                    chmod 600 "$SSL_OUT_DIR/privkey.pem"
                elif command -v openssl >/dev/null 2>&1; then
                    echo "[SSL] (Root阶段) 未挂载 /certs，生成自签证书至 $SSL_OUT_DIR..."
                    openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
                        -keyout "$SSL_OUT_DIR/privkey.pem" \
                        -out "$SSL_OUT_DIR/fullchain.pem" \
                        -subj "/CN=localhost" >/dev/null 2>&1 || true
                    chmod 644 "$SSL_OUT_DIR/fullchain.pem" 2>/dev/null || true
                    chmod 600 "$SSL_OUT_DIR/privkey.pem" 2>/dev/null || true
                fi
            fi
            chown -R hubuser:hubuser "$SSL_OUT_DIR" 2>/dev/null || true
            ;;
    esac

    chown -R hubuser:hubuser /data 2>/dev/null || true
    export HOME=/home/hubuser
    export USER=hubuser
    export LOGNAME=hubuser
    exec gosu hubuser "$@"
fi

exec "$@"
