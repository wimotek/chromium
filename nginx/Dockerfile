# syntax=docker/dockerfile:1.4
FROM golang:1.22-alpine AS builder
WORKDIR /src
COPY . .
RUN if [ ! -f go.mod ]; then go mod init github.com/wimotek/nginx; fi
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /bin/nano-server ./cmd/server

FROM alpine:3.20

# 1. 安装 Nginx、基础证书、特权控制工具 libcap 以及 acme.sh 运行依赖
RUN apk add --no-cache nginx tzdata ca-certificates libcap curl openssl socat && \
    mkdir -p /run/nginx /var/www/html /var/www/acme /etc/nginx/conf.d /etc/nginx/ssl /var/lib/nginx/tmp /var/log/nginx && \
    # 2. 内置安装纯 Shell ACME 客户端（仅多 ~3MB）
    curl https://get.acme.sh | sh -s email=admin@example.com && \
    ln -s /root/.acme.sh/acme.sh /usr/local/bin/acme.sh

COPY --from=builder /bin/nano-server /usr/local/bin/nano-server

# 3. 剥离 Root 特权，赋予绑定 80/443 能力，所有权转移给 nginx 用户
RUN setcap 'cap_net_bind_service=+ep' /usr/sbin/nginx && \
    setcap 'cap_net_bind_service=+ep' /usr/local/bin/nano-server && \
    chown -R nginx:nginx /etc/nginx /var/www /run/nginx /var/log/nginx /var/lib/nginx /usr/local/bin/nano-server /root/.acme.sh && \
    chmod -R 755 /etc/nginx/conf.d /var/www /run/nginx

USER nginx
VOLUME ["/etc/nginx/conf.d", "/etc/nginx/ssl", "/var/www/html", "/root/.acme.sh"]
EXPOSE 80 443 8080

ENTRYPOINT ["/usr/local/bin/nano-server"]