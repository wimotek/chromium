# Wimotek Nginx

> 零数据库、与官方行业基线对齐、默认自动追踪最新 Nginx 版本并支持自由定制编译参数的云原生 Nginx 可视化微内核引擎。

[![Docker Pulls](https://img.shields.io/docker/pulls/wimotek/nginx?style=flat-square)](https://hub.docker.com/r/wimotek/nginx)
[![Image Size](https://img.shields.io/docker/image-size/wimotek/nginx/latest?style=flat-square)](https://hub.docker.com/r/wimotek/nginx)
[![License](https://img.shields.io/github/license/wimotek/nginx?style=flat-square)](LICENSE)

---

## 核心架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Wimotek Nginx Container (UID 101)                    │
│                                                                         │
│  ┌──────────────────────────┐        ┌───────────────────────────────┐  │
│  │  Go PID 1 Microkernel    │        │  Official-Aligned Nginx       │  │
│  │  - Zombie Reaper (SIGCHLD)│◄──────►│  - Auto-Latest nginx.org src  │  │
│  │  - Watchdog Auto-Restart │        │  - HTTP/2, HTTP/3, Stream,    │  │
│  │  - Atomic Save + Rollback│        │    DAV/MP4/FLV, FastCGI Ready │  │
│  │  - 12h ACME Auto-Renew   │        │  - Opt-in gzip_static/Brotli  │  │
│  │  - Embedded Web Console  │        │  - CAP_NET_BIND_SERVICE       │  │
│  └────────────┬─────────────┘        └──────────────┬────────────────┘  │
│               │                                     │                   │
│               ▼                                     ▼                   │
│          统一持久化数据卷 /data (conf.d / ssl / acme / www / logs / nginx.conf)
└─────────────────────────────────────────────────────────────────────────┘
```

### 关键特性

- **单卷极简挂载 (`VOLUME ["/data"]`)**：所有持久化数据统一收纳于 `/data`，部署仅需映射一个目录（`- ./data:/data`）。首次挂载空目录时，Go 微内核自动初始化子目录与默认 `/data/nginx.conf`；`acme.sh` 脚本本体留在镜像只读层 `/opt/acme.sh`，数据存入 `/data/acme`，彻底避免挂载空卷导致脚本丢失；同时内置 `/etc/nginx/*` 与 `/var/www` 软链接向下兼容历史配置。
- **自动追踪最新 Nginx 版本与版本号镜像标签**：
  - `Dockerfile` 默认 `ARG NGINX_VERSION=latest`，构建期自动从 `nginx.org/download/` 解析官方最新 Mainline 版本（同样支持 `stable` 自动取官方最新稳定版，或锁定精确版本号如 `1.27.5`）。
  - GitHub Actions 推送至 Docker Hub 与 GHCR 时自动携带解析后的版本号标签：`:latest`、`:<x.y.z>`、`:<x.y>`、`:<x.y.z>-alpine`（手动自定义构建还可通过 `tag_suffix` 生成如 `:1.27.5-gzip-static` 专属标签）。
- **默认编译参数与行业基线对齐，开箱兼容主流应用**：
  - 默认 `./configure` 参数与官方 `nginx:alpine` 标准对齐（内置 SSL/HTTP2/HTTP3、RealIP、DAV、MP4/FLV、Gunzip、Auth Request、Secure Link、Stub Status、Slice、Stream 四层代理与 Mail 代理等）。
  - 默认 `nginx.conf` 预置 `fastcgi.conf`、`fastcgi_buffers` 防 502 调优、`client_max_body_size 64m` 与 WebSocket `$connection_upgrade` 映射，Web 控制台内置 **WordPress 安全加固模板**、**反向代理 (WS)**、**静态 / SPA** 与 **Laravel / PHP-FPM** 模板，开箱适配 WordPress、WooCommerce、Laravel、Nextcloud、Typecho 与容器反代。
- **自定义编译参数与按需扩展（如 `gzip_static`）**：
  - 将 `gzip_static`（`--with-http_gzip_static_module`）、`ngx_brotli`、`headers-more`、`zstd` 全部收口为清晰的可选构建参数，并支持 `NGINX_EXTRA_CONFIGURE_ARGS` 自由追加任意 `./configure` 参数。
- **原子事务校验与自动回滚**：站点配置及全局 `/data/nginx.conf` 保存前加互斥锁写入真实目标路径并执行 `nginx -t`，语法错误立即自动恢复旧版本，支持在线干跑预检与一键启用/停用（`.conf` ⇄ `.conf.disabled`）。
- **全屏响应式 Web 控制台**：基于 `100dvh` 全视口自适应排版（桌面双栏分屏 / 平板与移动端抽屉导航 + 上下自适应编辑区），支持浅色/深色双主题切换。

---

## 统一 `/data` 目录结构

容器仅暴露单一持久化卷 `/data`，宿主机目录一览无余，备份与迁移只需打包一个文件夹：

```text
/data/
├── nginx.conf      # 全局主配置（空卷首次启动自动从默认模板生成）
├── conf.d/         # 虚拟主机站点配置 (*.conf / *.conf.disabled)
├── ssl/            # 签发部署的 TLS 证书与私钥 (*.crt / *.key)
├── acme/           # acme.sh 账户与自动续签状态数据
├── www/            # 站点静态文件 / WordPress 代码根目录（含 www/acme 验证目录）
└── logs/           # Nginx access.log 与 error.log
```

---

## 默认内置与自定义编译参数

### 1. 默认编译模块（与官方 `nginx:alpine` 行业标准对齐）

| 类别 | 默认开启模块 |
| --- | --- |
| 协议与安全 | `--with-http_ssl_module` `--with-http_v2_module` `--with-http_v3_module` `--with-http_auth_request_module` `--with-http_secure_link_module` |
| 路由与主流应用 | `--with-http_realip_module` `--with-http_addition_module` `--with-http_sub_module` `--with-http_dav_module` `--with-http_flv_module` `--with-http_mp4_module` `--with-http_gunzip_module` `--with-http_random_index_module` `--with-http_stub_status_module` `--with-http_slice_module` |
| 四层与邮件转发 | `--with-stream` `--with-stream_ssl_module` `--with-stream_realip_module` `--with-stream_ssl_preread_module` `--with-mail` `--with-mail_ssl_module` |
| 底层性能 | `--with-compat` `--with-threads` `--with-file-aio` `--with-pcre-jit` |

### 2. 自定义编译参数（按需通过 `--build-arg` 开启）

| 构建参数 | 默认值 | 说明 |
| --- | --- | --- |
| `NGINX_VERSION` | `latest` | `latest` 自动拉取官方最新版；`stable` 拉取官方稳定版；或指定具体版本如 `1.27.5` |
| `ENABLE_GZIP_STATIC` | `false` | 设为 `true` 开启 `--with-http_gzip_static_module`（`.gz` 预压缩直出） |
| `ENABLE_BROTLI` | `false` | 设为 `true` 编译 Google `ngx_brotli`（`.br` 静态/动态压缩） |
| `ENABLE_HEADERS_MORE` | `false` | 设为 `true` 编译 `headers-more-nginx-module` |
| `ENABLE_ZSTD` | `false` | 设为 `true` 编译 `zstd-nginx-module`（Zstandard 压缩） |
| `NGINX_EXTRA_CONFIGURE_ARGS` | `""` | 透传任意官方 `./configure` 参数（如 `--with-debug`、`--without-http_autoindex_module`） |
| `NGINX_EXTRA_CFLAGS` | `"-O2 -pipe"` | 自定义 C 编译器优化参数 |

---

## 自定义编译构建示例

### 1. 默认构建（自动拉取最新 Nginx + 官方行业对齐模块）

```bash
docker build -t wimotek/nginx:latest ./nginx
```

### 2. 自定义开启 `gzip_static` 与 `Brotli`（适合高流量静态站点 / SPA）

```bash
docker build -t wimotek/nginx:gzip-static \
  --build-arg NGINX_VERSION=latest \
  --build-arg ENABLE_GZIP_STATIC=true \
  --build-arg ENABLE_BROTLI=true \
  ./nginx
```

### 3. 指定稳定版 + 追加任意自定义编译参数

```bash
docker build -t wimotek/nginx:stable-custom \
  --build-arg NGINX_VERSION=stable \
  --build-arg ENABLE_GZIP_STATIC=true \
  --build-arg ENABLE_HEADERS_MORE=true \
  --build-arg NGINX_EXTRA_CONFIGURE_ARGS="--with-debug --without-http_autoindex_module" \
  --build-arg NGINX_EXTRA_CFLAGS="-O3 -pipe" \
  ./nginx
```

---

## 极速启动与 WordPress 主流应用示例 (`docker-compose.yml`)

> 提示：容器以非特权 `UID 101` 运行；若使用宿主机绑定目录 `./data:/data`，首次启动前建议执行一次 `mkdir -p ./data && chown -R 101:101 ./data`（若改用 Docker 命名卷 `nginx_data:/data` 则自动继承权限）。

```yaml
services:
  nginx:
    image: wimotek/nginx:latest
    container_name: wimotek-nginx
    restart: always
    environment:
      - ADMIN_USER=admin
      - ADMIN_PASS=ChangeMeStrongPassword2026
      - AUTH_TOKEN=change-me-random-32-byte-token
      - ACME_RENEW_HOURS=12
      - TZ=Asia/Shanghai
    ports:
      - "80:80"
      - "443:443/tcp"
      - "443:443/udp" # HTTP/3 QUIC
      - "8080:8080"   # Web 管理面板端口（建议仅内网或通过反代暴露）
    volumes:
      - ./data:/data  # 单卷统一收纳 conf.d / ssl / acme / www / logs / nginx.conf
    networks:
      - web-net

  # WordPress / Laravel 通用 PHP-FPM 容器（启动后在控制台选「WordPress」模板即可一键生效）
  php83:
    image: wordpress:php8.3-fpm-alpine
    container_name: php83
    restart: unless-stopped
    environment:
      - WORDPRESS_DB_HOST=db:3306
      - WORDPRESS_DB_USER=wordpress
      - WORDPRESS_DB_PASSWORD=ChangeMeDbPass2026
      - WORDPRESS_DB_NAME=wordpress
    volumes:
      - ./data/www/wp.example.com:/var/www/html
    networks:
      - web-net

  db:
    image: mariadb:11
    container_name: wp-mariadb
    restart: unless-stopped
    environment:
      - MARIADB_ROOT_PASSWORD=ChangeMeRootPass2026
      - MARIADB_DATABASE=wordpress
      - MARIADB_USER=wordpress
      - MARIADB_PASSWORD=ChangeMeDbPass2026
    volumes:
      - ./db-data:/var/lib/mysql
    networks:
      - web-net

networks:
  web-net:
    driver: bridge
```

---

## 环境变量说明

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `DATA_DIR` | `/data` | 统一持久化数据根目录（自动派生下方各子目录） |
| `ADMIN_USER` | `admin` | Web 控制台管理员用户名 |
| `ADMIN_PASS` | 自动随机生成 | Web 控制台登录密码（未配置时启动日志打印一次性随机密码） |
| `AUTH_TOKEN` | 自动随机生成 | API `Authorization: Bearer` / `X-Auth-Token` 凭证 |
| `HTTP_PORT` | `8080` | Web 控制台与管理 API 监听端口 |
| `NGINX_DIR` | `/data/conf.d` | 站点配置文件目录 |
| `NGINX_MAIN_CONF` | `/data/nginx.conf` | Nginx 全局主配置文件路径 |
| `SSL_DIR` | `/data/ssl` | TLS 证书与私钥存储目录 |
| `ACME_HOME` | `/data/acme` | `acme.sh` 持久化账户与续期状态目录 |
| `ACME_WEBROOT` | `/data/www/acme` | HTTP-01 验证根目录 |
| `LOG_DIR` | `/data/logs` | Nginx 访问与错误日志目录 |
| `AUTH_FILE` | `/data/.auth.json` | 后台修改用户名/密码后的 PBKDF2-HMAC-SHA256 持久化文件路径（`0600` 权限） |
| `TRUST_PROXY` | `false` | 仅当部署在可信反代后方时设为 `true`，允许按 `X-Forwarded-For` / `X-Real-IP` 识别客户端防刷 IP |
| `RESET_ADMIN_AUTH` | `false` | 设为 `true` 启动时强制按环境变量重新初始化管理员账号密码（用于忘记密码找回） |
| `MCP_ENABLED` | `false` | 设为 `true` 开启原生 MCP Streamable HTTP 端点（`/mcp`，亦可在后台管理「MCP / Agent」页热开关） |
| `MCP_READ_ONLY` | `false` | 设为 `true` 将 MCP 限制为只读模式（仅暴露查询与 `test_site_config` 干跑工具，服务端拦截所有写入/删除/签发调用） |
| `MCP_TOKEN` | 复用 `AUTH_TOKEN` | 为 AI Agent 单独签发的 MCP 专用 Bearer Token（推荐与管理面板 `AUTH_TOKEN` 隔离） |
| `MCP_FILE` | `/data/.mcp.json` | 后台修改 MCP 开关、只读策略与独立 Token 的持久化文件路径（`0600` 权限，重启保留） |
| `ACME_RENEW_HOURS` | `12` | Go 内置证书自动续签检查间隔（小时） |

---

## 原生 MCP (Model Context Protocol) 与 Agent 对接

Go 微内核已内置零第三方依赖的标准 **MCP Streamable HTTP (`2025-03-26`, JSON-RPC 2.0)** 服务端，端点固定为 `/mcp`。支持通过 **Web 后台管理「MCP / Agent」页面热开关与一键生成独立 Token**（自动持久化至 `/data/.mcp.json`，无需重启容器），也支持环境变量初始化。Cursor、Claude Desktop、Dify、OpenAI Agents 等任意兼容客户端均可直连。

### 1. 开启 MCP（后台热开关 或 环境变量）

```yaml
environment:
  - MCP_ENABLED=true
  - MCP_READ_ONLY=false          # 仅做巡检排障时建议设为 true
  - MCP_TOKEN=replace-with-dedicated-32-byte-agent-token
```

### 2. AI 客户端接入配置（Cursor / Claude / Dify 通用）

```json
{
  "mcpServers": {
    "wimotek-nginx": {
      "type": "streamable-http",
      "url": "http://<your-host>:8080/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_TOKEN>"
      }
    }
  }
}
```

### 3. 快速连通性测试 (`curl`)

```bash
# 1) 握手协商
curl -sS -X POST http://127.0.0.1:8080/mcp \
  -H "Authorization: Bearer <MCP_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'

# 2) 拉取可用工具清单
curl -sS -X POST http://127.0.0.1:8080/mcp \
  -H "Authorization: Bearer <MCP_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

### 4. 内置 Tools 与 Resources

- **只读与干跑 Tools（`MCP_READ_ONLY=true` 下可用）**：`nginx_health`、`nginx_system_info`、`list_sites`、`get_site_config`、`get_main_config`、`list_certs`、`test_site_config`
- **受原子回滚保护的变更 Tools（写模式可用）**：`save_site_config`、`toggle_site`、`delete_site`、`save_main_config`、`reload_nginx`、`issue_ssl_cert`（全部受 `nginx -t` 原子事务回滚与 DNS 白名单约束）
- **Resources**：`nginx://system/info`、`nginx://config/main`、`nginx://sites`、`nginx://certs`、模板 `nginx://sites/{domain}`
- **安全边界**：默认关闭（未开启返回 `404`）；鉴权使用恒定时间比对；若请求带浏览器 `Origin` 头则校验同源以防跨站重绑定；永不暴露管理员账号密码修改接口与 SSL 私钥内容。

---

## 管理 API 概览

所有受保护接口支持 `Authorization: Bearer <AUTH_TOKEN>` 或 `X-Auth-Token: <AUTH_TOKEN>` 鉴权：

- `GET /api/health` — 容器健康探针（检测 Nginx Master PID 存活状态）
- `GET /api/auth/challenge` — 签发一次性防机器人挑战（扭曲 SVG 图形验证码 + 动态难度 SHA-256 PoW）
- `POST /api/login` — 账号密码或 Token 登录（校验 SVG 验证码、PoW 算力证明、蜜罐、停留时延与多级 IP 指数锁定）
- `GET /api/account` — 获取当前管理员信息、持久化状态与防刷安全盾实时统计
- `POST /api/account/credentials` — 校验当前密码并更新管理员用户名/密码（PBKDF2-HMAC-SHA256 持久化并自动轮换会话 Token）
- `GET /api/system/info` — 获取 Nginx 版本、`nginx -V` 模块矩阵与运行汇总
- `GET /api/sites` — 获取全部站点及元数据（启用状态、模式、端口、SSL、`gzip_static`）
- `GET / POST / DELETE /api/site` — 读取、原子校验保存（失败自动回滚）、删除站点配置
- `POST /api/site/test` — 干跑预检配置语法（不落盘）
- `POST /api/site/toggle` — 启用或停用指定站点（校验失败自动恢复）
- `GET / POST /api/nginx-conf` — 读取与事务保存全局 `/etc/nginx/nginx.conf`
- `POST /api/reload` — 语法校验通过后执行 `nginx -s reload` 零停机热重载
- `GET /api/certs` — 扫描 `/etc/nginx/ssl/*.crt` 返回 X.509 颁发者、SANs 与剩余天数
- `POST /api/ssl/issue` — 通过 HTTP-01 或白名单 DNS-01（支持泛域名）签发 Let's Encrypt / ZeroSSL 证书
- `GET / POST /api/mcp/config` — 读取与动态修改 MCP 开关、只读模式与独立 Token（实时生效并持久化至 `/data/.mcp.json`）
- `POST /mcp` — 原生 MCP Streamable HTTP (`2025-03-26`, JSON-RPC 2.0) 服务端（开启后生效）