# Xray 极简免配置容器 & 网页管理多用户租用系统

本项目提供一个**体积小于 18MB**、**免配置**、支持**双层端口防探测架构 (Dokodemo 443 ⇄ Reality 4431)** 的 Xray 代理容器与多用户租用管理 Web 面板。

---

## 📁 容器核心文件清单

- `Dockerfile`: 基于 Alpine 3.20 的多阶段极简构建文件，产物镜像仅 ~17.8MB。
- `docker-compose.yml`: 一键同时编排 Xray 代理核心与网页管理后台。
- `entrypoint.sh`: 免配置核心启动脚本。如果未挂载任何配置，自动生成 X25519 密钥对、UUID、ShortID 并就绪启动。
- `config.json`: 您指定的标准双层防嗅探配置模板。
- `setup.sh`: 全新 VPS 终端 1 键自动化部署脚本（自动装 Docker、开启 BBR、拉起容器）。

---

## 🚀 部署方式

### 方式一：一键自动脚本（最推荐）

在你的 Linux VPS 终端运行：
```bash
bash setup.sh
```

### 方式二：Docker Compose 编排启动

```bash
docker compose up -d
```
启动后：
- Xray 代理监听：`443`（外层 dokodemo-door）与 `4431`（内层 Reality）
- 网页管理后台：访问 `http://你的IP:3000`

### 方式三：直接构建并运行单容器

```bash
# 1. 构建镜像（体积 < 18MB）
docker build -t xray-reality:alpine .

# 2. 运行容器（推荐 host 模式）
docker run -d \
  --name xray-reality-core \
  --restart always \
  --net=host \
  -v $(pwd)/config.json:/etc/xray/config.json \
  xray-reality:alpine
```

---

## 🌐 网页管理多用户租用系统功能

1. **租户全生命周期管控**：实时增删改查租户，到期/超额自动禁用。
2. **多客户端格式导出**：
   - 一键生成并复制 `vless://` 链接与二维码。
   - Clash Meta (Mihomo) YAML 配置。
   - Sing-Box 1.8+ JSON 配置。
   - 真实的订阅接口：`/api/sub/:token`。
3. **Reality 伪装站点检测**：内置 Samsung、Cloudflare Speed、Microsoft 等站点的 TLS 1.3 探测。
