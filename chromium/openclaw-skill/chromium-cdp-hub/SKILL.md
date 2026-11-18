---
name: chromium-cdp-hub
description: Connect OpenClaw to Chromium Sync Hub (single-user or multi-tenant SaaS) to discover online browser nodes, perform random/round-robin load balancing, manage cookies on owned nodes, and run both anonymous (cookie-free) and authenticated (cookie-injected) web scraping or automation tasks.
metadata: {"openclaw":{"requires":{"bins":["python3"],"env":["CHROMIUM_HUB_URL","CHROMIUM_HUB_API_KEY"]},"primaryEnv":"CHROMIUM_HUB_API_KEY"}}
---

# Chromium CDP Hub (Distributed Browser Pool & Cookie Skill)

Use this skill when the user wants OpenClaw to run browser tasks, web scraping, or login-authenticated data collection across distributed Chromium nodes managed by `chromium_sync` or `chromium_sync_saas`.

## Required Environment

Set these before invoking `{baseDir}/scripts/hub_pool.py`:
- `CHROMIUM_HUB_URL`: Hub base URL, e.g. `https://hub.example.com` (or `https://127.0.0.1:8443`)
- `CHROMIUM_HUB_API_KEY`: Tenant or admin API-Key (`cdp_...`)
- Optional `CHROMIUM_HUB_SCOPE`: `all` (default, owned + leased nodes), `owned` (only owned nodes), or `leased` (only rented market nodes; SaaS edition only)
- Optional `CHROMIUM_HUB_INSECURE`: set `1` only for self-signed development certificates

## Core Security & Privacy Boundaries

1. **Authentication**: Send `X-API-Key: $CHROMIUM_HUB_API_KEY` (or `Authorization: Bearer $CHROMIUM_HUB_API_KEY`) on REST calls, and use `?api_key=...` on CDP URLs.
2. **Leased Nodes (`access_role == "leased_buyer"`)**:
   - NEVER call `/api/v1/nodes/{id}/cookies` on leased nodes (or on owned nodes currently rented out); the Hub enforces HTTP `403/409`.
   - NEVER use `browser.contexts[0]` on a leased node for authenticated tasks. ALWAYS create an isolated `browser.new_context()`, inject cookies into memory, extract data, optionally save `context.storage_state()`, and immediately call `context.close()`.

## Commands (`{baseDir}/scripts/hub_pool.py`)

### 1. Inspect Available Online Nodes
```bash
python3 {baseDir}/scripts/hub_pool.py list --scope all --online-only
```

### 2. Pick a Node (Random / Round-Robin) & Bind OpenClaw Browser Profile
Use this when you want OpenClaw's native `browser` tool (`open`, `snapshot`, `click`, `type`) to drive a dynamically chosen remote node:
```bash
# Random selection (both wss:// and https:// discovery URLs supported)
python3 {baseDir}/scripts/hub_pool.py pick --strategy random --scope all --bind-profile hub-pool

# Round-robin selection across the pool
python3 {baseDir}/scripts/hub_pool.py pick --strategy round-robin --scope all --bind-profile hub-pool
```
After `--bind-profile hub-pool`, control the selected browser directly with OpenClaw:
```bash
openclaw browser --browser-profile hub-pool open "https://example.com"
openclaw browser --browser-profile hub-pool snapshot
```

### 3. Workflow A — Anonymous Scraping Task (No Cookies Required)
For public pages, price monitoring, or anti-bot scraping where a clean fingerprint + rotating exit IP is desired:
- **Option A1 (OpenClaw native `browser` tool)**: Run `pick --strategy round-robin --bind-profile hub-pool`, then open/snapshot/extract with `--browser-profile hub-pool`.
- **Option A2 (Isolated Playwright runner)**: Runs `browser.new_context()` so zero cookies or local state leak into the session:
```bash
python3 {baseDir}/scripts/hub_pool.py crawl \
  --url "https://example.com" \
  --mode anon \
  --scope all \
  --strategy random
```

### 4. Workflow B — Authenticated Scraping Task (Cookies Required)
Choose the right sub-mode based on node ownership:

- **B1. Using an Owned Idle Node (`scope=owned`)**
  Export/inject cookies directly or trigger Hub sync:
  ```bash
  # Export cookies from owned node #1
  python3 {baseDir}/scripts/hub_pool.py cookies export --node-id 1 --out /tmp/auth_cookies.json

  # Inject cookies into owned idle node #2
  python3 {baseDir}/scripts/hub_pool.py cookies import --node-id 2 --in /tmp/auth_cookies.json

  # Trigger Hub cookie sync policy
  python3 {baseDir}/scripts/hub_pool.py sync
  ```
  Then either bind that node to OpenClaw (`--bind-profile`) or run `crawl --mode cookie`.

- **B2. Using a Leased Market Node (`scope=leased` / `scope=all`) with Privacy Isolation**
  Pull cookies from a local JSON file (`--cookie-file`) or an owned idle node (`--cookie-source-node`), inject them inside an isolated `browser.new_context()` on the leased node, scrape, optionally persist refreshed cookies back via `--save-state`, and close the context immediately:
  ```bash
  # Method 1: Load cookies from local auth.json / cookies.json
  python3 {baseDir}/scripts/hub_pool.py crawl \
    --url "https://target.example.com/dashboard" \
    --mode cookie \
    --cookie-file /tmp/auth_cookies.json \
    --scope leased \
    --strategy round-robin \
    --save-state /tmp/refreshed_state.json

  # Method 2: Fetch cookies from owned node #1, then run isolated on any pooled node
  python3 {baseDir}/scripts/hub_pool.py crawl \
    --url "https://target.example.com/dashboard" \
    --mode cookie \
    --cookie-source-node 1 \
    --scope all \
    --strategy random
  ```
