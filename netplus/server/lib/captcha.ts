import crypto from 'node:crypto';
import type { CaptchaChallengeResponse, SecurityConfig } from '../../src/types/models.ts';

interface StoredCaptcha {
  id: string;
  answer: string;
  powSalt: string;
  powDifficulty: number;
  sliderTarget: number;
  requireSlider: boolean;
  issuedAt: number;
  expiresAt: number;
  ip: string;
}

interface RateBucket {
  timestamps: number[];
}

interface FailureRecord {
  count: number;
  lockedUntil: number;
  lastAttemptAt: number;
}

const CAPTCHA_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CAPTCHA_TTL_MS = 120_000;

export class AntiBotGuard {
  private challenges = new Map<string, StoredCaptcha>();
  private rateBuckets = new Map<string, RateBucket>();
  private loginFailures = new Map<string, FailureRecord>();

  constructor() {
    setInterval(() => this.gc(), 60_000).unref();
  }

  private gc() {
    const now = Date.now();
    for (const [id, ch] of this.challenges.entries()) {
      if (now > ch.expiresAt) this.challenges.delete(id);
    }
    for (const [key, rec] of this.loginFailures.entries()) {
      if (now - rec.lastAttemptAt > 3_600_000 && now > rec.lockedUntil) {
        this.loginFailures.delete(key);
      }
    }
  }

  checkRateLimit(key: string, windowSeconds: number, maxRequests: number): { allowed: boolean; retryAfterSec: number } {
    const now = Date.now();
    const windowMs = Math.max(5, windowSeconds) * 1000;
    const bucket = this.rateBuckets.get(key) ?? { timestamps: [] };
    bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs);

    if (bucket.timestamps.length >= maxRequests) {
      const oldest = bucket.timestamps[0] ?? now;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
      this.rateBuckets.set(key, bucket);
      return { allowed: false, retryAfterSec };
    }

    bucket.timestamps.push(now);
    this.rateBuckets.set(key, bucket);
    return { allowed: true, retryAfterSec: 0 };
  }

  checkLockout(ip: string): { locked: boolean; retryAfterSec: number; failures: number } {
    const rec = this.loginFailures.get(ip);
    if (!rec) return { locked: false, retryAfterSec: 0, failures: 0 };
    const now = Date.now();
    if (rec.lockedUntil > now) {
      return {
        locked: true,
        retryAfterSec: Math.max(1, Math.ceil((rec.lockedUntil - now) / 1000)),
        failures: rec.count,
      };
    }
    return { locked: false, retryAfterSec: 0, failures: rec.count };
  }

  recordLoginFailure(ip: string, maxAttempts: number, lockoutMinutes: number): { locked: boolean; attemptsLeft: number; retryAfterSec: number } {
    const now = Date.now();
    const rec = this.loginFailures.get(ip) ?? { count: 0, lockedUntil: 0, lastAttemptAt: now };
    rec.count += 1;
    rec.lastAttemptAt = now;

    if (rec.count >= maxAttempts) {
      const multiplier = Math.min(4, Math.floor(rec.count / maxAttempts));
      const lockMs = lockoutMinutes * 60_000 * multiplier;
      rec.lockedUntil = now + lockMs;
      this.loginFailures.set(ip, rec);
      return { locked: true, attemptsLeft: 0, retryAfterSec: Math.ceil(lockMs / 1000) };
    }

    this.loginFailures.set(ip, rec);
    return { locked: false, attemptsLeft: Math.max(0, maxAttempts - rec.count), retryAfterSec: 0 };
  }

  clearLoginFailures(ip: string) {
    this.loginFailures.delete(ip);
  }

  createChallenge(ip: string, config: SecurityConfig): CaptchaChallengeResponse {
    const id = crypto.randomBytes(16).toString('hex');
    const codeLen = config.captchaDifficulty === 'high' ? 6 : 5;
    let answer = '';
    for (let i = 0; i < codeLen; i++) {
      answer += CAPTCHA_ALPHABET[crypto.randomInt(0, CAPTCHA_ALPHABET.length)];
    }
    const powSalt = crypto.randomBytes(12).toString('hex');
    const sliderTarget = crypto.randomInt(22, 82); // percentage along track
    const failedAttempts = this.checkLockout(ip).failures;
    const sliderThreshold =
      typeof config.sliderFailureThreshold === 'number' && Number.isFinite(config.sliderFailureThreshold)
        ? Math.max(0, Math.min(10, Math.floor(config.sliderFailureThreshold)))
        : 2;
    const requireSlider =
      Boolean(config.requireSliderVerify) && (sliderThreshold === 0 || failedAttempts >= sliderThreshold);
    const issuedAt = Date.now();
    const expiresAt = issuedAt + CAPTCHA_TTL_MS;

    this.challenges.set(id, {
      id,
      answer,
      powSalt,
      powDifficulty: Math.min(4, Math.max(1, config.powDifficulty)),
      sliderTarget,
      requireSlider,
      issuedAt,
      expiresAt,
      ip,
    });

    const svg = this.renderDistortedSvg(answer, config.captchaDifficulty);

    return {
      challengeId: id,
      svg,
      powSalt,
      powDifficulty: Math.min(4, Math.max(1, config.powDifficulty)),
      sliderTarget,
      requireSlider,
      failedAttempts,
      sliderThreshold,
      issuedAt,
      expiresAt,
    };
  }

  verifyChallenge(params: {
    challengeId: string;
    answer: string;
    powNonce: string;
    sliderValue?: number;
    honeypot?: string;
    ip: string;
    config: SecurityConfig;
  }): { ok: boolean; code: string } {
    // Honeypot trap for bots
    if (params.honeypot && params.honeypot.trim().length > 0) {
      return { ok: false, code: 'BOT_HONEYPOT_TRIGGERED' };
    }

    const ch = this.challenges.get(params.challengeId);
    // Single-use: consume immediately to prevent replay
    this.challenges.delete(params.challengeId);

    if (!ch) {
      return { ok: false, code: 'CAPTCHA_EXPIRED_OR_INVALID' };
    }

    const now = Date.now();
    if (now > ch.expiresAt) {
      return { ok: false, code: 'CAPTCHA_EXPIRED' };
    }

    // Minimum dwell time anti-bot check
    if (now - ch.issuedAt < Math.max(300, params.config.minFormDwellMs)) {
      return { ok: false, code: 'BOT_TOO_FAST' };
    }

    // Verify Proof-of-Work
    const expectedPrefix = '0'.repeat(ch.powDifficulty);
    const powDigest = crypto
      .createHash('sha256')
      .update(`${ch.powSalt}:${params.powNonce ?? ''}`)
      .digest('hex');
    if (!powDigest.startsWith(expectedPrefix)) {
      return { ok: false, code: 'POW_INVALID' };
    }

    // Verify Slider Human Interaction (tolerance ±6%)
    if (ch.requireSlider) {
      const val = Number(params.sliderValue);
      if (!Number.isFinite(val) || Math.abs(val - ch.sliderTarget) > 6) {
        return { ok: false, code: 'SLIDER_MISMATCH' };
      }
    }

    // Verify CAPTCHA text (case-insensitive)
    const normalizedInput = String(params.answer ?? '').trim().toUpperCase();
    if (normalizedInput !== ch.answer) {
      return { ok: false, code: 'CAPTCHA_WRONG' };
    }

    return { ok: true, code: 'OK' };
  }

  private renderDistortedSvg(code: string, difficulty: 'standard' | 'high'): string {
    const width = 220;
    const height = 64;
    const lineCount = difficulty === 'high' ? 8 : 5;
    const dotCount = difficulty === 'high' ? 48 : 28;
    const palette = ['#1d4ed8', '#0f766e', '#4338ca', '#b45309', '#be123c', '#0369a1'];

    const noiseLines: string[] = [];
    for (let i = 0; i < lineCount; i++) {
      const x1 = crypto.randomInt(0, 40);
      const y1 = crypto.randomInt(6, height - 6);
      const cx1 = crypto.randomInt(50, 110);
      const cy1 = crypto.randomInt(0, height);
      const cx2 = crypto.randomInt(110, 175);
      const cy2 = crypto.randomInt(0, height);
      const x2 = crypto.randomInt(180, width);
      const y2 = crypto.randomInt(6, height - 6);
      const color = palette[crypto.randomInt(0, palette.length)];
      const sw = (1 + crypto.randomInt(0, 12) / 10).toFixed(1);
      noiseLines.push(
        `<path d="M${x1},${y1} C${cx1},${cy1} ${cx2},${cy2} ${x2},${y2}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-opacity="0.32" />`
      );
    }

    const noiseDots: string[] = [];
    for (let i = 0; i < dotCount; i++) {
      const cx = crypto.randomInt(4, width - 4);
      const cy = crypto.randomInt(4, height - 4);
      const r = (0.8 + crypto.randomInt(0, 14) / 10).toFixed(1);
      const color = palette[crypto.randomInt(0, palette.length)];
      noiseDots.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" fill-opacity="0.28" />`);
    }

    const charStep = (width - 36) / code.length;
    const chars: string[] = [];
    for (let i = 0; i < code.length; i++) {
      const x = Math.round(22 + i * charStep + crypto.randomInt(-3, 4));
      const y = Math.round(41 + crypto.randomInt(-6, 7));
      const rotate = crypto.randomInt(difficulty === 'high' ? -24 : -16, difficulty === 'high' ? 25 : 17);
      const skew = crypto.randomInt(-10, 11);
      const fontSize = crypto.randomInt(26, 33);
      const color = palette[crypto.randomInt(0, palette.length)];
      chars.push(
        `<text x="${x}" y="${y}" font-family="JetBrains Mono, ui-monospace, monospace" font-size="${fontSize}" font-weight="700" fill="${color}" transform="rotate(${rotate} ${x} ${y}) skewX(${skew})">${code[i]}</text>`
      );
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Security verification code"><defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#f8fafc"/><stop offset="100%" stop-color="#e2e8f0"/></linearGradient></defs><rect width="${width}" height="${height}" rx="8" fill="url(#bg)"/>${noiseDots.join('')}${noiseLines.join('')}${chars.join('')}</svg>`;
  }
}

export const antiBotGuard = new AntiBotGuard();
