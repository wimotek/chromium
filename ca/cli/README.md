# wimotek-cli — Enterprise PKI Client & Embedded Web Manager

Pure-Go (`CGO_ENABLED=0`) static PKI client aligned with **Smallstep (`step`) CLI**, purpose-built for `wimotek/ca` (and OpenBao / Vault PKI compatible endpoints), featuring an embedded **Web Management Console** (`wimotek-cli web`) and automated background certificate renewal.

## Key Capabilities

- **Step-Aligned CLI Grammar**: Familiar `ca`, `certificate`, `crypto`, and `context` subcommands (`bootstrap`, `root`, `health`, `token`, `certificate`, `sign`, `renew --daemon`, `revoke`, `inspect`, `verify`, `needs-renewal`, `p12`, `install`, `format`, `keypair`, `rand`).
- **Embedded Web Management Console (`wimotek-cli web`)**: Single-binary zero-dependency UI (`go:embed`) to manage multiple CA contexts, issue/renew/revoke local certificates, inspect/verify X.509 chains (including `msUPN` & Adobe/RFC9336 PDF OIDs), generate keypairs, and package Modern2023 `.pfx` bundles.
- **Zero-CGO Static Binaries**: Cross-compiles cleanly to `linux/amd64`, `linux/arm64`, `windows/amd64`, and `darwin/arm64`.
- **Security by Default**:
  - Constant-time SHA-256 Root CA fingerprint pinning on `ca bootstrap`.
  - Strict `0600` private key & credential permissions and atomic `.tmp` + rename renewal writes.
  - Web UI binds to `127.0.0.1:9443` by default, requires `--web-password` on non-loopback binds, and confines web-managed certificate files strictly inside `$WIMOTEK_PATH/certs`.

## Step CLI Alignment Reference

| Smallstep `step` Command | `wimotek-cli` Equivalent | Description |
|---|---|---|
| `step ca bootstrap --ca-url ... --fingerprint ... --install` | `wimotek-cli ca bootstrap --ca-url ... --fingerprint ... --install` | Fetch Root CA, pin SHA-256, save context & trust in OS store |
| `step ca root root.crt` | `wimotek-cli ca root root.crt` | Download Root CA PEM |
| `step ca health` | `wimotek-cli ca health` | Verify CA server health |
| `step ca token` | `wimotek-cli ca token --username admin` | Solve `wimotek/ca` offline PoW or save `wca_` provisioner token |
| `step ca certificate <cn> app.crt app.key` | `wimotek-cli ca certificate <cn> app.crt app.key --profile tls_server` | Local keygen + CSR sign + track for auto-renewal |
| `step ca sign req.csr out.crt` | `wimotek-cli ca sign req.csr out.crt` | Sign an existing CSR PEM |
| `step ca renew app.crt app.key --daemon` | `wimotek-cli ca renew app.crt app.key --daemon` | Atomic certificate renewal & background daemon |
| `step ca revoke <serial>` | `wimotek-cli ca revoke <serial>` | Revoke certificate on CA |
| `step certificate inspect app.crt` | `wimotek-cli certificate inspect app.crt [--json]` | Decode X.509 cert or CSR (incl. msUPN & PDF OIDs) |
| `step certificate verify app.crt` | `wimotek-cli certificate verify app.crt --server-name ...` | Verify chain against active Root CA |
| `step certificate needs-renewal app.crt` | `wimotek-cli certificate needs-renewal app.crt --expires-in 33%` | Exit `0` when renewal is due, `1` otherwise |
| `step certificate p12 out.pfx app.crt app.key` | `wimotek-cli certificate p12 out.pfx app.crt app.key` | Modern2023 PKCS#12 `.pfx` bundle |
| `step certificate install root.crt` | `wimotek-cli certificate install` | Install Root CA into Linux / macOS / Windows trust store |
| `step crypto keypair pub.pem priv.pem` | `wimotek-cli crypto keypair pub.pem priv.pem --kty EC` | Generate ECDSA / Ed25519 / RSA keypair |
| `step context list / select` | `wimotek-cli context list / select` | Manage multiple CA contexts |
| *(Extra)* | `wimotek-cli web --listen 127.0.0.1:9443` | Embedded Web Management Console + Auto-Renew Daemon |

## Quick Start

```bash
# Build static binary (zero CGO)
CGO_ENABLED=0 go build -o wimotek-cli ./cmd/wimotek-cli

# 1. Bootstrap against your wimotek/ca server
./wimotek-cli ca bootstrap \
  --ca-url https://ca.company.internal:8443 \
  --fingerprint <ROOT_CA_SHA256> \
  --token wca_your_provisioner_token \
  --install

# 2. Issue a TLS server certificate
./wimotek-cli ca certificate app.corp.internal app.crt app.key \
  --profile tls_server --san app.corp.internal --san 10.0.1.25

# 3. Launch the embedded Web Management Console + background renewal daemon
./wimotek-cli web --listen 127.0.0.1:9443
```

## Environment Variables (Optional Defaults)

| Variable | Default | Description |
|---|---|---|
| `WIMOTEK_PATH` | `~/.wimotek` | Storage directory for contexts, Root CA PEMs, and managed certificates |
| `WIMOTEK_CLI_LISTEN` | `127.0.0.1:9443` | Listen address for `wimotek-cli web` |
| `WIMOTEK_CLI_WEB_PASSWORD` | *(empty)* | Password protecting Web UI & APIs (**required** when binding to `0.0.0.0` or non-loopback IP) |
| `WIMOTEK_PASSWORD` | *(empty)* | Optional password input for `wimotek-cli ca token --username ...` |
