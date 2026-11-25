import crypto from 'node:crypto';
import type { IdentityProviderType, IdentityUser } from '../types';
import type { ResilientCacheEngine } from './oidcCore';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * Generates a 160-bit Base32 secret for RFC 6238 TOTP (Authenticator apps / 1Password).
 */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function buildOtpAuthUri(issuer: string, accountEmail: string, secret: string): string {
  const label = encodeURIComponent(`${issuer}:${accountEmail}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * RFC 6238 TOTP (HMAC-SHA1, 30s period, 6 digits).
 */
export function generateTotp(secret: string, timestampMs = Date.now()): string {
  const key = base32Decode(secret);
  const counter = Math.floor(timestampMs / 1000 / 30);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

/**
 * Constant-time TOTP verification allowing ±1 step (30s) clock skew.
 */
export function verifyTotp(secret: string, code: string, timestampMs = Date.now()): boolean {
  const clean = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  const inputBuf = Buffer.from(clean, 'ascii');
  for (const offsetMs of [-30_000, 0, 30_000]) {
    const expected = Buffer.from(generateTotp(secret, timestampMs + offsetMs), 'ascii');
    if (crypto.timingSafeEqual(inputBuf, expected)) {
      return true;
    }
  }
  return false;
}

export function generateRecoveryCodes(count = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const hex = crypto.randomBytes(4).toString('hex').toUpperCase();
    codes.push(`${hex.slice(0, 4)}-${hex.slice(4, 8)}`);
  }
  return codes;
}

/**
 * Passwordless 6-digit Email OTP + 192-bit Magic Link token.
 */
export function generateEmailOtp(): { code: string; magicToken: string } {
  const num = crypto.randomInt(0, 1_000_000);
  const code = String(num).padStart(6, '0');
  const magicToken = crypto.randomBytes(24).toString('base64url');
  return { code, magicToken };
}

/**
 * RFC 8628 Device Flow human-readable User Code (unambiguous consonants & digits: XXXX-XXXX).
 */
export function generateDeviceUserCode(): string {
  const chars = 'BCDFGHJKLMNPQRSTVWXZ23456789';
  let out = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) out += '-';
    out += chars[crypto.randomInt(0, chars.length)];
  }
  return out;
}

/**
 * Exponential backoff lockout calculator (starts at threshold attempts: 15s, 30s, 60s, 120s...).
 */
export function computeExponentialBackoffSec(failedAttempts: number, threshold = 3): number {
  if (failedAttempts < threshold) return 0;
  const shift = Math.min(failedAttempts - threshold, 6);
  return 15 * (1 << shift);
}

/**
 * Progressive Identity Resolution:
 * 1. Exact match on (provider, providerSub) in user_identities.
 * 2. If emailVerified && autoLink enabled, smoothly bind provider onto existing users row with same email.
 * 3. Otherwise JIT-provision a fresh lightweight user + identity binding.
 */
export function resolveOrLinkIdentity(
  users: IdentityUser[],
  incoming: {
    provider: IdentityProviderType;
    providerLabel: string;
    providerSub: string;
    email: string;
    emailVerified: boolean;
    displayName: string;
  },
  autoLinkVerifiedEmail = true
): {
  user: IdentityUser;
  action: 'matched_identity' | 'linked_existing_verified_email' | 'provisioned_new_user';
} {
  const normEmail = incoming.email.trim().toLowerCase();
  const nowIso = new Date().toISOString();

  // 1. Existing identity link
  for (const u of users) {
    const existing = u.identities.find(
      (id) => id.provider === incoming.provider && id.providerSub === incoming.providerSub
    );
    if (existing) {
      u.lastLoginAt = nowIso;
      return { user: u, action: 'matched_identity' };
    }
  }

  // 2. Smooth verified-email linking onto existing account (zero duplicate users!)
  if (autoLinkVerifiedEmail && incoming.emailVerified && normEmail) {
    const matchedUser = users.find((u) => u.email.toLowerCase() === normEmail && u.emailVerified);
    if (matchedUser) {
      matchedUser.identities.push({
        id: `ident_${crypto.randomBytes(5).toString('hex')}`,
        userId: matchedUser.id,
        provider: incoming.provider,
        providerLabel: incoming.providerLabel,
        providerSub: incoming.providerSub,
        email: normEmail,
        linkedAt: nowIso,
      });
      if (incoming.provider === 'passkey') {
        matchedUser.passkeyCount += 1;
      }
      matchedUser.lastLoginAt = nowIso;
      return { user: matchedUser, action: 'linked_existing_verified_email' };
    }
  }

  // 3. JIT provision new lightweight identity account
  const newId = `usr_${crypto.randomBytes(5).toString('hex')}`;
  const created: IdentityUser = {
    id: newId,
    email: normEmail,
    emailVerified: incoming.emailVerified,
    displayName: incoming.displayName || normEmail.split('@')[0],
    passwordAlgo: 'none',
    totpEnabled: false,
    passkeyCount: incoming.provider === 'passkey' ? 1 : 0,
    status: 'active',
    identities: [
      {
        id: `ident_${crypto.randomBytes(5).toString('hex')}`,
        userId: newId,
        provider: incoming.provider,
        providerLabel: incoming.providerLabel,
        providerSub: incoming.providerSub,
        email: normEmail,
        linkedAt: nowIso,
      },
    ],
    createdAt: nowIso,
    lastLoginAt: nowIso,
  };
  users.unshift(created);
  return { user: created, action: 'provisioned_new_user' };
}

/**
 * HMAC-SHA256 webhook signature (X-Wimotek-Signature-256).
 */
export function signWebhookPayload(secret: string, payloadJson: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(payloadJson, 'utf8').digest('hex')}`;
}

/**
 * SSRF-safe validation for user-supplied Webhook destination URLs.
 */
export function validateWebhookUrl(rawUrl: string): { valid: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, reason: 'Invalid URL format' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { valid: false, reason: 'Only http:// and https:// URLs are allowed' };
  }
  const host = parsed.hostname.toLowerCase();
  const blockedPatterns = [
    /^localhost$/,
    /^127\./,
    /^0\.0\.0\.0$/,
    /^::1$/,
    /^169\.254\./,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[0-1])\./,
  ];
  if (blockedPatterns.some((re) => re.test(host))) {
    return { valid: false, reason: 'Private, loopback, and metadata addresses are blocked for security' };
  }
  return { valid: true };
}

/**
 * Risk Control Guard backed by ResilientCacheEngine (Redis -> SQL fallback).
 */
export class RiskGuardEngine {
  constructor(private readonly cache: ResilientCacheEngine) {}

  checkIpRateLimit(ip: string, limitPerMin: number, now = Date.now()): { allowed: boolean; count: number } {
    const key = `risk:rl:${ip}`;
    const raw = this.cache.get(key, now);
    const count = raw ? Number(raw) + 1 : 1;
    this.cache.set(key, String(count), 60_000, now);
    return { allowed: count <= limitPerMin, count };
  }

  recordLoginFailure(email: string, threshold: number, now = Date.now()): { attempts: number; lockedUntil: number; backoffSec: number } {
    const key = `risk:fail:${email.toLowerCase()}`;
    const raw = this.cache.get(key, now);
    const prev = raw ? (JSON.parse(raw) as { attempts: number; lockedUntil: number }) : { attempts: 0, lockedUntil: 0 };
    const attempts = prev.attempts + 1;
    const backoffSec = computeExponentialBackoffSec(attempts, threshold);
    const lockedUntil = backoffSec > 0 ? now + backoffSec * 1000 : 0;
    this.cache.set(key, JSON.stringify({ attempts, lockedUntil }), 3600_000, now);
    return { attempts, lockedUntil, backoffSec };
  }

  checkAccountLock(email: string, now = Date.now()): { locked: boolean; retryAfterSec: number } {
    const key = `risk:fail:${email.toLowerCase()}`;
    const raw = this.cache.get(key, now);
    if (!raw) return { locked: false, retryAfterSec: 0 };
    const state = JSON.parse(raw) as { attempts: number; lockedUntil: number };
    if (state.lockedUntil > now) {
      return { locked: true, retryAfterSec: Math.ceil((state.lockedUntil - now) / 1000) };
    }
    return { locked: false, retryAfterSec: 0 };
  }

  clearLoginFailures(email: string) {
    this.cache.delete(`risk:fail:${email.toLowerCase()}`);
  }
}
