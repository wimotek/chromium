# Sing-box 双协议极简边缘节点套件 (VLESS-REALITY + Hysteria2)

这是一个与 `xray_core` 架构完全对齐、可无缝接入 `xray_web` 主控中心（Hub）的 **Sing-box 双协议边缘节点镜像**（Docker Hub: `wimotek/sing-box` / GHCR: `ghcr.io/wimotek/sing-box`）。

单容器、单进程即可同时提供 **VLESS-REALITY-Vision (TCP)** 与 **Hysteria2 (原生 UDP / QUIC)** 双协议入站，延续 **Alpine 三阶段精简构建**、**非 Root 最低特权运行（UID/GID `10001`）**、**`dumb-init` 完整信号链** 与 **纯 Python 异步看门狗**，并与现有 `xray_core` 节点在同一个 Hub 集群内自由混跑。

---

## 🌟 相比 `xray_core` 的核心优势

| 对比项 | `sing-box` (`wimotek/sing-box`) | `xray_core` (`wimotek/xray`) |
| :--- | :--- | :--- |
| **协议能力** | **单核原生双协议**：同时支持 **VLESS-REALITY (TCP)** + **Hysteria2 (原生 UDP/QUIC)**，TCP 稳防断流 + UDP 快抗丢包互为兜底 | 单协议 **VLESS-REALITY (TCP)**（UDP 业务经 TCP 隧道转发，高丢包线路存在队头阻塞） |
| **高丢包/晚高峰表现** | Hysteria2 基于 QUIC + BBR/Brutal 拥塞控制，**跨国高丢包、晚高峰、游戏联机与 4K 秒开表现显著更优** | 依赖内核 TCP 拥塞控制，跨国丢包率高时吞吐衰减较明显 |
| **同端口复用** | **443/TCP（REALITY）与 443/UDP（Hysteria2）原生共存**，无需额外暴露高危端口（亦支持自定义独立 UDP 端口） | 仅监听 443/TCP |
| **商业化流量计费** | 编译期已内置 `with_v2ray_api` 与零依赖 `sb-helper`，**VLESS 与 Hysteria2 共享同一套用户 UUID 与按用户精准流量结算** | 内置 Xray `StatsService` 按用户统计 |
| **镜像精简与现代配置** | 采用 `sing-box 1.11+/1.12+` 原生 `action: sniff` / `ip_is_private` 规则，**无需打包 ~15MB 的 `geosite.dat`/`geoip.dat` 与 `openssl` CLI** | 需携带 `geosite.dat` / `geoip.dat` |
| **Hub 联动与订阅** | 无缝接入 `xray_web` Hub，客户端刷新**同一个订阅地址自动同时下发 `vless://` + `hysteria2://` 双节点**；重置用户 UUID 时双协议同步失效 | 自动下发 `vless://` |

### 什么时候优先选 `wimotek/sing-box`？
- 节点线路晚高峰丢包严重、跨境延迟抖动大，或有低延迟游戏 / 语音 / 视频会议需求；
- 希望**一台服务器同时给用户提供 TCP（稳）+ UDP（快）两条线路**，且共用同一套后台配额、到期时间与限流治理。

---

## 🛠️ 服务器端设置要求（部署必读）

为充分发挥 Hysteria2 原生 UDP/QUIC 性能并确保非 Root 容器正常运行，请在节点宿主机完成以下配置：

### 1. 宿主机数据目录权限（非 Root UID `10001` 必需）
容器以非特权用户 `appuser`（UID `10001` / GID `10001`）运行，绑定挂载宿主机目录前必须提前授权，否则会因权限不足启动失败：

```bash
mkdir -p ./data
chown -R 10001:10001 ./data
```

> 若改用 Docker 命名卷（`-v singbox_node_data:/data`），首次初始化会自动继承镜像内 `10001:10001` 属主，无需手动 `chown`。

### 2. 防火墙与云服务器安全组放行（TCP + UDP 缺一不可）
- **入站放行**：
  - `443/TCP`（或自定义 `PORT/tcp`）—— 供 VLESS-REALITY 使用；
  - `443/UDP`（或自定义 `HY2_PORT/udp`）—— 供 Hysteria2 原生 UDP 使用；
- **出站放行**：允许节点出站 TCP 与 UDP（避免拦截目标 UDP 443/53）。
- 若使用 Docker Bridge 模式而非 `--network host`，**必须显式同时映射 TCP 与 UDP 端口**：
  ```bash
  -p 443:443/tcp -p 443:443/udp
  ```

### 3. Linux 内核 UDP 缓冲区与 BBR 优化（强烈推荐！）
Hysteria2 基于 QUIC/UDP，Linux 默认较小的 UDP 读写缓冲区会严重限制单连接吞吐并产生 `failed to sufficiently increase receive buffer size` 警告。建议在宿主机执行以下命令持久化优化：

```bash
cat <<'EOF' | sudo tee /etc/sysctl.d/99-singbox-quic.conf
# 增大 UDP/QUIC 收发缓冲区至 8MB，避免高带宽下丢包与限速
net.core.rmem_max = 8388608
net.core.wmem_max = 8388608
net.core.rmem_default = 1048576
net.core.wmem_default = 1048576

# 开启 FQ 队列调度与 BBR 拥塞控制（同时加速 VLESS TCP）
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
EOF

sudo sysctl --system
```

### 4. 非 Root 绑定 443 低端口注意事项
镜像已在构建期通过 `setcap 'cap_net_bind_service=+ep'` 为 `/usr/bin/sing-box` 与 `python3` 赋予低端口绑定权限：
- **切勿添加 `--security-opt=no-new-privileges:true`**，该选项会屏蔽二进制文件上的 `setcap` 能力导致无法监听 `443`；
- 若在极少数 LXC / 精简宿主机内核下 `xattr` 权能不生效，可在宿主机执行：
  ```bash
  sudo sysctl -w net.ipv4.ip_unprivileged_port_start=0
  ```
  或改用高位端口（如 `-e PORT=8443 -e HY2_PORT=8443`）。

### 5. Hysteria2 TLS 证书策略（两种方式任选）
- **方式 A：零配置自动 ECDSA 自签证书（默认，开箱即用）**
  - 无需域名和 80 端口，启动时由内置 `sb-helper` 自动生成 `/data/hy2_cert.pem` 与 `/data/hy2_key.pem`（默认 `HY2_SNI=www.bing.com`、`HY2_INSECURE=true`），Hub 下发订阅时自动携带 `insecure=1`。
- **方式 B：挂载自有域名的正规 CA 证书（更强伪装，免 `insecure`）**
  - 将 Let's Encrypt / 宝塔签发的证书挂载进容器（确保 UID `10001` 可读），并配置：
    ```bash
    -v /path/to/fullchain.pem:/certs/fullchain.pem:ro \
    -v /path/to/privkey.pem:/certs/privkey.pem:ro \
    -e HY2_CERT_PATH="/certs/fullchain.pem" \
    -e HY2_KEY_PATH="/certs/privkey.pem" \
    -e HY2_SNI="your-node.example.com" \
    -e HY2_INSECURE="false"
    ```

### 6. （进阶可选）Hysteria2 UDP 端口跳跃防 QoS
如果部分地区运营商对单个长连接 UDP 端口限速，可在宿主机通过 `iptables` 将一段 UDP 端口转发到 `HY2_PORT`（例如将 `20000:30000/udp` 映射到 `443/udp`）：

```bash
sudo iptables -t nat -A PREROUTING -i eth0 -p udp --dport 20000:30000 -j DNAT --to-destination :443
# 若启用 IPv6 同步配置 ip6tables：
sudo ip6tables -t nat -A PREROUTING -i eth0 -p udp --dport 20000:30000 -j DNAT --to-destination :443
```

---

## ⚠️ 重要注意事项

1. **运营商 UDP QoS 特性**：国内部分宽带/移动网络在晚高峰可能对 UDP 流量触发限速或丢包。这正是本镜像同时开启 **VLESS-REALITY (TCP)** 与 **Hysteria2 (UDP)** 的核心价值——一旦某地区 UDP 遭 QoS，用户只需在客户端一键切回同节点的 REALITY (TCP) 线路即可无缝恢复。
2. **关于 `HY2_UP_MBPS` / `HY2_DOWN_MBPS`（拥塞控制模式）**：
   - 默认值均为 `0`（省略限速字段），此时 Hysteria2 自动使用温和的 **BBR 拥塞控制**，对绝大多数 VPS 最友好且不易被机房判定滥用；
   - 若你明确知道服务器真实带宽并希望启用激进的 **Brutal 拥塞控制**，请**按机房实际口子如实填写**（切忌虚标远超实际带宽的数值，否则会引发严重重传与拥塞）。
3. **NAT4 / `reverse_wss` 反穿模式说明**：
   - 当节点处于无公网入口的 NAT4 内网并被 Hub 裁决进入 `reverse_wss` 反穿模式时，仅通过 WSS 反向隧道承载 **VLESS (TCP)** 业务，**Hysteria2 (UDP) 会自动暂停且不会下发不可达的 UDP 订阅链接**。
4. **Hub 端版本匹配**：
   - 请确保 `xray_web` 主控端已同步更新至支持 `singbox` + `Hysteria2` 联动的版本；即使对接旧版 Hub，本节点的 VLESS-REALITY 仍完全兼容，但 Hysteria2 订阅下发与后台参数编辑需要新版 Hub 支持。
5. **与 `xray_core` 共存原则**：
   - 同一台服务器如需同时运行 `xray_core` 与 `singbox_core`，请错开 `PORT`、`STATS_PORT`、`HEALTH_PORT`、`LOCAL_BRIDGE_PORT` 与持久化目录。

---

## 🚀 快速启动

### 方式 1：Docker Run 单条命令接入 Hub 集群（推荐）

```bash
# 1. 创建并授权持久化目录 (非 root UID 10001 必需)
mkdir -p ./data && chown -R 10001:10001 ./data

# 2. 启动 Sing-box 双协议节点 (同时提供 VLESS-REALITY + Hysteria2)
docker run -d \
  --name singbox-node \
  --restart always \
  --network host \
  -e TZ="Asia/Shanghai" \
  -e PANEL_URL="https://<主控服务器IP>:8443" \
  -e CLUSTER_TOKEN="xray_cluster_secret_key_2026" \
  -e NET_MODE="auto" \
  -e PORT=443 \
  -e DEST="www.microsoft.com:443" \
  -e SERVER_NAMES="www.microsoft.com,microsoft.com" \
  -e HY2_ENABLED="true" \
  -e HY2_PORT=443 \
  -e HY2_SNI="www.bing.com" \
  -v $(pwd)/data:/data \
  wimotek/sing-box:latest
```

### 方式 2：Docker Compose 生产编排

```bash
mkdir -p ./data && chown -R 10001:10001 ./data
```

创建 `docker-compose.yml`：

```yaml
services:
  singbox:
    image: wimotek/sing-box:latest
    container_name: singbox-node
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
      - HY2_ENABLED=true                           # 开启 Hysteria2 原生 UDP 双协议
      - HY2_PORT=443                               # 默认 443/udp，与 REALITY 443/tcp 共存
      - HY2_SNI=www.bing.com
      - HY2_MASQUERADE=https://www.bing.com
      # - HY2_UP_MBPS=100                          # 可选：指定带宽启用 Brutal，默认 0 使用 BBR
      # - HY2_DOWN_MBPS=100
    volumes:
      - ./data:/data
```

启动并查看日志：

```bash
docker compose up -d && docker logs -f singbox-node
```

### 方式 3：纯单机双协议模式（不连 Hub 控制中心）

不填 `PANEL_URL` 即可自动生成 REALITY 密钥、Hysteria2 证书与 `vless://` + `hysteria2://` 双导入链接（同时打印在日志并保存于 `./data/client_info.txt`）：

```bash
mkdir -p ./data && chown -R 10001:10001 ./data

docker run -d \
  --name singbox-standalone \
  --restart always \
  --network host \
  -e TZ="Asia/Shanghai" \
  -e UUID="$(cat /proc/sys/kernel/random/uuid)" \
  -e PORT=443 \
  -e HY2_ENABLED="true" \
  -e HY2_PORT=443 \
  -e HY2_SNI="www.bing.com" \
  -v $(pwd)/data:/data \
  wimotek/sing-box:latest

# 获取双协议导入链接
cat ./data/client_info.txt
```

---

## ⚙️ 环境变量详解

| 环境变量 | 默认值 | 作用说明 |
| :--- | :--- | :--- |
| `PANEL_URL` | *(空)* | Hub 控制中心地址（例：`https://hub.example.com:8443`）；留空为纯单机模式 |
| `CLUSTER_TOKEN` | *(空)* | 集群引导令牌或单次 Join Token（也兼容 `NODE_KEY`） |
| `UUID` | `11111111-...` | 纯单机模式下双协议共用的客户端 UUID / 密码（接入 Hub 后由主控自动下发） |
| `NET_MODE` | `auto` | `auto`（由 Hub 主动拨测裁决）、`direct`（强制公网直连）、`reverse_wss`（强制反穿） |
| `SERVER_IP` / `SERVER_IPV6` | *(自动探测)* | 手动指定节点对外上报的公网 IPv4 / IPv6 地址 |
| `PORT` | `443` | VLESS-REALITY TCP 监听端口 |
| `DEST` | `www.microsoft.com:443` | REALITY 伪装回落目标地址 |
| `SERVER_NAMES` | `www.microsoft.com,microsoft.com` | REALITY 伪装 SNI 域名列表（逗号分隔） |
| `HY2_ENABLED` | `true` | 是否开启 Hysteria2 原生 UDP 入站（`true` / `false`） |
| `HY2_PORT` | `${PORT}` (`443`) | Hysteria2 UDP 监听端口（与 TCP 443 互不冲突） |
| `HY2_SNI` | `www.bing.com` | Hysteria2 TLS 证书 SNI（自签证书自动以此生成 SAN） |
| `HY2_MASQUERADE` | `https://www.bing.com` | Hysteria2 抗探测 HTTP/3 伪装回落地址 |
| `HY2_UP_MBPS` / `HY2_DOWN_MBPS` | `0` | Hysteria2 服务端限速（Mbps）；`0` 为自动 BBR，大于 `0` 启用 Brutal |
| `HY2_CERT_PATH` / `HY2_KEY_PATH` | *(自动自签)* | 自定义正规 CA 证书与私钥路径（需对 UID `10001` 可读） |
| `HY2_INSECURE` | 自签 `true` / 自定义 `false` | 订阅链接是否下发 `insecure=1`（跳过自签证书校验） |
| `STATS_PORT` | `10085` | 纯回环 `127.0.0.1` 的 `v2ray_api` 流量统计 gRPC 端口 |
| `HEALTH_PORT` | `10087` | 纯回环 `127.0.0.1` 的 `/healthz` 健康检查端口（`0` 禁用） |
| `DATA_DIR` | `/data` | 持久化目录（存放密钥、证书、`node_key.txt`、`config.json`） |
| `TZ` | `Asia/Shanghai` | 容器运行期时区 |

---

## 📂 镜像内包结构说明 (`/app/`)

```text
/app/
├── __init__.py          # 包声明与版本号 (v1.0.17)
├── __main__.py          # 容器唯一入口 (python3 -m app) & 优雅停机
├── config.py            # 环境变量与双协议配置解析
├── net_detector.py      # 双栈公网 IPv4/IPv6 采集 & 本地双栈 :: 监听探测
├── config_builder.py    # 现代 sing-box 1.11+/1.12+ 双协议配置与 v2ray_api 组装
├── singbox_manager.py   # REALITY 密钥、Hysteria2 证书、sing-box check 预检与看门狗
├── health.py            # 纯回环 /healthz（同时校验 TCP + UDP 监听 + Stats API）
├── tunnel.py            # WSS 反向隧道全双工桥接与 Ping-Pong 心跳探活
└── hub_client.py        # Hub 握手同步、双协议能力上报与 sb-helper 增量流量结算
```

---

## 📱 客户端兼容性

Hub 端统一订阅接口 `/api/sub?token=<UUID>` 会自动为本节点同时生成标准 `vless://` 与 `hysteria2://` 链接，开箱兼容：
- **v2rayN**（Windows，建议 6.40+ / 7.x，开启 sing-box / hysteria2 核心）
- **v2rayNG**（Android，1.8.18+ 原生支持 Hysteria2）
- **Clash Verge Rev / Mihomo (Clash.Meta)**（Windows / macOS / Linux / Android）
- **sing-box 官方客户端（SFA / SFI / SFM）**（Android / iOS / macOS）
- **Shadowrocket（小火箭）**（iOS）
