# ⚡ Wimotek Nginx

> 极简、现代、零依赖的云原生 Nginx 可视化微内核引擎。体积仅 32MB，告别传统面板数据库及冗余依赖。

[![Docker Pulls](https://img.shields.io/docker/pulls/wimotek/nginx?style=flat-square)](https://hub.docker.com/r/wimotek/nginx)
[![Image Size](https://img.shields.io/docker/image-size/wimotek/nginx/latest?style=flat-square)](https://hub.docker.com/r/wimotek/nginx)
[![License](https://img.shields.io/github/license/wimotek/nginx?style=flat-square)](LICENSE)

---

## 🌟 核心特性

- 🪶 **极致体积**：基于 Alpine Linux 与单一静态 Go 二进制，全镜像大小仅 **32MB**，冷启动低于 0.2 秒。
- 🔒 **非 Root 安全基线**：以非特权 `nginx (UID 101)` 用户运行，通过 Linux Capabilities 机制安全监听 80/443 特权端口，杜绝容器提权。
- 📜 **ACME 自动化证书管理**：集成纯 Shell 架构 `acme.sh`，支持 Let's Encrypt / ZeroSSL 证书一键申请，60 天静默全自动续签与热重载。
- 🐕 **看门狗自愈守护**：Go 内置 Watchdog，Nginx 遭遇异常崩溃或 OOM 时 1 秒内自动拉起，保障高可用。
- 🧹 **原生 PID 1 僵尸回收**：底层内核系统调用非阻塞回收孤儿子进程，告别第三方外挂包装。
- 🧊 **Zero-DB 架构**：无任何 SQLite/MySQL 数据库开销，直接管理原生 `.conf` 配置文件，GitOps 高度友好。
- 🔄 **动态 PHP 解耦**：通过 Docker Compose 随时按需拉取 PHP-FPM 多版本，毫秒级切换。

---

## 🚀 极速启动 (`docker-compose.yml`)

```yaml
version: '3.8'

services:
  nginx:
    image: wimotek/nginx:latest
    container_name: wimotek-nginx
    restart: always
    environment:
      - ADMIN_USER=admin
      - ADMIN_PASS=YourSecretPassword2026
      - AUTH_TOKEN=custom-secret-token-key
      - TZ=Asia/Shanghai
    ports:
      - "80:80"
      - "443:443"
      - "8080:8080" # Web 管理面板端口
    volumes:
      - ./vhosts:/etc/nginx/conf.d
      - ./ssl:/etc/nginx/ssl
      - ./www:/var/www/html
      - ./acme:/root/.acme.sh       # 持久化 ACME 证书与续期任务
    networks:
      - web-net

  # 纯动态轻量 PHP-FPM（按需启用）
  php83:
    image: php:8.3-fpm-alpine
    container_name: php83
    restart: unless-stopped
    volumes:
      - ./www:/var/www/html
    networks:
      - web-net

networks:
  web-net:
    driver: bridge