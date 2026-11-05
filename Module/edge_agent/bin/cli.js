#!/usr/bin/env node
const { spawn } = require('child_process');

const args = ['-m', 'wimotek_edge_agent.agent', ...process.argv.slice(2)];
const py = spawn('python3', args, { stdio: 'inherit', env: process.env });

py.on('error', () => {
  console.error('❌ 请确保宿主机已安装 Python 3 和 wimotek-edge-agent: pip install wimotek-edge-agent');
  process.exit(1);
});

py.on('close', (code) => {
  process.exit(code);
});