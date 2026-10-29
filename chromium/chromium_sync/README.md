明白了，已记下。以后生成 README 等 Markdown 文档时，直接输出原生 Markdown 文本，绝不再在外层包裹多余的 Markdown 代码框。

以下是完整的 `README.md` 原码内容：

# Chromium CDP Cluster Cookie Sync Manager

> 专注于 Chromium / Chrome CDP（Chrome DevTools Protocol）节点 Cookie 集中调度、SSH 穿透隧道管理与自动化同步的 Web 控制台。

[![Docker](https://img.shields.io/badge/Docker-Ready-blue.svg?logo=docker)](https://www.docker.com/)
[![Vue](https://img.shields.io/badge/Frontend-Vue%203%20(Vite)-4FC08D.svg?logo=vue.js)](https://vuejs.org/)
[![FastAPI](https://img.shields.io/badge/Backend-FastAPI-009688.svg?logo=fastapi)](https://fastapi.tiangolo.com/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## 📌 项目特性

- **现代暗黑风 SPA 界面**：基于 Vue 3 (`<script setup>`) 与 Tailwind CSS 构建，输入表单遵循 70% 响应式自适应约束。
- **SSH 动态穿透与隧道池**：自动建立本地端口到远程 CDP 实例（默认 9222）的本地端口转发，支持后台一键开关隧道与状态监控。
- **证书集中管理与多节点复用**：
  - 支持集中上传私钥证书（`.pem` / `id_rsa` 等），权限自动规范为 `0o600`；
  - 节点创建时自由选取证书，支持多个节点复用同一个私钥，亦兼容密码认证。
- **Cookie 智能同步引擎**：
  - **原生集成**：自动载入目录下的 `chromium_sync_module` 模块；
  - **无缝容灾**：若模块未引入，自动回退到纯原生 WebSocket CDP 通讯机制（`Storage.getCookies` & `Network.setCookies`）。
  - **调度机制**：支持手动一键同步及 15 分钟间隔的自动定时同步；自由指定源节点（Source Node）。
- **人机安全防护与防爆破**：
  - 动态服务端生成几何噪点算术 SVG 验证码，防爬虫机器人探测；
  - 密码连续错误 IP 级 15 分钟临时封禁；
  - JWT 秘钥自增存储于 SQLite，完全免除手工配置。
- **全链路 SSL (HTTPS)**：
  - 默认以 HTTPS 协议启动（监听 `8443` 端口）；
  - **智能回退机制**：自动检测 `/certs` 目录下通用的 `fullchain.pem` 与 `privkey.pem`。若未挂载有效证书，系统自动签发 10 年期自签名证书，实现开箱即用。
- **零前端依赖打包**：采用 Docker 多阶段构建（Multi-stage Build），在容器内自动编译前端，宿主机无需安装 Node.js 或 npm。

---

## 🚀 快速启动

### 1. 前置准备
确保宿主机已安装 Docker 及 Docker Compose。

### 2. 配置与启动
进入 `chromium_sync` 目录：

```bash
# 启动并自动进行多阶段编译构建
docker compose up -d --build
```

### 3. 访问系统
* 浏览器打开：`https://<你的服务器IP>:8443`
* **默认管理员密码**：`Admin@123456`
* **首次访问说明**：若未挂载外部正式证书，浏览器将使用系统生成的自签名证书，会提示“您的连接不是私密连接”，点击 **高级 -> 继续前往** 即可。

---

## ⚙️ 配置说明

### 1. 环境变量与端口 (`docker-compose.yml`)

```yaml
services:
  chromium-sync:
    build: .
    container_name: cdp_sync_manager
    restart: unless-stopped
    ports:
      - "8443:8443"              # Web 控制台 HTTPS 端口
      - "19200-19250:19200-19250" # 映射给本地 CDP 隧道的监听端口段
    volumes:
      - ./data:/data             # 数据库及 SSH 私钥持久化
      - ./certs:/certs           # SSL 证书目录
    environment:
      - ADMIN_INIT_PASS=Admin@123456  # 初始管理员密码
```

> **提示**：若希望直接通过标准 HTTPS 端口访问，只需修改端口映射为 `"443:8443"` 即可。

### 2. 挂载自有 SSL 证书
如果你拥有正式域名证书（如 Let's Encrypt、阿里云、腾讯云申请的证书）：
1. 将公钥证书（包含证书链）命名为 `fullchain.pem`
2. 将私钥文件命名为 `privkey.pem`
3. 将上述两文件存入宿主机的 `./certs` 文件夹：
   ```bash
   cp your_cert.crt ./certs/fullchain.pem
   cp your_cert.key ./certs/privkey.pem
   ```
4. 重启容器生效：
   ```bash
   docker compose restart
   ```

---

## 📖 使用指南

### 步骤 1：上传 SSH 证书（可选）
若远程节点使用私钥登录，进入面板 **SSH 密钥/证书管理** 区域，上传 `.pem` 或私钥文件。

### 步骤 2：添加 CDP 节点
点击 **+ 新建节点**，填写目标节点信息：
- **节点名称**：自定义标识（如：`欧洲-节点01`）
- **SSH 连接信息**：SSH Host、Port（默认 22）、用户名（如 `root`）
- **认证方式**：
  - 从下拉框选取之前上传的证书（**多台主机可随意复用同一个证书**）；
  - 或留空证书下拉项，在下方直接填写 SSH 登录密码。
- **远程 CDP 端口**：远程 Chromium 启动时的调试端口（默认 `9222`）
- **本地转发端口**：绑定到容器内的本地端口（如 `19222`，需在已开放端口范围内）

### 步骤 3：建立穿透并设置源节点
1. 点击节点列表中的 **启动穿透**，状态变为绿色的 `● connected` 即代表 SSH 隧道建立成功；
2. 点击某个节点的 **设为源**，将其标记为 `源 (Source)`。
   - 系统将以此节点的 Cookie 为基准，分发至其他所有未设为源的目标节点。

### 步骤 4：执行同步
- **手动同步**：点击右上角 **⚡ 立即同步**，执行 Cookie 捕获并推送到各节点；
- **定时同步**：系统后台每 15 分钟自动执行一次全量提取与分发；
- **任务日志**：右下角可实时追踪每次同步的 Cookie 数量及各节点分发状态。

---

## 🛡️ 安全与防护

1. **防爆破机制**：单 IP 连续密码或验证码错误 5 次，自动触发封禁 15 分钟。
2. **密码重置**：登录后点击导航栏的 **修改密码**，可直接在线重置管理员登录密码。
3. **私钥权限控制**：上传的 SSH 私钥保存到 `/data/keys` 后，系统会自动赋予 `0o600` Linux 权限，防止 Paramiko 因权限过大抛出异常。
4. **JWT 签名防篡改**：首次启动由系统在 SQLite 中生成 64 位不可逆强随机密钥，重启不丢失，外部不可猜解。

---

## 🛠️ 常见问题 (FAQ)

#### Q1：添加节点并启动穿透时，显示 `error: Authentication failed`？
- 检查 SSH 用户名、密码或上传的证书内容是否正确；
- 远程目标主机的 `/etc/ssh/sshd_config` 是否开启了对应的公钥认证（`PubkeyAuthentication yes`）或密码认证。

#### Q2：同步日志显示 `源节点读取中断: Connection refused`？
- 确认远程主机上的 Chromium 进程是否已正确开启远程调试，需包含启动参数：
  ```bash
  --remote-debugging-port=9222 --remote-debugging-address=0.0.0.0
  ```
- 确认已在控制台点击该节点的 **启动穿透**，且状态为绿色的 `● connected`。