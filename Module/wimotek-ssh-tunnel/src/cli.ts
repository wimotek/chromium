#!/usr/bin/env node

/**
 * CLI executable for wimotek-ssh-tunnel (NPM Edition)
 * Universal SSH Tunnel & Port Forwarding Engine
 */

import { openTunnel } from './tunnel.js';
import { TunnelException } from './types.js';

function printHelp(): void {
  console.log(`
wimotek-ssh-tunnel (NPM Edition) - Universal SSH Tunnel Engine (Default 9222 -> 19222)

Usage:
  wimotek-ssh-tunnel open --host <ssh_host> [options]
  wimotek-ssh-tunnel modes
  wimotek-ssh-tunnel --help

Options:
  --host, -h         Remote SSH host (required for open)
  --port, -p         SSH port (default: 22)
  --user, -u         SSH username (default: root)
  --remote-port, -r  Remote target port (default: 9222)
  --local-port, -l   Local bound port (default: 19222)
  --key, -k          Private key path or PEM string
  --password, -P     SSH password
  --timeout, -t      Timeout in seconds (default: 6.0)
`);
}

function printModes(): void {
  console.log(`
========================================================================
   CDP HUB 4 CONNECTION MODES MATRIX
========================================================================
1. Direct (直连)        : Direct HTTP/WS connection (host:9222).
2. WSS Direct (wss直连) : Direct TLS WebSocket connection via gateway.
3. WSS Reverse (wss反穿): Edge devices dial outbound WebSocket to Hub.
4. SSH Tunnel (ssh穿透) : Encrypted SSH L-Forwarding (19222 -> 9222).
========================================================================
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    process.exit(0);
  }

  if (command === 'modes') {
    printModes();
    process.exit(0);
  }

  if (command === 'open') {
    const getArg = (flag: string, shortFlag?: string): string | undefined => {
      for (let i = 1; i < args.length; i++) {
        if (args[i] === flag || (shortFlag && args[i] === shortFlag)) {
          return args[i + 1];
        }
      }
      return undefined;
    };

    const host = getArg('--host', '-h');
    if (!host) {
      console.error('Error: --host is required for open command.');
      process.exit(1);
    }

    const port = parseInt(getArg('--port', '-p') || '22', 10);
    const user = getArg('--user', '-u') || 'root';
    const remotePort = parseInt(getArg('--remote-port', '-r') || '9222', 10);
    const localPort = parseInt(getArg('--local-port', '-l') || '19222', 10);
    const key = getArg('--key', '-k');
    const password = getArg('--password', '-P');
    const timeout = parseFloat(getArg('--timeout', '-t') || '6.0');

    console.log(`[*] Starting SSH Tunnel: ${user}@${host}:${port} (127.0.0.1:${localPort} -> 127.0.0.1:${remotePort})...`);

    try {
      const session = await openTunnel(host!, remotePort, localPort, user, port, key, password, '127.0.0.1', timeout);
      console.log(`[+] Tunnel established! Bound to 127.0.0.1:${session.localPort}`);
      console.log('[*] Press Ctrl+C to stop tunnel...');

      process.on('SIGINT', () => {
        console.log('\n[*] Stopping tunnel...');
        session.stop();
        console.log('[+] Tunnel stopped.');
        process.exit(0);
      });

      // Keep process alive
      setInterval(() => {}, 10000);
    } catch (err) {
      if (err instanceof TunnelException) {
        console.error(`[-] Tunnel error [${err.code}]: ${err.message}`);
        if (err.suggestion) {
          console.error(`    Suggestion: ${err.suggestion}`);
        }
      } else {
        console.error(`[-] Error:`, err);
      }
      process.exit(1);
    }
    return;
  }

  printHelp();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
