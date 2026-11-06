# ⚡ Chromium Distributed CDP Cluster & Cookie Synchronization Hub

分布式 Chromium 节点集群治理、多策略 Cookie 调度与安全 WSS 远程调试代理网关。

---

## 🌟 核心特性与架构升级

1. **PyPI 标准模块化依赖 (`wimotek-edge-agent`)**：
   - 节点镜像彻底摆脱零散 Python 脚本拷贝，通过 `pip` 统一安装商业级边缘接入控制套件；
   - 原生对接 Chromium `127.0.0.1:9222`，零损耗内网直连。
2. **三模式智能自适应网络接入 (`REVERSE_TUNNEL`)**：
   - **智能自适应 (默认 `None`)**：节点启动时向 Hub 发送双向回声探针 (`/api/nodes/detect-mode`)。若 Hub 能直接反向打通 CDP 端口，自动走直连纳管；若被 NAT4/家宽/云防火墙阻断，自动无感切换为出站反向长连接隧道；
   - **强制穿透 (`REVERSE_TUNNEL=true`)**：跳过网络探测，强制建立出站 WSS 安全长连接，杜绝公网暴露；
   - **强制直连 (`REVERSE_TUNNEL=false`)**：跳过隧道，仅通过 HTTP 向 Hub 登记直连 IP。
3. **零信任准入控制与双模认证**：
   - **Edge Agent 模式 (批量免审)**：配置 `JOIN_TOKEN` (标准 40 字符紧凑凭据)，秒级自动放行；
   - **TOFU 模式 (首连待审)**：不填 Token，节点隔离在心跳阶段，管理端顶栏弹出待认领横幅，管理员一键批准并即时唤醒节点。
4. **多策略凭据调度中枢**：
   - 支持全网智能双向合并 (Smart Merge)、组对组同步 (Group-to-Group)、节点对组 (Node-to-Group)、节点对多节点；
   - 前置 0 差异秒级跳过与自动垃圾清理 (单域名 50 条熔断)。
5. **安全 WSS CDP 网关 (`8443`)**：
   - 全网流量收敛于唯一 HTTPS/WSS 端口，强制校验 `api_key`，支持穿透反向控制 NAT4 节点中的 Chromium。

---

## 🚀 节点端快速部署

### 方案 1：noVNC 节点容器 (极简版)

#### 极简出站穿透 (NAT4 / 家宽推荐，只需提供 HUB_URL)
```bash
docker run -d \
  --name chromium-novnc \
  -p 6080:6080 \
  -p 9222:9222 \
  -e HUB_URL=https://hub.yourdomain.com:8443 \
  -e JOIN_TOKEN=hub_join_xxxxxxxxxxxxxxxxxxxx \
  -v ./novnc_data:/data \
  --shm-size="2gb" \
  --restart unless-stopped \
  wimotek/chromium:novnc
```

#### 宿主机映射自定义端口 (例如映射为 1922)
若宿主机映射了自定义端口（如 `-p 1922:9222`），传入 `DIRECT_PORT=1922`，探针将自动以 1922 端口探测并登记：
```bash
docker run -d \
  --name chromium-novnc \
  -p 6080:6080 \
  -p 1922:9222 \
  -e HUB_URL=https://hub.yourdomain.com:8443 \
  -e DIRECT_PORT=1922 \
  -v ./novnc_data:/data \
  wimotek/chromium:novnc
```

---

### 方案 2：KasmVNC 节点容器 (流媒体增强版)

```bash
docker run -d \
  --name chromium-kasm \
  -p 6901:6901 \
  -p 9222:9222 \
  -e HUB_URL=https://hub.yourdomain.com:8443 \
  -e JOIN_TOKEN=hub_join_xxxxxxxxxxxxxxxxxxxx \
  -e VNC_PASSWORD=MySecurePassword123 \
  -v ./kasm_data:/data \
  --shm-size="2gb" \
  --restart unless-stopped \
  wimotek/chromium:kasmvnc
```

---

## ⚙️ 节点环境变量参数规范

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `HUB_URL` | *(空)* | Hub 控制台公网地址（如 `https://hub.domain.com:8443`），填入即激活边缘代理 |
| `REVERSE_TUNNEL` | `None` *(auto)* | 穿透模式：留空为智能探测；`true` 强制反向长连接；`false` 强制直连登记 |
| `JOIN_TOKEN` | *(空)* | 集群入网通行码；填入走免审直入，留空走后台 TOFU 认领审批 |
| `NODE_NAME` | 智能嗅探 | 节点标识名称；留空自动嗅探出口公网 IP 或 Hostname 命名并持久化 |
| `DIRECT_PORT` | `9222` | 宿主机映射端口；当宿主机使用 `-p 1922:9222` 时传入 `DIRECT_PORT=1922` |
| `CDP_PORT` | `9222` | 容器内部 Chromium 原生监听调试端口 |

---

## 🛠️ Hub 主控端快速部署 (`chromium_sync`)

```bash
cd chromium/chromium_sync
docker compose up -d --build
```

- **访问地址**：`https://<服务器IP或域名>:8443`
- **默认账号密码**：`admin` / `123456`
- **数据持久化**：`./data/app.db`（SQLite WAL 高并发防锁模式）、`./data/audit.jsonl`（零信任准入审计日志）

---

## 🤖 外部 AI Agent / Playwright 远程调试调用

通过 Hub 统一鉴权网关安全接入，彻底阻断公网端口暴露风险：

```python
import asyncio
from playwright.async_api import async_playwright

API_KEY = "cdp_xxxxxxxxxxxxxxxxxxxx"  # 在 Hub 控制台获取
HUB_HOST = "hub.yourdomain.com:8443"
NODE_ID = 1  # 目标节点 ID (支持穿透控制 NAT4 内网节点)

async def main():
    async with async_playwright() as p:
        cdp_url = f"wss://{HUB_HOST}/cdp/{NODE_ID}/ws?api_key={API_KEY}"
        browser = await p.chromium.connect_over_cdp(cdp_url)
        page = await browser.new_page()
        await page.goto("https://github.com/wimotek/chromium")
        print("Page Title:", await page.title())
        await browser.close()

asyncio.run(main())
```

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源。