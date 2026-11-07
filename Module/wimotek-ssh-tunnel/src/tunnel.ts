import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { TunnelConfig, SkipRecord, TunnelException } from './types.js';

export class SshTunnelSession {
  public config: TunnelConfig;
  public proc: ChildProcess | null = null;
  public isReused = false;
  public tempKeyFile: string | null = null;
  public askpassScript: string | null = null;
  public localPort: number;

  constructor(config: TunnelConfig) {
    this.config = {
      ...config,
      sshPort: config.sshPort || 22,
      sshUser: config.sshUser || 'root',
      remoteHost: config.remoteHost || '127.0.0.1',
      remotePort: config.remotePort || 9222,
      localPort: config.localPort || 19222,
      timeoutSec: config.timeoutSec || 6.0,
      name: config.name || config.id,
    };
    this.localPort = this.config.localPort!;
  }

  private isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(300);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.connect(port, '127.0.0.1');
    });
  }

  private prepareKeyFile(): string | null {
    if (!this.config.sshKey) return null;
    const keyStr = this.config.sshKey.trim();
    if (keyStr.includes('-----BEGIN') || keyStr.includes('\n')) {
      const tmpPath = path.join(os.tmpdir(), `ssh_key_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
      fs.writeFileSync(tmpPath, keyStr + '\n', { mode: 0o600 });
      this.tempKeyFile = tmpPath;
      return tmpPath;
    } else {
      if (fs.existsSync(keyStr)) {
        return keyStr;
      }
      throw new TunnelException(
        'SSH_KEY_NOT_FOUND',
        `指定的私钥文件不存在: ${keyStr}`,
        '检查私钥路径或直接传入 PEM 文本内容。'
      );
    }
  }

  private prepareAskpassScript(): string | null {
    if (!this.config.sshPassword) return null;
    const tmpPath = path.join(os.tmpdir(), `askpass_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.sh`);
    const escapedPw = this.config.sshPassword.replace(/'/g, "'\\''");
    fs.writeFileSync(tmpPath, `#!/bin/sh\necho '${escapedPw}'\n`, { mode: 0o700 });
    this.askpassScript = tmpPath;
    return tmpPath;
  }

  public async start(): Promise<number> {
    if (['127.0.0.1', 'localhost', '::1', ''].includes(this.config.sshHost)) {
      return this.config.remotePort || 9222;
    }

    const portUsed = await this.isPortInUse(this.localPort);
    if (portUsed) {
      this.isReused = true;
      return this.localPort;
    }

    const sshArgs = [
      '-N',
      '-p', String(this.config.sshPort),
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'TCPKeepAlive=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', `ConnectTimeout=${Math.floor(this.config.timeoutSec!)}`,
      '-L', `${this.localPort}:${this.config.remoteHost}:${this.config.remotePort}`,
    ];

    const env = { ...process.env };

    const keyPath = this.prepareKeyFile();
    if (keyPath) {
      sshArgs.push('-i', keyPath);
    }

    const askpassPath = this.prepareAskpassScript();
    if (askpassPath) {
      env.SSH_ASKPASS = askpassPath;
      env.SSH_ASKPASS_REQUIRE = 'force';
      env.DISPLAY = ':0';
      sshArgs.push('-o', 'BatchMode=no');
    }

    sshArgs.push(`${this.config.sshUser}@${this.config.sshHost}`);

    try {
      this.proc = spawn('ssh', sshArgs, {
        env,
        stdio: 'ignore',
        detached: false,
      });
    } catch {
      throw new TunnelException(
        'SSH_COMMAND_NOT_FOUND',
        '系统未找到 ssh 命令执行文件，请确认安装 openssh-client',
        '运行 apt-get install openssh-client 或对应系统包管理器安装'
      );
    }

    const maxAttempts = Math.floor(this.config.timeoutSec! / 0.3);
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 300));
      if (await this.isPortInUse(this.localPort)) {
        return this.localPort;
      }
      if (this.proc && this.proc.exitCode !== null) {
        break;
      }
    }

    this.stop(true);
    throw new TunnelException(
      'SSH_CONNECT_TIMEOUT',
      `建立 SSH 隧道失败或超时 [${this.config.name} -> ${this.config.sshHost}:${this.config.sshPort}]`,
      '检查远程 SSH 账号密码/密钥、安全组规则及目标服务监听状态。'
    );
  }

  public stop(force = false): void {
    if (this.isReused && !force) return;
    if (this.proc && this.proc.exitCode === null) {
      try {
        this.proc.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
    if (this.tempKeyFile && fs.existsSync(this.tempKeyFile)) {
      try { fs.unlinkSync(this.tempKeyFile); } catch {}
    }
    if (this.askpassScript && fs.existsSync(this.askpassScript)) {
      try { fs.unlinkSync(this.askpassScript); } catch {}
    }
  }
}

export class SSHTunnelManager {
  public startPort: number;
  public tunnels: Map<string, SshTunnelSession> = new Map();
  public skips: SkipRecord[] = [];
  private currentAllocatedPort: number;

  constructor(startPort = 19222) {
    this.startPort = startPort;
    this.currentAllocatedPort = startPort;
  }

  public allocatePort(): number {
    const port = this.currentAllocatedPort;
    this.currentAllocatedPort += 1;
    return port;
  }

  public addTunnel(config: TunnelConfig): SshTunnelSession {
    const session = new SshTunnelSession(config);
    this.tunnels.set(config.id, session);
    return session;
  }

  public async startAll(skipOnFailure = true): Promise<Record<string, number>> {
    const activePorts: Record<string, number> = {};
    let portCursor = this.startPort;

    for (const [id, tunnel] of this.tunnels.entries()) {
      if (!tunnel.config.localPort || tunnel.config.localPort === 19222) {
        tunnel.localPort = portCursor;
        tunnel.config.localPort = portCursor;
        portCursor += 1;
      }

      try {
        const boundPort = await tunnel.start();
        activePorts[id] = boundPort;
      } catch (err: any) {
        const code = err instanceof TunnelException ? err.code : 'UNKNOWN_TUNNEL_ERROR';
        const suggestion = err instanceof TunnelException ? err.suggestion : undefined;
        this.skips.push({
          nodeId: id,
          name: tunnel.config.name || id,
          host: tunnel.config.sshHost,
          code,
          error: err.message,
          suggestion,
          timestamp: new Date().toISOString(),
        });
        if (!skipOnFailure) {
          throw err;
        }
      }
    }

    return activePorts;
  }

  public stopAll(): void {
    for (const tunnel of this.tunnels.values()) {
      tunnel.stop();
    }
  }
}

export async function openTunnel(
  sshHost: string,
  remotePort = 9222,
  localPort = 19222,
  sshUser = 'root',
  sshPort = 22,
  sshKey?: string,
  sshPassword?: string,
  remoteHost = '127.0.0.1',
  timeoutSec = 6.0
): Promise<SshTunnelSession> {
  const session = new SshTunnelSession({
    id: `tunnel-${sshHost}-${remotePort}`,
    sshHost,
    sshPort,
    sshUser,
    remoteHost,
    remotePort,
    localPort,
    sshKey,
    sshPassword,
    timeoutSec,
  });
  await session.start();
  return session;
}
