import crypto from 'node:crypto';
import type { CacheMode } from '../types';

export function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, 'base64');
}

export function randomToken(bytes = 24): string {
  return base64UrlEncode(crypto.randomBytes(bytes));
}

export function computePkceChallenge(verifier: string): string {
  return base64UrlEncode(crypto.createHash('sha256').update(verifier, 'ascii').digest());
}

export function verifyPkceS256(verifier: string, expectedChallenge: string): boolean {
  if (!verifier || !expectedChallenge) return false;
  const computed = Buffer.from(computePkceChallenge(verifier), 'ascii');
  const expected = Buffer.from(expectedChallenge, 'ascii');
  if (computed.length !== expected.length) return false;
  return crypto.timingSafeEqual(computed, expected);
}

export function validateRedirectUri(candidate: string, allowedUris: string[]): boolean {
  if (!candidate || allowedUris.length === 0) return false;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
  } catch {
    return false;
  }
  return allowedUris.includes(candidate);
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hashHex] = parts;
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hashHex, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

export function maskSecret(secret: string): string {
  if (!secret) return '';
  if (secret.length <= 8) return '••••••••';
  return `${secret.slice(0, 4)}••••••••${secret.slice(-4)}`;
}

/**
 * AES-256-GCM encryption for persisting third-party social connector secrets & Apple .p8 keys.
 */
export class SecretCipher {
  private readonly key: Buffer;

  constructor(masterKeyInput?: string) {
    if (masterKeyInput && masterKeyInput.trim().length > 0) {
      this.key = crypto.createHash('sha256').update(masterKeyInput.trim(), 'utf8').digest();
    } else {
      this.key = crypto.randomBytes(32);
    }
  }

  encrypt(plaintext: string): string {
    if (!plaintext) return '';
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `enc:v1:${Buffer.concat([iv, tag, encrypted]).toString('base64')}`;
  }

  decrypt(envelope: string): string {
    if (!envelope) return '';
    if (!envelope.startsWith('enc:v1:')) {
      throw new Error('Invalid encrypted secret envelope');
    }
    const raw = Buffer.from(envelope.slice('enc:v1:'.length), 'base64');
    if (raw.length < 28) {
      throw new Error('Malformed ciphertext');
    }
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const payload = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8');
  }
}

/**
 * RSA-2048 RS256 JWT Signer + Public JWKS Exporter for OIDC ID Tokens & Access Tokens.
 */
export class RsaJwtSigner {
  private readonly privateKey: crypto.KeyObject;
  private readonly publicKey: crypto.KeyObject;
  public readonly kid: string;

  constructor() {
    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
    const jwk = this.publicKey.export({ format: 'jwk' }) as { n?: string };
    const thumb = crypto.createHash('sha256').update(jwk.n || 'rsa').digest();
    this.kid = base64UrlEncode(thumb.subarray(0, 8));
  }

  getJwks() {
    const jwk = this.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    return {
      keys: [
        {
          ...jwk,
          kty: 'RSA',
          use: 'sig',
          alg: 'RS256',
          kid: this.kid,
        },
      ],
    };
  }

  sign(payload: Record<string, unknown>, expiresInSec = 3600): string {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT', kid: this.kid };
    const body = { ...payload, iat: now, exp: now + expiresInSec };
    const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(body))}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput, 'utf8'), this.privateKey);
    return `${signingInput}.${base64UrlEncode(signature)}`;
  }

  verify(token: string): { valid: boolean; header: Record<string, unknown>; payload: Record<string, unknown> } {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return { valid: false, header: {}, payload: {} };
    }
    const [hB64, pB64, sB64] = parts;
    const header = JSON.parse(base64UrlDecode(hB64).toString('utf8')) as Record<string, unknown>;
    const payload = JSON.parse(base64UrlDecode(pB64).toString('utf8')) as Record<string, unknown>;
    const sigOk = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${hB64}.${pB64}`, 'utf8'),
      this.publicKey,
      base64UrlDecode(sB64)
    );
    const notExpired = typeof payload.exp === 'number' && payload.exp > Math.floor(Date.now() / 1000);
    return { valid: sigOk && notExpired, header, payload };
  }
}

interface CacheEntry {
  value: string;
  expiresAt: number;
}

/**
 * Unified Cache Engine implementing Redis primary with automatic transparent fallback
 * to SQL `sys_caches` table + TTL expiration & GC sweep.
 */
export class ResilientCacheEngine {
  private redisStore = new Map<string, CacheEntry>();
  private sqlFallbackStore = new Map<string, CacheEntry>();
  private redisConfigured: boolean;
  private redisSimulatedDown = false;

  constructor(redisConfigured = false) {
    this.redisConfigured = redisConfigured;
  }

  configureRedis(enabled: boolean, simulatedDown = false) {
    this.redisConfigured = enabled;
    this.redisSimulatedDown = simulatedDown;
  }

  getActiveMode(): CacheMode {
    if (this.redisConfigured && !this.redisSimulatedDown) {
      return 'redis';
    }
    return 'sql_fallback';
  }

  set(key: string, value: string, ttlMs: number, now = Date.now()): CacheMode {
    const entry: CacheEntry = { value, expiresAt: now + ttlMs };
    if (this.getActiveMode() === 'redis') {
      this.redisStore.set(key, entry);
      return 'redis';
    }
    this.sqlFallbackStore.set(key, entry);
    return 'sql_fallback';
  }

  get(key: string, now = Date.now()): string | null {
    if (this.getActiveMode() === 'redis') {
      const hit = this.redisStore.get(key);
      if (hit) {
        if (hit.expiresAt > now) return hit.value;
        this.redisStore.delete(key);
      }
    }
    // Transparent fallback read from SQL sys_caches even during/after failover
    const sqlHit = this.sqlFallbackStore.get(key);
    if (!sqlHit) return null;
    if (sqlHit.expiresAt <= now) {
      this.sqlFallbackStore.delete(key);
      return null;
    }
    return sqlHit.value;
  }

  delete(key: string) {
    this.redisStore.delete(key);
    this.sqlFallbackStore.delete(key);
  }

  purgeExpired(now = Date.now()): number {
    let purged = 0;
    for (const [k, v] of this.redisStore.entries()) {
      if (v.expiresAt <= now) {
        this.redisStore.delete(k);
        purged++;
      }
    }
    for (const [k, v] of this.sqlFallbackStore.entries()) {
      if (v.expiresAt <= now) {
        this.sqlFallbackStore.delete(k);
        purged++;
      }
    }
    return purged;
  }

  stats() {
    return {
      mode: this.getActiveMode(),
      redisKeys: this.redisStore.size,
      sqlFallbackKeys: this.sqlFallbackStore.size,
    };
  }
}
