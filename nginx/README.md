# ⚡ Wimotek Nginx

> 极简、现代、零依赖的云原生 Nginx 可视化微内核引擎。体积仅 28MB，告别传统面板数据库及冗余依赖。

[![Docker Pulls](https://img.shields.io/docker/pulls/wimotek/nginx?style=flat-square)](https://hub.docker.com/r/wimotek/nginx)
[![Image Size](https://img.shields.io/docker/image-size/wimotek/nginx/latest?style=flat-square)](https://hub.docker.com/r/wimotek/nginx)
[![License](https://img.shields.io/github/license/wimotek/nginx?style=flat-square)](LICENSE)

---

## 🌟 核心特性

- 🪶 **极致体积**：基于 Alpine Linux 与单静态 Go 二进制，全镜像大小仅 **28MB**，冷启动低于 0.2 秒。
- 🛡️ **安全隔离**：全系统调用直连，杜绝字符串拼接引起的 Shell 注入（RCE）；严格白名单防止路径穿越。
- 🧊 **Zero-DB 架构**：无 SQLite/MySQL 数据库开销，直接管理原生 `.conf` 配置文件，GitOps 高度友好。
- 📱 **现代响应式 UI**：内嵌暗色拟态 Web 界面，完美适配手机移动端与桌面大屏。
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