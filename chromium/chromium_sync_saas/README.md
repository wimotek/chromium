# Chromium Sync SaaS — 重度多租户 / 对外商业运营版 Hub

`chromium_sync_saas` 是独立演进的企业级多租户 SaaS 主控中心，保留原有轻量单用户版 [`chromium_sync`](../chromium_sync/) 原封不动，面向 **对外开放运营、多租户隔离、节点算力共享变现与严苛合规审计** 场景重构。

---

## 🎯 与单用户版 (`chromium_sync`) 的核心差异

| 维度 | 轻量单用户版 (`chromium_sync`) | 重度多租户 SaaS 版 (`chromium_sync_saas`) |
| :--- | :--- | :--- |
| **入网鉴权** | 单集群 `cluster_join_token` + TOFU 审批队列 | **彻底移除 TOFU**：强制携带租户专属 `JOIN_TOKEN` 或强绑定 `SessionTicket` 入网 |
| **用户体系** | 单管理员账号 | **公开注册 + 图形验证码 + RBAC (`user`/`admin`) + 启停封禁** |
| **套餐配额** | 无配额限制 | Starter / Pro / Enterprise 三档套餐，限制节点数、并发租约、月流量与抽成折扣 |
| **节点变现市场** | 无 | **卖家上架定价 → 买家按时租+流量付费 → 平台赚取买卖差价 (`saas_platform_fee_bps`)** |
| **资源与会话隔离** | 全局统一策略同步 | 租户隔离池 + **出租中节点自动从同步/清理中豁免** + `/cookies` 对买家锁定 `403` |
| **审计追踪** | 节点接入 JSONL 文件 | **双写不可篡改 `AuditLog` ORM 表 + 滚动 `/data/audit.jsonl`**，支持筛选与导出 |

---

## 💰 节点共享与平台差价计费模型

1. **卖家设定底价**：节点所有者在「我的节点 → 共享定价」设置时租底价（元/小时）与流量底价（元/GB），默认采用 `exclusive_slot`（独占槽位 `max_concurrent_leases = 1`）。
2. **平台加价产生差价**：对外展示给买家的单价为：
   $$\text{BuyerPrice} = \text{SellerPrice} + \lceil \text{SellerPrice} \times \frac{\text{platform\_fee\_bps} - \text{buyer\_discount\_bps}}{10000} \rceil$$
   例如平台默认抽成 `2000 bps (20%)`，卖家挂 `0.50 元/小时` + `1.00 元/GB`，普通买家实付 `0.60 元/小时` + `1.20 元/GB`；每 15 秒结算一次，卖家账户获得 `0.50` 率分成，平台赚取 `0.10` 率差价利润。
3. **余额耗尽自动退租断流**：后台 `billing_settlement_loop` 采用整厘（`1 元 = 10000 units`）累计计费法杜绝浮点/短周期误差；一旦买家余额清零，自动将租约置为 `exhausted`，释放槽位并立即切断买家的 CDP WebSocket 会话。

---

## 🔒 共享节点与同步策略的隐私安全红线

1. **为什么 SaaS 版彻底移除了 TOFU？**  
   对外开放的公网 SaaS 环境存在恶意脚本批量探测。若保留未鉴权挂起队列，会造成数据库泛洪与多租户归属歧义。SaaS 版要求任何边缘节点连接（HTTP `auto-register` 或 WS `reverse-tunnel`）必须凭**归属用户的专属 `cluster_join_token`** 或**带 `owner_id` 签名的 `SessionTicket`**，并严禁不同租户抢占同一 `node_uuid`。
2. **个人 Cookie 同步与共享出租如何隔离？**
   * `SyncPolicy`、`SyncLog`、`Bookmark`、`SshKey` 全部按 `owner_id` 强隔离，只作用于租户自有节点；
   * 同步与清理任务在执行前会过滤掉所有 `active_lease_count > 0` 的共享出租中节点，防止卖家个人登录态误同步进买家会话，也防止卖家反过来吸取买家操作产生的 Cookie；
   * `/api/v1/nodes/{id}/cookies` 与 `/cookie-details` 对买家一律返回 `403`，卖家在节点出租期间亦禁止读取实时 Cookie，买家仅能在活跃租约期内接入 `/cdp/{node_id}/ws` 控制浏览器。
3. **单节点多开独立 Profile 的资源开销与稳定性建议**：
   * 每个独立 Chromium Profile（含渲染进程 + GPU/网络进程 + 磁盘缓存）稳定态约占用 **350MB ~ 800MB RAM**；
   * 若在单台宿主上为大量连接并发开多份独立 Profile，极易 OOM 并引发进程间端口/锁竞争；
   * 因此 SaaS 版默认采用 **`exclusive_slot`（单节点同时仅 1 路独占租约）**，仅当节点运行于高配多核容器或独立沙箱环境时才建议启用 `ephemeral_profile` 并通过 `max_concurrent_leases`（1~8）限流。

---

## 🚀 快速部署（预构建闭源镜像 & 支持 `HUB_SERVE_FRONTEND` 前后端分离）

### 方式一：直接拉取 GitHub Actions 构建的多架构闭源二进制镜像（推荐）

镜像由 `.github/workflows/build-saas-hub.yml` 自动构建并推送至：

* **Docker Hub**: `wimotek/chromium:saas`
* **GitHub Container Registry (GHCR)**: `ghcr.io/wimotek/chromium:saas`

> 若在个人仓库触发 GitHub Actions 同步推送 Docker Hub，请在仓库 **Settings → Secrets and variables → Actions** 中配置 `DOCKERHUB_TOKEN`（Access Token）及可选 `DOCKERHUB_USERNAME`（默认 `wimotek`）；GHCR 默认使用内置 `GITHUB_TOKEN` 自动推送。

```bash
docker run -d --name cdp_sync_saas_hub --restart unless-stopped \
  -p 8443:8443 -p 19200-19250:19200-19250 \
  -v $(pwd)/data:/data -v $(pwd)/certs:/certs:ro \
  wimotek/chromium:saas
```

### 方式二：本地源码构建

```bash
cd chromium/chromium_sync_saas
docker compose up -d --build
```

* 默认一体模式（`HUB_SERVE_FRONTEND=true`）：访问 `https://<IP>:8443` 进入首次安装向导。
* 前后端分离模式（`HUB_SERVE_FRONTEND=false`）：容器以内部明文 HTTP/WS 监听 `8443`，由 Nginx / 管理面板配置域名 TLS 与静态资源（从镜像 `/app/frontend/dist` 拷贝导出即可）。

---

## 🛡️ 闭源二进制构建与性能说明

* **闭源构建架构**：`Dockerfile` 阶段二通过 `app/backend/build_binary.py` 将 SaaS 后端全部业务模块（`app` / `config` / `core/*` / `services/*` / `routers/*`）经 Cython 编译为原生 `.so` 动态库并 `strip --strip-unneeded` 剥离调试符号，同时编译生成原生 ELF 启动器 `/app/backend/chromium-sync-saas`；最终运行镜像 `/app/backend` 中**不包含任何 `.py` / `.pyc` / `.c` 源码文件**，前端则为 Vite 编译混淆后的静态产物。
* **关于运行速度**：编译成二进制后**整体并发吞吐不会暴涨（纯 Python 热路径约有 1.2x~3x 提速，整体接口响应提升约 5%~15%）**，原因在于本项目的重计算与高并发核心（`uvicorn`/`uvloop`/`httptools`、`pydantic-core` Rust、`cryptography`/`bcrypt` C/Rust、SQLite/MySQL 驱动）本就已是原生扩展，SaaS Hub 真正耗时的是 WebSocket/CDP 网络 I/O 与数据库交互；因此该机制的核心价值在于**商业闭源防反编译保护**与**精简启动路径**，若需大幅提升高并发吞吐，应优先开启 **MySQL + Redis** 与生产级负载均衡。

