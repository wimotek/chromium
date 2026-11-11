# Xray-core 极简边缘代理套件 (纯 Python 守护 & 双模自适应)

这是一个工业级、开箱即用的 Xray 边缘节点容器镜像。支持 **公网直连 (VLESS-REALITY-Vision)** 与 **NAT4 无公网 (WSS 反向打洞穿透)** 双模式自适应切换。

底层彻底抛弃脆弱的 Shell 脚本编排，采用标准纯 Python（`python3 -m app`）面向对象异步架构进行三层守护。

---

## ✨ 核心特性

- 🐍 **纯 Python 异步三层看门狗**：
  - **核心看门狗**：秒级监控 Xray 核心运行状态，意外退出 1 秒内原地自愈拉起；
  - **语法沙箱防变砖**：配置变更前强制执行 `xray test -config` 预检，100% 校验通过后原子上架并平滑重载；
  - **WSS 隧道守护**：长连接探活心跳（Ping-Pong 15s），网络波动按指数退避（1s~60s）自动重连。
- 🌐 **IPv4 + IPv6 双栈原生支持**：
  - 自动检测并输出公网 IPv4 与原生全球单播 IPv6；
  - 纯 IPv6 独享主机（如 Scaleway / Hetzner）天然直连端到端。
- ☁️ **Oracle Cloud / AWS 1:1 NAT 完美识别**：
  - 内置云平台元数据探测（IMDSv1/v2，`169.254.169.254`）；
  - 即使主机网卡仅显示 `10.0.0.x` 私网 IP，也能准确识别 1:1 NAT 公网直通映射，**绝不误判走反穿**。
- 🔀 **智能网络双模自适应 (`net_mode`)**：
  - **直连模式 (`direct`)**：监听 `0.0.0.0:443`，启用 VLESS + REALITY + Vision 流控；
  - **NAT4 反穿模式 (`reverse_wss`)**：Xray 监听本地 `127.0.0.1:10086`，Python 建立 WSS 反向隧道连向 Hub 端接流，无需公网 IP 和端口映射。
- 🛡️ **TOFU 首次信任与零信任通信**：
  - 首次启动携带集群引导令牌协商凭证，成功后固化永久专属 `node_key`；
  - 动态下发与轮换密钥，上报增量流量并重置统计。

---

## 🚀 快速启动

### 方式 1：Docker Run 单条命令接入主控集群（推荐）

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

### 方式 2：使用 Docker Compose 启动

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
      - CLUSTER_TOKEN=xray_cluster_secret_key_2026 # 集群引导令牌
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

### 方式 3：纯单机运行（不连 Hub 控制中心）
若不配置 `PANEL_URL`，系统将自动进入单机独立模式，在终端日志及 `./data/client_info.txt` 输出开箱即用的客户端 `vless://` 直连链接。

---

## ⚙️ 环境变量详解

| 环境变量 | 默认值 | 作用说明 |
| :--- | :--- | :--- |
| `PANEL_URL` | *(空)* | Hub 控制中心访问地址（例：`https://hub.example.com:8443`）。若留空则为纯单机模式 |
| `CLUSTER_TOKEN` | *(空)* | 集群引导令牌（首次连接用于 TOFU 认证）。也可用 `NODE_KEY` |
| `NET_MODE` | `auto` | 网络模式：`auto`（智能探测）、`direct`（强制公网直连）、`reverse_wss`（强制 NAT4 反穿） |
| `PORT` | `443` | 节点直连监听端口（反穿模式下对外端口由 Hub 代理接管） |
| `DEST` | `www.microsoft.com:443` | REALITY 伪装回落目标 |
| `SERVER_NAMES` | `www.microsoft.com,microsoft.com` | REALITY 伪装 SNI 列表（逗号分隔） |
| `DATA_DIR` | `/data` | 持久化数据目录，存储 node_id、node_key、真实公钥及 config.json |

---

## 📂 项目包结构说明 (`xray_core/app/`)

```text
app/
├── __init__.py         # 包声明与版本号 (v1.0.15)
├── __main__.py         # 容器唯一启动入口 (python3 -m app)
├── config.py           # 环境变量与路径解析配置
├── net_detector.py     # IPv4/IPv6 双栈探测与 Oracle/AWS 1:1 NAT 元数据判定
├── config_builder.py   # 区分构建 Direct REALITY 与 Reverse WSS 的 config.json
├── xray_manager.py     # 密钥推导、ShortId、语法沙箱预检与看门狗
├── tunnel.py           # WSS 反向隧道全双工桥接与 Ping-Pong 心跳探活
└── hub_client.py       # 主控端心跳握手、TOFU 准入、用户同步与流量结算
```

---

## 📱 客户端兼容性

无论节点是海外公网直连（REALITY），还是家宽 NAT4 反穿（WSS），**Hub 端下发的订阅地址均会自动生成标准原生链接**，完全兼容：
- **v2rayN / xrayN (Windows)**
- **Clash-Meta / Clash Verge (Rev)**
- **Sing-box (Android / iOS)**
- **Shadowrocket (小火箭 / iOS)**
