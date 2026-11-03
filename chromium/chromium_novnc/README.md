# Minimal Chromium (Web UI + CDP + Clipboard Sync)

[![Docker Image Size](https://img.shields.io/docker/image-size/wimotek/chromium/latest?style=flat-square)](https://hub.docker.com/r/wimotek/chromium)
[![Docker Pulls](https://img.shields.io/docker/pulls/wimotek/chromium?style=flat-square)](https://hub.docker.com/r/wimotek/chromium)
[![Supported Architectures](https://img.shields.io/badge/arch-amd64%20%7C%20arm64-blue?style=flat-square)](https://hub.docker.com/r/wimotek/chromium)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)


轻量、纯净且深度调优的 Dockerized Chromium 容器方案。专为 **AI Agent（Claude Computer Use、Browser-Use、AutoGPT）、自动化测试（Playwright / Puppeteer）以及远程轻量云桌面** 量身定制。

提供 **noVNC 极简版** 与 **KasmVNC 流媒体版** 双引擎，开箱即用。

---

## 🌟 核心特性与架构升级

* **小键盘锁定默认开启（Num Lock ON）**：容器启动自动激活 X11 `numlockx on`，物理小键盘数字键直接可用，彻底解决小键盘失灵或误触发方向键问题。
* **原生 UTF-8 剪贴板（告别中文乱码）**：
  * **noVNC 版**：彻底淘汰老旧的 `Xvfb + x11vnc + autocutsel` 拼凑方案，全面采用 **`tigervnc-standalone-server` (Xvnc)** 原生 Extended Clipboard 协议，结合容器 UTF-8 本地化字符集，中文字符、特殊符号无缝粘贴不乱码。
  * **KasmVNC 版**：底层基于 WebSocket 现代化数据流，天然具备全字符集极速秒级双向剪贴板同步。
* **智能证书动态检测与回退（`/certs`）**：
  * 启动脚本自动扫描 `/certs` 映射目录下的 `fullchain`（公钥链）与 `privkey`（私钥）；
  * **检测到有效证书时**：优先加载映射的域名真实证书，浏览器访问无安全警告；
  * **未检测到或未映射时**：自动生成 10 年有效期的自签名证书回退兜底，确保 HTTPS（6443 / 8444）与 WSS 安全连接平稳拉起。
* **Tini (PID 1) 守护与原生 `CMD []` 传参**：
  * 使用 `tini` 作为 1 号进程，彻底回收 Chromium 标签崩溃产生的僵尸子进程，正确响应 Docker 停止与重启信号；
  * 镜像采用 `ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]` + `CMD []`，在 `docker run` 末尾可直接追加目标 URL 或自定义 Chromium 启动参数。
* **CDP 9222 端口内部安全穿透（Socat）**：
  * Chromium 内部监听 `127.0.0.1:9223`，配合内置 `socat` 转发至 `0.0.0.0:9222`，完美规避 Chromium 强制绑定本地回环与跨域 403 阻断；
  * 建议生产环境绑定宿主机 `-p 127.0.0.1:9222:9222`，杜绝 CDP 端口暴露在公网遭恶意接管。
* **AI 视觉与自动化基准调优**：
  * 预置 `--test-type` 消除 `--no-sandbox` 顶部黄色警告横幅，避免模型点击坐标（Bounding Box）垂直偏移；
  * 预装文泉驿正黑（`fonts-wqy-zenhei`），杜绝中文网页排版“豆腐块”；
  * 开启零拷贝渲染与多线程光栅化（`--num-raster-threads=4 --enable-zero-copy`）。
* **进程自愈防黑屏**：
  * 误关浏览器或崩溃时，守护进程将在 1 秒内自动拉起，保障无头/远程会话持久可用。

---

## 📊 双引擎版本对比

| 特性维度 | noVNC 极简版 (`:novnc` / `:latest`) | KasmVNC 增强版 (`:kasmvnc`) |
| :--- | :--- | :--- |
| **底层渲染引擎** | TigerVNC Standalone (Xvnc) | KasmVNC Server |
| **Web 访问协议** | **HTTP: 6080** / **HTTPS: 6443** (双端口) | **HTTPS: 8444** (单端口) |
| **剪贴板体验** | 原生 UTF-8 支持，中文粘贴绝不乱码 | 现代化流媒体剪贴板，支持无感秒同步 |
| **画面流畅度** | 25 ~ 30 FPS（差异图片块压缩） | 高达 60 FPS（WebP / H.264 动态压缩） |
| **认证方式** | VNC 密码认证 (`VNC_PASSWORD`) | 用户名 + 密码认证 (`VNC_USER` + `VNC_PASSWORD`) |
| **Init 守护** | Tini (PID 1) | Tini (PID 1) |
| **适用场景** | 资源受限服务器、自动化任务挂机、轻量访问 | 长时间人工操作交互、AI Agent 视觉推理交互 |

---

## 🚀 快速启动

### 方案 1：noVNC 版本（HTTP 6080 + HTTPS 6443）

#### Docker CLI
```bash
docker run -d \
  --name chromium-novnc \
  -p 6080:6080 \
  -p 6443:6443 \
  -p 127.0.0.1:9222:9222 \
  -e VNC_PASSWORD="MySecurePassword123" \
  -e RESOLUTION=1920x1080 \
  -v chromium_data:/data \
  --shm-size="2gb" \
  --restart unless-stopped \
  wimotek/chromium:novnc \
  https://www.google.com
```

#### Docker Compose
```yaml
services:
  chromium:
    image: wimotek/chromium:novnc
    container_name: chromium-novnc
    ports:
      - "6080:6080"             # HTTP 访问
      - "6443:6443"             # HTTPS 访问 (支持自有证书或自签)
      - "127.0.0.1:9222:9222"   # CDP 端口（仅限宿主机访问）
    environment:
      - VNC_PASSWORD=MySecurePassword123
      - RESOLUTION=1920x1080
    volumes:
      - chromium_data:/data
      # 可选：映射自有 SSL 证书目录（内含 fullchain.pem 与 privkey.pem）
      # - /etc/letsencrypt/live/yourdomain.com:/certs:ro
    command: ["https://www.google.com"]
    shm_size: "2gb"
    restart: unless-stopped

volumes:
  chromium_data:
```

* **HTTP 访问**：`http://<服务器IP>:6080`
* **HTTPS 访问**：`https://<服务器IP>:6443`

---

### 方案 2：KasmVNC 版本（HTTPS 8444，极致流畅）

#### Docker CLI
```bash
docker run -d \
  --name chromium-kasm \
  -p 8444:8444 \
  -p 127.0.0.1:9222:9222 \
  -e VNC_USER=admin \
  -e VNC_PASSWORD="MySecurePassword123" \
  -e RESOLUTION=1920x1080 \
  -v chromium_data:/data \
  --shm-size="2gb" \
  --restart unless-stopped \
  wimotek/chromium:kasmvnc \
  https://www.google.com
```

#### Docker Compose
```yaml
services:
  chromium:
    image: wimotek/chromium:kasmvnc
    container_name: chromium-kasm
    ports:
      - "8444:8444"             # KasmVNC HTTPS 访问
      - "127.0.0.1:9222:9222"   # CDP 端口
    environment:
      - VNC_USER=admin
      - VNC_PASSWORD=MySecurePassword123
      - RESOLUTION=1920x1080
    volumes:
      - chromium_data:/data
      # 可选：映射自有 SSL 证书目录
      # - /etc/letsencrypt/live/yourdomain.com:/certs:ro
    command: ["https://www.google.com"]
    shm_size: "2gb"
    restart: unless-stopped

volumes:
  chromium_data:
```

* **Web 访问**：`https://<服务器IP>:8444`（账号：`admin`，密码：`MySecurePassword123`）

---

## 🔒 证书映射与自动回退说明

两个版本均原生支持自动识别 `/certs` 挂载目录：

```bash
-v /etc/letsencrypt/live/yourdomain.com:/certs:ro
```

* **检测匹配规则**：
  * **公钥证书**：支持命名为 `fullchain*.pem`、`fullchain*.crt`、`fullchain`、`cert*.pem`
  * **私钥文件**：支持命名为 `privkey*.pem`、`privkey*.key`、`privkey`、`key*.pem`
* **逻辑机制**：
  * **检测到有效的一组证书时**：控制台输出 `[SSL] 检测到外部映射证书，优先启用自有证书`，自动应用自有合法证书。
  * **未映射或缺少任一文件时**：控制台输出 `[SSL] 回退使用自签证书...`，自动生成 10 年有效期的 RSA-2048 自签证书，保证 HTTPS 始终可用。

---

## 🤖 Playwright / AI Agent CDP 对接

宿主机无需安装浏览器驱动，直接通过 CDP 端口连接操控：

```python
import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        # 连接容器开放的 CDP 回环端口
        browser = await p.chromium.connect_over_cdp("http://127.0.0.1:9222")
        context = browser.contexts[0]
        page = context.pages[0] if context.pages else await context.new_page()

        await page.goto("https://github.com/wimotek/chromium")
        print("Page Title:", await page.title())

asyncio.run(main())
```

---

## ⚙️ 环境变量与参数列表

| 变量 / 参数 | 默认值 | 作用与说明 |
| :--- | :--- | :--- |
| `RESOLUTION` | `1920x1080` | 桌面与 Chromium 视口分辨率（格式：`宽x高`） |
| `VNC_PASSWORD` | *(空)* | Web 登录访问密码（noVNC 与 KasmVNC 均生效） |
| `VNC_USER` | `admin` | KasmVNC Web 登录用户名（仅 KasmVNC 版本） |
| `CHROME_ARGS` | *(空)* | 追加到 Chromium 启动命令中的额外自定义 Flag |
| `CMD [...]` | `[]` | 容器命令行末尾传参，用于直接传入启动首页网址或参数 |

---

## 📂 核心目录挂载

* `/data`：Chromium 用户数据目录（Profile）。建议映射为持久化卷，保持登录状态、Cookies 与插件。
* `/certs`：外部 SSL 证书只读挂载目录（`:ro`）。放入 `fullchain.pem` 和 `privkey.pem` 即可无感生效。

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源。