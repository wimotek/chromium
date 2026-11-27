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

- Mount TLS certificates (`fullchain.pem` & `privkey.pem`, or `fullchain` & `prikey`) to `/certs:ro`.
- If `/certs` is empty or unmounted, `wimotek/url` automatically generates an ECDSA P-256 self-signed certificate inside `/data/certs`.

## Synchronize wimotek/Oauth Hosted Login Theme

```bash
export WIMOTEK_ADMIN_SESSION_TOKEN="<YOUR_ADMIN_TOKEN>"
chmod +x scripts/sync-oauth-theme.sh
./scripts/sync-oauth-theme.sh
```
