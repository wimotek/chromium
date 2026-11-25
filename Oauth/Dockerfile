# syntax=docker/dockerfile:1.7

# ==============================================================================
# Stage 1: Build Modern React + TypeScript + Tailwind Frontend
# ==============================================================================
FROM node:22-alpine AS web-builder
WORKDIR /src/web

COPY web/package.json web/package-lock.json* ./
RUN if [ -f package-lock.json ]; then \
      npm ci --no-audit --no-fund --legacy-peer-deps; \
    else \
      npm install --no-audit --no-fund --legacy-peer-deps; \
    fi

COPY web/ ./
RUN npm run build

# ==============================================================================
# Stage 2: Build Single Static Go Binary with Embedded Web Assets (go:embed)
# ==============================================================================
FROM golang:1.23-alpine AS go-builder
WORKDIR /src

RUN apk add --no-cache git ca-certificates tzdata

COPY go.mod go.sum* ./
COPY cmd/ ./cmd/
COPY internal/ ./internal/
COPY web/embed.go ./web/embed.go
COPY --from=web-builder /src/web/dist ./web/dist

ARG TARGETOS=linux
ARG TARGETARCH=amd64

RUN go mod tidy && \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /out/wimotek-oauth ./cmd/server

# ==============================================================================
# Stage 3: Minimal Non-Root Production Runtime Image
# ==============================================================================
FROM alpine:3.21 AS runtime

RUN apk add --no-cache ca-certificates tzdata && \
    addgroup -g 1000 -S wimotek && \
    adduser -u 1000 -S -G wimotek -h /app -s /sbin/nologin wimotek && \
    mkdir -p /app /data /certs && \
    chown -R 1000:1000 /app /data && \
    chmod 0750 /data

WORKDIR /app

COPY --from=go-builder --chown=1000:1000 /out/wimotek-oauth /app/wimotek-oauth

# Non-root UID/GID (1000:1000)
USER 1000:1000

ENV WIMOTEK_HTTP_ADDR=":8080" \
    WIMOTEK_HTTPS_ADDR=":8443" \
    WIMOTEK_DATA_DIR="/data" \
    WIMOTEK_CERTS_DIR="/certs"

VOLUME ["/data"]
EXPOSE 8080 8443

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

ENTRYPOINT ["/app/wimotek-oauth"]