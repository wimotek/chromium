#!/usr/bin/env python3
"""Inject Wimotek clipboard-sync.js and cache-busting tags into noVNC vnc.html."""

import os
from pathlib import Path
import re
import sys

VNC_HTML = Path("/opt/novnc/vnc.html")
NOVNC_VER = os.getenv("NOVNC_VER", "1.5.0")
CACHE_META = (
    '<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">\n'
    '    <meta http-equiv="Pragma" content="no-cache">\n'
    '    <meta http-equiv="Expires" content="0">'
)
SCRIPT_TAG = f'<script type="module" src="app/clipboard-sync.js?v={NOVNC_VER}"></script>'


def main() -> int:
    if not VNC_HTML.exists():
        print(f"ERROR: {VNC_HTML} not found", file=sys.stderr)
        return 1

    content = VNC_HTML.read_text(encoding="utf-8")

    # 1. Prevent stale browser caching of vnc.html / index.html across noVNC upgrades
    if "Cache-Control" not in content and "<head>" in content:
        content = content.replace("<head>", f"<head>\n    {CACHE_META}", 1)

    # 2. Add version query string to noVNC local assets in vnc.html so old cached JS/CSS never mixes with new HTML
    def _append_ver(match: re.Match[str]) -> str:
        prefix, url, quote = match.group(1), match.group(2), match.group(3)
        if "?" in url:
            return match.group(0)
        return f"{prefix}{url}?v={NOVNC_VER}{quote}"

    content = re.sub(
        r'((?:src|href)=["\'])(app/(?:ui\.js|styles/[^"\']+\.css))(["\'])',
        _append_ver,
        content,
    )

    # 3. Inject Wimotek bidirectional clipboard auto-sync bridge
    if "app/clipboard-sync.js" not in content:
        if "</body>" not in content:
            print("ERROR: </body> tag not found in vnc.html", file=sys.stderr)
            return 1
        content = content.replace("</body>", f"    {SCRIPT_TAG}\n</body>", 1)

    VNC_HTML.write_text(content, encoding="utf-8")
    print(f"Successfully patched /opt/novnc/vnc.html (v={NOVNC_VER})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
