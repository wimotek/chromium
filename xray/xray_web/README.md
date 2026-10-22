# Xray REALITY 可视化智能商业运营套件 (Vue 3 + FastAPI/Flask + SQLite3 专属版)

本项目是基于 **Xray-core (VLESS-Reality-Vision)**、**Vue 3 (Vite + Tailwind / Element Plus)**、**轻量 API 后端** 与 **SQLite3** 打造的现代化轻量级多用户商业网络节点管理面板。所有凭据由 SQLite3 驱动并严格持久化，具备免删数据无损修改端口、原子写入防 0 字节 EOF 崩溃特性，并实现**用户端自服务与管理端权限隔离**的商业闭环。

镜像地址：`wimotek/xray:web` 或 `ghcr.io/wimotek/xray:web`

---

## ✨ 核心特性

- **双重角色与安全隔离 (`APP_MODE`)**：
  - `user`（默认模式）：仅启动 Xray 核心与**用户个人服务中心**，管理后台接口直接物理熔断（返回 404），彻底隐藏管理端指纹，杜绝全网端口扫描与爆破。
  - `admin`：仅启动管理控制台，不启动 Xray，便于多节点跨地域或内网独立部署。
  - `all`：单机全功能一体化模式，同时开放前台与管理后台。
- **商用卡密发卡闭环**：
  - 管理员可在后台按“流量（GB）+ 有效期（天）”批量生成兑换卡密，无缝对接各类自动发卡平台（爱发电、发卡云等）。
  - 用户登录前台输入卡密即时扩容并延期，实现全自动无人值守运营。
- **用户自服务仪表盘**：
  - 动态可视化展示**剩余流量百分比（已用 / 总配额）**与**套餐到期倒计时**。
  - 展示服务端 REALITY 公钥，支持一键获取 `vless://` 链接与动态二维码扫码导入。
- **REALITY 公钥自动推导与持久化**：
  - 启动时自动基于服务端私钥通过 `xray x25519` 推导计算 Public Key，并固化至 `/data/public_key.txt`，**彻底解决前端公钥显示空白及重启后公钥变动的 Bug**。
- **全平台剪贴板复制降级**：
  - 集成底层兼容算法，在纯 HTTP IP 访问（非安全上下文）环境下也能 100% 成功一键复制节点，杜绝前端报错无反应。
- **免删库动态配置同步**：
  - 在 `docker-compose.yml` 中修改 `PORT` 或伪装域名 `DEST` 后，重启容器即可自动打补丁生效，**100% 保护已有用户名单与私钥不丢失**。
- **严格持久化隔离 (`./data:/data`)**：
  - 核心数据库 `/data/xray_web.db`、配置文件 `/data/config.json` 与公私密钥对统一持久化存储在宿主机 `./data` 目录下，容器升级或销毁数据零丢失。

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
      - APP_MODE=user               # 运行模式: user(默认纯用户前台防扫) | admin(仅管理后台) | all(全功能)
      - WEB_ENABLE=true             # 是否开启内置 Web 页面
      - WEB_PORT=3000               # Web 面板访问端口
      - WEB_PASSWORD=admin888       # 管理员登录密码（APP_MODE 为 admin/all 时生效）
      - PORT=8443                   # Xray REALITY 节点网络监听端口（若 443 冲突可随意更换）
      - DEST=www.microsoft.com:443  # REALITY 可信伪装与 TLS 回落目标
      - SERVER_NAMES=www.microsoft.com,microsoft.com
      - USER_COUNT=2                # 首次初始化自动生成的默认体验用户数
      - AUTO_UPDATE=true            # 重启容器时是否自动检查并热更新官方最新核心
      # - REALITY_PRIVATE_KEY=xxx   # 可选: 留空则由系统首次启动时自动生成并固化至 /data
    volumes:
      # 统一持久化挂载至宿主机 ./data，绝不泄漏或冲掉镜像内部模板
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
  -e APP_MODE=user \
  -e WEB_ENABLE=true \
  -e WEB_PORT=3000 \
  -e WEB_PASSWORD=admin888 \
  -e PORT=8443 \
  -e DEST=www.microsoft.com:443 \
  -e SERVER_NAMES=www.microsoft.com,microsoft.com \
  -v $(pwd)/data:/data \
  wimotek/xray:web
```

---

## 🖥️ 面板使用与商业运营指南

### 1. 普通用户端操作（默认开启，安全对外）
- **访问入口**：浏览器打开 `http://<服务器IP>:3000`。
- **注册与体验**：新用户可直接注册，系统自动分配独立 UUID、赠送初始体验流量与有效期。
- **个人中心看板**：
  - 动态查看已用流量、剩余可用配额及套餐到期时间。
  - 查看当前节点 REALITY Public Key。
  - **一键导入节点**：点击一键复制标准 `vless://` 链接，或直接扫码导入手机客户端。
- **卡密自助充值**：
  - 用户在发卡网购买卡密后，在页面输入 `KM-XXXXX` 卡密，系统即时自动增加流量配额并顺延有效期。

### 2. 管理员控制台（制卡与监控）
为了保障节点机安全，**生产环境下建议默认保持 `APP_MODE=user`**。需要制卡或管理用户时：
1. 修改 `docker-compose.yml` 中的环境变量为 `APP_MODE=all`（或在管理机使用 `APP_MODE=admin`）。
2. 执行 `docker compose up -d` 重新应用。
3. 访问 `http://<服务器IP>:3000`，输入管理员账号 `admin` 与密码 `WEB_PASSWORD`（默认 `admin888`）进入后台：
   - **批量生成卡密**：指定套餐流量（GB）、有效天数及制卡张数，一键导出用于发卡网售卖。
   - **全站用户监控**：实时查看所有注册用户的已用流量、配额上限、到期时间，支持软开关启停凭证。
4. **安全加固**：制卡或维护完成后，将 `APP_MODE` 切回 `user` 并重启，管理接口即刻物理熔断，外界扫描仅显示普通用户登录。

### 3. 纯代理模式（彻底关闭 Web）
若服务器仅作为中继节点，无需任何网页界面：
```yaml
environment:
  - WEB_ENABLE=false
```
重启后容器内将仅运行 Xray-core，Web 服务进程彻底关闭，不占用额外内存。

---

## 🛠️ 环境变量详细说明

| 环境变量 | 默认值 | 作用说明 |
| :--- | :--- | :--- |
| `APP_MODE` | `user` | **权限模式**：`user`（仅开放用户端，管理端 404 隐藏）/ `admin`（仅管理端）/ `all`（全开） |
| `WEB_ENABLE` | `true` | 是否启用内置 Web 控制台服务（设为 `false` 则仅运行代理内核） |
| `WEB_PORT` | `3000` | Web 网页访问端口 |
| `WEB_PASSWORD` | 首次随机生成 / `admin888` | 管理员后台登录密码 |
| `PORT` | `443` 或 `8443` | Xray REALITY 节点网络监听端口 |
| `DEST` | `www.microsoft.com:443` | REALITY 伪装与 TLS 回落目标 |
| `SERVER_NAMES` | `www.microsoft.com,microsoft.com` | REALITY 可信伪装 SNI 域名列表（逗号分隔） |
| `SERVER_IP` | 自动识别外网 IP | 客户端连接目标公网 IP（多网卡可手动指定） |
| `USER_COUNT` | `2` | 首次初始化时自动写入数据库的用户数量 |
| `AUTO_UPDATE` | `true` | 容器重启时是否自动检查并热更新官方最新 Xray 核心 |

---

## 📂 宿主机挂载目录说明

采用 `./data:/data` 统一挂载映射，所有关键数据均受保护：

- **`./data/xray_web.db`**：**核心数据库文件**。存储所有用户记录、UUID、配额上限、到期时间及卡密库存。备份或换机时，**直接复制该文件即可无缝迁移全站业务**。
- **`./data/config.json`**：由后端根据 SQLite 数据库与环境变量动态渲染生成的有效 Xray 配置文件。
- **`./data/public_key.txt`** 与 **`private_key.txt`**：当前节点绑定的 Reality 密钥对，确保容器重建后公钥订阅保持不变。
- **`./data/client_info.txt`**：初始化时的默认连接信息备份。

---

## 🔧 常见维护操作

### 1. 修改监听端口或伪装域名
无需删除 `data` 目录！直接在 `docker-compose.yml` 中修改 `PORT` 或 `DEST`，然后重启：
```bash
docker compose restart
```
系统会自动将最新端口和域名热补丁写入配置，已有的用户数据与密钥**完全不受影响**。

### 2. 容器启动提示 `exec /entrypoint.sh: no such file or directory`？
- **原因**：脚本在 Windows 环境下编辑拉取过，换行符被转为 `CRLF`。
- **解决**：在宿主机执行转换命令并重启：
```bash
sed -i -e 's/\r$//' entrypoint.sh
chmod +x entrypoint.sh
docker compose up -d --build
```

### 3. 重置节点公私钥
如需更换全新的 X25519 密钥对与 ShortId：
```bash
docker compose down
rm -f ./data/config.json ./data/public_key.txt ./data/private_key.txt ./data/client_info.txt
docker compose up -d
```
系统会重新生成全新的一套公私钥，并自动将数据库中保存的用户批量绑定至新节点。

### 4. 宿主机开启 BBR 加速
```bash
echo "net.core.default_qdisc=fq" >> /etc/sysctl.conf
echo "net.ipv4.tcp_congestion_control=bbr" >> /etc/sysctl.conf
sysctl -p
```