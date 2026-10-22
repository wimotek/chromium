# Xray-core 极简独立部署套件 (REALITY 自动最新版)

这是一个完全解耦、开箱即用的 Xray 服务端 Docker 部署套件。默认采用目前抗封锁与传输性能最佳的 **VLESS + XTLS + REALITY (Vision 流控)** 架构，无需自行申请或维护 SSL 证书。

---

## ✨ 核心特性

- **官方最新核心**：构建镜像与容器运行时均支持自动直连 GitHub 获取官方最新 Release，杜绝频控限制与版本滞后。
- **全自动化初始化**：初次启动自动生成高强度 UUID、x25519 密钥对和 ShortId，一机一密。
- **即启即用**：启动后直接在终端日志与本地文件中输出标准客户端导入链接（`vless://`）。
- **轻量与多架构**：基于 Alpine Linux 构建，原生适配 `amd64`、`arm64`、`armv7` 等硬件架构。
- **高性能网络**：默认推荐 Host 网络栈，全面兼容系统原生 TCP BBR 拥塞控制算法。

---

## 🚀 快速开始

### 方式 A：使用 Docker Compose（推荐）

### 1. 准备配置文件

在目录中创建 `docker-compose.yml`：

```yaml
services:
  xray:
    image: ghcr.io/wimotek/xray:latest
    # 若使用 Docker Hub 镜像可切换为: wimotek/xray:latest
    container_name: xray-service
    restart: unless-stopped
    network_mode: "host"
    environment:
      - TZ=Asia/Shanghai
      - AUTO_UPDATE=true        # 每次重启容器时自动检查并热更新到官方最新版
      - PORT=443               # 监听端口
      - DEST=www.apple.com:443 # REALITY 伪装目标地址与端口
      - SERVER_NAMES=www.apple.com,apple.com
    volumes:
      - ./data:/data
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

### 2. 启动服务

在项目目录下执行：

```bash
docker compose up -d
```

### 方式 B：使用 Docker Run 命令行
无需创建配置文件，直接在终端执行以下命令启动：
* 选项 1：Host 网络模式（Linux 首选，吞吐最佳）
  
 直接复用宿主机网络栈，能最大化 TCP/UDP 传输性能：
```bash
docker run -d \
  --name xray-service \
  --restart unless-stopped \
  --network host \
  -v $(pwd)/data:/data \
  -e TZ=Asia/Shanghai \
  -e AUTO_UPDATE=true \
  -e PORT=443 \
  -e DEST=www.apple.com:443 \
  -e SERVER_NAMES=www.apple.com,apple.com \
  ghcr.io/wimotek/xray:latest
```
* 选项 2：端口映射模式（跨平台 / 非 Host 环境）
  
  适用于 macOS、Windows Docker Desktop 或需要固定暴露端口的环境：
```bash
docker run -d \
  --name xray-service \
  --restart unless-stopped \
  -p 443:443/tcp \
  -p 443:443/udp \
  -v $(pwd)/data:/data \
  -e TZ=Asia/Shanghai \
  -e AUTO_UPDATE=true \
  -e PORT=443 \
  -e DEST=www.apple.com:443 \
  -e SERVER_NAMES=www.apple.com,apple.com \
  ghcr.io/wimotek/xray:latest
```

### 获取节点连接信息

容器启动后会自动生成配置并打印节点链接，执行以下命令查看：

```bash
docker logs xray-service
```

终端将输出类似以下内容：

```text
======================================================
              Xray Reality 节点配置信息
======================================================
IP / 地址:        198.51.100.???
端口:             443
UUID:             ????????-????-????-????-????????????
流控 (flow):      xtls-rprx-vision
传输协议:         tcp
安全类型:         reality
SNI / 伪装域名:   www.apple.com
公钥 (PublicKey): ????????????????????????????????????????????
ShortId:          ????????????????
Fingerprint:      chrome

客户端导入链接:
vless://???@198.51.100.???:443?security=reality&encryption=none&pbk=???&headerType=none&fp=chrome&type=tcp&flow=xtls-rprx-vision&sni=www.apple.com&sid=???#Xray-Reality
======================================================
```

也可以随时在宿主机查看持久化的节点信息：

```bash
cat ./data/client_info.txt
```

---

## 🔄 核心更新机制

### 方式一：容器重启时自动更新（推荐）
在 `docker-compose.yml` 中已默认配置环境变量 `AUTO_UPDATE=true`。每次重启容器时，脚本会自动检测官方最新 Release，如有更新则自动拉取替换：

```bash
docker compose restart xray
```

### 方式二：容器内热更新（无需重新构建镜像）
执行内置的热更新命令，直接拉取官方最新二进制：

```bash
docker exec -it xray-service update-xray
docker compose restart xray
```

### 方式三：强制无缓存重新构建
```bash
docker compose build --no-cache
docker compose up -d
```

---

## 🛠️ 环境变量说明

可通过修改 `docker-compose.yml` 中的 `environment` 自定义各项参数：

为您整理了 **`xray_core`（纯核心版）** 与 **`xray_web`（可视化商业版）** 的环境变量详细对比表格，可直接复制粘贴到 `README.md` 中：

---

### 📊 环境变量对比矩阵 (`xray_core` vs `xray_web`)

| 环境变量 | `xray_core` (纯核心版) | `xray_web` (可视化商业版) | 默认推荐值 | 功能说明与行为差异 |
| :--- | :---: | :---: | :--- | :--- |
| **`PORT`** | ✅ 支持 | ✅ 支持 | `8443` 或 `443` | **Xray 节点入站监听端口**。<br>两个版本均支持动态更改，重启自动应用。 |
| **`DEST`** | ✅ 支持 | ✅ 支持 | `www.microsoft.com:443` | **REALITY 伪装握手与 TLS 回落目标目标**。 |
| **`SERVER_NAMES`** | ✅ 支持 | ✅ 支持 | `www.microsoft.com,microsoft.com` | **REALITY 可信伪装 SNI 列表**（逗号分隔）。 |
| **`SERVER_IP`** | ✅ 支持 | ✅ 支持 | `自动获取公网 IP` | 节点对外连接公网 IP（多网卡机器可手动指定）。 |
| **`REALITY_PRIVATE_KEY`** | ❌ 仅写入文件 | ✅ 环境变量+持久化 | `留空自动生成` | 服务端 X25519 私钥。<br>`xray_web` 支持自动反推公钥并固化到 `/data/public_key.txt`。 |
| **`REALITY_SHORT_ID`** | ❌ 静态固定 | ✅ 环境变量注入 | `123456` | REALITY 客户端握手识别 ID。 |
| **`AUTO_UPDATE`** | ✅ 支持 | ✅ 支持 | `true` | 重启容器时是否自动拉取并热更新官方最新 Xray-core。 |
| **`TZ`** | ✅ 支持 | ✅ 支持 | `Asia/Shanghai` | 容器运行时区配置。 |
| **`USER_COUNT`** | ❌ 仅单用户/静态 | ✅ 支持 | `2` | **初始用户数**。<br>`xray_web` 会自动存入 SQLite 并初始化对应体验配额。 |
| **`WEB_ENABLE`** | ❌ **不支持** | ✅ **核心参数** | `true` | **Web 服务总开关**。<br>设为 `false` 时，`xray_web` 可一键降级为纯核心代理模式，零多余内存开销。 |
| **`APP_MODE`** | ❌ **不支持** | ✅ **核心参数** | `user` | **权限与防扫模式控制**：<br>• `user`：**默认安全模式**，仅开放用户端（查流量/卡密充值），管理接口物理 404 隐藏防扫描；<br>• `admin`：纯管理后台（不启动 Xray，适合内网独立机）；<br>• `all`：单机全功能（前台+管理后台一体）。 |
| **`WEB_PORT`** | ❌ **不支持** | ✅ **核心参数** | `3000` (或 `8080`) | 前端 Vue 3 及 API 后端对外网页访问端口。 |
| **`ADMIN_USERNAME`** | ❌ **不支持** | ✅ **核心参数** | `随机生成` | 管理员控制台用户名（在 `APP_MODE` 为 `admin` 或 `all` 时生效）。 |
| **`ADMIN_PASSWORD`** | ❌ **不支持** | ✅ **核心参数** | `随机生成` | 管理员控制台密码（在 `APP_MODE` 为 `admin` 或 `all` 时生效）。 |
| **`DB_PATH`** | ❌ **不支持** | ✅ **核心参数** | `/data/xray_web.db` | SQLite3 商业数据库持久化路径，记录账号、配额、到期日与卡密库存。 |

---

### 💡 版本选型建议

* **`xray_core` 适用场景**：个人轻量单一节点、配置固定、追求极致精简（仅依靠静态配置文件或无 Web 界面需求）。
* **`xray_web` 适用场景**：多用户分发、商业运营/发卡变现（卡密充值）、防止公网恶意扫描管理后台、需要实时监控用户上传/下载流量及自动到期拦截。

---

## 📱 客户端支持

复制控制台生成的 `vless://???` 链接，直接粘贴导入主流客户端：

- **Windows**: v2rayN / Nekoray / Sing-box
- **Android**: v2rayNG / NekoBox / Sing-box
- **iOS / macOS**: Shadowrocket / Loon / Sing-box / FoXray
- **Linux**: Clash-Meta (Mihomo) / Sing-box 核心

---

## ⚡ 系统底层性能优化 (BBR)

建议在 Linux 宿主机上开启 BBR 拥塞控制算法以获得更高吞吐量与抗丢包表现：

```bash
echo "net.core.default_qdisc=fq" >> /etc/sysctl.conf
echo "net.ipv4.tcp_congestion_control=bbr" >> /etc/sysctl.conf
sysctl -p
```

检查 BBR 是否成功生效：
```bash
sysctl net.ipv4.tcp_congestion_control
# 输出应包含: bbr
```

## 💡 附带的 Warning 优化建议
日志中还有两行黄色警告：
```code
REALITY: Choosing apple, icloud, etc. as the target may get your IP blocked by the GFW
```
这是新版 Xray-core 的温馨提示：近年来 Apple / iCloud 域名的 SNI 握手特征在部分地区容易被重点关注。

建议将 docker-compose.yml 中的伪装目标换成更通用的域名（如微软、亚马逊等）：

---

## 📂 文件持久化说明

- `./data/config.json`: 当前运行的 Xray 服务端核心配置。
- `./data/client_info.txt`: 当前节点的公私钥及 `vless://???` 导入链接备份。
- 如需重新生成全新的 UUID 与密钥对，只需停止容器，删除 `./data/config.json` 后重新启动容器即可。
