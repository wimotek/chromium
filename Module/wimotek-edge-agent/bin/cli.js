#!/usr/bin/env node
const { spawn } = require('child_process');

const path = require('path');
const packageDir = path.resolve(__dirname, '..');
const env = { ...process.env };
env.PYTHONPATH = env.PYTHONPATH ? `${packageDir}:${env.PYTHONPATH}` : packageDir;

const args = ['-m', 'wimotek_edge_agent', ...process.argv.slice(2)];
const py = spawn('python3', args, { stdio: 'inherit', env });

py.on('error', () => {
  console.error('❌ 请确保宿主机已安装 Python 3 环境与 wimotek-edge-agent 依赖。');
  process.exit(1);
});

py.on('close', (code) => {
  process.exit(code ?? 0);
});