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

### 1. 启动服务

在项目目录下执行：

``'bash
docker compose up -d
``'

### 2. 获取节点连接信息

容器启动后会自动生成配置并打印节点链接，执行以下命令查看：

``'bash
docker logs xray-service
``'

终端将输出类似以下内容：

``'text
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
``'

也可以随时在宿主机查看持久化的节点信息：

``'bash
cat ./data/client_info.txt
``'

---

## 🔄 核心更新机制

### 方式一：容器重启时自动更新（推荐）
在 `docker-compose.yml` 中已默认配置环境变量 `AUTO_UPDATE=true`。每次重启容器时，脚本会自动检测官方最新 Release，如有更新则自动拉取替换：

``'bash
docker compose restart xray
``'

### 方式二：容器内热更新（无需重新构建镜像）
执行内置的热更新命令，直接拉取官方最新二进制：

``'bash
docker exec -it xray-service update-xray
docker compose restart xray
``'

### 方式三：强制无缓存重新构建
``'bash
docker compose build --no-cache
docker compose up -d
``'

---

## 🛠️ 环境变量说明

可通过修改 `docker-compose.yml` 中的 `environment` 自定义各项参数：

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `AUTO_UPDATE` | `true` | 容器启动时是否自动检查并更新 Xray 官方最新版 |
| `PORT` | `443` | 监听端口 |
| `DEST` | `www.apple.com:443` | REALITY 目标回落与伪装地址 |
| `SERVER_NAMES` | `www.apple.com,apple.com` | REALITY 伪装 SNI 域名列表（逗号分隔） |
| `SERVER_IP` | 自动获取 | 客户端连接的目标公网 IP，多网卡时建议手动指定 |
| `UUID` | 自动生成 | 自定义客户端用户 ID |
| `PRIVATE_KEY` | 自动生成 | 自定义 REALITY 服务端私钥（需与 `PUBLIC_KEY` 匹配） |
| `PUBLIC_KEY` | 自动生成 | 自定义 REALITY 客户端公钥 |
| `SHORT_ID` | 自动生成 | 自定义十六进制 ShortId |

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

``'bash
echo "net.core.default_qdisc=fq" >> /etc/sysctl.conf
echo "net.ipv4.tcp_congestion_control=bbr" >> /etc/sysctl.conf
sysctl -p
``'

检查 BBR 是否成功生效：
``'bash
sysctl net.ipv4.tcp_congestion_control
# 输出应包含: bbr
``'

---

## 📂 文件持久化说明

- `./data/config.json`: 当前运行的 Xray 服务端核心配置。
- `./data/client_info.txt`: 当前节点的公私钥及 `vless://???` 导入链接备份。
- 如需重新生成全新的 UUID 与密钥对，只需停止容器，删除 `./data/config.json` 后重新启动容器即可。
