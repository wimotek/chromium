# Wimotek Commercial PKI Suite (`ca/ca` + `ca/cli`)

An enterprise-grade, public-internet-ready, dual-engine PKI and SSL certificate hosting platform — combining a lightweight **Commercial Certificate Authority & ACME Server** (`ca/ca`) and a **Smallstep (`step`) aligned PKI Client with Embedded Web Manager** (`ca/cli`).

## Repository Layout

```text
.
├── docker-compose.yml   # Production Docker Compose with commented optional env vars & profiles (cli / mysql / redis)
├── AI_PROMPT.md         # Latest architecture & AI engineering specification (strictly excluded from Docker builds via .dockerignore)
├── .dockerignore        # Excludes AI_PROMPT.md, compose files, secrets & local data from Docker contexts
└── ca/
    ├── docker-compose.yml
    ├── ca/              # Commercial Dual-Engine CA Server (Go 1.24, CGO_ENABLED=0, SQLite/MySQL, Redis HybridCache, Embedded React UI)
    └── cli/             # Step-aligned PKI Client + Embedded Web Management Console (Go 1.24, CGO_ENABLED=0, Auto-Renewal Daemon)
```

## Docker Images (Docker Hub & GHCR — unified `ca` repository)

Both the CA Server and the CLI Client are published to the same `ca` repository via GitHub Actions (`.github/workflows/publish_ca.yml`):

| Component | Docker Hub / GHCR Tag | Quick Start |
|---|---|---|
| **CA Server** | `ca:latest` (`ca:<version>`) | `docker run -d --name wimotek-ca -p 8443:8443 -v ./ca-data:/data ghcr.io/wimotek/ca:latest` |
| **CLI Client + Web Manager** | `ca:cli` (`ca:cli-<version>`) | `docker run -d --name wimotek-cli -p 9443:9443 -e WIMOTEK_CLI_WEB_PASSWORD=change-me -v ./cli-data:/data ghcr.io/wimotek/ca:cli` |

### Docker Compose Quick Start (Recommended)

A complete [`docker-compose.yml`](./docker-compose.yml) (also available at the repository root) is provided with `#` comments explaining every optional environment variable and profile:

```bash
mkdir -p ./ca-data ./cli-data
chown -R 10001:10001 ./ca-data ./cli-data

# 1. Default zero-config start (SQLite WAL + automatic self-signed HTTPS)
docker compose up -d

# 2. Optional profiles (mix and match as needed)
docker compose --profile cli up -d                        # Add wimotek-cli Web Manager (:9443)
docker compose --profile mysql --profile redis up -d      # Enable MySQL 8.4 + Redis 7 HybridCache
```

> **Build Isolation Notice**: `AI_PROMPT.md` at the repository root is maintained strictly for engineering reference and is explicitly excluded from all Docker build contexts and images via `.dockerignore` (`/.dockerignore`, `/ca/.dockerignore`, `/ca/ca/.dockerignore`, `/ca/cli/.dockerignore`).

## Architecture Highlights

- **Pure Go 1.24 Static Binaries (`CGO_ENABLED=0`)**: Both `wimotek-ca` and `wimotek-cli` cross-compile cleanly for `linux/amd64`, `linux/arm64`, `windows/amd64`, and `darwin/arm64` with all frontend assets, SQL schemas, and 5-language i18n JSON embedded directly via `embed.FS`.
- **Dual-Engine Server (`ca/ca`)**:
  - **Engine 1 — Private 2-Tier Enterprise CA**: Automatic ECDSA P-256 `Root CA → Issuing CA` with RFC 5280 128-bit CSPRNG serials, 8 built-in enterprise templates (`tls_server`, `tls_client`, `entra_cba` with `msUPN`, `pdf_signing` with Adobe/RFC9336/MS OIDs, `code_signing`, `smime_email`, `wifi_eap`, `iot_device`), CRL/OCSP AIA, Modern2023 `.pfx` delivery, and OpenBao/Vault `/v1/pki/*` compatibility.
  - **Engine 2 — Public Trusted CA ACME Proxy & Managed SSL**: Manage browser-trusted public ACME upstreams (Let's Encrypt Prod/Staging, Google Trust Services, ZeroSSL, custom ACME), AES-256-GCM encrypted DNS-01 provider vaults (Cloudflare, Aliyun DNS, DNSPod, AWS Route 53, Webhook), automated domain SSL hosting & renewal, and unified ACME proxy directory endpoints (`/acme/proxy/:upstreamId/directory`).
  - **RFC 8555 ACME v2 + EAB + ZeroSSL-Style Quota Separation**: Full RFC 8555 endpoints (`/acme/directory`, `new-nonce`, `new-account` with HMAC-SHA256 EAB, `new-order`, `authz`, `http-01`/`dns-01` challenges, `finalize`, `cert`, `revoke-cert`). Manual web issuance enforces per-role quotas, while EAB-authenticated ACME clients (Certbot, acme.sh, Caddy, Traefik) enjoy **unlimited ACME issuance** with domain compliance & rate controls.
  - **Unified SSO, 2FA, API Tokens, Notifications & MCP**: Editable `wimotek/OAuth` (PKCE S256) primary SSO gateway plus optional direct Microsoft/GitHub/Google OAuth, Email Verification & 2FA (WebAuthn Passkeys + Email OTP), offline PoW anti-abuse, scoped multi-purpose API tokens, expiry alerts (SMTP, ServerChan Turbo/3, Telegram, Webhook), MCP Server endpoints, and 5-language RTL-ready UI (`en`, `zh-CN`, `ja`, `de`, `ar`).
  - **Resilient Storage & Non-Root Security**: Dual SQLite (WAL write/read split) & MySQL (`WithTx` deadlock retry), `HybridCache` (Redis + automatic SQL fallback), non-root `UID/GID 10001:10001`, `/data` persistence, and `/certs:ro` read-only TLS hot reload.
- **Client (`ca/cli`)**:
  - Aligned with `step` CLI commands (`ca bootstrap`, `ca certificate`, `ca renew --daemon`, `ca revoke`, `certificate inspect/verify/p12/install`, `crypto keypair/rand`, `context`).
  - Built-in Web Management Console (`wimotek-cli web`) for multi-CA context switching, local certificate lifecycle & auto-renewal, X.509 decoding/verification, and offline Modern2023 `.pfx` packaging.

## Quick Build

```bash
# Build CA Server
CGO_ENABLED=0 go -C ca/ca build -o ../../bin/wimotek-ca ./cmd/server

# Build CLI Client (+ embedded Web UI)
CGO_ENABLED=0 go -C ca/cli build -o ../../bin/wimotek-cli ./cmd/wimotek-cli
```

See [ca/ca/README.md](./ca/README.md) and [ca/cli/README.md](./cli/README.md) for detailed configuration, Docker Compose options, and complete environment variable documentation.
