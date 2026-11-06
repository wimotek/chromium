# Wimotek Edge Agent

Commercial-grade edge access control, service bridge, and tunnel agent featuring a 3-layer decision policy engine, TOFU quarantine, single-use HMAC token verification, session fast re-auth, and NAT4 reverse tunneling.

## Table of contents

- [Design goals](#design-goals)
- [Architecture](#architecture)
- [Decision matrix](#decision-matrix)
- [Installation & Quickstart](#installation--quickstart)
- [Environment variables](#environment-variables)
- [CLI usage](#cli-usage)
- [Programmatic usage](#programmatic-usage)
- [Reverse tunnel / NAT4](#reverse-tunnel--nat4)
- [Audit log](#audit-log)
- [Security model](#security-model)
- [Commercial deployment checklist](#commercial-deployment-checklist)
- [License](#license)

## Design goals

1. **Local connections default allow**, gated by `local_bypass_token` (mode `0600`), preventing unauthorized local processes from abusing `127.0.0.1`.
2. **External connections default TOFU**. Unauthenticated nodes are quarantined to heartbeats only. No business data is relayed until approved by an administrator.
3. **External connections with token use Edge Agent mode**. Single-use HMAC-SHA256 tokens verify signature, TTL, audience, issuer, optional node UUID, IP CIDR binding, and replay prevention.
4. **NAT4 / no public IP uses reverse tunnel**. Authentication strength remains identical under `nat4_reverse` network profiles.
5. **Trusted nodes re-auth with short-lived session tickets**. Trusted nodes without token or session are denied, strictly preventing downgrade attacks to TOFU.

## Architecture

```text
                 +---------------------------+
   loopback ---> |  AccessPolicyEngine       | ---> ALLOW_LOCAL
                 |  (Single Decision Point)  |
   external ---> |                           | ---> ALLOW_TOKEN
   + token       |  1. Local bypass token    |
                 |  2. Join token verify     | ---> ALLOW_SESSION
   external ---> |  3. Session ticket        |
   no token      |  4. TOFU quarantine       | ---> PENDING_TOFU
                 |  5. Revoked / mismatch    |
   nat4_rev ---> |                           | ---> DENY
                 +---------------------------+
                               |
                               v
                     +-------------------+
                     | TrustStore        |
                     | SQLite WAL        |
                     | pending/trusted/  |
                     | revoked + jti     |
                     +-------------------+
                               |
                               v
                     +-------------------+
                     | AuditLogger       |
                     | JSON Lines        |
                     +-------------------+
```

## Decision matrix

| Source | Loopback | Join token | Session ticket | Existing trust | Decision |
|--------|----------|------------|----------------|----------------|----------|
| direct | yes | - | - | any | `ALLOW_LOCAL` if bypass token ok, else `DENY` |
| direct | no | valid | - | any | `ALLOW_TOKEN`, bind trust |
| direct | no | invalid/replay | - | any | `DENY` |
| direct | no | - | valid | trusted | `ALLOW_SESSION` |
| direct | no | - | - | trusted | `DENY` (no downgrade to TOFU) |
| direct | no | - | - | pending, same fp | `PENDING_TOFU` (heartbeat only) |
| direct | no | - | - | pending, diff fp | `DENY` (fingerprint tamper prevention) |
| direct | no | - | - | none | `PENDING_TOFU` (quarantine) |
| direct | no | - | - | revoked | `DENY` |
| nat4_reverse | no | valid | - | any | `ALLOW_TOKEN` |
| nat4_reverse | no | - | - | none | `PENDING_TOFU` |

## Installation & Quickstart

### Python Package

```bash
pip install wimotek-edge-agent
```

From source:

```bash
git clone https://github.com/wimotek/wimotek-edge-agent.git
cd wimotek-edge-agent
pip install -e .
```

### Node.js CLI Runner

```bash
npm install -g wimotek-edge-agent
# or directly execute:
npx wimotek-edge-agent --help
```

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `EDGE_AGENT_DATA_DIR` | no | `./edge_agent_data` | Persistent data directory for trust DB, audit log, local bypass token |
| `EDGE_AGENT_TOKEN_SECRET` | yes | - | HMAC secret, >= 32 bytes |
| `EDGE_AGENT_TOKEN_AUDIENCE` | no | `edge-agent` | Token audience claim |
| `EDGE_AGENT_TOKEN_ISSUER` | no | `central` | Token issuer claim |
| `EDGE_AGENT_TOKEN_MAX_TTL_SECONDS` | no | `600` | Max token TTL (seconds) |
| `EDGE_AGENT_SESSION_TICKET_TTL_SECONDS` | no | `300` | Session ticket TTL (seconds) |
| `EDGE_AGENT_TOFU_HEARTBEAT_SECONDS` | no | `10` | TOFU quarantine heartbeat interval |
| `EDGE_AGENT_REQUIRE_LOCAL_BYPASS_TOKEN` | no | `true` | Require local bypass token for loopback |
| `EDGE_AGENT_REVERSE_TUNNEL` | no | auto | Force reverse tunnel (`true`/`false`) |
| `EDGE_AGENT_NAT_TYPE` | no | `unknown` | Network NAT type (`nat4`, `symmetric`, etc.) |
| `EDGE_AGENT_NODE_UUID` | reverse only | - | Agent node UUID |
| `EDGE_AGENT_PUBLIC_KEY_FINGERPRINT` | reverse only | - | Agent public key fingerprint |
| `EDGE_AGENT_JOIN_TOKEN` | reverse only | - | Join token for reverse tunnel connection |
| `EDGE_AGENT_TLS_SERVER_NAME` | no | - | TLS SNI hostname |
| `EDGE_AGENT_CERTIFICATE_PIN_SHA256` | no | - | TLS certificate SHA-256 pin |

Generate a high-entropy secret:

```bash
wimotek-edge-agent generate-secret
```

## CLI usage

Start a direct TLS / TCP JSON-line server:

```bash
wimotek-edge-agent listen --host 0.0.0.0 --port 8443 \
  --cert /path/server.crt --key /path/server.key
```

Approve a pending TOFU node (admin out-of-band verification):

```bash
wimotek-edge-agent approve --node-uuid node-xxx --fingerprint sha256:...
```

Revoke a compromised or decommissioned node:

```bash
wimotek-edge-agent revoke --node-uuid node-xxx
```

List all managed nodes in trust store:

```bash
wimotek-edge-agent list-nodes --status trusted
```

Inspect a specific node record:

```bash
wimotek-edge-agent show-node --node-uuid node-xxx
```

Issue a single-use Edge Agent join token:

```bash
wimotek-edge-agent issue-token \
  --node-group fleet-a \
  --ttl 300 \
  --node-uuid node-xxx \
  --allowed-ip-cidr 203.0.113.0/24
```

Verify a token directly:

```bash
wimotek-edge-agent verify-token --token <token_string> --source-ip 203.0.113.10
```

Read or generate the local bypass token:

```bash
wimotek-edge-agent bypass-token
```

## Programmatic usage

```python
import asyncio
from wimotek_edge_agent import Config, EdgeAgent
from wimotek_edge_agent.transport import JsonLineTransport

async def main() -> None:
    config = Config.from_env()
    agent = EdgeAgent(config)

    async def data_handler(transport, ctx):
        while True:
            msg = await transport.read_message()
            if msg.get("type") == "ping":
                await transport.write_message({"type": "pong"})

    agent.data_handler = data_handler

    server = await asyncio.start_server(
        lambda r, w: agent.handle_connection(
            JsonLineTransport(r, w),
            w.get_extra_info("peername")[0],
        ),
        host="0.0.0.0",
        port=8443,
    )
    async with server:
        await server.serve_forever()

if __name__ == "__main__":
    asyncio.run(main())
```

## Reverse tunnel / NAT4

Implement `TunnelDialer` with your WebSocket stack, then launch:

```python
await agent.run_reverse_tunnel(
    url="wss://central.example.com/tunnel",
    dialer=your_dialer,
    ssl_context=ssl_context,
    server_hostname="central.example.com",
)
```

- Sends handshake fields (`node_uuid`, `public_key_fingerprint`, `join_token`, `nat_type`, `reverse_tunnel`);
- Supports TLS pinning via `EDGE_AGENT_CERTIFICATE_PIN_SHA256`;
- Quarantines in `pending_tofu` until approved by central administrator;
- Exponential backoff on reconnection attempts.

## Audit log

Every `AccessDecision` is written to `EDGE_AGENT_DATA_DIR/audit.jsonl`:

```json
{"ts":"2026-11-06T12:00:00+00:00","event":"access_decision","node_uuid":"node-xxx","source_ip":"203.0.113.10","is_loopback":false,"decision":"allow_token","reason":"edge_agent_token_verified","network_profile":"direct","nat_type":"unknown","fingerprint":"sha256:...","node_status":"trusted"}
```

Ship this structured log file to your central logging pipeline (Loki, ELK, CloudWatch, OpenTelemetry). Raw join tokens are never logged.

## Security model

- **Token Secret**: >= 32 bytes HMAC secret.
- **Single-Use Replay Protection**: `jti` is stored in SQLite `used_tokens` until expiration. Subsequent attempts are rejected with `token replay detected`.
- **Identity & Network Binding**: Tokens can be bound to specific `node_uuid` and `allowed_ip_cidr` networks.
- **TOFU Quarantine**: Unapproved nodes only exchange heartbeats; business data relay is strictly forbidden.
- **No Downgrade**: Trusted nodes presenting without credentials cannot downgrade to TOFU.
- **Local Bypass Hardening**: `local_bypass.token` is generated with POSIX `0600` permissions.
- **Immediate Revocation**: Revoked nodes are denied on the next handshake packet across all network profiles.

## Commercial deployment checklist

- [ ] Set unique `EDGE_AGENT_TOKEN_SECRET` (>= 32 bytes) per environment.
- [ ] Mount `EDGE_AGENT_DATA_DIR` on persistent, encrypted storage.
- [ ] Verify `local_bypass.token` POSIX permissions (`0600`).
- [ ] Ship `audit.jsonl` to central security SIEM.
- [ ] Enable TLS; configure `EDGE_AGENT_CERTIFICATE_PIN_SHA256` for reverse tunnels.
- [ ] Restrict `wimotek-edge-agent approve` to admin-only bastion hosts or CI pipelines.
- [ ] Monitor `tofu_pending_queue_size` and `token_replay_rejections`.
- [ ] Execute `wimotek-edge-agent revoke` upon node decommissioning.
- [ ] Back up `trust_store.sqlite3` prior to upgrades.

## License

MIT. See `LICENSE`.