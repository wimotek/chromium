FROM --platform=$TARGETPLATFORM alpine:3.21

ARG TARGETARCH
# 默认为 latest，也可在 build 时通过 --build-arg XRAY_VERSION=v25.1.30 指定固定版本
ARG XRAY_VERSION=latest

LABEL maintainer="Wimotek <i@wimotek.com>"
LABEL description="Optimized Standalone Xray Server with Auto-Update"

RUN apk add --no-cache \
    ca-certificates \
    tzdata \
    jq \
    curl \
    openssl \
    bind-tools

# 根据架构确定下载名称并拉取官方最新 Release
RUN set -ex && \
    case "${TARGETARCH}" in \
        "amd64") XRAY_ARCH="64" ;; \
        "arm64") XRAY_ARCH="arm64-v8a" ;; \
        "arm")   XRAY_ARCH="arm32-v7a" ;; \
        "386")   XRAY_ARCH="32" ;; \
        *) echo "Unsupported target architecture: ${TARGETARCH}" && exit 1 ;; \
    esac && \
    mkdir -p /tmp/xray /usr/share/xray /etc/xray && \
    if [ "${XRAY_VERSION}" = "latest" ]; then \
        DOWNLOAD_URL="https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-${XRAY_ARCH}.zip"; \
    else \
        DOWNLOAD_URL="https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/Xray-linux-${XRAY_ARCH}.zip"; \
    fi && \
    echo "Downloading Xray-core from: ${DOWNLOAD_URL}" && \
    curl -fSL "${DOWNLOAD_URL}" -o /tmp/xray/xray.zip && \
    unzip -q /tmp/xray/xray.zip -d /tmp/xray && \
    mv /tmp/xray/xray /usr/bin/xray && \
    mv /tmp/xray/geosite.dat /usr/share/xray/geosite.dat && \
    mv /tmp/xray/geoip.dat /usr/share/xray/geoip.dat && \
    chmod +x /usr/bin/xray && \
    rm -rf /tmp/xray

ENV XRAY_LOCATION_ASSET=/usr/share/xray \
    TZ=Asia/Shanghai

WORKDIR /root
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY config.template.json /etc/xray/config.template.json

RUN chmod +x /usr/local/bin/entrypoint.sh

# 创建软链接，方便随时使用 update-xray 指令手动更新
RUN ln -s /usr/local/bin/entrypoint.sh /usr/local/bin/update-xray

VOLUME ["/etc/xray"]
EXPOSE 443/tcp 443/udp

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["run", "-config", "/etc/xray/config.json"]
