/**
 * Pure global ambient type shims for Node.js built-ins.
 * NO top-level import or export, so TypeScript treats this as a root ambient script.
 */

interface ProcessObject {
  env: Record<string, string | undefined>;
  argv: string[];
  exit(code?: number): never;
  on(event: string, listener: (...args: any[]) => void): any;
}

declare var process: ProcessObject;

declare module 'child_process' {
  export interface ChildProcess {
    pid?: number;
    exitCode: number | null;
    kill(signal?: string): boolean;
    on(event: string, listener: (...args: any[]) => void): this;
  }
  export function spawn(command: string, args?: readonly string[], options?: any): ChildProcess;
}

declare module 'node:child_process' {
  export interface ChildProcess {
    pid?: number;
    exitCode: number | null;
    kill(signal?: string): boolean;
    on(event: string, listener: (...args: any[]) => void): this;
  }
  export function spawn(command: string, args?: readonly string[], options?: any): ChildProcess;
}

declare module 'fs' {
  export function writeFileSync(path: string, data: string | Uint8Array, options?: any): void;
  export function existsSync(path: string): boolean;
  export function unlinkSync(path: string): void;
}

declare module 'node:fs' {
  export function writeFileSync(path: string, data: string | Uint8Array, options?: any): void;
  export function existsSync(path: string): boolean;
  export function unlinkSync(path: string): void;
}

declare module 'net' {
  export class Socket {
    setTimeout(timeout: number): this;
    once(event: string, listener: (...args: any[]) => void): this;
    destroy(): this;
    connect(port: number, host: string, connectionListener?: () => void): this;
  }
}

declare module 'node:net' {
  export class Socket {
    setTimeout(timeout: number): this;
    once(event: string, listener: (...args: any[]) => void): this;
    destroy(): this;
    connect(port: number, host: string, connectionListener?: () => void): this;
  }
}

declare module 'os' {
  export function tmpdir(): string;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'path' {
  export function join(...paths: string[]): string;
}

declare module 'node:path' {
  export function join(...paths: string[]): string;
}
