# =========================================================================
# Stage 1: 提取时区数据 (保留完整全球时区数据库，支持后续任意动态切换)
# =========================================================================
FROM alpine:3.21 AS tz-builder
RUN apk add --no-cache tzdata

# =========================================================================
# Stage 2: 下载并提取最新官方 Xray 核心与路由规则数据
# =========================================================================
FROM alpine:3.21 AS xray-builder
ARG TARGETARCH
ARG XRAY_VERSION=latest

RUN set -ex && \
    apk add --no-cache curl unzip && \
    case "${TARGETARCH}" in \
        "amd64") XRAY_ARCH="64" ;; \
        "arm64") XRAY_ARCH="arm64-v8a" ;; \
        "arm")   XRAY_ARCH="arm32-v7a" ;; \
        "386")   XRAY_ARCH="32" ;; \
        *) echo "Unsupported target architecture: ${TARGETARCH}" && exit 1 ;; \
    esac && \
    mkdir -p /out/usr/bin /out/usr/share/xray && \
    if [ "${XRAY_VERSION}" = "latest" ] || [ -z "${XRAY_VERSION}" ]; then \
        DOWNLOAD_URL="https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-${XRAY_ARCH}.zip"; \
    else \
        TAG_VER="${XRAY_VERSION}"; \
        case "$TAG_VER" in v*) ;; *) TAG_VER="v${TAG_VER}" ;; esac; \
        DOWNLOAD_URL="https://github.com/XTLS/Xray-core/releases/download/${TAG_VER}/Xray-linux-${XRAY_ARCH}.zip"; \
    fi && \
    curl -fSL "${DOWNLOAD_URL}" -o /tmp/xray.zip && \
    unzip -q /tmp/xray.zip -d /tmp/xray && \
    mv /tmp/xray/xray /out/usr/bin/xray && \
    chmod 755 /out/usr/bin/xray && \
    mv /tmp/xray/geosite.dat /out/usr/share/xray/geosite.dat && \
    mv /tmp/xray/geoip.dat /out/usr/share/xray/geoip.dat && \
    rm -rf /tmp/xray*

# =========================================================================
# Stage 3: 最小化非 root 运行时镜像 (含 dumb-init 完整信号链与防崩溃保障)
# =========================================================================
FROM alpine:3.21

LABEL maintainer="Wimotek <i@Wimotek.com>"
LABEL description="Xray REALITY Core (Headless, Slim & Non-Root Multi-Stage)"

# 安装轻量运行时依赖：dumb-init 处理进程信号链、ca-certificates、openssl、libcap、Python 运行环境
RUN apk add --no-cache \
    dumb-init \
    ca-certificates \
    openssl \
    libcap \
    python3 \
    py3-websockets

# 环境变量：
# 1. PYTHONUNBUFFERED=1 保证 Python stdout/stderr 实时直通 docker logs
# 2. PYTHONDONTWRITEBYTECODE=1 禁止生成 .pyc，适配只读层
# 3. TZ=Asia/Shanghai 设置默认时区，用户运行时通过 -e TZ=任意时区 即可动态覆盖生效
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    XRAY_LOCATION_ASSET=/usr/share/xray \
    TZ=Asia/Shanghai

# 从 Stage 1 复制完整全球时区数据库，并创建默认软链接 (无需 /etc/timezone 文本残留)
COPY --from=tz-builder /usr/share/zoneinfo /usr/share/zoneinfo
RUN ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime

# 从 Stage 2 复制 Xray 二进制与规则数据
COPY --from=xray-builder /out/usr/bin/xray /usr/bin/xray
COPY --from=xray-builder /out/usr/share/xray /usr/share/xray

# 创建专用非 root 用户 (UID 10001: appuser)，并赋予 Xray 低特权绑定 443 端口权限
RUN addgroup -g 10001 appgroup && \
    adduser -u 10001 -G appgroup -s /bin/sh -D appuser && \
    setcap 'cap_net_bind_service=+ep' /usr/bin/xray

# 显式创建各持久化挂载与运行目录并授予 appuser 所有权，避免未挂载数据卷时启动即报错
RUN mkdir -p /app /etc/xray /data /tmp && \
    chown -R appuser:appgroup /etc/xray /data /app /tmp && \
    chmod 775 /data /tmp

# 工作目录设为根目录 /，代码统一放入唯一的 /app 模块目录 (纯净单层无嵌套)
WORKDIR /

# 复制 Python 守护代码包到 /app (唯一目录) 与配置模板
COPY --chown=appuser:appgroup app/ /app/
COPY --chown=appuser:appgroup config.template.json /etc/xray/config.template.json

# 显式切换为非 root 用户运行
USER appuser

# 外部持久化数据卷与暴露端口
VOLUME ["/data"]
EXPOSE 443/tcp 443/udp

# 完整信号链：dumb-init (PID 1) -> Python (SIGTERM 优雅捕获) -> Xray (Popen 安全终止)
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["python3", "-m", "app"]