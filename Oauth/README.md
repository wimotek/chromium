# wimotek/Oauth

Lightweight, open-source **Unified Identity Center & OAuth 2.0 / OIDC Identity Provider (IdP)** designed for small-to-medium enterprises. Combines single-binary simplicity and rich domestic/global social connectors with a clean, minimalist developer console, progressive identity linking, and standards-compliant OIDC token issuance.

## Core Capabilities

- **Standard OIDC 1.0 / OAuth 2.0 IdP**: Issues RS256-signed `id_token` & `access_token` JWTs with Auto-Discovery (`/.well-known/openid-configuration`), JWKS (`/.well-known/jwks.json`), Authorization Code + PKCE (`S256`), Refresh Token, UserInfo, Logout, and RFC 8628 Device Flow.
- **Social Login & Modern Auth**: Built-in connectors for Microsoft (Entra ID), Apple (`.p8` + `form_post`), Google, WeChat (Open Platform QR / Official Account MP), GitHub, and extensible generic OIDC; plus Argon2id password, Passwordless Email OTP / Magic Link, TOTP 2FA + Recovery Codes, and Passkeys (WebAuthn).
- **Lightweight Identity Store**: Minimal `users` + `user_identities` tables with JIT provisioning, verified-email smooth account linking, and HMAC-SHA256 signed `user.banned` downstream session revocation webhooks.

## Directory Layout

- `Oauth/` — Core Go backend, embedded React frontend (`go:embed`), multi-stage `Dockerfile`, `docker-compose.yml`, IdP documentation (`Oauth/docs/`), and 5-language minimal SDKs (`python`, `nodejs`, `go`, `java`, `php`).
- `dev/` — Isolated local sandbox (`docker-compose.dev.yml`, MySQL 8, Redis 7, and a mock OIDC client app).
- `.github/workflows/publish_Oauth.yml` — Automated multi-architecture (`linux/amd64`, `linux/arm64`) image builds pushed to Docker Hub (`wimotek/oauth`) and GHCR (`ghcr.io/wimotek/oauth`). *(OCI/Docker image tags remain lowercase per registry specification.)*

---

## Production Deployment (Docker Compose — Recommended)

Create a `docker-compose.yml` file (also provided at `Oauth/docker-compose.yml`):

```yaml
services:
  wimotek-oauth:
    image: wimotek/oauth:latest
    # Or use GitHub Container Registry:
    # image: ghcr.io/wimotek/oauth:latest
    container_name: wimotek-Oauth
    restart: unless-stopped
    ports:
      - "8080:8080"   # HTTP
      - "8443:8443"   # HTTPS (uses /certs if mounted, otherwise auto-generates under /data/certs)
    volumes:
      - ./data:/data          # Read-Write: SQLite3 WAL DB, config.json, RS256 keys, auto-generated master.key & TLS certs
      # - ./certs:/certs:ro   # Optional Read-Only: mount custom tls.crt/tls.key or fullchain.pem/privkey.pem
    environment:
      - TZ=Asia/Shanghai
      # [Optional] Master encryption key for AES-256-GCM at-rest encryption of third-party OAuth secrets,
      # Apple .p8 private keys, TOTP secrets, and webhook signing secrets.
      # If omitted, a random 32-byte key is auto-generated and persisted at /data/keys/master.key (0600).
      # Set explicitly ONLY when running multiple replicas sharing an external MySQL database.
      # - WIMOTEK_MASTER_KEY=replace-with-strong-32-byte-secret
      #
      # [Optional] Custom HTTP / HTTPS bind addresses inside the container (defaults: :8080 / :8443)
      # - WIMOTEK_HTTP_ADDR=:8080
      # - WIMOTEK_HTTPS_ADDR=:8443
      #
      # [Optional] Custom data and certificate directories inside the container (defaults: /data / /certs)
      # - WIMOTEK_DATA_DIR=/data
      # - WIMOTEK_CERTS_DIR=/certs
```

Prepare the data directory for the non-root container user (`1000:1000`) and start:

```bash
mkdir -p ./data
chown -R 1000:1000 ./data
docker compose up -d
```

### Quick `docker run` Equivalent

```bash
mkdir -p ./data && chown -R 1000:1000 ./data

docker run -d \
  --name wimotek-Oauth \
  --restart unless-stopped \
  -p 8080:8080 \
  -p 8443:8443 \
  -v $(pwd)/data:/data \
  # -v $(pwd)/certs:/certs:ro \
  # -e WIMOTEK_MASTER_KEY="replace-with-strong-32-byte-secret" \
  wimotek/oauth:latest
```

---

## Environment Variables Reference

| Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `WIMOTEK_MASTER_KEY` | Optional | Auto-generated at `/data/keys/master.key` | Derives the 256-bit **AES-256-GCM** key used to encrypt sensitive secrets stored in the database (social provider `client_secret`, Apple `.p8` key, TOTP 2FA secrets, webhook signing secrets). **Single-node deployments do not need to set it** — the server auto-generates and persists a random 32-byte key in `/data/keys/master.key` (`0600`). For **multi-node clusters sharing MySQL**, set the exact same value on all nodes and never change it without migrating encrypted rows. |
| `WIMOTEK_DATA_DIR` | Optional | `/data` | Writable data directory for SQLite3 WAL database, `config.json`, `keys/oidc_rs256.pem`, `keys/master.key`, and auto-generated fallback TLS certs. |
| `WIMOTEK_CERTS_DIR` | Optional | `/certs` | Read-only directory checked first for custom TLS certificates (`tls.crt`/`tls.key`, `server.crt`/`server.key`, or `fullchain.pem`/`privkey.pem`). Never written to. |
| `WIMOTEK_HTTP_ADDR` | Optional | `:8080` | Container HTTP listen address. |
| `WIMOTEK_HTTPS_ADDR` | Optional | `:8443` | Container HTTPS listen address. |
| `TZ` | Optional | `UTC` | Container timezone (e.g. `Asia/Shanghai`). |

### Volume & Certificate Handling
- **`/data` (Read-Write)**: Stores SQLite3 database (WAL mode + `busy_timeout=5000`), `config.json`, persistent RS256 OIDC signing keys, auto-generated `master.key`, and fallback self-signed TLS certificates (`/data/certs/`). The container runs as non-root `1000:1000`; if `/data` is not writable, the server prints actionable `chown` diagnostics on startup.
- **`/certs` (Read-Only `:ro`)**: Checked first for custom TLS certificates. If `/certs` is empty or unmounted, the server **never writes to `/certs`** and automatically generates & persists a self-signed certificate inside `/data/certs/`.

## Standard OIDC Endpoints

| Endpoint | Description |
| :--- | :--- |
| `GET /.well-known/openid-configuration` | OIDC Discovery document |
| `GET /.well-known/jwks.json` | Public RS256 JWK Set |
| `GET /oauth/authorize` | Authorization Code + PKCE (`S256`) |
| `POST /oauth/token` | Token exchange, Refresh Token, and RFC 8628 Device Code exchange |
| `POST /oauth/device_authorization` | RFC 8628 Device Authorization Grant |
| `GET /oauth/userinfo` | Authenticated OIDC profile claims |
| `GET /oauth/logout` | End session / logout endpoint |

See [`Oauth/docs/IDP_INTEGRATION_GUIDE.md`](./docs/IDP_INTEGRATION_GUIDE.md) for full integration instructions, curl examples, and HMAC-SHA256 `user.banned` webhook verification.  
For Go developers (including beginners using `go mod init` / `go get` or offline single-file copy), see [`Oauth/docs/GO_SDK_GUIDE.md`](./docs/GO_SDK_GUIDE.md).  
For multi-site login theme customization (`PUT /api/applications/{clientId}/theme`) and AI-assisted OIDC integration prompts, see [`Oauth/docs/AI_INTEGRATION_PROMPT.md`](./docs/AI_INTEGRATION_PROMPT.md).

## Local Sandbox Testing

```bash
docker compose -f dev/docker-compose.dev.yml up --build
```
