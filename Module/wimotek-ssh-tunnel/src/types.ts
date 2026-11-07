/**
 * Type definitions for wimotek-ssh-tunnel
 * Universal SSH Tunnel & Port Forwarding Engine
 */

export interface TunnelConfig {
  id: string;
  sshHost: string;
  sshPort?: number;
  sshUser?: string;
  remoteHost?: string;
  remotePort?: number;      // Default: 9222
  localPort?: number;       // Default: 19222
  sshKey?: string;          // PEM string or absolute file path
  sshPassword?: string;     // SSH password
  timeoutSec?: number;      // Default: 6.0
  name?: string;
  extraOptions?: Record<string, string>;
}

export interface SkipRecord {
  nodeId: string;
  name: string;
  host: string;
  code: string;
  error: string;
  suggestion?: string;
  timestamp: string;
}

export class TunnelException extends Error {
  public code: string;
  public suggestion?: string;

  constructor(code: string, message: string, suggestion?: string) {
    super(message);
    this.name = 'TunnelException';
    this.code = code;
    this.suggestion = suggestion;
  }
}
