# syntax=docker/dockerfile:1.7

# ==============================================================================
# Stage 1: Build Production Frontend (Pure React + TypeScript + Tailwind CSS)
# ==============================================================================
FROM node:22-alpine AS web-builder
WORKDIR /src/web

COPY web/package.json web/package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

COPY web/ ./
RUN npm run build

# ==============================================================================
# Stage 2: Build Single Static Go Binary with go:embed Frontend
# ==============================================================================
FROM golang:1.24-alpine AS go-builder
WORKDIR /src

RUN apk add --no-cache ca-certificates tzdata

COPY go.mod go.sum* ./
RUN go mod download || true

COPY cmd/ ./cmd/
COPY internal/ ./internal/
COPY --from=web-builder /src/web/dist ./cmd/server/web/dist

ARG TARGETOS=linux
ARG TARGETARCH=amd64
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /out/wimotek-url ./cmd/server

# ==============================================================================
# Stage 3: Minimal Non-Root Production Runtime
# ==============================================================================
FROM alpine:3.21 AS runtime

RUN apk add --no-cache ca-certificates tzdata \
    && addgroup -g 10001 -S wimotek \
    && adduser -u 10001 -S -G wimotek -h /home/wimotek wimotek \
    && mkdir -p /data /data/certs /data/backups /data/audit /certs \
    && chown -R 10001:10001 /data /home/wimotek \
    && chmod 0750 /data \
    && chmod 0755 /certs

COPY --from=go-builder /out/wimotek-url /usr/local/bin/wimotek-url

ENV WIMOTEK_DATA_DIR=/data \
    WIMOTEK_CERTS_DIR=/certs \
    WIMOTEK_HTTP_ADDR=:8080 \
    WIMOTEK_HTTPS_ADDR=:8443

VOLUME ["/data"]
EXPOSE 8080 8443

# Strictly non-root execution (UID/GID 10001).
# /certs may be mounted read-only (:ro) with fullchain.pem & privkey.pem (or fullchain & prikey).
# Ensure host cert files are readable by UID 10001 (e.g., mode 0644 or group 10001).
# If /certs is empty or unmounted, wimotek-url automatically generates self-signed TLS certs in /data/certs.
USER 10001:10001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["/usr/local/bin/wimotek-url"]
