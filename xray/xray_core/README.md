# Xray-core 极简边缘代理套件 (非 Root 多阶段构建 & 双模自适应)

这是一个工业级、轻量化、开箱即用的 Xray-core 边缘节点容器镜像。

- **Docker Hub**: `wimotek/xray:latest`
- **GHCR**: `ghcr.io/wimotek/xray:latest`
- **支持架构**: `linux/amd64`、`linux/arm64`

采用 **Alpine 三阶段极简构建**、**非 Root 最低特权运行（UID/GID `10001`）** 与 **`dumb-init` 完整信号链守护**，支持 **公网直连 (VLESS-REALITY-Vision)** 与 **NAT4 / 无公网入口 (WSS 反向打洞穿透)** 双模式运行；底层彻底抛弃 Shell 编排，采用纯 Python 标准库异步架构（`python3 -m app`）进行看门狗自愈与配置热加载。

---

## 🚀 快速部署（Docker Run & Docker Compose）

> **部署前必做**：容器以非 Root 用户 `appuser`（UID/GID `10001`）运行，挂载宿主机目录前必须先授权 `10001:10001`（改用 Docker 命名卷 `-v xray_node_data:/data` 时可免 `chown`），并在防火墙/安全组放行 **`443/TCP`**。

### 方式 1：纯单机一键启动（无需 Hub 控制中心）

不填写 `PANEL_URL` 即可自动生成 X25519 密钥对、`ShortId`、`config.json`，并将完整客户端配置与 `vless://` 导入链接输出至日志和 `./data/client_info.txt`。

#### 1) Docker Run 单机一键启动

```bash
# 1. 创建并授权持久化数据目录 (非 root UID 10001 必需)
mkdir -p ./data && chown -R 10001:10001 ./data

# 2. 生成随机客户端 UUID 并启动纯单机 VLESS-REALITY 节点（其余参数均已内置默认值）
docker run -d \
  --name xray-standalone \
  --restart unless-stopped \
  --network host \
  -e UUID="$(cat /proc/sys/kernel/random/uuid)" \
  -v $(pwd)/data:/data \
  wimotek/xray:latest
```

> 提示：若系统无 `/proc/sys/kernel/random/uuid`，可替换为 `uuidgen` 或任意标准 UUIDv4；如需使用 GHCR 镜像，替换为 `ghcr.io/wimotek/xray:latest`；无法使用 `--network host` 时改为 `-p 443:443/tcp`。

#### 2) Docker Compose 单机配置 (`docker-compose.yml`)

```yaml
services:
  xray-standalone:
    image: wimotek/xray:latest
    # 可选：改用 GHCR 镜像 ghcr.io/wimotek/xray:latest
    container_name: xray-standalone
    restart: unless-stopped
    # 推荐 host 模式：开箱支持 IPv4/IPv6 双栈
    network_mode: "host"
    # 可选：若改用桥接端口映射，请注释上方 network_mode 并取消下方 ports 注释
    # ports:
    #   - "443:443/tcp"
    environment:
      # 不填写 PANEL_URL 即自动进入纯单机模式；只需指定随机 UUID
      - UUID=请替换为随机UUIDv4
      # --- 以下均为可选参数（已内置默认值，按需取消注释覆写） ---
      # - TZ=Asia/Shanghai                             # 默认 Asia/Shanghai
      # - SERVER_IP=你的公网IP或域名                     # NAT 后或无法自动探测公网 IP 时指定
      # - SERVER_IPV6=你的公网IPv6                       # 默认自动探测
      # - PORT=443                                     # 默认 443
      # - DEST=www.microsoft.com:443                   # 默认 www.microsoft.com:443
      # - SERVER_NAMES=www.microsoft.com,microsoft.com # 默认 www.microsoft.com,microsoft.com
      # - HEALTH_PORT=10087                            # 默认 10087（回环 /healthz，0 禁用）
    volumes:
      - ./data:/data
```

#### 3) 获取客户端导入链接

启动数秒后，直接复制 `vless://` 链接导入 **v2rayN / Clash Verge / Sing-box / Shadowrocket**：

```bash
# 查看容器日志中的 vless:// 链接
docker logs xray-standalone

# 或直接读取持久化摘要文件
cat ./data/client_info.txt
```

---

### 方式 2：Docker Run 接入 Hub 主控集群

```bash
# 1. 创建并授权持久化数据目录 (非 root UID 10001 必需)
mkdir -p ./data && chown -R 10001:10001 ./data

# 2. 启动边缘节点接入 Hub（其余均为内置默认值的可选参数，按需追加 -e 覆写）
docker run -d \
  --name xray-node \
  --restart unless-stopped \
  --network host \
  -e PANEL_URL="https://<主控服务器IP或域名>:8443" \
  -e CLUSTER_TOKEN="xray_cluster_secret_key_2026" \
  -v $(pwd)/data:/data \
  wimotek/xray:latest
```

> 可选扩展：
> - 若公网 443 端口被运营商/防火墙封锁，可追加 `-e NET_MODE="reverse_wss"` 强制启用 WSS 反向穿透（也可在 Web 后台一键热切换）；
> - 如需改用桥接模式，去掉 `--network host` 并加 `-p 443:443/tcp`。

---

### 方式 3：Docker Compose 接入 Hub 主控集群

```bash
mkdir -p ./data && chown -R 10001:10001 ./data
```

创建 `docker-compose.yml`（仓库同目录已内置现成模板；所有可选参数默认以 `#` 注释，按需取消注释即可）：

```yaml
services:
  xray:
    image: wimotek/xray:latest
    # 可选：改用 GHCR 镜像 ghcr.io/wimotek/xray:latest
    container_name: xray-node
    restart: unless-stopped
    # 推荐 host 模式：开箱支持 IPv4/IPv6 双栈
    network_mode: "host"
    # 可选：若改用桥接端口映射，请注释上方 network_mode 并取消下方 ports 注释
    # ports:
    #   - "443:443/tcp"
    environment:
      # --- 必填：接入 Hub 控制中心（留空 PANEL_URL 即进入纯单机模式） ---
      - PANEL_URL=https://<主控服务器IP或域名>:8443
      - CLUSTER_TOKEN=xray_cluster_secret_key_2026
      # --- 以下均为可选参数（已内置默认值，按需取消注释覆写） ---
      # - TZ=Asia/Shanghai                             # 默认 Asia/Shanghai
      # - NET_MODE=auto                                # 默认 auto（Hub 拨测裁决），可选 direct / reverse_wss
      # - EDGE_AGENT_REVERSE_TUNNEL=true               # 可选布尔覆写：强制开启反穿
      # - SERVER_IP=你的公网IP或域名                     # 默认自动探测
      # - SERVER_IPV6=你的公网IPv6                       # 默认自动探测
      # - PORT=443                                     # 默认 443
      # - DEST=www.microsoft.com:443                   # 默认 www.microsoft.com:443
      # - SERVER_NAMES=www.microsoft.com,microsoft.com # 默认 www.microsoft.com,microsoft.com
      # - LOCAL_BRIDGE_PORT=10086                      # 默认 10086（同机多实例避让）
      # - STATS_PORT=10085                             # 默认 10085（同机多实例避让）
      # - HEALTH_PORT=10087                            # 默认 10087（同机多实例避让，0 禁用）
    volumes:
      - ./data:/data
```

启动并查看日志：

```bash
docker compose up -d && docker compose logs -f xray
```

---

### 常用运维命令

```bash
# 更新镜像并无感重建（Docker Compose）
docker compose pull && docker compose up -d

# 查看实时日志
docker logs -f --tail 100 xray-node

# 查看容器健康检查状态（探针检测 127.0.0.1:10087/healthz）
docker inspect --format='{{.State.Health.Status}}' xray-node
```

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
- 🔀 **Hub 主动双栈 TCP 拨测裁决 (`net_mode`)**：
  - **极简节点上报**：节点端零第三方依赖，仅采集自身公网 IPv4 / IPv6 上报至 Hub，默认先以 `direct` 拉起端口监听；
  - **Hub 真实拨测**：Hub 端内置 `wimotek-edge-agent >= 1.0.16`，并发 TCP 拨测节点 IPv4 与 IPv6 端口（`direct_dual` / `direct_ipv4` / `direct_ipv6` / `reverse_tunnel`），端口不通或无公网入口时自动下发 `reverse_wss` 热切换指令；
  - **直连模式 (`direct`)**：启用原生 `TCP + REALITY + xtls-rprx-vision` 流控（无废弃 WebSocket 告警）；
  - **反穿模式 (`reverse_wss`)**：Xray 本地仅监听回环 `127.0.0.1:10086`（纯原生 TCP，无 WS 废弃告警），由 Python 异步进程主动建立 `wss://` 反向隧道连向 Hub 中枢接流。
- 🛡️ **TOFU 首次信任与防重放准入**：
  - 支持主控 `wimotek-edge-agent` 签发的 40 字符单次防重放 `Join Token` 或集群引导令牌协商准入；
  - 握手成功后固化永久专属 `node_key`，并周期同步用户、策略与增量流量统计。

---

## ⚠️ 宿主机目录权限与低端口注意事项

### 1. 宿主机目录挂载权限（非 Root UID `10001` 必需）
若直接挂载宿主机本地目录（如 `-v $(pwd)/data:/data`），Docker 自动创建的目录属主为 `root:root`，会导致容器报 `PermissionError`。请提前执行：

```bash
mkdir -p ./data
chown -R 10001:10001 ./data
```

> 从旧版 `root` 容器升级迁移时同样需执行一次 `chown -R 10001:10001 ./data`；若改用 Docker 命名卷（`-v xray_node_data:/data`），首次初始化会自动继承 `10001:10001` 属主。

### 2. 非 Root 绑定 443 低端口注意事项
镜像已对 `/usr/bin/xray` 写入文件级权能 `cap_net_bind_service=+ep`，绝大多数标准 Docker 环境可直接绑定 `443` 端口：
1. **切勿添加 `--security-opt=no-new-privileges:true`**，该选项会屏蔽二进制文件上的 `setcap` 权能提权，导致无法绑定 `443`；
2. 若在极少数 LXC / 精简宿主机内核下 `xattr` 权能不生效，可在宿主机执行：
   ```bash
   sudo sysctl -w net.ipv4.ip_unprivileged_port_start=0
   ```
   或改用高位端口（如 `-e PORT=8443`）。

---

## ⚙️ 环境变量详解

| 环境变量 | 默认值 | 作用说明 |
| :--- | :--- | :--- |
| `PANEL_URL` | *(空)* | Hub 控制中心访问地址（例：`https://hub.example.com:8443`）。若留空则为纯单机模式 |
| `UUID` | `11111111-2222-3333-4444-555555555555` | 纯单机模式下使用的客户端连接 UUID（接入 Hub 后由主控用户列表下发接管） |
| `CLUSTER_TOKEN` | *(空)* | 集群引导令牌或 Hub 签发的 40 字符单次 Join Token（首次连接用于 TOFU 认证）。也可用 `NODE_KEY` |
| `NET_MODE` | `auto` | 网络模式：`auto`（上报双栈 IP 由 Hub 主动拨测裁决）、`direct`（强制公网直连 REALITY）、`reverse_wss`（强制反向隧道穿透） |
| `EDGE_AGENT_REVERSE_TUNNEL` | *(空)* | 可选布尔覆写：`true` 强制反穿 |
| `SERVER_IP` / `SERVER_IPV6` | *(自动探测)* | 手动指定节点对外汇报的 IPv4 / IPv6 地址（覆盖外部 IP 探测与 `/proc/net/if_inet6` 采集） |
| `PORT` | `443` | 节点直连监听端口（反穿模式下对外端口由 Hub 代理接管） |
| `DEST` | `www.microsoft.com:443` | REALITY 伪装回落目标 |
| `SERVER_NAMES` | `www.microsoft.com,microsoft.com` | REALITY 伪装 SNI 列表（逗号分隔） |
| `LOCAL_BRIDGE_PORT` | `10086` | 反穿模式下回环 `127.0.0.1` 的本地桥接端口 |
| `STATS_PORT` | `10085` | 纯回环 `127.0.0.1` 的 Xray `StatsService` 流量统计端口 |
| `HEALTH_PORT` | `10087` | 仅绑定回环 `127.0.0.1` 的本地 `/healthz` 健康检查端口（设为 `0` 禁用） |
| `DATA_DIR` | `/data` | 持久化数据目录，存储 `node_id.txt`、`node_key.txt`、`public_key.txt`、`short_id.txt`、`config.json` |
| `TZ` | `Asia/Shanghai` | 容器运行期时区（镜像含完整 `/usr/share/zoneinfo`，支持任意标准时区动态切换） |

---

## 📂 镜像内包结构说明 (`/app/`)

镜像工作目录 `WORKDIR /`，守护代码包直接挂载于单层 `/app/` 目录（无冗余嵌套）：

```text
/app/
├── __init__.py         # 包声明与版本号 (v1.0.17)
├── __main__.py         # 容器唯一启动入口 (python3 -m app) & 信号优雅退出
├── config.py           # 环境变量与路径解析配置
├── net_detector.py     # 纯标准库双栈公网 IPv4/IPv6 采集器 (交由 Hub 主动拨测)
├── config_builder.py   # 构建 Direct REALITY 与本地 TCP Loopback 反穿 config.json
├── xray_manager.py     # 密钥推导、ShortId、xray -test 语法预检与看门狗
├── health.py           # 纯标准库本地回环 /healthz 端点与 Docker HEALTHCHECK 探针
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
