# Xray Reality 分布式多节点管理中枢 (Xray-Web & Xray-Core)

基于 **Xray-core (VLESS-REALITY-Vision / WSS 反向打洞隧道)** 打造的高性能分布式节点管理与商业化运营中枢。

系统采用 **Master-Agent（主控中心 - 边缘工作节点）彻底解耦架构**：
* **`xray_web` (主控端)**：轻量化 Web 管理面板（非 Root `UID 10001` 运行，Granian 原生支持 IPv4+IPv6 双栈 HTTPS），内置官方 **`wimotek-edge-agent`** 零信任安全引擎，负责用户生命周期、数据库备份恢复、卡密核销、邮件通知、聚合订阅下发、单次防重放 Join Token 签发与审计流水；
* **`xray_core` (节点端)**：极致精简的纯 Python 异步守护镜像（Alpine 多阶段构建 + 非 Root `UID 10001` + `dumb-init` 信号链），部署于任意海外 VPS 或家庭内网主机，专注高速 REALITY 代理与反向穿透。

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
- 💳 **多种套餐计费、发卡 API 与数据库安全备份**：
  - 支持固定流量包、每月固定重置卡（邮件/微信清零推送）、无限量/永久卡及第三方发卡网 API（兼容独角数卡）；
  - 支持后台热备份下载、外部快照导入及恢复前自动冷备与 SQLite 完整性校验。

---

## ⚠️ 非 Root 容器与宿主机挂载目录权限要求（必读）

为遵循容器最小权限安全规范，**`xray_web`（主控端）与 `xray_core`（节点端）镜像均默认以非 Root 用户 `appuser`（UID `10001` / GID `10001`）运行**。

在 Linux 宿主机使用 `-v ./xxx:/data` 绑定挂载本地目录时，若本地目录事先不存在或归属为 `root:root`，容器内的 `appuser` 将因无写入权限而直接报错启动失败（`PermissionError: [Errno 13] Permission denied`）。

### 1. 主控端 (`xray_web`) 宿主机目录授权

启动主控前请先创建并授权数据与备份目录：

```bash
mkdir -p ./data/backups ./certs
chown -R 10001:10001 ./data
```

* **`./data:/data`（读写）**：存放 `xray_web.db`、自动冷备及 `edge_agent_data/`（密钥、TrustStore、审计日志），**必须对 UID `10001` 可写**；
* **`./certs:/certs:ro`（只读，可选）**：若挂载外部商业 SSL 证书（`fullchain.pem` 与 `privkey.pem`），需确保容器内 UID `10001` 具有**读取权限**（例如执行 `chmod 755 ./certs && chmod 644 ./certs/*.pem`，或 `chown -R 10001:10001 ./certs` 后配合 `chmod 600 ./certs/privkey.pem`）。容器启动时 `cert_init` 会自动将其复制到内部 `/app/certs` 并修正为 `0644/0600`。若不挂载则自动生成 10 年期现代自签名证书。

### 2. 节点端 (`xray_core`) 宿主机目录授权

启动节点容器前，同样**必须先创建并授权 `./data` 目录**：

```bash
mkdir -p ./data
chown -R 10001:10001 ./data
```

> **提示**：如不想在宿主机手动执行 `chown`，可改用 **Docker 命名卷**（如 `xray_node_data:/data`），Docker 会自动继承镜像内 `/data` 的 `10001:10001` 权限。同时请勿为节点容器添加 `--security-opt=no-new-privileges:true`，以免屏蔽 `/usr/bin/xray` 上的 `cap_net_bind_service=+ep` 导致无法绑定 443 端口。

---

## 🚀 部署指南

### 第一步：部署 `xray_web` 主控端

> 建议部署在连接性良好的 Linux VPS（主控默认监听 `[::]:8443` 双栈原生 HTTPS TLS；若需 443 端口承接 WSS 反穿，可通过 Nginx/Caddy 反代或直接 `-e WEB_PORT=443`）。

1. **克隆项目并初始化目录权限**：
   ```bash
   git clone https://github.com/wimotek/chromium.git
   cd chromium/xray/xray_web
   mkdir -p ./data/backups ./certs
   chown -R 10001:10001 ./data
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
       environment:
         - TZ=Asia/Shanghai
         - APP_MODE=all
         - WEB_PORT=8443
         # 可选：手动强制监听地址 (默认留空则自动探测 IPv4+IPv6 双栈 "::"，禁用 IPv6 环境自动回退 "0.0.0.0")
         # - WEB_HOST=::
         - NODE_KEY=xray_cluster_secret_key_2026   # 集群通信引导令牌 (可自定义)
       volumes:
         - ./data:/data
         - ./data/backups:/data/backups
         - ./certs:/certs:ro                      # 可选挂载外部权威证书 (需 UID 10001 可读)
   ```

3. **启动主控容器**：
   ```bash
   docker compose up -d --build
   ```

4. **登录主控面板**：
   - IPv4 访问：`https://<主控IPv4>:8443`
   - IPv6 访问：`https://[<主控IPv6>]:8443`
   - 查看初始管理员账密：
     ```bash
     docker logs xray-web-master | grep "初始管理员凭据" -A 3
     ```
   - 登录后台后，可在【系统发信与全局运维配置】中配置发件 SMTP 邮箱、节点通信密钥、备份恢复与系统公告。

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

## 🌐 IPv4 + IPv6 双栈监听说明（Granian）

主控 `entrypoint.sh` 启动时会自动检测宿主机内核协议栈：
1. 若宿主机支持 IPv6 且 `net.ipv6.bindv6only=0`（Linux 默认值），Granian 自动绑定 `--host "::"`，在单个端口上**同时接管 IPv4 与 IPv6 请求**；
2. 若宿主机禁用了 IPv6（如 `ipv6.disable=1`）或开启了 `bindv6only=1`，系统会自动安全回退到 `--host 0.0.0.0`（纯 IPv4），确保容器健康检查（`HEALTHCHECK`）与控制面板 100% 正常启动不崩溃；
3. 如需强制锁定监听地址，可通过环境变量 `-e WEB_HOST="::"` 或 `-e WEB_HOST="0.0.0.0"` 显式指定。

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