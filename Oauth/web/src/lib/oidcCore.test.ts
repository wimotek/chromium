import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computePkceChallenge,
  verifyPkceS256,
  validateRedirectUri,
  SecretCipher,
  RsaJwtSigner,
  ResilientCacheEngine,
  hashPassword,
  verifyPassword,
} from './oidcCore';

test('PKCE S256 derives RFC 7636 challenge and rejects tampered verifier', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = computePkceChallenge(verifier);
  assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.equal(verifyPkceS256(verifier, challenge), true);
  assert.equal(verifyPkceS256('wrong-verifier', challenge), false);
});

test('Redirect URI validator strictly enforces allowlist and blocks unsafe schemes', () => {
  const allowed = ['https://app.example.com/callback', 'http://localhost:4000/callback'];
  assert.equal(validateRedirectUri('https://app.example.com/callback', allowed), true);
  assert.equal(validateRedirectUri('https://evil.example.com/callback', allowed), false);
  assert.equal(validateRedirectUri('javascript:alert(1)', allowed), false);
  assert.equal(validateRedirectUri('data:text/html,hi', allowed), false);
});

test('AES-256-GCM SecretCipher roundtrips secrets and produces unique nonces', () => {
  const cipher = new SecretCipher('unit-test-master-secret');
  const plain = '-----BEGIN PRIVATE KEY-----\nAPPLE_P8_SECRET\n-----END PRIVATE KEY-----';
  const enc1 = cipher.encrypt(plain);
  const enc2 = cipher.encrypt(plain);
  assert.ok(enc1.startsWith('enc:v1:'));
  assert.notEqual(enc1, enc2);
  assert.equal(cipher.decrypt(enc1), plain);
  assert.equal(cipher.decrypt(enc2), plain);
});

test('RS256 JWT signer signs, exports JWKS, verifies valid token, and rejects tampered payload', () => {
  const signer = new RsaJwtSigner();
  const jwks = signer.getJwks();
  assert.equal(jwks.keys.length, 1);
  assert.equal(jwks.keys[0].alg, 'RS256');
  assert.equal(jwks.keys[0].kid, signer.kid);

  const token = signer.sign({ iss: 'https://auth.example.com', sub: 'usr_1', email: 'admin@wimotek.dev' }, 600);
  const verified = signer.verify(token);
  assert.equal(verified.valid, true);
  assert.equal(verified.payload.sub, 'usr_1');

  const tampered = `${token.slice(0, -4)}AAAA`;
  assert.equal(signer.verify(tampered).valid, false);
});

test('ResilientCacheEngine automatically falls back to SQL cache when Redis disconnects and purges TTL', () => {
  const cache = new ResilientCacheEngine(true);
  assert.equal(cache.getActiveMode(), 'redis');
  assert.equal(cache.set('k1', 'v1', 5000, 1000), 'redis');
  assert.equal(cache.get('k1', 2000), 'v1');

  // Simulate Redis outage -> transparently falls back to sql_fallback
  cache.configureRedis(true, true);
  assert.equal(cache.getActiveMode(), 'sql_fallback');
  assert.equal(cache.set('code_abc', '{"sub":"u1"}', 3000, 1000), 'sql_fallback');
  assert.equal(cache.get('code_abc', 3500), '{"sub":"u1"}');
  assert.equal(cache.get('code_abc', 5000), null);

  cache.set('expired_key', 'old', 100, 1000);
  const purged = cache.purgeExpired(1500);
  assert.equal(purged, 1);
});

test('scrypt password hashing verifies matching password and rejects wrong password', () => {
  const hash = hashPassword('SuperSecure!2026');
  assert.equal(verifyPassword('SuperSecure!2026', hash), true);
  assert.equal(verifyPassword('WrongPassword', hash), false);
});
