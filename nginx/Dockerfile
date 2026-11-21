# syntax=docker/dockerfile:1.7

# ==============================================================================
# Global Build Arguments — 默认行业对齐 + 自动最新 Nginx 版本 + 可选自定义编译参数
# ==============================================================================
ARG GO_VERSION=1.22
ARG ALPINE_VERSION=3.20

# Nginx 版本号：
#   - latest : 构建期自动从 nginx.org 获取官方最新 Mainline 版本（默认）
#   - stable : 构建期自动获取官方最新 Stable（偶数次版本）版本
#   - x.y.z  : 指定精确版本号（如 1.27.5 / 1.28.0）
ARG NGINX_VERSION=latest

# 可选自定义编译模块开关（默认保持与官方 nginx:alpine 行业基线对齐，按需开启）
ARG ENABLE_GZIP_STATIC=false
ARG ENABLE_BROTLI=false
ARG ENABLE_HEADERS_MORE=false
ARG ENABLE_ZSTD=false

# 任意追加 ./configure 编译参数与 C 优化标志
# 示例：--build-arg NGINX_EXTRA_CONFIGURE_ARGS="--with-http_gzip_static_module --with-debug"
ARG NGINX_EXTRA_CONFIGURE_ARGS=""
ARG NGINX_EXTRA_CFLAGS="-O2 -pipe"
ARG ACME_EMAIL="admin@example.com"

# ==============================================================================
# Stage 1: Go 控制平面微内核编译（静态单二进制，零 CGO 依赖）
# ==============================================================================
FROM golang:${GO_VERSION}-alpine AS go-builder
WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux go build \
    -trimpath \
    -ldflags="-s -w" \
    -o /out/nano-server ./cmd/server

# ==============================================================================
# Stage 2: Nginx 源码定制编译阶段（行业对齐默认模块 + 自定义扩展与编译参数）
# ==============================================================================
FROM alpine:${ALPINE_VERSION} AS nginx-builder

ARG NGINX_VERSION
ARG ENABLE_GZIP_STATIC
ARG ENABLE_BROTLI
ARG ENABLE_HEADERS_MORE
ARG ENABLE_ZSTD
ARG NGINX_EXTRA_CONFIGURE_ARGS
ARG NGINX_EXTRA_CFLAGS

RUN set -eux; \
    BUILD_PKGS="build-base curl linux-headers openssl-dev pcre2-dev zlib-dev"; \
    if [ "${ENABLE_BROTLI}" = "true" ]; then BUILD_PKGS="${BUILD_PKGS} git cmake"; fi; \
    if [ "${ENABLE_HEADERS_MORE}" = "true" ]; then BUILD_PKGS="${BUILD_PKGS} git"; fi; \
    if [ "${ENABLE_ZSTD}" = "true" ]; then BUILD_PKGS="${BUILD_PKGS} git zstd-dev"; fi; \
    apk add --no-cache ${BUILD_PKGS}

WORKDIR /build

# 1. 解析版本号（支持 latest / stable / 指定版本号）并下载官方 Nginx 源码包
RUN set -eux; \
    RESOLVED_VER="${NGINX_VERSION}"; \
    if [ "${RESOLVED_VER}" = "latest" ] || [ -z "${RESOLVED_VER}" ]; then \
      RESOLVED_VER="$(curl -fsSL https://nginx.org/download/ \
        | grep -Eo 'nginx-[0-9]+\.[0-9]+\.[0-9]+\.tar\.gz' \
        | sed -E 's/^nginx-([0-9]+\.[0-9]+\.[0-9]+)\.tar\.gz$/\1/' \
        | sort -V | tail -n 1)"; \
    elif [ "${RESOLVED_VER}" = "stable" ]; then \
      RESOLVED_VER="$(curl -fsSL https://nginx.org/download/ \
        | grep -Eo 'nginx-[0-9]+\.[0-9]*[02468]\.[0-9]+\.tar\.gz' \
        | sed -E 's/^nginx-([0-9]+\.[0-9]+\.[0-9]+)\.tar\.gz$/\1/' \
        | sort -V | tail -n 1)"; \
    fi; \
    test -n "${RESOLVED_VER}"; \
    echo "[INFO] Resolved Nginx source version: ${RESOLVED_VER}"; \
    echo "${RESOLVED_VER}" > /build/nginx_version.txt; \
    curl -fsSL "https://nginx.org/download/nginx-${RESOLVED_VER}.tar.gz" -o nginx.tar.gz; \
    tar -xzf nginx.tar.gz; \
    mv "nginx-${RESOLVED_VER}" nginx-src; \
    mkdir -p /build/modules

# 2. 按需启用自定义模块（gzip_static / brotli / headers-more / zstd）
RUN set -eux; \
    CUSTOM_FLAGS=""; \
    if [ "${ENABLE_GZIP_STATIC}" = "true" ]; then \
      CUSTOM_FLAGS="${CUSTOM_FLAGS} --with-http_gzip_static_module"; \
    fi; \
    if [ "${ENABLE_BROTLI}" = "true" ]; then \
      git clone --depth=1 --recurse-submodules https://github.com/google/ngx_brotli.git /build/modules/ngx_brotli; \
      cd /build/modules/ngx_brotli/deps/brotli && mkdir -p out && cd out && \
      cmake -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DCMAKE_INSTALL_PREFIX=./installed .. && \
      cmake --build . --config Release --target brotlienc -j"$(nproc)"; \
      CUSTOM_FLAGS="${CUSTOM_FLAGS} --add-module=/build/modules/ngx_brotli"; \
    fi; \
    if [ "${ENABLE_HEADERS_MORE}" = "true" ]; then \
      git clone --depth=1 https://github.com/openresty/headers-more-nginx-module.git /build/modules/headers-more; \
      CUSTOM_FLAGS="${CUSTOM_FLAGS} --add-module=/build/modules/headers-more"; \
    fi; \
    if [ "${ENABLE_ZSTD}" = "true" ]; then \
      git clone --depth=1 https://github.com/tokers/zstd-nginx-module.git /build/modules/zstd; \
      CUSTOM_FLAGS="${CUSTOM_FLAGS} --add-module=/build/modules/zstd"; \
    fi; \
    echo "${CUSTOM_FLAGS}" > /build/custom_flags.txt

# 3. 编译 Nginx：默认参数与官方 nginx:alpine 行业基线完全对齐，全面支持 WordPress / Laravel / Nextcloud / 反代等主流应用
RUN set -eux; \
    cd /build/nginx-src; \
    CUSTOM_FLAGS="$(cat /build/custom_flags.txt)"; \
    ./configure \
      --prefix=/etc/nginx \
      --sbin-path=/usr/sbin/nginx \
      --modules-path=/usr/lib/nginx/modules \
      --conf-path=/etc/nginx/nginx.conf \
      --error-log-path=/var/log/nginx/error.log \
      --http-log-path=/var/log/nginx/access.log \
      --pid-path=/run/nginx/nginx.pid \
      --lock-path=/run/nginx/nginx.lock \
      --http-client-body-temp-path=/var/lib/nginx/tmp/client_body \
      --http-proxy-temp-path=/var/lib/nginx/tmp/proxy \
      --http-fastcgi-temp-path=/var/lib/nginx/tmp/fastcgi \
      --http-uwsgi-temp-path=/var/lib/nginx/tmp/uwsgi \
      --http-scgi-temp-path=/var/lib/nginx/tmp/scgi \
      --user=nginx \
      --group=nginx \
      --with-compat \
      --with-threads \
      --with-file-aio \
      --with-pcre-jit \
      --with-http_ssl_module \
      --with-http_v2_module \
      --with-http_v3_module \
      --with-http_realip_module \
      --with-http_addition_module \
      --with-http_sub_module \
      --with-http_dav_module \
      --with-http_flv_module \
      --with-http_mp4_module \
      --with-http_gunzip_module \
      --with-http_random_index_module \
      --with-http_secure_link_module \
      --with-http_stub_status_module \
      --with-http_auth_request_module \
      --with-http_slice_module \
      --with-mail \
      --with-mail_ssl_module \
      --with-stream \
      --with-stream_ssl_module \
      --with-stream_realip_module \
      --with-stream_ssl_preread_module \
      --with-cc-opt="${NGINX_EXTRA_CFLAGS}" \
      ${CUSTOM_FLAGS} \
      ${NGINX_EXTRA_CONFIGURE_ARGS}; \
    make -j"$(nproc)"; \
    make DESTDIR=/rootfs install; \
    strip --strip-unneeded /rootfs/usr/sbin/nginx; \
    cp /build/nginx_version.txt /rootfs/etc/nginx/.nginx-version

# ==============================================================================
# Stage 3: 极简非 Root 生产运行时镜像（无编译器、无数据库、内置 acme.sh 与自愈内核）
# ==============================================================================
FROM alpine:${ALPINE_VERSION} AS runtime

ARG ACME_EMAIL
ARG ENABLE_BROTLI
ARG ENABLE_ZSTD

LABEL org.opencontainers.image.title="Wimotek Nginx" \
      org.opencontainers.image.description="Zero-DB non-root Nginx microkernel aligned with official Alpine defaults, WordPress/PHP-FPM ready, with customizable compile modules (gzip_static, Brotli, Zstd)" \
      org.opencontainers.image.source="https://github.com/wimotek/wimotek"

# 仅安装最小运行时动态库与 ACME 工具依赖
# 将 acme.sh 程序本体安装在只读镜像层 /opt/acme.sh，持久化状态存入 /data/acme，避免宿主机挂载空 /data 目录覆盖脚本
RUN set -eux; \
    RUNTIME_PKGS="pcre2 zlib openssl tzdata ca-certificates libcap curl socat"; \
    if [ "${ENABLE_BROTLI}" = "true" ]; then RUNTIME_PKGS="${RUNTIME_PKGS} libstdc++"; fi; \
    if [ "${ENABLE_ZSTD}" = "true" ]; then RUNTIME_PKGS="${RUNTIME_PKGS} zstd-libs"; fi; \
    apk add --no-cache ${RUNTIME_PKGS}; \
    addgroup -g 101 -S nginx && \
    adduser -S -D -H -u 101 -h /var/lib/nginx -s /sbin/nologin -G nginx nginx; \
    mkdir -p \
      /data/conf.d \
      /data/ssl \
      /data/acme \
      /data/www/acme \
      /data/logs \
      /opt/acme.sh \
      /etc/nginx \
      /var/lib/nginx/tmp/client_body \
      /var/lib/nginx/tmp/proxy \
      /var/lib/nginx/tmp/fastcgi \
      /var/lib/nginx/tmp/uwsgi \
      /var/lib/nginx/tmp/scgi \
      /run/nginx; \
    curl -fsSL https://get.acme.sh | sh -s -- --home /opt/acme.sh --config-home /data/acme --nocron --email "${ACME_EMAIL}"; \
    ln -sf /opt/acme.sh/acme.sh /usr/local/bin/acme.sh

# 从编译阶段复制精简产物（含 fastcgi.conf / fastcgi_params 等主流 PHP/WordPress 依赖配置）
COPY --from=nginx-builder /rootfs/usr/sbin/nginx /usr/sbin/nginx
COPY --from=nginx-builder /rootfs/etc/nginx/mime.types /etc/nginx/mime.types
COPY --from=nginx-builder /rootfs/etc/nginx/fastcgi.conf /etc/nginx/fastcgi.conf
COPY --from=nginx-builder /rootfs/etc/nginx/fastcgi_params /etc/nginx/fastcgi_params
COPY --from=nginx-builder /rootfs/etc/nginx/uwsgi_params /etc/nginx/uwsgi_params
COPY --from=nginx-builder /rootfs/etc/nginx/scgi_params /etc/nginx/scgi_params
COPY --from=nginx-builder /rootfs/etc/nginx/.nginx-version /etc/nginx/.nginx-version
COPY --from=go-builder /out/nano-server /usr/local/bin/nano-server

# 内置默认主配置模板（挂载空 /data 时由 Go 微内核自动拷贝至 /data/nginx.conf）
COPY conf/nginx.conf /etc/nginx/nginx.conf.default
COPY conf/nginx.conf /data/nginx.conf

# 创建标准路径向 /data 的透明软链接，既只需映射单个 /data 卷，又完全兼容引用 /etc/nginx/* 与 /var/www 的历史配置
RUN rm -rf /etc/nginx/conf.d /etc/nginx/ssl /var/www /var/log/nginx && \
    ln -sf /data/nginx.conf /etc/nginx/nginx.conf && \
    ln -s /data/conf.d /etc/nginx/conf.d && \
    ln -s /data/ssl /etc/nginx/ssl && \
    ln -s /data/www /var/www && \
    ln -s /data/logs /var/log/nginx && \
    setcap 'cap_net_bind_service=+ep' /usr/sbin/nginx && \
    setcap 'cap_net_bind_service=+ep' /usr/local/bin/nano-server && \
    chown -R nginx:nginx /data /opt/acme.sh /etc/nginx /var/lib/nginx /run/nginx /usr/local/bin/nano-server && \
    chmod -R 755 /data /opt/acme.sh /run/nginx

ENV HOME=/var/lib/nginx \
    DATA_DIR=/data \
    ACME_SCRIPT_HOME=/opt/acme.sh \
    ACME_HOME=/data/acme \
    ACME_WEBROOT=/data/www/acme \
    NGINX_DIR=/data/conf.d \
    NGINX_MAIN_CONF=/data/nginx.conf \
    NGINX_DEFAULT_CONF=/etc/nginx/nginx.conf.default \
    SSL_DIR=/data/ssl \
    LOG_DIR=/data/logs \
    HTTP_PORT=:8080

USER nginx

# 统一单卷收纳：conf.d / ssl / acme / www / logs / nginx.conf 全部位于 /data
VOLUME ["/data"]
EXPOSE 80 443 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/api/health || exit 1

ENTRYPOINT ["/usr/local/bin/nano-server"]