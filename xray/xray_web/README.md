# ⚡ Xray Reality 分布式多节点管理中枢（Xray-Web & Xray-Core）

基于 **Xray-core（VLESS-REALITY-Vision / WSS 反向打洞隧道）** 打造的高性能分布式节点管理与商业化运营中枢。系统采用 **Master-Agent（主控中心 - 边缘工作节点）彻底解耦架构**，兼顾零依赖开箱即用与大规模集群高并发扩展。

| 组件 | 定位与核心技术栈 | 核心职责 |
| :--- | :--- | :--- |
| **`xray_web`（主控端）** | Python 3.11 + Cython `.so` 闭源编译 + Granian 双栈 WSGI + `dumb-init + gosu` 非 Root (`UID 10001`) + SQLAlchemy 2.0 (`SQLite` / `MySQL`) + Vue 3 | 用户生命周期、数据库备份与跨库迁移、卡密核销、邮件/微信通知、聚合订阅下发、防重放 Join Token 签发、审计日志与节点拨测裁决 |
| **`xray_core`（节点端）** | Alpine 三阶段构建 + 非 Root (`UID 10001`) + `dumb-init` + 纯 Python 异步看门狗 + `xray-core` | 部署于海外 VPS 或内网主机，专注高速 REALITY 代理、WSS 反向隧道穿透、配置预检热重载与流量上报 |

---

## 📑 目录导航

> 💡 **提示**：在 GitHub / Gitee 浏览本页时，也可直接点击右上角 / 左上角的 **大纲（Outline）按钮** 悬浮呼出固定侧边目录。

| 分类 | 章节直达 |
| :--- | :--- |
| **一、架构与特性** | [核心特性总览](#-核心特性总览) · [非 Root 与证书架构](#-非-root-运行宝塔证书挂载与-root-init-drop-架构) · [端口自定义与映射](#-对外端口自定义与端口映射处理) |
| **二、部署与扩展** | [部署指南](#-部署指南) · [Redis 加速与 SQL 回退](#-可选-redis-加速与-sql-cache-自动回退) · [前后端分离（Nginx）](#-单参数开启前后端分离--nginx-托管-tls-separate_frontendtrue) · [IPv4 + IPv6 双栈](#-ipv4--ipv6-双栈监听说明granian) |
| **三、性能与风控** | [高并发性能调优](#-高并发性能调优) · [全链路防刷防爆破](#-全链路防刷与防爆破保护) |
| **四、数据库迁移** | [迁移前必读要点](#迁移前必读要点) · [SQLite 迁移至 MySQL](#方案一sqlite-迁移至-mysql) · [MySQL 迁移至 SQLite](#方案二mysql-迁移至-sqlite反向迁移) · [进阶与回滚](#迁移进阶与注意事项) |
| **五、运营与对接** | [客户端订阅导入](#-客户端使用与订阅导入) · [第三方发卡网 API](#-方案-c第三方发卡网-api-自动出卡规范) |

---

## 🌟 核心特性总览

- **IPv4 + IPv6 双栈面板 & 节点双模自适应**
  - **主控双栈监听**：Granian 启动时自动探测内核 IPv6 双栈能力（`::` 且 `IPV6_V6ONLY=0`），开箱同时监听 IPv4 与 IPv6（支持 `WEB_HOST` 手动覆写）。
  - **公网直连节点 (`direct`)**：默认启用原生 `TCP + VLESS-REALITY-Vision`，抗封锁性能优异。
  - **NAT4 / 封端口反穿节点 (`reverse_wss`)**：本地回环采用纯 TCP 桥接，节点主动向 Hub 建立 WSS 反向长连接，免公网 IP、免端口映射。
- **原生集成零信任安全引擎 `wimotek-edge-agent >= 1.0.17`**
  - **主动双栈 TCP 拨测裁决 (`detect_network_mode_sync`)**：节点上报公网 IPv4 / IPv6 与端口后，Hub 端主动并发拨测连通性，精准裁决 `direct_dual` / `direct_ipv4` / `direct_ipv6` / `reverse_tunnel`，端口不通时自动下发 `reverse_wss` 热切换。
  - **40 字符单次防重放令牌 (`JoinTokenIssuer / Verifier`)**：14 字节随机 ID + 16 字节 HMAC-SHA256 签名，核销后原子作废。
  - **结构化安全审计 (`AuditLogger`)**：统一记录 JSONL 安全审计流水，支持 **10MB 自动切割轮转与归档**，提供 `/api/node/edge_agent/*` 原生管理端点。
- **TOFU 首次准入与隔离区**
  - 具备 **TOFU 首次信任总开关** 与 **免审自动准入子开关**；未知新节点接入自动进入【待审隔离区】，审批或有效令牌验证后方可上线。
  - 通信密钥 `node_key` 首次握手自动固化，支持后台一键轮换与心跳热更新。
- **聚合订阅地址自动透明分流**
  - 用户只需导入一个订阅地址（`/api/sub?token=用户UUID`），Hub 自动根据节点状态实时下发 REALITY 直连或 Hub 域名 WSS 链接。
- **SQLAlchemy 2.0 双引擎 & Web 安装向导 (`SetupWizard`)**
  - **3 步可视化安装向导**：全新实例首次访问即可在线完成 SQLite / MySQL 切换与连通性测试、Redis PING 探测、对外入口（`PUBLIC_URL` / `PUBLIC_PORT` / `APP_MODE`）及管理员账密与 `cluster_token` 初始化；配置持久化至 `/data/hub_config.json` 并自动锁定向导接口。
  - **双引擎热备与跨库迁移**：SQLite 模式支持 `.db` 在线无锁热备与 `PRAGMA integrity_check`；MySQL 模式支持事务级 `.json` 逻辑快照导出与还原，且支持 **SQLite ⇄ MySQL 双向无损迁移**。
- **多种计费套餐与发卡对接**
  - 支持固定流量包、每月固定重置卡（邮件/微信清零推送）、无限量/永久卡以及兼容独角数卡的第三方自动出卡 API。

---

## 🔒 非 Root 运行、宝塔证书挂载与 Root-Init-Drop 架构

为遵循容器最小权限安全规范，**`xray_web` 与 `xray_core` 业务主进程均以非特权用户 `appuser`（UID `10001` / GID `10001`）运行**。

### 1. 主控端 (`xray_web`)：如何兼顾“非 Root + 宝塔证书 `0600`”

宝塔面板 / Certbot 签发的私钥 `privkey.pem` 在宿主机默认归属 `root:root` 且权限为 `0600`。为避免容器启动因无权读取报错或改乱宿主机目录权限，`xray_web` 采用 **Root-Init-Drop（`dumb-init + gosu`）两阶段安全降权架构**：

1. **阶段 1 · Root-Init（启动瞬时初始化）**：
   - `entrypoint.sh` 短暂以 `root` 身份创建并修正 `/data`、`/data/backups`、`/app/certs` 的属主为 `10001:10001`（宿主机忘记提前 `chown ./data` 也能正常启动）。
   - `cert_init` 读取只读挂载 `/certs:ro` 中的证书与 `0600` 私钥，安全拷贝至容器内部 `/app/certs/` 并收口为 `10001:10001`（`0644` / `0600`），**全程绝不修改宿主机原文件权限，宝塔自动续签零干扰**。
2. **阶段 2 · Drop（不可逆降权运行）**：
   - 初始化完成后通过 `exec gosu appuser:appgroup granian ...` 彻底放弃 root 权限；同时已为 `python3` 写入 `cap_net_bind_service=+ep`，即使设置 `-e WEB_PORT=443` 也能在非 Root 下直接监听 `443`。

> **宝塔证书直接挂载示例**：
> ```yaml
> volumes:
>   - ./data:/data
>   - ./data/backups:/data/backups
>   - /www/server/panel/vhost/cert/你的域名:/certs:ro
> ```
> *(宝塔自动续签更新宿主机证书后，重启一次 `xray-web` 容器即可自动同步最新证书。)*

### 2. 节点端 (`xray_core`) 宿主机目录授权

`xray_core` 直接以 `USER appuser (10001)` 启动，使用绑定挂载前需预先创建并授权 `./data` 目录（或改用 Docker 命名卷 `xray_node_data:/data`）：

```bash
mkdir -p ./data && chown -R 10001:10001 ./data
```

> **注意**：请勿为节点容器添加 `--security-opt=no-new-privileges:true`，否则会屏蔽 `/usr/bin/xray` 的 `cap_net_bind_service=+ep` 权能导致无法绑定 `443` 端口。

---

## 🌐 对外端口自定义与端口映射处理

主控容器默认内部监听 **`WEB_PORT=8443`**（HTTPS TLS），支持任意自定义端口与宿主机端口映射：

| 部署场景 | 配置示例 | 系统自动处理机制 |
| :--- | :--- | :--- |
| **默认双栈直通** | `network_mode: host`，默认 `WEB_PORT=8443` | 监听 `[::]:8443`，`HEALTHCHECK` 探测 `127.0.0.1:8443/healthz`，订阅与部署命令自动使用 `:8443` |
| **修改内部端口** | `network_mode: host` + `-e WEB_PORT=9443` | Granian 监听 `[::]:9443`，`HEALTHCHECK` 动态读取 `${WEB_PORT}` 探测 `9443` |
| **宿主机端口映射** | `-p 3000:8443`（容器保持 `WEB_PORT=8443`） | 容器内健康检查仍走 `8443`；后端通过 `ProxyFix` + `resolve_public_endpoint` 自动识别请求 `Host` / `X-Forwarded-Port` 中的 **`3000`**，并将 `PANEL_URL`、订阅地址及 WSS 反穿地址对齐为 `:3000` |
| **反代 / NAT 转发** | Nginx/Cloudflare `443 -> 8443` 或未透传端口 | 自动读取 `X-Forwarded-Host` / `X-Forwarded-Port`；未透传时可通过 `-e PUBLIC_PORT=3000` 或 `-e PUBLIC_URL=https://panel.example.com:3000` 强制锁定 |

---

## 🚀 部署指南

### 第一步：部署 `xray_web` 主控端

1. **准备目录与 `docker-compose.yml`**：

   ```bash
   git clone https://github.com/wimotek/chromium.git
   cd chromium/xray/xray_web
   mkdir -p ./data/backups ./certs
   ```

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
       # 若改用端口映射（如 3000:8443），可注释 network_mode 并启用：
       # ports:
       #   - "3000:8443"
       environment:
         - TZ=Asia/Shanghai
         - APP_MODE=all
         - WEB_PORT=8443
         # - PUBLIC_PORT=3000
         # - PUBLIC_URL=https://panel.example.com:3000
         # - WEB_HOST=::
         # 外置 MySQL 可在向导中填写，或在此提前声明：
         # - DB_TYPE=mysql
         # - MYSQL_HOST=127.0.0.1
         # - MYSQL_PORT=3306
         # - MYSQL_USER=xray_web
         # - MYSQL_PASSWORD=your_strong_password
         # - MYSQL_DATABASE=xray_web
       volumes:
         - ./data:/data
         - ./data/backups:/data/backups
         # - /www/server/panel/vhost/cert/你的域名:/certs:ro
         - ./certs:/certs:ro
   ```

2. **启动并完成首次初始化**：

   ```bash
   docker compose up -d --build
   ```

   - 浏览器访问 `https://<主控IPv4>:8443` 或 `https://[<主控IPv6>]:8443`。
   - **全新实例**：自动进入 **3 步可视化安装向导**（可在线测试 SQLite/MySQL、Redis、设置管理员账密与 `cluster_token`；自动化部署可传 `-e AUTO_SKIP_SETUP=true`）。
   - **旧集群升级**：检测到已有节点或用户数据时自动跳过向导，业务零中断。

### 第二步：接入边缘节点 `xray_core`

在海外 VPS 或内网主机上执行：

```bash
mkdir -p ./data && chown -R 10001:10001 ./data

docker run -d \
  --name xray-node \
  --restart always \
  --network host \
  -e TZ="Asia/Shanghai" \
  -e PANEL_URL="https://<主控域名或IP>:8443" \
  -e CLUSTER_TOKEN="你的cluster_token" \
  -e NET_MODE="auto" \
  -e PORT=443 \
  -e DEST="www.microsoft.com:443" \
  -e SERVER_NAMES="www.microsoft.com,microsoft.com" \
  -v $(pwd)/data:/data \
  ghcr.io/wimotek/xray:latest
```

#### 节点常用环境变量说明

| 变量名 | 说明 | 默认值 / 示例 |
| :--- | :--- | :--- |
| `PANEL_URL` | **[必填]** 主控 `xray_web` 访问地址 | `https://1.2.3.4:8443` |
| `CLUSTER_TOKEN` | **[必填]** 集群引导令牌或 40 字符单次 Join Token | `ctk_...` |
| `NET_MODE` | `auto`（Hub 双栈拨测裁决）、`direct`（强制直连）、`reverse_wss`（强制反穿） | `auto` |
| `PORT` | 节点 Reality 监听端口 | `443` |
| `DEST` | 伪装目标回落地址 | `www.microsoft.com:443` |
| `SERVER_NAMES` | 伪装域名池（逗号分隔） | `www.microsoft.com,microsoft.com` |
| `TZ` | 容器时区 | `Asia/Shanghai` |

> 若家宽/NAT4 主机无公网端口或 443 被封，请设置 `-e NET_MODE="reverse_wss"` 或保持 `auto` 由主控自动裁决切换。

---

## ⚡ 可选 Redis 加速与 SQL Cache 自动回退

主控内建统一缓存层（`core/cache.py`），遵循 **“Redis 优先 + 熔断降级 + SQL Cache 自动回退”**：

1. **零配置默认模式**：未配置 `REDIS_URL` / `REDIS_HOST` 时，自动复用主库（SQLite 或 MySQL）中的 `kv_cache` 表，单容器开箱即用。
2. **后台可视化查看与在线热切换（推荐）**：登录管理后台 → **「🗄️ 数据库自动备份与全局配置」→「⚡ 缓存引擎 (Redis / SQL)」**，可实时查看当前缓存引擎模式、PING 延迟、Redis 版本/内存/连接数与熔断降级状态，支持在线测试连通性并**一键保存热生效**（原子落盘 `/data/hub_config.json`，所有 Granian Worker 进程 1~2 秒内自动同步，**无需重启容器**），同时支持一键清理业务缓存。
3. **环境变量 / 首次向导配置**：也可在首次运行安装向导配置，或通过 `-e REDIS_URL="redis://[:密码@]主机:6379/0"`（及 `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` / `REDIS_DB`）声明；旧版向导留空的 `redis_url` 不会覆盖环境变量中的 Redis 配置。
4. **故障无感回退**：Redis 超时（默认 `1.5s`）或宕机时触发冷却（默认 `30s`），自动回退至 SQL `kv_cache`（支持原子删除与行级锁），待 Redis 恢复后自动切回。

---

## 🔀 单参数开启前后端分离 + Nginx 托管 TLS (`SEPARATE_FRONTEND=true`)

高并发或宿主机已有 Nginx（如宝塔面板）时，设置单个环境变量 **`SEPARATE_FRONTEND=true`**：

- Flask 不再托管静态资源（释放后端线程）；
- `entrypoint.sh` 自动跳过 TLS 证书加载，Granian 仅以纯 HTTP 监听 `${WEB_HOST}:${WEB_PORT}`；
- `HEALTHCHECK` 自动探测 `http://127.0.0.1:${WEB_PORT}/healthz`，后端继续通过 `ProxyFix` 对齐 `https://` 订阅链接。

### 1. 分离模式启动后端 & 拷贝前端产物

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

mkdir -p /var/www/xray-web
docker cp xray-web-master:/app/frontend/dist/. /var/www/xray-web/
```

### 2. Nginx 生产配置参考

```nginx
limit_req_zone $binary_remote_addr zone=xray_api_burst:10m rate=20r/s;
limit_req_zone $binary_remote_addr zone=xray_auth_strict:10m rate=5r/s;

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name panel.example.com;

    ssl_certificate     /www/server/panel/vhost/cert/panel.example.com/fullchain.pem;
    ssl_certificate_key /www/server/panel/vhost/cert/panel.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:20m;
    ssl_session_timeout 1d;

    root /var/www/xray-web;
    index index.html;

    gzip on;
    gzip_static on;
    gzip_min_length 1024;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;

    location = /index.html {
        add_header Cache-Control "private, no-cache, no-store, must-revalidate";
        add_header CDN-Cache-Control "no-store";
        add_header Cloudflare-CDN-Cache-Control "no-store";
    }
    location /assets/ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "private, no-cache, must-revalidate";
        add_header CDN-Cache-Control "no-store";
        add_header Cloudflare-CDN-Cache-Control "no-store";
    }

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

## 📡 IPv4 + IPv6 双栈监听说明（Granian）

`entrypoint.sh` 启动时自动检测宿主机内核协议栈：

1. 若支持 IPv6 且 `net.ipv6.bindv6only=0`，自动绑定 `--host "::"` 在同一端口接管 IPv4 与 IPv6 请求；
2. 若禁用了 IPv6 或开启了 `bindv6only=1`，自动安全回退 `--host 0.0.0.0`；
3. 可显式设置 `-e WEB_HOST="::"` 或 `"0.0.0.0"`；前后端分离搭配本机 Nginx 时推荐设为 `-e WEB_HOST="127.0.0.1"`。

---

## ⚙️ 高并发性能调优

后端在数据与路由层已完成全面解耦与性能优化：

- **非阻塞 I/O 与短事务**：TOFU 探测、节点测活（`ThreadPoolExecutor` 并发）、定时通知发送、充卡/换绑提示邮件均脱离数据库事务执行；只读路由统一采用 `readonly` 会话避免无效写锁；
- **全原子并发防竞态**：流量扣费原子累加、卡密核销 `UPDATE cards SET is_used=1 WHERE code=? AND is_used=0` 防双花、推荐返利条件原子递增；
- **热点读缓存**：`get_cached_nodes()` 与 `get_cached_active_users()` 缓存 30s 并随后台变更自动失效。

| 环境变量 | 默认值 | 高并发推荐（MySQL + Redis + Nginx） | 说明 |
| :--- | :---: | :---: | :--- |
| `WEB_WORKERS` | `1` | `4` ~ `CPU核数` | Granian Worker 进程数（低配/SQLite 默认 `1` 省内存） |
| `WEB_BLOCKING_THREADS` | `16` | `32` ~ `64` | 单 Worker WSGI 阻塞线程池大小 |
| `WEB_BACKLOG` | `2048` | `4096` | Socket 全连接等待队列长度 |
| `DB_POOL_SIZE` | `20` | `20` ~ `50` | MySQL 连接池常驻连接数 |
| `DB_MAX_OVERFLOW` | `30` | `50` | MySQL 峰值溢出最大连接数 |

---

## 🛡️ 全链路防刷与防爆破保护

内置 `core/rate_limit.py`（Redis 原子 Lua 脚本优先，故障自动回退 SQL 原子操作，默认 `RATE_LIMIT_ENABLE=true`）：

- **可信代理防伪造 (`TRUST_PROXY=auto`)**：公网直连请求忽略伪造的 `X-Forwarded-For` / `X-Real-IP`，仅解析受信任代理追加的真实客户端 IP（支持 `auto | always | never` 与 `RATE_LIMIT_WHITELIST`）。
- **滑动时间窗口**：双桶滑动窗口消除固定窗口边界 2 倍突发漏洞，返回标准 `Retry-After` 与 `X-RateLimit-*` 响应头。
- **人机 / 蜜罐 / 账号防爆破**：`/api/auth/captcha` 限流 `30次/60秒/IP`；`/api/login` 限流 `20次/60秒/IP` + 蜜罐秒封 30 分钟 + 答题速度检测（`<0.5s` 拦截）+ IP 阶梯封禁 + **单账号连续错 8 次锁定 15 分钟**；`/api/admin/*` 连续 20 次鉴权失败封禁 IP 30 分钟。
- **邮件防轰炸与高开销防护**：发信接口限 `5次/5分钟/IP`、同邮箱 60s 冷却、单日目标邮箱跨 IP 上限 10 封；OTP 错 5 次立即作废；卡密核销 `15次/5分钟/IP`（8 次无效锁定 15 分钟）；订阅/二维码 `60次/60秒/IP`；客户端打包下载 `8次/5分钟/IP`。

---

## 🔄 数据库双向迁移指南（SQLite ⇄ MySQL）

本项目基于 **SQLAlchemy 2.0 ORM**，两套数据库使用完全一致的模型，并通过内置 **`.json` 逻辑快照引擎**（`core/backup_manager.py`）实现双向平滑迁移，无需手工转换 SQL 语法。

### 迁移前必读要点

1. **迁移数据范围**：完整迁移 `users`、`nodes`、`cards`、`system_settings`、`notify_logs` 以及最近 2000 条 `audit_logs`；临时表（`verify_codes`、`captchas`、`ip_security_limits`、`kv_cache`）新库启动时自动重建。
2. **配置优先级陷阱（重点）**：若曾通过 Web 安装向导初始化，系统会生成 `./data/hub_config.json`。在 `config.py` 中，**`hub_config.json` 内的 `database_url` 优先级高于 `docker-compose.yml` 环境变量**。切换引擎时若存在 `./data/hub_config.json`，**务必同步修改其中的数据库字段**。
3. **备份格式差异**：MySQL 模式后台默认生成跨库通用的 **`.json`** 快照；SQLite 模式后台默认生成原生 **`.db`** 热备（MySQL 无法直接还原 `.db`），需通过下方容器命令导出 `.json` 快照。
4. **容器权限规范**：执行 `docker exec` 操作 `/data` 时建议加上 **`-u 10001:10001`**，确保文件归属非 Root 用户 `appuser`。

### 方案一：SQLite 迁移至 MySQL

#### 第 1 步：创建空的 MySQL 数据库（`utf8mb4`）

```sql
CREATE DATABASE IF NOT EXISTS xray_web
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'xray_web'@'%' IDENTIFIED BY '你的强密码';
GRANT ALL PRIVILEGES ON xray_web.* TO 'xray_web'@'%';
FLUSH PRIVILEGES;
```

> 若容器与 MySQL 同机且使用 `network_mode: "host"`，可将 `'%'` 收紧为 `'127.0.0.1'` 或 `'localhost'`。

#### 第 2 步：从当前 SQLite 导出通用 `.json` 快照

建议顺手复制一份 `./data/xray_web.db` 作为冷备份：

```bash
cp ./data/xray_web.db ./data/xray_web.db.bak.$(date +%Y%m%d_%H%M%S)

docker exec -u 10001:10001 -it xray-web-master python3 -c \
  "from core.backup_manager import _export_logical_snapshot; _export_logical_snapshot('/data/backups/xray_backup_migrate_to_mysql.json')"
```

#### 第 3 步：切换配置指向 MySQL 并初始化空表

- **存在 `./data/hub_config.json` 时**，修改其中数据库连接信息（若密码含 `@`、`:`、`/`、`#` 等特殊字符，建议清空 `database_url` 并填写分离字段，后端会自动转义）：

  ```json
  {
    "setup_completed": true,
    "db_type": "mysql",
    "database_url": "",
    "mysql_host": "127.0.0.1",
    "mysql_port": 3306,
    "mysql_user": "xray_web",
    "mysql_password": "你的强密码",
    "mysql_database": "xray_web"
  }
  ```

- **无 `hub_config.json` 时**，直接在 `docker-compose.yml` 取消注释 `DB_TYPE=mysql` 与 `MYSQL_*` 环境变量。
- 重建容器使系统在 MySQL 中自动建立全套表结构：

  ```bash
  docker compose up -d --force-recreate
  ```

#### 第 4 步：导入 `.json` 快照并刷新缓存

```bash
docker exec -u 10001:10001 -it xray-web-master python3 -c \
  "from core.backup_manager import restore_database_from_backup; print(restore_database_from_backup('xray_backup_migrate_to_mysql.json'))"
```

看到返回 `(True, ...)` 后重启容器刷新内存及 Redis 缓存即可：

```bash
docker compose restart
```

> 也可使用新库初始账密登录后台 →「🗄️ 数据库自动备份与全局配置」→ 上传/选中该 `.json` 快照点击「🔄 一键恢复」。

### 方案二：MySQL 迁移至 SQLite（反向迁移）

#### 第 1 步：在 MySQL 模式下导出 `.json` 快照

- **Web 后台操作（推荐）**：管理后台 →「🗄️ 数据库自动备份与全局配置」→ 点击 **「⚡ 立即创建热备份快照」**，记录文件名（如 `xray_backup_20261118_120000_manual.json`），可顺便下载至本地留底。
- **或命令行导出**：

  ```bash
  docker exec -u 10001:10001 -it xray-web-master python3 -c \
    "from core.backup_manager import _export_logical_snapshot; _export_logical_snapshot('/data/backups/xray_backup_migrate_to_sqlite.json')"
  ```

#### 第 2 步：清理旧 `.db` 并切回 SQLite 配置

1. 若宿主机 `./data/` 下有早年遗留的 `xray_web.db`，先隔离改名以免旧数据干扰：

   ```bash
   mv ./data/xray_web.db ./data/xray_web.db.old.$(date +%Y%m%d_%H%M%S) 2>/dev/null || true
   rm -f ./data/xray_web.db-wal ./data/xray_web.db-shm
   ```

2. 若存在 `./data/hub_config.json`，改回 SQLite 配置：

   ```json
   {
     "setup_completed": true,
     "db_type": "sqlite",
     "db_path": "/data/xray_web.db",
     "database_url": "sqlite:////data/xray_web.db"
   }
   ```

3. 将 `docker-compose.yml` 中的 `DB_TYPE=mysql`、`MYSQL_*`、`DATABASE_URL` 重新注释掉并重建容器：

   ```bash
   docker compose up -d --force-recreate
   ```

#### 第 3 步：从 `.json` 快照恢复到 SQLite

将文件名替换为第 1 步实际生成的 `.json` 快照文件名：

```bash
docker exec -u 10001:10001 -it xray-web-master python3 -c \
  "from core.backup_manager import restore_database_from_backup; print(restore_database_from_backup('xray_backup_20261118_120000_manual.json'))"
```

看到 `(True, ...)` 后重启一次容器刷新缓存：

```bash
docker compose restart
```

### 迁移进阶与注意事项

- **审计日志超过 2000 条的全量保留**：`_export_logical_snapshot()` 默认保留最近 2000 条 `audit_logs`；若需完整迁移海量历史审计记录，可在停写状态下通过 SQLAlchemy 引擎直连源库/目标库逐表复制。
- **边缘节点无感续接**：`nodes` 中的节点公钥、`node_key`、`tunnel_uuid` 与 `cluster_token` 会完整迁入新库；只要面板域名与端口不变，海外 `xray_core` 节点无需重装，下一次心跳自动续接。
- **停写窗口与回滚**：导出 `.json` 到恢复完成的几十秒内建议暂停前台充值与注册；在确认新库数据完整前勿删除旧库文件或旧 MySQL 库，发现异常改回配置文件重启即可秒级回退。
- **Redis 缓存刷新**：命令行导入后务必 `docker compose restart`（或 Web 后台执行恢复自动清缓存），避免 `setting:*` / `cluster:nodes` 残留旧库缓存。

---

## 📱 客户端使用与订阅导入

用户在个人中心即可获取节点列表与聚合订阅链接（`/api/sub?token=用户UUID`）：

- **v2rayN / xrayN (Windows)**：订阅分组设置 → 添加订阅地址 → 更新订阅（自动包含全部可用的 Reality 直连与 WSS 反穿节点）。
- **Clash-Meta / Clash Verge**：配置 → 粘贴订阅 URL 导入。
- **Sing-box / Shadowrocket (iOS)**：右上角添加 → 类型选择 `Subscribe` 导入。

---

## 🛒 方案 C：第三方发卡网 API 自动出卡规范

支持无库存实时出卡，兼容 **独角数卡** 等自动化发卡平台：

- **请求方式**：`GET` 或 `POST`
- **接口路径**：`/api/open/faka_generate`
- **请求示例**：

  ```text
  https://<主控域名或IP>:8443/api/open/faka_generate?gb=100&days=30&is_monthly=1&token=你的Token
  ```

| 参数名 | 类型 | 必填 | 说明 |
| :--- | :---: | :---: | :--- |
| `token` | string | **是** | 发卡 API 专用鉴权密钥（后台设置中查看/生成） |
| `gb` | int | 否 | 流量配额（GB，填 `0` 为不限流量，默认 `100`） |
| `days` | int | 否 | 有效期天数（填 `36500` 为永久有效，默认 `30`） |
| `is_monthly` | int | 否 | `1` 为每月固定重置套餐卡，`0` 为普通固定卡 |
| `format` | string | 否 | 留空返回纯卡密文本（如 `KM-ABCD1234EF56`），填 `json` 返回完整 JSON 对象 |