import test from 'node:test';
import assert from 'node:assert/strict';
import { hasLeadingZeroBits, solvePowChallenge } from './pow';
import {
  ALL_PROFILES,
  PROFILE_SPECS,
  ROLE_DEFAULT_QUOTA,
  parseSanInput,
  isValidUpn,
  isValidSanEntry,
  parseAdvanceDays,
  computeQuotaRemaining,
  isQuotaExhausted,
  formatSerialColon,
  computeCertEffectiveStatus,
  isExpiringWithinDays,
} from './pki-utils';

test('hasLeadingZeroBits accurately evaluates byte and bit boundaries', () => {
  assert.equal(hasLeadingZeroBits(new Uint8Array([0x00, 0x00, 0xff]), 16), true);
  assert.equal(hasLeadingZeroBits(new Uint8Array([0x00, 0x0f, 0xff]), 12), true);
  assert.equal(hasLeadingZeroBits(new Uint8Array([0x00, 0x10, 0xff]), 12), false);
  assert.equal(hasLeadingZeroBits(new Uint8Array([0x00, 0x00, 0x7f]), 17), true);
  assert.equal(hasLeadingZeroBits(new Uint8Array([0x00, 0x00, 0x80]), 17), false);
});

test('solvePowChallenge finds valid solution meeting difficulty', async () => {
  const challenge = 'dGVzdG5vbmNl.deadbeef';
  const result = await solvePowChallenge(challenge, 8);
  assert.ok(result.iterations >= 1);
  assert.ok(result.solution.length > 0);
});

test('SAN parser deduplicates and validates DNS, wildcard, IPv4, and IPv6', () => {
  const list = parseSanInput('api.corp.internal, *.svc.corp.internal\n10.20.0.15; api.corp.internal');
  assert.deepEqual(list, ['api.corp.internal', '*.svc.corp.internal', '10.20.0.15']);
  assert.equal(isValidSanEntry('api.corp.internal'), true);
  assert.equal(isValidSanEntry('*.svc.corp.internal'), true);
  assert.equal(isValidSanEntry('10.20.0.15'), true);
  assert.equal(isValidSanEntry('999.1.2.3'), false);
  assert.equal(isValidSanEntry('bad host name'), false);
});

test('all 8 enterprise certificate profiles have valid OID specs and constraints', () => {
  assert.equal(ALL_PROFILES.length, 8);
  for (const pid of ALL_PROFILES) {
    const spec = PROFILE_SPECS[pid];
    assert.ok(spec, `missing spec for ${pid}`);
    assert.ok(spec.ekuOids.length >= 1);
    assert.ok(spec.defaultTtlDays > 0 && spec.defaultTtlDays <= spec.maxTtlDays);
  }
  assert.equal(isValidUpn('alice@contoso.com'), true);
  assert.equal(isValidUpn('not-an-upn'), false);
  assert.equal(PROFILE_SPECS.pdf_signing.ekuOids.length, 3);
  assert.equal(PROFILE_SPECS.entra_cba.requiresUpn, true);
  assert.equal(PROFILE_SPECS.smime_email.requiresEmail, true);
  assert.equal(PROFILE_SPECS.code_signing.ekuOids[0].includes('1.3.6.1.5.5.7.3.3'), true);
});

test('user role quotas and advance notification day parser handle edge cases', () => {
  assert.equal(ROLE_DEFAULT_QUOTA.admin, -1);
  assert.equal(ROLE_DEFAULT_QUOTA.standard, 10);
  assert.equal(ROLE_DEFAULT_QUOTA.basic, 3);
  assert.equal(computeQuotaRemaining(5, -1), null);
  assert.equal(isQuotaExhausted(500, -1), false);
  assert.equal(computeQuotaRemaining(2, 3), 1);
  assert.equal(isQuotaExhausted(3, 3), true);
  assert.deepEqual(parseAdvanceDays('7, 30, 1, 7, 0, 999'), [30, 7, 1]);
  assert.deepEqual(parseAdvanceDays('invalid'), [30, 7, 1]);
});

test('certificate status & expiration helpers work with Unix seconds', () => {
  const now = 1_750_000_000;
  assert.equal(computeCertEffectiveStatus('active', now + 3600, now), 'active');
  assert.equal(computeCertEffectiveStatus('active', now - 10, now), 'expired');
  assert.equal(computeCertEffectiveStatus('revoked', now + 3600, now), 'revoked');
  assert.equal(isExpiringWithinDays('active', now + 10 * 86400, now, 30), true);
  assert.equal(isExpiringWithinDays('active', now + 60 * 86400, now, 30), false);
  assert.equal(isExpiringWithinDays('revoked', now + 10 * 86400, now, 30), false);
  assert.equal(formatSerialColon('4a1b2c3d'), '4A:1B:2C:3D');
});
