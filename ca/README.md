# Wimotek PKI Suite (`ca/ca` + `ca/cli`)

An enterprise-grade, zero-configuration, single-binary PKI platform designed for small & mid-size organizations — combining a lightweight **Certificate Authority Server** (`ca/ca`) and a **Smallstep (`step`) aligned PKI Client with Embedded Web Manager** (`ca/cli`).

## Repository Layout

```text
ca/
├── ca/          # Enterprise Lightweight CA Server (Go 1.24, CGO_ENABLED=0, SQLite/MySQL, Hybrid Redis/SQL Cache, Embedded React UI)
└── cli/         # Step-aligned PKI Client + Embedded Web Management Console (Go 1.24, CGO_ENABLED=0, Auto-Renewal Daemon)
```

## Docker Images (Docker Hub & GHCR — unified `ca` repository)

Both the CA Server and the CLI Client are published to the same `ca` repository via GitHub Actions (`publish_ca.yml`):

| Component | Docker Hub / GHCR Tag | Quick Start |
|---|---|---|
| **CA Server** | `ca:latest` (`ca:<version>`) | `docker run -d --name wimotek-ca -p 8443:8443 -v ca_data:/data -v /path/certs:/certs:ro <owner>/ca:latest` |
| **CLI Client + Web Manager** | `ca:cli` (`ca:cli-<version>`) | `docker run -d --name wimotek-cli -p 9443:9443 -e WIMOTEK_CLI_WEB_PASSWORD=change-me -v cli_data:/data <owner>/ca:cli` |

## Architecture Highlights

- **Pure Go 1.24 Static Binaries (`CGO_ENABLED=0`)**: Both `wimotek-ca` and `wimotek-cli` cross-compile cleanly for `linux/amd64`, `linux/arm64`, `windows/amd64`, and `darwin/arm64` with all frontend assets, SQL schemas, and i18n JSON embedded directly in the binary.
- **Server (`ca/ca`)**:
  - Automatic two-tier ECDSA P-256 PKI (`Root CA → Issuing CA`) with RFC 5280 128-bit CSPRNG serials.
  - Dual SQLite (WAL write/read split) & MySQL support with `Store.WithTx` retry protection and `HybridCache` (Redis + automatic SQL fallback).
  - 8 built-in profiles (`tls_server`, `tls_client`, `entra_cba` with `msUPN`, `pdf_signing` with Adobe/RFC9336/MS OIDs, `code_signing`, `smime_email`, `wifi_eap`, `iot_device`), OpenBao/Vault `/v1/pki/*` compatibility, expiry notification channels, and 5-language RTL-ready UI (`en`, `zh-CN`, `ja`, `de`, `ar`).
  - Data persisted under `/data`; optional TLS certificates mounted read-only at `/certs:ro` (automatic self-signed fallback if omitted). Non-root container (`UID 10001`).
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

See [ca/ca/README.md](./ca/README.md) and [ca/cli/README.md](./cli/README.md) for detailed configuration, Docker Compose examples, and optional environment variables.
