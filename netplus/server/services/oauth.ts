import crypto from 'node:crypto';
import type { Request } from 'express';
import type { OAuthProviderId, OAuthProviderPublicConfig } from '../../src/types/models.ts';
import { store } from '../lib/store.ts';

export const OAUTH_PROVIDERS: OAuthProviderId[] = ['microsoft', 'github', 'google', 'apple'];

export function isOAuthProviderId(value: string): value is OAuthProviderId {
  return (OAUTH_PROVIDERS as string[]).includes(value);
}

interface ResolvedOAuthCredentials {
  provider: OAuthProviderId;
  enabled: boolean;
  configured: boolean;
  envManaged: boolean;
  clientId: string;
  clientSecret: string;
  tenantId: string;
  teamId: string;
  keyId: string;
  privateKey: string;
  secretPreview?: string;
}

interface PendingOAuthState {
  provider: OAuthProviderId;
  mode: 'login' | 'bind';
  redirectUri: string;
  codeVerifier?: string;
  createdAt: number;
  expiresAt: number;
  actor?: string;
}

const pendingStates = new Map<string, PendingOAuthState>();

function prunePendingStates() {
  const now = Date.now();
  for (const [key, item] of pendingStates.entries()) {
    if (item.expiresAt <= now) {
      pendingStates.delete(key);
    }
  }
}

export function resolveOAuthCredentials(provider: OAuthProviderId): ResolvedOAuthCredentials {
  const stored = store.getState().oauthProviders.find((p) => p.provider === provider);
  const decrypted = store.getOAuthProviderDecryptedSecrets(provider);

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

  const envManaged = Boolean(envClientId && (provider === 'apple' ? envTeamId && envKeyId && envPrivateKey : envClientSecret));
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
    return {
      provider,
      enabled: stored ? Boolean(stored.enabled) : resolved.envManaged,
      configured: resolved.configured,
      envManaged: resolved.envManaged,
      clientId: resolved.clientId || undefined,
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
  return `${resolveAppBaseUrl(req)}/api/auth/oauth/${provider}/callback`;
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length < 2) return {};
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
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

export function createOAuthAuthorizationUrl(params: {
  req: Request;
  provider: OAuthProviderId;
  mode: 'login' | 'bind';
  actor?: string;
}): { ok: true; url: string; callbackUri: string } | { ok: false; error: string } {
  prunePendingStates();
  const creds = resolveOAuthCredentials(params.provider);
  if (!creds.configured) {
    return {
      ok: false,
      error: `${params.provider.toUpperCase()} OAuth 尚未配置 Client ID / Secret，请先在「安全与容器设置」中配置凭据`,
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
  let codeVerifier: string | undefined;
  let codeChallenge: string | undefined;

  if (params.provider === 'microsoft' || params.provider === 'google') {
    codeVerifier = base64UrlEncode(crypto.randomBytes(32));
    codeChallenge = base64UrlEncode(crypto.createHash('sha256').update(codeVerifier).digest());
  }

  pendingStates.set(state, {
    provider: params.provider,
    mode: params.mode,
    redirectUri,
    codeVerifier,
    createdAt: Date.now(),
    expiresAt: Date.now() + 10 * 60_000,
    actor: params.actor,
  });

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
    callbackUri: redirectUri,
    url: `https://appleid.apple.com/auth/authorize?${q.toString()}`,
  };
}

export interface VerifiedOAuthIdentity {
  provider: OAuthProviderId;
  subject: string;
  email?: string;
  displayName?: string;
  avatarUrl?: string;
}

export async function completeOAuthCallback(params: {
  provider: OAuthProviderId;
  code: string;
  state: string;
  appleUserJson?: string;
}): Promise<
  | { ok: true; mode: 'login' | 'bind'; actor?: string; identity: VerifiedOAuthIdentity }
  | { ok: false; error: string }
> {
  prunePendingStates();
  const pending = pendingStates.get(params.state);
  if (!pending || pending.provider !== params.provider) {
    return { ok: false, error: 'OAuth state 无效或已过期，请重新发起授权' };
  }
  pendingStates.delete(params.state);

  const creds = resolveOAuthCredentials(params.provider);
  if (!creds.configured) {
    return { ok: false, error: `${params.provider.toUpperCase()} OAuth 凭据未配置` };
  }

  try {
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
          error: tokenData.error_description || tokenData.error || `Microsoft token exchange failed (${tokenRes.status})`,
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
        return { ok: false, error: '未能从 Microsoft 获取用户唯一标识 (sub/oid)' };
      }
      const email = String(
        profile.mail || profile.userPrincipalName || idClaims.preferred_username || idClaims.email || ''
      ).trim() || undefined;
      const displayName = String(profile.displayName || idClaims.name || email || 'Microsoft User').trim();

      return {
        ok: true,
        mode: pending.mode,
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
          error: tokenData.error_description || tokenData.error || `GitHub token exchange failed (${tokenRes.status})`,
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
        return { ok: false, error: '未能从 GitHub 获取用户信息' };
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
            const primary = emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified) || emails[0];
            email = primary?.email;
          }
        } catch {
          // Optional email lookup
        }
      }

      return {
        ok: true,
        mode: pending.mode,
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
          error: tokenData.error_description || tokenData.error || `Google token exchange failed (${tokenRes.status})`,
        };
      }

      const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      const info = (await infoRes.json()) as {
        sub?: string;
        email?: string;
        name?: string;
        picture?: string;
      };
      if (!infoRes.ok || !info.sub) {
        return { ok: false, error: '未能从 Google 获取用户信息' };
      }
      return {
        ok: true,
        mode: pending.mode,
        actor: pending.actor,
        identity: {
          provider: 'google',
          subject: info.sub,
          email: info.email,
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
        error: tokenData.error_description || tokenData.error || `Apple token exchange failed (${tokenRes.status})`,
      };
    }

    const claims = decodeJwtPayload(tokenData.id_token);
    const subject = String(claims.sub || '').trim();
    if (!subject) {
      return { ok: false, error: '未能从 Apple ID Token 解析用户标识 (sub)' };
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
  error?: string;
}): string {
  // Serialize safely for embedding inside <script> (prevent </script> injection)
  const safeJson = JSON.stringify(payload).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  const title = payload.ok
    ? payload.mode === 'bind'
      ? '账号绑定成功'
      : '授权登录成功'
    : '授权未完成';
  const subtitle = payload.ok
    ? '正在返回 NetPlus 控制台，此窗口将自动关闭…'
    : String(payload.error || '请关闭此窗口后重试').replace(/[<>&"']/g, (ch) =>
        ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[ch] || ch)
      );

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${title} - NetPlus</title>
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #090c14; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
    .card { max-width: 420px; width: 100%; background: #111827; border: 1px solid #1e293b; border-radius: 16px; padding: 24px; text-align: center; }
    h1 { margin: 0 0 8px; font-size: 18px; color: ${payload.ok ? '#34d399' : '#fb7185'}; }
    p { margin: 0; font-size: 13px; color: #94a3b8; line-height: 1.6; word-break: break-word; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${subtitle}</p>
  </div>
  <script>
    (function () {
      var data = ${safeJson};
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage({ type: data.ok ? 'OAUTH_AUTH_SUCCESS' : 'OAUTH_AUTH_ERROR', payload: data }, '*');
        }
      } catch (e) {}
      if (data.ok) {
        setTimeout(function () { window.close(); }, 350);
      }
    })();
  </script>
</body>
</html>`;
}
