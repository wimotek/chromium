#!/usr/bin/env python3
"""OpenClaw helper CLI for Chromium Sync Hub (single-user & multi-tenant SaaS)."""

import argparse
import json
import os
import random
import ssl
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional


RR_STATE_FILE = Path(os.environ.get("CHROMIUM_HUB_RR_STATE", "/tmp/.chromium_hub_rr.json"))


def _get_env_config() -> Dict[str, Any]:
    hub_url = (os.environ.get("CHROMIUM_HUB_URL") or "").strip().rstrip("/")
    api_key = (os.environ.get("CHROMIUM_HUB_API_KEY") or "").strip()
    insecure = (os.environ.get("CHROMIUM_HUB_INSECURE") or "").strip().lower() in {"1", "true", "yes"}
    if not hub_url:
        raise SystemExit("Missing env CHROMIUM_HUB_URL (e.g. https://hub.example.com)")
    if not api_key:
        raise SystemExit("Missing env CHROMIUM_HUB_API_KEY")
    return {"hub_url": hub_url, "api_key": api_key, "insecure": insecure}


def _ssl_context(insecure: bool) -> Optional[ssl.SSLContext]:
    if not insecure:
        return None
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _http_json(
    method: str,
    url: str,
    api_key: str,
    insecure: bool = False,
    payload: Optional[Dict[str, Any]] = None,
    timeout: int = 15,
) -> Any:
    headers = {
        "X-API-Key": api_key,
        "Accept": "application/json",
    }
    data_bytes = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    req = urllib.request.Request(url, data=data_bytes, headers=headers, method=method.upper())
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_ssl_context(insecure)) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as he:
        body = he.read().decode("utf-8", errors="replace")
        raise SystemExit(f"HTTP {he.code} calling {url}: {body}")
    except urllib.error.URLError as ue:
        raise SystemExit(f"Request failed calling {url}: {ue.reason}")


def fetch_nodes(cfg: Dict[str, Any], scope: str = "all", online_only: bool = True) -> List[Dict[str, Any]]:
    query = urllib.parse.urlencode(
        {
            "online_only": "true" if online_only else "false",
            "scope": scope,
        }
    )
    url = f"{cfg['hub_url']}/api/v1/nodes?{query}"
    data = _http_json("GET", url, cfg["api_key"], insecure=cfg["insecure"])
    return data.get("nodes", [])


def pick_node(nodes: List[Dict[str, Any]], strategy: str, scope: str) -> Dict[str, Any]:
    if not nodes:
        raise SystemExit(f"No matching online nodes found for scope={scope}")
    if strategy == "random":
        return random.choice(nodes)

    idx = 0
    if RR_STATE_FILE.exists():
        try:
            state = json.loads(RR_STATE_FILE.read_text(encoding="utf-8"))
            idx = int(state.get(scope, 0))
        except Exception:
            idx = 0

    chosen = nodes[idx % len(nodes)]
    try:
        existing = json.loads(RR_STATE_FILE.read_text(encoding="utf-8")) if RR_STATE_FILE.exists() else {}
    except Exception:
        existing = {}
    existing[scope] = (idx + 1) % max(1, len(nodes))
    RR_STATE_FILE.write_text(json.dumps(existing), encoding="utf-8")
    return chosen


def normalize_playwright_cookies(raw_items: Any) -> List[Dict[str, Any]]:
    if isinstance(raw_items, dict):
        raw_items = raw_items.get("cookies", [])
    if not isinstance(raw_items, list):
        return []
    out: List[Dict[str, Any]] = []
    for c in raw_items:
        if not isinstance(c, dict):
            continue
        name = c.get("name")
        value = c.get("value")
        domain = c.get("domain")
        if not name or value is None or not domain:
            continue
        item: Dict[str, Any] = {
            "name": str(name),
            "value": str(value),
            "domain": str(domain),
            "path": str(c.get("path") or "/"),
            "secure": bool(c.get("secure", False)),
            "httpOnly": bool(c.get("httpOnly", False)),
        }
        if c.get("expires") and isinstance(c.get("expires"), (int, float)) and float(c["expires"]) > 0:
            item["expires"] = float(c["expires"])
        same_site = str(c.get("sameSite") or "").strip()
        if same_site in {"Strict", "Lax", "None"}:
            item["sameSite"] = same_site
        out.append(item)
    return out


def cmd_list(args: argparse.Namespace) -> None:
    cfg = _get_env_config()
    nodes = fetch_nodes(cfg, scope=args.scope, online_only=args.online_only)
    summary = [
        {
            "id": n["id"],
            "name": n["name"],
            "access_role": n.get("access_role", "owner"),
            "status": n.get("status"),
            "conn_type": n.get("conn_type"),
            "preferred_cdp_url": n.get("preferred_cdp_url"),
            "cdp_http_base": n.get("cdp_http_base"),
        }
        for n in nodes
    ]
    print(json.dumps({"total": len(summary), "scope": args.scope, "nodes": summary}, ensure_ascii=False, indent=2))


def cmd_pick(args: argparse.Namespace) -> None:
    cfg = _get_env_config()
    nodes = fetch_nodes(cfg, scope=args.scope, online_only=True)
    node = pick_node(nodes, strategy=args.strategy, scope=args.scope)
    target_url = node["cdp_http_base"] if args.url_type == "http" and node.get("cdp_http_base") else node["preferred_cdp_url"]

    bound = False
    if args.bind_profile:
        res = subprocess.run(
            ["openclaw", "browser", "create-profile", "--name", args.bind_profile, "--cdp-url", target_url],
            capture_output=True,
            text=True,
        )
        if res.returncode != 0:
            raise SystemExit(f"openclaw browser create-profile failed: {res.stderr.strip() or res.stdout.strip()}")
        bound = True

    print(
        json.dumps(
            {
                "node_id": node["id"],
                "name": node["name"],
                "access_role": node.get("access_role", "owner"),
                "strategy": args.strategy,
                "cdp_ws_url": node["preferred_cdp_url"],
                "cdp_http_base": node.get("cdp_http_base"),
                "bound_profile": args.bind_profile if bound else None,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def cmd_cookies(args: argparse.Namespace) -> None:
    cfg = _get_env_config()
    if args.action == "export":
        data = _http_json(
            "GET",
            f"{cfg['hub_url']}/api/v1/nodes/{args.node_id}/cookies",
            cfg["api_key"],
            insecure=cfg["insecure"],
        )
        if args.out:
            Path(args.out).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps({"status": "ok", "saved_to": args.out, "total_cookies": data.get("total_cookies", 0)}))
        else:
            print(json.dumps(data, ensure_ascii=False, indent=2))
    elif args.action == "import":
        raw = json.loads(Path(args.infile).read_text(encoding="utf-8"))
        cookies = raw.get("cookies", []) if isinstance(raw, dict) else raw
        res = _http_json(
            "POST",
            f"{cfg['hub_url']}/api/v1/nodes/{args.node_id}/cookies",
            cfg["api_key"],
            insecure=cfg["insecure"],
            payload={"cookies": cookies},
        )
        print(json.dumps(res, ensure_ascii=False, indent=2))


def cmd_sync(_: argparse.Namespace) -> None:
    cfg = _get_env_config()
    res = _http_json("POST", f"{cfg['hub_url']}/api/v1/sync", cfg["api_key"], insecure=cfg["insecure"])
    print(json.dumps(res, ensure_ascii=False, indent=2))


def cmd_crawl(args: argparse.Namespace) -> None:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise SystemExit(
            f"Playwright is required for 'crawl' ({exc}). Install via: pip install playwright"
        )

    cfg = _get_env_config()
    nodes = fetch_nodes(cfg, scope=args.scope, online_only=True)
    if args.strategy == "random":
        random.shuffle(nodes)
    else:
        first = pick_node(nodes, strategy="round-robin", scope=args.scope)
        nodes = [first] + [n for n in nodes if n["id"] != first["id"]]

    pw_cookies: List[Dict[str, Any]] = []
    if args.mode == "cookie":
        if args.cookie_file:
            raw = json.loads(Path(args.cookie_file).read_text(encoding="utf-8"))
            pw_cookies = normalize_playwright_cookies(raw)
        elif args.cookie_source_node:
            raw = _http_json(
                "GET",
                f"{cfg['hub_url']}/api/v1/nodes/{args.cookie_source_node}/cookies",
                cfg["api_key"],
                insecure=cfg["insecure"],
            )
            pw_cookies = normalize_playwright_cookies(raw)
        else:
            raise SystemExit("--mode cookie requires either --cookie-file or --cookie-source-node")

    last_err = None
    with sync_playwright() as p:
        for node in nodes:
            cdp_ws = node["preferred_cdp_url"]
            try:
                browser = p.chromium.connect_over_cdp(cdp_ws, timeout=args.timeout_ms)
                # Always isolate via browser.new_context() so anonymous tasks stay clean and
                # cookie-authenticated tasks never leak into leased/host default profiles.
                context = browser.new_context()
                try:
                    if pw_cookies:
                        context.add_cookies(pw_cookies)
                    page = context.new_page()
                    page.goto(args.url, wait_until=args.wait_until, timeout=args.timeout_ms)
                    if args.wait_ms > 0:
                        page.wait_for_timeout(args.wait_ms)
                    title = page.title()
                    final_url = page.url
                    text_content = page.inner_text("body")[: args.max_chars]
                    if args.save_state:
                        state = context.storage_state()
                        Path(args.save_state).write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
                    out = {
                        "status": "ok",
                        "mode": args.mode,
                        "node_id": node["id"],
                        "node_name": node["name"],
                        "access_role": node.get("access_role", "owner"),
                        "injected_cookies": len(pw_cookies),
                        "title": title,
                        "final_url": final_url,
                        "text_excerpt": text_content,
                    }
                    print(json.dumps(out, ensure_ascii=False, indent=2))
                    return
                finally:
                    context.close()
                    browser.close()
            except Exception as exc:
                last_err = f"Node#{node['id']}: {exc}"
                continue

    raise SystemExit(f"All candidate nodes failed ({last_err})")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Chromium CDP Hub CLI for OpenClaw")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_list = sub.add_parser("list", help="List visible nodes")
    p_list.add_argument("--scope", choices=["all", "owned", "leased"], default=os.environ.get("CHROMIUM_HUB_SCOPE", "all"))
    p_list.add_argument("--online-only", action="store_true", default=True)
    p_list.add_argument("--include-offline", dest="online_only", action="store_false")
    p_list.set_defaults(func=cmd_list)

    p_pick = sub.add_parser("pick", help="Pick an online node (random or round-robin) and optionally bind OpenClaw profile")
    p_pick.add_argument("--scope", choices=["all", "owned", "leased"], default=os.environ.get("CHROMIUM_HUB_SCOPE", "all"))
    p_pick.add_argument("--strategy", choices=["random", "round-robin"], default="random")
    p_pick.add_argument("--url-type", choices=["ws", "http"], default="ws")
    p_pick.add_argument("--bind-profile", default="", help="Optional OpenClaw browser profile name to update")
    p_pick.set_defaults(func=cmd_pick)

    p_cookies = sub.add_parser("cookies", help="Export or import cookies on an owned idle node")
    p_cookies.add_argument("action", choices=["export", "import"])
    p_cookies.add_argument("--node-id", type=int, required=True)
    p_cookies.add_argument("--out", default="", help="Output JSON path for export")
    p_cookies.add_argument("--in", dest="infile", default="", help="Input JSON path for import")
    p_cookies.set_defaults(func=cmd_cookies)

    p_sync = sub.add_parser("sync", help="Trigger Hub cookie sync policies")
    p_sync.set_defaults(func=cmd_sync)

    p_crawl = sub.add_parser("crawl", help="Run isolated anonymous or cookie-authenticated web scrape")
    p_crawl.add_argument("--url", required=True)
    p_crawl.add_argument("--mode", choices=["anon", "cookie"], default="anon")
    p_crawl.add_argument("--scope", choices=["all", "owned", "leased"], default=os.environ.get("CHROMIUM_HUB_SCOPE", "all"))
    p_crawl.add_argument("--strategy", choices=["random", "round-robin"], default="random")
    p_crawl.add_argument("--cookie-file", default="", help="Local cookies.json or Playwright storage_state.json")
    p_crawl.add_argument("--cookie-source-node", type=int, default=0, help="Owned idle node ID to fetch cookies from")
    p_crawl.add_argument("--save-state", default="", help="Save refreshed Playwright storage_state JSON here")
    p_crawl.add_argument("--wait-until", choices=["load", "domcontentloaded", "networkidle"], default="domcontentloaded")
    p_crawl.add_argument("--wait-ms", type=int, default=1500)
    p_crawl.add_argument("--timeout-ms", type=int, default=30000)
    p_crawl.add_argument("--max-chars", type=int, default=4000)
    p_crawl.set_defaults(func=cmd_crawl)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
