FROM --platform=$TARGETPLATFORM alpine:3.21

ARG TARGETARCH
ARG XRAY_VERSION=latest

LABEL maintainer="Wimotek <i@Wimotek.com>"
LABEL description="Xray REALITY Core (Headless & Slim)"

# 安装必要系统工具
RUN apk add --no-cache \
    ca-certificates tzdata jq curl openssl bind-tools

# 拉取官方核心
RUN set -ex && \
    case "${TARGETARCH}" in \
        "amd64") XRAY_ARCH="64" ;; \
        "arm64") XRAY_ARCH="arm64-v8a" ;; \
        "arm")   XRAY_ARCH="arm32-v7a" ;; \
        "386")   XRAY_ARCH="32" ;; \
        *) echo "Unsupported target architecture: ${TARGETARCH}" && exit 1 ;; \
    esac && \
    mkdir -p /tmp/xray /usr/share/xray /etc/xray /data && \
    if [ "${XRAY_VERSION}" = "latest" ] || [ -z "${XRAY_VERSION}" ]; then \
        DOWNLOAD_URL="https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-${XRAY_ARCH}.zip"; \
    else \
        TAG_VER="${XRAY_VERSION}"; \
        case "$TAG_VER" in v*) ;; *) TAG_VER="v${TAG_VER}" ;; esac; \
        DOWNLOAD_URL="https://github.com/XTLS/Xray-core/releases/download/${TAG_VER}/Xray-linux-${XRAY_ARCH}.zip"; \
    fi && \
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

# 模板文件保持在原生位置 /etc/xray/ 不动
COPY config.template.json /etc/xray/config.template.json

RUN chmod +x /usr/local/bin/entrypoint.sh
RUN ln -s /usr/local/bin/entrypoint.sh /usr/local/bin/update-xray

# 外部持久化卷统一指定为 /data
VOLUME ["/data"]
EXPOSE 443/tcp 443/udp

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]