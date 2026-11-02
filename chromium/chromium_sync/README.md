# ⚡ Chromium CDP Sync Hub

> **分布式 Chromium 节点集群治理与多策略 Cookie 调度控制台**  
> 基准代码仓：`https://github.com/wimotek/chromium/tree/main/chromium/chromium_sync`

---

## 📖 项目简介

**Chromium CDP Sync Hub** 是一套专为多账号矩阵、分布式爬虫及自动化测试集群打造的生产级 Chrome DevTools Protocol (CDP) 节点治理与 Cookie 智能同步调度系统。

系统通过深曜石黑科技风格（Dark Obsidian HUD）的 Web 控制台，帮助运维与开发者将分散在各地的本地或远程 Chromium 实例进行统一分组监管、凭证汇聚融合与双向增量下发，并提供基于 API-Key 的安全 WSS 远程调试反向代理网关。

### 🌟 核心特性

- **👥 节点集群分组与双向穿透**：
  - 支持 **免 SSH 本地/局域网直连**（支持配置局域网 IP 如 `192.168.x.x` 或内部域名，默认 `127.0.0.1`）；
  - 支持 **远程 SSH 密钥/密码隧道穿透**，内置 30 秒心跳看门狗后台自动自愈保活；
  - 支持 **自定义集群分组（Group）**，提供顶部按组快速筛选；
  - 支持 **双击切换源节点**，随时取消默认源，回归完全对等节点。
- **🌐 多策略同步调度中枢**：
  - **🌟 智能全局最新值合并 (Smart Merge)**：各节点产生的最新有效登录态自动取并集，同名 Cookie 按有效期顺延时间与特征消歧融合，**无需指定固定源节点**；
  - **🏢 组对组分发 (Group-to-Group)**：自动聚合源分组全部节点的最新 Cookie，并发分发给目标分组所有节点；
  - **🎯 节点对组分发 (Node-to-Group)**：以单个 Master 节点为基准一键辐射分发至指定分组；
  - **💻 节点对多节点 (Node-to-Nodes)**：经典一对多定向队列下发；
  - 独立定时调度：每条策略均可独立设置定时执行周期（分钟），并支持手动即时单项触发。
- **🛡️ 全局 Cookie 过滤与差量同步 (Diff / Delta Sync)**：
  - **差量指纹检测**：仅对比发生实质变更（值或到期时间）的 Cookie 进行增量下发，跳过无变化项，极大降低浏览器存储刷盘损耗；
  - **域名黑/白名单**：支持配置业务域名白名单（仅同步指定站点）与广告追踪黑名单（默认过滤 `doubleclick.net, google-analytics.com`）。
- **🔒 两种远程 CDP 连接方式（安全网关 vs 裸端口直连）**：
  - **方式一（安全 WSS 反向网关，推荐）**：全流量收敛于唯一的 HTTPS `8443` 端口，强制校验 `X-API-Key`，彻底消除公网扫描与 RCE 裸奔风险；
  - **方式二（公网裸端口映射）**：兼容原有直接连接 `19200-19250` 端口的自动化脚本，控制台提供全局动态开关。
- **🍪 96vw 超宽生命周期透视抽屉**：
  - 弹出全屏流式 96vw 宽幅抽屉，详细透视每条 Cookie 的有效持久状态、会话凭证状态与到期倒计时，**单行平铺绝不折行**。
- **📜 定容结构化审计流水**：
  - 清晰呈现：时间戳、源端发起、分发目标范围、Cookie 数量、精确耗时（如 `0.85s`）、状态与详细堆栈轨迹；
  - **自动定容滚动淘汰**：入库自动轮转，**严格仅保留最近 20 条记录**，数据库永久轻量，支持一键清空。
- **🔔 独立双通道告警中心**：
  - **SMTP 邮件底座**（1:1 状态指示灯、密码留空保持、发件人名称、SSL 加密与即时发信测试）；
  - **Server酱微信服务号推送**（一键微信弹窗通知集群离线与同步故障）。


---

## 🚀 快速部署与启动

### 1. 克隆仓库与准备环境

确保服务器已安装 Docker 与 Docker Compose：

```bash
git clone https://github.com/wimotek/chromium.git
cd chromium/chromium/chromium_sync
```

### 2. 检查 `docker-compose.yml`

```yaml
services:
  chromium-sync:
    build: .
    container_name: cdp_sync_manager
    restart: unless-stopped
    ports:
      - "8443:8443"
    volumes:
      - ./data:/data
      - ./certs:/certs
    # environment:
    #   # 【可选】：如果完全注释不填，系统默认使用 admin / 123456
    #   - ADMIN_INIT_USER=admin
    #   - ADMIN_INIT_PASS=123456
```

### 3. 一键编译并启动

```bash
docker compose up -d --build
```

### 4. 访问系统

- **访问地址**：`https://<你的服务器IP或域名>:8443`
- **默认用户名**：`admin`
- **默认初始化密码**：`123456`（首次登录后可在卡片 4 中随时修改）
- **算术验证码**：直接输入计算结果即可登录。

---

## 🛠️ 外部程序与 Agent 调用指南

系统已为外部第三方自动化程序（如 AI Agent、分布式爬虫）开放了标准接口与反向中继通道。

### 方式一：API-Key 安全 WSS 反向网关连接（强烈推荐 ⭐⭐⭐⭐⭐）

无需在云服务器防火墙开放复杂的 `19200-19250` 裸端口，全部通过 **`8443` 端口全量 TLS 加密传输**，未携带合法 API-Key 外部连接将被直接断开。

#### 1. Playwright (Python 示例)

```python
import asyncio
from playwright.async_api import async_playwright

API_KEY = "cdp_U2GZUVe-TxGRevRV90eq_gMPrpHyUsbF"  # 在卡片 4 中获取
DOMAIN = "your-domain.com"
NODE_ID = 1  # 目标节点 ID

async def main():
    async with async_playwright() as p:
        # 直接通过 WSS 鉴权网关连接远程浏览器
        cdp_url = f"wss://{DOMAIN}:8443/cdp/{NODE_ID}/ws?api_key={API_KEY}"
        browser = await p.chromium.connect_over_cdp(cdp_url)
        
        context = browser.contexts[0]
        page = await context.new_page()
        await page.goto("https://ipinfo.io")
        print("页面标题:", await page.title())
        
        await browser.close()

asyncio.run(main())
```

#### 2. Playwright (Node.js 示例)

```javascript
const { chromium } = require('playwright');

(async () => {
  const apiKey = 'cdp_U2GZUVe-TxGRevRV90eq_gMPrpHyUsbF';
  const cdpUrl = `wss://your-domain.com:8443/cdp/1/ws?api_key=${apiKey}`;

  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0];
  const page = await context.newPage();
  await page.goto('https://ipinfo.io');
  console.log(await page.title());
  await browser.close();
})();
```

#### 3. Puppeteer 连接示例

```javascript
const puppeteer = require('puppeteer-core');

(async () => {
  const browser = await puppeteer.connect({
    browserWSEndpoint: 'wss://your-domain.com:8443/cdp/1/ws?api_key=cdp_U2GZUVe-TxGRevRV90eq_gMPrpHyUsbF'
  });
  const page = await browser.newPage();
  await page.goto('https://ipinfo.io');
  await browser.disconnect();
})();
```

---

### 方式二：公网裸端口直接映射（兼容模式）

若你的旧脚本不支持 WSS URL 参数，可在控制台卡片 4 开启「公网端口直接映射访问」，并在宿主机防火墙放行对应端口（如 `19222`）：

```python
from playwright.async_api import async_playwright

async with async_playwright() as p:
    browser = await p.chromium.connect_over_cdp("http://<服务器IP>:19222")
    page = await browser.new_page()
    await page.goto("https://ipinfo.io")
```

---

### 开放 REST API 接口汇总

所有开放 API 需在请求头携带 `X-API-Key: cdp_xxx` 或 URL 参数 `?api_key=cdp_xxx`。

| 方法 | 请求路径 | 说明 | 返回内容 |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/nodes` | 获取全网节点列表 | 包含每个节点的在线状态、双连接方式（WSS 网关 + 裸端口直连完整 URL） |
| `GET` | `/api/v1/nodes/{id}/cookies` | 导出单节点全量 Cookies | 包含完整的 Cookie JSON 数据 |
| `POST` | `/api/v1/sync` | 外部 Webhook 触发同步 | 触发默认策略的全网 Cookie 同步与对齐 |

#### 批量获取节点连接信息示例：
```bash
curl -H "X-API-Key: cdp_U2GZUVe-TxGRevRV90eq_gMPrpHyUsbF" \
     https://your-domain.com:8443/api/v1/nodes
```
**返回数据格式：**
```json
{
  "code": 200,
  "total": 2,
  "online_count": 2,
  "direct_port_access_enabled": true,
  "nodes": [
    {
      "id": 1,
      "name": "欧洲爬虫 01",
      "is_source": false,
      "is_local": false,
      "status": "connected",
      "cookie_count": 85,
      "last_sync": "2026-11-02 10:00:00",
      "connection_methods": {
        "gateway": {
          "type": "wss_secure_gateway",
          "enabled": true,
          "description": "基于 API-Key 的加密反向中继网关 (推荐，防扫描，仅走 8443)",
          "ws_url": "wss://your-domain.com:8443/cdp/1/ws?api_key=cdp_U2GZUVe-TxGRevRV90eq_gMPrpHyUsbF",
          "http_version_url": "https://your-domain.com:8443/cdp/1/json/version?api_key=cdp_U2GZUVe-TxGRevRV90eq_gMPrpHyUsbF"
        },
        "direct": {
          "type": "direct_port_mapping",
          "enabled": true,
          "port": 19222,
          "http_endpoint": "http://your-domain.com:19222"
        }
      },
      "cookies_export_url": "/api/v1/nodes/1/cookies"
    }
  ]
}
```

---

## ⚙️ 常见运维与排查手册

### 1. 查看容器日志
```bash
docker compose logs -f
```

### 2. 重置管理员密码
如果忘记密码，可进入容器执行重置指令：
```bash
docker exec -it cdp_sync_manager python3 -c '
from core.database import set_setting
from core.security import hash_password
set_setting("admin_password", hash_password("Admin@123456"))
print("管理员密码已重置为: Admin@123456")
'
```

### 3. 数据备份与迁移
所有数据（节点配置、分组、策略、SSH 私钥及审计记录）均持久化在 `./data` 目录下：
- 数据库文件：`./data/app.db`
- SSH 私钥金库：`./data/keys/`
- 仅需备份 `./data` 目录即可实现全量无损迁移。

---

## 📜 开源与生态组件

- **核心同步组件**：已发布至 PyPI 的通用库 [`wimotek-chromium-sync`](https://pypi.org/project/wimotek-chromium-sync/)，可通过 `pip install wimotek-chromium-sync` 直接引入。
- **协议兼容**：遵循原生 Chrome DevTools Protocol 规范。