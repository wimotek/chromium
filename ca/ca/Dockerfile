# syntax=docker/dockerfile:1.7

# -----------------------------------------------------------------------------
# Stage 1: Build Frontend SPA into /src/web/dist
# -----------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:22-alpine AS web-builder

WORKDIR /src/frontend
COPY internal/i18n/locales /src/internal/i18n/locales
COPY frontend/package.json ./
RUN npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# -----------------------------------------------------------------------------
# Stage 2: Build Static CGO_ENABLED=0 Go 1.24 Single Binary
# -----------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS go-builder

ARG TARGETOS=linux
ARG TARGETARCH=amd64

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY cmd/ ./cmd/
COPY internal/ ./internal/
COPY web/embed.go ./web/embed.go
COPY --from=web-builder /src/web/dist ./web/dist

RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /out/wimotek-ca ./cmd/server

# -----------------------------------------------------------------------------
# Stage 3: Minimal Non-Root Runtime Image (UID/GID 10001)
# -----------------------------------------------------------------------------
FROM alpine:3.21 AS runtime

RUN apk add --no-cache ca-certificates tzdata \
    && addgroup -g 10001 -S wimotek \
    && adduser -u 10001 -S -G wimotek -h /data -s /sbin/nologin wimotek \
    && mkdir -p /data /certs \
    && chown -R 10001:10001 /data /certs \
    && chmod 0750 /data \
    && chmod 0755 /certs

COPY --from=go-builder /out/wimotek-ca /usr/local/bin/wimotek-ca

# Safe Production Defaults (Zero-Config Out of the Box)
ENV CA_LISTEN_ADDR=":8443" \
    CA_TLS_ENABLED="true" \
    CA_DATA_DIR="/data" \
    CA_CERTS_DIR="/certs" \
    CA_DB_DRIVER="sqlite" \
    CA_DB_DSN="/data/wimotek-ca.db" \
    CA_ORG_NAME="Wimotek Enterprise" \
    CA_ADMIN_USER="admin" \
    CA_POW_DIFFICULTY="16" \
    CA_NOTIFY_INTERVAL_MIN="60" \
    CA_ALLOW_PRIVATE_WEBHOOKS="false"

WORKDIR /data
VOLUME ["/data"]
EXPOSE 8443

# Strictly Non-Root Execution
USER 10001:10001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --no-check-certificate -qO- https://127.0.0.1:8443/api/health || wget -qO- http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["/usr/local/bin/wimotek-ca"]
