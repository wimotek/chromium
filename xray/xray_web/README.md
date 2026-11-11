# Xray Reality 分布式多节点管理中枢 (Xray-Web & Xray-Core)

基于 **Xray-core (VLESS-REALITY-Vision / WSS 反向打洞隧道)** 打造的高性能分布式节点管理与商业化运营中枢。

系统采用 **Master-Agent（主控中心 - 边缘工作节点）解耦架构**：
* **`xray_web` (主控端)**：轻量化 Web 管理面板，负责用户生命周期、数据库、卡密核销、邮件通知、聚合订阅下发、TOFU 首次信任准入与 WSS 反向隧道网关调度；
* **`xray_core` (节点端)**：模块化 Python 异步守护容器（`python3 -m app`），部署于任意海外 VPS 或家庭内网主机，支持公网直连与 NAT4 反穿自适应。

---

## 🌟 核心特性

- 🌐 **公网直连 + NAT4 反穿双模支持**：
  - **公网节点 (Direct)**：默认启用 VLESS-REALITY-Vision，抗封锁性能优异，客户端直连低延迟；
  - **NAT4 / 无公网节点 (Reverse WSS)**：通过 WebSocket 隧道主动反向连回 Hub，免公网 IP，免端口映射。
- 🔄 **点阅订阅地址自动透明分流**：
  - 用户只需导入一个聚合订阅地址（`/api/sub?token=用户UUID`）；
  - Hub 端自动识别节点网络属性：公网节点下发 REALITY 链接，NAT4 节点自动转化为 Hub 域名的 WSS 链接，用户更新订阅即开即用！
- 🛡️ **TOFU (Trust-On-First-Use) 首次准入与审计隔离**：
  - 具备 **TOFU 首次信任总开关** 与 **免审自动准入子开关**；
  - 未知新节点接入自动进入【待审隔离区】，经管理员人工审批或引导令牌验证后方可生效并进入订阅列表；
  - 全流程记录【节点安全审计流水】。
- 🐍 **集成官方 PyPI 模块 `wimotek-edge-agent`**：
  - 规范引入标准 Python 库，使用高强度 Compact 40-char HMAC 令牌与防重放机制。
- 🔑 **通信密钥自动握手与动态轮换**：
  - 节点首次握手自动分配专属永久 `node_key`；后台支持一键轮换密钥，下次心跳自动同步生效。
- 🔄 **多种套餐计费与卡密系统**：
  - 普通固定套餐、每月固定重置卡（支持微信/邮件清零推送）、无限量/永久有效；
  - 支持方案 C 第三方发卡网 API 实时出卡（兼容独角数卡）。
- ⏰ **增量流量结算与智能预警**：
  - 节点定时通过 Stats API 采集用户增量流量并精确回传；
  - 支持 **SMTP 邮件** 与 **Server酱·Turbo（微信推送）** 双通道额度预警。

---

## 🚀 部署指南

### 第一步：部署 `xray_web` 主控端

> 建议部署在连接性良好的 Linux VPS（主控使用 HTTPS 8443 原生 TLS 端口，若承接 WSS 反穿可配置 443 Nginx 反代）。

1. **克隆项目到服务器**：
   ```bash
   git clone https://github.com/wimotek/chromium.git
   cd chromium/xray/xray_web
   ```

2. **检查或修改 `docker-compose.yml`**：
   ```yaml
   services:
     xray-web:
       build:
         context: .
         dockerfile: Dockerfile
       container_name: xray-web-master
       restart: unless-stopped
       network_mode: "host"
       environment:
         - TZ=Asia/Shanghai
         - APP_MODE=all
         - WEB_PORT=8443
         - NODE_KEY=xray_cluster_secret_key_2026   # 集群通信引导令牌 (可自定义)
       volumes:
         - ./data:/data
         - ./certs:/certs:ro                      # 可选挂载外部权威证书 (自动同步至 /app/certs)
   ```

3. **启动主控容器**：
   ```bash
   docker compose up -d --build
   ```

4. **登录主控面板**：
   - 访问地址：`https://<主控服务器IP>:8443`
   - 查看初始管理员账密：
     ```bash
     docker logs xray-web-master | grep "初始管理员凭据" -A 3
     ```
   - 登录后台后，可在【系统发信与全局运维配置】中配置发件 SMTP 邮箱、节点通信密钥与系统公告。

---

### 第二步：在任意节点 VPS / 家宽主机接入 `xray_core`

节点镜像采用纯 Python 异步三层看门狗架构（`python3 -m app`），单条指令即可接入：

```bash
docker run -d \
  --name xray-node \
  --restart always \
  --network host \
  -e PANEL_URL="https://<主控服务器IP>:8443" \
  -e CLUSTER_TOKEN="xray_cluster_secret_key_2026" \
  -e NET_MODE="auto" \
  -e PORT=443 \
  -e DEST="www.microsoft.com:443" \
  -e SERVER_NAMES="www.microsoft.com,microsoft.com" \
  -v $(pwd)/data:/data \
  ghcr.io/wimotek/xray:latest
```

#### 环境变量说明：
| 变量名 | 说明 | 默认值 / 示例 |
| :--- | :--- | :--- |
| `PANEL_URL` | **[必填]** 主控 `xray_web` 的访问地址 | `https://1.2.3.4:8443` |
| `CLUSTER_TOKEN` | **[必填]** 集群通信引导令牌（用于首次 TOFU 准入） | `xray_cluster_secret_key_2026` |
| `NET_MODE` | 网络模式：`auto`（自动探测）、`direct`（直连）、`reverse_wss`（反穿） | `auto` |
| `PORT` | 节点 Reality 监听端口 | `443` |
| `DEST` | 伪装目标回落地址 | `www.microsoft.com:443` |
| `SERVER_NAMES` | 伪装域名列表 (逗号分隔) | `www.microsoft.com,microsoft.com` |

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