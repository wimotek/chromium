# Xray Reality 分布式多节点管理中枢 (Xray-Web & Xray-Core)

基于 **Xray-core (VLESS-REALITY-Vision / WSS 反向打洞隧道)** 打造的高性能分布式节点管理与商业化运营中枢。

系统采用 **Master-Agent（主控中心 - 边缘工作节点）彻底解耦架构**：
* **`xray_web` (主控端)**：轻量化 Web 管理面板（**Cython 原生 `.so` 二进制闭源编译 + `python:3.11-slim` 预编译轮子多阶段构建 + `dumb-init + gosu` Root-Init-Drop 安全降权架构**，业务层以非 Root `UID 10001` 运行，Granian 原生支持 IPv4+IPv6 双栈 HTTPS，支持自由修改 `WEB_PORT` 与 `-p 3000:8443` 端口映射智能识别），内置官方 **`wimotek-edge-agent >= 1.0.17`** 零信任安全引擎，负责用户生命周期、数据库备份恢复、卡密核销、邮件通知、聚合订阅下发、单次防重放 Join Token 签发与审计流水；
* **`xray_core` (节点端)**：极致精简的纯 Python 异步守护镜像（Alpine 多阶段构建 + 非 Root `UID 10001` + `dumb-init` 信号链 + 仅回环 `/healthz` 健康探针），部署于任意海外 VPS 或家庭内网主机，专注高速 REALITY 代理与反向穿透。

---

## 🌟 核心特性

- 🌐 **IPv4 + IPv6 双栈控制面板 & 节点双模自适应**：
  - **主控双栈监听**：Granian 启动时自动探测内核 IPv6 双栈能力（`::` 且 `IPV6_V6ONLY=0`），开箱同时监听 IPv4 与 IPv6（支持 `WEB_HOST` 手动覆写）；
  - **公网直连节点 (`direct`)**：默认启用原生 `TCP + VLESS-REALITY-Vision`，无任何废弃 WebSocket 警告，抗封锁性能优异；
  - **NAT4 / 封端口反穿节点 (`reverse_wss`)**：本地回环采用纯 TCP 桥接，节点 Python 守护进程主动向 Hub 建立 WSS 反向长连接，免公网 IP、免端口映射。
- 🐍 **主控端原生集成官方 PyPI 模块 `wimotek-edge-agent >= 1.0.17`**：
  - **主动双栈 TCP 拨测裁决 (`detect_network_mode_sync`)**：节点上报公网 IPv4 / IPv6 与端口后，Hub 端主动并发 TCP 拨测连通性，精准裁决 `direct_dual` / `direct_ipv4` / `direct_ipv6` / `reverse_tunnel`，端口被墙或处于 NAT4 自动下发 `reverse_wss` 热切换；
  - **40 字符单次防重放令牌 (`JoinTokenIssuer / Verifier`)**：14 字节随机 ID + 16 字节 HMAC-SHA256 签名，核销后原子作废防重放劫持；
  - **零信任 `TrustStore` 与结构化审计 (`AuditLogger`)**：统一记录 JSONL 安全审计流水，支持 **10MB 自动切割轮转与归档**，提供 `/api/node/edge_agent/*` 原生管理端点。
- 🛡️ **TOFU (Trust-On-First-Use) 首次准入与隔离区**：
  - 具备 **TOFU 首次信任总开关** 与 **免审自动准入子开关**；
  - 未知新节点接入自动进入【待审隔离区】，经管理员审批或携带有效令牌验证后方可生效；
  - 通信密钥 `node_key` 自动握手固化，支持后台一键轮换与心跳热更新。
- 🔄 **聚合订阅地址自动透明分流**：
  - 用户只需导入一个聚合订阅地址（`/api/sub?token=用户UUID`）；
  - Hub 自动根据节点状态下发 REALITY 链接或 Hub 域名 WSS 链接。
- 🗄️ **SQLAlchemy 2.0 原生双数据库引擎（SQLite WAL + MySQL InnoDB）与首次运行安装向导**：
  - **首次运行 Web 安装向导 (`SetupWizard`)**：全新部署首次打开面板时，无需手工翻日志查随机密码或反复改环境变量，通过 3 步可视化向导即可完成 **SQLite / MySQL 切换与连通性测试**、**Redis 加速开启与 PING 探测**、**对外入口 (`PUBLIC_URL`/`PUBLIC_PORT`/`APP_MODE`)** 及 **管理员初始账密与 `cluster_token` 初始化**；配置自动持久化至 `/data/hub_config.json` 并热同步至所有 Worker 进程，完成后自动锁定向导接口；
  - **双数据库无缝切换**：全面基于 SQLAlchemy 2.0 ORM 重构，单机零配置默认使用 **SQLite (WAL)**，高并发集群可一键接入 **外置 MySQL / MariaDB (`PyMySQL` + `utf8mb4` + 连接池保活)**；
  - **双引擎热备份与跨库迁移**：SQLite 模式支持原生 `.db` 在线无锁热备与 `PRAGMA integrity_check`；MySQL 模式支持 **事务级 JSON 逻辑快照 (`.json`)** 导出与一键还原（并兼容跨库导入迁移）。
- 💳 **多种套餐计费、发卡 API**：
  - 支持固定流量包、每月固定重置卡（邮件/微信清零推送）、无限量/永久卡及第三方发卡网 API（兼容独角数卡）。

---

## 🔒 非 Root 运行、宝塔证书零侵入挂载与 Root-Init-Drop (`dumb-init + gosu`) 架构

为遵循容器最小权限安全规范，**`xray_web` 与 `xray_core` 业务主进程均以非特权用户 `appuser`（UID `10001` / GID `10001`）运行**。

### 1. 主控端 (`xray_web`) 如何完美解决“非 Root + 宝塔证书 `0600`”权限冲突？

宝塔面板 / Certbot 签发的证书目录（如 `/www/server/panel/vhost/cert/你的域名`）中，私钥 `privkey.pem` 在宿主机默认归属 `root:root` 且权限为 `0600`。如果容器启动时直接切为 `USER appuser (10001)`，容器将因 `PermissionError` 无法读取 `/certs:ro/privkey.pem`；而如果强行修改宿主机宝塔目录属主，又会影响宝塔面板或 Nginx 自动续签。

为此，`xray_web` 采用工业标准的 **Root-Init-Drop（`dumb-init` + `gosu`）两阶段安全降权架构**：
1. **阶段 1 · Root-Init（启动瞬时初始化）**：
   - 容器由 `dumb-init`（PID 1）引导 `entrypoint.sh` 短暂以 `root` 身份完成初始化；
   - 自动创建并修复 `/data`、`/data/backups`、`/app/certs` 的属主为 `10001:10001`（**即使宿主机忘记提前 `chown` `./data` 也能正常启动**）；
   - 由 `cert_init` 读取只读挂载 `/certs:ro` 中的宝塔证书与 `0600` 私钥，安全复制到容器内部隔离目录 `/app/certs/`，将其属主设为 `appuser:appgroup`（`10001:10001`）、权限收口为 `0644`（证书）/ `0600`（私钥），**全程绝不修改宿主机 `/certs:ro` 原文件权限，宝塔续签零干扰**；
2. **阶段 2 · Drop（不可逆降权运行）**：
   - 初始化完成后，`entrypoint.sh` 通过 `exec gosu appuser:appgroup granian ...` **彻底放弃 root 权限并替换进程**，整个 Granian Web 服务、Flask 路由、SQLite、定时备份与邮件线程 **100% 运行在非特权 `appuser (10001)` 沙箱下**；
   - 同时镜像已为 `python3` 写入 `cap_net_bind_service=+ep`，即使用户将 `-e WEB_PORT=443` 设为特权端口，降权后依然可直接监听 `443`。

> **宝塔证书直接挂载示例**：
> ```yaml
> volumes:
>   - ./data:/data
>   - /www/server/panel/vhost/cert/你的域名:/certs:ro
> ```
> *(宝塔自动续签更新宿主机证书后，重启一次 `xray-web` 容器即可自动重新同步最新证书。)*

### 2. 节点端 (`xray_core`) 宿主机目录授权

`xray_core` 为极致无状态边缘代理容器，直接以 `USER appuser`（`10001`）启动，启动前需提前创建并授权 `./data` 目录（或改用 Docker 命名卷 `xray_node_data:/data`）：

```bash
mkdir -p ./data
chown -R 10001:10001 ./data
```

> **提示**：请勿为节点容器添加 `--security-opt=no-new-privileges:true`，以免屏蔽 `/usr/bin/xray` 上的 `cap_net_bind_service=+ep` 导致无法绑定 443 端口。

---

## 🌐 对外端口自定义与端口映射智能处理（如 `-p 3000:8443`）

系统默认容器内部监听 **`WEB_PORT=8443`**（HTTPS TLS），支持**任意修改对外端口**或使用 **宿主机端口映射**：

| 部署场景 | 配置示例 | 系统自动判断与处理机制 |
| :--- | :--- | :--- |
| **默认双栈直通** | `network_mode: host`，默认 `WEB_PORT=8443` | 监听 `[::]:8443`，`HEALTHCHECK` 探测 `127.0.0.1:8443/healthz`，订阅/部署命令自动使用 `:8443` |
| **修改容器内部端口** | `network_mode: host` + `-e WEB_PORT=9443` | Granian 监听 `[::]:9443`，`HEALTHCHECK` 动态读取 `${WEB_PORT}` 探测 `127.0.0.1:9443/healthz` |
| **宿主机端口映射** | `-p 3000:8443`（容器内保持 `WEB_PORT=8443`） | 容器内部健康检查仍探测 `8443` 不失效；后端通过 `ProxyFix` + `resolve_public_endpoint` 自动识别请求 `Host` 头或 `X-Forwarded-Port` 中的对外端口 **`3000`**，自动将管理端生成的 `PANEL_URL`、聚合订阅 `sub_url` 与 `reverse_wss` 节点链接全部对齐为 `:3000`！ |
| **反代 / NAT 隐藏端口** | Nginx/Cloudflare 443 反代至 `8443`，或穿透映射 `3000:8443` | 自动读取 `X-Forwarded-Host` / `X-Forwarded-Port`；若上游未透传对外端口，可显式追加 `-e PUBLIC_PORT=3000` 或 `-e PUBLIC_URL=https://panel.example.com:3000` 强制锁定 |

> **端口映射示例 (`docker run -p 3000:8443`)**：
> ```bash
> docker run -d --name xray-web-master --restart unless-stopped \
>   -p 3000:8443 \
>   -v $(pwd)/data:/data \
>   -v /www/server/panel/vhost/cert/你的域名:/certs:ro \
>   xray-web:latest
> ```
> 访问 `https://你的域名:3000` 后，面板生成的节点接入命令、`PANEL_URL`、订阅地址及 WSS 反穿端口将自动全部切换为 `3000`。

---

## 🚀 部署指南

### 第一步：部署 `xray_web` 主控端

> 建议部署在连接性良好的 Linux VPS（主控默认监听 `[::]:8443` 双栈原生 HTTPS TLS；若需 443 端口承接 WSS 反穿，可通过 Nginx/Caddy 反代或直接 `-e WEB_PORT=443`）。

1. **克隆项目并准备目录**：
   ```bash
   git clone https://github.com/wimotek/chromium.git
   cd chromium/xray/xray_web
   mkdir -p ./data/backups ./certs
   ```

2. **检查或修改 `docker-compose.yml`**：
   ```yaml
   services:
     xray-web:
       build:
         context: .
         dockerfile: Dockerfile
       image: xray-web:latest
       container_name: xray-web-master
       restart: unless-stopped
       network_mode: "host"
       # 若改用端口映射（如 3000:8443），可注释 network_mode: "host" 并取消下面注释：
       # ports:
       #   - "3000:8443"
       environment:
         - TZ=Asia/Shanghai
         - APP_MODE=all
         - WEB_PORT=8443
         # - PUBLIC_PORT=3000                     # 可选：显式指定对外映射端口
         # 可选：手动强制监听地址 (默认留空则自动探测 IPv4+IPv6 双栈 "::"，禁用 IPv6 环境自动回退 "0.0.0.0")
         # - WEB_HOST=::
         - NODE_KEY=xray_cluster_secret_key_2026   # 集群通信引导令牌 (可自定义)
       volumes:
         - ./data:/data
         - ./data/backups:/data/backups
         # 可直接挂载宝塔证书目录（Root-Init-Drop 自动兼容 0600 私钥权限）
         # - /www/server/panel/vhost/cert/你的域名:/certs:ro
         - ./certs:/certs:ro
   ```

3. **启动主控容器**：
   ```bash
   docker compose up -d --build
   ```

4. **首次运行安装向导 & 登录主控面板**：
   - IPv4 访问：`https://<主控IPv4>:8443`
   - IPv6 访问：`https://[<主控IPv6>]:8443`
   - **全新实例**：首次打开页面将自动进入 **3 步可视化安装向导**，支持直接在线配置数据库引擎（SQLite / MySQL 连通测试）、可选 Redis（PING 测试）、对外入口 URL/端口、初始管理员账号密码、集群引导令牌 `cluster_token` 与 TOFU 策略（若需自动化静默跳过向导，可传入 `-e AUTO_SKIP_SETUP=true`）。
   - **已有旧集群升级**：系统检测到已有节点或历史数据时自动跳过安装向导，原账密与业务零中断；
   - **使用外置 MySQL（也可通过向导填写或提前在环境变量指定）**：
     ```yaml
     environment:
       - DB_TYPE=mysql
       - MYSQL_HOST=127.0.0.1
       - MYSQL_PORT=3306
       - MYSQL_USER=xray_web
       - MYSQL_PASSWORD=your_strong_password
       - MYSQL_DATABASE=xray_web
     ```
   - 登录后台后，可在【系统发信与全局运维配置】中配置发件 SMTP 邮箱、节点通信密钥、热备份策略与系统公告。

---

### 第二步：在任意节点 VPS / 家宽主机接入 `xray_core`

节点镜像采用三阶段非 Root 构建与纯 Python 异步看门狗架构（`python3 -m app`），执行前确保已对宿主机 `./data` 授权 UID `10001`：

```bash
# 1. 创建并授权持久化数据目录 (非 root UID 10001 必需)
mkdir -p ./data && chown -R 10001:10001 ./data

# 2. 启动节点并接入主控
docker run -d \
  --name xray-node \
  --restart always \
  --network host \
  -e TZ="Asia/Shanghai" \
  -e PANEL_URL="https://<主控服务器IP>:8443" \
  -e CLUSTER_TOKEN="xray_cluster_secret_key_2026" \
  -e NET_MODE="auto" \
  -e PORT=443 \
  -e DEST="www.microsoft.com:443" \
  -e SERVER_NAMES="www.microsoft.com,microsoft.com" \
  -v $(pwd)/data:/data \
  ghcr.io/wimotek/xray:latest
```

#### 节点常用环境变量说明：
| 变量名 | 说明 | 默认值 / 示例 |
| :--- | :--- | :--- |
| `PANEL_URL` | **[必填]** 主控 `xray_web` 的访问地址 | `https://1.2.3.4:8443` |
| `CLUSTER_TOKEN` | **[必填]** 集群引导令牌或主控签发的 40 字符单次 Join Token | `xray_cluster_secret_key_2026` |
| `NET_MODE` | 网络模式：`auto`（上报双栈 IP 由 Hub 主动拨测裁决）、`direct`（强制直连）、`reverse_wss`（强制反穿） | `auto` |
| `PORT` | 节点 Reality 监听端口 | `443` |
| `DEST` | 伪装目标回落地址 | `www.microsoft.com:443` |
| `SERVER_NAMES` | 伪装域名列表 (逗号分隔) | `www.microsoft.com,microsoft.com` |
| `TZ` | 节点容器时区（支持运行时动态覆盖） | `Asia/Shanghai` |

> **公网主机但 443 端口被封的场景**：若家宽虽有公网 IP 但运营商封锁 80/443 入站，请在节点启动参数中显式设置 `-e NET_MODE="reverse_wss"`，或在主控面板直接下发切换至反穿模式。

---

## ⚡ 可选 Redis 加速与 SQL Cache 自动回退机制

主控内建统一缓存抽象层（`core/cache.py`，基于 SQLAlchemy 2.0 兼容 SQLite 与 MySQL），遵循 **“Redis 优先 + 熔断降级 + SQL Cache 自动回退”**：
1. **零配置默认模式**：未配置 `REDIS_URL` / `REDIS_HOST` 时，自动使用当前主库（SQLite 或 MySQL）中的 `kv_cache` 共享表（多 Worker 进程同步，支持 TTL 过期与定时清理），单容器零外部依赖开箱即用；
2. **开启 Redis 加速**：可通过首次安装向导开启或传入 `-e REDIS_URL="redis://[:密码@]主机:6379/0"`（或拆分 `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` / `REDIS_DB`），自动接管图形验证码、IP 防爆破限流、邮箱验证码、全局 `system_settings` 读取、`/api/node/sync` 活跃用户快照与 `/api/sub` 节点配置快照；
3. **故障自动无感回退**：当 Redis 未启动、网络超时（默认 `REDIS_TIMEOUT=1.5s`）或运行中宕机时，熔断器立即触发冷却（默认 `REDIS_COOLDOWN_SECONDS=30s`），读写操作**自动无缝回退至 SQL `kv_cache`**（SQLite / MySQL 均采用 `FOR UPDATE` 行级/事务锁保证 OTP 原子核销与限流计数），确保面板与节点通信 100% 不中断；待 Redis 恢复并过冷却期后自动无感切回。

---

## 🚀 单参数开启前后端分离 + TLS 移交 Nginx (`SEPARATE_FRONTEND=true`)

在高并发或宿主机已有 Nginx（如宝塔面板 / 独立 Nginx 网关）的场景下，建议将 **静态资源缓存、Gzip/Brotli 压缩、HTTPS TLS 握手与前沿限流** 全部交给最擅长的 Nginx，让后端容器专心处理纯 API 业务逻辑。

只需在主控容器中添加 **单个环境变量 `SEPARATE_FRONTEND=true`**，后端将自动完成全套分离切换：
1. **关闭后端静态托管**：Flask 不再挂载 `../frontend/dist` 静态路由（`/` 返回 API 状态 JSON），彻底释放后端工作线程；
2. **关闭后端 TLS 监听**：`entrypoint.sh` 自动跳过 `/app/certs` 初始化与证书读取，Granian 以纯 **HTTP** 协议高速监听 `${WEB_HOST}:${WEB_PORT}`（建议配合 `-e WEB_HOST=127.0.0.1` 仅对本机回环开放）；
3. **健康检查自动适配**：Dockerfile `HEALTHCHECK` 自动探测 `http://127.0.0.1:${WEB_PORT}/healthz`；
4. **HTTPS 链接透传对齐**：后端通过 `ProxyFix` 自动识别 Nginx 传递的 `X-Forwarded-Proto: https`、`X-Forwarded-Host` 与 `X-Forwarded-Port`，订阅地址（`sub_url`）与节点 WSS 反穿地址依然精准输出 `https://` 与公网端口。

### 第 1 步：以分离模式启动后端容器

```bash
docker run -d --name xray-web-master --restart unless-stopped \
  --network host \
  -e TZ=Asia/Shanghai \
  -e SEPARATE_FRONTEND=true \
  -e WEB_HOST=127.0.0.1 \
  -e WEB_PORT=8443 \
  -e PUBLIC_URL=https://panel.example.com \
  -e WEB_WORKERS=4 \
  -e WEB_BLOCKING_THREADS=32 \
  -v $(pwd)/data:/data \
  -v $(pwd)/data/backups:/data/backups \
  xray-web:latest
```
*(若 Nginx 运行在另一台容器而非宿主机 host 网络，可将 `WEB_HOST` 保持默认 `::` / `0.0.0.0`，通过 Docker 内网互通。)*

### 第 2 步：手动将前端静态资源拷贝给 Nginx

从已构建的镜像/容器中直接提取编译好的 `frontend/dist` 到宿主机 Nginx 站点目录（如 `/var/www/xray-web`）：

```bash
mkdir -p /var/www/xray-web
docker cp xray-web-master:/app/frontend/dist/. /var/www/xray-web/
```
*(或在本地源码 `app/frontend` 执行 `npm install && npm run build`，将生成的 `dist/*` 上传至 `/var/www/xray-web/`。)*

### 第 3 步：Nginx 生产配置参考（含 TLS + 静态缓存 + 反代 + WS 隧道 + 防刷限流）

```nginx
# 放在 nginx.conf 的 http {} 块内：针对登录/发信/订阅做前置连接与速率保护
limit_req_zone $binary_remote_addr zone=xray_api_burst:10m rate=20r/s;
limit_req_zone $binary_remote_addr zone=xray_auth_strict:10m rate=5r/s;

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name panel.example.com;

    # TLS 证书完全交由 Nginx 宿主机维护（宝塔 / Certbot / Acme.sh 自动续签零影响）
    ssl_certificate     /www/server/panel/vhost/cert/panel.example.com/fullchain.pem;
    ssl_certificate_key /www/server/panel/vhost/cert/panel.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:20m;
    ssl_session_timeout 1d;

    # 前端静态资源根目录（管理员手动拷贝的 dist 内容）
    root /var/www/xray-web;
    index index.html;

    gzip on;
    gzip_static on;
    gzip_min_length 1024;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;

    # 静态资源长缓存（index.html 禁止浏览器与 Cloudflare CDN 缓存，确保发版即时生效）
    location = /index.html {
        add_header Cache-Control "private, no-cache, no-store, must-revalidate";
        add_header CDN-Cache-Control "no-store";
        add_header Cloudflare-CDN-Cache-Control "no-store";
    }
    location /assets/ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # SPA 前端路由兜底（非真实静态文件走 index.html，同样禁止 CDN 缓存）
    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "private, no-cache, must-revalidate";
        add_header CDN-Cache-Control "no-store";
        add_header Cloudflare-CDN-Cache-Control "no-store";
    }

    # 登录/注册/发信/卡密敏感接口加强防刷
    location ~ ^/api/(login|register|recharge|auth/) {
        limit_req zone=xray_auth_strict burst=10 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:8443;
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header X-Forwarded-Port $server_port;
    }

    # 通用 API 与 WSS 反向穿透隧道代理
    location ~ ^/(api/|healthz$) {
        limit_req zone=xray_api_burst burst=40 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:8443;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header X-Forwarded-Port $server_port;
        proxy_read_timeout 300s;
    }
}
```

---

## ⚡ 高并发性能调优与全链路防刷保护

### 1. 并发架构与调优参数
后端在路由与数据层针对高并发进行了系统级改造：
- **非阻塞网络拨测解耦**：节点 TOFU 首次接入 / `FORCE_RESYNC` / 后台批量 `ping` 探测均在 **数据库事务锁外** 执行（后台全节点测活采用 `ThreadPoolExecutor` 并发握手），避免慢网络 I/O 长期占用数据库连接池；
- **全原子并发防竞态更新**：
  - 节点流量扣费（`/api/node/traffic`）：先批次内存聚合，再执行 `UPDATE users SET used_mb = ROUND(COALESCE(used_mb, 0) + inc, 2)` 原子累加；
  - 卡密核销（`/api/recharge`）：采用条件原子更新 `UPDATE cards SET is_used=1 WHERE code=? AND is_used=0`，彻底杜绝并发双花漏洞；
  - 推荐返利（`/api/register`）：条件原子递增 `referral_count < max_per_user`，防止并发突破上限；
- **热点读缓存**：登录、个人刷新、UUID 重置与订阅接口统一读取 `get_cached_nodes()` 与 `get_cached_active_users()`（30s TTL，后台修改节点/用户时自动失效）。

可通过环境变量按机器规格弹性扩容 Granian 与数据库连接池：
| 变量名 | 默认值 | 高并发推荐（MySQL + Redis + Nginx） | 说明 |
| :--- | :---: | :---: | :--- |
| `WEB_WORKERS` | `1` | `4` ~ `CPU核数` | Granian 多进程 Worker 数（1GB 低配 VPS / SQLite 默认 `1` 省内存，高配可按需调大） |
| `WEB_BLOCKING_THREADS` | `16` | `32` ~ `64` | 每个 Worker 并发处理 WSGI 阻塞线程数 |
| `WEB_BACKLOG` | `2048` | `4096` | Socket 全连接等待队列深度 |
| `DB_POOL_SIZE` | `20` | `20` ~ `50` | MySQL 连接池常驻连接数 |
| `DB_MAX_OVERFLOW` | `30` | `50` | MySQL 峰值溢出最大连接数 |

### 2. 全方位后端防刷与防爆破保护（Redis Lua / SQLite & MySQL 原子协同）
内置统一限流与风控模块 `core/rate_limit.py`（复用 `core.cache`，Redis 通过原子 Lua 脚本计数，未开启或故障自动回退至 SQLite `INSERT...ON CONFLICT RETURNING` / MySQL `ON DUPLICATE KEY UPDATE` 原子 SQL，默认 `RATE_LIMIT_ENABLE=true`）：
- **可信代理防伪造 (`TRUST_PROXY=auto`)**：通过 `TrustedProxyMiddleware` 校验底层 TCP 对端 IP；公网直连请求一律忽略伪造的 `X-Forwarded-For` / `X-Real-IP`，即使位于 Nginx 后也仅解析受信任代理追加的最右端真实客户端 IP（支持 `TRUST_PROXY=auto|always|never` 与 `RATE_LIMIT_WHITELIST` 白名单）；
- **滑动时间窗口 & 标准限流响应头**：所有限流器采用双桶滑动窗口算法彻底消除固定窗口边界 2 倍突发漏洞，并返回 `Retry-After` 与 `X-RateLimit-Limit / Remaining / Reset` 响应头；
- **人机、蜜罐封禁与账号级防爆破**：`/api/auth/captcha` 限流 `30次/60秒/IP`；`/api/login` 限流 `20次/60秒/IP` + **触发蜜罐即刻全域封禁 IP 30 分钟** + 人机响应时间窗口（`<0.5s` 拦截）+ IP 阶梯锁定（`15m -> 30m -> 60m`）+ **按目标账号连续 8 次错误锁定 15 分钟**（彻底封堵代理池轮换 IP 撞库）；
- **后台管理接口防爆破**：`/api/admin/*` 连续 20 次密码校验失败自动封禁 IP 30 分钟；
- **邮件防轰炸 & OTP 防枚举**：注册/找回/换绑发信接口严格限制 **IP 5次/5分钟**、**同邮箱 60 秒冷却**、**单 IP 单日 15 封** 以及 **同目标邮箱单日 10 封跨 IP 封顶**；`APP_MODE=admin` 时一并关闭发信；6 位邮箱验证码输错 **5 次立即作废销毁**；
- **卡密、订阅与高开销资源防护**：`/api/recharge` 限制 `15次/5分钟/IP`（8 次无效卡密锁定 15 分钟）；`/api/sub` 与 `/api/qrcode` 限制 `60次/60秒/IP`；`/api/user/download_client`（ZIP 打包）限制 `8次/5分钟/IP`，`/api/user/download_apk` 限制 `10次/5分钟/IP`；`/api/user/change_password` 增加 `10次/5分钟/IP` + 原密码错 5 次锁定 10 分钟；第三方发卡 `/api/open/faka_generate` 限制 `120次/60秒/IP` 与 10 次错误 Token 限流。

---

## 🌐 IPv4 + IPv6 双栈监听说明（Granian）

主控 `entrypoint.sh` 启动时会自动检测宿主机内核协议栈：
1. 若宿主机支持 IPv6 且 `net.ipv6.bindv6only=0`（Linux 默认值），Granian 自动绑定 `--host "::"`，在单个端口上**同时接管 IPv4 与 IPv6 请求**；
2. 若宿主机禁用了 IPv6（如 `ipv6.disable=1`）或开启了 `bindv6only=1`，系统会自动安全回退到 `--host 0.0.0.0`（纯 IPv4），确保容器健康检查（`HEALTHCHECK`）与控制面板 100% 正常启动不崩溃；
3. 如需强制锁定监听地址，可通过环境变量 `-e WEB_HOST="::"` 或 `-e WEB_HOST="0.0.0.0"` 显式指定；在 `SEPARATE_FRONTEND=true` 配合本机 Nginx 反代时推荐设为 `-e WEB_HOST="127.0.0.1"` 禁止外部绕过 Nginx 直连后端。

---

## 📱 客户端使用与订阅导入

用户在个人中心即可一览所有可用加速节点：

### 通用聚合订阅（推荐）
点击用户界面的 **`🔗 一键复制全节点订阅链接`**，直接填入客户端订阅地址中，所有节点一次性批量导入：
* **v2rayN / xrayN (Windows)**：订阅设置 -> 添加订阅链接 -> 更新订阅
* **Clash-Meta / Clash Verge**：配置 -> 导入订阅 URL
* **Sing-box / Shadowrocket (iOS)**：右上角添加 -> 类型选择 Subscribe 导入

> **提示**：订阅链接会自动包含公网直连（Reality）与 NAT4 反穿（WSS）全部可用节点，无需客户端做任何特殊配置。

---

## 🛒 方案 C：第三方发卡网 API 自动出卡规范

系统支持无库存实时出卡，完美兼容**独角数卡**等自动化发卡平台。

### 1. 接口规范
* **请求方式**：`GET` 或 `POST`
* **接口路径**：`/api/open/faka_generate`
* **URL 示例**：
  ```text
  https://<主控IP>:8443/api/open/faka_generate?gb=100&days=30&is_monthly=1&token=你的Token
  ```

### 2. 请求参数说明
| 参数名 | 类型 | 必填 | 说明 |
| :--- | :---: | :---: | :--- |
| `token` | string | **是** | 发卡 API 专用鉴权密钥（后台设置中查看或生成） |
| `gb` | int | 否 | 卡密包含的流量（单位 GB，填 `0` 为不限流量，默认 100） |
| `days` | int | 否 | 有效期天数（填 `36500` 为永久有效，默认 30） |
| `is_monthly` | int | 否 | 填 `1` 时生成“每月固定重置套餐卡”，填 `0` 为普通固定卡 |
| `format` | string | 否 | 留空返回纯卡密文本（如 `KM-ABCD1234EF56`），填 `json` 返回完整 JSON 实体 |