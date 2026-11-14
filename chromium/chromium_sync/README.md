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

---

## 🔐 宿主机映射目录权限与宝塔证书说明

### 1. 默认 `Root-Init-Drop` 模式（开箱兼容宝塔 0600 证书）

三个容器均采用业内主流的 **启动瞬间 Root 初始化 + `exec gosu` 降权至 UID 1000** 架构：
* **安全边界**：在打开任何监听端口前完成初始化，`exec gosu` 会彻底替换掉 root shell，容器中不存在任何常驻 root 业务进程；
* **宝塔 / Let's Encrypt 证书零改动兼容**：可直接只读挂载宿主机 `-v /www/server/panel/vhost/cert/yourdomain.com:/certs:ro`（即使私钥权限为 `0600 root:root`），容器会将其安全复制至内部 `/etc/ssl/app/` 并转为 `UID 1000 (600)` 读取，**绝对不触碰宿主机原目录属主**；
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

## 🛠️ Hub 主控端快速部署 (`chromium_sync`)

```bash
cd chromium/chromium_sync
# 1. 使用默认 8443 端口启动
docker compose up -d --build

# 2. 自定义容器内外统一端口（如 9443:9443）：
HUB_PORT=9443 docker compose up -d --build

# 3. 宿主机映射不同对外端口（如 3000:8443，容器内仍监听 8443，对外端点自动识别为 3000）：
HUB_EXTERNAL_PORT=3000 docker compose up -d --build
```

* **访问地址**：`https://<服务器IP或域名>:${HUB_PORT:-8443}`
* **默认账号密码**：`admin` / `123456`（可选参数 `ADMIN_INIT_USER` / `ADMIN_INIT_PASS` 控制，仅首次初始化 `/data/app.db` 时生效）
* **宝塔证书挂载示例**：将 `docker-compose.yml` 中 `./certs:/certs:ro` 改为 `/www/server/panel/vhost/cert/yourdomain.com:/certs:ro` 即可。

---

## 🚀 节点端构建与快速部署

本地手动构建节点镜像前，请先将共用 `common/edge_node_client.py` 复制到目标节点目录（GitHub Actions 会自动执行此步骤）：

```bash
cd chromium
cp common/edge_node_client.py chromium_novnc/edge_node_client.py
docker build -t wimotek/chromium:novnc ./chromium_novnc

cp common/edge_node_client.py chromium_kasmvnc/edge_node_client.py
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
| `HUB_PORT` | Hub | `8443` | Hub 容器内部 HTTPS/WSS 监听端口（同步 `HEALTHCHECK`） |
| `HUB_EXTERNAL_PORT` | Hub | 自动推导 | 宿主机对外映射端口（如 `-p 3000:8443` 时填 `3000`；不填也会从 `Host` / `X-Forwarded-Port` 请求头自动识别） |
| `HUB_PUBLIC_HOST` | Hub | *(空)* | 强制指定对外拼接域名/IP（适用于多级反代改写 `Host` 头时） |
| `HUB_HOST` | Hub | `::` | 默认同时监听 IPv4 + IPv6 双栈（容器未开启 IPv6 时自动回退 `0.0.0.0`） |
| `ADMIN_INIT_USER` / `ADMIN_INIT_PASS` | Hub | `admin` / `123456` | 可选参数；首次初始化空库时的管理员账号与密码（已存在库或已改密则不覆盖） |
| `UVICORN_ACCESS_LOG` | Hub | `false` | 是否输出 Uvicorn HTTP 访问日志（默认关闭以免前端 3s 轮询与健康检查刷屏） |
| `EDGE_AGENT_ALLOW_NON_PUBLIC_PROBE` | Hub | `false` | 是否允许探测内网/私网 IP（生产公网务必保持 `false` 防 SSRF） |
| `EDGE_AGENT_NETWORK_PROBE_TIMEOUT_SECONDS` | Hub | `2.0` | Hub TCP 三次握手探测超时秒数 |
| `EDGE_AGENT_SESSION_TICKET_TTL_SECONDS` | Hub | `300` | Session Ticket 有效期（秒） |

---

## 🤖 外部 Playwright 远程调试调用 (支持直连与 NAT4 反向穿透)

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