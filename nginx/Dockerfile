# ---- 阶段 1: 静态构建 Go 控制器 ----
FROM golang:1.22-alpine AS builder
WORKDIR /src

COPY . .

# 利用缓存加速模块拉取
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download || true

COPY . .

# 核心效率优化：挂载编译器缓存目录，二次构建即使换架构也是增量编译
# 禁用 CGO，使用 ldflags 彻底去除调试符号与 DWARF
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /bin/nano-server ./cmd/server

# ---- 阶段 2: 最终极致轻量镜像 ----
FROM alpine:3.20

# 纯安装 Nginx 及必要时区，清理一切包管理缓存
RUN apk add --no-cache nginx tzdata ca-certificates && \
    mkdir -p /run/nginx /var/www/html /etc/nginx/conf.d

# 复制仅 8MB 的单一纯静态二进制
COPY --from=builder /bin/nano-server /usr/local/bin/nano-server

# 容器数据卷挂载点
VOLUME ["/etc/nginx/conf.d", "/etc/nginx/ssl", "/var/www/html"]

EXPOSE 80 443 8080

# 具备内置健康检查探针
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/ || exit 1

ENTRYPOINT ["/usr/local/bin/nano-server"]