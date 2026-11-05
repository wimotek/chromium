# Wimotek Edge Agent (wimotek-edge-agent)

[![PyPI version](https://img.shields.io/pypi/v/wimotek-edge-agent.svg?color=blue)](https://pypi.org/project/wimotek-edge-agent/)
[![npm version](https://img.shields.io/npm/v/wimotek-edge-agent.svg?color=red)](https://www.npmjs.com/package/wimotek-edge-agent)
[![Python Version](https://img.shields.io/pypi/pyversions/wimotek-edge-agent.svg)](https://pypi.org/project/wimotek-edge-agent/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

轻量、通用、零侵入的边缘节点出站反向代理与服务中继客户端（Universal Edge Reverse Tunnel & Service Bridge Agent）。

专为处于 **无公网 IP、NAT4、移动宽带、家用路由器或严格云防火墙** 环境下的容器（noVNC、Kasm Workspaces、Headless Chromium、自动化爬虫等）与边缘服务器设计，提供全自动设备确权、双模身份认证与本地端口透明反向穿透能力。

---

## 🌟 核心特性

- **⚡ 出站长连接 NAT4 极速穿透**：通过单向发起 Outbound WebSocket (WSS/TLS) 长连接直达中心管理端，彻底突破多层 NAT 与企业内网防火墙，**节点无需公网 IP、无需路由器端口映射**。
- **🛡️ 生产级双模身份认证与防伪造（TOFU + Edge Agent）**：
  - **默认 TOFU 模式（Trust On First Use）**：零配置启动，节点自动生成硬件指纹 UUID，管理端后台实时弹出审核认领，管理员「一键信任锁定」后完成公钥防篡改绑定。
  - **Edge Agent 模式**：批量注入 `JOIN_TOKEN`，节点开机秒级自验证入网，支持 CI/CD 与大规模集群全自动挂靠。
- **🤖 智能命名与设备自协商**：自动探测出口公网 IP 或物理网卡 IP 智能拼接命名（如 `Node-123.45.67.89`），嗅探失败平滑降级为容器主机名。
- **🔌 通用本地服务透明桥接（Decoupled & Multi-Service）**：业务完全解耦，不仅支持 Chromium CDP（9222），亦可同时中继 VNC 桌面（6080）、Web 业务 API（8080）等任意本地端口。
- **🌐 跨语言分发与 CLI 驱动**：同时发布至 PyPI 与 npm，支持系统级全局命令 `edge-agent` 与 `npx wimotek-edge-agent`。

---

## 🏗️ 架构原理

```text
 ┌────────────────────────────────────────────────────────┐
 │ 边缘内网节点 (家用宽带 / NAT4 / 容器无公网IP)           │
 │                                                        │
 │   - Chromium CDP (:9222)                               │
 │   - noVNC 桌面 (:6080)                                 │
 │   - 自定义业务服务 (:8080)                             │
 └──────────────────────────┬─────────────────────────────┘
                            ▲ 本地 127.0.0.1 访问
                            ▼
 ┌────────────────────────────────────────────────────────┐
 │               wimotek-edge-agent 客户端                │
 │                                                        │
 │   职责: 硬件指纹生成 + TOFU/Token协商 + 本地服务透明中继 │
 └──────────────────────────┬─────────────────────────────┘
                            │
                            │ 主动发起出站反向长连接 (Outbound TLS/WSS)
                            │ 仅需中心管理端暴露 8443 端口，无视客户端网络环境
                            ▼
 ┌────────────────────────────────────────────────────────┐
 │              中心控制端 (Central Hub)                  │
 │                                                        │
 │   - 管理员在线认领锁定 (TOFU) / Token 自动化放行       │
 │   - 借由反向长连接随时下发指令、Cookie同步、采集探针   │
 └────────────────────────────────────────────────────────┘
```

---

## 📦 安装与调用

### 1. Python / PyPI 安装（推荐）
```bash
pip install wimotek-edge-agent
```
安装后直接获得系统全局命令 **`edge-agent`**。

### 2. Node.js / npm 免安装执行
```bash
npx wimotek-edge-agent --hub-url https://hub.yourdomain.com:8443
```
或全局安装：
```bash
npm install -g wimotek-edge-agent
```

---

## 🚀 快速上手

### 1. 命令行直接启动 (CLI)
```bash
# 最简启动 (直连模式，自动嗅探 IP 命名)
edge-agent --hub-url https://hub.yourdomain.com:8443

# NAT4 穿透模式 (无公网 IP 环境)
edge-agent --hub-url https://hub.yourdomain.com:8443 --reverse

# 批量免审批模式 (携带集群入网通行码)
edge-agent --hub-url https://hub.yourdomain.com:8443 --join-token hub_join_xxxxxx --reverse
```

### 2. 环境变量一键启动（容器化最佳实践）
无需修改命令，直接传入环境变量：
```bash
export HUB_URL="https://hub.yourdomain.com:8443"
export JOIN_TOKEN="hub_join_xxxxxx" # 可选，不填走 TOFU 待认领模式
export REVERSE_TUNNEL="true"        # 可选，默认 false；NAT4 无公网环境设为 true
edge-agent
```

### 3. Python 脚本编程式集成
```python
from wimotek_edge_agent import EdgeAgent

agent = EdgeAgent(
    hub_url="https://hub.yourdomain.com:8443",
    join_token="hub_join_xxxxxx",     # 可选
    node_name="Seoul-Worker-01",      # 可选，留空自动按 IP 拼接
    node_group="爬虫矩阵组",           # 默认: 默认分组
    cdp_port=9222,                    # 默认: 9222
    reverse_tunnel=True               # 开启 NAT4 反向长连接
)

# 启动后台代理 (阻塞运行)
agent.run()
```

---

## ⚙️ 环境变量与参数字典

| 环境变量名 | CLI 参数 | 默认值 | 描述 |
| :--- | :--- | :--- | :--- |
| `HUB_URL` | `--hub-url` | *无 (必填)* | 中心管理端 HTTPS/WSS 地址，如 `https://hub.domain.com:8443` |
| `JOIN_TOKEN` | `--join-token` | `""` (空) | 集群入网通行码。**留空走 TOFU 后台审核认领**；填入则走 Edge Agent 自动放行入网 |
| `REVERSE_TUNNEL`| `--reverse` / `--direct` | `false` | 是否开启出站反向长连接隧道。**无公网 IP/NAT4 环境设为 `true`**；有公网/局域网设为 `false` |
| `NODE_NAME` | `--node-name` | 自动嗅探 | 节点名称。未设置时自动以出口 IP 命名（如 `Node-123.45.67.89`），兜底为主机名 |
| `NODE_GROUP` | `--group` | `默认分组` | 节点所属集群分组，便于多策略调度分类 |
| `CDP_PORT` | `--port` | `9222` | 容器本地需要中继的主服务端口（如 Chromium 调试端口） |
| `LOCAL_CDP_HOST`| `--cdp-host` | `127.0.0.1` | 节点本地被中继服务的绑定地址 |
| `SERVICES` | `--services` | *无* | 多服务端口定义，格式：`cdp:9222,vnc:6080,api:8080` |
| `UUID_FILE` | `--uuid-file` | `/data/node_machine.id` | 硬件指纹持久化文件路径，保障重启后身份不漂移 |

---

## 🐳 Docker 生产环境集成示例

### 场景 1：noVNC / Kasm 节点 Dockerfile 集成
在现有的浏览器镜像中，只需增加 `pip install` 即可：

```dockerfile
FROM debian:bookworm-slim

# 安装 Chromium、noVNC 及基础环境
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium xvfb x11vnc novnc websockify python3 python3-pip curl \
    && rm -rf /var/lib/apt/lists/*

# 一行安装通用边缘 Agent
RUN pip3 install --no-cache-dir --break-system-packages wimotek-edge-agent

COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
ENTRYPOINT ["/app/entrypoint.sh"]
```

在 `entrypoint.sh` 中只需一行后台唤起：
```bash
#!/bin/bash
# 启动本地服务 (如 Chromium 9222)
chromium --remote-debugging-port=9222 --remote-allow-origins=* &

# 只要注入了 HUB_URL，自动在后台拉起边缘代理
if [ -n "$HUB_URL" ]; then
    echo "🚀 启动 wimotek-edge-agent ..."
    edge-agent &
fi

wait -n
```

### 场景 2：`docker-compose.yml` 极简部署

#### 无公网 IP / 家用宽带 / NAT4（开启反向长连接）：
```yaml
version: '3.8'

services:
  browser-node:
    image: your-browser-image:latest
    restart: unless-stopped
    ports:
      - "6080:6080"  # 仅供内网访问桌面，公网无需暴露 9222
    environment:
      - HUB_URL=https://hub.yourdomain.com:8443
      - JOIN_TOKEN=hub_join_abcdef1234567890   # 可选：留空在控制台一键点击认领
      - REVERSE_TUNNEL=true                    # NAT4 穿透开关
      - NODE_GROUP=北美爬虫矩阵组
    volumes:
      - ./data:/data
```

#### 拥有独立公网 IP 的云服务器（直连心跳上报）：
```yaml
version: '3.8'

services:
  browser-node:
    image: your-browser-image:latest
    restart: unless-stopped
    ports:
      - "9222:9222"  # 防火墙已开放端口
    environment:
      - HUB_URL=https://hub.yourdomain.com:8443
      - REVERSE_TUNNEL=false  # 默认即为 false，仅发起轻量 HTTP 登记，零长连接开销
```

---

## 🔒 安全性考量

1. **防恶意伪造（SSRF 防御）**：在直连上报模式下，管理端强制从底层 TCP 握手来源直接锁定节点的真实来源 IP，杜绝假冒内网私网地址。
2. **防公网扫描冒充**：未携带 `JOIN_TOKEN` 的未知连接一律进入隔离待审核队列（TOFU），未经管理端管理员后台显式认领的节点，绝不参与任何数据交互。
3. **安全通信**：长连接反向通道强制基于 TLS (WSS) 传输，天然防御中间人窃听与数据篡改。

---

## 📄 License

MIT License © 2026 [Wimotek](https://github.com/wimotek)
```