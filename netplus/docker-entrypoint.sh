#!/bin/sh
set -eu

DATA_DIR="${DATA_DIR:-/data}"
TLS_CERT_DIR="${TLS_CERT_DIR:-/certs}"
STAGED_CERT_DIR="/tmp/netpulse-certs"

mkdir -p "$DATA_DIR" "$DATA_DIR/certs"

# If running as root (container startup), ensure /data ownership and safely stage
# read-only Baota/BT certificates from /certs:ro even when privkey.pem is 0600 root:root.
if [ "$(id -u)" = "0" ]; then
  chown -R netpulse:netpulse "$DATA_DIR" || true
  chmod 700 "$DATA_DIR/certs" || true

  if [ -d "$TLS_CERT_DIR" ]; then
    rm -rf "$STAGED_CERT_DIR"
    mkdir -p "$STAGED_CERT_DIR"

    # Support Baota (fullchain.pem / privkey.pem) and standard (cert.pem / key.pem)
    CERT_SRC=""
    KEY_SRC=""
    if [ -n "${TLS_CERT_FILE:-}" ] && [ -f "$TLS_CERT_FILE" ]; then
      CERT_SRC="$TLS_CERT_FILE"
    elif [ -f "$TLS_CERT_DIR/fullchain.pem" ]; then
      CERT_SRC="$TLS_CERT_DIR/fullchain.pem"
    elif [ -f "$TLS_CERT_DIR/cert.pem" ]; then
      CERT_SRC="$TLS_CERT_DIR/cert.pem"
    fi

    if [ -n "${TLS_KEY_FILE:-}" ] && [ -f "$TLS_KEY_FILE" ]; then
      KEY_SRC="$TLS_KEY_FILE"
    elif [ -f "$TLS_CERT_DIR/privkey.pem" ]; then
      KEY_SRC="$TLS_CERT_DIR/privkey.pem"
    elif [ -f "$TLS_CERT_DIR/key.pem" ]; then
      KEY_SRC="$TLS_CERT_DIR/key.pem"
    fi

    if [ -n "$CERT_SRC" ] && [ -n "$KEY_SRC" ]; then
      cp -L "$CERT_SRC" "$STAGED_CERT_DIR/fullchain.pem"
      cp -L "$KEY_SRC" "$STAGED_CERT_DIR/privkey.pem"
      chown -R netpulse:netpulse "$STAGED_CERT_DIR"
      chmod 700 "$STAGED_CERT_DIR"
      chmod 644 "$STAGED_CERT_DIR/fullchain.pem"
      chmod 600 "$STAGED_CERT_DIR/privkey.pem"
      export TLS_STAGED_DIR="$STAGED_CERT_DIR"
    fi
  fi

  exec su-exec netpulse:netpulse "$@"
fi

exec "$@"
