// In-memory session token store (never written to localStorage or sessionStorage)
let memoryToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

export function setAuthToken(token: string | null) {
  memoryToken = token;
}

export function getAuthToken(): string | null {
  return memoryToken;
}

export function setOnUnauthorized(handler: () => void) {
  unauthorizedHandler = handler;
}

export class ApiError extends Error {
  status: number;
  code: string;
  data: Record<string, unknown>;

  constructor(status: number, code: string, data: Record<string, unknown> = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (memoryToken) {
    headers.set('Authorization', `Bearer ${memoryToken}`);
  }

  const res = await fetch(path, {
    ...init,
    headers,
  });

  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  if (text) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = { error: text };
    }
  }

  if (!res.ok) {
    if (res.status === 401 && memoryToken && !path.startsWith('/api/auth/')) {
      memoryToken = null;
      unauthorizedHandler?.();
    }
    throw new ApiError(res.status, String(parsed.error || `HTTP_${res.status}`), parsed);
  }

  return parsed as unknown as T;
}

// Web Crypto SHA-256 Proof-of-Work solver for anti-bot verification
export async function solvePowChallenge(salt: string, difficulty: number): Promise<string> {
  const prefix = '0'.repeat(Math.max(1, Math.min(4, difficulty)));
  const encoder = new TextEncoder();
  let nonce = 0;

  while (nonce < 500_000) {
    const candidate = String(nonce);
    const data = encoder.encode(`${salt}:${candidate}`);
    const digestBuf = await crypto.subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(digestBuf);
    let hex = '';
    for (let i = 0; i < Math.ceil(prefix.length / 2) + 1; i++) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    if (hex.startsWith(prefix)) {
      return candidate;
    }
    nonce += 1;
    // Yield periodically to keep UI responsive at 60fps
    if (nonce % 400 === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  return '0';
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / Math.pow(1024, idx);
  return `${val >= 100 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
}

export function formatTimeAgo(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
