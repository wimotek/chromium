# Chromium Sync SaaS — 重度多租户 / 对外商业运营版 Hub

`chromium_sync_saas` 是独立演进的企业级多租户 SaaS 主控中心，保留原有轻量单用户版 [`chromium_sync`](../chromium_sync/) 原封不动，面向 **对外开放运营、多租户隔离、纯 WSS 节点算力共享变现、自用双计费、推广领券充值与严苛合规审计** 场景重构。

---

## 🎯 与单用户版 (`chromium_sync`) 的核心差异

| 维度 | 轻量单用户版 (`chromium_sync`) | 重度多租户 SaaS 版 (`chromium_sync_saas`) |
| :--- | :--- | :--- |
| **入网鉴权** | 单集群 `cluster_join_token` + TOFU 审批队列 | **彻底移除 TOFU**：强制携带租户专属 `JOIN_TOKEN` 或强绑定 `SessionTicket` 入网 |
| **用户体系** | 单管理员账号 | **公开注册 + 图形验证码 + RBAC (`user`/`admin`) + 启停封禁** |
| **节点接入通道** | `public_wss` / `reverse` / `direct` / `ssh` | **仅保留 `public_wss`（WSS 直连）与 `reverse`（WSS 反向穿透）**；彻底移除本地 `direct` (`127.0.0.1`) 与 `ssh` 隧道 |
| **套餐与自用计费** | 无计费系统 | Starter / Pro / Enterprise 套餐配额 + **自用分模式计费**（直连 ¥0，反穿按 Hub 流量单价计费） |
| **推广与充值系统** | 无 | **每月固定领取 + 每日签到奖励 + 支付宝 / 微信收款订单、异步回调验签与后台人工核销** |
| **资源与会话隔离** | 全局统一策略同步 | 租户隔离池 + 出租节点 cookie 接口锁定 `403` + 自动排除出租中节点同步 |
| **审计追踪** | 节点接入 JSONL 文件 | **双写不可篡改 `AuditLog` ORM 表 + 滚动 `/data/audit.jsonl`**，支持筛选与导出 |

---

## 💰 纯 WSS 通道差价、自用分拆计费与推广充值体系

1. **为什么仅保留 `public_wss` 与 `reverse`（彻底移除 `direct` 与 `ssh` 隧道）？**  
   多租户云端 Hub 运行在独立服务器上，`127.0.0.1` 回环地址以及将其映射回本地的 `ssh` 隧道都不适合开放公网共享计费且易引入 SSRF 风险；因此 SaaS 版**彻底清理了 `direct` / `ssh` 通道与 SSH 密钥代码**，专注 **WSS 直连 (`public_wss`)** 与 **WSS 反向穿透 (`reverse`)**。
2. **分通道差异化平台差价（共享市场）**：
   * **WSS 反向穿透 (`reverse`)**：全程经由 Hub 中继转发，消耗 Hub 上下行带宽与长连接池，平台加价较高（默认基准 `2500 bps / 25%`）；
   * **公网 WSS 直连 (`public_wss`)**：节点具备公网直连能力，Hub 仅负责鉴权调度与按量旁路结算，加价更低（默认基准 `1000 bps / 10%`）。
3. **自用节点分模式账单规则**：
   * **使用自有 `public_wss` 直连节点**：节点费 ¥0、Hub 中继流量费 ¥0，账单记录清晰展示 **0 元**（免扣费、不因余额为 0 阻塞）；
   * **使用自有 `reverse` 反穿节点**：由于流量经过 Hub 网关中继，**节点租用费为 ¥0**，但**按 Hub 反向流量费率（可后台配置，如 `¥0.50 / GB`）计入账单与平台营收**；当账户可用余额清零（`<= 0`）时，Hub `/cdp/{node_id}/ws` 将返回 `402 Payment Required` 并阻断高开销反穿中继。
4. **用户等级自动升降级（在线时长 · 节点速度 · 贡献流量）**：
   * 内置四档等级（`Lv.1 青铜` → `Lv.2 白银` → `Lv.3 黄金` → `Lv.4 钻石`），后台每 60 秒按 **累计在线时长**、**平均延迟/速度** 与 **历史贡献流量** 自动升级或降级。
5. **推广福利与支付宝 / 微信充值系统**：
   * **每月固定领取 (`POST /api/billing/promo/monthly-claim`)**：每月可领取一次固定赠送额度；
   * **每日签到奖励 (`POST /api/billing/promo/daily-checkin`)**：每日可签到领取随机或固定额度（均采用数据库原子锁防并发重放刷取）；
   * **在线充值 (`POST /api/billing/recharge/create`)**：支持创建支付宝 (`alipay`) / 微信 (`wechat`) 充值订单，展示收款二维码/商户信息，支持 **HMAC-SHA256 支付回调验签自动入账**、**沙盒测试支付**（管理员开启后生效）以及 **管理员后台人工核销 (`POST /api/admin/recharges/{id}/confirm`)**。

---

## ⚡ 界面加载与 Cloudflare CDN 优化

* **服务端传输与缓存分层**：启用 `GZipMiddleware(minimum_size=500)` 自动压缩 JSON 与文本响应；针对 `/assets/*` 静态指纹资源下发 `Cache-Control: public, max-age=31536000, immutable`，HTML 入口下发 `no-cache, must-revalidate`，`/api/*` 与 `/cdp/*` 下发 `no-store` 防动态响应误缓存。
* **Cloudflare 真实 IP 与 HTTPS 协议透传**：`get_client_ip` 与 `resolve_hub_access_info` 优先识别 `CF-Connecting-IP`、`True-Client-IP` 与 `CF-Visitor` JSON 中的 `"scheme"`，避免套 CDN 后全部来源被误判为代理节点 IP 或丢失 `wss://` 协议前缀。
* **前端首屏瘦身**：Vite 开启 `es2020`、`cssCodeSplit` 与 `vue` 独立 chunk 切分，`App.vue` 通过 `defineAsyncComponent` 按标签页懒加载视图模块，显著加快 Cloudflare CDN 边缘节点回源与浏览器首屏渲染。
* **收藏夹精简**：SaaS Hub 已彻底移除所有收藏夹代码、UI 与数据库依赖（仅 Android 端独立保留手机本地收藏夹，不与 Hub 同步）。

---

## 🔒 共享节点与同步策略的隐私安全红线

1. **为什么 SaaS 版彻底移除了 TOFU？**  
   对外开放的公网 SaaS 环境存在恶意脚本批量探测。SaaS 版要求任何边缘节点连接必须凭**归属用户的专属 `cluster_join_token`** 或**带 `owner_id` 签名的 `SessionTicket`**，并严禁不同租户抢占同一 `node_uuid`。
2. **个人 Cookie 同步与共享出租如何隔离？**  
   * `SyncPolicy`、`SyncLog` 全部按 `owner_id` 强隔离，只作用于租户自有节点；
   * 同步与清理任务在执行前过滤掉 `active_lease_count > 0` 的共享出租中节点；
   * `/api/v1/nodes/{id}/cookies` 对买家返回 `403`，卖家在节点出租期间亦禁止读取实时 Cookie。
3. **单节点多开独立 Profile 的稳定性建议**：  
   SaaS 版默认采用 **`exclusive_slot`（单节点同时仅 1 路独占租约）**，避免单宿主多开引发内存 OOM 与锁竞争；高配环境按需开启 `ephemeral_profile` 并通过 `max_concurrent_leases`（1~8）限流。

---

## 🚀 快速部署（预构建闭源镜像 & 支持 `HUB_SERVE_FRONTEND` 前后端分离）

### 方式一：直接拉取 GitHub Actions 构建的多架构闭源二进制镜像（推荐）

镜像由 `.github/workflows/build_chromium_sync_saas.yml` 自动构建并推送至：

* **Docker Hub**: `wimotek/chromium:saas`
* **GitHub Container Registry (GHCR)**: `ghcr.io/wimotek/chromium:saas`

> 若在个人仓库触发 GitHub Actions 同步推送 Docker Hub，请在仓库 **Settings → Secrets and variables → Actions** 中配置 `DOCKERHUB_TOKEN` 及可选 `DOCKERHUB_USERNAME`（默认 `wimotek`）；GHCR 默认使用内置 `GITHUB_TOKEN` 自动推送。

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
