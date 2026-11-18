# ⚡ Chromium Distributed CDP Cluster & Cookie Synchronization Hub

分布式 Chromium 节点集群治理、多策略 Cookie 调度与安全 WSS 远程调试代理网关。

---

## 🌟 核心特性与架构升级

1. **Hub 端 `wimotek-edge-agent >= 1.0.17` 深度集成 + 节点轻量鉴权 WSS 选路（绝不暴露裸 9222）**：
   - 节点端 Chromium 原生 CDP `9222` 仅绑定容器内部 `127.0.0.1:9222`（仅在显式设置 `CDP_FORWARD_PORT` 或 `ENABLE_CDP_FORWARD=true` 时才用 `socat` 将默认 `9223`/自定义端口转发到 `9222`）；
   - 节点运行轻量级 `edge_node_client.py`（仅依赖 `httpx` + `websockets`，无需在节点侧重复打包 `wimotek-edge-agent`），内置双栈加密 + `X-Edge-Auth` 密钥鉴权 WSS 服务端（默认 `EDGE_WSS_PORT=9443`），上报公网 IPv4 / IPv6 与外部 WSS 端口至 Hub (`POST /api/nodes/detect-mode`)，由 Hub 端调用 `wimotek-edge-agent >= 1.0.17` 并发执行异步 **TCP 三次握手**（完全兼容 Oracle Cloud / 云主机的 1:1 NAT 内网网卡，并内置 SSRF 私网拦截）；
   - **有公网 IP 且 WSS 端口可达**：节点登记为 `public_wss`，Hub 通过 `wss://<节点IP>:<端口>/ws` 携带独立 `edge_wss_secret` 主动建立加密长连并桥接至节点 `127.0.0.1:9222`；
   - **无公网 / NAT4 / 防火墙未放行**：节点自动关闭入站监听并回落为 `reverse`（出站连 `/api/nodes/reverse-tunnel`），网关 `/cdp/{node_id}/ws` 统一多路复用透传至 Playwright / Puppeteer。
2. **零信任准入控制与 Session Ticket**：
   - 严格使用 `secrets.compare_digest` 校验 `JOIN_TOKEN` 与 `SessionTicketManager` 签发的短时复用凭据（默认 300 秒 TTL）；
   - 未提供 Token 时进入 TOFU 待审隔离区，管理员在控制台审批放行后通过反向信道即时下发通行指令与最新 `network_mode`。
3. **三镜像统一安全加固与极致瘦身（`dumb-init` + Root-Init-Drop `gosu` -> `UID 1000` + 分阶段提取）**：
   - Hub (`chromium_sync`) 与节点 (`chromium_novnc` / `chromium_kasmvnc`) 均在启动阶段短暂以 `root` 自愈 `/data` 权限并将宿主机宝塔/Certbot `/certs` 安全拷贝到容器内 `/etc/ssl/app`（绝不改动宿主机 `/certs` 权限），随后立即 `exec gosu` 降权为 `UID/GID 1000` 非特权运行业务进程；
   - **分阶段时区文件提取**：`tzdata` 仅在 builder 阶段安装，最终运行镜像仅复制 `/etc/localtime` 与 `/etc/timezone` 2 个文件；清理 `/opt/venv` 中冗余 `pip*` 与 `__pycache__`、`apt` 缓存及 `/var/log`，内建 Python 原生 `HEALTHCHECK`。
4. **多策略 Cookie 调度中枢与安全 WSS 网关 (默认 `8443`，可自定义 `HUB_PORT`)**：
   - 支持智能双向合并 (Smart Merge)、组对组、节点对组及自动清理熔断，原生支持 RFC 2732 IPv6 `[host]:port` CDP 连接；默认关闭高频 Uvicorn HTTP 轮询访问日志，可通过 `UVICORN_ACCESS_LOG=true` 按需开启。
5. **SQLAlchemy 2.0 ORM（SQLite / MySQL）+ Redis 自动熔断回退 SQLite Cache**：
   - 主数据全面迁移至 SQLAlchemy 2.0 ORM，开箱支持 SQLite WAL (`/data/app.db`) 与 MySQL/PyMySQL (`utf8mb4`)；
   - 高频流量计数、图形验证码、运行态指标及热配置缓存优先写入 Redis（1.5s 超时熔断），若未配置 Redis 或 Redis 异常自动无缝回退本地 `/data/cache.db` (SQLite WAL)，并每 30s 自动探活重连。
6. **双层实时流量统计与首次安装向导**：
   - Hub 代理网关 (`cdp_gateway` + `tunnel_manager`) 按 `public_wss` / `reverse` / `direct` / `ssh` 精确计量 CDP `rx/tx/requests/duration_sec` 与活跃会话数，Docker 边缘节点每 10s 采集 `/proc/net/dev`、Windows 桌面客户端每 10s 采集隧道与 CDP 转发真实流量并发起 `metrics_report` 上报，最终按小时汇总写入 `traffic_stats`；
   - 全新空库首次打开控制台自动触发 **4 步图形化安装向导**（支持数据库连通性测试、Redis 测试、管理员设密与 TOFU 默认策略初始化，写入 `/data/bootstrap.json`）。
7. **闭源二进制构建 + Cloudflare CDN 与界面加载加速**：
   - Hub 后端 (`chromium-sync`) 与边缘节点客户端 (`/opt/edge-node-client`) 均通过 Cython 编译为原生 `.so` 动态库与剥离符号的 ELF 可执行文件，运行时镜像不保留 `.py` / `.pyc` 源码（保留 `openssh-client` 供单用户 SSH 隧道使用）；
   - 服务端默认启用 `GZipMiddleware`、`Cache-Control` 精细分层头（`/assets/` `max-age=31536000, immutable`；HTML `no-cache`；`/api/` `/cdp/` `no-store`）以及 `CF-Connecting-IP` / `True-Client-IP` / `CF-Visitor` 穿透解析；前端 Vite 分块（`vue` 独立 chunk）+ `defineAsyncComponent` 按需懒加载，显著降低 Cloudflare 回源耗时；
   - Hub 端已彻底移除所有收藏夹相关代码与同步处理逻辑（仅 Android 端独立保留手机本地收藏夹，不同步 Hub）。
8. **Hub 全链路防刷、防爆破与 TOFU 防洪水体系**：
   - 基于现有 **Redis + SQLite Cache** 原子滑动固定窗口计数器 (`incr_window`)，无需额外外部组件即可跨请求/重启持久化防刷状态；
   - **登录与密钥防爆破**：`/api/captcha` / `/api/login` 限流 + 连续错误 5 次自动递增封禁 IP+账号；`API-Key` 与 `JOIN_TOKEN` 使用 `secrets.compare_digest` 恒定时间比对，连续猜错自动拉黑来源 IP；
   - **TOFU 防洪水与 SSRF 护盾**：限制全局及单 IP 待审批 TOFU 节点配额（防垃圾节点写满数据库）、WebSocket 握手前前置校验封禁与单 IP 并发隧道上限、`detect-mode` 限流与回落探测公网 IP 强制校验、`audit.jsonl` 超 5MB 自动轮转防撑爆磁盘。

---

## 🔐 宿主机映射目录权限与宝塔证书说明

### 1. 默认 `Root-Init-Drop` 模式（开箱兼容宝塔 0600 证书）

三个容器均采用业内主流的 **启动瞬间 Root 初始化 + `exec gosu` 降权至 UID 1000** 架构：
* **安全边界**：在打开任何监听端口前完成初始化，`exec gosu` 会彻底替换掉 root shell，容器中不存在任何常驻 root 业务进程；
* **宝塔 / Let's Encrypt 证书零改动兼容**：
  * **一体直连模式（默认 `HUB_SERVE_FRONTEND=true`）**：后端挂载 `-v /www/server/panel/vhost/cert/yourdomain.com:/certs:ro`，`entrypoint.sh` 复制至内部 `/etc/ssl/app/` 并转为 `UID 1000 (600)` 读取，**绝对不触碰宿主机原目录属主**；
  * **前后端分离模式（`HUB_SERVE_FRONTEND=false`）**：后端彻底跳过 `/certs` 扫描与 TLS 初始化，仅以明文 HTTP/WS 运行；SSL 证书直接由 **宿主机 Nginx / 宝塔 / 1Panel 面板** 配置。
* **数据卷自动自愈**：启动自动校准 `/data` 属主为 `1000:1000`，避免因宿主机以 `root` 建目录导致 SQLite WAL (`attempt to write a readonly database`) 或 Chromium `SingletonLock` 报错。

> 若宿主机 `./data` 已有海量文件或需规范化运维，仍建议预先手动授权：`chown -R 1000:1000 ./data && chmod -R 750 ./data`。

### 2. 若需严格限制为纯非 root (`--user 1000:1000` / `--cap-drop ALL`)

若在 Kubernetes PodSecurity Restricted 或强制 `--user 1000:1000` 下运行，容器将跳过阶段 1 降权初始化，此时请在宿主机完成以下准备：

```bash
# 1. 初始化目录并授权给 UID 1000
mkdir -p ./data/keys ./data/certs ./certs
sudo chown -R 1000:1000 ./data
sudo chmod -R 750 ./data

# 2. 若需读取宿主机 0600 root 证书，通过 ACL 授权（不改原属主）或复制改属主副本：
sudo setfacl -m u:1000:rx /etc/letsencrypt/archive/yourdomain.com
sudo setfacl -m u:1000:r /etc/letsencrypt/archive/yourdomain.com/privkey*.pem
```

### 3. SELinux、Rootless Docker 与常见排查

| 场景 / 报错信息 | 原因与解决方法 |
| :--- | :--- |
| **`attempt to write a readonly database`** | 强制 `--user 1000` 运行且 `./data` 属主为 `root`；执行 `sudo chown -R 1000:1000 ./data` |
| **SELinux (`Permission denied`)** | 宿主机启用了 Enforcing 模式；Compose 卷末尾追加 `:Z`（如 `./data:/data:Z`、`./certs:/certs:ro,Z`） |
| **Rootless Docker 权限异常** | Rootless 存在 subuid 映射；执行 `docker unshare chown -R 1000:1000 ./data` |
| **私网/Docker 内网互探被拦截** | `wimotek-edge-agent` 默认禁止探测私网防 SSRF；仅内网测试时设置 `EDGE_AGENT_ALLOW_NON_PUBLIC_PROBE=true` |

---

## 🛠️ Hub 主控端快速部署 (`chromium_sync` —— 单一镜像，一个参数切换分离)

> 全程只需维护 **1 个镜像**，通过 **`HUB_SERVE_FRONTEND`** 一个参数即可在「单容器一体」与「Nginx 前后端彻底分离」之间无缝切换。

### 方式 1：默认单容器一体模式（开箱即用，兼容所有旧版配置）

默认 `HUB_SERVE_FRONTEND=true`，单容器同时托管 Vue 前端页面与内置 HTTPS/WSS 证书（挂载 `./certs` 或自动生成自签证书）：

```bash
cd chromium/chromium_sync
# 1. 使用默认 8443 端口启动（一体直连）
docker compose up -d --build

# 2. 自定义容器内外统一端口（如 9443:9443）：
HUB_PORT=9443 docker compose up -d --build

# 3. 宿主机映射不同对外端口（如 3000:8443，对外端点自动识别为 3000）：
HUB_EXTERNAL_PORT=3000 docker compose up -d --build
```

### 方式 2：前后端分离模式（推荐生产：一个参数 `HUB_SERVE_FRONTEND=false`，静态文件直接从镜像拷给 Nginx）

当需要用宿主机 Nginx / 宝塔 / 1Panel 独立托管静态前端与 HTTPS 证书时，**无需单独构建第二套镜像**，只需传 **`HUB_SERVE_FRONTEND=false`**：
- 后端自动**停止托管 `/assets` 与前端页面**，同时**自动跳过所有证书处理与自签 TLS**，仅在 `127.0.0.1:8443` 暴露纯 HTTP/WS 接口（`/api/*`、`/cdp/*`）；
- 管理员直接从容器内把打包好的 `/app/frontend/dist` 拷出交给 Nginx 站点即可（更新镜像后重新拷一次覆盖）。

```bash
cd chromium/chromium_sync

# 1. 启动纯后端模式（仅改一个参数 HUB_SERVE_FRONTEND=false，建议绑定回环 127.0.0.1）
HUB_SERVE_FRONTEND=false HUB_BIND_ADDR=127.0.0.1 docker compose up -d --build

# 2. 从容器内直接拷出前端静态产物到宿主机 Nginx / 宝塔站点目录
mkdir -p /www/wwwroot/hub.yourdomain.com
docker cp cdp_sync_manager:/app/frontend/dist/. /www/wwwroot/hub.yourdomain.com/
```

然后在 Nginx / 宝塔 / 1Panel 中为站点开启面板 SSL 证书，并配置静态托管 + `/api/` `/cdp/` 反代（完整模板见 `nginx/baota-proxy.conf.example`）：

```nginx
root /www/wwwroot/hub.yourdomain.com;
index index.html;

location /assets/ {
    expires 30d;
    add_header Cache-Control "public, immutable";
    try_files $uri =404;
}

location ~ ^/(api|cdp)/ {
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
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}

location / {
    try_files $uri $uri/ /index.html;
}
```

* **访问地址**：方式 1 为 `https://<IP或域名>:${HUB_PORT:-8443}`；方式 2 为 `https://<域名或IP>[:端口]`
* **首次安装向导**：全新部署强制在首次访问 Web UI 时进入图形化安装向导，依次配置 **SQLite / MySQL (ORM)**、**Redis / SQLite Cache**、**管理员账号密码** 与 **对外网关/TOFU 默认策略**。
* **宝塔证书挂载示例**：仅方式 1（一体直连）需挂载证书，将 `docker-compose.yml` 中 `./certs:/certs:ro` 改为 `/www/server/panel/vhost/cert/yourdomain.com:/certs:ro`；方式 2 直接在宝塔/1Panel 站点面板开启 SSL，后端不碰证书。

---

## 🚀 节点端构建与快速部署

本地手动构建节点镜像前，请先将共用 `common/edge_node_client.py`、`common/build_edge_binary.py` 与 `common/desktop/` 复制到目标节点目录（GitHub Actions 会自动执行此步骤并在容器内编译为闭源二进制 `/opt/edge-node-client`）：

```bash
cd chromium
cp common/edge_node_client.py chromium_novnc/edge_node_client.py
cp common/build_edge_binary.py chromium_novnc/build_edge_binary.py
rm -rf chromium_novnc/desktop && cp -r common/desktop chromium_novnc/desktop
docker build -t wimotek/chromium:novnc ./chromium_novnc

cp common/edge_node_client.py chromium_kasmvnc/edge_node_client.py
cp common/build_edge_binary.py chromium_kasmvnc/build_edge_binary.py
rm -rf chromium_kasmvnc/desktop && cp -r common/desktop chromium_kasmvnc/desktop
docker build -t wimotek/chromium:kasmvnc ./chromium_kasmvnc
```

### 运行 noVNC 节点（公网 WSS 9443 直连 / NAT4 自动回落反向穿透）

```bash
docker run -d \
  --name chromium-novnc \
  -p 6080:6080 \
  -p 9443:9443 \
  -e HUB_URL=https://hub.yourdomain.com:8443 \
  -e JOIN_TOKEN=hub_join_xxxxxxxxxxxxxxxxxxxx \
  -v /home/docker/chromium_novnc:/data \
  --shm-size="2gb" \
  --restart unless-stopped \
  wimotek/chromium:novnc
```

> 若宿主机将容器内 `9443` 映射到其他外部端口（如 `-p 19443:9443`），传入 `-e EDGE_WSS_EXTERNAL_PORT=19443`，Hub 将对外部端口执行并发 TCP 三次握手并自动完成 `public_wss` 鉴权建连（不可达则自动转 `reverse` 反向穿透）。

---

## ⚙️ 节点与 Hub 新增/核心环境变量

| 环境变量 | 适用端 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `HUB_URL` | Node | *(空)* | Hub 地址，填入后激活 `edge_node_client.py` |
| `JOIN_TOKEN` | Node | *(空)* | 集群入网通行码，留空走 TOFU 待审 |
| `REVERSE_TUNNEL` | Node | *(auto)* | 留空智能探测 WSS 端口；`true` 强制反连；`false` 强制公网 WSS 直连 |
| `PUBLIC_IPV4` / `PUBLIC_IPV6` | Node | 自动嗅探 | 上报供 Hub TCP 探测的公网 IPv4 / IPv6 |
| `EDGE_WSS_PORT` | Node | `9443` | 节点内置加密鉴权 WSS 服务端监听端口 |
| `EDGE_WSS_EXTERNAL_PORT` | Node | `EDGE_WSS_PORT` | 宿主机对外映射的 WSS 端口（兼容旧参数 `DIRECT_PORT`） |
| `CDP_FORWARD_PORT` | Node | *(空，不启用)* | 仅显式设置时才启用 `socat` 将指定端口（填 `true` 默认 `9223`）转发至 `127.0.0.1:9222`（亦支持 `ENABLE_CDP_FORWARD=true`） |
| `HUB_PORT` | Hub | `8443` | Hub 容器内部监听端口（同步 `HEALTHCHECK`） |
| `HUB_SERVE_FRONTEND` | Hub | `true` | **核心分离开关**：`true`=一体容器（托管前端+内置TLS）；`false`=前后端分离（仅纯后端 HTTP/WS API，跳过证书处理，静态资源用 `docker cp` 拷出给 Nginx） |
| `HUB_BIND_ADDR` / `HUB_HOST_PORT` | Hub | `0.0.0.0` / `HUB_PORT` | Compose 宿主机绑定 IP 与映射端口（前置 Nginx 时建议设 `HUB_BIND_ADDR=127.0.0.1`） |
| `HUB_EXTERNAL_PORT` | Hub | 自动推导 | 宿主机对外映射端口（如 `-p 3000:8443` 时填 `3000`；不填也会从 `Host` / `X-Forwarded-Port` 请求头自动识别） |
| `HUB_PUBLIC_HOST` | Hub | *(空)* | 强制指定对外拼接域名/IP（适用于多级反代改写 `Host` 头时） |
| `HUB_HOST` | Hub | `::` | 默认同时监听 IPv4 + IPv6 双栈（容器未开启 IPv6 时自动回退 `0.0.0.0`） |
| `DB_TYPE` / `DATABASE_URL` | Hub | `sqlite` / *(空)* | 主库 ORM 驱动类型（`sqlite` 或 `mysql`），也可直接传完整 SQLAlchemy 连接串 |
| `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE` | Hub | `127.0.0.1` / `3306` / `root` / *(空)* / `chromium_sync` | `DB_TYPE=mysql` 时的 PyMySQL (`utf8mb4`) 默认连接参数 |
| `REDIS_URL` | Hub | *(空)* | 可选 Redis 缓存连接串（如 `redis://127.0.0.1:6379/0`）；留空或不可达时自动回退 `/data/cache.db` |
| `UVICORN_ACCESS_LOG` | Hub | `false` | 是否输出 Uvicorn HTTP 访问日志（默认关闭以免前端 3s 轮询与健康检查刷屏） |
| `EDGE_AGENT_ALLOW_NON_PUBLIC_PROBE` | Hub | `false` | 是否允许探测内网/私网 IP（生产公网务必保持 `false` 防 SSRF） |
| `EDGE_AGENT_NETWORK_PROBE_TIMEOUT_SECONDS` | Hub | `2.0` | Hub TCP 三次握手探测超时秒数 |
| `EDGE_AGENT_SESSION_TICKET_TTL_SECONDS` | Hub | `300` | Session Ticket 有效期（秒） |
| `HUB_RATE_LIMIT_ENABLED` | Hub | `true` | 是否开启 Hub 全局与细粒度防刷保护（设 `false` 可一键旁路） |
| `RATE_LIMIT_GLOBAL_PER_MIN` / `RATE_LIMIT_API_V1_PER_MIN` | Hub | `360` / `240` | 单 IP 每分钟全局 `/api/*` 及开放 API (`/api/v1/*`) 限流阈值 |
| `RATE_LIMIT_DETECT_PER_MIN` / `RATE_LIMIT_REGISTER_PER_MIN` | Hub | `20` / `40` | 单 IP 每分钟网络探测 (`detect-mode`) 与节点注册/WS建连上限 |
| `LOGIN_MAX_FAILURES` / `LOGIN_BLOCK_SECONDS` | Hub | `5` / `300` | 登录连续失败锁定阈值与基础封禁秒数（`API_KEY_MAX_FAILURES=15`、`JOIN_TOKEN_MAX_FAILURES=8`） |
| `MAX_PENDING_TOFU_NODES` / `MAX_PENDING_TOFU_PER_IP` | Hub | `200` / `10` | 待审批 TOFU 队列全局上限与单 IP 建档配额，防止垃圾节点洪水 |
| `MAX_WS_TUNNELS_PER_IP` / `MAX_WS_CDP_PER_IP` | Hub | `60` / `60` | 单 IP 最大并发反向 WS 隧道数与 CDP 网关会话数 |

---

## 🤖 外部 Playwright & OpenClaw 远程调试调用 (支持直连与 NAT4 反向穿透)

### 1. 网关协议与鉴权方式
* **支持端点**：
  * `GET /cdp/{node_id}/json/version`（CDP 版本与 `webSocketDebuggerUrl` 发现）
  * `GET /cdp/{node_id}/json/list` 与 `/cdp/{node_id}/json`（标签页列表探测，兼容 `https://` 模式 `cdpUrl`）
  * `WS /cdp/{node_id}/ws?api_key=<API_KEY>`（全双工 CDP 调试通道）
* **支持鉴权**：`X-API-Key: <API_KEY>`、`Authorization: Bearer <API_KEY>`、`?api_key=<API_KEY>` 或 `?token=<API_KEY>`。

### 2. OpenClaw 快速接入（改设置直连 vs 使用 Skill 动态调度）

1. **方式 A：只连固定单节点（仅改 `~/.openclaw/openclaw.json`，无需 Skill）**
   ```json5
   {
     "browser": {
       "enabled": true,
       "defaultProfile": "chromium-hub-node1",
       "remoteCdpTimeoutMs": 5000,
       "remoteCdpHandshakeTimeoutMs": 8000,
       "profiles": {
         "chromium-hub-node1": {
           "cdpUrl": "wss://hub.yourdomain.com:8443/cdp/1/ws?api_key=cdp_xxxxxxxxxxxxxxxxxxxx",
           // 亦支持 HTTPS 自动探测（/json/version + /json/list）：
           // "cdpUrl": "https://hub.yourdomain.com:8443/cdp/1?api_key=cdp_xxxxxxxxxxxxxxxxxxxx",
           "attachOnly": true
         }
       }
     }
   }
   ```

2. **方式 B：多节点随机/轮询与带 Cookie 采集（导入 Skill `chromium-cdp-hub`）**
   将仓库中的 `chromium/openclaw-skill/chromium-cdp-hub` 复制到 `~/.openclaw/skills/chromium-cdp-hub`，配置 `CHROMIUM_HUB_URL` 与 `CHROMIUM_HUB_API_KEY` 环境变量后即可在对话或脚本中运行：
   * **无 Cookie 匿名采集**：`python3 scripts/hub_pool.py crawl --url "https://example.com" --mode anon --strategy round-robin`
   * **带 Cookie 登录态采集**：`python3 scripts/hub_pool.py crawl --url "https://target.example.com" --mode cookie --cookie-source-node 1 --strategy random`

### 3. Python Playwright 代码示例

```python
import asyncio
from playwright.async_api import async_playwright

API_KEY = "cdp_xxxxxxxxxxxxxxxxxxxx"  # 在 Hub 控制台获取
HUB_HOST = "hub.yourdomain.com:8443"
NODE_ID = 1  # 目标节点 ID（同时兼容直连、IPv6 及 NAT4 反向隧道节点）

async def main():
    async with async_playwright() as p:
        cdp_url = f"wss://{HUB_HOST}/cdp/{NODE_ID}/ws?api_key={API_KEY}"
        browser = await p.chromium.connect_over_cdp(cdp_url)
        page = await browser.new_page()
        await page.goto("https://example.com")
        print("Page Title:", await page.title())
        await browser.close()

asyncio.run(main())
```