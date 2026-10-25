# Xray Reality 分布式多节点管理中枢 (Xray-Web & Xray-Core)

基于 **Xray-core (VLESS-REALITY-Vision)** 打造的高性能分布式节点管理与商业化运营中枢。

系统采用 **Master-Agent（主控中心 - 边缘工作节点）解耦架构**：
* **`xray_web` (主控端)**：轻量化 Web 管理面板，负责用户生命周期、数据库、卡密核销、邮件通知、聚合订阅下发与节点集群调度；
* **`xray_core` (节点端)**：高轻量（无 Python 依赖，仅约 30MB）边缘代理容器，部署于任意海外 VPS，自动向主控上报真实公钥、拉取用户名单并同步回传流量消耗。

---

## 🌟 核心特性

- 🌐 **分布式无感集群对接**：远程海外节点只需单条 Docker 指令即可接入主控，启动时自动推导并上报真实公钥（`pbk`）、`ShortId`、`IP` 与端口，**无需人工在服务器间复制任何密钥**。
- 🔑 **通信密钥自动握手与重置**：节点启动可不填 `NODE_KEY`，首次接入自动生成唯一凭据；主控后台支持在线一键重置节点密钥，心跳自动下发热更。
- 🔄 **多种套餐计费模式**：
  - **普通固定套餐**：流量用完即止，支持有效期顺延；
  - **每月固定流量套餐**：后台或发卡网可开出“每月重置卡”，定时线程在每月重置日自动向核心下发清零指令并推送微信/邮件提醒；
  - **无限量 / 永久有效**：支持设置 `0 MB` 不限流量与 `2099` 永久有效，智能跳过告警骚扰。
- 🔗 **聚合多节点订阅与一键导入**：
  - 提供聚合订阅地址 `/api/sub?token=用户UUID`，直接导入 **v2rayN、Clash-Meta、Sing-box、Shadowrocket**，全节点自动就位并支持批量测速；
  - 网页端支持单节点复制与专属高清 SVG 矢量二维码扫码。
- 🖥️ **Windows 客户端开箱即用一键打包**：
  - 用户可在前台一键下载为其个性化打包好的绿色版客户端（`.zip`）；
  - 内置该节点专属配置与自动化批处理脚本，双击 `一键启动代理.bat` 自动改写系统代理翻墙，双击 `停止代理.bat` 恢复网络，纯小白零配置开箱即用。
- 📢 **登录页系统公告**：后台富文本动态配置，即改即显；留空自动隐身，不占多余空间。
- 🔌 **方案 C 第三方发卡网 API 实时出卡**：支持独角数卡等发卡平台在买家拍下时现场请求出卡（支持 `&is_monthly=1` 出月重置卡），实现 0 库存全自动发卡。
- ⏰ **定时巡检与智能预警**：后台自动轮询全站用户配额与到期时限，支持 **SMTP 邮件** 与 **Server酱·Turbo（微信服务号推送）** 双通道精准告警。
- 🔐 **完备用户中心与持久会话**：邮箱验证码注册/找回密码、密码自主变更、F5 刷新永不退登（`localStorage` 会话持久化）。

---


## 🚀 部署指南

### 第一步：部署 `xray_web` 主控端

> 建议部署在连接性良好的 Linux VPS（主控仅需 3000 端口，无需占用 443）。

1. **克隆项目到服务器**：
   ```bash
   git clone https://github.com/wimotek/chromium.git
   cd chromium/xray/xray_web
   ```

2. **检查或修改 `docker-compose.yml`**：
   ```yaml
   services:
     xray-web:
       build:
         context: .
         dockerfile: Dockerfile
       container_name: xray-web-master
       restart: unless-stopped
       network_mode: "host"
       environment:
         - TZ=Asia/Shanghai
         - APP_MODE=all
         - WEB_PORT=3000
         - NODE_KEY=xray_cluster_secret_key_2026   # 集群通信密钥 (可自定义)
       volumes:
         - ./data:/data
   ```

3. **启动主控容器**：
   ```bash
   docker compose up -d --build
   ```

4. **登录主控面板**：
   - 访问地址：`http://<主控服务器IP>:3000`
   - 查看初始管理员账密：
     ```bash
     docker logs xray-web-master | grep "初始管理员凭据" -A 3
     ```
   - 登录后台后，可在【系统发信与全局运维配置】中配置发件 SMTP 邮箱、节点通信密钥与系统公告。

---

### 第二步：在任意海外 VPS 接入 `xray_core` 工作节点

> 纯核心节点极度轻量（内存占用约 20MB），零 Python 依赖。支持单台主控挂载数十台全球边缘节点。

在海外节点 VPS 上执行如下一条 Docker 指令即可完成自动接入：

```bash
docker run -d \
  --name xray-node \
  --restart always \
  --network host \
  -e PANEL_URL="http://<主控服务器IP>:3000" \
  -e NODE_KEY="xray_cluster_secret_key_2026" \
  -e PORT=443 \
  -e DEST="www.microsoft.com:443" \
  -e SERVER_NAMES="www.microsoft.com,microsoft.com" \
  -v $(pwd)/data:/data \
  wimotek/xray:core
```

#### 环境变量说明：
| 变量名 | 说明 | 默认值 / 示例 |
| :--- | :--- | :--- |
| `PANEL_URL` | **[必填]** 主控 `xray_web` 的访问地址 | `http://1.2.3.4:3000` |
| `NODE_KEY` | **[选填]** 节点通信密钥。若留空，节点首次启动将自动生成随机密钥并存入本地 `/data/node_key.txt` | `xray_cluster_secret_key_2026` |
| `PORT` | 节点 Reality 监听端口 | `443` |
| `DEST` | 伪装目标回落地址 | `www.microsoft.com:443` |
| `SERVER_NAMES` | 伪装域名列表 (逗号分隔) | `www.microsoft.com,microsoft.com` |
| `AUTO_UPDATE` | 每次容器启动是否检测并更新 Xray-core 官方最新核心 | `true` |

---

## 📱 客户端使用与订阅导入

用户在个人中心即可一览所有可用加速节点，提供多种开箱即用导入方案：

### 方案 1：通用聚合订阅（推荐）
点击用户界面的 **`🔗 一键复制全节点订阅链接`**，直接填入客户端订阅地址中，所有节点一次性批量导入：
* **v2rayN (Windows)**：订阅设置 -> 添加订阅链接 -> 更新订阅
* **Clash-Meta / Verge**：配置 -> 导入订阅 URL
* **Sing-box / Shadowrocket (iOS)**：右上角添加 -> 类型选择 Subscribe 导入

### 方案 2：Windows 一键免配置开箱即用客户端
1. 在网页端节点列表对应的卡片上，点击 **`🖥️ 下载客户端`**；
2. 下载后直接解压压缩包；
3. **双击运行 `一键启动代理(自动配置系统代理).bat`**，系统代理即刻自动激活，直接秒开 Google / YouTube；
4. 退出时双击 `一键停止代理(关闭系统代理).bat`，自动还原 Windows 代理设置，不留任何垃圾。

---

## 🛒 方案 C：第三方发卡网 API 自动出卡规范

系统支持无库存实时出卡，完美兼容**独角数卡**等自动化发卡平台的“自定义插件”或“GET/POST 异步通知”。

### 1. 接口规范
* **请求方式**：`GET` 或 `POST`
* **接口路径**：`/api/open/faka_generate`
* **URL 示例**：
  ```text
  http://<主控IP>:3000/api/open/faka_generate?gb=100&days=30&is_monthly=1&token=你的Token
  ```

### 2. 请求参数说明
| 参数名 | 类型 | 必填 | 说明 |
| :--- | :---: | :---: | :--- |
| `token` | string | **是** | 发卡 API 专用鉴权密钥（后台设置中查看或生成） |
| `gb` | int | 否 | 卡密包含的流量（单位 GB，填 `0` 为不限流量，默认 100） |
| `days` | int | 否 | 有效期天数（填 `36500` 为永久有效，默认 30） |
| `is_monthly` | int | 否 | 填 `1` 时生成“每月固定重置套餐卡”，填 `0` 为普通固定卡 |
| `format` | string | 否 | 留空返回纯卡密文本（如 `KM-ABCD1234EF56`），填 `json` 返回完整 JSON 实体 |

---

## 🛡️ 运维与常见故障排查

### 1. 节点启动后后台没有显示节点？
* 检查节点容器日志：
  ```bash
  docker logs -f xray-node
  ```
* 确认节点服务器是否能够访问主控服务器的 3000 端口（注意主控所在云厂商的**安全组/防火墙规则**需放行 TCP 3000）。

### 2. 如何在线重置节点密钥？
* 进入主控后台【远程节点 (xray_core) 集群】标签；
* 找到对应节点点击【重置密钥】，主控会生成一个全新密钥；
* 远程节点在下一次心跳（60 秒内）会自动收到新密钥并热写入本地 `/data/node_key.txt`，全程无需登录节点服务器。

### 3. 数据备份
所有的核心数据均位于 `./data` 目录：
* `xray_web/data/xray_web.db`：全站 SQLite 数据库（包含账号、卡密、节点与配置，建议定时备份此文件）；
* `xray_core/data/`：节点独立的 Reality 密钥对持久化文件，保留此目录可确保节点公钥和私钥永不漂移。

---

## 📄 开源协议

本项目采用 [MIT License](LICENSE) 开源授权。