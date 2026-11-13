# Minimal Chromium Node (noVNC & KasmVNC + CDP + Edge Agent)

轻量、安全加固且深度调优的 Dockerized Chromium 远程节点容器方案，专为 **AI Agent、自动化测试（Playwright / Puppeteer）以及分布式 CDP 集群** 打造。

提供 **noVNC 版 (`chromium_novnc`)** 与 **KasmVNC 流媒体版 (`chromium_kasmvnc`)** 双引擎，统一复用 `common/edge_node_client.py` 接入 `chromium_sync` 主控网关。

---

## 🌟 核心特性与容器优化

* **两阶段安全降权运行 (`dumb-init` + `gosu` -> `UID/GID 1000`)**：
  * **阶段 1（瞬态 Root 初始化）**：启动时由 PID 1 `dumb-init` 拉起 `entrypoint.sh` 完成 `/data` 权限自愈，并将宿主机 `/certs` 中宝塔/Certbot 的 `0600 root` 私钥安全复制合成到容器内 `/etc/ssl/app/`（**绝不修改宿主机 `/certs` 属主与权限**）。
  * **阶段 2（非 root 业务运行）**：通过 `exec gosu` 彻底替换进程，随后 `Xvnc`、`openbox`、`novnc_proxy`、`edge_node_client.py` 与 `Chromium` 全部以非特权用户（noVNC 为 `appuser:1000`，KasmVNC 为 `kasm-user:1000`）运行，无任何常驻 root 进程。
* **Multi-stage 构建与镜像瘦身**：
  * `py-builder` / `builder` 阶段隔离构建 `/opt/venv`（`httpx`、`websockets`、`wimotek-edge-agent>=1.0.17`）并下载 KasmVNC `.deb`；
  * 运行时剔除 `tini`、`curl`、`wget`、`procps`、`net-tools`、`autocutsel` 等冗余工具，并清理 `apt` 缓存、`/usr/share/doc`、`/usr/share/man` 与 noVNC 测试文档，压缩镜像体积与攻击面。
* **`dumb-init` (PID 1) 信号转发与 Python 原生 `HEALTHCHECK`**：
  * `ENTRYPOINT ["/usr/bin/dumb-init", "--", "/entrypoint.sh"]` 自动回收 Chromium 崩溃产生的僵尸进程并转发 `SIGTERM`/`SIGINT`；
  * 无需依赖 `curl`，容器每 30 秒通过内置 Python 校验 `http://127.0.0.1:9222/json/version`（CDP）与 VNC 端口可用性（`6080` / `6901`）。
* **严格隔离 9222 + 鉴权加密 WSS (`9443`) 对称选路 (`wimotek-edge-agent >= 1.0.17`)**：
  * Chromium CDP `9222` 严格仅监听容器内部 `127.0.0.1:9222`（绝不直接暴露到公网）；
  * 节点内置双栈 TLS + `X-Edge-Auth` 密钥鉴权 WSS 服务端（默认 `EDGE_WSS_PORT=9443`），启动后上报公网 IPv4 / IPv6 与 `9443` 端口给 Hub (`POST /api/nodes/detect-mode`) 执行 TCP 三次握手（完全兼容 Oracle / 云主机的 1:1 NAT 内网网卡）；
  * 握手可达走 `public_wss`（Hub 主动入站 `wss://<节点IP>:9443/ws`），不可达则自动关闭入站监听并回落为 `reverse`（节点出站连 `wss://<Hub>/api/nodes/reverse-tunnel`）。
* **原生 UTF-8 剪贴板 & Num Lock ON & 自愈防黑屏**：
  * noVNC 版采用 `tigervnc-standalone-server` (Xvnc) 原生 Extended Clipboard，KasmVNC 版基于现代 WebSocket 流媒体协议；启动自动开启 `numlockx on`，进程异常 1~3 秒内自愈拉起。

---

## 📊 双引擎版本对比

| 特性维度 | noVNC 极简版 (`chromium_novnc`) | KasmVNC 流媒体版 (`chromium_kasmvnc`) |
| :--- | :--- | :--- |
| **底层渲染引擎** | TigerVNC Standalone (Xvnc) | KasmVNC Server v1.3.3 |
| **Web 访问端口** | **HTTP: 6080** / **HTTPS: 6443** | **HTTPS: 6901** |
| **加密 WSS 服务端口** | 双栈鉴权 WSS **`9443`**（内部桥接 `127.0.0.1:9222`） | 双栈鉴权 WSS **`9443`**（内部桥接 `127.0.0.1:9222`） |
| **Init 守护进程** | `dumb-init` (PID 1) | `dumb-init` (PID 1) |
| **安全运行模型** | Root-Init-Drop (`gosu appuser`, UID `1000`) | Root-Init-Drop (`gosu kasm-user`, UID `1000`) |
| **VNC 登录账号** | VNC 密码认证 (`VNC_PASSWORD`) | `VNC_USER` (默认 `kasm-user`) + `VNC_PASSWORD` |

---

## 🔨 镜像构建方式

`chromium_novnc` 与 `chromium_kasmvnc` 构建前（如 GitHub Actions 流水线）需将共用 `common/edge_node_client.py` 复制到对应引擎目录后直接执行本地构建：

```bash
# 构建 noVNC 节点镜像
cp common/edge_node_client.py chromium_novnc/edge_node_client.py
docker build -t wimotek/chromium:novnc ./chromium_novnc

# 构建 KasmVNC 节点镜像 (支持 amd64 / arm64)
cp common/edge_node_client.py chromium_kasmvnc/edge_node_client.py
docker build -t wimotek/chromium:kasmvnc ./chromium_kasmvnc
```

如需自定义构建 UID/GID（例如与宿主机非 1000 用户对齐）：
```bash
docker build --build-arg PUID=$(id -u) --build-arg PGID=$(id -g) \
  -t wimotek/chromium:novnc ./chromium_novnc
```

---

## 🔐 宿主机映射目录权限与宝塔证书说明

### 1. 默认模式（推荐，自动权限自愈 + 无感挂载宝塔证书）

默认启动容器时，阶段 1 会自动：
1. 将容器内映射的 `/data` 目录修正为 `1000:1000`，解决宿主机事先用 `root` 创建目录导致 Chromium 无法写入 `SingletonLock` 的问题；
2. 以只读方式读取宿主机 `/certs`（包括宝塔面板 `/www/server/panel/vhost/cert/<域名>` 或 Certbot `/etc/letsencrypt/live/<域名>` 下权限为 `0600 root:root` 的私钥），复制到容器内部 `/etc/ssl/app` 并设为 `600` 归属 `UID 1000`，**不会对宿主机 `/certs` 执行任何写或 `chown` 操作**；
3. 随后通过 `exec gosu` 彻底降权至 `UID 1000` 启动服务。

因此标准 Linux 宿主机通常只需挂载**专属子目录**即可（切勿直接将共享父目录 `/home/docker` 整目录映射给 `/data`，否则自愈阶段 `chown -R` 会改写同级其他项目文件属主）：
```bash
# 推荐：为每个节点分配独立子目录
-v /home/docker/chromium_novnc:/data \
-v /www/server/panel/vhost/cert/yourdomain.com:/certs:ro
```
> * **宿主机 `/home/docker` 父目录权限要求**：标准 Docker 绑定挂载子目录（`/home/docker/chromium_novnc:/data`）时，`/home/docker` 本身保持常见 `755`（或 `711` / `750`）即可，只要宿主机子目录所在文件系统支持 `chown`（本地 ext4/xfs 均支持，NFS 需开启 `no_root_squash`），容器阶段 1 会自动将 `/data` 自愈为 `1000:1000`（`rwx`）。
> * 若宿主机目录已存放大量历史数据，建议提前手动授权以加快首次启动：`chown -R 1000:1000 /home/docker/chromium_novnc && chmod -R 750 /home/docker/chromium_novnc`。

### 2. 若强制使用 `--user 1000:1000` / Rootless / SELinux / 磁盘满排查

* **显式指定 `--user 1000:1000` 跳过阶段 1 时**：需提前在宿主机执行 `chown -R 1000:1000 /home/docker/chromium_novnc`；若同时需要读取 `0600 root` 证书，需在宿主机使用 `setfacl -m u:1000:r ...` 或导出 `1000:1000` 属主副本后再挂载，否则将自动回退至自签证书。
* **SELinux 开启环境 (CentOS / RHEL / Fedora)**：在挂载卷参数末尾追加 `:Z`（如 `-v /home/docker/chromium_novnc:/data:Z -v /path/to/certs:/certs:ro,Z`）。
* **Rootless Docker 环境**：由于存在 User Namespace UID 偏移，需在宿主机执行 `docker unshare chown -R 1000:1000 /home/docker/chromium_novnc`。
* **出现 `No space left on device` / `Fontconfig error` / Chromium 无限重启**：此报错是宿主机磁盘或 inode 耗尽（`df -h` / `df -i`），或未配置 `--shm-size="2gb"` 导致 `/dev/shm`（默认 64MB）写满。清理磁盘（`docker system prune -af` / 清理旧容器与日志）后，容器入口已内置 `/dev/shm < 512MB` 自动兜底 `--disable-dev-shm-usage`。

---

## 🚀 快速启动示例

### 方案 1：noVNC 版本（HTTP 6080 + HTTPS 6443）

```bash
docker run -d \
  --name chromium-novnc \
  -p 6080:6080 \
  -p 6443:6443 \
  -p 9443:9443 \
  -e VNC_PASSWORD="MySecurePassword123" \
  -e RESOLUTION=1920x1080 \
  -e HUB_URL="https://hub.yourdomain.com:8443" \
  -e JOIN_TOKEN="hub_join_xxxxxxxxxxxxxxxxxxxx" \
  -v /home/docker/chromium_novnc:/data \
  -v /www/server/panel/vhost/cert/yourdomain.com:/certs:ro \
  --shm-size="2gb" \
  --restart unless-stopped \
  wimotek/chromium:novnc \
  https://www.google.com
```

### 方案 2：KasmVNC 版本（HTTPS 6901，高帧率流媒体）

```bash
docker run -d \
  --name chromium-kasm \
  -p 6901:6901 \
  -p 9443:9443 \
  -e VNC_PASSWORD="MySecurePassword123" \
  -e RESOLUTION=1920x1080 \
  -e HUB_URL="https://hub.yourdomain.com:8443" \
  -e JOIN_TOKEN="hub_join_xxxxxxxxxxxxxxxxxxxx" \
  -v /home/docker/chromium_kasmvnc:/data \
  -v /www/server/panel/vhost/cert/yourdomain.com:/certs:ro \
  --shm-size="2gb" \
  --restart unless-stopped \
  wimotek/chromium:kasmvnc \
  https://www.google.com
```

---

## ⚙️ 核心环境变量

| 变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `RESOLUTION` | `1920x1080` | 桌面与 Chromium 视口分辨率 |
| `VNC_PASSWORD` | *(空)* | VNC 访问密码（留空则免密） |
| `VNC_USER` | `kasm-user` | KasmVNC 登录用户名 |
| `CHROME_ARGS` | *(空)* | 追加到 Chromium 的额外命令行 Flag |
| `HUB_URL` | *(空)* | `chromium_sync` Hub 地址，配置后自动激活 `edge_node_client.py` |
| `JOIN_TOKEN` | *(空)* | 集群入网通行码（留空走 Hub TOFU 待审流程） |
| `REVERSE_TUNNEL` | *(auto)* | 留空自动对 WSS `9443` 端口 TCP 探测；`true` 强制反向隧道；`false` 强制公网 WSS 直连 |
| `PUBLIC_IPV4` / `PUBLIC_IPV6` | 自动嗅探 | 手动指定节点上报给 Hub 探测的公网 IPv4 / IPv6 |
| `EDGE_WSS_PORT` | `9443` | 节点容器内部监听的双栈鉴权加密 WSS 服务端口 |
| `EDGE_WSS_EXTERNAL_PORT` | `EDGE_WSS_PORT` | 宿主机映射到公网的 WSS 端口（如 `-p 19443:9443` 时填 `19443`；兼容旧变量 `DIRECT_PORT`） |