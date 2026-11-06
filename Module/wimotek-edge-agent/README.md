# Wimotek Edge Agent

Commercial-grade edge access control, service bridge, and tunnel agent featuring a 3-layer decision policy engine, TOFU quarantine, single-use HMAC token verification, session fast re-auth, and NAT4 reverse tunneling.

## Table of contents

- [Design goals](#design-goals)
- [Architecture](#architecture)
- [Decision matrix](#decision-matrix)
- [Installation & Quickstart](#installation--quickstart)
  - [PyPI 安装与 ModuleNotFoundError 深度排查](#pypi-安装与-modulenotfounderror-深度排查)
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

### 1. PyPI 安装与导入规则

> 📌 **关键名称区别**：
> - **PyPI 仓库包名（用于 pip 安装）**：`wimotek-edge-agent`（中划线 `-`）
> - **Python 导入包名（用于代码 import）**：`wimotek_edge_agent`（下划线 `_`）

在终端中使用当前 Python 运行环境安装：

```bash
# 推荐做法：使用当前 Python 解释器执行，避免装错环境
python -m pip install --upgrade wimotek-edge-agent
```

在 Python 代码中使用标准导入：

```python
from wimotek_edge_agent import EdgeAgent, Config, AccessPolicyEngine
```

---

### PyPI 安装与 ModuleNotFoundError 深度排查

如果在上传 PyPI 后本地执行 `from wimotek_edge_agent ...` 报 `ModuleNotFoundError: No module named 'wimotek_edge_agent'`，请按以下 4 种最常见情况逐一排查：

#### 🔴 原因 1：Python 运行环境不一致（最常见，占 80%）
- **根因分析**：
  在终端中执行的 `pip install` 将包安装到了全局 Python、系统 Python 或 Conda 的 base 环境；而你在 IDE（VS Code、PyCharm、Cursor）或者运行代码时，使用的是项目独立的虚拟环境（例如 `.venv`）。
- **一键自查命令**：
  在运行报错的代码同级终端中执行：
  ```bash
  python -c "import sys; print('当前 Python 解释器路径:', sys.executable); print('模块搜索路径:', sys.path)"
  ```
- **解决方法**：
  确保使用**执行代码的同一个 Python 解释器**进行安装：
  ```bash
  python -m pip install --upgrade wimotek-edge-agent
  ```
  如果使用了虚拟环境，先激活虚拟环境再安装：
  ```bash
  # Linux / macOS:
  source .venv/bin/activate
  python -m pip install --upgrade wimotek-edge-agent

  # Windows (PowerShell / CMD):
  .venv\Scripts\activate
  python -m pip install --upgrade wimotek-edge-agent
  ```

---

#### 🔴 原因 2：PyPI 全球 CDN 刷新延迟 或 国内镜像源未同步
- **根因分析**：
  1. 上传到 PyPI（通过 `twine upload dist/*`）后，PyPI 主站的全球 Fastly CDN 边缘节点通常需要 1~5 分钟同步刷新。
  2. 如果你的本地 pip 配置了国内镜像源（如清华源、阿里源、腾讯源），镜像源通常会有几十分钟到数小时的同步周期。如果刚上传就立刻通过镜像源安装，镜像源尚未同步，会提示找不到包或匹配不到版本。
  3. `pip` 本地存在 HTTP 缓存，可能命中了上传前的 404 记录。
- **解决方法**：
  直连 PyPI 官方源，并跳过本地缓存强制安装：
  ```bash
  python -m pip install -i https://pypi.org/simple/ --no-cache-dir --upgrade wimotek-edge-agent
  ```

---

#### 🔴 原因 3：打包时生成了“空包”（Empty Wheel 陷阱）
- **根因分析**：
  打包工具在执行 `python -m build` 或 `python setup.py bdist_wheel` 时，如果打包配置中未显式声明包路径，生成的 `.whl` 文件可能**只包含元数据 `wimotek_edge_agent-1.0.0.dist-info/`，而漏掉了 `wimotek_edge_agent/` 源码目录**。
  安装时 pip 会显示安装成功，但 `site-packages` 里其实没有代码目录，因此运行时必然报错 `ModuleNotFoundError`。
- **一键自查本地构建产物**：
  在执行打包的机器上检查生成的 `.whl` 和 `.tar.gz` 内容：
  ```bash
  # 检查 wheel 文件内容列表
  unzip -l dist/wimotek_edge_agent-*.whl

  # 或检查源码 tar 包
  tar -ztvf dist/wimotek_edge_agent-*.tar.gz
  ```
  **正常的文件列表**必须包含以下源码文件：
  ```text
  wimotek_edge_agent/__init__.py
  wimotek_edge_agent/agent.py
  wimotek_edge_agent/config.py
  wimotek_edge_agent/policy.py
  wimotek_edge_agent/trust_store.py
  ...
  wimotek_edge_agent/py.typed
  ```
  如果列表里全都是 `dist-info/` 开头的文件，而**没有** `wimotek_edge_agent/`，则说明上传的是空包！
- **彻底根治与重新发布**：
  本项目已在 `pyproject.toml` 中配置了明确的 setuptools 规则：
  ```toml
  [tool.setuptools]
  packages = ["wimotek_edge_agent"]

  [tool.setuptools.package-data]
  wimotek_edge_agent = ["py.typed"]
  ```
  并配备了 `MANIFEST.in` 与 `setup.py` 双重保障。重新打包与发布：
  ```bash
  # 1. 清理所有历史缓存构建目录
  rm -rf dist build *.egg-info

  # 2. 安装/升级标准构建工具
  python -m pip install --upgrade build twine

  # 3. 规范打包
  python -m build

  # 4. 验证 wheel 是否包含代码
  unzip -l dist/*.whl | grep "wimotek_edge_agent/__init__.py"

  # 5. 上传到 PyPI（注意修改 pyproject.toml 递增版本号，如 1.0.1）
  twine upload dist/*
  ```

---

#### 🔴 原因 4：当前工作目录文件遮蔽（Shadowing）
- **根因分析**：
  Python 会把执行命令的当前目录（`sys.path[0]`）作为最高优先级的模块搜索路径。如果当前目录下碰巧有一个名为 `wimotek_edge_agent.py` 的测试脚本，或者一个空的同名文件夹，Python 会直接加载该文件，导致无法找到内部类和函数。
- **排查验证**：
  ```bash
  python -c "import wimotek_edge_agent; print('实际加载的文件路径:', wimotek_edge_agent.__file__)"
  ```
  如果路径指向了当前临时目录而非 `site-packages`，说明发生了路径遮蔽。

---

### 2. 本地源码免上传开发（推荐）

在日常开发、测试或修改功能时，建议在本地项目根目录下使用可编辑模式（Editable Mode）直接安装，无需频繁上传 PyPI：

```bash
cd wimotek-edge-agent
pip install -e .
```

安装后，本地对 `wimotek_edge_agent/` 目录中代码的任何改动会立即反映在 Python 环境中。验证：

```bash
python -c "import wimotek_edge_agent; print('版本:', wimotek_edge_agent.__version__, '路径:', wimotek_edge_agent.__file__)"
```

---

### 3. Node.js CLI Runner

除了 Python CLI 外，还可通过 npm / npx 直接运行：

```bash
npm install -g wimotek-edge-agent
# 或者直接免安装执行：
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