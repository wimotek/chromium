# wimotek/ca

开源、可公网商业化部署的双引擎企业级 PKI 与 SSL 证书托管平台（参考 **Step-CA**、**ZeroSSL**、**EJBCA Community** 与 **OpenBao / HashiCorp Vault PKI Engine** 设计），开箱即用、零繁琐配置。

## 核心能力一览

- **单二进制零 CGO**：Go 1.24 `CGO_ENABLED=0` 静态编译，React 管理台、SQLite/MySQL 建表脚本、5 国语言 JSON 全部通过 `embed.FS` 内嵌。
- **引擎一 · 私有两级 ECDSA P-256 企业 CA**：
  - 首次启动自动生成 Root CA（20 年）→ Issuing CA（10 年），序列号采用 RFC 5280 128-bit CSPRNG 随机正整数，私钥经 `CA_MASTER_KEY` AES-256-GCM 静态加密。
  - **8 大企业证书模板**：`tls_server`、`tls_client`、`entra_cba`（内置 `msUPN` 与 HTTP CDP）、`pdf_signing`（内置 Adobe / RFC 9336 / Microsoft 文档签名 OID）、`code_signing`、`smime_email`、`wifi_eap`、`iot_device`。
  - 未上传 CSR 时一键生成 Modern2023 `.pfx`（AES-256-CBC + SHA-256）；上传 CSR 返回完整 PEM 证书链；兼容 OpenBao/Vault `/v1/pki/*`。
- **引擎二 · 公网可信 CA ACME 代理与托管 SSL（Public Trusted CA Proxy & Managed SSL）**：
  - 统一管理多上游浏览器可信公网 CA（Let's Encrypt Prod/Staging、Google Trust Services、ZeroSSL、自定义企业 ACME）。
  - 内置多云 DNS-01 凭据保险库（Cloudflare、阿里云 DNS、腾讯云 DNSPod、AWS Route 53、通用 Webhook，全量 AES-256-GCM 静态加密）。
  - 支持公网单域名与泛域名托管、到期前自动续签，并提供集中式 **ACME 代理目录端点（`/acme/proxy/:upstreamId/directory`）**，让下游服务器使用一套 EAB 即可透明经由本平台签发公网可信证书。
- **完整 RFC 8555 ACME v2 + EAB 与双轨商业配额**：
  - 支持标准 ACME 客户端（Certbot、acme.sh、Caddy、Traefik）通过 HMAC-SHA256 EAB 绑定账户，完成 `http-01` / `dns-01` 验证、签发与吊销。
  - **ZeroSSL 风格双轨配额**：Web 手工签发受账号角色配额约束（`admin` 无上限、`operator` 50、`standard` 10、`basic` 3）；通过 EAB 接入的标准 ACME 自动化签发**不限证书数量（ACME Unlimited）**，仅受速率与公网域名合规风控限制。
- **统一身份认证网关、2FA、API Token 与 MCP**：
  - 支持 **统一 `wimotek/OAuth`（OAuth 2.0 + OIDC + PKCE S256）主 SSO 网关**（Issuer、Client ID/Secret、Scopes 均支持环境变量配置及后台「系统设置」实时动态编辑），并兼容直连 Microsoft / GitHub / Google OAuth。
  - 支持邮箱验证、WebAuthn Passkeys 与邮箱 OTP 双因素认证（2FA）、离线 HMAC SHA-256 PoW 防刷（+ `SetNX` 防重放 + 5 次失败锁定 15 分钟）。
  - 支持细粒度作用域 API Token、多渠道到期自动巡检通知（SMTP、Server酱 Turbo/3、Telegram Bot、钉钉/飞书/企微/Slack Webhook）与面向 AI Agent 的 MCP Server 接口。
- **双模数据库、高并发防死锁与 5 语言 RTL**：
  - SQLite（WAL 读写分离）与 MySQL 8.x 双模支持（`WithTx` 自动处理死锁重试）；`HybridCache` 支持 Redis 优先、15s 熔断自动降级 SQL `cache_kv`、10s 探活恢复并双删吊销缓存。
  - 完整支持 `en` / `zh-CN` / `ja` / `de` / `ar`（含阿拉伯语 `dir="rtl"`）。
- **非 Root 容器安全与构建隔离**：
  - 以非特权用户 `UID/GID 10001:10001` 运行，数据存于 `/data`，外部 TLS 证书只读挂载 `/certs:ro` 并支持每 30 秒热重载。
  - 仓库根目录的架构规范与 AI 提示词文件 `AI_PROMPT.md` 已通过 `.dockerignore` 严格排除，**构建镜像时绝不会包含该文件**。

---

## 快速启动（Docker & Docker Compose）

容器镜像通过 GitHub Actions 同步发布至 **GHCR** 与 **Docker Hub**（仓库名 `ca`）：

- GHCR：`ghcr.io/wimotek/ca:latest`（客户端管理台：`ghcr.io/wimotek/ca:cli`）
- Docker Hub：`docker.io/wimotek/ca:latest`（客户端管理台：`docker.io/wimotek/ca:cli`）

### 1. 使用 Docker Compose 启动（生产推荐）

仓库根目录与 `ca/` 目录下均已提供完整的 [`docker-compose.yml`](../docker-compose.yml)，所有可选环境变量均附带 `#` 中文备注说明，并内置可选 `profiles`（`cli`、`mysql`、`redis`）：

```bash
mkdir -p ./ca-data ./cli-data
# 容器以非 root UID/GID 10001 运行，宿主机挂载目录需赋予 10001 写权限
chown -R 10001:10001 ./ca-data ./cli-data

# 默认零配置启动（SQLite + 自动签发 HTTPS 证书，访问 https://localhost:8443）
docker compose up -d

# 按需组合启用可选组件：
docker compose --profile cli up -d                        # 同时启动 wimotek-cli Web 管理台 (:9443)
docker compose --profile mysql --profile redis up -d      # 启用 MySQL 8.4 + Redis 7 高并发架构
```

> 首次访问 `https://localhost:8443` 将自动进入 3 步安装向导设置管理员密码与组织信息；若已配置 `CA_ADMIN_PASSWORD` 则直接进入登录页。

### 2. Docker CLI 快速单容器启动（支持挂载外部 `/certs:ro`）

外部只读证书目录 `/certs:ro` 自动识别以下任一文件名组合并每 30 秒热重载：
- `tls.crt` + `tls.key`（Kubernetes TLS Secret 格式）
- `fullchain.pem` + `privkey.pem`（Let's Encrypt / Certbot 格式）
- `server.crt` + `server.key`

```bash
docker run -d --name wimotek-ca \
  --user 10001:10001 \
  -p 8443:8443 \
  -v $(pwd)/ca-data:/data \
  -v $(pwd)/tls-certs:/certs:ro \
  -e CA_BASE_URL="https://ca.example.com:8443" \
  -e CA_ORG_NAME="Acme Corp" \
  ghcr.io/wimotek/ca:latest
```

> **权限说明**：进程绝不向 `/certs` 写入任何文件。未挂载或目录为空时，自动签发的 HTTPS 证书会持久化到 `/data/tls/server.crt` 与 `/data/tls/server.key`（权限 `0600`），重启自动复用并在到期前 15 天自动续签。

---

## 环境变量说明（全部内置安全默认值）

完整注释模板亦可直接查看根目录 `docker-compose.yml` 与 `ca/ca/.env.example`。

### 核心网络、TLS 与存储

| 变量名 | 是否必填 | 默认值 | 说明与备注 |
| :--- | :---: | :--- | :--- |
| `CA_HTTP_ENABLED` | 可选 | `true` | 是否启用 HTTP 监听（默认与 HTTPS 同时开启）。仅需纯 HTTPS 时可设为 `false`。 |
| `CA_HTTP_ADDR` | 可选 | `:8080` | HTTP 服务监听地址。 |
| `CA_HTTPS_ENABLED` | 可选 | `true` | 是否启用内置 HTTPS 监听（默认与 HTTP 同时开启）。前置 Nginx/Caddy/Traefik 终止 TLS 且不需要内置 HTTPS 时可设为 `false`。 |
| `CA_HTTPS_ADDR` | 可选 | `:8443` | HTTPS 服务监听地址。 |
| `CA_BASE_URL` | 可选 | `https://localhost:8443` | 对外访问根地址，用于写入 CRL CDP、OCSP AIA、ACME 目录及 OAuth 回调地址。**公网生产强烈建议显式配置**。 |
| `CA_ORG_NAME` | 可选 | `Wimotek Enterprise` | 自动初始化 Root CA / Issuing CA 的组织名称（Subject `O`），首次启动亦可在安装向导修改。 |
| `CA_DATA_DIR` | 可选 | `/data` | 持久化数据目录（存放 SQLite 数据库、`.master.key` 与自签 `/data/tls/`），须对 UID `10001` 可写。 |
| `CA_CERTS_DIR` | 可选 | `/certs` | 外部 TLS 证书只读挂载目录（`:ro`），为空时自动生成 ECDSA P-256 证书。 |
| `CA_TLS_HOSTS` | 可选 | `localhost,127.0.0.1` | 自动生成 HTTPS 证书时额外附加的 SAN 域名或 IP（逗号分隔）。 |
| `CA_ADMIN_USER` | 可选 | `admin` | 初始管理员用户名。 |
| `CA_ADMIN_PASSWORD` | 可选 | `""`（空） | 初始管理员口令。留空时首次访问将进入 3 步安装向导并 bcrypt 落盘。 |
| `CA_MASTER_KEY` | 可选 | `""`（空） | 32 字节十六进制主密钥（AES-256-GCM 加密 CA 私钥、DNS 凭据、通知密钥及 HMAC）。留空自动生成并保存至 `/data/.master.key`。 |
| `CA_POW_DIFFICULTY` | 可选 | `16` | 登录离线 SHA-256 PoW 难度（前导零位数，范围 `8`–`24`）。 |
| `CA_DB_DRIVER` | 可选 | `sqlite` | 数据库驱动：`sqlite`（默认）或 `mysql`。 |
| `CA_DB_DSN` | 可选 | `/data/wimotek-ca.db` | 数据库连接串；使用 MySQL 时必填，如 `user:pass@tcp(mysql:3306)/wimotek_ca?parseTime=false&multiStatements=true`。 |
| `CA_REDIS_ADDR` | 可选 | `""`（空） | Redis 地址（如 `redis:6379`）；留空或宕机时自动无感降级 SQL `cache_kv`。 |
| `CA_REDIS_PASSWORD` | 可选 | `""`（空） | Redis 认证密码。 |
| `CA_REDIS_TLS` | 可选 | `false` | 连接 Redis 是否启用 TLS 1.2+。 |
| `CA_REDIS_TLS_INSECURE` | 可选 | `false` | 启用 Redis TLS 时是否跳过服务端证书校验（仅限内网自签 Redis）。 |
| `CA_NOTIFY_INTERVAL_MIN` | 可选 | `60` | 后台证书到期自动巡检间隔（分钟）。 |
| `CA_ALLOW_PRIVATE_WEBHOOKS` | 可选 | `false` | 是否允许通知 Webhook 指向本机或内网私网地址（默认 `false` 防 SSRF）。 |

### 统一身份网关（`wimotek/OAuth`）、直连 OAuth 与系统 SMTP

| 变量名 | 是否必填 | 默认值 | 说明与备注 |
| :--- | :---: | :--- | :--- |
| `WIMOTEK_OAUTH_ISSUER` | 可选 | `""`（空） | 统一 `wimotek/OAuth`（OIDC + PKCE S256）网关 Issuer 地址；亦可在后台「系统设置」随时动态编辑。 |
| `WIMOTEK_OAUTH_CLIENT_ID` | 可选 | `""`（空） | 统一 OAuth 网关注册的 Client ID。 |
| `WIMOTEK_OAUTH_CLIENT_SECRET` | 可选 | `""`（空） | 统一 OAuth 网关 Client Secret（公有 PKCE 客户端可留空）。 |
| `WIMOTEK_OAUTH_SCOPES` | 可选 | `openid profile email` | 请求的 OIDC/OAuth Scope 列表。 |
| `OAUTH_MICROSOFT_CLIENT_ID` / `_SECRET` / `_TENANT_ID` | 可选 | `""` / `common` | 可选直连 Microsoft Entra ID OAuth 凭据。 |
| `OAUTH_GITHUB_CLIENT_ID` / `_SECRET` | 可选 | `""` | 可选直连 GitHub OAuth 凭据。 |
| `OAUTH_GOOGLE_CLIENT_ID` / `_SECRET` | 可选 | `""` | 可选直连 Google OAuth 凭据。 |
| `CA_SMTP_HOST` / `CA_SMTP_PORT` | 可选 | `""` / `587` | 系统级 SMTP 服务器与端口，用于新用户邮箱验证及 2FA 邮箱 OTP 验证码发送。 |
| `CA_SMTP_USER` / `CA_SMTP_PASSWORD` / `CA_SMTP_FROM` | 可选 | `""` | 系统级 SMTP 登录凭据与发件人地址。 |

---

## 核心 API 端点速览

- **公开 PKI 与吊销端点**：`GET /ca/root.crt`、`GET /ca/issuing.crt`、`GET /ca/chain.pem`、`GET /ca/crl.der`、`GET /ca/crl.pem`、`POST /ca/ocsp`
- **RFC 8555 ACME v2 与 EAB 端点**：`GET /acme/directory`、`HEAD /acme/new-nonce`、`POST /acme/new-account`、`POST /acme/new-order`、`POST /acme/authz/:id`、`POST /acme/chall/:id`、`POST /acme/finalize/:id`、`POST /acme/cert/:id`、`POST /acme/revoke-cert`
- **公网可信 CA ACME 代理端点**：`GET /acme/proxy/:upstreamId/directory`（以及后台托管 SSL API `/api/managed/*`）
- **OpenBao / HashiCorp Vault PKI 兼容端点**：`GET /v1/pki/ca/pem`、`GET /v1/pki/ca_chain`、`GET /v1/pki/crl/pem`、`POST /v1/pki/issue/:role`、`POST /v1/pki/sign/:role`、`POST /v1/pki/revoke`
- **统一 OAuth 回调端点**：`GET /api/auth/oauth/wimotek/callback`（及短别名 `GET /callback`）

---

## AI 架构提示词与镜像构建隔离

- 仓库根目录的 [`AI_PROMPT.md`](../../AI_PROMPT.md) 记录了本项目最新的完整商业架构与研发提示词，便于团队协作或后续 AI 迭代。
- **构建排除保障**：仓库所有 Docker 构建上下文（`/.dockerignore`、`/ca/.dockerignore`、`/ca/ca/.dockerignore`、`/ca/cli/.dockerignore`）均显式排除了 `AI_PROMPT.md` 及 `**/AI_PROMPT.md`，且采用多阶段静态编译（最终 `alpine:3.21` 镜像仅包含编译后的单个二进制文件），确保任何构建出的容器镜像绝不会包含 `AI_PROMPT.md`。

---

## 本地构建与交叉编译

```bash
cd ca/ca
make frontend       # 构建前端并内嵌至 web/dist
make test           # 运行 CGO_ENABLED=0 全量单元测试
make build          # 编译当前平台静态单二进制
make cross-compile  # 静态交叉编译 linux/amd64, linux/arm64, windows/amd64, darwin/arm64
```
