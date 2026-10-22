# Xray REALITY 可视化智能管理套件 (Vue 3 + FastAPI + SQLite3 专属版)

本项目是基于 **Xray-core**、**Vue 3 (Vite + Tailwind CSS)**、**FastAPI** 和 **SQLite3** 打造的现代化轻量级多用户网络面板系统。所有用户凭证由 SQLite3 数据库驱动并持久化，采用原子写入彻底规避 0 字节启动崩溃，支持免删数据无损修改端口。

镜像地址：`wimotek/xray:web` 或 `ghcr.io/wimotek/xray:web`

---

## ✨ 核心特性

- **SQLite3 数据库驱动**：用户信息持久化存储于 `/data/xray_web.db`，支持记录账号创建时间、状态软开关（一键启用/停用），数据源稳定可靠。
- **免删库动态配置同步**：在 `docker-compose.yml` 中修改 `PORT` 或伪装域名 `DEST` 后，重启容器即可自动打补丁生效，**100% 保护已有用户名单与私钥不丢失**。
- **原子写入防 EOF 崩溃**：采用临时文件中转验证与严格的 0 字节体积校验，彻底杜绝因意外产生空配置导致 Xray 核心 `EOF` 死循环。
- **现代暗黑风 Web UI**：深度调配的暗黑科技风界面，移动端与 PC 端自适应，支持一键复制标准 `vless://` 链接与动态二维码扫码导入。
- **超轻量全栈单容器**：FastAPI 后端直接托管 Vue 3 打包后的静态前端资产，无需额外运行 Nginx 和 MySQL，整机常驻内存仅约 **35MB**。
- **物理隔离架构**：容器内部模板留存原位隐藏，宿主机仅映射 `./data:/data`，宿主机目录干净整洁。

---

## 🚀 快速启动

### 方式 A：使用 Docker Compose（推荐）

在 `xray_web` 目录下创建 `docker-compose.yml`：

```yaml
services:
  xray-web:
    image: wimotek/xray:web
    # 亦可选用 GitHub 镜像源: ghcr.io/wimotek/xray:web
    container_name: xray-web
    restart: unless-stopped
    network_mode: "host"
    environment:
      - TZ=Asia/Shanghai
      - AUTO_UPDATE=true        # 重启容器时自动检查并热更新官方最新核心
      - PORT=8443               # 节点监听端口（若 443 冲突可随意更换）
      - DEST=www.microsoft.com:443 # REALITY 可信握手目标
      - SERVER_NAMES=www.microsoft.com,microsoft.com
      - USER_COUNT=2            # 首次初始化自动生成的节点用户数
      - WEB_ENABLE=true         # 是否开启内置 Web 管理控制台
      - WEB_PORT=3000           # Web 面板网页访问端口
      - WEB_PASSWORD=admin888   # 管理员登录密码（留空则自动随机生成）
    volumes:
      # 统一挂载至 /data，绝不泄漏或冲掉镜像内部模板
      - ./data:/data
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

启动服务：
```bash
docker compose up -d
```

---

### 方式 B：使用 Docker Run 命令行

```bash
docker run -d \
  --name xray-web \
  --restart unless-stopped \
  --network host \
  -e WEB_PASSWORD=admin888 \
  -e WEB_PORT=3000 \
  -e PORT=8443 \
  -v $(pwd)/data:/data \
  wimotek/xray:web
```

---

## 🖥️ 管理面板使用指南

1. **登录控制台**：
   - 浏览器访问：`http://<服务器IP>:3000`
   - 输入在配置中指定的 `WEB_PASSWORD`（示例为 `admin888`）。
2. **面板主要功能**：
   - **实时概览**：直观展示服务端当前运行的 Xray-core 官方版本号、REALITY 公钥 (PublicKey)、ShortId、端口与运行状态。
   - **多用户生命周期管理**：
     - **添加用户**：输入备注名，系统自动生成独立 UUID 并同步写入 SQLite3 与 Xray 核心。
     - **状态切换**：点击「停用 / 启用」，即时软封禁或解封该凭证，无需物理删除。
     - **复制链接 / 二维码**：一键获取对应用户的 `vless://???` 链接，或直接弹出二维码供手机扫码导入。
     - **删除用户**：物理删除该凭证并自动触发核心热重载。

---

## 🛠️ 环境变量详细说明

| 环境变量 | 默认值 | 作用说明 |
| :--- | :--- | :--- |
| `WEB_PORT` | `8080` | Web 管理控制台网页访问端口 |
| `WEB_PASSWORD` | 首次随机生成 | Web 控制台管理员登录密码 |
| `WEB_ENABLE` | `true` | 是否启用内置 Web 控制台 |
| `PORT` | `443` | Xray REALITY 节点网络监听端口 |
| `DEST` | `www.microsoft.com:443` | REALITY 伪装与 TLS 回落目标 |
| `SERVER_NAMES` | `www.microsoft.com,microsoft.com` | REALITY 可信伪装 SNI 域名列表（逗号分隔） |
| `SERVER_IP` | 自动识别外网 IP | 客户端连接目标公网 IP（多网卡可手动指定） |
| `USER_COUNT` | `2` | 首次初始化时自动写入数据库的用户数量 |
| `AUTO_UPDATE` | `true` | 容器重启时是否自动检查并热更新官方最新 Xray 核心 |

---

## 📂 宿主机挂载目录说明

采用 `./data:/data` 单一目录映射，启动后宿主机 `./data/` 目录中仅存放真正所需的文件：

- **`./data/xray_web.db`**：**核心数据库文件**。存储所有用户记录、UUID、创建时间与状态开关。备份或换机时，**直接复制该文件即可完整迁移全部用户**。
- **`./data/config.json`**：由后端根据 SQLite 数据库自动同步生成的有效 Xray 配置文件。
- **`./data/client_info.txt`**：初始化时的公钥、ShortId 及默认节点连接链接备份。

---

## 🔧 常见维护操作

### 1. 修改监听端口或伪装域名
无需删除 `data` 目录！直接在 `docker-compose.yml` 中修改 `PORT` 或 `DEST`，然后重启：
```bash
docker compose restart
```
脚本会自动将最新端口和域名补丁写入 `config.json`，已有的用户与密钥**完全不受影响**。

### 2. 重置节点公私钥
如需更换全新的 X25519 密钥对与 ShortId：
```bash
docker compose down
rm -f ./data/config.json ./data/client_info.txt
docker compose up -d
```
系统会重新生成全新的一套公私钥，并自动将数据库中保存的用户批量绑定至新节点。

### 3. 宿主机开启 BBR 加速
```bash
echo "net.core.default_qdisc=fq" >> /etc/sysctl.conf
echo "net.ipv4.tcp_congestion_control=bbr" >> /etc/sysctl.conf
sysctl -p
```