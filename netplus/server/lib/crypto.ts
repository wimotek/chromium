import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

let cachedKey: Buffer | null = null;
let cachedKeySource: 'env' | 'file' | 'ephemeral' = 'ephemeral';
let cachedKeyPath: string | null = null;

function resolveKeyFilePath(): string {
  const dataDir = path.resolve(process.cwd(), process.env.DATA_DIR?.trim() || './data');
  return path.join(dataDir, '.app.key');
}

function getEncryptionKey(): Buffer {
  const envKey = process.env.APP_ENCRYPTION_KEY?.trim();
  if (envKey) {
    cachedKeySource = 'env';
    cachedKeyPath = null;
    if (/^[0-9a-fA-F]{64}$/.test(envKey)) {
      return Buffer.from(envKey, 'hex');
    }
    return crypto.createHash('sha256').update(envKey, 'utf8').digest();
  }

  if (cachedKey) {
    return cachedKey;
  }

  const keyFile = resolveKeyFilePath();
  try {
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    if (fs.existsSync(keyFile)) {
      const hex = fs.readFileSync(keyFile, 'utf8').trim();
      if (/^[0-9a-fA-F]{64}$/.test(hex)) {
        cachedKey = Buffer.from(hex, 'hex');
        cachedKeySource = 'file';
        cachedKeyPath = keyFile;
        return cachedKey;
      }
    }
    const generated = crypto.randomBytes(32);
    const tmpFile = `${keyFile}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmpFile, generated.toString('hex') + '\n', { mode: 0o600 });
    fs.renameSync(tmpFile, keyFile);
    cachedKey = generated;
    cachedKeySource = 'file';
    cachedKeyPath = keyFile;
    return cachedKey;
  } catch (err) {
    console.warn(
      `[NetPlus] Could not persist encryption key at ${keyFile}, falling back to ephemeral memory key:`,
      err instanceof Error ? err.message : err
    );
    cachedKey = crypto.randomBytes(32);
    cachedKeySource = 'ephemeral';
    cachedKeyPath = null;
    return cachedKey;
  }
}

export function getEncryptionKeyInfo(): { source: 'env' | 'file' | 'ephemeral'; path: string | null } {
  getEncryptionKey();
  return { source: cachedKeySource, path: cachedKeyPath };
}

export function encryptSecret(plaintext: string): string {
  if (!plaintext) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptSecret(ciphertext?: string): string {
  if (!ciphertext) return '';
  const parts = ciphertext.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    return '';
  }
  try {
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const data = Buffer.from(parts[3], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

export function maskSecret(secret?: string): string {
  if (!secret) return '';
  const clean = secret.trim();
  if (clean.length <= 4) return '••••';
  return `••••${clean.slice(-4)}`;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }
  const [, salt, hashHex] = parts;
  const derived = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(hashHex, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

export function safeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function isPrivateIpv4(ip: string): boolean {
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => Number.isNaN(n))) return true;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return (
    lower === '::1' ||
    lower === '::' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe80:') ||
    lower.startsWith('::ffff:127.') ||
    lower.startsWith('::ffff:10.') ||
    lower.startsWith('::ffff:192.168.') ||
    lower.startsWith('::ffff:169.254.')
  );
}

export function validateSafeExternalUrl(rawUrl: string): { valid: boolean; reason?: string; parsed?: URL } {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { valid: false, reason: 'Only http/https URLs are permitted' };
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      hostname === 'metadata.google.internal'
    ) {
      return { valid: false, reason: 'Localhost and internal metadata hosts are blocked' };
    }
    if (net.isIPv4(hostname) && isPrivateIpv4(hostname)) {
      return { valid: false, reason: 'Private or loopback IPv4 addresses are blocked' };
    }
    if (net.isIPv6(hostname) && isPrivateIpv6(hostname)) {
      return { valid: false, reason: 'Private or loopback IPv6 addresses are blocked' };
    }
    return { valid: true, parsed };
  } catch {
    return { valid: false, reason: 'Invalid URL format' };
  }
}
