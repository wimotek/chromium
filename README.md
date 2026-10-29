# Minimal Chromium (Web UI + CDP + Clipboard Sync)

[![Docker Image Size](https://img.shields.io/docker/image-size/wimotek/chromium/latest?style=flat-square)](https://hub.docker.com/r/wimotek/chromium)
[![Docker Pulls](https://img.shields.io/docker/pulls/wimotek/chromium?style=flat-square)](https://hub.docker.com/r/wimotek/chromium)
[![Supported Architectures](https://img.shields.io/badge/arch-amd64%20%7C%20arm64-blue?style=flat-square)](https://hub.docker.com/r/wimotek/chromium)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)

专为 **AI Agent（Claude Computer Use / AutoGPT / Browser-Use）、自动化测试（Playwright / Puppeteer）与远程云桌面** 设计的高性能轻量 Chromium 容器镜像。

支持纯 Web 浏览器访问图形界面、双向原生剪贴板秒同步、开启 9222 端口 Chrome DevTools Protocol (CDP)，并内置防崩溃/防关闭自愈守护机制。

配套提供了通用的会话热同步工具，支持在本地容器与云端远程容器之间**双向无感热同步登录状态（Cookie + LocalStorage）**，无需重新手动扫码登录。 该模块已同步发布至 [PyPI](https://pypi.org/project/wimotek-chromium-sync/) 与 [npm](https://www.npmjs.com/package/wimotek-chromium-sync) 。


---

## 🌟 核心特性

* **双引擎架构**：
  * **noVNC 极简版（`:latest` / `:novnc`）**：开箱即用轻量化实现，同时支持 HTTP (`6080`) 与 HTTPS (`6443`) 双端口。
  * **KasmVNC 版 （`:kasmvnc`）**：采用流媒体级动态编码（WebP / H.264），支持 60FPS 丝滑体验与原生浏览器剪贴板无缝同步。
* **可选映射自有证书.默认自签证书.
* **原生剪贴板双向同步**：宿主机与容器内的 `Ctrl+C / Ctrl+V` 实时无缝互通，彻底摒弃多余的侧边栏中转。
* **CDP 自动化就绪**：预置穿透端口转发与 `--remote-allow-origins=*`，解决高版本 Chromium 强制绑定 `127.0.0.1` 和跨域 403 问题。
* **AI Agent 深度调优**：
  * 屏蔽 `--no-sandbox` 警告横幅（`--test-type`），避免视口挤压造成点击坐标偏移。
  * 预装文泉驿正黑（`font-wqy-zenhei`），杜绝中文网页文字排版“方块豆腐块”。
  * 纯净输入环境：不加载宿主机输入法干扰，支持 CDP 逐字模拟与直接 Unicode 注入。
* **守护进程自愈**：误触网页右上角 `X` 或关闭最后一个标签页时，系统会在 1 秒内自动重新拉起浏览器，彻底告别黑屏。
* **动态传参启动**：支持在命令行直接追加目标首页网址、无痕模式参数或多标签页。
* **公网安全隔离**：支持 Web 账号密码认证；CDP 端口可原生限制仅允许宿主机本地调用，隔绝公网扫描器。

---

## 📊 双版本对比与选型指南

| 对比维度 | KasmVNC 版 (`:kasmvnc`) | noVNC 极简版 (`:latest` / `:novnc`) |
| :--- | :--- | :--- |
| **底包系统** | Debian 12 (Bookworm) Slim | Debian 12 (Bookworm) Slim |
| **画质与流畅度** | **60 FPS**（流媒体编码，滑动/视频极顺滑） | 15~25 FPS（传统图片块传输） |
| **剪贴板体验** | **原生无缝秒同步**（无需任何侧边栏） | HTTPS 原生同步；HTTP 需使用侧边栏 |
| **默认 Web 端口** | HTTPS: `8444` | HTTP: `6080` / HTTPS: `6443` |
| **推荐适用场景** | **日常使用、长时间交互、AI Agent 视觉调试** | 极简双端口访问、轻量化挂机 |

---

## 🚀 快速启动

### 方案 A：noVNC 极简版（双端口）

#### 1. 使用 `docker run` 运行
```bash
docker run -d \
  --name chromium-novnc \
  -p 3000:6080 \
  -p 3001:6443 \
  -p 127.0.0.1:9222:9222 \
  -e VNC_PASSWORD="MySecurePassword123" \
  -e RESOLUTION=1920x1080 \
  -v chromium_data:/data \
  -v /etc/letsencrypt/live/yourdomain.com:/certs:ro \
  --shm-size="2gb" \
  --restart unless-stopped \
  wimotek/chromium:novnc \
  https://www.bing.com
```
HTTP 访问：http://<服务器IP>:6080

HTTPS 访问：https://<服务器IP>:6443（支持原生无缝剪贴板）

### 方案 B：KasmVNC 版

#### 1. 使用 `docker run` 直接运行
```bash
docker run -d \
  --name chromium-kasm \
  -p 8444:8444 \
  -p 127.0.0.1:9222:9222 \
  -e VNC_USER=admin \
  -e VNC_PASSWORD="MySecurePassword123" \
  -e RESOLUTION=1920x1080 \
  -v chromium_data:/data \
  wimotek/chromium:kasmvnc \
  https://www.google.com
```
#### 2. 使用 docker-compose.yml
```Yaml
services:
  chromium:
    image: wimotek/chromium:kasmvnc
    container_name: chromium
    ports:
      - "8444:8444"            # KasmVNC Web 端 (HTTPS)
      - "127.0.0.1:9222:9222"  # 核心保护：CDP 仅允许宿主机访问
    environment:
      - VNC_USER=admin
      - VNC_PASSWORD=MySecurePassword123
      - RESOLUTION=1920x1080
      - HOMEPAGE=https://www.google.com
    volumes:
      - chromium_data:/data
      - /etc/letsencrypt/live/yourdomain.com:/certs:ro    #可选域名证书. 不设置默认使用自签证书
    restart: unless-stopped

volumes:
  chromium_data:
```
Web 访问地址：https://<服务器IP>:8444

默认账号密码：admin / MySecurePassword123

剪贴板同步：首次进入页面浏览器提示“请求剪贴板权限”时点击允许，即可使用 Ctrl+C / Ctrl+V。

##   🤖 AI Agent 与 CDP 自动化接入

###  1. 验证 CDP 状态（宿主机终端执行）
```bash
curl http://127.0.0.1:9222/json/version
```

###  2. Python (Playwright / Agent) 连接示例
```Python
import asyncio from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp("http://127.0.0.1:9222")
        context = browser.contexts[0]
        page = context.pages[0] if context.pages else await context.new_page()

        await page.goto("https://github.com")

        # 模拟真人输入（逐字打字延迟，无需系统安装中文输入法）
        await page.locator("input[name='q']").press_sequentially("AI Agent", delay=150)
        await page.keyboard.press("Enter")

        print("Title:", await page.title())

asyncio.run(main())
```

###  3. 本地远程访问公网服务器的 CDP（安全隧道）
严禁将 9222 直接开放给公网 0.0.0.0。推荐在本地电脑通过 SSH 建立加密通道：
```bash
Bash
ssh -N -L 9222:127.0.0.1:9222 root@<公网服务器IP>
随后本地代码连接 http://127.0.0.1:9222 即可。
```

## ⚙️ 环境变量列表

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `RESOLUTION` | `1920x1080` | 屏幕分辨率（如 1280x800, 2560x1440） |
| `DEPTH` | `24` | 色深（推荐保持 24） |
| `VNC_USER` | `admin` | KasmVNC 登录用户名（仅限 KasmVNC 版） |
| `VNC_PASSWORD`| *无*（空） | Web 访问密码（**公网部署强烈建议设置**） |
| `HOMEPAGE` | `about:blank` | 容器启动时默认打开的网址 |
| `CHROME_ARGS` | *无*（空） | 注入 Chromium 的额外参数（如 `--incognito`） |


##  💡 命令行动态传参示例
可以在 docker run 命令末尾直接附加网址或参数：
```bash
Bash
# 启动时打开指定网址
docker run -d -p 8444:8444 wimotek/chromium:latest https://news.ycombinator.com

# 启动时以无痕模式打开多个标签页
docker run -d -p 8444:8444 wimotek/chromium:latest --incognito https://github.com https://google.com
```


## 📄 License
本项目基于 MIT 许可证 开源。





