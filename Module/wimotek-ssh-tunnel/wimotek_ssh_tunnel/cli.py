"""
CLI runner for wimotek-ssh-tunnel Python package.
"""

import sys
import json
from .models import SshHostConfig
from .sync import CdpSyncEngine
from .logger import default_logger

def main():
    args = sys.argv[1:]
    command = args[0] if args else "help"

    if command in ("help", "--help", "-h"):
        print("""
wimotek-ssh-tunnel (Python Edition) - Resilient CDP Target Sync & SSH Tunnel Engine

Usage:
  wimotek-ssh-tunnel sync [--config nodes.json] [--timeout 4000]
  wimotek-ssh-tunnel modes
  wimotek-ssh-tunnel help

CDP Hub 4 Connection Modes:
  1. Direct (直连)         Direct HTTP/WS to target port (192.168.1.100:9222)
  2. WSS Direct (wss直连)  Direct TLS WebSocket to secure gateway
  3. WSS Reverse (wss反穿) Edge client initiates outbound WebSocket to Hub
  4. SSH Tunnel (ssh穿透)  Managed by wimotek-ssh-tunnel with resilient skip
""")
        sys.exit(0)

    if command == "modes":
        print("""
========================================================================
   CDP HUB 4 CONNECTION MODES
========================================================================
1. Direct (直连)       : Local / trusted LAN. Direct port access.
2. WSS Direct (wss直连): Remote TLS gateway with SSL certificates.
3. WSS Reverse (wss反穿): Edge devices behind NAT dial outbound to Hub.
4. SSH Tunnel (ssh穿透): Encrypted SSH port forward with resilient skip.
========================================================================
""")
        sys.exit(0)

    # Demo execution
    sample_nodes = [
        SshHostConfig(id="node-1", name="Healthy Edge Node", host="10.0.1.15", port=22),
        SshHostConfig(id="node-fault", name="Offline Fault Node", host="192.0.2.1", port=22),
    ]

    engine = CdpSyncEngine(default_logger)
    result = engine.sync_all(sample_nodes, timeout_ms=2000, skip_on_failure=True)
    print("\n--- Summary ---")
    print(result.summary_message)
    print(f"Synced: {result.successful_nodes}/{result.total_nodes}, Skipped: {result.failed_nodes}")

if __name__ == "__main__":
    main()
