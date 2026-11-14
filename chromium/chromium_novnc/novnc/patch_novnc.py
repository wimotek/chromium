#!/usr/bin/env python3
"""Inject Wimotek clipboard-sync.js into noVNC vnc.html cleanly."""

from pathlib import Path
import sys

VNC_HTML = Path("/opt/novnc/vnc.html")
SCRIPT_TAG = '<script type="module" src="app/clipboard-sync.js"></script>'


def main() -> int:
    if not VNC_HTML.exists():
        print(f"ERROR: {VNC_HTML} not found", file=sys.stderr)
        return 1

    content = VNC_HTML.read_text(encoding="utf-8")
    if "app/clipboard-sync.js" in content:
        print("clipboard-sync.js already referenced in vnc.html")
        return 0

    if "</body>" not in content:
        print("ERROR: </body> tag not found in vnc.html", file=sys.stderr)
        return 1

    patched = content.replace("</body>", f"    {SCRIPT_TAG}\n</body>", 1)
    VNC_HTML.write_text(patched, encoding="utf-8")
    print("Successfully injected clipboard-sync.js into /opt/novnc/vnc.html")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
