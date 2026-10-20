# ========================================================
# 超轻量级免配置 Xray-core Reality 容器 Dockerfile (< 18MB)
# 基于 Alpine Linux，体积极致优化，无冗余依赖
# ========================================================
FROM alpine:3.20 AS builder

RUN apk add --no-cache curl unzip

ARG TARGETARCH
ARG XRAY_VERSION=v25.1.30

# 自动适配 amd64 / arm64 架构并提取 xray 二进制
RUN set -ex && \
    ARCH="64" && \
    if [ "$TARGETARCH" = "arm64" ]; then ARCH="arm64-v8a"; fi && \
    curl -sSL -o /tmp/xray.zip https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/Xray-linux-${ARCH}.zip && \
    mkdir -p /app/bin && \
    unzip /tmp/xray.zip xray -d /app/bin/ && \
    chmod +x /app/bin/xray

# 最终运行镜像 (仅含 ca-certificates 与 xray 静态二进制)
FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata bash openssl && \
    mkdir -p /etc/xray /var/log/xray

COPY --from=builder /app/bin/xray /usr/local/bin/xray
COPY entrypoint.sh /entrypoint.sh
COPY config.json /etc/xray/config.json
RUN chmod +x /entrypoint.sh

# 暴露外层 dokodemo 端口 (443) 和内层 reality 端口 (4431)
EXPOSE 443 4431

ENV XRAY_CONFIG_DIR=/etc/xray

VOLUME ["/etc/xray"]

ENTRYPOINT ["/entrypoint.sh"]
