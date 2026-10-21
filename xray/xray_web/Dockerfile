# Stage 1: 编译 Vue 3 静态前端
FROM node:20-alpine AS frontend-builder
WORKDIR /build
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# Stage 2: 组装 Alpine 轻量运行环境
FROM alpine:3.21

ARG TARGETARCH
ARG XRAY_VERSION=latest

LABEL maintainer="Wimotek <i@wimotek.com>"
LABEL description="Xray REALITY with Vue 3 and FastAPI Web Management"

# 安装基础依赖与 Python 异步运行时 (兼容 Alpine 官方包名)
RUN apk add --no-cache \
    ca-certificates tzdata jq curl openssl bind-tools \
    python3 py3-pip && \
    (apk add --no-cache py3-fastapi uvicorn || pip install --no-cache-dir --break-system-packages fastapi "uvicorn[standard]")

# 拉取官方指定/最新 Xray 核心
RUN set -ex && \
    case "${TARGETARCH}" in \
        "amd64") XRAY_ARCH="64" ;; \
        "arm64") XRAY_ARCH="arm64-v8a" ;; \
        "arm")   XRAY_ARCH="arm32-v7a" ;; \
        "386")   XRAY_ARCH="32" ;; \
        *) echo "Unsupported target architecture: ${TARGETARCH}" && exit 1 ;; \
    esac && \
    mkdir -p /tmp/xray /usr/share/xray /etc/xray /app/backend/static && \
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

WORKDIR /app
COPY backend/ /app/backend/
# 从构建阶段拷入编译好的静态前端
COPY --from=frontend-builder /build/dist/ /app/backend/static/
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY config.template.json /etc/xray/config.template.json

RUN chmod +x /usr/local/bin/entrypoint.sh
RUN ln -s /usr/local/bin/entrypoint.sh /usr/local/bin/update-xray

VOLUME ["/etc/xray"]
EXPOSE 443/tcp 443/udp 8080/tcp

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]