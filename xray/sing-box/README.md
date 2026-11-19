# Sing-box 双协议极简边缘节点套件 (VLESS-REALITY + Hysteria2)

这是一个与 `xray_core` 架构完全对齐、可无缝接入 `xray_web` 主控中心（Hub）的 **Sing-box 双协议边缘节点镜像**。

- **Docker Hub**: `wimotek/sing-box:latest`
- **GHCR**: `ghcr.io/wimotek/sing-box:latest`
- **支持架构**: `linux/amd64`、`linux/arm64`

单容器、单进程即可同时提供 **VLESS-REALITY-Vision (TCP)** 与 **Hysteria2 (原生 UDP / QUIC)** 双协议入站，采用 **Alpine 三阶段精简构建**、**非 Root 最低特权运行（UID/GID `10001`）**、**`dumb-init` 完整信号链** 与 **纯 Python 异步看门狗**，可与现有 `xray_core` 节点在同一个 Hub 集群内自由混跑。

---

## 🚀 快速部署（Docker Run & Docker Compose）

> **部署前必做**：容器以非 Root 用户 `appuser`（UID/GID `10001`）运行，挂载宿主机目录前必须先授权 `10001:10001`（改用 Docker 命名卷 `-v singbox_node_data:/data` 时可免 `chown`），并在防火墙/安全组同时放行 **`443/TCP` + `443/UDP`**。

### 方式 1：纯单机双协议一键启动（无需 Hub 控制中心）

不填 `PANEL_URL` 即可自动生成 REALITY X25519 密钥、Hysteria2 证书与 `vless://` + `hysteria2://` 双协议导入链接（同步输出到日志及 `./data/client_info.txt`）：

#### 1) Docker Run 单机一键启动

```bash
# 1. 创建并授权持久化目录 (非 root UID 10001 必需)
mkdir -p ./data && chown -R 10001:10001 ./data

# 2. 生成随机 UUID 并启动单机双协议节点（其余参数均已内置默认值）
docker run -d \
  --name singbox-standalone \
  --restart unless-stopped \
  --network host \
  -e UUID="$(cat /proc/sys/kernel/random/uuid)" \
  -v $(pwd)/data:/data \
  wimotek/sing-box:latest
```

> 提示：若无法使用 `--network host`，改为 `-p 443:443/tcp -p 443:443/udp`；如需使用 GHCR 镜像，将 `wimotek/sing-box:latest` 替换为 `ghcr.io/wimotek/sing-box:latest`。

#### 2) Docker Compose 单机配置 (`docker-compose.yml`)

```yaml
services:
  singbox-standalone:
    image: wimotek/sing-box:latest
    # 可选：改用 GHCR 镜像 ghcr.io/wimotek/sing-box:latest
    container_name: singbox-standalone
    restart: unless-stopped
    # 推荐 host 模式：开箱支持 IPv4/IPv6 双栈与原生 UDP 零 NAT 损耗
    network_mode: "host"
    # 可选：若改用桥接端口映射，请注释上方 network_mode 并取消下方 ports 注释（TCP+UDP 必须同时放行）
    # ports:
    #   - "443:443/tcp"
    #   - "443:443/udp"
    environment:
      # 不填写 PANEL_URL 即自动进入纯单机模式；只需指定随机 UUID
      - UUID=请替换为随机UUIDv4
      # --- 以下均为可选参数（已内置默认值，按需取消注释覆写） ---
      # - TZ=Asia/Shanghai                             # 默认 Asia/Shanghai
      # - LOG_LEVEL=fatal                              # 默认 warn；设为 fatal 可屏蔽外网 REALITY 扫描回落日志
      # - SERVER_IP=你的公网IP或域名                     # NAT 后或无法自动探测公网 IP 时指定
      # - SERVER_IPV6=你的公网IPv6                       # 默认自动探测
      # - PORT=443                                     # 默认 443（VLESS-REALITY TCP）
      # - DEST=www.microsoft.com:443                   # 默认 www.microsoft.com:443
      # - SERVER_NAMES=www.microsoft.com,microsoft.com # 默认 www.microsoft.com,microsoft.com
      # - HY2_ENABLED=true                             # 默认 true（开启 Hysteria2 原生 UDP）
      # - HY2_PORT=443                                 # 默认跟随 PORT（443/udp 与 TCP 共存）
      # - HY2_SNI=www.bing.com                         # 默认 www.bing.com
      # - HY2_MASQUERADE=https://www.bing.com          # 默认 https://www.bing.com
      # - HY2_UP_MBPS=100                              # 默认 0（自动 BBR）；按实际带宽填写启用 Brutal
      # - HY2_DOWN_MBPS=100                            # 默认 0（自动 BBR）；按实际带宽填写启用 Brutal
    volumes:
      - ./data:/data
```

#### 3) 获取客户端导入链接

```bash
# 查看容器日志中的双协议链接
docker logs singbox-standalone

# 或直接读取持久化摘要文件
cat ./data/client_info.txt
```

---

### 方式 2：Docker Run 接入 Hub 集群（推荐，`host` 网络）

所有双协议与端口参数均已内置合理默认值（默认 `443/TCP` VLESS-REALITY + `443/UDP` Hysteria2），只需填 `PANEL_URL` 和 `CLUSTER_TOKEN` 即可直接启动：

```bash
# 1. 创建并授权持久化目录 (非 root UID 10001 必需)
mkdir -p ./data && chown -R 10001:10001 ./data

# 2. 启动 Sing-box 双协议节点（其余均为内置默认值的可选参数，按需追加 -e 覆写）
docker run -d \
  --name singbox-node \
  --restart unless-stopped \
  --network host \
  -e PANEL_URL="https://<主控服务器IP或域名>:8443" \
  -e CLUSTER_TOKEN="xray_cluster_secret_key_2026" \
  -v $(pwd)/data:/data \
  wimotek/sing-box:latest
```

> 可选扩展：
> - 桥接模式（无法使用 `--network host` 时）：去掉 `--network host`，改加 `-p 443:443/tcp -p 443:443/udp`；
> - 如需覆写端口/伪装域名等可选参数，按需追加 `-e PORT=443 -e HY2_PORT=443 -e HY2_SNI="www.bing.com"` 等。

---

### 方式 3：Docker Compose 接入 Hub 集群

```bash
mkdir -p ./data && chown -R 10001:10001 ./data
```

创建 `docker-compose.yml`（仓库同目录已内置现成模板；所有可选参数默认以 `#` 注释，按需取消注释即可）：

```yaml
services:
  singbox:
    image: wimotek/sing-box:latest
    # 可选：改用 GHCR 镜像 ghcr.io/wimotek/sing-box:latest
    container_name: singbox-node
    restart: unless-stopped
    # 推荐 host 模式：开箱支持 IPv4/IPv6 双栈与原生 UDP 零 NAT 损耗
    network_mode: "host"
    # 可选：若改用桥接端口映射，请注释上方 network_mode 并取消下方 ports 注释（TCP+UDP 必须同时放行）
    # ports:
    #   - "443:443/tcp"
    #   - "443:443/udp"
    environment:
      # --- 必填：接入 Hub 控制中心（留空 PANEL_URL 即进入纯单机模式） ---
      - PANEL_URL=https://<主控服务器IP或域名>:8443
      - CLUSTER_TOKEN=xray_cluster_secret_key_2026
      # --- 以下均为可选参数（已内置默认值，按需取消注释覆写） ---
      # - TZ=Asia/Shanghai                             # 默认 Asia/Shanghai
      # - LOG_LEVEL=fatal                              # 默认 warn；设为 fatal 可屏蔽外网 REALITY 扫描回落日志
      # - NET_MODE=auto                                # 默认 auto，可选 direct / reverse_wss
      # - SERVER_IP=你的公网IP或域名                     # 默认自动探测
      # - SERVER_IPV6=你的公网IPv6                       # 默认自动探测
      # - PORT=443                                     # 默认 443（VLESS-REALITY TCP）
      # - DEST=www.microsoft.com:443                   # 默认 www.microsoft.com:443
      # - SERVER_NAMES=www.microsoft.com,microsoft.com # 默认 www.microsoft.com,microsoft.com
      # - HY2_ENABLED=true                             # 默认 true（开启 Hysteria2 原生 UDP）
      # - HY2_PORT=443                                 # 默认跟随 PORT（443/udp 与 TCP 共存）
      # - HY2_SNI=www.bing.com                         # 默认 www.bing.com
      # - HY2_MASQUERADE=https://www.bing.com          # 默认 https://www.bing.com
      # - HY2_UP_MBPS=100                              # 默认 0（自动 BBR）；按实际带宽填写启用 Brutal
      # - HY2_DOWN_MBPS=100                            # 默认 0（自动 BBR）；按实际带宽填写启用 Brutal
      # - HY2_CERT_PATH=/certs/fullchain.pem           # 可选：挂载自有 CA 证书（需 UID 10001 可读）
      # - HY2_KEY_PATH=/certs/privkey.pem
      # - HY2_INSECURE=false                           # 自签默认 true；自定义证书默认 false
      # - LOCAL_BRIDGE_PORT=10086                      # 默认 10086（同机多实例避让）
      # - STATS_PORT=10085                             # 默认 10085（同机多实例避让）
      # - HEALTH_PORT=10087                            # 默认 10087（同机多实例避让，0 禁用）
    volumes:
      - ./data:/data
      # 可选：挂载自有 CA 证书
      # - /path/to/fullchain.pem:/certs/fullchain.pem:ro
      # - /path/to/privkey.pem:/certs/privkey.pem:ro
```

启动并查看运行日志：

```bash
docker compose up -d && docker compose logs -f singbox
```

---

### 常用运维命令

```bash
# 更新镜像并无感重建（Docker Compose）
docker compose pull && docker compose up -d

# 查看实时日志
docker logs -f --tail 100 singbox-node

# 查看容器健康检查状态（探针检测 127.0.0.1:10087/healthz）
docker inspect --format='{{.State.Health.Status}}' singbox-node
```

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

---

## 🛠️ 服务器端设置要求与性能优化

### 1. 宿主机数据目录权限（非 Root UID `10001` 必需）
```bash
mkdir -p ./data
chown -R 10001:10001 ./data
```
> 若改用 Docker 命名卷（`-v singbox_node_data:/data`），首次初始化会自动继承镜像内 `10001:10001` 属主，无需手动 `chown`。

### 2. 防火墙与云服务器安全组放行（TCP + UDP 缺一不可）
- **入站放行**：`443/TCP`（或自定义 `PORT/tcp`）与 `443/UDP`（或自定义 `HY2_PORT/udp`）。
- **出站放行**：允许节点出站 TCP 与 UDP（避免拦截目标 UDP 443/53）。

### 3. Linux 内核 UDP 缓冲区与 BBR 优化（强烈推荐）
Hysteria2 基于 QUIC/UDP，Linux 默认较小的 UDP 缓冲区会限制单连接吞吐并产生 `failed to sufficiently increase receive buffer size` 警告。建议在宿主机执行：

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
- **切勿添加 `--security-opt=no-new-privileges:true`**，该选项会屏蔽二进制上的 `setcap` 权能导致无法监听 `443`；
- 若在极少数 LXC / 精简宿主机内核下 `xattr` 权能不生效，可在宿主机执行 `sudo sysctl -w net.ipv4.ip_unprivileged_port_start=0` 或改用高位端口（如 `-e PORT=8443 -e HY2_PORT=8443`）。

### 5. Hysteria2 TLS 证书策略（两种方式任选）
- **方式 A：零配置自动 ECDSA 自签证书（默认）**：启动时由内置 `sb-helper` 自动生成 `/data/hy2_cert.pem` 与 `/data/hy2_key.pem`（默认 `HY2_SNI=www.bing.com`、`HY2_INSECURE=true`），Hub 订阅自动携带 `insecure=1`。
- **方式 B：挂载自有域名的正规 CA 证书（免 `insecure`）**：确保证书对 UID `10001` 可读，挂载后配置 `HY2_CERT_PATH`、`HY2_KEY_PATH`、`HY2_SNI` 与 `HY2_INSECURE=false`。

### 6. （进阶可选）Hysteria2 UDP 端口跳跃防 QoS
若部分运营商对单个长连接 UDP 端口限速，可在宿主机通过 `iptables` 将一段 UDP 端口转发到 `HY2_PORT`（如 `20000:30000/udp -> 443/udp`，请先在云服务器安全组与本机防火墙放行 `20000-30000/UDP`，并将 `eth0` 替换为实际公网网卡名）：

```bash
sudo iptables -t nat -A PREROUTING -i eth0 -p udp --dport 20000:30000 -j DNAT --to-destination :443
# 若启用 IPv6 同步配置 ip6tables：
sudo ip6tables -t nat -A PREROUTING -i eth0 -p udp --dport 20000:30000 -j DNAT --to-destination :443

# 查看规则与命中包计数（验证是否生效）：
sudo iptables -t nat -L PREROUTING -n -v --line-numbers
```

- **持久化提示**：`iptables` 规则默认重启后失效，Debian/Ubuntu 需安装 `iptables-persistent` 并执行 `sudo netfilter-persistent save`；CentOS/Rocky/Alma 需安装 `iptables-services` 并执行 `sudo service iptables save && sudo service ip6tables save` 并设置开机自启。
- **客户端配合填写跳跃端口**：在 v2rayN / Clash / sing-box / Shadowrocket 的该 Hysteria2 节点中，填入跳跃端口范围 `20000-30000`（如 Clash/Mihomo 的 `ports: 20000-30000`、链接参数 `mport=20000-30000`）。

---

## ⚠️ 重要注意事项

1. **运营商 UDP QoS 兜底**：晚高峰部分地区可能对 UDP 限速，此时客户端可一键切回同节点的 VLESS-REALITY (TCP) 线路。
2. **关于 `HY2_UP_MBPS` / `HY2_DOWN_MBPS`**：默认值均为 `0`（自动 BBR）；仅当明确知道真实带宽时才填正整数启用 Brutal，切勿虚标。
3. **NAT4 / `reverse_wss` 反穿模式**：节点进入反穿模式时仅通过 WSS 反向隧道承载 **VLESS (TCP)**，Hysteria2 (UDP) 自动暂停且不下发不可达链接；若公网 443 被封也可手动设置 `-e NET_MODE="reverse_wss"`。
4. **与 `xray_core` 同机共存**：请错开 `PORT`、`HY2_PORT`、`STATS_PORT`、`HEALTH_PORT`、`LOCAL_BRIDGE_PORT` 与持久化目录。

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
| `LOCAL_BRIDGE_PORT` | `10086` | 反穿模式下回环 `127.0.0.1` 的本地桥接端口 |
| `STATS_PORT` | `10085` | 纯回环 `127.0.0.1` 的 `v2ray_api` 流量统计 gRPC 端口 |
| `HEALTH_PORT` | `10087` | 纯回环 `127.0.0.1` 的 `/healthz` 健康检查端口（`0` 禁用） |
| `DATA_DIR` | `/data` | 持久化目录（存放密钥、证书、`node_key.txt`、`config.json`） |
| `LOG_LEVEL` | `warn` | sing-box 内核日志级别（`trace`/`debug`/`info`/`warn`/`error`/`fatal`/`panic`）；设为 `fatal` 可静默外网 REALITY 扫描回落日志 |
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
