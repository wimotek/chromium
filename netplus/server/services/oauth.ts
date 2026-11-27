import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import type {
  OAuthProviderId,
  OAuthProviderPublicConfig,
  WimotekOAuthPublicStatus,
} from '../../src/types/models.ts';
import { decryptSecret, encryptSecret, safeEqualStrings } from '../lib/crypto.ts';
import { store } from '../lib/store.ts';

export const OAUTH_PROVIDERS: OAuthProviderId[] = ['wimotek', 'microsoft', 'github', 'google', 'apple'];

export const DEFAULT_WIMOTEK_ISSUER = 'http://ca.wimotek.com';
export const DEFAULT_WIMOTEK_CLIENT_ID = 'wimotek_ebb129ddb83c';
export const OIDC_TX_COOKIE_NAME = 'netplus_oidc_tx';

export function isOAuthProviderId(value: string): value is OAuthProviderId {
  return (OAUTH_PROVIDERS as string[]).includes(value);
}

export interface ResolvedOAuthCredentials {
  provider: OAuthProviderId;
  enabled: boolean;
  configured: boolean;
  envManaged: boolean;
  clientId: string;
  clientSecret: string;
  issuerUrl: string;
  redirectUriOverride: string;
  directLogin: boolean;
  adminEmail: string;
  restrictToBoundOnly: boolean;
  tenantId: string;
  teamId: string;
  keyId: string;
  privateKey: string;
  secretPreview?: string;
}

export interface OidcDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  end_session_endpoint: string;
}

interface PendingOAuthState {
  provider: OAuthProviderId;
  mode: 'login' | 'bind';
  flow: 'popup' | 'redirect';
  redirectUri: string;
  codeVerifier?: string;
  nonce?: string;
  returnTo?: string;
  createdAt: number;
  expiresAt: number;
  actor?: string;
}

interface OidcTxCookiePayload {
  state: string;
  provider: OAuthProviderId;
  mode: 'login' | 'bind';
  flow: 'popup' | 'redirect';
  redirectUri: string;
  codeVerifier?: string;
  nonce?: string;
  returnTo?: string;
  actor?: string;
  expiresAt: number;
}

const pendingStates = new Map<string, PendingOAuthState>();
const discoveryCache = new Map<string, { doc: OidcDiscoveryDocument; expiresAt: number }>();
const jwksCache = new Map<string, { keys: Array<Record<string, unknown>>; expiresAt: number }>();

function prunePendingStates() {
  const now = Date.now();
  for (const [key, item] of pendingStates.entries()) {
    if (item.expiresAt <= now) {
      pendingStates.delete(key);
    }
  }
}

function normalizeIssuerUrl(raw?: string): string {
  const clean = (raw || '').trim().replace(/\/+$/, '');
  if (!clean) return DEFAULT_WIMOTEK_ISSUER;
  try {
    const parsed = new URL(clean);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return DEFAULT_WIMOTEK_ISSUER;
    }
    return clean;
  } catch {
    return DEFAULT_WIMOTEK_ISSUER;
  }
}

function buildFallbackDiscovery(issuer: string): OidcDiscoveryDocument {
  const base = normalizeIssuerUrl(issuer);
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    userinfo_endpoint: `${base}/oauth/userinfo`,
    jwks_uri: `${base}/.well-known/jwks.json`,
    end_session_endpoint: `${base}/oauth/logout`,
  };
}

export async function getWimotekDiscovery(issuerInput?: string): Promise<OidcDiscoveryDocument> {
  const issuer = normalizeIssuerUrl(issuerInput);
  const cached = discoveryCache.get(issuer);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.doc;
  }

  const fallback = buildFallbackDiscovery(issuer);
  try {
    const res = await fetch(`${issuer}/.well-known/openid-configuration`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(6_000),
    });
    if (res.ok) {
      const json = (await res.json()) as Partial<OidcDiscoveryDocument>;
      const doc: OidcDiscoveryDocument = {
        issuer: typeof json.issuer === 'string' && json.issuer.trim() ? json.issuer.trim().replace(/\/+$/, '') : fallback.issuer,
        authorization_endpoint:
          typeof json.authorization_endpoint === 'string' && json.authorization_endpoint.trim()
            ? json.authorization_endpoint.trim()
            : fallback.authorization_endpoint,
        token_endpoint:
          typeof json.token_endpoint === 'string' && json.token_endpoint.trim()
            ? json.token_endpoint.trim()
            : fallback.token_endpoint,
        userinfo_endpoint:
          typeof json.userinfo_endpoint === 'string' && json.userinfo_endpoint.trim()
            ? json.userinfo_endpoint.trim()
            : fallback.userinfo_endpoint,
        jwks_uri:
          typeof json.jwks_uri === 'string' && json.jwks_uri.trim()
            ? json.jwks_uri.trim()
            : fallback.jwks_uri,
        end_session_endpoint:
          typeof json.end_session_endpoint === 'string' && json.end_session_endpoint.trim()
            ? json.end_session_endpoint.trim()
            : fallback.end_session_endpoint,
      };
      discoveryCache.set(issuer, { doc, expiresAt: Date.now() + 10 * 60_000 });
      return doc;
    }
  } catch {
    // Gracefully fall back to standard wimotek OIDC endpoints
  }

  discoveryCache.set(issuer, { doc: fallback, expiresAt: Date.now() + 2 * 60_000 });
  return fallback;
}

async function fetchJwksKeys(jwksUri: string, forceRefresh = false): Promise<Array<Record<string, unknown>>> {
  if (!forceRefresh) {
    const cached = jwksCache.get(jwksUri);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.keys;
    }
  }

  const res = await fetch(jwksUri, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch JWKS (${res.status}) from ${jwksUri}`);
  }
  const data = (await res.json()) as { keys?: Array<Record<string, unknown>> };
  const keys = Array.isArray(data.keys) ? data.keys : [];
  if (keys.length === 0) {
    throw new Error('JWKS endpoint returned no signing keys');
  }
  jwksCache.set(jwksUri, { keys, expiresAt: Date.now() + 10 * 60_000 });
  return keys;
}

export function resolveOAuthCredentials(provider: OAuthProviderId): ResolvedOAuthCredentials {
  const stored = store.getState().oauthProviders.find((p) => p.provider === provider);
  const decrypted = store.getOAuthProviderDecryptedSecrets(provider);

  if (provider === 'wimotek') {
    const envIssuer = process.env.OAUTH_ISSUER?.trim() || process.env.OAUTH_WIMOTEK_ISSUER?.trim() || '';
    const envClientId = process.env.OAUTH_CLIENT_ID?.trim() || process.env.OAUTH_WIMOTEK_CLIENT_ID?.trim() || '';
    const envClientSecret = process.env.OAUTH_SECRET?.trim() || process.env.OAUTH_WIMOTEK_CLIENT_SECRET?.trim() || '';
    const envRedirectUri = process.env.OAUTH_REDIRECT_URI?.trim() || process.env.OAUTH_WIMOTEK_REDIRECT_URI?.trim() || '';
    const envAdminEmail = process.env.OAUTH_ADMIN_EMAIL?.trim() || '';
    const envEnabledRaw = process.env.OAUTH_ENABLED?.trim().toLowerCase();
    const envDirectRaw = process.env.OAUTH_DIRECT_LOGIN?.trim().toLowerCase();

    const issuerUrl = normalizeIssuerUrl(envIssuer || stored?.issuerUrl || DEFAULT_WIMOTEK_ISSUER);
    const clientId = envClientId || stored?.clientId?.trim() || DEFAULT_WIMOTEK_CLIENT_ID;
    const clientSecret = envClientSecret || decrypted.clientSecret || '';
    const redirectUriOverride = envRedirectUri || stored?.redirectUri?.trim() || '';
    const adminEmail = envAdminEmail || stored?.adminEmail?.trim() || '';
    const directLogin =
      stored?.directLogin !== undefined
        ? Boolean(stored.directLogin)
        : envDirectRaw !== 'false';
    const restrictToBoundOnly = Boolean(stored?.restrictToBoundOnly);

    const envManaged = Boolean(envClientSecret);
    const configured = Boolean(issuerUrl && clientId && clientSecret);

    // Respect explicit Web UI toggle if saved; otherwise auto-enable when OAUTH_ENABLED=true or OAUTH_SECRET is provided (unless OAUTH_ENABLED=false)
    let enabledFlag = false;
    if (stored && typeof stored.enabled === 'boolean') {
      enabledFlag = stored.enabled;
    } else if (envEnabledRaw === 'true') {
      enabledFlag = true;
    } else if (envEnabledRaw === 'false') {
      enabledFlag = false;
    } else {
      enabledFlag = envManaged;
    }

    return {
      provider: 'wimotek',
      enabled: configured && enabledFlag,
      configured,
      envManaged,
      clientId,
      clientSecret,
      issuerUrl,
      redirectUriOverride,
      directLogin,
      adminEmail,
      restrictToBoundOnly,
      tenantId: '',
      teamId: '',
      keyId: '',
      privateKey: '',
      secretPreview: stored?.secretPreview || (envClientSecret ? `••••${envClientSecret.slice(-4)}` : undefined),
    };
  }

  const prefix = `OAUTH_${provider.toUpperCase()}_`;
  const envClientId = process.env[`${prefix}CLIENT_ID`]?.trim() || '';
  const envClientSecret = process.env[`${prefix}CLIENT_SECRET`]?.trim() || '';
  const envTenantId = process.env.OAUTH_MICROSOFT_TENANT_ID?.trim() || '';
  const envTeamId = process.env.OAUTH_APPLE_TEAM_ID?.trim() || '';
  const envKeyId = process.env.OAUTH_APPLE_KEY_ID?.trim() || '';
  const envPrivateKey = (process.env.OAUTH_APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();

  const clientId = envClientId || stored?.clientId?.trim() || '';
  const clientSecret = envClientSecret || decrypted.clientSecret || '';
  const tenantId = envTenantId || stored?.tenantId?.trim() || 'common';
  const teamId = envTeamId || stored?.teamId?.trim() || '';
  const keyId = envKeyId || stored?.keyId?.trim() || '';
  const privateKey = envPrivateKey || decrypted.privateKey || '';

  const envManaged = Boolean(
    envClientId && (provider === 'apple' ? envTeamId && envKeyId && envPrivateKey : envClientSecret)
  );
  const configured =
    provider === 'apple'
      ? Boolean(clientId && teamId && keyId && privateKey)
      : Boolean(clientId && clientSecret);

  const enabled = stored ? Boolean(stored.enabled) : envManaged;

  return {
    provider,
    enabled: configured && enabled,
    configured,
    envManaged,
    clientId,
    clientSecret,
    issuerUrl: '',
    redirectUriOverride: '',
    directLogin: false,
    adminEmail: '',
    restrictToBoundOnly: true,
    tenantId,
    teamId,
    keyId,
    privateKey,
    secretPreview: stored?.secretPreview || (envClientSecret ? `••••${envClientSecret.slice(-4)}` : undefined),
  };
}

export function listOAuthProviderConfigs(): OAuthProviderPublicConfig[] {
  const bindings = store.getState().boundOAuthAccounts;
  return OAUTH_PROVIDERS.map((provider) => {
    const resolved = resolveOAuthCredentials(provider);
    const stored = store.getState().oauthProviders.find((p) => p.provider === provider);
    const rawEnabled = stored ? Boolean(stored.enabled) : resolved.enabled;
    return {
      provider,
      enabled: rawEnabled,
      configured: resolved.configured,
      envManaged: resolved.envManaged,
      clientId: resolved.clientId || undefined,
      issuerUrl: provider === 'wimotek' ? resolved.issuerUrl : undefined,
      redirectUri: provider === 'wimotek' ? resolved.redirectUriOverride || undefined : undefined,
      directLogin: provider === 'wimotek' ? resolved.directLogin : undefined,
      adminEmail: provider === 'wimotek' ? resolved.adminEmail || undefined : undefined,
      restrictToBoundOnly: provider === 'wimotek' ? resolved.restrictToBoundOnly : undefined,
      tenantId: provider === 'microsoft' ? resolved.tenantId : undefined,
      teamId: provider === 'apple' ? resolved.teamId || undefined : undefined,
      keyId: provider === 'apple' ? resolved.keyId || undefined : undefined,
      hasClientSecret: Boolean(resolved.clientSecret),
      secretPreview: resolved.secretPreview,
      hasPrivateKey: provider === 'apple' ? Boolean(resolved.privateKey) : undefined,
      boundCount: bindings.filter((b) => b.provider === provider).length,
    };
  });
}

export function getPublicOAuthStatus() {
  const bindings = store.getState().boundOAuthAccounts;
  return OAUTH_PROVIDERS.map((provider) => {
    const resolved = resolveOAuthCredentials(provider);
    return {
      provider,
      configured: resolved.configured,
      enabled: resolved.enabled,
      boundCount: bindings.filter((b) => b.provider === provider).length,
    };
  });
}

export function getWimotekPublicStatus(): WimotekOAuthPublicStatus {
  const resolved = resolveOAuthCredentials('wimotek');
  return {
    enabled: resolved.enabled,
    configured: resolved.configured,
    directLogin: resolved.directLogin,
    issuerUrl: resolved.issuerUrl,
    clientId: resolved.clientId,
    loginPath: '/login',
    logoutPath: '/logout',
  };
}

export function resolveAppBaseUrl(req: Request): string {
  const envUrl = process.env.APP_URL?.trim();
  if (envUrl && envUrl !== 'MY_APP_URL' && /^https?:\/\//i.test(envUrl)) {
    return envUrl.replace(/\/+$/, '');
  }
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const proto = forwardedProto || (req.secure ? 'https' : 'http');
  const host = forwardedHost || req.headers.host || 'localhost:3000';
  return `${proto}://${host}`.replace(/\/+$/, '');
}

export function buildOAuthCallbackUri(req: Request, provider: OAuthProviderId): string {
  if (provider === 'wimotek') {
    const creds = resolveOAuthCredentials('wimotek');
    if (creds.redirectUriOverride) {
      return creds.redirectUriOverride;
    }
    return `${resolveAppBaseUrl(req)}/auth/callback`;
  }
  return `${resolveAppBaseUrl(req)}/api/auth/oauth/${provider}/callback`;
}

function isHttpsReq(req: Request): boolean {
  if (req.secure) return true;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

export function setOidcTxCookie(req: Request, res: Response, payload: OidcTxCookiePayload) {
  const sealed = encryptSecret(JSON.stringify(payload));
  const secure = isHttpsReq(req);
  const parts = [
    `${OIDC_TX_COOKIE_NAME}=${encodeURIComponent(sealed)}`,
    'Path=/',
    'HttpOnly',
    'Max-Age=600',
  ];
  if (secure) {
    parts.push('Secure', 'SameSite=None', 'Partitioned');
  } else {
    parts.push('SameSite=Lax');
  }
  res.append('Set-Cookie', parts.join('; '));
}

export function clearOidcTxCookie(req: Request, res: Response) {
  const secure = isHttpsReq(req);
  const parts = [
    `${OIDC_TX_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'Max-Age=0',
  ];
  if (secure) {
    parts.push('Secure', 'SameSite=None', 'Partitioned');
  } else {
    parts.push('SameSite=Lax');
  }
  res.append('Set-Cookie', parts.join('; '));
}

export function readOidcTxCookie(rawCookieValue?: string): OidcTxCookiePayload | null {
  if (!rawCookieValue) return null;
  const decrypted = decryptSecret(rawCookieValue);
  if (!decrypted) return null;
  try {
    const parsed = JSON.parse(decrypted) as Partial<OidcTxCookiePayload>;
    if (
      typeof parsed.state === 'string' &&
      typeof parsed.provider === 'string' &&
      isOAuthProviderId(parsed.provider) &&
      typeof parsed.redirectUri === 'string' &&
      typeof parsed.expiresAt === 'number' &&
      parsed.expiresAt > Date.now()
    ) {
      return {
        state: parsed.state,
        provider: parsed.provider,
        mode: parsed.mode === 'bind' ? 'bind' : 'login',
        flow: parsed.flow === 'redirect' ? 'redirect' : 'popup',
        redirectUri: parsed.redirectUri,
        codeVerifier: typeof parsed.codeVerifier === 'string' ? parsed.codeVerifier : undefined,
        nonce: typeof parsed.nonce === 'string' ? parsed.nonce : undefined,
        returnTo: typeof parsed.returnTo === 'string' ? parsed.returnTo : undefined,
        actor: typeof parsed.actor === 'string' ? parsed.actor : undefined,
        expiresAt: parsed.expiresAt,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + '='.repeat(padLen), 'base64');
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length < 2) return {};
  try {
    return JSON.parse(base64UrlDecode(parts[1]).toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function verifyRs256IdToken(params: {
  idToken: string;
  jwksUri: string;
  expectedIssuer: string;
  expectedClientId: string;
  expectedNonce?: string;
}): Promise<Record<string, unknown>> {
  const parts = params.idToken.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid OIDC id_token structure');
  }
  const [headerB64, payloadB64, signatureB64] = parts;
  let header: { alg?: string; kid?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString('utf8')) as { alg?: string; kid?: string };
    payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('Malformed OIDC id_token JSON');
  }

  if (header.alg !== 'RS256') {
    throw new Error(`Unsupported OIDC id_token alg "${header.alg || 'none'}" (expected RS256)`);
  }

  const findMatchingJwk = (keys: Array<Record<string, unknown>>) => {
    if (header.kid) {
      const exact = keys.find((k) => k.kid === header.kid);
      if (exact) return exact;
    }
    return keys.find((k) => k.kty === 'RSA' && (!k.use || k.use === 'sig')) || keys[0];
  };

  let keys = await fetchJwksKeys(params.jwksUri, false);
  let jwk = findMatchingJwk(keys);
  if (header.kid && (!jwk || jwk.kid !== header.kid)) {
    keys = await fetchJwksKeys(params.jwksUri, true);
    jwk = findMatchingJwk(keys);
  }
  if (!jwk) {
    throw new Error('No matching RS256 signing key found in JWKS');
  }

  const publicKey = crypto.createPublicKey({
    key: jwk as unknown as crypto.JsonWebKey,
    format: 'jwk',
  });
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  const signature = base64UrlDecode(signatureB64);
  const sigValid = crypto.verify('RSA-SHA256', signingInput, publicKey, signature);
  if (!sigValid) {
    throw new Error('OIDC id_token RS256 signature verification failed');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const clockSkewSec = 60;

  const tokenIss = typeof payload.iss === 'string' ? payload.iss.trim().replace(/\/+$/, '') : '';
  const expectedIss = params.expectedIssuer.trim().replace(/\/+$/, '');
  if (!tokenIss || tokenIss !== expectedIss) {
    throw new Error(`OIDC id_token issuer mismatch (got "${tokenIss}", expected "${expectedIss}")`);
  }

  const aud = payload.aud;
  const audValid =
    (typeof aud === 'string' && aud === params.expectedClientId) ||
    (Array.isArray(aud) && aud.includes(params.expectedClientId));
  if (!audValid) {
    throw new Error('OIDC id_token audience (aud) does not match client_id');
  }

  if (typeof payload.exp !== 'number' || payload.exp + clockSkewSec < nowSec) {
    throw new Error('OIDC id_token has expired');
  }

  if (typeof payload.nbf === 'number' && payload.nbf - clockSkewSec > nowSec) {
    throw new Error('OIDC id_token is not yet valid (nbf)');
  }

  if (params.expectedNonce && typeof payload.nonce === 'string') {
    if (!safeEqualStrings(payload.nonce, params.expectedNonce)) {
      throw new Error('OIDC id_token nonce mismatch');
    }
  }

  if (typeof payload.sub !== 'string' || !payload.sub.trim()) {
    throw new Error('OIDC id_token missing subject (sub)');
  }

  return payload;
}

function createAppleClientSecret(creds: ResolvedOAuthCredentials): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'ES256', kid: creds.keyId, typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iss: creds.teamId,
      iat: now,
      exp: now + 300,
      aud: 'https://appleid.apple.com',
      sub: creds.clientId,
    })
  );
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: creds.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

export function sanitizeSafeReturnPath(raw?: string): string {
  const candidate = (raw || '').trim();
  if (!candidate || !candidate.startsWith('/') || candidate.startsWith('//') || candidate.startsWith('/\\')) {
    return '/';
  }
  return candidate;
}

export async function createOAuthAuthorizationUrl(params: {
  req: Request;
  res?: Response;
  provider: OAuthProviderId;
  mode: 'login' | 'bind';
  flow?: 'popup' | 'redirect';
  returnTo?: string;
  actor?: string;
}): Promise<{ ok: true; url: string; callbackUri: string; state: string } | { ok: false; error: string }> {
  prunePendingStates();
  const creds = resolveOAuthCredentials(params.provider);
  if (!creds.configured) {
    return {
      ok: false,
      error:
        params.provider === 'wimotek'
          ? 'wimotek/Oauth 尚未配置 OAUTH_SECRET（Client Secret），请在环境变量或「安全与容器设置」中配置'
          : `${params.provider.toUpperCase()} OAuth 尚未配置 Client ID / Secret，请先在「安全与容器设置」中配置凭据`,
    };
  }
  if (!creds.enabled && params.mode === 'login') {
    return {
      ok: false,
      error: `${params.provider.toUpperCase()} 登录当前已禁用，请在「安全与容器设置」中开启`,
    };
  }

  const state = crypto.randomBytes(24).toString('hex');
  const redirectUri = buildOAuthCallbackUri(params.req, params.provider);
  const flow = params.flow || 'popup';
  const returnTo = sanitizeSafeReturnPath(params.returnTo);
  const expiresAt = Date.now() + 10 * 60_000;

  let codeVerifier: string | undefined;
  let codeChallenge: string | undefined;
  let nonce: string | undefined;

  if (params.provider === 'wimotek' || params.provider === 'microsoft' || params.provider === 'google') {
    codeVerifier = base64UrlEncode(crypto.randomBytes(32));
    codeChallenge = base64UrlEncode(crypto.createHash('sha256').update(codeVerifier).digest());
  }
  if (params.provider === 'wimotek') {
    nonce = base64UrlEncode(crypto.randomBytes(24));
  }

  pendingStates.set(state, {
    provider: params.provider,
    mode: params.mode,
    flow,
    redirectUri,
    codeVerifier,
    nonce,
    returnTo,
    createdAt: Date.now(),
    expiresAt,
    actor: params.actor,
  });

  if (params.res) {
    setOidcTxCookie(params.req, params.res, {
      state,
      provider: params.provider,
      mode: params.mode,
      flow,
      redirectUri,
      codeVerifier,
      nonce,
      returnTo,
      actor: params.actor,
      expiresAt,
    });
  }

  if (params.provider === 'wimotek') {
    const discovery = await getWimotekDiscovery(creds.issuerUrl);
    const q = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid profile email',
      state,
      nonce: nonce!,
      code_challenge: codeChallenge!,
      code_challenge_method: 'S256',
    });
    return {
      ok: true,
      state,
      callbackUri: redirectUri,
      url: `${discovery.authorization_endpoint}?${q.toString()}`,
    };
  }

  if (params.provider === 'microsoft') {
    const tenant = encodeURIComponent(creds.tenantId || 'common');
    const q = new URLSearchParams({
      client_id: creds.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      response_mode: 'query',
      scope: 'openid profile email User.Read',
      state,
      code_challenge: codeChallenge!,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    return {
      ok: true,
      state,
      callbackUri: redirectUri,
      url: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${q.toString()}`,
    };
  }

  if (params.provider === 'github') {
    const q = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: redirectUri,
      scope: 'read:user user:email',
      state,
    });
    return {
      ok: true,
      state,
      callbackUri: redirectUri,
      url: `https://github.com/login/oauth/authorize?${q.toString()}`,
    };
  }

  if (params.provider === 'google') {
    const q = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      code_challenge: codeChallenge!,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    return {
      ok: true,
      state,
      callbackUri: redirectUri,
      url: `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`,
    };
  }

  // Apple Sign In (uses response_mode=form_post when requesting name/email)
  const q = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    response_mode: 'form_post',
    scope: 'name email',
    state,
  });
  return {
    ok: true,
    state,
    callbackUri: redirectUri,
    url: `https://appleid.apple.com/auth/authorize?${q.toString()}`,
  };
}

export async function buildWimotekLogoutUrl(req: Request, idTokenHint?: string): Promise<string | null> {
  const creds = resolveOAuthCredentials('wimotek');
  if (!creds.configured || !creds.enabled) return null;
  const discovery = await getWimotekDiscovery(creds.issuerUrl);
  const postLogoutRedirect = `${resolveAppBaseUrl(req)}/?logged_out=1`;
  const q = new URLSearchParams({
    client_id: creds.clientId,
    post_logout_redirect_uri: postLogoutRedirect,
  });
  if (idTokenHint) {
    q.set('id_token_hint', idTokenHint);
  }
  return `${discovery.end_session_endpoint}?${q.toString()}`;
}

export interface VerifiedOAuthIdentity {
  provider: OAuthProviderId;
  subject: string;
  email?: string;
  emailVerified?: boolean;
  displayName?: string;
  preferredUsername?: string;
  avatarUrl?: string;
  idToken?: string;
}

export async function completeOAuthCallback(params: {
  provider: OAuthProviderId;
  code: string;
  state: string;
  txCookieRaw?: string;
  appleUserJson?: string;
}): Promise<
  | {
      ok: true;
      mode: 'login' | 'bind';
      flow: 'popup' | 'redirect';
      returnTo: string;
      actor?: string;
      identity: VerifiedOAuthIdentity;
    }
  | { ok: false; flow: 'popup' | 'redirect'; error: string }
> {
  prunePendingStates();
  const cookieTx = readOidcTxCookie(params.txCookieRaw);
  const memoryPending = pendingStates.get(params.state);

  // If HttpOnly CSRF cookie is present, enforce strict timing-safe state match
  if (cookieTx && !safeEqualStrings(cookieTx.state, params.state)) {
    return {
      ok: false,
      flow: cookieTx.flow,
      error: 'OAuth CSRF state 校验不匹配，请重新发起授权',
    };
  }

  const pending: PendingOAuthState | null =
    memoryPending && memoryPending.provider === params.provider
      ? memoryPending
      : cookieTx && cookieTx.provider === params.provider && safeEqualStrings(cookieTx.state, params.state)
      ? {
          provider: cookieTx.provider,
          mode: cookieTx.mode,
          flow: cookieTx.flow,
          redirectUri: cookieTx.redirectUri,
          codeVerifier: cookieTx.codeVerifier,
          nonce: cookieTx.nonce,
          returnTo: cookieTx.returnTo,
          createdAt: Date.now(),
          expiresAt: cookieTx.expiresAt,
          actor: cookieTx.actor,
        }
      : null;

  if (!pending) {
    return {
      ok: false,
      flow: cookieTx?.flow || 'popup',
      error: 'OAuth state 无效或已过期，请重新发起授权',
    };
  }

  pendingStates.delete(params.state);

  const creds = resolveOAuthCredentials(params.provider);
  if (!creds.configured) {
    return {
      ok: false,
      flow: pending.flow,
      error: `${params.provider.toUpperCase()} OAuth 凭据未配置`,
    };
  }

  const returnTo = sanitizeSafeReturnPath(pending.returnTo);

  try {
    if (params.provider === 'wimotek') {
      const discovery = await getWimotekDiscovery(creds.issuerUrl);
      const tokenBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code: params.code,
        redirect_uri: pending.redirectUri,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      });
      if (pending.codeVerifier) {
        tokenBody.set('code_verifier', pending.codeVerifier);
      }

      const tokenRes = await fetch(discovery.token_endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: tokenBody,
        signal: AbortSignal.timeout(15_000),
      });
      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        id_token?: string;
        token_type?: string;
        error?: string;
        error_description?: string;
      };
      if (!tokenRes.ok || (!tokenData.access_token && !tokenData.id_token)) {
        return {
          ok: false,
          flow: pending.flow,
          error:
            tokenData.error_description ||
            tokenData.error ||
            `wimotek/Oauth token exchange failed (${tokenRes.status})`,
        };
      }

      let idClaims: Record<string, unknown> = {};
      if (tokenData.id_token) {
        idClaims = await verifyRs256IdToken({
          idToken: tokenData.id_token,
          jwksUri: discovery.jwks_uri,
          expectedIssuer: discovery.issuer,
          expectedClientId: creds.clientId,
          expectedNonce: pending.nonce,
        });
      }

      let userInfo: Record<string, unknown> = {};
      if (tokenData.access_token) {
        const infoRes = await fetch(discovery.userinfo_endpoint, {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(10_000),
        });
        if (infoRes.ok) {
          userInfo = (await infoRes.json()) as Record<string, unknown>;
        } else if (!tokenData.id_token) {
          return {
            ok: false,
            flow: pending.flow,
            error: `wimotek/Oauth userinfo request failed (${infoRes.status})`,
          };
        }
      }

      const idSub = typeof idClaims.sub === 'string' ? idClaims.sub.trim() : '';
      const infoSub = typeof userInfo.sub === 'string' ? userInfo.sub.trim() : '';
      if (idSub && infoSub && idSub !== infoSub) {
        return {
          ok: false,
          flow: pending.flow,
          error: 'OIDC UserInfo sub 与 ID Token sub 不一致',
        };
      }

      const subject = idSub || infoSub;
      if (!subject) {
        return {
          ok: false,
          flow: pending.flow,
          error: '未能从 wimotek/Oauth 获取用户唯一标识 (sub)',
        };
      }

      const emailRaw =
        (typeof userInfo.email === 'string' && userInfo.email.trim()) ||
        (typeof idClaims.email === 'string' && idClaims.email.trim()) ||
        '';
      const email = emailRaw || undefined;
      const emailVerified =
        userInfo.email_verified === true ||
        (userInfo.email_verified === undefined && idClaims.email_verified === true);
      const preferredUsername =
        (typeof userInfo.preferred_username === 'string' && userInfo.preferred_username.trim()) ||
        (typeof idClaims.preferred_username === 'string' && idClaims.preferred_username.trim()) ||
        undefined;
      const displayName =
        (typeof userInfo.name === 'string' && userInfo.name.trim()) ||
        (typeof idClaims.name === 'string' && idClaims.name.trim()) ||
        preferredUsername ||
        email ||
        `wimotek:${subject.slice(0, 12)}`;
      const avatarUrl =
        (typeof userInfo.picture === 'string' && userInfo.picture.trim()) ||
        (typeof idClaims.picture === 'string' && idClaims.picture.trim()) ||
        undefined;

      return {
        ok: true,
        mode: pending.mode,
        flow: pending.flow,
        returnTo,
        actor: pending.actor,
        identity: {
          provider: 'wimotek',
          subject,
          email,
          emailVerified,
          displayName,
          preferredUsername,
          avatarUrl,
          idToken: tokenData.id_token,
        },
      };
    }

    if (params.provider === 'microsoft') {
      const tenant = encodeURIComponent(creds.tenantId || 'common');
      const tokenRes = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          code: params.code,
          redirect_uri: pending.redirectUri,
          grant_type: 'authorization_code',
          code_verifier: pending.codeVerifier || '',
          scope: 'openid profile email User.Read',
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        id_token?: string;
        error?: string;
        error_description?: string;
      };
      if (!tokenRes.ok || !tokenData.access_token) {
        return {
          ok: false,
          flow: pending.flow,
          error:
            tokenData.error_description ||
            tokenData.error ||
            `Microsoft token exchange failed (${tokenRes.status})`,
        };
      }

      const idClaims = tokenData.id_token ? decodeJwtPayload(tokenData.id_token) : {};
      let profile: { id?: string; displayName?: string; mail?: string; userPrincipalName?: string } = {};
      try {
        const meRes = await fetch('https://graph.microsoft.com/v1.0/me', {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (meRes.ok) {
          profile = (await meRes.json()) as typeof profile;
        }
      } catch {
        // Fallback to OIDC id_token claims
      }

      const subject = String(profile.id || idClaims.oid || idClaims.sub || '').trim();
      if (!subject) {
        return { ok: false, flow: pending.flow, error: '未能从 Microsoft 获取用户唯一标识 (sub/oid)' };
      }
      const email =
        String(
          profile.mail || profile.userPrincipalName || idClaims.preferred_username || idClaims.email || ''
        ).trim() || undefined;
      const displayName = String(profile.displayName || idClaims.name || email || 'Microsoft User').trim();

      return {
        ok: true,
        mode: pending.mode,
        flow: pending.flow,
        returnTo,
        actor: pending.actor,
        identity: { provider: 'microsoft', subject, email, displayName },
      };
    }

    if (params.provider === 'github') {
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          code: params.code,
          redirect_uri: pending.redirectUri,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        error?: string;
        error_description?: string;
      };
      if (!tokenRes.ok || !tokenData.access_token) {
        return {
          ok: false,
          flow: pending.flow,
          error:
            tokenData.error_description ||
            tokenData.error ||
            `GitHub token exchange failed (${tokenRes.status})`,
        };
      }

      const userRes = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'NetPlus/1.0',
        },
        signal: AbortSignal.timeout(10_000),
      });
      const userData = (await userRes.json()) as {
        id?: number;
        login?: string;
        name?: string;
        email?: string;
        avatar_url?: string;
      };
      if (!userRes.ok || !userData.id) {
        return { ok: false, flow: pending.flow, error: '未能从 GitHub 获取用户信息' };
      }

      let email = userData.email || undefined;
      if (!email) {
        try {
          const emailRes = await fetch('https://api.github.com/user/emails', {
            headers: {
              Authorization: `Bearer ${tokenData.access_token}`,
              Accept: 'application/vnd.github+json',
              'User-Agent': 'NetPlus/1.0',
            },
            signal: AbortSignal.timeout(8_000),
          });
          if (emailRes.ok) {
            const emails = (await emailRes.json()) as Array<{ email: string; primary?: boolean; verified?: boolean }>;
            const primary =
              emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified) || emails[0];
            email = primary?.email;
          }
        } catch {
          // Optional email lookup
        }
      }

      return {
        ok: true,
        mode: pending.mode,
        flow: pending.flow,
        returnTo,
        actor: pending.actor,
        identity: {
          provider: 'github',
          subject: String(userData.id),
          email,
          displayName: userData.name || userData.login || `github:${userData.id}`,
          avatarUrl: userData.avatar_url,
        },
      };
    }

    if (params.provider === 'google') {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          code: params.code,
          redirect_uri: pending.redirectUri,
          grant_type: 'authorization_code',
          code_verifier: pending.codeVerifier || '',
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        id_token?: string;
        error?: string;
        error_description?: string;
      };
      if (!tokenRes.ok || !tokenData.access_token) {
        return {
          ok: false,
          flow: pending.flow,
          error:
            tokenData.error_description ||
            tokenData.error ||
            `Google token exchange failed (${tokenRes.status})`,
        };
      }

      const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      const info = (await infoRes.json()) as {
        sub?: string;
        email?: string;
        email_verified?: boolean;
        name?: string;
        picture?: string;
      };
      if (!infoRes.ok || !info.sub) {
        return { ok: false, flow: pending.flow, error: '未能从 Google 获取用户信息' };
      }
      return {
        ok: true,
        mode: pending.mode,
        flow: pending.flow,
        returnTo,
        actor: pending.actor,
        identity: {
          provider: 'google',
          subject: info.sub,
          email: info.email,
          emailVerified: info.email_verified === true,
          displayName: info.name || info.email || 'Google User',
          avatarUrl: info.picture,
        },
      };
    }

    // Apple Sign In token exchange
    const clientSecret = createAppleClientSecret(creds);
    const tokenRes = await fetch('https://appleid.apple.com/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: creds.clientId,
        client_secret: clientSecret,
        code: params.code,
        grant_type: 'authorization_code',
        redirect_uri: pending.redirectUri,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const tokenData = (await tokenRes.json()) as {
      id_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!tokenRes.ok || !tokenData.id_token) {
      return {
        ok: false,
        flow: pending.flow,
        error:
          tokenData.error_description ||
          tokenData.error ||
          `Apple token exchange failed (${tokenRes.status})`,
      };
    }

    const claims = decodeJwtPayload(tokenData.id_token);
    const subject = String(claims.sub || '').trim();
    if (!subject) {
      return { ok: false, flow: pending.flow, error: '未能从 Apple ID Token 解析用户标识 (sub)' };
    }

    let displayName: string | undefined;
    if (params.appleUserJson) {
      try {
        const parsedUser = JSON.parse(params.appleUserJson) as {
          name?: { firstName?: string; lastName?: string };
        };
        const full = [parsedUser.name?.firstName, parsedUser.name?.lastName].filter(Boolean).join(' ').trim();
        if (full) displayName = full;
      } catch {
        // Ignore optional Apple user JSON
      }
    }

    const email = typeof claims.email === 'string' ? claims.email : undefined;
    return {
      ok: true,
      mode: pending.mode,
      flow: pending.flow,
      returnTo,
      actor: pending.actor,
      identity: {
        provider: 'apple',
        subject,
        email,
        displayName: displayName || email || `Apple ID (${subject.slice(0, 8)})`,
      },
    };
  } catch (err) {
    return {
      ok: false,
      flow: pending.flow,
      error: err instanceof Error ? err.message : 'OAuth 授权交换失败',
    };
  }
}

export function renderOAuthPopupResultHtml(payload: {
  ok: boolean;
  mode: 'login' | 'bind';
  provider: OAuthProviderId;
  token?: string;
  username?: string;
  expiresAt?: number;
  boundAccount?: { email?: string; displayName?: string };
  account?: { email?: string; displayName?: string };
  returnTo?: string;
  error?: string;
}): string {
  const normalizedPayload = {
    ...payload,
    account: payload.account || payload.boundAccount,
    boundAccount: payload.boundAccount || payload.account,
    returnTo: sanitizeSafeReturnPath(payload.returnTo),
  };
  // Serialize safely for embedding inside <script> (prevent </script> injection)
  const safeJson = JSON.stringify(normalizedPayload).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  const title = payload.ok
    ? payload.mode === 'bind'
      ? '账号绑定成功'
      : '授权登录成功'
    : '授权未完成';
  const subtitle = payload.ok
    ? '正在返回 NetPulse 控制台，此窗口将自动关闭…'
    : String(payload.error || '请关闭此窗口后重试').replace(/[<>&"']/g, (ch) =>
        ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[ch] || ch)
      );

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${title} - NetPulse</title>
  <style>
    body { margin: 0; font-family: "DM Sans", system-ui, -apple-system, sans-serif; background: #020617; color: #f1f5f9; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
    .card { max-width: 420px; width: 100%; background: #0f172a; border: 1px solid #1e293b; border-radius: 12px; padding: 24px; text-align: center; }
    h1 { margin: 0 0 8px; font-size: 18px; color: ${payload.ok ? '#34d399' : '#fb7185'}; }
    p { margin: 0; font-size: 13px; color: #94a3b8; line-height: 1.6; word-break: break-word; }
    a { display: inline-block; margin-top: 16px; padding: 8px 16px; border-radius: 8px; background: #2563eb; color: #ffffff; text-decoration: none; font-size: 13px; font-weight: 600; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${subtitle}</p>
    ${!payload.ok ? '<a href="/?local=1">返回登录页</a>' : ''}
  </div>
  <script>
    (function () {
      var data = ${safeJson};
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage({ type: data.ok ? 'OAUTH_AUTH_SUCCESS' : 'OAUTH_AUTH_ERROR', payload: data }, window.location.origin);
          if (data.ok) {
            setTimeout(function () { window.close(); }, 350);
          }
          return;
        }
      } catch (e) {}
      if (data.ok) {
        window.location.replace(data.returnTo || '/');
      }
    })();
  </script>
</body>
</html>`;
}
