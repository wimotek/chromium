# wimotek/ca

开源、企业级轻量 CA 证书服务器（参考 **Step-CA**、**EJBCA Community** 与 **OpenBao / HashiCorp Vault PKI Engine** 设计），面向中小企业开箱即用、零繁琐配置。

- **单二进制零 CGO**：Go 1.24 `CGO_ENABLED=0` 静态编译，前端 UI、SQLite/MySQL 建表脚本、5 国语言 JSON 全部通过 `embed.FS` 内嵌。
- **两级 ECDSA P-256 PKI**：首次启动自动生成 Root CA（20 年）→ Issuing CA（10 年），序列号采用 RFC 5280 128-bit CSPRNG 随机正整数。
- **首次进入安装向导**：首次启动自动引导 3 步配置（组织与 PKI 地址 → 管理员与 X.509 资料 → 可选到期通知渠道），开箱即用。
- **8 大企业证书模板**：
  - `pdf_signing`：内置 Adobe（`1.2.840.113583.1.1.5`）、RFC 9336（`1.3.6.1.5.5.7.3.36`）与 Microsoft（`1.3.6.1.4.1.311.10.3.12`）文档签名 OID。
  - `entra_cba`：内置 SAN OtherName `msUPN`（`1.3.6.1.4.1.311.20.2.3`）、ClientAuth EKU 与强制 HTTP CRL 分发点。
  - `tls_server`：内网 Web / API 网关，支持多 DNS / IP SAN。
  - `tls_client`：mTLS / VPN 双向客户端认证。
  - `code_signing`：脚本 / 二进制代码签名（`1.3.6.1.5.5.7.3.3`）。
  - `smime_email`：企业邮件 S/MIME 签名与加密（`1.3.6.1.5.5.7.3.4`）。
  - `wifi_eap`：802.1X Wi-Fi / RADIUS EAP-TLS 认证。
  - `iot_device`：IoT / 微服务双向节点身份（ClientAuth + ServerAuth）。
- **多用户分级配额与资料自动填充**：支持 `admin`（无上限）、`operator`（默认 50）、`standard`（默认 10）、`basic`（默认 3）四级账户及自定义有效证书上限；个人 X.509 资料（姓名、组织、部门、邮箱、msUPN、C/ST/L）申请证书时自动填充。
- **多渠道到期通知模块**：内置 Email (SMTP)、Server酱（Turbo / Server酱³）、Telegram Bot 与通用 Webhook（钉钉 / 飞书 / 企微 / Slack），支持按提前天数（如 `30, 7, 1`）定时巡检、自动去重与渠道凭据 AES-256-GCM 静态加密。
- **一键交付 Modern2023 `.pfx`**：未提交 CSR 时自动生成密钥并打包 AES-256-CBC + SHA-256 `.pfx` 供员工双击安装；提交 CSR 则签发完整 PEM 证书链。
- **双模数据库与高并发防互锁**：支持 SQLite（`WriteDB=1` WAL + `ReadDB` 读写分离）与 MySQL（`WithTx` 自动处理 `SQLITE_BUSY` 与 MySQL `1213/1205` 死锁重试），证书配额校验与插入在同一事务内原子执行；`HybridCache` 支持 Redis 优先、15 秒熔断、10 秒探活恢复清理滞留 `crl:issuing`、吊销双删 SQL + Redis。
- **安全防刷与 5 语言 RTL**：无状态 HMAC SHA-256 离线 PoW（+ `SetNX` 防重放）、分布式 IP 窗口限流、5 次失败锁定 15 分钟；支持 `en` / `zh-CN` / `ja` / `de` / `ar`（含阿拉伯语 `dir="rtl"`）。
- **非 Root 容器安全**：以非特权用户 `UID/GID 10001:10001` 运行，数据存于 `/data`，外部 TLS 证书只读挂载至 `/certs:ro`，未挂载时自动生成 ECDSA P-256 自签/Issuing CA 签发证书。

---

## 快速启动（Docker）

容器镜像同时发布至 **Docker Hub** 与 **GHCR**（仓库名 `ca`）：

- Docker Hub: `docker.io/<your-dockerhub-user>/ca:latest`
- GHCR: `ghcr.io/<your-github-owner>/ca:latest`

### 1. 零配置生产启动（未挂载 `/certs` 时自动签发 HTTPS 证书）

```bash
mkdir -p ./ca-data
# 容器以非 root UID/GID 10001 运行，宿主机挂载目录需赋予 10001 写权限
chown -R 10001:10001 ./ca-data

docker run -d --name wimotek-ca \
  -p 8443:8443 \
  -v $(pwd)/ca-data:/data \
  ghcr.io/wimotek/ca:latest
```

首次访问 `https://localhost:8443` 即可通过初始化界面认领管理员密码（若已设置 `CA_ADMIN_PASSWORD` 则直接进入 PoW 登录页）。

### 2. 挂载外部只读 TLS 证书（`/certs:ro`）

支持自动识别以下任一文件名组合：
- `tls.crt` + `tls.key`（Kubernetes TLS Secret 默认格式）
- `fullchain.pem` + `privkey.pem`（Let's Encrypt / Certbot 默认格式）
- `server.crt` + `server.key`

```bash
# 确保挂载证书目录对 UID 10001 可读（目录 755，私钥建议 chgrp 10001 && chmod 640 或由 K8s Secret fsGroup: 10001 映射）
docker run -d --name wimotek-ca \
  -p 8443:8443 \
  -v $(pwd)/ca-data:/data \
  -v $(pwd)/tls-certs:/certs:ro \
  -e CA_BASE_URL="https://ca.example.com:8443" \
  -e CA_ORG_NAME="Acme Corp" \
  ghcr.io/wimotek/ca:latest
```

> **权限说明**：进程绝不向 `/certs` 写入任何文件。当未挂载证书或 `/certs` 为空时，自动生成的 HTTPS 证书会持久化到 `/data/tls/server.crt` 与 `/data/tls/server.key`（权限 `0600`），重启自动复用并在到期前 15 天自动续签；若挂载了 `/certs:ro`，进程每 30 秒检测文件变更并支持热重载。

### 3. Docker Compose 示例（生产推荐）

```yaml
services:
  ca:
    image: ghcr.io/wimotek/ca:latest
    container_name: wimotek-ca
    restart: unless-stopped
    user: "10001:10001"
    ports:
      - "8443:8443"
    volumes:
      - ./ca-data:/data
      - ./tls-certs:/certs:ro
    environment:
      CA_ORG_NAME: "Acme Enterprise"
      CA_BASE_URL: "https://ca.acme.internal:8443"
      # 可选：固定加密主密钥（32字节十六进制）与管理员口令
      # CA_MASTER_KEY: "0123456789abcdef..."
      # CA_ADMIN_PASSWORD: "StrongPassword!2026"
```

---

## 环境变量说明（全部内置默认值）

| 变量名 | 是否必填 | 默认值 | 说明与备注 |
| :--- | :---: | :--- | :--- |
| `CA_TLS_ENABLED` | 可选 | `true` | 是否开启内置 HTTPS。设为 `false` 时以纯 HTTP 运行（默认监听 `:8080`），适用于前置 Nginx/Caddy/Traefik 终止 TLS 的场景。 |
| `CA_LISTEN_ADDR` | 可选 | `:8443`（HTTP 时 `:8080`） | 服务监听地址。 |
| `CA_BASE_URL` | 可选 | `https://localhost:8443` | 对外访问根地址，用于写入证书的 HTTP CRL 分发点（CDP）、OCSP AIA 与 ACME 目录地址。**生产环境建议显式配置为内网域名**。 |
| `CA_ORG_NAME` | 可选 | `Wimotek Enterprise` | 自动生成的 Root CA / Issuing CA 组织名称（Subject `O`），首次启动亦可在安装向导中修改。 |
| `CA_DATA_DIR` | 可选 | `/data` | 持久化数据目录（存放 SQLite 数据库、自动生成的 `.master.key` 及未挂载 `/certs` 时的 `/data/tls/` 证书）。容器内必须对 UID `10001` 可写。 |
| `CA_CERTS_DIR` | 可选 | `/certs` | 外部 TLS 证书只读挂载目录（`:ro`）。为空或未挂载时自动生成 ECDSA P-256 证书。 |
| `CA_TLS_HOSTS` | 可选 | `localhost,127.0.0.1` | **可选备注**：自动生成 HTTPS 证书时额外附加的 SAN 域名或 IP（逗号分隔，如 `ca.corp.local,10.0.0.10`）；默认已包含本机地址与容器主机名。 |
| `CA_ADMIN_USER` | 可选 | `admin` | 管理员登录用户名。 |
| `CA_ADMIN_PASSWORD` | 可选 | `""`（空） | **可选备注**：管理员口令。留空时首次访问 Web 页面将进入 3 步安装向导并 bcrypt 落盘；配置此变量将跳过密码初始化。 |
| `CA_MASTER_KEY` | 可选 | `""`（空） | **可选备注**：用于 AES-256-GCM 加密 Root/Issuing CA 私钥、通知渠道凭据及签发 PoW/会话 HMAC 的 32 字节密钥。留空时会在 `/data/.master.key` 自动生成并持久化（权限 `0600`）。 |
| `CA_DB_DRIVER` | 可选 | `sqlite` | 数据库驱动，支持 `sqlite`（零配置默认）或 `mysql`。 |
| `CA_DB_DSN` | 可选 | `/data/wimotek-ca.db` | **可选备注**：数据库连接串。使用 MySQL 时必填，例如 `user:pass@tcp(mysql:3306)/wimotek_ca?parseTime=false&multiStatements=true`。 |
| `CA_REDIS_ADDR` | 可选 | `""`（空） | **可选备注**：Redis 地址（如 `redis:6379`）。留空或宕机时不阻塞进程，自动无感降级到 SQL `cache_kv` 表。 |
| `CA_REDIS_PASSWORD` | 可选 | `""`（空） | **可选备注**：Redis 认证密码，仅在配置 `CA_REDIS_ADDR` 且 Redis 启用鉴权时填写。 |
| `CA_REDIS_TLS` | 可选 | `false` | **可选备注**：连接 Redis 时是否启用 TLS 1.2+。 |
| `CA_REDIS_TLS_INSECURE` | 可选 | `false` | **可选备注**：启用 Redis TLS 时是否跳过服务端证书校验（仅建议用于内网自签 Redis）。 |
| `CA_POW_DIFFICULTY` | 可选 | `16` | **可选备注**：登录离线 SHA-256 PoW 难度（前导零位数，范围 `8`–`24`）。数值越大防暴力破解越强，浏览器端计算耗时相应增加。 |
| `CA_NOTIFY_INTERVAL_MIN` | 可选 | `60` | **可选备注**：后台证书到期自动巡检间隔（分钟，默认每 60 分钟巡检一次并按渠道提前天数触发去重通知）。 |
| `CA_ALLOW_PRIVATE_WEBHOOKS` | 可选 | `false` | **可选备注**：默认禁止通知 Webhook 指向本机或内网私网地址；若需推送至内网中继服务可设为 `true`。 |

---

## API 端点速览

- **公开 PKI 与吊销端点**：`GET /ca/root.crt`、`GET /ca/issuing.crt`、`GET /ca/chain.pem`、`GET /ca/crl.der`、`GET /ca/crl.pem`、`POST /ca/ocsp`
- **OpenBao / HashiCorp Vault PKI 兼容端点**：`GET /v1/pki/ca/pem`、`GET /v1/pki/ca_chain`、`GET /v1/pki/crl/pem`、`POST /v1/pki/issue/:role`、`POST /v1/pki/sign/:role`、`POST /v1/pki/revoke`
- **Step-CA 风格 ACME 发现端点**：`GET /acme/directory`、`HEAD /acme/new-nonce`

---

## 本地构建与交叉编译

```bash
cd ca
make frontend       # 构建前端并内嵌至 ca/web/dist
make test           # 运行 CGO_ENABLED=0 全量单元测试
make build          # 编译当前平台静态单二进制
make cross-compile  # 静态交叉编译 linux/amd64, linux/arm64, windows/amd64, darwin/arm64
```
