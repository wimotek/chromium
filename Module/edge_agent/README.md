# edge_agent commercial module

Commercial-grade edge agent with explicit access policy, TOFU quarantine,
Edge Agent token verification, session fast re-auth, and NAT4 reverse tunnel.

## Table of contents

- [Design goals](#design-goals)
- [Architecture](#architecture)
- [Decision matrix](#decision-matrix)
- [Install](#install)
- [Environment variables](#environment-variables)
- [CLI usage](#cli-usage)
- [Programmatic usage](#programmatic-usage)
- [Reverse tunnel / NAT4](#reverse-tunnel--nat4)
- [Audit log](#audit-log)
- [Security model](#security-model)
- [Commercial deployment checklist](#commercial-deployment-checklist)
- [Publishing](#publishing)
- [License](#license)

## Design goals

1. **Local connections default allow**, gated by a `local_bypass_token`
   written with mode `0600`, so other processes on the same host cannot
   trivially reuse `127.0.0.1`.
2. **External connections default TOFU**. A node without a token is
   placed in a quarantine that only exchanges heartbeats. No business
   data is relayed until an administrator approves the node.
3. **External connections with token use Edge Agent mode**. The token is
   verified for signature, TTL, audience, issuer, `node_uuid` binding,
   optional source IP CIDR binding, and single-use replay protection.
4. **NAT4 / no public IP uses reverse tunnel**. Authentication strength
   does not downgrade when the network profile is `nat4_reverse`.
5. **Trusted nodes re-auth with short-lived session tickets**. A trusted
   node without token or session is denied, preventing downgrade to TOFU.

## Architecture

```text
                 +---------------------------+
   loopback ---> |  AccessPolicyEngine       | ---> ALLOW_LOCAL
                 |  (single decision point)  |
   external ---> |                           | ---> ALLOW_TOKEN
   + token       |  1. local bypass token    |
                 |  2. join token verify     | ---> ALLOW_SESSION
   external ---> |  3. session ticket        |
   no token      |  4. TOFU pending          | ---> PENDING_TOFU
                 |  5. revoked / mismatch    |
   nat4_rev ---> |                           | ---> DENY
                 +---------------------------+
                              |
                              v
                    +-------------------+
                    | TrustStore        |
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
| direct | no | invalid | - | any | `DENY` |
| direct | no | - | valid | trusted | `ALLOW_SESSION` |
| direct | no | - | - | trusted | `DENY` (no downgrade) |
| direct | no | - | - | pending, same fp | `PENDING_TOFU` |
| direct | no | - | - | pending, diff fp | `DENY` |
| direct | no | - | - | none | `PENDING_TOFU` |
| direct | no | - | - | revoked | `DENY` |
| nat4_reverse | no | valid | - | any | `ALLOW_TOKEN` |
| nat4_reverse | no | - | - | none | `PENDING_TOFU` |

## Install

```bash
pip install edge-agent-commercial
```

From source:

```bash
git clone https://github.com/yourorg/edge-agent.git
cd edge-agent
pip install -e ".[dev]"
```

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `EDGE_AGENT_DATA_DIR` | no | `./edge_agent_data` | Data directory for trust DB, audit log, local bypass token |
| `EDGE_AGENT_TOKEN_SECRET` | yes | - | HMAC secret, >= 32 bytes |
| `EDGE_AGENT_TOKEN_AUDIENCE` | no | `edge-agent` | Token audience |
| `EDGE_AGENT_TOKEN_ISSUER` | no | `central` | Token issuer |
| `EDGE_AGENT_TOKEN_MAX_TTL_SECONDS` | no | `600` | Max token TTL |
| `EDGE_AGENT_SESSION_TICKET_TTL_SECONDS` | no | `300` | Session ticket TTL |
| `EDGE_AGENT_TOFU_HEARTBEAT_SECONDS` | no | `10` | TOFU quarantine heartbeat interval |
| `EDGE_AGENT_REQUIRE_LOCAL_BYPASS_TOKEN` | no | `true` | Require local bypass token for loopback |
| `EDGE_AGENT_REVERSE_TUNNEL` | no | auto | `true` / `false` / unset |
| `EDGE_AGENT_NAT_TYPE` | no | `unknown` | `nat4`, `symmetric`, etc. |
| `EDGE_AGENT_NODE_UUID` | reverse only | - | Agent node UUID |
| `EDGE_AGENT_PUBLIC_KEY_FINGERPRINT` | reverse only | - | Agent public key fingerprint |
| `EDGE_AGENT_JOIN_TOKEN` | reverse only | - | Join token for Edge Agent mode |
| `EDGE_AGENT_TLS_SERVER_NAME` | no | - | TLS SNI |
| `EDGE_AGENT_CERTIFICATE_PIN_SHA256` | no | - | TLS certificate pin |

Generate a secret:

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

## CLI usage

Start a direct TLS JSON-line server:

```bash
edge-agent listen --host 0.0.0.0 --port 8443 \
  --cert /path/server.crt --key /path/server.key
```

Approve a pending TOFU node (admin, out-of-band):

```bash
edge-agent approve --node-uuid node-xxx --fingerprint sha256:...
```

Revoke a trusted node:

```bash
edge-agent revoke --node-uuid node-xxx
```

Show a node record:

```bash
edge-agent show-node --node-uuid node-xxx
```

Issue a single-use Edge Agent join token:

```bash
edge-agent issue-token \
  --node-group group-a \
  --ttl 300 \
  --node-uuid node-xxx \
  --allowed-ip-cidr 203.0.113.0/24
```

## Programmatic usage

```python
import asyncio
from edge_agent import Config, EdgeAgent

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
            __import__("edge_agent.transport", fromlist=["JsonLineTransport"]).JsonLineTransport(r, w),
            w.get_extra_info("peername")[0],
        ),
        host="0.0.0.0",
        port=8443,
    )
    async with server:
        await server.serve_forever()

asyncio.run(main())
```

## Reverse tunnel / NAT4

`transport.TunnelDialer` is a protocol. Implement it with your existing
WebSocket stack, then call:

```python
await agent.run_reverse_tunnel(
    url="wss://central.example.com/tunnel",
    dialer=your_dialer,
    ssl_context=ssl_context,
    server_hostname="central.example.com",
)
```

The reverse tunnel:

- uses TLS and supports certificate pinning via
  `EDGE_AGENT_CERTIFICATE_PIN_SHA256`;
- sends the same handshake fields as direct mode (`node_uuid`,
  `public_key_fingerprint`, `join_token`, `nat_type`, `reverse_tunnel`);
- keeps waiting on `pending_tofu` until the central side sends
  `approved` or `denied`;
- applies exponential backoff on reconnect.

Authentication is performed by the central side using the same
`AccessPolicyEngine`. The network profile is `nat4_reverse`; the auth
strength is identical to direct mode.

## Audit log

Every `AccessDecision` is written to `EDGE_AGENT_DATA_DIR/audit.jsonl`:

```json
{"ts":"2026-11-06T12:00:00+00:00","event":"access_decision","node_uuid":"node-xxx","source_ip":"203.0.113.10","is_loopback":false,"decision":"allow_token","reason":"edge_agent_token_verified","network_profile":"direct","nat_type":"unknown","fingerprint":"sha256:...","node_status":"trusted"}
```

Ship this file to your central log platform (Loki, ELK, CloudWatch, etc.).
Do not store the raw join token in the audit log; only record the decision.

## Security model

- **Token secret**: >= 32 bytes. Rotate by restarting with a new secret;
  old tokens become invalid immediately.
- **Token single use**: `jti` is stored in `used_tokens` until `exp`.
- **Token binding**: optional `node_uuid` and `allowed_ip_cidr`.
- **TOFU quarantine**: pending nodes exchange heartbeat only. No data
  relay, no business messages.
- **Fingerprint mismatch**: pending node presenting a different
  fingerprint is denied; trusted node presenting a different fingerprint
  is denied.
- **No downgrade**: trusted node without token or session is denied.
- **Local bypass**: `local_bypass.token` is written with mode `0600`.
  Set `EDGE_AGENT_REQUIRE_LOCAL_BYPASS_TOKEN=false` only if you fully
  trust every process on the host.
- **TLS pinning**: optional SHA-256 pin of the peer certificate.
- **Audit**: every decision is logged. Revocation is immediate on the
  next handshake.

## Commercial deployment checklist

- [ ] Rotate `EDGE_AGENT_TOKEN_SECRET` per environment.
- [ ] Store `EDGE_AGENT_DATA_DIR` on persistent, encrypted storage.
- [ ] Ship `audit.jsonl` to central logging with retention policy.
- [ ] Enable TLS with a valid certificate; set
      `EDGE_AGENT_CERTIFICATE_PIN_SHA256` for reverse tunnel.
- [ ] Restrict `edge-agent approve` to an admin-only host or CI job.
- [ ] Monitor `tofu_pending_queue_size`, `token_replay_rejections`,
      `reverse_tunnel_reconnect_count`.
- [ ] Run `edge-agent revoke` on node decommission.
- [ ] Back up `trust_store.sqlite3` before upgrades.
- [ ] Pin Python and Node versions in CI.
- [ ] Publish PyPI and npm from tagged releases only.

## Publishing

PyPI:

```bash
python -m build
python -m twine check dist/*
python -m twine upload dist/*
```

npm (CLI wrapper):

```bash
cd npm
npm pack --dry-run
npm publish --access public
```

## License

MIT. See `LICENSE`.