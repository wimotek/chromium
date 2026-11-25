import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateTotpSecret,
  buildOtpAuthUri,
  generateTotp,
  verifyTotp,
  generateRecoveryCodes,
  generateEmailOtp,
  generateDeviceUserCode,
  computeExponentialBackoffSec,
  resolveOrLinkIdentity,
  signWebhookPayload,
  validateWebhookUrl,
  RiskGuardEngine,
} from './authMethods';
import { ResilientCacheEngine } from './oidcCore';
import type { IdentityUser } from '../types';

test('RFC 6238 TOTP generates 6-digit codes, builds otpauth URI, and verifies within ±30s skew', () => {
  const secret = generateTotpSecret();
  assert.ok(secret.length >= 32);
  const uri = buildOtpAuthUri('wimotek/oauth', 'admin@wimotek.dev', secret);
  assert.ok(uri.startsWith('otpauth://totp/'));
  assert.ok(uri.includes(`secret=${secret}`));

  const now = 1_764_000_000_000;
  const code = generateTotp(secret, now);
  assert.match(code, /^\d{6}$/);
  assert.equal(verifyTotp(secret, code, now), true);
  assert.equal(verifyTotp(secret, code, now + 29_000), true);
  assert.equal(verifyTotp(secret, '000000', now), code === '000000');

  const recovery = generateRecoveryCodes(8);
  assert.equal(recovery.length, 8);
  assert.match(recovery[0], /^[0-9A-F]{4}-[0-9A-F]{4}$/);
});

test('Passwordless Email OTP and RFC 8628 Device User Code formats are valid', () => {
  const otp = generateEmailOtp();
  assert.match(otp.code, /^\d{6}$/);
  assert.ok(otp.magicToken.length >= 24);

  const userCode = generateDeviceUserCode();
  assert.match(userCode, /^[BCDFGHJKLMNPQRSTVWXZ23456789]{4}-[BCDFGHJKLMNPQRSTVWXZ23456789]{4}$/);
});

test('JIT Provisioning + Verified-Email Linking attaches new providers onto existing verified accounts', () => {
  const users: IdentityUser[] = [
    {
      id: 'usr_existing',
      email: 'alice@company.com',
      emailVerified: true,
      displayName: 'Alice Chen',
      passwordAlgo: 'argon2id',
      totpEnabled: true,
      passkeyCount: 0,
      status: 'active',
      identities: [
        {
          id: 'ident_1',
          userId: 'usr_existing',
          provider: 'microsoft',
          providerLabel: 'Microsoft (Entra ID)',
          providerSub: 'ms_sub_001',
          email: 'alice@company.com',
          linkedAt: '2026-11-20T00:00:00Z',
        },
      ],
      createdAt: '2026-11-20T00:00:00Z',
      lastLoginAt: '2026-11-20T00:00:00Z',
    },
  ];

  // Signing in via WeChat with same verified email smoothly links onto usr_existing
  const linked = resolveOrLinkIdentity(users, {
    provider: 'wechat',
    providerLabel: '微信 WeChat',
    providerSub: 'wx_union_999',
    email: 'alice@company.com',
    emailVerified: true,
    displayName: 'Alice WeChat',
  });
  assert.equal(linked.action, 'linked_existing_verified_email');
  assert.equal(linked.user.id, 'usr_existing');
  assert.equal(users.length, 1);
  assert.equal(linked.user.identities.length, 2);

  // Subsequent login via WeChat hits exact identity match
  const matched = resolveOrLinkIdentity(users, {
    provider: 'wechat',
    providerLabel: '微信 WeChat',
    providerSub: 'wx_union_999',
    email: 'alice@company.com',
    emailVerified: true,
    displayName: 'Alice WeChat',
  });
  assert.equal(matched.action, 'matched_identity');

  // Brand-new email JIT-provisions a new lightweight user
  const provisioned = resolveOrLinkIdentity(users, {
    provider: 'google',
    providerLabel: 'Google',
    providerSub: 'goog_sub_777',
    email: 'bob@company.com',
    emailVerified: true,
    displayName: 'Bob Lin',
  });
  assert.equal(provisioned.action, 'provisioned_new_user');
  assert.equal(users.length, 2);
});

test('RiskGuard enforces IP rate limit and progressive exponential backoff lockout', () => {
  assert.equal(computeExponentialBackoffSec(2, 3), 0);
  assert.equal(computeExponentialBackoffSec(3, 3), 15);
  assert.equal(computeExponentialBackoffSec(4, 3), 30);
  assert.equal(computeExponentialBackoffSec(5, 3), 60);

  const cache = new ResilientCacheEngine(false);
  const guard = new RiskGuardEngine(cache);
  const t0 = 1_764_000_000_000;

  assert.equal(guard.checkIpRateLimit('203.0.113.5', 2, t0).allowed, true);
  assert.equal(guard.checkIpRateLimit('203.0.113.5', 2, t0).allowed, true);
  assert.equal(guard.checkIpRateLimit('203.0.113.5', 2, t0).allowed, false);

  guard.recordLoginFailure('admin@wimotek.dev', 3, t0);
  guard.recordLoginFailure('admin@wimotek.dev', 3, t0);
  const third = guard.recordLoginFailure('admin@wimotek.dev', 3, t0);
  assert.equal(third.backoffSec, 15);
  assert.equal(guard.checkAccountLock('admin@wimotek.dev', t0 + 5_000).locked, true);
  assert.equal(guard.checkAccountLock('admin@wimotek.dev', t0 + 16_000).locked, false);
});

test('Webhook URL validator blocks SSRF private/metadata targets and HMAC signs payloads', () => {
  assert.equal(validateWebhookUrl('https://erp.company.com/webhooks/oauth').valid, true);
  assert.equal(validateWebhookUrl('http://169.254.169.254/latest/meta-data').valid, false);
  assert.equal(validateWebhookUrl('http://127.0.0.1:8080/hook').valid, false);
  assert.equal(validateWebhookUrl('http://10.0.0.5/internal').valid, false);

  const sig = signWebhookPayload('whsec_demo', '{"event":"user.banned"}');
  assert.match(sig, /^sha256=[0-9a-f]{64}$/);
});
