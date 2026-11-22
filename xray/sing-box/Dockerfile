# =========================================================================
# Stage 1: 提取时区数据 (保留完整全球时区数据库，支持运行时动态切换)
# =========================================================================
FROM alpine:3.21 AS tz-builder
RUN apk add --no-cache tzdata

# =========================================================================
# Stage 2: 源码带全特性标签交叉编译 sing-box (with_quic + with_v2ray_api) 与 sb-helper
# 使用 --platform=$BUILDPLATFORM 实现原生 Go 交叉编译，大幅加速多架构构建
# =========================================================================
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS singbox-builder
ARG TARGETOS=linux
ARG TARGETARCH
ARG SINGBOX_VERSION=latest
ENV GOTOOLCHAIN=local

RUN apk add --no-cache git curl jq

WORKDIR /src
RUN set -ex && \
    if [ "${SINGBOX_VERSION}" = "latest" ] || [ -z "${SINGBOX_VERSION}" ]; then \
        TAG_VER=$(curl -sSL https://api.github.com/repos/SagerNet/sing-box/releases/latest | jq -r .tag_name); \
        if [ -z "${TAG_VER}" ] || [ "${TAG_VER}" = "null" ]; then \
            TAG_VER=$(curl -sSI https://github.com/SagerNet/sing-box/releases/latest | grep -i "^location:" | sed -n 's/.*tag\/\([^\r\n]*\).*/\1/p' | tr -d '\r\n'); \
        fi; \
    else \
        case "${SINGBOX_VERSION}" in \
            v*) TAG_VER="${SINGBOX_VERSION}" ;; \
            *)  TAG_VER="v${SINGBOX_VERSION}" ;; \
        esac; \
    fi && \
    if [ -z "${TAG_VER}" ] || [ "${TAG_VER}" = "v" ]; then \
        echo "ERROR: Failed to resolve sing-box version tag" >&2 && exit 1; \
    fi && \
    BUILD_OS="${TARGETOS:-linux}" && \
    BUILD_ARCH="${TARGETARCH:-$(go env GOARCH)}" && \
    echo "==> Building sing-box ${TAG_VER} for ${BUILD_OS}/${BUILD_ARCH} ($(go version))" && \
    git clone --depth 1 --branch "${TAG_VER}" https://github.com/SagerNet/sing-box.git /src/sing-box && \
    cd /src/sing-box && \
    mkdir -p /out/usr/bin && \
    VERSION_NUM="${TAG_VER#v}" && \
    BUILD_TAGS="with_quic,with_grpc,with_dhcp,with_wireguard,with_utls,with_acme,with_clash_api,with_v2ray_api" && \
    LDFLAGS_SHARED="" && \
    if [ -f release/LDFLAGS ]; then \
        LDFLAGS_SHARED="$(cat release/LDFLAGS)"; \
    fi && \
    case "${LDFLAGS_SHARED}" in \
        *checklinkname=0*) BUILD_TAGS="${BUILD_TAGS},badlinkname,tfogo_checklinkname0" ;; \
    esac && \
    CGO_ENABLED=0 GOOS="${BUILD_OS}" GOARCH="${BUILD_ARCH}" \
    go build -v -trimpath \
        -tags "${BUILD_TAGS}" \
        -ldflags "-X github.com/sagernet/sing-box/constant.Version=${VERSION_NUM} ${LDFLAGS_SHARED} -s -w -buildid=" \
        -o /out/usr/bin/sing-box ./cmd/sing-box && \
    chmod 755 /out/usr/bin/sing-box

# 编译零外部依赖的 Go 1.26 工具 sb-helper (v2ray_api gRPC 流量采集 / ECDSA 自签证书 / X25519 公钥推导)
COPY tools/sb_helper/ /src/sb_helper/
RUN set -ex && \
    cd /src/sb_helper && \
    go mod init sb-helper && \
    BUILD_OS="${TARGETOS:-linux}" && \
    BUILD_ARCH="${TARGETARCH:-$(go env GOARCH)}" && \
    CGO_ENABLED=0 GOOS="${BUILD_OS}" GOARCH="${BUILD_ARCH}" \
    go build -trimpath -ldflags "-s -w -buildid=" -o /out/usr/bin/sb-helper . && \
    chmod 755 /out/usr/bin/sb-helper

# 预置与 Xray-core (Loyalsoldier/v2ray-rules-dat) 同源的 CN 二进制规则集 (geoip-cn.srs + geosite-cn.srs)
RUN set -ex && \
    mkdir -p /out/usr/share/sing-box/rule-set && \
    curl -fsSL https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geoip/cn.srs \
        -o /out/usr/share/sing-box/rule-set/geoip-cn.srs && \
    curl -fsSL https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/cn.srs \
        -o /out/usr/share/sing-box/rule-set/geosite-cn.srs && \
    chmod 644 /out/usr/share/sing-box/rule-set/*.srs

# =========================================================================
# Stage 3: 最小化非 root 运行时镜像 (含 dumb-init 完整信号链与防崩溃保障)
# =========================================================================
FROM alpine:3.21

LABEL maintainer="Wimotek <i@Wimotek.com>"
LABEL description="Sing-box Dual-Protocol Edge Core (VLESS-REALITY + Hysteria2, Non-Root & Slim)"

# 与 xray_core 对齐的极简运行时依赖（免 openssl CLI，免 geosite/geoip 大文件）
RUN apk add --no-cache \
    dumb-init \
    ca-certificates \
    libcap \
    python3 \
    py3-websockets

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TZ=Asia/Shanghai

# 从 Stage 1 复制完整全球时区数据库
COPY --from=tz-builder /usr/share/zoneinfo /usr/share/zoneinfo
RUN ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime

# 从 Stage 2 复制带 v2ray_api + quic 标签的 sing-box、sb-helper 与精简 CN 规则集
COPY --from=singbox-builder /out/usr/bin/sing-box /usr/bin/sing-box
COPY --from=singbox-builder /out/usr/bin/sb-helper /usr/bin/sb-helper
COPY --from=singbox-builder /out/usr/share/sing-box /usr/share/sing-box

# 创建专用非 root 用户 (UID 10001: appuser)，并赋予 sing-box 与 Python 低特权绑定 443 端口权限
RUN addgroup -g 10001 appgroup && \
    adduser -u 10001 -G appgroup -s /bin/sh -D appuser && \
    setcap 'cap_net_bind_service=+ep' /usr/bin/sing-box && \
    setcap 'cap_net_bind_service=+ep' $(readlink -f /usr/bin/python3)

# 显式创建持久化与配置目录并授予 appuser 权限
RUN mkdir -p /app /etc/sing-box /data /tmp && \
    chown -R appuser:appgroup /etc/sing-box /data /app /tmp && \
    chmod 775 /data /tmp

WORKDIR /

# 复制 Python 守护代码包到 /app 与配置模板
COPY --chown=appuser:appgroup app/ /app/
COPY --chown=appuser:appgroup config.template.json /etc/sing-box/config.template.json

USER appuser

VOLUME ["/data"]
EXPOSE 443/tcp 443/udp

# 容器健康检查：探测仅回环暴露的 127.0.0.1:${HEALTH_PORT:-10087}/healthz
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["python3", "-m", "app.health"]

# 完整信号链：dumb-init (PID 1) -> Python (SIGTERM 优雅捕获) -> sing-box (Popen 安全终止)
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["python3", "-m", "app"]
