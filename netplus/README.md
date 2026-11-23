# NetPlus — 多云主机、DNS 自动化与 OCI ARM 抢注控制台

本目录 `netplus/` 为独立可部署的生产项目目录，包含全部前后端源码、Dockerfile、docker-compose.yml、编译发布脚本与 GitHub Actions 工作流，已与在线预览环境完全隔离。

- **Docker Hub 镜像**：`wimotek/netplus:latest`
- **GHCR 镜像**：`ghcr.io/wimotek/netplus:latest`

## 目录结构

```text
netplus/
├── src/                               # React + Tailwind CSS 前端界面
├── server/                            # 多云 API (OCI / AWS / 阿里云 / GCP)、DNS 同步、监控与通知服务
├── server.ts                          # Express 后端与生产静态资源入口
├── Dockerfile                         # 四阶段多架构容器构建（宿主机架构原生编译）
├── Dockerfile.release                 # 预编译产物镜像构建（仅打包已验证的 dist/ 与 dist-server/，零源码）
├── Dockerfile.release.dockerignore    # 发布镜像白名单，仅允许编译产物进入构建上下文
├── scripts/build-and-push.sh          # 本地一键「先编译校验 -> 冒烟测试 -> 推送多架构镜像」脚本
├── docker-compose.yml                 # Docker Compose 生产编排（含宝塔 /certs:ro 挂载示例）
├── docker-entrypoint.sh               # 安全证书权限中转脚本（UID 1001 非 root 运行）
├── .github/workflows/                 # 先编译冒烟验证、再构建推送 GHCR & Docker Hub 的 CI 工作流
├── .env.example                       # 生产环境变量模板
└── package.json
```

## 快速部署（零环境变量开箱即用）

### 直接拉取镜像运行

无需传递任何环境变量，默认自动同时监听 HTTP (`3000`) 与 HTTPS (`3443`，未挂载外部证书时自动生成持久化自签证书)：

```bash
docker run -d --name netplus --restart unless-stopped \
  -p 3000:3000 \
  -p 3443:3443 \
  -v netplus_data:/data \
  wimotek/netplus:latest
# 或使用 GHCR 镜像：ghcr.io/wimotek/netplus:latest
```

### Docker Compose

```bash
docker compose pull && docker compose up -d
# 或本地编译构建启动：
docker compose up -d --build
```

启动后直接访问 `http://<server-ip>:3000` 或 `https://<server-ip>:3443` 登录（无公开「创建管理员」页面，避免抢注风险）。全新生产实例默认零示例数据，所有凭据与配置均持久化保存在 `/data`。

> **获取初始管理员密码 & 命令行健康检查**：
> - 未设置 `ADMIN_PASSWORD` 时，首次启动会自动生成 16 位随机强密码并**一次性打印在容器日志中**，执行 `docker logs netplus` 即可查看（默认用户名 `admin`），登录后建议立即在「安全设置」修改密码。
> - 检测 HTTP：`curl http://127.0.0.1:3000/api/health`
> - 检测 HTTPS：`curl -k https://127.0.0.1:3443/api/health`（注意必须带 `https://` 与 `-k`；直接执行 `curl 127.0.0.1:3443` 会因明文 HTTP 请求连到 TLS 端口而返回 `Empty reply from server`）

## 环境变量说明（全部可选，均带默认值）

```bash
# 以下变量均为可选（# 注释即使用内置默认值），按需取消注释或通过 -e 传入：
# PORT=3000                             # HTTP 监听端口（默认 3000）
# HTTPS_PORT=3443                       # HTTPS 监听端口（默认 3443；设为 0 可关闭内置 HTTPS）
# DATA_DIR=/data                        # 数据、加密密钥(.app.key)、自签证书与审计日志持久化目录（容器默认 /data）
# TLS_CERT_DIR=/certs                   # 外部 SSL 证书只读挂载目录（默认 /certs，支持宝塔 fullchain.pem/privkey.pem）
# TLS_AUTO_SELF_SIGNED=true             # 未挂载外部证书时是否自动生成自签证书（默认 true）
# TLS_SELF_SIGNED_CN=netplus.local      # 自动自签证书默认 CN（默认 netplus.local）
# ADMIN_USERNAME=admin                  # 首次启动初始管理员用户名（默认 admin，仅首次写入生效）
# ADMIN_PASSWORD=change-me-strong-pass  # 首次启动初始管理员密码（仅初始值，不锁定；留空则自动生成 16 位随机强密码并打印到 docker logs netplus）
# APP_ENCRYPTION_KEY=                   # 可选 64 位十六进制 AES-256 密钥（留空自动生成并持久化在 /data/.app.key）
# AUDIT_MAX_SIZE_BYTES=5242880          # 审计日志容量上限，单位字节（默认 5242880 即 5MB）
```

## 先编译源码再构建 / 推送镜像

### 方式 1：一键编译校验并推送（推荐）

```bash
chmod +x scripts/build-and-push.sh

# 依次执行：tsc 类型检查 -> Vite 编译前端(dist/) -> esbuild 编译后端(dist-server/server.mjs)
# -> 本地生产启动冒烟检查(/api/health) -> 通过后再打包推送多架构镜像
./scripts/build-and-push.sh wimotek/netplus latest
./scripts/build-and-push.sh ghcr.io/wimotek/netplus latest

# 仅本地编译并构建镜像验证（不推送远程仓库）
NO_PUSH=true ./scripts/build-and-push.sh wimotek/netplus local
```

### 方式 2：手动分步编译再构建镜像

```bash
npm install --include=dev
npm run build:all                      # 1. 类型检查 + 编译前端 dist/ + 编译后端 dist-server/server.mjs

# 2. 使用预编译产物打包多架构镜像并推送（镜像内不含 TS 源码，仅保留运行期依赖）
docker buildx build -f Dockerfile.release \
  --platform linux/amd64,linux/arm64 \
  --push \
  -t wimotek/netplus:latest \
  -t ghcr.io/wimotek/netplus:latest .
```

### 方式 3：GitHub Actions 自动流水线

- 整个仓库提交时，根目录 `.github/workflows/docker-publish.yml` 通过统一变量 `WORKING_DIR: netplus` 调度编译与打包。
- 单独导出 `netplus/` 目录作为独立仓库时，内置 `.github/workflows/docker-publish.yml` 使用 `WORKING_DIR: .` 开箱即用。
- 流水线先运行 `compile-and-verify`（类型检查 + 编译 + 生产启动 `/api/health` 冒烟测试），通过后再触发 `build-and-push` 推送至 `ghcr.io/wimotek/netplus` 与 `wimotek/netplus`（配置 `DOCKERHUB_USERNAME` 与 `DOCKERHUB_TOKEN` Secret）。
