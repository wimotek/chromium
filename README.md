# Minimal Chromium Web & CDP Docker

基于 Alpine Linux 的轻量化 Chromium 容器镜像（体积约 400MB），具备完整的 Web 图形访问、剪贴板同步及 CDP 自动化控制能力。

## 特性

* **极简体积**：基于 Alpine 3.20 构建，去除重型桌面，大小仅 ~400MB。
* **双模 Web 访问**：同时支持 HTTP (`6080`) 和 HTTPS (`6443`)。
* **剪贴板同步**：HTTPS 模式下自动启用原生浏览器 `Ctrl+C / Ctrl+V` 双向同步。
* **CDP 自动化就绪**：开启 9222 端口，内置穿透转发与 `--remote-allow-origins=*`。
* **高可用守护**：窗口关闭后 1 秒自动重新拉起，避免黑屏。
* **动态参数传参**：支持在命令行直接附加网址或参数。

## 快速运行

```bash
docker run -d \
  --name chromium \
  -p 6080:6080 \
  -p 6443:6443 \
  -p 127.0.0.1:9222:9222 \
  -e VNC_PASSWORD="YourPassword123" \
  -e RESOLUTION=1920x1080 \
  -v chromium_data:/data \
  wimotek/minimal-chromium:latest \
  https://www.google.com

* **无痕迹模式下 打开多个网址
docker run -d \
  --name chromium \
  -p 6080:6080 -p 6443:6443 \
  -p 127.0.0.1:9222:9222 \
  -e VNC_PASSWORD="password" \
  minimal-chromium-web \
  --incognito https://github.com https://news.ycombinator.com

* **通过环境变量设置homepage
docker run -d \
  --name chromium \
  -p 6080:6080 -p 6443:6443 \
  -p 127.0.0.1:9222:9222 \
  -e HOMEPAGE="https://www.bing.com" \
  minimal-chromium-web


'''YAML
services:
  chromium:
    image: minimal-chromium-web
    environment:
      - HOMEPAGE=https://www.bing.com
      - CHROME_ARGS=--incognito
      - VNC_PASSWORD=password
