# wimotek/url — Commercial Lightweight URL Shortener

`wimotek/url` is a single-binary Go + React commercial URL shortener engineered for SMBs, combining the minimalism of Chhoto URL with the enterprise controls of Dub, Kutt, and YOURLS.

## Core Capabilities
- **Single-Binary Deployment**: Go backend embedding the production React + TypeScript + Tailwind CSS UI via `go:embed`.
- **Dual Database Engine**: SQLite3 (WAL mode + `busy_timeout` + serialized write lock for deadlock prevention) and MySQL connection pool, with scheduled online backups and retention pruning.
- **Hybrid Cache**: Redis acceleration with automatic fallback to built-in SQL Cache.
- **First-Run Setup Wizard**: Auto-activates when `/data` is uninitialized; configures DB with 1-click connection test, optional Redis skip, Issuer URL, custom `/admin` portal path, Super Admin account, and permanent initialization lock (`.setup.lock`).
- **wimotek/Oauth SSO & Protected Local Fallback**: Native integration with `wimotek/Oauth` (`http://ca.wimotek.com`, client `wimotek_c41ac24274c6`). When disabled, falls back to local login hardened with IP rate limiting, free Cloudflare Turnstile anti-bot checks, and configurable Trusted Device duration.
- **Protected Admin Portal**: Customizable admin login path (default `/admin`) protected at the database & API level so it can never be deleted.
- **Custom Domains & Root `/` Forwarding**: Toggle `/` redirect per domain (redirects to target when enabled; renders homepage when disabled).
- **Analytics, SEO, Audit & Cron**: GeoIP regional telemetry, password-protected & expiring links, 301/302/307 SEO metadata & IndexNow/Sitemap submission, rolling audit logs, and built-in cron scheduler.
- **REST API & MCP Server**: Native `/mcp` JSON-RPC 2.0 endpoint for AI Agents (Claude Desktop, Cursor, Windsurf).

## Docker Deployment (Non-Root, `/data` & `/certs:ro`)

```bash
mkdir -p data certs
chown -R 10001:10001 data
docker compose up -d
```

- Mount TLS certificates (`fullchain.pem` & `privkey.pem`) to `/certs:ro`.
- If `/certs` is empty or unmounted, `wimotek/url` automatically generates an ECDSA P-256 self-signed certificate inside `/data/certs`.

## Synchronize wimotek/Oauth Hosted Login Theme

```bash
export WIMOTEK_ADMIN_SESSION_TOKEN="<YOUR_ADMIN_TOKEN>"
chmod +x scripts/sync-oauth-theme.sh
./scripts/sync-oauth-theme.sh
```

## Cloudflare Workers 部署可行性与方案说明

**结论：当前 Go 单二进制版本不能在不改动代码的情况下直接部署到标准 Cloudflare Workers（D1 + KV）。**

原因在于标准 Cloudflare Workers 运行在 V8 Isolate 沙盒环境，不支持直接运行监听 TCP 端口的 Go Linux 二进制、本地文件系统（`/data`、`sqlite3` 文件、`.setup.lock`）以及常驻 Goroutine 计划任务。

### 方案一：零代码改动接入 Cloudflare（推荐用于现有 Go 版本）
- 使用现有 `Dockerfile` / `docker-compose.yml` 部署在任意轻量 VPS 或容器主机，通过 **Cloudflare Tunnel (`cloudflared`)** 接入 Cloudflare 边缘网络（自动获得 Edge TLS、CDN 缓存与 WAF/防刷，无需挂载 `/certs`）。
- 如需完全运行在 Cloudflare 基础设施内且不改 Go 代码，可使用 **Cloudflare Containers** 运行现有 Docker 镜像（注意容器磁盘为临时存储，需搭配外部 MySQL 数据库以保证数据持久化）。

### 方案二：原生 Cloudflare Workers + D1 (SQLite) + KV Cache（需后端适配）
前端 `url/web` 构建产物可通过 Workers Static Assets 零改动托管，后端需使用 TypeScript（如 Hono）对数据与运行时接口做轻量适配：

| 当前 Go 组件 | Cloudflare Workers 对应能力 | 改动说明 |
| --- | --- | --- |
| SQLite3 (`internal/db`) | **Cloudflare D1**（托管 SQLite） | SQL 语法高度兼容，改用异步 `env.DB.prepare().bind()`；移除本地 WAL/文件锁与磁盘备份 |
| Redis / SQL Cache (`internal/cache`) | **Cloudflare KV** | 短链跳转热路径读取 `env.KV.get(host:slug)`，更新/删除时同步写入或失效 |
| 前端静态资源 (`go:embed`) | **Workers Static Assets** | 直接指向 `url/web/dist`，零改动 |
| 本地 GeoIP (`internal/geoip`) | 原生 **`request.cf`** | 直接读取 `country` / `region` / `city` / `asn`，无需本地 IP 库 |
| 计划任务 (`internal/scheduler`) | **Cron Triggers** | 在 `wrangler.toml` 配置 `[triggers] crons`，由 `scheduled()` 钩子执行日志清理与失效检查 |
| 配置文件 / 密钥 / TLS | **D1 + Wrangler Secrets + Edge SSL** | 配置存 D1，密钥用 `wrangler secret put`，TLS 由 Cloudflare 边缘自动托管 |

