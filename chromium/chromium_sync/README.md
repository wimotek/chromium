# ⚡ Chromium Distributed CDP Cluster & Cookie Synchronization Hub

分布式 Chromium 节点集群治理、多策略 Cookie 调度与安全 WSS 远程调试代理网关。

---

## 🌟 核心特性与架构升级

1. **`wimotek-edge-agent >= 1.0.17` 深度集成与 TCP 三次握手实测**：
   - 节点启动时自动采集公网 IPv4 / IPv6 与映射端口 (`public_ipv4`, `public_ipv4_port`, `public_ipv6`, `public_ipv6_port`) 上传至 Hub (`POST /api/nodes/detect-mode` 或反向隧道握手)；
   - Hub 调用 `wimotek_edge_agent.nat.detect_network_mode` 并发执行异步 **TCP 三次握手**（内置 SSRF 私网拦截，无需 ICMP 权限），判定 `network_mode`（`direct_dual` / `direct_ipv4` / `direct_ipv6` / `reverse_tunnel`）与最佳低延迟端点 `recommended_endpoint` 并实时回传至节点；
   - NAT4 / 家宽 / 防火墙节点自动回落到 `/api/nodes/reverse-tunnel` WSS 反向长连接，网关 `/cdp/{node_id}/ws` 原生支持多路复用 `cdp_ws_open` / `cdp_ws_frame` / `cdp_ws_close`，Playwright / Puppeteer 可直接穿透控制内网节点。
2. **零信任准入控制与 Session Ticket**：
   - 严格使用 `secrets.compare_digest` 校验 `JOIN_TOKEN` 与 `SessionTicketManager` 签发的短时复用凭据（默认 300 秒 TTL）；
   - 未提供 Token 时进入 TOFU 待审隔离区，管理员在控制台审批放行后通过反向信道即时下发通行指令与最新 `network_mode`。
3. **三镜像统一安全加固（`dumb-init` + Root-Init-Drop `gosu` -> `UID 1000` + Multi-stage 瘦身）**：
   - Hub (`chromium_sync`) 与节点 (`chromium_novnc` / `chromium_kasmvnc`) 均在启动阶段短暂以 `root` 自愈 `/data` 权限并将宿主机宝塔/Certbot `/certs` 安全拷贝到容器内 `/etc/ssl/app`（绝不改动宿主机 `/certs` 权限），随后立即 `exec gosu` 降权为 `UID/GID 1000` 非特权运行业务进程；
   - 多阶段构建隔离前端 Node 与后端 `/opt/venv`，剔除冗余工具并全栈内建 Python 原生 `HEALTHCHECK`。
4. **多策略 Cookie 调度中枢与安全 WSS 网关 (`8443`)**：
   - 支持智能双向合并 (Smart Merge)、组对组、节点对组及自动清理熔断，原生支持 RFC 2732 IPv6 `[host]:port` CDP 连接。

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
docker compose up -d --build
```

* **访问地址**：`https://<服务器IP或域名>:8443`
* **默认账号密码**：`admin` / `Admin@123456`（由 `docker-compose.yml` 中 `ADMIN_INIT_PASS` 控制）
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

### 运行 noVNC 节点（自适应 TCP 探测 / NAT4 穿透）

```bash
docker run -d \
  --name chromium-novnc \
  -p 6080:6080 \
  -p 9222:9222 \
  -e HUB_URL=https://hub.yourdomain.com:8443 \
  -e JOIN_TOKEN=hub_join_xxxxxxxxxxxxxxxxxxxx \
  -e DIRECT_PORT=9222 \
  -v ./novnc_data:/data \
  --shm-size="2gb" \
  --restart unless-stopped \
  wimotek/chromium:novnc
```

> 若节点拥有公网 IPv6/IPv4 且宿主机映射到自定义端口（如 `-p 1922:9222`），传入 `DIRECT_PORT=1922`（或分别设置 `PUBLIC_IPV4` / `PUBLIC_IPV4_PORT` / `PUBLIC_IPV6` / `PUBLIC_IPV6_PORT`），Hub 将通过并发 TCP 三次握手实测并回传最优选路 `network_mode`。

---

## ⚙️ 节点与 Hub 新增/核心环境变量

| 环境变量 | 适用端 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `HUB_URL` | Node | *(空)* | Hub 地址，填入后激活 `edge_node_client.py` |
| `JOIN_TOKEN` | Node | *(空)* | 集群入网通行码，留空走 TOFU 待审 |
| `REVERSE_TUNNEL` | Node | *(auto)* | 留空智能探测；`true` 强制反连；`false` 强制直连 |
| `PUBLIC_IPV4` / `PUBLIC_IPV4_PORT` | Node | 自动嗅探 | 上报供 Hub TCP 探测的公网 IPv4 及外部端口 |
| `PUBLIC_IPV6` / `PUBLIC_IPV6_PORT` | Node | 自动嗅探 | 上报供 Hub TCP 探测的公网 IPv6 及外部端口 |
| `DIRECT_PORT` | Node | `9222` | 宿主机对外映射的 CDP 端口 |
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