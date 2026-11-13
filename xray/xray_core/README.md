# Xray-core 极简边缘代理套件 (非 Root 多阶段构建 & 双模自适应)

这是一个工业级、轻量化、开箱即用的 Xray 边缘节点容器镜像。采用 **Alpine 三阶段极简构建**、**非 Root 最低特权运行（UID/GID `10001`）** 与 **dumb-init 完整信号链守护**，支持 **公网直连 (VLESS-REALITY-Vision)** 与 **NAT4 / 无公网入口 (WSS 反向打洞穿透)** 双模式运行。

底层彻底抛弃脆弱的 Shell 脚本编排，采用纯 Python 标准库异步架构（`python3 -m app`）进行看门狗自愈与配置热加载。

---

## ✨ 核心特性

- 🔒 **非 Root 安全沙箱与低特权绑定**：
  - 容器以专用非特权用户 `appuser`（**UID `10001` / GID `10001`**）运行；
  - 构建期通过 `setcap 'cap_net_bind_service=+ep'` 为 `/usr/bin/xray` 与 `python3` 赋予低端口绑定权限，无需以 `root` 运行即可直接监听 `443` 端口。
- 🏗️ **三阶段极致精简构建**：
  - `Stage 1 (tz-builder)`：提取完整全球时区库，默认 `TZ=Asia/Shanghai`，支持运行时通过 `-e TZ=任意时区` 动态覆盖；
  - `Stage 2 (xray-builder)`：自动拉取官方最新 Xray-core 与最新 `geosite.dat` / `geoip.dat` 路由数据；
  - `Stage 3`：仅保留 `dumb-init`、`ca-certificates`、`libcap`、`python3`、`py3-websockets`（已剔除 `openssl` CLI 与 `pip` 等非必需组件），镜像体积最小化；
  - 信号链完整：`dumb-init (PID 1)` ➔ `Python (SIGTERM 捕获)` ➔ `Xray (Popen 优雅停机)`，配合 `PYTHONUNBUFFERED=1` 与 `PYTHONDONTWRITEBYTECODE=1`，日志实时直通 `docker logs` 且适配只读层。
- 🐍 **纯 Python 异步三层看门狗**：
  - **核心看门狗**：秒级监控 Xray 核心运行状态，意外退出立即自愈拉起；
  - **语法沙箱防变砖**：配置变更前强制执行 `xray -test -config` 预检，校验通过后在 `/data` 同分区原子替换并平滑重载；
  - **WSS 隧道守护**：反穿模式下长连接探活心跳（Ping-Pong 15s），网络波动按指数退避（1s~60s）自动重连。
- 🔀 **智能网络双模判定 (`net_mode`)**：
  - **直连模式 (`direct`)**：监听 `0.0.0.0:443`，启用原生 `TCP + REALITY + xtls-rprx-vision` 流控（无废弃 WebSocket 告警）；
  - **反穿模式 (`reverse_wss`)**：Xray 本地仅监听回环 `127.0.0.1:10086`（纯原生 TCP，无 WS 废弃告警），由 Python 异步进程主动建立 `wss://` 反向隧道连向 Hub 中枢接流；
  - **判定规范**：遵循 `wimotek-edge-agent` 规范——显式环境变量（`NET_MODE` / `EDGE_AGENT_REVERSE_TUNNEL`）与主控下发指令优先；默认 `auto` 模式下检测到 CGNAT (`100.64.0.0/10`) / 纯私网自动切入反穿，公网 IPv4（含云厂商 1:1 NAT）及全球 IPv6 默认走 `direct` REALITY 直连。
- 🛡️ **TOFU 首次信任与防重放准入**：
  - 支持主控 `wimotek-edge-agent` 签发的 40 字符单次防重放 `Join Token` 或集群引导令牌协商准入；
  - 握手成功后固化永久专属 `node_key`，并周期同步用户、策略与增量流量统计。

---

## ⚠️ 宿主机目录挂载权限要求（必读）

由于镜像已切换为 **非 Root 用户 `appuser`（UID `10001` / GID `10001`）** 运行，若直接挂载宿主机本地目录（如 `-v $(pwd)/data:/data`），Docker 在宿主机目录不存在时会自动以 `root:root (0:0)` 权限创建该目录，导致容器启动时出现 `PermissionError: [Errno 13] Permission denied: '/data/...'` 写入失败！

请在启动容器前，**务必按以下任一方式处理持久化目录权限**：

### 方式 A：宿主机目录绑定挂载（推荐生产使用，提前授权 UID `10001`）

```bash
mkdir -p ./data
chown -R 10001:10001 ./data
```

> **提示**：如从旧版 `root` 容器升级迁移，原 `./data` 下的 `config.json`、`node_key.txt`、`public_key.txt` 等文件归属为 `root`，升级启动前同样需执行一次 `chown -R 10001:10001 ./data`。

### 方式 B：使用 Docker 命名卷（自动继承镜像内权限）

Docker 命名卷在首次初始化时会自动拷贝镜像内 `/data` 的 `10001:10001` 属主与 `775` 权限，无需手动 `chown`：

```bash
-v xray_node_data:/data
```

### 关于非 Root 绑定 443 端口的宿主机注意事项

镜像已对 `/usr/bin/xray` 写入文件级权能 `cap_net_bind_service=+ep`，绝大多数标准 Docker 环境可直接绑定 `443` 端口。若遇到以下特殊宿主环境：
1. **切勿添加 `--security-opt=no-new-privileges:true`**：该安全参数会屏蔽二进制文件上的 `setcap` 权能提权，导致 Xray 无法绑定 443 端口；
2. 若在部分精简内核 / LXC / 无特权容器环境导致文件 `xattr` 权能失效，可任选其一解决：
   - 在启动参数中显式保留权能并放宽内核非特权端口起点：
     `--sysctl net.ipv4.ip_unprivileged_port_start=0`（注意 `--network host` 模式下需在宿主机执行 `sysctl -w net.ipv4.ip_unprivileged_port_start=0`）；
   - 或改用高位端口 `-e PORT=8443` 配合宿主机防火墙/网关转发。

---

## 🚀 快速启动

### 方式 1：Docker Run 单条命令接入主控集群（推荐）

```bash
# 1. 创建并授权持久化数据目录 (非 root UID 10001 必需)
mkdir -p ./data && chown -R 10001:10001 ./data

# 2. 启动边缘节点容器
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

### 方式 2：使用 Docker Compose 启动

先在宿主机执行权限初始化：
```bash
mkdir -p ./data && chown -R 10001:10001 ./data
```

创建 `docker-compose.yml`：

```yaml
services:
  xray:
    image: ghcr.io/wimotek/xray:latest
    container_name: xray-node
    restart: unless-stopped
    network_mode: "host"
    environment:
      - TZ=Asia/Shanghai
      - PANEL_URL=https://<主控服务器IP>:8443      # 留空则进入纯单机模式
      - CLUSTER_TOKEN=xray_cluster_secret_key_2026 # 集群引导令牌或单次 Join Token
      - NET_MODE=auto                              # auto / direct / reverse_wss
      - PORT=443
      - DEST=www.microsoft.com:443
      - SERVER_NAMES=www.microsoft.com,microsoft.com
    volumes:
      - ./data:/data
```

启动命令：
```bash
docker compose up -d
```

### 方式 3：公网 IP 但 443 端口被运营商/防火墙封锁（强制反穿）

若主机拥有公网 IP（如国内家宽公网动态 IP），但运营商封锁了入站 80/443 端口，请显式强制启用反穿：
```bash
-e NET_MODE="reverse_wss"
```
或直接在 Web 控制面板后台为该节点切换模式，节点下次心跳将自动热切换拉起反穿隧道。

### 方式 4：纯单机运行（不连 Hub 控制中心）

若不配置 `PANEL_URL`，系统将自动进入单机独立模式，在终端日志及 `./data/client_info.txt` 输出开箱即用的客户端 `vless://` 直连链接。

---

## ⚙️ 环境变量详解

| 环境变量 | 默认值 | 作用说明 |
| :--- | :--- | :--- |
| `PANEL_URL` | *(空)* | Hub 控制中心访问地址（例：`https://hub.example.com:8443`）。若留空则为纯单机模式 |
| `CLUSTER_TOKEN` | *(空)* | 集群引导令牌或 Hub 签发的 40 字符单次 Join Token（首次连接用于 TOFU 认证）。也可用 `NODE_KEY` |
| `NET_MODE` | `auto` | 网络模式：`auto`（自动识别 CGNAT/私网）、`direct`（强制公网直连 REALITY）、`reverse_wss`（强制反向隧道穿透） |
| `EDGE_AGENT_REVERSE_TUNNEL` | *(空)* | 可选布尔覆写：`true` 强制反穿，`false` 强制直连（与 `NET_MODE` 协同） |
| `EDGE_AGENT_NAT_TYPE` | `unknown` | 可选 NAT 提示：`nat4` / `symmetric` 将在 `auto` 模式下触发反穿 |
| `SERVER_IP` / `SERVER_IPV6` | *(自动探测)* | 手动指定节点对外汇报的 IPv4 / IPv6 地址（覆盖外部 IP 探测接口） |
| `PORT` | `443` | 节点直连监听端口（反穿模式下对外端口由 Hub 代理接管） |
| `DEST` | `www.microsoft.com:443` | REALITY 伪装回落目标 |
| `SERVER_NAMES` | `www.microsoft.com,microsoft.com` | REALITY 伪装 SNI 列表（逗号分隔） |
| `DATA_DIR` | `/data` | 持久化数据目录，存储 `node_id.txt`、`node_key.txt`、`public_key.txt`、`short_id.txt`、`config.json` |
| `TZ` | `Asia/Shanghai` | 容器运行期时区（镜像含完整 `/usr/share/zoneinfo`，支持任意标准时区动态切换） |

---

## 📂 镜像内包结构说明 (`/app/`)

镜像工作目录 `WORKDIR /`，守护代码包直接挂载于单层 `/app/` 目录（无冗余嵌套）：

```text
/app/
├── __init__.py         # 包声明与版本号 (v1.0.15)
├── __main__.py         # 容器唯一启动入口 (python3 -m app) & 信号优雅退出
├── config.py           # 环境变量与路径解析配置
├── net_detector.py     # 纯标准库网络拓扑解析 (CGNAT 识别 + 显式覆写)
├── config_builder.py   # 构建 Direct REALITY 与本地 TCP Loopback 反穿 config.json
├── xray_manager.py     # 密钥推导、ShortId、xray -test 语法预检与看门狗
├── tunnel.py           # WSS 反向隧道全双工桥接与 Ping-Pong 心跳探活
└── hub_client.py       # 主控端心跳握手、TOFU 准入、用户同步与增量流量结算
```

---

## 📱 客户端兼容性

无论节点是海外公网直连（REALITY），还是家宽 NAT4 反穿（WSS），**Hub 端下发的订阅地址均会自动生成标准原生链接**，完全兼容：
- **v2rayN / xrayN (Windows)**
- **Clash-Meta / Clash Verge (Rev)**
- **Sing-box (Android / iOS)**
- **Shadowrocket (小火箭 / iOS)**
