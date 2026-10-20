#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

const cliScript = path.resolve(__dirname, '../chromium_sync/cli.py');
const args = [cliScript, ...process.argv.slice(2)];

const child = spawn('python3', args, {
  stdio: 'inherit'
});

child.on('exit', (code) => {
  process.exit(code || 0);
});
