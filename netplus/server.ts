import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import express, { type NextFunction, type Request, type Response } from 'express';
import type {
  CronIpSyncPolicy,
  CronJob,
  CronJobType,
  DnsIpv6Target,
  DnsSyncRule,
  ExternalCloudProvider,
  IpPolicyAction,
  IpPolicyTargetScope,
  ManagedDnsRecord,
  ManagedDomain,
  ManagedIpRecord,
  MonitorCheckSample,
  MonitorTarget,
  NotificationEventType,
  OAuthProviderId,
  OciInstanceAction,
  OverviewSummary,
  SecurityConfig,
} from './src/types/models.ts';
import { antiBotGuard } from './server/lib/captcha.ts';
import { computeNextCronRun, isValidCronExpression } from './server/lib/cron.ts';
import { generateToken, getEncryptionKeyInfo, validateSafeExternalUrl } from './server/lib/crypto.ts';
import {
  getHostLinkedRuleIds,
  setHostLinkedRuleIds,
  store,
  type PersistedSessionRecord,
  type StoredCloudAccount,
  type StoredCloudHost,
  type StoredDnsProvider,
  type StoredNotificationChannel,
  type StoredOAuthProviderConfig,
  type StoredOciProfile,
  type StoredOciSniperTask,
} from './server/lib/store.ts';
import {
  checkDomainNsDelegation,
  createProviderDnsRecord,
  createProviderDomain,
  deleteProviderDnsRecord,
  detectPublicIps,
  executeDnsSyncRule,
  listCloudflareZones,
  listProviderDomains,
  type DnsRuleSyncReport,
  pullProviderDnsRecords,
  resolveCloudflareZoneId,
  updateProviderDnsRecord,
  validateDnsRecordInput,
} from './server/services/dnsSync.ts';
import { probeTcp, runMonitorCheck } from './server/services/monitor.ts';
import {
  buildOAuthCallbackUri,
  completeOAuthCallback,
  createOAuthAuthorizationUrl,
  getPublicOAuthStatus,
  isOAuthProviderId,
  listOAuthProviderConfigs,
  renderOAuthPopupResultHtml,
} from './server/services/oauth.ts';
import {
  CLOUD_INSTANCE_ID_REGEX,
  cloudHostAddIpv4,
  cloudHostAddIpv6,
  cloudHostDeleteIpv4,
  cloudHostDeleteIpv6,
  cloudHostPowerAction,
  cloudHostSwapIpv4,
  GCP_ZONE_REGEX,
  getCloudHostDetail,
  listCloudAccountInstances,
  mapCloudStateToHostStatus,
  parseGcpServiceAccountJson,
  testCloudAccount,
  validateCloudRegion,
} from './server/services/multiCloudClient.ts';
import { dispatchSystemNotification, testNotificationChannel } from './server/services/notifier.ts';
import {
  computeOciFingerprint,
  discoverOciInstanceVnics,
  discoverOciResources,
  generateEd25519SshKeypair,
  getOciInstanceDetail,
  inspectOciVnicIps,
  isValidOcid,
  listOciImages,
  listOciInstancesDetailed,
  normalizeOciPem,
  sanitizeOcid,
  mapOciStateToHostStatus,
  ociAddIpv6ToVnic,
  ociAllocatePublicIpv4,
  ociDeleteIpv6,
  ociDeletePublicIpv4,
  ociInstancePowerAction,
  ociSwapPublicIpv4,
} from './server/services/ociClient.ts';
import {
  autoResolveSniperParams,
  generateStandaloneOciScript,
  runOciSniperAttempt,
} from './server/services/ociSniper.ts';
import { runCronJobNow, schedulerEngine } from './server/services/scheduler.ts';
import { tlsManager } from './server/services/tlsManager.ts';
import { fileURLToPath, pathToFileURL } from 'node:url';

dotenv.config();

export interface ServerHookContext {
  createSession: (username: string, ip: string) => { token: string; expiresAt: string; expiresAtMs: number };
  setSessionCookie: (req: Request, res: Response, token: string, expiresAtMs: number) => void;
  getClientIp: (req: Request) => string;
}

export interface CreateServerOptions {
  configureApp?: (app: express.Express, ctx: ServerHookContext) => void;
}

type ActiveSession = PersistedSessionRecord;

const SESSION_COOKIE_NAME = 'netplus_sid';
const sessions = new Map<string, ActiveSession>();

// Hydrate persisted sessions so logins survive page refresh and server/container restart
for (const saved of store.loadSessions()) {
  sessions.set(saved.token, saved);
}

function persistSessionsToDisk() {
  try {
    store.saveSessions(Array.from(sessions.values()));
  } catch {
    // Non-fatal persistence warning
  }
}

const OCI_REGION_REGEX = /^[a-z]{2}-[a-z0-9-]+-\d+$/;
const VALID_NOTIFY_EVENTS: NotificationEventType[] = [
  'oci_sniper_success',
  'oci_sniper_error',
  'monitor_down',
  'monitor_recover',
  'dns_sync_fail',
  'ip_changed',
  'audit_prune',
  'security_lockout',
];

setInterval(() => {
  const now = Date.now();
  let removed = false;
  for (const [token, s] of sessions.entries()) {
    if (now > s.expiresAt) {
      sessions.delete(token);
      removed = true;
    }
  }
  if (removed) persistSessionsToDisk();
}, 60_000).unref();

interface AuthedRequest extends Request {
  sessionUser?: string;
  sessionToken?: string;
}

function getClientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '127.0.0.1';
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

function isHttpsRequest(req: Request): boolean {
  if (req.secure) return true;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

function setSessionCookie(req: Request, res: Response, token: string, expiresAtMs: number) {
  const maxAgeSec = Math.max(60, Math.floor((expiresAtMs - Date.now()) / 1000));
  const secure = isHttpsRequest(req);
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) {
    // Required for HTTPS iframe contexts (e.g. AI Studio preview) as well as standard HTTPS
    parts.push('Secure', 'SameSite=None', 'Partitioned');
  } else {
    parts.push('SameSite=Lax');
  }
  res.append('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(req: Request, res: Response) {
  const secure = isHttpsRequest(req);
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
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

function extractAuthToken(req: Request): { token: string | null; source: 'bearer' | 'cookie' | 'none' } {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token) return { token, source: 'bearer' };
  }
  const cookies = parseCookies(req);
  const cookieToken = cookies[SESSION_COOKIE_NAME]?.trim();
  if (cookieToken) {
    return { token: cookieToken, source: 'cookie' };
  }
  return { token: null, source: 'none' };
}

function passesCookieCsrfCheck(req: Request): boolean {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  if (String(req.headers['x-requested-with'] || '') === 'NetPlus') return true;
  const origin = String(req.headers.origin || '').trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (origin && host) {
    try {
      const parsed = new URL(origin);
      if (parsed.host === host) return true;
    } catch {
      return false;
    }
  }
  return false;
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const extracted = extractAuthToken(req);
  if (!extracted.token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  if (extracted.source === 'cookie' && !passesCookieCsrfCheck(req)) {
    res.status(403).json({ error: 'CSRF validation failed' });
    return;
  }
  const session = sessions.get(extracted.token);
  if (!session || Date.now() > session.expiresAt) {
    if (session) {
      sessions.delete(extracted.token);
      persistSessionsToDisk();
    }
    res.status(401).json({ error: 'Session expired or invalid' });
    return;
  }
  const timeoutMs = Math.max(10, store.getState().security.sessionTimeoutMinutes) * 60_000;
  const now = Date.now();
  // Throttle disk writes when sliding expiration
  if (session.expiresAt - now < timeoutMs * 0.85) {
    session.expiresAt = now + timeoutMs;
    persistSessionsToDisk();
  } else {
    session.expiresAt = now + timeoutMs;
  }
  req.sessionUser = session.username;
  req.sessionToken = extracted.token;
  next();
}

function createSession(
  username: string,
  ip: string,
  loginMethod = 'password'
): { token: string; expiresAt: string; expiresAtMs: number } {
  const token = generateToken(36);
  const timeoutMs = Math.max(10, store.getState().security.sessionTimeoutMinutes) * 60_000;
  const expiresAtMs = Date.now() + timeoutMs;
  sessions.set(token, {
    token,
    username,
    ip,
    createdAt: Date.now(),
    expiresAt: expiresAtMs,
    loginMethod,
  });
  persistSessionsToDisk();
  return { token, expiresAt: new Date(expiresAtMs).toISOString(), expiresAtMs };
}

function sanitizeIpv6List(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const v = String(item ?? '').trim().replace(/\/128$/, '');
    if (!v || !net.isIPv6(v)) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function sanitizeEvents(raw: unknown): NotificationEventType[] {
  if (!Array.isArray(raw)) return ['oci_sniper_success', 'monitor_down', 'monitor_recover'];
  return raw.filter((e): e is NotificationEventType =>
    VALID_NOTIFY_EVENTS.includes(e as NotificationEventType)
  );
}

export async function createServer(options: CreateServerOptions = {}) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  // Healthcheck for Docker & orchestrators
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      httpsListening: tlsManager.inspectStatus().httpsListening,
      timestamp: new Date().toISOString(),
    });
  });

  // ---- Auth & Anti-Bot Endpoints ----
  app.get('/api/auth/status', (req, res) => {
    const { token } = extractAuthToken(req);
    const session = token ? sessions.get(token) : undefined;
    const validSession = session && Date.now() <= session.expiresAt ? session : undefined;
    const sec = store.getState().security;
    res.json({
      envManagedAdmin: store.isEnvAdminConfigured(),
      authenticated: Boolean(validSession),
      username: validSession?.username,
      oauthProviders: getPublicOAuthStatus(),
      security: {
        captchaDifficulty: sec.captchaDifficulty,
        powDifficulty: sec.powDifficulty,
        requireSliderVerify: sec.requireSliderVerify,
        minFormDwellMs: sec.minFormDwellMs,
      },
    });
  });

  app.get('/api/auth/captcha', (req, res) => {
    const ip = getClientIp(req);
    const sec = store.getState().security;
    const rl = antiBotGuard.checkRateLimit(`captcha:${ip}`, sec.rateLimitWindowSeconds, sec.rateLimitMaxRequests);
    if (!rl.allowed) {
      res.setHeader('Retry-After', String(rl.retryAfterSec));
      res.status(429).json({ error: 'RATE_LIMITED', retryAfterSec: rl.retryAfterSec });
      return;
    }
    const challenge = antiBotGuard.createChallenge(ip, sec);
    res.json(challenge);
  });

  // Note: Public first-run web bootstrap endpoint has been removed for security.
  // Admin credentials are always initialized on first startup (from ADMIN_USERNAME/ADMIN_PASSWORD
  // or auto-generated strong random password printed once to container logs).

  app.post('/api/auth/login', async (req, res) => {
    const ip = getClientIp(req);
    const sec = store.getState().security;

    const lockout = antiBotGuard.checkLockout(ip);
    if (lockout.locked) {
      res.setHeader('Retry-After', String(lockout.retryAfterSec));
      res.status(429).json({ error: 'ACCOUNT_LOCKED', retryAfterSec: lockout.retryAfterSec });
      return;
    }

    const rl = antiBotGuard.checkRateLimit(`login:${ip}`, sec.rateLimitWindowSeconds, sec.rateLimitMaxRequests);
    if (!rl.allowed) {
      res.setHeader('Retry-After', String(rl.retryAfterSec));
      store.appendAudit({
        category: 'security',
        severity: 'warning',
        action: 'LOGIN_RATE_LIMITED',
        actor: 'anonymous',
        ip,
        details: `Rate limit triggered (${sec.rateLimitMaxRequests} req / ${sec.rateLimitWindowSeconds}s)`,
      });
      res.status(429).json({ error: 'RATE_LIMITED', retryAfterSec: rl.retryAfterSec });
      return;
    }

    const { username, password, challengeId, captchaAnswer, powNonce, sliderValue, honeypot } = req.body ?? {};
    const verification = antiBotGuard.verifyChallenge({
      challengeId: String(challengeId ?? ''),
      answer: String(captchaAnswer ?? ''),
      powNonce: String(powNonce ?? ''),
      sliderValue,
      honeypot,
      ip,
      config: sec,
    });

    if (!verification.ok) {
      const failState = antiBotGuard.recordLoginFailure(ip, sec.maxLoginAttempts, sec.lockoutMinutes);
      store.appendAudit({
        category: 'auth',
        severity: 'warning',
        action: 'LOGIN_CAPTCHA_FAILED',
        actor: String(username ?? 'unknown'),
        ip,
        details: `Anti-bot check failed (${verification.code}); attempts left: ${failState.attemptsLeft}`,
      });
      res.status(400).json({
        error: verification.code,
        attemptsLeft: failState.attemptsLeft,
        retryAfterSec: failState.retryAfterSec,
      });
      return;
    }

    const credCheck = store.verifyAdminCredentials(String(username ?? ''), String(password ?? ''));
    if (!credCheck.ok) {
      const failState = antiBotGuard.recordLoginFailure(ip, sec.maxLoginAttempts, sec.lockoutMinutes);
      store.appendAudit({
        category: 'auth',
        severity: failState.locked ? 'error' : 'warning',
        action: failState.locked ? 'LOGIN_LOCKED_OUT' : 'LOGIN_INVALID_CREDENTIALS',
        actor: String(username ?? 'unknown'),
        ip,
        details: failState.locked
          ? `IP locked for ${failState.retryAfterSec}s after exceeding max failed attempts`
          : `Invalid credentials; ${failState.attemptsLeft} attempt(s) remaining`,
      });
      if (failState.locked) {
        void dispatchSystemNotification({
          event: 'security_lockout',
          title: 'Security Lockout Triggered',
          message: `Client IP ${ip} was temporarily locked for ${failState.retryAfterSec}s after repeated failed login attempts.`,
          actor: 'security',
          ip,
        });
      }
      res.status(failState.locked ? 429 : 401).json({
        error: failState.locked ? 'ACCOUNT_LOCKED' : 'INVALID_CREDENTIALS',
        attemptsLeft: failState.attemptsLeft,
        retryAfterSec: failState.retryAfterSec,
      });
      return;
    }

    antiBotGuard.clearLoginFailures(ip);
    const sess = createSession(credCheck.canonicalUsername, ip, 'password');
    setSessionCookie(req, res, sess.token, sess.expiresAtMs);
    store.appendAudit({
      category: 'auth',
      severity: 'success',
      action: 'LOGIN_SUCCESS',
      actor: credCheck.canonicalUsername,
      ip,
      details: 'Verified username, password, distorted CAPTCHA, PoW, and human interaction check',
    });

    res.json({ token: sess.token, username: credCheck.canonicalUsername, expiresAt: sess.expiresAt });
  });

  app.post('/api/auth/logout', requireAuth, (req: AuthedRequest, res) => {
    if (req.sessionToken) {
      sessions.delete(req.sessionToken);
      persistSessionsToDisk();
    }
    clearSessionCookie(req, res);
    store.appendAudit({
      category: 'auth',
      severity: 'info',
      action: 'LOGOUT',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      details: 'Administrator signed out and invalidated session cookie/token',
    });
    res.json({ ok: true });
  });

  // ---- Third-Party OAuth Login & Admin Account Binding (Microsoft / GitHub / Google / Apple) ----
  app.get('/api/auth/oauth/providers', (_req, res) => {
    res.json({ providers: getPublicOAuthStatus() });
  });

  app.get('/api/security/oauth', requireAuth, (req, res) => {
    const providers = listOAuthProviderConfigs().map((p) => ({
      ...p,
      callbackUri: buildOAuthCallbackUri(req, p.provider),
    }));
    res.json({
      providers,
      bindings: store.getState().boundOAuthAccounts,
    });
  });

  app.put('/api/security/oauth/:provider', requireAuth, (req: AuthedRequest, res) => {
    const providerParam = String(req.params.provider || '').toLowerCase();
    if (!isOAuthProviderId(providerParam)) {
      res.status(400).json({ error: 'Unsupported OAuth provider' });
      return;
    }
    const b = req.body ?? {};
    const state = store.getState();
    let cfg = state.oauthProviders.find((p) => p.provider === providerParam);
    if (!cfg) {
      cfg = { provider: providerParam, enabled: false };
      state.oauthProviders.push(cfg);
    }
    if (b.enabled !== undefined) cfg.enabled = Boolean(b.enabled);
    if (b.clientId !== undefined) cfg.clientId = String(b.clientId).trim() || undefined;
    if (b.tenantId !== undefined) cfg.tenantId = String(b.tenantId).trim() || 'common';
    if (b.teamId !== undefined) cfg.teamId = String(b.teamId).trim() || undefined;
    if (b.keyId !== undefined) cfg.keyId = String(b.keyId).trim() || undefined;
    store.setOAuthProviderSecrets(cfg, {
      clientSecret: typeof b.clientSecret === 'string' ? b.clientSecret : undefined,
      privateKey: typeof b.privateKey === 'string' ? b.privateKey : undefined,
    });
    cfg.updatedAt = new Date().toISOString();
    store.save();

    store.appendAudit({
      category: 'security',
      severity: 'warning',
      action: 'OAUTH_PROVIDER_UPDATED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: providerParam.toUpperCase(),
      details: `Updated OAuth provider config (enabled=${cfg.enabled})`,
    });

    const updated = listOAuthProviderConfigs().find((p) => p.provider === providerParam);
    res.json({
      provider: updated ? { ...updated, callbackUri: buildOAuthCallbackUri(req, providerParam) } : null,
    });
  });

  app.delete('/api/security/oauth/bindings/:id', requireAuth, (req: AuthedRequest, res) => {
    const list = store.getState().boundOAuthAccounts;
    const idx = list.findIndex((b) => b.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'Bound OAuth account not found' });
      return;
    }
    const [removed] = list.splice(idx, 1);
    store.save();
    store.appendAudit({
      category: 'security',
      severity: 'warning',
      action: 'OAUTH_ACCOUNT_UNBOUND',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${removed.provider}:${removed.email || removed.displayName || removed.subject}`,
      details: 'Administrator unbound external OAuth identity',
    });
    res.json({ ok: true });
  });

  app.get('/api/auth/oauth/:provider/url', (req, res) => {
    const providerParam = String(req.params.provider || '').toLowerCase();
    if (!isOAuthProviderId(providerParam)) {
      res.status(400).json({ error: 'Unsupported OAuth provider' });
      return;
    }
    const mode = req.query.mode === 'bind' ? 'bind' : 'login';
    let actor: string | undefined;

    if (mode === 'bind') {
      const { token } = extractAuthToken(req);
      const sess = token ? sessions.get(token) : undefined;
      if (!sess || Date.now() > sess.expiresAt) {
        res.status(401).json({ error: '请先登录后再绑定第三方账号' });
        return;
      }
      actor = sess.username;
    }

    const built = createOAuthAuthorizationUrl({
      req,
      provider: providerParam,
      mode,
      actor,
    });
    if (!built.ok) {
      res.status(400).json({ error: built.error });
      return;
    }
    res.json({ url: built.url, callbackUri: built.callbackUri });
  });

  const handleOAuthCallback = async (req: Request, res: Response) => {
    const providerParam = String(req.params.provider || '').toLowerCase();
    if (!isOAuthProviderId(providerParam)) {
      res.status(400).send('Unsupported OAuth provider');
      return;
    }

    const queryOrBody = req.method === 'POST' ? (req.body ?? {}) : (req.query ?? {});
    const errCode = String(queryOrBody.error_description || queryOrBody.error || '').trim();
    const code = String(queryOrBody.code || '').trim();
    const state = String(queryOrBody.state || '').trim();
    const appleUserJson = typeof queryOrBody.user === 'string' ? queryOrBody.user : undefined;

    if (errCode) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(
        renderOAuthPopupResultHtml({
          ok: false,
          mode: 'login',
          provider: providerParam,
          error: `授权被取消或拒绝：${errCode}`,
        })
      );
      return;
    }

    if (!code || !state) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(
        renderOAuthPopupResultHtml({
          ok: false,
          mode: 'login',
          provider: providerParam,
          error: '缺少授权码 (code) 或状态参数 (state)',
        })
      );
      return;
    }

    const result = await completeOAuthCallback({
      provider: providerParam,
      code,
      state,
      appleUserJson,
    });

    if (!result.ok) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(
        renderOAuthPopupResultHtml({
          ok: false,
          mode: 'login',
          provider: providerParam,
          error: result.error,
        })
      );
      return;
    }

    const ip = getClientIp(req);
    const appState = store.getState();
    const now = new Date().toISOString();

    if (result.mode === 'bind') {
      const existing = appState.boundOAuthAccounts.find(
        (b) => b.provider === providerParam && b.subject === result.identity.subject
      );
      if (existing) {
        existing.email = result.identity.email || existing.email;
        existing.displayName = result.identity.displayName || existing.displayName;
        existing.avatarUrl = result.identity.avatarUrl || existing.avatarUrl;
      } else {
        appState.boundOAuthAccounts.unshift({
          id: `oauth-${crypto.randomBytes(5).toString('hex')}`,
          provider: providerParam,
          subject: result.identity.subject,
          email: result.identity.email,
          displayName: result.identity.displayName,
          avatarUrl: result.identity.avatarUrl,
          boundAt: now,
        });
      }
      store.save();

      store.appendAudit({
        category: 'security',
        severity: 'success',
        action: 'OAUTH_ACCOUNT_BOUND',
        actor: result.actor || store.getAdminInitSummary().username,
        ip,
        target: `${providerParam}:${result.identity.email || result.identity.displayName || result.identity.subject}`,
        details: 'Bound external OAuth account to administrator console',
      });

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(
        renderOAuthPopupResultHtml({
          ok: true,
          mode: 'bind',
          provider: providerParam,
          boundAccount: {
            email: result.identity.email,
            displayName: result.identity.displayName,
          },
        })
      );
      return;
    }

    // Login mode: ONLY allow accounts explicitly bound by the administrator
    const matched = appState.boundOAuthAccounts.find(
      (b) => b.provider === providerParam && b.subject === result.identity.subject
    );
    if (!matched) {
      store.appendAudit({
        category: 'auth',
        severity: 'warning',
        action: 'OAUTH_LOGIN_UNBOUND_REJECTED',
        actor: result.identity.email || result.identity.displayName || result.identity.subject,
        ip,
        target: providerParam.toUpperCase(),
        details: 'Rejected OAuth sign-in because external identity is not bound to admin',
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(
        renderOAuthPopupResultHtml({
          ok: false,
          mode: 'login',
          provider: providerParam,
          error: `该 ${providerParam.toUpperCase()} 账号 (${result.identity.email || result.identity.displayName || result.identity.subject}) 尚未绑定到管理员账户。请先使用管理员密码登录后，在「安全与容器设置」中绑定此账号。`,
        })
      );
      return;
    }

    matched.lastLoginAt = now;
    if (result.identity.email) matched.email = result.identity.email;
    if (result.identity.displayName) matched.displayName = result.identity.displayName;
    store.save();

    const adminUser = store.getAdminInitSummary().username;
    const sess = createSession(adminUser, ip, `oauth:${providerParam}`);
    setSessionCookie(req, res, sess.token, sess.expiresAtMs);

    store.appendAudit({
      category: 'auth',
      severity: 'success',
      action: 'OAUTH_LOGIN_SUCCESS',
      actor: adminUser,
      ip,
      target: `${providerParam}:${matched.email || matched.displayName || matched.subject}`,
      details: `Signed in via bound ${providerParam.toUpperCase()} account`,
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(
      renderOAuthPopupResultHtml({
        ok: true,
        mode: 'login',
        provider: providerParam,
        token: sess.token,
        username: adminUser,
        expiresAt: sess.expiresAtMs,
      })
    );
  };

  app.all(['/api/auth/oauth/:provider/callback', '/api/auth/oauth/:provider/callback/'], (req, res) => {
    void handleOAuthCallback(req, res);
  });

  const handleUpdateCredentials = (req: AuthedRequest, res: express.Response) => {
    if (store.isEnvAdminConfigured()) {
      res.status(400).json({ error: 'ENV_MANAGED_ADMIN' });
      return;
    }
    const { currentPassword, newUsername, newPassword } = req.body ?? {};
    const currentAdminUsername = store.getAdminInitSummary().username;
    const check = store.verifyAdminCredentials(currentAdminUsername, String(currentPassword ?? ''));
    if (!check.ok) {
      res.status(401).json({ error: 'INVALID_CURRENT_PASSWORD' });
      return;
    }

    const rawUser = newUsername !== undefined ? String(newUsername).trim() : '';
    const wantsUsernameChange = Boolean(rawUser) && rawUser !== currentAdminUsername;
    const nextPass = newPassword !== undefined ? String(newPassword) : '';
    const wantsPasswordChange = nextPass.length > 0;

    if (!wantsUsernameChange && !wantsPasswordChange) {
      res.status(400).json({ error: 'NO_CHANGES_REQUESTED' });
      return;
    }

    if (wantsUsernameChange) {
      if (rawUser.length < 3 || rawUser.length > 32 || !/^[a-zA-Z0-9._-]+$/.test(rawUser)) {
        res.status(400).json({ error: 'INVALID_USERNAME' });
        return;
      }
    }

    if (wantsPasswordChange) {
      if (nextPass.length < 8 || nextPass.length > 128) {
        res.status(400).json({ error: 'WEAK_PASSWORD' });
        return;
      }
    }

    const updated = store.updateAdminCredentials({
      newUsername: wantsUsernameChange ? rawUser : undefined,
      newPassword: wantsPasswordChange ? nextPass : undefined,
    });
    if (!updated.ok) {
      res.status(500).json({ error: 'CREDENTIALS_UPDATE_FAILED' });
      return;
    }

    // Keep current session active with updated username; revoke all other sessions
    for (const [tok, sess] of sessions.entries()) {
      if (tok === req.sessionToken) {
        sess.username = updated.username;
      } else {
        sessions.delete(tok);
      }
    }
    persistSessionsToDisk();

    const changedParts: string[] = [];
    if (updated.usernameChanged) changedParts.push(`username: "${currentAdminUsername}" -> "${updated.username}"`);
    if (updated.passwordChanged) changedParts.push('password rotated');

    store.appendAudit({
      category: 'security',
      severity: 'warning',
      action: updated.usernameChanged && !updated.passwordChanged ? 'ADMIN_USERNAME_UPDATED' : 'PASSWORD_ROTATED',
      actor: updated.username,
      ip: getClientIp(req),
      details: `Administrator credentials updated (${changedParts.join(', ')}); other active sessions revoked`,
    });
    console.log(`[NetPlus][Auth] Administrator credentials updated (${changedParts.join(', ')}) from ${getClientIp(req)}`);

    res.json({
      ok: true,
      username: updated.username,
      usernameChanged: updated.usernameChanged,
      passwordChanged: updated.passwordChanged,
    });
  };

  app.post('/api/auth/change-password', requireAuth, handleUpdateCredentials);
  app.post('/api/auth/credentials', requireAuth, handleUpdateCredentials);

  // ---- Overview ----
  app.get('/api/overview', requireAuth, (_req, res) => {
    const state = store.getState();
    const totalIpv4Targets = state.dnsRules.filter((r) => r.syncIpv4 && r.ipv4Address).length;
    const totalIpv6Targets = state.dnsRules.reduce(
      (sum, r) => sum + (r.syncIpv6 ? r.ipv6Targets.filter((t) => t.enabled).length : 0),
      0
    );
    const runningSnipers = state.ociSniperTasks.filter((t) => t.status === 'running').length;
    const totalSniperAttempts = state.ociSniperTasks.reduce((sum, t) => sum + t.attempts, 0);
    const monitorsUp = state.monitors.filter((m) => m.status === 'up').length;
    const monitorsDown = state.monitors.filter((m) => m.status === 'down').length;

    const payload: OverviewSummary = {
      dnsProviders: state.dnsProviders.length,
      dnsRules: state.dnsRules.length,
      totalIpv4Targets,
      totalIpv6Targets,
      ociProfiles: state.ociProfiles.length,
      runningSnipers,
      totalSniperAttempts,
      cloudHosts: state.cloudHosts.length,
      managedIps: state.managedIps.length,
      monitorsTotal: state.monitors.length,
      monitorsUp,
      monitorsDown,
      notificationChannels: state.notificationChannels.filter((c) => c.enabled).length,
      activeCronJobs: state.cronJobs.filter((j) => j.enabled).length,
      tlsStatus: tlsManager.inspectStatus(),
      auditStats: store.getAuditStats(),
      recentLogs: store.readAuditLogs({ limit: 8 }),
      containerInfo: {
        hostname: os.hostname(),
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        uptimeSeconds: Math.round(process.uptime()),
        dataDir: store.getDataDirectory(),
      },
    };
    res.json(payload);
  });

  // ---- Baota /certs:ro TLS Status & Reload ----
  app.get('/api/tls/status', requireAuth, (_req, res) => {
    res.json(tlsManager.inspectStatus());
  });

  app.post('/api/tls/reload', requireAuth, (req: AuthedRequest, res) => {
    const result = tlsManager.reloadContext();
    store.appendAudit({
      category: 'tls',
      severity: result.ok ? 'success' : 'warning',
      action: 'TLS_CERT_RELOAD',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: result.status.certPath || result.status.certDir,
      details: result.message,
    });
    res.json(result);
  });

  app.post('/api/tls/generate', requireAuth, (req: AuthedRequest, res) => {
    const b = req.body ?? {};
    const commonName = typeof b.commonName === 'string' ? b.commonName.trim() : 'netpulse.local';
    const sanDomains = Array.isArray(b.sanDomains)
      ? b.sanDomains.map((v: unknown) => String(v).trim()).filter(Boolean)
      : typeof b.sanDomains === 'string'
      ? b.sanDomains.split(/[\s,;]+/).map((v: string) => v.trim()).filter(Boolean)
      : [];
    const sanIps = Array.isArray(b.sanIps)
      ? b.sanIps.map((v: unknown) => String(v).trim()).filter(Boolean)
      : typeof b.sanIps === 'string'
      ? b.sanIps.split(/[\s,;]+/).map((v: string) => v.trim()).filter(Boolean)
      : [];
    const days = Number(b.days) || 825;

    const result = tlsManager.generateSelfSignedCertificate({
      commonName,
      sanDomains,
      sanIps,
      days,
    });

    store.appendAudit({
      category: 'tls',
      severity: result.ok ? 'success' : 'error',
      action: 'TLS_SELF_SIGNED_GENERATED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: commonName,
      details: result.message,
    });
    res.status(result.ok ? 200 : 500).json(result);
  });

  app.get('/api/tls/cert.pem', requireAuth, (_req, res) => {
    const pem = tlsManager.getActivePublicCertPem();
    if (!pem) {
      res.status(404).json({ error: 'No active certificate available' });
      return;
    }
    res.setHeader('Content-Type', 'application/x-pem-file');
    res.setHeader('Content-Disposition', 'attachment; filename="netpulse-cert.pem"');
    res.send(pem);
  });


  // ---- Unified System Notifications (Email / Server酱 / Telegram / Bark / Discord / Webhook) ----
  app.get('/api/notifications/channels', requireAuth, (_req, res) => {
    res.json(store.getState().notificationChannels.map((c) => store.toPublicNotificationChannel(c)));
  });

  app.post('/api/notifications/channels', requireAuth, (req: AuthedRequest, res) => {
    const b = req.body ?? {};
    if (!b.name || !b.type) {
      res.status(400).json({ error: 'Channel name and type are required' });
      return;
    }
    if (['bark', 'discord', 'webhook'].includes(b.type) && b.target) {
      const check = validateSafeExternalUrl(String(b.target));
      if (!check.valid) {
        res.status(400).json({ error: check.reason });
        return;
      }
    }
    const now = new Date().toISOString();
    const channel: StoredNotificationChannel = {
      id: `notif-${crypto.randomBytes(5).toString('hex')}`,
      name: String(b.name).trim(),
      type: b.type,
      enabled: b.enabled !== false,
      events: sanitizeEvents(b.events),
      smtpHost: b.smtpHost ? String(b.smtpHost).trim() : undefined,
      smtpPort: b.smtpPort ? Number(b.smtpPort) : undefined,
      smtpSecure: b.smtpSecure !== undefined ? Boolean(b.smtpSecure) : undefined,
      smtpUser: b.smtpUser ? String(b.smtpUser).trim() : undefined,
      emailFrom: b.emailFrom ? String(b.emailFrom).trim() : undefined,
      emailTo: b.emailTo ? String(b.emailTo).trim() : undefined,
      serverChanVersion: b.serverChanVersion === 'sc3' ? 'sc3' : 'turbo',
      target: b.target ? String(b.target).trim() : undefined,
      createdAt: now,
      updatedAt: now,
    };
    store.setNotificationSecret(channel, b.secret);
    store.getState().notificationChannels.unshift(channel);
    store.save();

    store.appendAudit({
      category: 'notify',
      severity: 'info',
      action: 'NOTIFY_CHANNEL_CREATED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${channel.name} (${channel.type})`,
      details: `Events: ${channel.events.join(', ')}`,
    });
    res.status(201).json(store.toPublicNotificationChannel(channel));
  });

  app.put('/api/notifications/channels/:id', requireAuth, (req: AuthedRequest, res) => {
    const channel = store.getState().notificationChannels.find((c) => c.id === req.params.id);
    if (!channel) {
      res.status(404).json({ error: 'Notification channel not found' });
      return;
    }
    const b = req.body ?? {};
    const nextType = b.type || channel.type;
    if (['bark', 'discord', 'webhook'].includes(nextType) && b.target) {
      const check = validateSafeExternalUrl(String(b.target));
      if (!check.valid) {
        res.status(400).json({ error: check.reason });
        return;
      }
    }
    if (b.name !== undefined) channel.name = String(b.name).trim();
    if (b.type !== undefined) channel.type = b.type;
    if (b.enabled !== undefined) channel.enabled = Boolean(b.enabled);
    if (Array.isArray(b.events)) channel.events = sanitizeEvents(b.events);
    if (b.smtpHost !== undefined) channel.smtpHost = String(b.smtpHost).trim() || undefined;
    if (b.smtpPort !== undefined) channel.smtpPort = Number(b.smtpPort) || 465;
    if (b.smtpSecure !== undefined) channel.smtpSecure = Boolean(b.smtpSecure);
    if (b.smtpUser !== undefined) channel.smtpUser = String(b.smtpUser).trim() || undefined;
    if (b.emailFrom !== undefined) channel.emailFrom = String(b.emailFrom).trim() || undefined;
    if (b.emailTo !== undefined) channel.emailTo = String(b.emailTo).trim() || undefined;
    if (b.serverChanVersion !== undefined) {
      channel.serverChanVersion = b.serverChanVersion === 'sc3' ? 'sc3' : 'turbo';
    }
    if (b.target !== undefined) channel.target = String(b.target).trim() || undefined;
    store.setNotificationSecret(channel, b.secret);
    channel.updatedAt = new Date().toISOString();
    store.save();

    store.appendAudit({
      category: 'notify',
      severity: 'info',
      action: 'NOTIFY_CHANNEL_UPDATED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${channel.name} (${channel.type})`,
      details: `Enabled=${channel.enabled}, Events=${channel.events.join(',')}`,
    });
    res.json(store.toPublicNotificationChannel(channel));
  });

  app.post('/api/notifications/channels/:id/test', requireAuth, async (req: AuthedRequest, res) => {
    const result = await testNotificationChannel(req.params.id, req.sessionUser || 'admin', getClientIp(req));
    if (!result) {
      res.status(404).json({ error: 'Notification channel not found' });
      return;
    }
    res.json(result);
  });

  app.delete('/api/notifications/channels/:id', requireAuth, (req: AuthedRequest, res) => {
    const list = store.getState().notificationChannels;
    const idx = list.findIndex((c) => c.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'Notification channel not found' });
      return;
    }
    const [removed] = list.splice(idx, 1);
    store.save();
    store.appendAudit({
      category: 'notify',
      severity: 'warning',
      action: 'NOTIFY_CHANNEL_DELETED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${removed.name} (${removed.type})`,
      details: 'Deleted system notification channel',
    });
    res.json({ ok: true });
  });

  // ---- Managed IP Lifecycle (Add / Replace (Swap) / Delete) ----
  app.get('/api/ips', requireAuth, (_req, res) => {
    res.json(store.getState().managedIps);
  });

  app.post('/api/ips', requireAuth, async (req: AuthedRequest, res) => {
    const b = req.body ?? {};
    const rawAddr = String(b.address || '').trim();
    const isV4 = net.isIPv4(rawAddr);
    const isV6 = net.isIPv6(rawAddr);
    if (!isV4 && !isV6) {
      res.status(400).json({ error: 'Valid IPv4 or IPv6 address is required' });
      return;
    }

    const state = store.getState();
    const host = b.hostId ? state.cloudHosts.find((h) => h.id === b.hostId) : undefined;
    const linkedDnsRuleIds: string[] = Array.isArray(b.linkedDnsRuleIds)
      ? b.linkedDnsRuleIds.map(String)
      : [];
    const now = new Date().toISOString();

    const record: ManagedIpRecord = {
      id: `ip-${crypto.randomBytes(5).toString('hex')}`,
      address: rawAddr,
      version: isV4 ? 'ipv4' : 'ipv6',
      label: String(b.label || `${host?.name ?? 'Node'} ${isV4 ? 'IPv4' : 'IPv6'}`).trim(),
      hostId: host?.id,
      hostName: host?.name,
      provider: host?.provider ?? b.provider,
      region: host?.region ?? (b.region ? String(b.region).trim() : undefined),
      linkedDnsRuleIds,
      status: b.status === 'standby' ? 'standby' : 'active',
      notes: b.notes ? String(b.notes).trim() : undefined,
      createdAt: now,
      updatedAt: now,
    };

    // Optionally attach IP directly to the linked Cloud Host & DNS Sync Rules
    if (b.applyToHostAndDns !== false) {
      if (host) {
        if (isV4) {
          host.ipv4 = rawAddr;
        } else if (!host.ipv6List.includes(rawAddr)) {
          host.ipv6List.push(rawAddr);
        }
        host.updatedAt = now;
      }
      for (const ruleId of linkedDnsRuleIds) {
        const rule = state.dnsRules.find((r) => r.id === ruleId);
        if (!rule) continue;
        if (isV4) {
          rule.ipv4Address = rawAddr;
        } else if (!rule.ipv6Targets.some((t) => t.address === rawAddr)) {
          rule.ipv6Targets.push({
            id: `v6-${crypto.randomBytes(4).toString('hex')}`,
            recordName:
              rule.ipv6Mode === 'round_robin'
                ? rule.recordName
                : `v6-${rule.ipv6Targets.length + 1}.${rule.recordName}`,
            address: rawAddr,
            proxied: rule.proxied,
            enabled: true,
            lastStatus: 'pending',
          });
        }
        rule.updatedAt = now;
      }
    }

    state.managedIps.unshift(record);
    store.save();

    if (b.syncDnsNow) {
      for (const ruleId of linkedDnsRuleIds) {
        await executeDnsSyncRule(ruleId, req.sessionUser || 'admin', getClientIp(req));
      }
    }

    store.appendAudit({
      category: 'ip',
      severity: 'info',
      action: 'IP_ADDED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: record.address,
      details: `Added ${record.version.toUpperCase()} (${record.label}) -> host=${record.hostName ?? 'none'}, dnsRules=${linkedDnsRuleIds.length}`,
    });
    res.status(201).json(record);
  });

  // Replace / Swap IP across Host, DNS Rules, and Monitors atomically
  app.post('/api/ips/:id/replace', requireAuth, async (req: AuthedRequest, res) => {
    const state = store.getState();
    const record = state.managedIps.find((x) => x.id === req.params.id);
    if (!record) {
      res.status(404).json({ error: 'IP record not found' });
      return;
    }

    const newAddress = String(req.body?.newAddress || '').trim();
    const valid =
      (record.version === 'ipv4' && net.isIPv4(newAddress)) ||
      (record.version === 'ipv6' && net.isIPv6(newAddress));
    if (!valid) {
      res.status(400).json({ error: `Valid ${record.version.toUpperCase()} address is required` });
      return;
    }

    const oldAddress = record.address;
    const now = new Date().toISOString();
    record.previousAddress = oldAddress;
    record.address = newAddress;
    record.replacedAt = now;
    record.updatedAt = now;

    // 1. Update matching Cloud Hosts
    let hostsUpdated = 0;
    for (const host of state.cloudHosts) {
      if (record.version === 'ipv4' && host.ipv4 === oldAddress) {
        host.ipv4 = newAddress;
        host.updatedAt = now;
        hostsUpdated += 1;
      } else if (record.version === 'ipv6' && host.ipv6List.includes(oldAddress)) {
        host.ipv6List = host.ipv6List.map((a) => (a === oldAddress ? newAddress : a));
        host.updatedAt = now;
        hostsUpdated += 1;
      }
    }

    // 2. Update matching DNS Sync Rules
    const touchedRuleIds = new Set<string>(record.linkedDnsRuleIds);
    let dnsRulesUpdated = 0;
    for (const rule of state.dnsRules) {
      let changed = false;
      if (record.version === 'ipv4' && rule.ipv4Address === oldAddress) {
        rule.ipv4Address = newAddress;
        changed = true;
      } else if (record.version === 'ipv6') {
        for (const t of rule.ipv6Targets) {
          if (t.address === oldAddress) {
            t.address = newAddress;
            t.lastStatus = 'pending';
            changed = true;
          }
        }
      }
      if (changed) {
        rule.updatedAt = now;
        touchedRuleIds.add(rule.id);
        dnsRulesUpdated += 1;
      }
    }

    // 3. Update matching Monitor targets
    let monitorsUpdated = 0;
    for (const mon of state.monitors) {
      let changed = false;
      if (mon.target === oldAddress) {
        mon.target = newAddress;
        changed = true;
      }
      if (mon.expectedIp === oldAddress) {
        mon.expectedIp = newAddress;
        changed = true;
      }
      if (changed) {
        mon.updatedAt = now;
        monitorsUpdated += 1;
      }
    }

    store.save();

    // 4. Optional immediate batch DNS sync for affected rules
    const syncReports: DnsRuleSyncReport[] = [];
    if (req.body?.syncDnsNow !== false) {
      for (const ruleId of touchedRuleIds) {
        const rep = await executeDnsSyncRule(ruleId, req.sessionUser || 'admin', getClientIp(req));
        if (rep) syncReports.push(rep);
      }
    }

    const summary = `Swapped ${oldAddress} -> ${newAddress} (hosts:${hostsUpdated}, dnsRules:${dnsRulesUpdated}, monitors:${monitorsUpdated}, synced:${syncReports.length})`;
    store.appendAudit({
      category: 'ip',
      severity: 'warning',
      action: 'IP_REPLACED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: record.label,
      details: summary,
    });

    if (req.body?.notify !== false) {
      await dispatchSystemNotification({
        event: 'ip_changed',
        title: `IP Replaced: ${record.label}`,
        message: summary,
        actor: req.sessionUser || 'admin',
        ip: getClientIp(req),
      });
    }

    res.json({ record, hostsUpdated, dnsRulesUpdated, monitorsUpdated, syncReports });
  });

  app.delete('/api/ips/:id', requireAuth, (req: AuthedRequest, res) => {
    const state = store.getState();
    const idx = state.managedIps.findIndex((x) => x.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'IP record not found' });
      return;
    }
    const [removed] = state.managedIps.splice(idx, 1);
    const pruneFromRefs = req.query.pruneRefs === 'true';

    if (pruneFromRefs) {
      for (const host of state.cloudHosts) {
        if (removed.version === 'ipv4' && host.ipv4 === removed.address) host.ipv4 = '';
        if (removed.version === 'ipv6') {
          host.ipv6List = host.ipv6List.filter((a) => a !== removed.address);
        }
      }
      for (const rule of state.dnsRules) {
        if (removed.version === 'ipv4' && rule.ipv4Address === removed.address) rule.ipv4Address = '';
        if (removed.version === 'ipv6') {
          rule.ipv6Targets = rule.ipv6Targets.filter((t) => t.address !== removed.address);
        }
      }
    }

    store.save();
    store.appendAudit({
      category: 'ip',
      severity: 'warning',
      action: 'IP_DELETED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: removed.address,
      details: `Deleted ${removed.version.toUpperCase()} (${removed.label}), pruneRefs=${pruneFromRefs}`,
    });
    res.json({ ok: true });
  });

  // ---- Monitoring Targets & Live Probes ----
  app.get('/api/monitors', requireAuth, (_req, res) => {
    res.json(store.getState().monitors);
  });

  app.post('/api/monitors', requireAuth, (req: AuthedRequest, res) => {
    const b = req.body ?? {};
    if (!b.name || !b.type || !b.target) {
      res.status(400).json({ error: 'Name, probe type, and target are required' });
      return;
    }
    if (b.type === 'http') {
      const check = validateSafeExternalUrl(String(b.target));
      if (!check.valid) {
        res.status(400).json({ error: check.reason });
        return;
      }
    }
    const now = new Date().toISOString();
    const notifyOnDown = b.notifyOnDown !== undefined ? Boolean(b.notifyOnDown) : b.notifyOnAlert !== false;
    const notifyOnRecover = b.notifyOnRecover !== undefined ? Boolean(b.notifyOnRecover) : b.notifyOnAlert !== false;
    const mon: MonitorTarget = {
      id: `mon-${crypto.randomBytes(5).toString('hex')}`,
      name: String(b.name).trim(),
      groupName: b.groupName ? String(b.groupName).trim() : undefined,
      type: b.type === 'http' || b.type === 'dns' ? b.type : 'tcp',
      target: String(b.target).trim(),
      port: b.type === 'tcp' ? Math.min(65535, Math.max(1, Number(b.port) || 443)) : undefined,
      expectedIp: b.expectedIp ? String(b.expectedIp).trim() : undefined,
      httpKeyword: b.httpKeyword ? String(b.httpKeyword).trim() : undefined,
      expectedStatusCodes: b.expectedStatusCodes ? String(b.expectedStatusCodes).trim() : undefined,
      intervalSeconds: Math.max(15, Number(b.intervalSeconds) || 60),
      timeoutMs: Math.min(12_000, Math.max(1000, Number(b.timeoutMs) || 5000)),
      failureThreshold: Math.min(10, Math.max(1, Number(b.failureThreshold) || 2)),
      enabled: b.enabled !== false,
      notifyOnAlert: notifyOnDown || notifyOnRecover,
      notifyOnDown,
      notifyOnRecover,
      notifyChannelIds: Array.isArray(b.notifyChannelIds) ? b.notifyChannelIds.map(String) : [],
      linkedHostId: b.linkedHostId || undefined,
      linkedIpId: b.linkedIpId || undefined,
      status: 'pending',
      consecutiveFailures: 0,
      uptimePercent: 100,
      history: [],
      createdAt: now,
      updatedAt: now,
    };
    store.getState().monitors.unshift(mon);
    store.save();

    store.appendAudit({
      category: 'monitor',
      severity: 'info',
      action: 'MONITOR_CREATED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${mon.name} (${mon.type})`,
      details: `Target=${mon.target}${mon.port ? ':' + mon.port : ''}`,
    });
    res.status(201).json(mon);
  });

  app.put('/api/monitors/:id', requireAuth, (req: AuthedRequest, res) => {
    const mon = store.getState().monitors.find((m) => m.id === req.params.id);
    if (!mon) {
      res.status(404).json({ error: 'Monitor not found' });
      return;
    }
    const b = req.body ?? {};
    if ((b.type || mon.type) === 'http' && b.target) {
      const check = validateSafeExternalUrl(String(b.target));
      if (!check.valid) {
        res.status(400).json({ error: check.reason });
        return;
      }
    }
    if (b.name !== undefined) mon.name = String(b.name).trim();
    if (b.groupName !== undefined) mon.groupName = String(b.groupName).trim() || undefined;
    if (b.type !== undefined) mon.type = b.type;
    if (b.target !== undefined) mon.target = String(b.target).trim();
    if (b.port !== undefined) mon.port = Math.min(65535, Math.max(1, Number(b.port) || 443));
    if (b.expectedIp !== undefined) mon.expectedIp = String(b.expectedIp).trim() || undefined;
    if (b.httpKeyword !== undefined) mon.httpKeyword = String(b.httpKeyword).trim() || undefined;
    if (b.expectedStatusCodes !== undefined) mon.expectedStatusCodes = String(b.expectedStatusCodes).trim() || undefined;
    if (b.intervalSeconds !== undefined) mon.intervalSeconds = Math.max(15, Number(b.intervalSeconds) || 60);
    if (b.timeoutMs !== undefined) mon.timeoutMs = Math.min(12_000, Math.max(1000, Number(b.timeoutMs) || 5000));
    if (b.failureThreshold !== undefined) mon.failureThreshold = Math.min(10, Math.max(1, Number(b.failureThreshold) || 2));
    if (b.enabled !== undefined) mon.enabled = Boolean(b.enabled);
    if (b.notifyOnDown !== undefined) mon.notifyOnDown = Boolean(b.notifyOnDown);
    if (b.notifyOnRecover !== undefined) mon.notifyOnRecover = Boolean(b.notifyOnRecover);
    if (b.notifyOnAlert !== undefined) {
      mon.notifyOnAlert = Boolean(b.notifyOnAlert);
      if (b.notifyOnDown === undefined) mon.notifyOnDown = Boolean(b.notifyOnAlert);
      if (b.notifyOnRecover === undefined) mon.notifyOnRecover = Boolean(b.notifyOnAlert);
    } else if (b.notifyOnDown !== undefined || b.notifyOnRecover !== undefined) {
      mon.notifyOnAlert = Boolean(mon.notifyOnDown || mon.notifyOnRecover);
    }
    if (Array.isArray(b.notifyChannelIds)) mon.notifyChannelIds = b.notifyChannelIds.map(String);
    mon.updatedAt = new Date().toISOString();
    store.save();
    res.json(mon);
  });

  app.post('/api/monitors/:id/check', requireAuth, async (req: AuthedRequest, res) => {
    const mon = await runMonitorCheck(req.params.id, req.sessionUser || 'admin', getClientIp(req));
    if (!mon) {
      res.status(404).json({ error: 'Monitor not found' });
      return;
    }
    res.json(mon);
  });

  app.post('/api/monitors/check-all', requireAuth, async (req: AuthedRequest, res) => {
    const targets = store.getState().monitors.filter((m) => m.enabled);
    const updated: MonitorTarget[] = [];
    for (const m of targets) {
      const result = await runMonitorCheck(m.id, req.sessionUser || 'admin', getClientIp(req));
      if (result) updated.push(result);
    }
    res.json({ monitors: updated });
  });

  app.delete('/api/monitors/:id', requireAuth, (req: AuthedRequest, res) => {
    const list = store.getState().monitors;
    const idx = list.findIndex((m) => m.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'Monitor not found' });
      return;
    }
    const [removed] = list.splice(idx, 1);
    store.save();
    store.appendAudit({
      category: 'monitor',
      severity: 'warning',
      action: 'MONITOR_DELETED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: removed.name,
      details: `Removed ${removed.type} monitor (${removed.target})`,
    });
    res.json({ ok: true });
  });

  // ---- DNS Providers & Batch IPv4 / Multi-IPv6 Rules ----
  app.get('/api/dns/providers', requireAuth, (_req, res) => {
    res.json(store.getState().dnsProviders.map((p) => store.toPublicDnsProvider(p)));
  });

  app.post('/api/dns/providers', requireAuth, (req: AuthedRequest, res) => {
    const { name, type, zoneId, domain, endpointUrl, accountEmail, secret, secretId } = req.body ?? {};
    if (!name || !type) {
      res.status(400).json({ error: 'Provider name and type are required' });
      return;
    }
    if (type === 'webhook' && !endpointUrl) {
      res.status(400).json({ error: 'Webhook endpoint URL is required' });
      return;
    }
    if (endpointUrl) {
      const check = validateSafeExternalUrl(String(endpointUrl));
      if (!check.valid) {
        res.status(400).json({ error: check.reason });
        return;
      }
    }
    const now = new Date().toISOString();
    const item: StoredDnsProvider = {
      id: `prov-${crypto.randomBytes(5).toString('hex')}`,
      name: String(name).trim(),
      type,
      zoneId: zoneId ? String(zoneId).trim() : undefined,
      domain: domain ? String(domain).trim() : undefined,
      endpointUrl: endpointUrl ? String(endpointUrl).trim() : undefined,
      accountEmail: accountEmail ? String(accountEmail).trim() : undefined,
      createdAt: now,
      updatedAt: now,
    };
    store.setDnsProviderSecrets(item, secret, secretId);
    store.getState().dnsProviders.unshift(item);
    store.save();

    store.appendAudit({
      category: 'dns',
      severity: 'info',
      action: 'DNS_PROVIDER_CREATED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${item.name} (${item.type})`,
      details: `Saved reusable DNS provider account (${item.secretEncrypted || item.endpointUrl ? 'credentials configured' : 'no secret'})`,
    });
    res.status(201).json(store.toPublicDnsProvider(item));
  });

  app.put('/api/dns/providers/:id', requireAuth, (req: AuthedRequest, res) => {
    const item = store.getState().dnsProviders.find((p) => p.id === req.params.id);
    if (!item) {
      res.status(404).json({ error: 'DNS provider not found' });
      return;
    }
    const { name, type, zoneId, domain, endpointUrl, accountEmail, secret, secretId } = req.body ?? {};
    if (endpointUrl) {
      const check = validateSafeExternalUrl(String(endpointUrl));
      if (!check.valid) {
        res.status(400).json({ error: check.reason });
        return;
      }
    }
    if (name) item.name = String(name).trim();
    if (type) item.type = type;
    if (zoneId !== undefined) item.zoneId = String(zoneId).trim() || undefined;
    if (domain !== undefined) item.domain = String(domain).trim() || undefined;
    if (endpointUrl !== undefined) item.endpointUrl = String(endpointUrl).trim() || undefined;
    if (accountEmail !== undefined) item.accountEmail = String(accountEmail).trim() || undefined;
    store.setDnsProviderSecrets(item, secret, secretId);
    item.updatedAt = new Date().toISOString();
    store.save();

    store.appendAudit({
      category: 'dns',
      severity: 'info',
      action: 'DNS_PROVIDER_UPDATED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${item.name} (${item.type})`,
      details: `Updated provider configuration${secret ? ' & rotated API secret' : ''}`,
    });
    res.json(store.toPublicDnsProvider(item));
  });

  app.get('/api/dns/providers/:id/zones', requireAuth, async (req, res) => {
    const provider = store.getState().dnsProviders.find((p) => p.id === req.params.id);
    if (!provider) {
      res.status(404).json({ error: 'DNS provider not found' });
      return;
    }
    if (provider.type !== 'cloudflare') {
      res.json({ ok: true, zones: [], autoZoneSupported: false });
      return;
    }
    const secrets = store.getDnsProviderSecrets(provider.id);
    if (!secrets.secret) {
      res.json({ ok: false, zones: [], autoZoneSupported: true, error: 'API Token not configured' });
      return;
    }
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const result = await listCloudflareZones(secrets.secret, forceRefresh, provider.accountEmail);
    res.json({ ...result, autoZoneSupported: true });
  });

  app.delete('/api/dns/providers/:id', requireAuth, (req: AuthedRequest, res) => {
    const state = store.getState();
    const idx = state.dnsProviders.findIndex((p) => p.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'DNS provider not found' });
      return;
    }
    const [removed] = state.dnsProviders.splice(idx, 1);
    store.save();
    store.appendAudit({
      category: 'dns',
      severity: 'warning',
      action: 'DNS_PROVIDER_DELETED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: removed.name,
      details: `Deleted DNS provider (${removed.type})`,
    });
    res.json({ ok: true });
  });

  app.get('/api/dns/rules', requireAuth, (_req, res) => {
    res.json(store.getState().dnsRules);
  });

  app.post('/api/dns/rules', requireAuth, async (req: AuthedRequest, res) => {
    const body = req.body ?? {};
    const domain = String(body.domain || '').trim();
    const recordName = String(body.recordName || '@').trim();
    if (!body.providerId || !domain) {
      res.status(400).json({ error: 'Provider and domain are required' });
      return;
    }
    const provider = store.getState().dnsProviders.find((p) => p.id === String(body.providerId));
    if (!provider) {
      res.status(404).json({ error: 'Selected DNS provider not found' });
      return;
    }

    let resolvedZoneId: string | undefined = body.resolvedZoneId
      ? String(body.resolvedZoneId).trim()
      : undefined;

    if (provider.type === 'cloudflare' && !resolvedZoneId) {
      const secrets = store.getDnsProviderSecrets(provider.id);
      if (secrets.secret) {
        const lookup = await resolveCloudflareZoneId(
          secrets.secret,
          domain,
          provider.zoneId,
          provider.accountEmail
        );
        if (lookup.zoneId) resolvedZoneId = lookup.zoneId;
      }
    }

    const now = new Date().toISOString();
    const ipv6Targets: DnsIpv6Target[] = Array.isArray(body.ipv6Targets)
      ? body.ipv6Targets
          .map((t: Partial<DnsIpv6Target>) => ({
            id: t.id || `v6-${crypto.randomBytes(4).toString('hex')}`,
            recordName: String(t.recordName || recordName || '@').trim(),
            address: String(t.address || '').trim(),
            proxied: Boolean(t.proxied),
            enabled: t.enabled !== false,
            lastStatus: 'pending' as const,
          }))
          .filter((t: DnsIpv6Target) => t.address.length > 0)
      : [];

    const autoName = recordName === '@' ? domain : `${recordName}.${domain}`;
    const hasCreds = provider.type === 'webhook' ? Boolean(provider.endpointUrl) : Boolean(provider.secretEncrypted);

    const rule: DnsSyncRule = {
      id: `rule-${crypto.randomBytes(5).toString('hex')}`,
      name: String(body.name || '').trim() || autoName,
      providerId: provider.id,
      domain,
      resolvedZoneId,
      recordName,
      ttl: Math.max(60, Number(body.ttl) || 120),
      proxied: Boolean(body.proxied),
      line: String(body.line || (provider.type === 'dnspod' ? '默认' : 'default')).trim(),
      syncIpv4: body.syncIpv4 !== false,
      ipv4Address: String(body.ipv4Address || '').trim(),
      ipv4Source: body.ipv4Source || 'manual',
      syncIpv6: body.syncIpv6 !== false,
      ipv6Mode: body.ipv6Mode === 'per_host' ? 'per_host' : 'round_robin',
      ipv6Targets,
      linkedHostId: body.linkedHostId || undefined,
      dryRun: body.dryRun !== undefined ? Boolean(body.dryRun) : !hasCreds,
      enabled: body.enabled !== false,
      lastStatus: 'pending',
      createdAt: now,
      updatedAt: now,
    };

    store.getState().dnsRules.unshift(rule);
    store.save();

    store.appendAudit({
      category: 'dns',
      severity: 'info',
      action: 'DNS_RULE_CREATED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${rule.name} (${rule.recordName}.${rule.domain})`,
      details: `Provider=${provider.name}, Zone=${resolvedZoneId || 'auto'}, IPv4=${rule.syncIpv4 ? rule.ipv4Address || 'auto' : 'off'}, IPv6=${rule.ipv6Targets.length}`,
    });
    res.status(201).json(rule);
  });

  app.put('/api/dns/rules/:id', requireAuth, async (req: AuthedRequest, res) => {
    const rule = store.getState().dnsRules.find((r) => r.id === req.params.id);
    if (!rule) {
      res.status(404).json({ error: 'DNS rule not found' });
      return;
    }
    const body = req.body ?? {};
    const domainChanged = body.domain !== undefined && String(body.domain).trim() !== rule.domain;
    const providerChanged = body.providerId !== undefined && String(body.providerId) !== rule.providerId;

    if (body.name !== undefined) rule.name = String(body.name).trim() || rule.name;
    if (body.providerId !== undefined) rule.providerId = String(body.providerId);
    if (body.domain !== undefined) rule.domain = String(body.domain).trim();
    if (body.recordName !== undefined) rule.recordName = String(body.recordName).trim();
    if (body.resolvedZoneId !== undefined) {
      rule.resolvedZoneId = String(body.resolvedZoneId).trim() || undefined;
    } else if (domainChanged || providerChanged) {
      rule.resolvedZoneId = undefined;
    }

    const provider = store.getState().dnsProviders.find((p) => p.id === rule.providerId);
    if (provider?.type === 'cloudflare' && !rule.resolvedZoneId) {
      const secrets = store.getDnsProviderSecrets(provider.id);
      if (secrets.secret) {
        const lookup = await resolveCloudflareZoneId(secrets.secret, rule.domain, provider.zoneId);
        if (lookup.zoneId) rule.resolvedZoneId = lookup.zoneId;
      }
    }

    if (body.ttl !== undefined) rule.ttl = Math.max(60, Number(body.ttl) || 120);
    if (body.proxied !== undefined) rule.proxied = Boolean(body.proxied);
    if (body.line !== undefined) rule.line = String(body.line).trim();
    if (body.syncIpv4 !== undefined) rule.syncIpv4 = Boolean(body.syncIpv4);
    if (body.ipv4Address !== undefined) rule.ipv4Address = String(body.ipv4Address).trim();
    if (body.ipv4Source !== undefined) rule.ipv4Source = body.ipv4Source;
    if (body.syncIpv6 !== undefined) rule.syncIpv6 = Boolean(body.syncIpv6);
    if (body.ipv6Mode !== undefined) rule.ipv6Mode = body.ipv6Mode === 'per_host' ? 'per_host' : 'round_robin';
    if (Array.isArray(body.ipv6Targets)) {
      rule.ipv6Targets = body.ipv6Targets
        .map((t: Partial<DnsIpv6Target>) => ({
          id: t.id || `v6-${crypto.randomBytes(4).toString('hex')}`,
          recordName: String(t.recordName || rule.recordName || '@').trim(),
          address: String(t.address || '').trim(),
          proxied: Boolean(t.proxied),
          enabled: t.enabled !== false,
          lastSyncedAt: t.lastSyncedAt,
          lastStatus: t.lastStatus || 'pending',
          lastMessage: t.lastMessage,
        }))
        .filter((t: DnsIpv6Target) => t.address.length > 0);
    }
    if (body.linkedHostId !== undefined) rule.linkedHostId = body.linkedHostId || undefined;
    if (body.dryRun !== undefined) rule.dryRun = Boolean(body.dryRun);
    if (body.enabled !== undefined) rule.enabled = Boolean(body.enabled);
    rule.updatedAt = new Date().toISOString();
    store.save();

    store.appendAudit({
      category: 'dns',
      severity: 'info',
      action: 'DNS_RULE_UPDATED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: rule.name,
      details: `Updated rule (${rule.ipv6Targets.length} IPv6 targets, dryRun=${rule.dryRun})`,
    });
    res.json(rule);
  });

  app.delete('/api/dns/rules/:id', requireAuth, (req: AuthedRequest, res) => {
    const state = store.getState();
    const idx = state.dnsRules.findIndex((r) => r.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'DNS rule not found' });
      return;
    }
    const [removed] = state.dnsRules.splice(idx, 1);
    for (const h of state.cloudHosts) {
      const ids = getHostLinkedRuleIds(h);
      if (ids.includes(removed.id)) {
        setHostLinkedRuleIds(
          h,
          ids.filter((id) => id !== removed.id)
        );
      }
    }
    store.save();
    store.appendAudit({
      category: 'dns',
      severity: 'warning',
      action: 'DNS_RULE_DELETED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: removed.name,
      details: `Deleted DNS sync rule for ${removed.recordName}.${removed.domain}`,
    });
    res.json({ ok: true });
  });

  app.post('/api/dns/sync', requireAuth, async (req: AuthedRequest, res) => {
    const { ruleIds } = req.body ?? {};
    const state = store.getState();
    const targets =
      Array.isArray(ruleIds) && ruleIds.length > 0
        ? state.dnsRules.filter((r) => ruleIds.includes(r.id))
        : state.dnsRules.filter((r) => r.enabled);

    const reports: DnsRuleSyncReport[] = [];
    for (const rule of targets) {
      const report = await executeDnsSyncRule(rule.id, req.sessionUser || 'admin', getClientIp(req));
      if (report) reports.push(report);
    }
    res.json({ reports });
  });

  app.get('/api/dns/detect-ip', requireAuth, async (_req, res) => {
    const ips = await detectPublicIps();
    res.json(ips);
  });

  // ---- Domain DNS Records Management (Pull from Provider, Manual CRUD, Group Filter & Search) ----
  app.get('/api/dns/providers/:id/domains', requireAuth, async (req, res) => {
    const provider = store.getState().dnsProviders.find((p) => p.id === req.params.id);
    if (!provider) {
      res.status(404).json({ error: 'DNS provider not found' });
      return;
    }
    const secrets = store.getDnsProviderSecrets(provider.id);
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const result = await listProviderDomains(provider, secrets, forceRefresh);
    res.json(result);
  });

  app.get('/api/dns/records', requireAuth, (req, res) => {
    const state = store.getState();
    const providerId = String(req.query.providerId || '').trim();
    const domain = String(req.query.domain || '').trim().toLowerCase();
    const group = String(req.query.group || '').trim();
    const type = String(req.query.type || '').trim().toUpperCase();
    const q = String(req.query.q || '').trim().toLowerCase();

    let list = state.dnsRecords;
    if (providerId && providerId !== 'all') list = list.filter((r) => r.providerId === providerId);
    if (domain && domain !== 'all') list = list.filter((r) => r.domain.toLowerCase() === domain);
    if (group && group !== 'all') list = list.filter((r) => (r.groupName || '默认分组') === group);
    if (type && type !== 'ALL') list = list.filter((r) => r.type === type);
    if (q) {
      list = list.filter((r) =>
        `${r.fqdn} ${r.name} ${r.domain} ${r.type} ${r.content} ${r.groupName} ${r.notes || ''}`
          .toLowerCase()
          .includes(q)
      );
    }
    res.json(list);
  });

  // ---- Managed Domains (Add Domain to DNS Provider + NS Delegation Guide & Verification) ----
  app.get('/api/dns/domains', requireAuth, (_req, res) => {
    res.json(store.getState().managedDomains);
  });

  app.post('/api/dns/domains', requireAuth, async (req: AuthedRequest, res) => {
    const state = store.getState();
    const b = req.body ?? {};
    const providerId = String(b.providerId || '').trim();
    const rawDomain = String(b.domain || '').trim().toLowerCase().replace(/\.$/, '');
    const notes = b.notes ? String(b.notes).trim().slice(0, 500) : undefined;

    const provider = state.dnsProviders.find((p) => p.id === providerId);
    if (!provider) {
      res.status(400).json({ error: '请选择有效的 DNS 服务商' });
      return;
    }

    const secrets = store.getDnsProviderSecrets(provider.id);
    const created = await createProviderDomain(provider, secrets, rawDomain);
    if (!created.ok) {
      res.status(502).json({ error: created.error || created.message || '添加域名失败' });
      return;
    }

    const now = new Date().toISOString();
    let entry = state.managedDomains.find(
      (d) => d.providerId === provider.id && d.domain.toLowerCase() === created.domain.toLowerCase()
    );
    if (entry) {
      entry.zoneId = created.zoneId || entry.zoneId;
      entry.status = created.status || entry.status;
      if (created.nameServers.length > 0) entry.nameServers = created.nameServers;
      if (created.originalNameServers?.length) entry.originalNameServers = created.originalNameServers;
      entry.nsNote = created.nsNote;
      if (notes !== undefined) entry.notes = notes;
      entry.updatedAt = now;
    } else {
      entry = {
        id: `dom-${crypto.randomBytes(5).toString('hex')}`,
        providerId: provider.id,
        domain: created.domain,
        zoneId: created.zoneId,
        status: created.status,
        nameServers: created.nameServers,
        originalNameServers: created.originalNameServers,
        nsNote: created.nsNote,
        notes,
        createdAt: now,
        updatedAt: now,
      };
      state.managedDomains.unshift(entry);
    }

    // Run a quick non-blocking live NS lookup so we immediately know if NS already matches
    const nsCheck = await checkDomainNsDelegation(entry.domain, entry.nameServers);
    entry.currentLiveNs = nsCheck.liveNs;
    entry.nsVerified = nsCheck.verified;
    entry.nsCheckedAt = now;
    if (nsCheck.verified) {
      entry.status = 'active';
    }
    store.save();

    store.appendAudit({
      category: 'dns',
      severity: 'success',
      action: 'DNS_DOMAIN_ADDED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${entry.domain} (${provider.name})`,
      details: `Added domain with NS=[${entry.nameServers.join(', ')}] (verified=${entry.nsVerified})`,
    });

    res.status(201).json({
      domain: entry,
      nameServers: entry.nameServers,
      originalNameServers: entry.originalNameServers,
      currentLiveNs: entry.currentLiveNs,
      nsVerified: entry.nsVerified,
      nsNote: entry.nsNote,
      message: created.message,
    });
  });

  app.post('/api/dns/domains/:id/check-ns', requireAuth, async (req: AuthedRequest, res) => {
    const state = store.getState();
    const entry = state.managedDomains.find((d) => d.id === req.params.id);
    if (!entry) {
      res.status(404).json({ error: '域名记录不存在' });
      return;
    }
    const check = await checkDomainNsDelegation(entry.domain, entry.nameServers);
    const now = new Date().toISOString();
    entry.currentLiveNs = check.liveNs;
    entry.nsVerified = check.verified;
    entry.nsCheckedAt = now;
    if (check.verified) entry.status = 'active';
    entry.updatedAt = now;
    store.save();
    res.json({ domain: entry, check });
  });

  app.delete('/api/dns/domains/:id', requireAuth, (req: AuthedRequest, res) => {
    const state = store.getState();
    const idx = state.managedDomains.findIndex((d) => d.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: '域名记录不存在' });
      return;
    }
    const [removed] = state.managedDomains.splice(idx, 1);
    store.save();
    store.appendAudit({
      category: 'dns',
      severity: 'info',
      action: 'DNS_DOMAIN_REMOVED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: removed.domain,
      details: 'Removed domain from local managed domain list',
    });
    res.json({ ok: true });
  });

  app.post('/api/dns/records/pull', requireAuth, async (req: AuthedRequest, res) => {
    const state = store.getState();
    const b = req.body ?? {};
    const providerId = String(b.providerId || '').trim();
    const domain = String(b.domain || '').trim().toLowerCase().replace(/\.$/, '');
    const zoneId = b.zoneId ? String(b.zoneId).trim() : undefined;
    const defaultGroupName = String(b.defaultGroupName || '').trim() || domain || '默认分组';

    const provider = state.dnsProviders.find((p) => p.id === providerId);
    if (!provider) {
      res.status(404).json({ error: '未找到选中的 DNS 服务商' });
      return;
    }
    const secrets = store.getDnsProviderSecrets(provider.id);
    const pulled = await pullProviderDnsRecords(provider, secrets, domain, zoneId);
    if (!pulled.ok) {
      console.warn(`[NetPlus][DNS] Pull records failed for provider="${provider.name}" (${provider.type}) domain="${domain}": ${pulled.error}`);
      res.status(502).json({ error: pulled.error || '从 DNS 服务商拉取记录失败' });
      return;
    }

    const now = new Date().toISOString();
    const existingForDomain = state.dnsRecords.filter(
      (r) => r.providerId === provider.id && r.domain.toLowerCase() === domain
    );
    const byRemoteId = new Map<string, ManagedDnsRecord>();
    for (const ex of existingForDomain) {
      if (ex.remoteRecordId) byRemoteId.set(ex.remoteRecordId, ex);
    }

    const seenRemoteIds = new Set<string>();
    let addedCount = 0;
    let updatedCount = 0;

    for (const item of pulled.records) {
      seenRemoteIds.add(item.remoteRecordId);
      const existing = byRemoteId.get(item.remoteRecordId);
      if (existing) {
        existing.domain = item.domain;
        existing.zoneId = item.zoneId || pulled.zoneId || existing.zoneId;
        existing.name = item.name;
        existing.fqdn = item.fqdn;
        existing.type = item.type;
        existing.content = item.content;
        existing.ttl = item.ttl;
        existing.proxied = item.proxied;
        existing.priority = item.priority;
        existing.line = item.line;
        existing.source = 'remote_sync';
        existing.syncState = 'synced';
        existing.lastSyncedAt = now;
        existing.updatedAt = now;
        updatedCount += 1;
      } else {
        const rec: ManagedDnsRecord = {
          id: `rec-${crypto.randomBytes(5).toString('hex')}`,
          providerId: provider.id,
          domain: item.domain,
          zoneId: item.zoneId || pulled.zoneId,
          remoteRecordId: item.remoteRecordId,
          name: item.name,
          fqdn: item.fqdn,
          type: item.type,
          content: item.content,
          ttl: item.ttl,
          proxied: item.proxied,
          priority: item.priority,
          line: item.line,
          groupName: defaultGroupName,
          source: 'remote_sync',
          syncState: 'synced',
          lastSyncedAt: now,
          createdAt: now,
          updatedAt: now,
        };
        state.dnsRecords.unshift(rec);
        addedCount += 1;
      }
    }

    // Remove stale remote-synced records for this provider+domain that no longer exist upstream
    const beforeCount = state.dnsRecords.length;
    state.dnsRecords = state.dnsRecords.filter((r) => {
      if (r.providerId !== provider.id || r.domain.toLowerCase() !== domain) return true;
      if (r.source === 'remote_sync' && r.remoteRecordId && !seenRemoteIds.has(r.remoteRecordId)) {
        return false;
      }
      return true;
    });
    const removedCount = beforeCount - state.dnsRecords.length;
    store.save();

    store.appendAudit({
      category: 'dns',
      severity: 'success',
      action: 'DNS_RECORDS_PULLED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${provider.name} / ${domain}`,
      details: `Pulled ${pulled.records.length} live DNS records (added=${addedCount}, updated=${updatedCount}, removed=${removedCount})`,
    });

    res.json({
      ok: true,
      total: pulled.records.length,
      addedCount,
      updatedCount,
      removedCount,
      zoneId: pulled.zoneId,
    });
  });

  app.post('/api/dns/records/pull-all', requireAuth, async (req: AuthedRequest, res) => {
    const state = store.getState();
    const b = req.body ?? {};
    const providerId = String(b.providerId || '').trim();
    const defaultGroupOverride = String(b.defaultGroupName || '').trim();
    const requestedDomains = Array.isArray(b.domains)
      ? b.domains
          .map((d: unknown) => String(d || '').trim().toLowerCase().replace(/\.$/, ''))
          .filter(Boolean)
      : [];

    const provider = state.dnsProviders.find((p) => p.id === providerId);
    if (!provider) {
      res.status(404).json({ error: '未找到选中的 DNS 服务商' });
      return;
    }
    const secrets = store.getDnsProviderSecrets(provider.id);
    const listed = await listProviderDomains(provider, secrets, true);
    if (!listed.ok) {
      console.warn(`[NetPlus][DNS] Pull-all domain list failed for "${provider.name}" (${provider.type}): ${listed.error}`);
      res.status(502).json({ error: listed.error || '拉取服务商域名列表失败' });
      return;
    }

    const targets =
      requestedDomains.length > 0
        ? listed.domains.filter((d) => requestedDomains.includes(d.name.toLowerCase()))
        : listed.domains;

    if (targets.length === 0) {
      res.json({
        ok: true,
        domainCount: 0,
        totalRecords: 0,
        addedCount: 0,
        updatedCount: 0,
        removedCount: 0,
        domains: [],
        errors: [],
      });
      return;
    }

    const now = new Date().toISOString();
    let totalRecords = 0;
    let totalAdded = 0;
    let totalUpdated = 0;
    let totalRemoved = 0;
    const domainSummaries: Array<{ domain: string; count: number; added: number; updated: number; removed: number }> = [];
    const errors: Array<{ domain: string; error: string }> = [];

    for (const dom of targets) {
      const cleanDomain = dom.name.toLowerCase();
      const pulled = await pullProviderDnsRecords(provider, secrets, cleanDomain, dom.id);
      if (!pulled.ok) {
        errors.push({ domain: cleanDomain, error: pulled.error || '拉取失败' });
        continue;
      }

      const existingForDomain = state.dnsRecords.filter(
        (r) => r.providerId === provider.id && r.domain.toLowerCase() === cleanDomain
      );
      const byRemoteId = new Map<string, ManagedDnsRecord>();
      for (const ex of existingForDomain) {
        if (ex.remoteRecordId) byRemoteId.set(ex.remoteRecordId, ex);
      }

      const seenRemoteIds = new Set<string>();
      let added = 0;
      let updated = 0;
      const groupName = defaultGroupOverride || cleanDomain;

      for (const item of pulled.records) {
        seenRemoteIds.add(item.remoteRecordId);
        const existing = byRemoteId.get(item.remoteRecordId);
        if (existing) {
          existing.domain = item.domain;
          existing.zoneId = item.zoneId || pulled.zoneId || existing.zoneId;
          existing.name = item.name;
          existing.fqdn = item.fqdn;
          existing.type = item.type;
          existing.content = item.content;
          existing.ttl = item.ttl;
          existing.proxied = item.proxied;
          existing.priority = item.priority;
          existing.line = item.line;
          existing.source = 'remote_sync';
          existing.syncState = 'synced';
          existing.lastSyncedAt = now;
          existing.updatedAt = now;
          updated += 1;
        } else {
          state.dnsRecords.unshift({
            id: `rec-${crypto.randomBytes(5).toString('hex')}`,
            providerId: provider.id,
            domain: item.domain,
            zoneId: item.zoneId || pulled.zoneId,
            remoteRecordId: item.remoteRecordId,
            name: item.name,
            fqdn: item.fqdn,
            type: item.type,
            content: item.content,
            ttl: item.ttl,
            proxied: item.proxied,
            priority: item.priority,
            line: item.line,
            groupName,
            source: 'remote_sync',
            syncState: 'synced',
            lastSyncedAt: now,
            createdAt: now,
            updatedAt: now,
          });
          added += 1;
        }
      }

      const beforeCount = state.dnsRecords.length;
      state.dnsRecords = state.dnsRecords.filter((r) => {
        if (r.providerId !== provider.id || r.domain.toLowerCase() !== cleanDomain) return true;
        if (r.source === 'remote_sync' && r.remoteRecordId && !seenRemoteIds.has(r.remoteRecordId)) {
          return false;
        }
        return true;
      });
      const removed = beforeCount - state.dnsRecords.length;

      totalRecords += pulled.records.length;
      totalAdded += added;
      totalUpdated += updated;
      totalRemoved += removed;
      domainSummaries.push({
        domain: cleanDomain,
        count: pulled.records.length,
        added,
        updated,
        removed,
      });
    }

    store.save();

    store.appendAudit({
      category: 'dns',
      severity: errors.length > 0 ? 'warning' : 'success',
      action: 'DNS_ALL_DOMAINS_PULLED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${provider.name} (${domainSummaries.length} domains)`,
      details: `Pulled ${totalRecords} records across ${domainSummaries.length} domain(s) (added=${totalAdded}, updated=${totalUpdated}, removed=${totalRemoved}, errors=${errors.length})`,
    });

    res.json({
      ok: true,
      domainCount: domainSummaries.length,
      totalRecords,
      addedCount: totalAdded,
      updatedCount: totalUpdated,
      removedCount: totalRemoved,
      domains: domainSummaries,
      errors,
    });
  });

  app.post('/api/dns/records', requireAuth, async (req: AuthedRequest, res) => {
    const state = store.getState();
    const b = req.body ?? {};
    const providerId = String(b.providerId || '').trim();
    const provider = state.dnsProviders.find((p) => p.id === providerId);
    if (!provider) {
      res.status(400).json({ error: '请选择有效的 DNS 服务商' });
      return;
    }

    const validated = validateDnsRecordInput({
      domain: String(b.domain || ''),
      name: String(b.name || '@'),
      type: String(b.type || 'A'),
      content: String(b.content || ''),
      ttl: b.ttl !== undefined ? Number(b.ttl) : 300,
      priority: b.priority !== undefined && b.priority !== '' ? Number(b.priority) : undefined,
    });
    if (!validated.ok) {
      res.status(400).json({ error: validated.error });
      return;
    }

    const proxied = Boolean(b.proxied);
    const line = b.line ? String(b.line).trim() : provider.type === 'dnspod' ? '默认' : undefined;
    const groupName = String(b.groupName || '').trim() || '默认分组';
    const notes = b.notes ? String(b.notes).trim().slice(0, 500) : undefined;
    const syncRemote = b.syncRemote !== false;

    let remoteRecordId: string | undefined;
    let zoneId: string | undefined = b.zoneId ? String(b.zoneId).trim() : undefined;
    let syncState: ManagedDnsRecord['syncState'] = 'local_only';
    let remoteMessage = '已保存为本地记录';

    if (syncRemote) {
      const secrets = store.getDnsProviderSecrets(provider.id);
      const remoteRes = await createProviderDnsRecord(provider, secrets, {
        domain: validated.domain,
        zoneId,
        name: validated.name,
        fqdn: validated.fqdn,
        type: validated.type,
        content: validated.content,
        ttl: validated.ttl,
        proxied,
        priority: validated.priority,
        line,
      });
      if (!remoteRes.ok) {
        res.status(502).json({ error: remoteRes.message });
        return;
      }
      remoteRecordId = remoteRes.remoteRecordId;
      zoneId = remoteRes.zoneId || zoneId;
      syncState = remoteRes.synced ? 'synced' : 'local_only';
      remoteMessage = remoteRes.message;
    }

    const now = new Date().toISOString();
    const record: ManagedDnsRecord = {
      id: `rec-${crypto.randomBytes(5).toString('hex')}`,
      providerId: provider.id,
      domain: validated.domain,
      zoneId,
      remoteRecordId,
      name: validated.name,
      fqdn: validated.fqdn,
      type: validated.type,
      content: validated.content,
      ttl: validated.ttl,
      proxied: provider.type === 'cloudflare' ? proxied : undefined,
      priority: validated.priority,
      line,
      groupName,
      notes,
      source: 'manual',
      syncState,
      lastSyncedAt: syncState === 'synced' ? now : undefined,
      createdAt: now,
      updatedAt: now,
    };

    state.dnsRecords.unshift(record);
    store.save();

    store.appendAudit({
      category: 'dns',
      severity: 'info',
      action: 'DNS_RECORD_CREATED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${record.fqdn} (${record.type})`,
      details: `Value=${record.content}, Group=${record.groupName}, Sync=${syncState} (${remoteMessage})`,
    });

    res.status(201).json({ record, message: remoteMessage });
  });

  app.put('/api/dns/records/:id', requireAuth, async (req: AuthedRequest, res) => {
    const state = store.getState();
    const record = state.dnsRecords.find((r) => r.id === req.params.id);
    if (!record) {
      res.status(404).json({ error: 'DNS 记录不存在' });
      return;
    }

    const b = req.body ?? {};
    const providerId = b.providerId ? String(b.providerId).trim() : record.providerId;
    const provider = state.dnsProviders.find((p) => p.id === providerId);
    if (!provider) {
      res.status(400).json({ error: '关联的 DNS 服务商不存在' });
      return;
    }

    const validated = validateDnsRecordInput({
      domain: b.domain !== undefined ? String(b.domain) : record.domain,
      name: b.name !== undefined ? String(b.name) : record.name,
      type: b.type !== undefined ? String(b.type) : record.type,
      content: b.content !== undefined ? String(b.content) : record.content,
      ttl: b.ttl !== undefined ? Number(b.ttl) : record.ttl,
      priority:
        b.priority !== undefined
          ? b.priority === '' || b.priority === null
            ? undefined
            : Number(b.priority)
          : record.priority,
    });
    if (!validated.ok) {
      res.status(400).json({ error: validated.error });
      return;
    }

    const nextProxied = b.proxied !== undefined ? Boolean(b.proxied) : record.proxied;
    const nextLine = b.line !== undefined ? String(b.line).trim() || undefined : record.line;
    const nextGroup = b.groupName !== undefined ? String(b.groupName).trim() || '默认分组' : record.groupName;
    const nextNotes = b.notes !== undefined ? String(b.notes).trim().slice(0, 500) || undefined : record.notes;
    const syncRemote = b.syncRemote !== false;

    const dnsFieldsChanged =
      validated.domain !== record.domain ||
      validated.name !== record.name ||
      validated.type !== record.type ||
      validated.content !== record.content ||
      validated.ttl !== record.ttl ||
      nextProxied !== record.proxied ||
      validated.priority !== record.priority ||
      nextLine !== record.line;

    let remoteMessage = '已更新记录';
    const now = new Date().toISOString();

    if (syncRemote && dnsFieldsChanged) {
      const secrets = store.getDnsProviderSecrets(provider.id);
      const remoteRes = await updateProviderDnsRecord(provider, secrets, record, {
        domain: validated.domain,
        name: validated.name,
        fqdn: validated.fqdn,
        type: validated.type,
        content: validated.content,
        ttl: validated.ttl,
        proxied: nextProxied,
        priority: validated.priority,
        line: nextLine,
      });
      if (!remoteRes.ok) {
        res.status(502).json({ error: remoteRes.message });
        return;
      }
      if (remoteRes.remoteRecordId) record.remoteRecordId = remoteRes.remoteRecordId;
      if (remoteRes.zoneId) record.zoneId = remoteRes.zoneId;
      record.syncState = remoteRes.synced ? 'synced' : 'local_only';
      if (remoteRes.synced) record.lastSyncedAt = now;
      remoteMessage = remoteRes.message;
    }

    record.providerId = provider.id;
    record.domain = validated.domain;
    record.name = validated.name;
    record.fqdn = validated.fqdn;
    record.type = validated.type;
    record.content = validated.content;
    record.ttl = validated.ttl;
    record.proxied = provider.type === 'cloudflare' ? Boolean(nextProxied) : undefined;
    record.priority = validated.priority;
    record.line = nextLine;
    record.groupName = nextGroup;
    record.notes = nextNotes;
    record.updatedAt = now;
    store.save();

    store.appendAudit({
      category: 'dns',
      severity: 'info',
      action: 'DNS_RECORD_UPDATED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${record.fqdn} (${record.type})`,
      details: `Value=${record.content}, Group=${record.groupName} (${remoteMessage})`,
    });

    res.json({ record, message: remoteMessage });
  });

  // Explicit single-record push to remote DNS server
  app.post('/api/dns/records/:id/push', requireAuth, async (req: AuthedRequest, res) => {
    const state = store.getState();
    const record = state.dnsRecords.find((r) => r.id === req.params.id);
    if (!record) {
      res.status(404).json({ error: 'DNS 记录不存在' });
      return;
    }
    const provider = state.dnsProviders.find((p) => p.id === record.providerId);
    if (!provider) {
      res.status(400).json({ error: '关联的 DNS 服务商不存在' });
      return;
    }
    const secrets = store.getDnsProviderSecrets(provider.id);
    const remoteRes = await updateProviderDnsRecord(provider, secrets, record, {
      domain: record.domain,
      name: record.name,
      fqdn: record.fqdn,
      type: record.type,
      content: record.content,
      ttl: record.ttl,
      proxied: record.proxied,
      priority: record.priority,
      line: record.line,
    });
    const now = new Date().toISOString();
    if (!remoteRes.ok) {
      record.syncState = 'error';
      record.updatedAt = now;
      store.save();
      res.status(502).json({ error: remoteRes.message, record });
      return;
    }
    if (remoteRes.remoteRecordId) record.remoteRecordId = remoteRes.remoteRecordId;
    if (remoteRes.zoneId) record.zoneId = remoteRes.zoneId;
    record.syncState = remoteRes.synced ? 'synced' : 'local_only';
    if (remoteRes.synced) record.lastSyncedAt = now;
    record.updatedAt = now;
    store.save();

    store.appendAudit({
      category: 'dns',
      severity: 'success',
      action: 'DNS_RECORD_PUSHED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${record.fqdn} (${record.type})`,
      details: `Pushed single record to ${provider.name}: ${remoteRes.message}`,
    });
    res.json({ ok: true, record, message: remoteRes.message });
  });

  app.post('/api/dns/records/batch-group', requireAuth, (req: AuthedRequest, res) => {
    const state = store.getState();
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    const groupName = String(req.body?.groupName || '').trim() || '默认分组';
    if (ids.length === 0) {
      res.status(400).json({ error: '请先选择至少一条 DNS 记录' });
      return;
    }
    const idSet = new Set(ids);
    const now = new Date().toISOString();
    let updatedCount = 0;
    for (const r of state.dnsRecords) {
      if (idSet.has(r.id)) {
        r.groupName = groupName;
        r.updatedAt = now;
        updatedCount += 1;
      }
    }
    store.save();
    store.appendAudit({
      category: 'dns',
      severity: 'info',
      action: 'DNS_RECORDS_BATCH_GROUP',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: groupName,
      details: `Moved ${updatedCount} DNS record(s) to group "${groupName}"`,
    });
    res.json({ ok: true, updatedCount, groupName });
  });

  app.delete('/api/dns/records/:id', requireAuth, async (req: AuthedRequest, res) => {
    const state = store.getState();
    const idx = state.dnsRecords.findIndex((r) => r.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'DNS 记录不存在' });
      return;
    }
    const record = state.dnsRecords[idx];
    const deleteRemote = req.query.deleteRemote !== 'false' && req.body?.deleteRemote !== false;
    let remoteMessage = '已删除本地记录';

    if (deleteRemote) {
      const provider = state.dnsProviders.find((p) => p.id === record.providerId);
      if (provider) {
        const secrets = store.getDnsProviderSecrets(provider.id);
        const remoteRes = await deleteProviderDnsRecord(provider, secrets, record);
        if (!remoteRes.ok) {
          res.status(502).json({ error: remoteRes.message });
          return;
        }
        remoteMessage = remoteRes.message;
      }
    }

    state.dnsRecords.splice(idx, 1);
    store.save();

    store.appendAudit({
      category: 'dns',
      severity: 'warning',
      action: 'DNS_RECORD_DELETED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${record.fqdn} (${record.type})`,
      details: `Deleted record ${record.content} (${remoteMessage})`,
    });

    res.json({ ok: true, message: remoteMessage });
  });

  // ---- Oracle Cloud (OCI) Multi-Region Profiles, Auto-Discovery & Real Domain IP Lifecycle ----
  app.post('/api/oci/compute-fingerprint', requireAuth, (req, res) => {
    const privateKeyPem = String(req.body?.privateKeyPem || '');
    const result = computeOciFingerprint(privateKeyPem);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ fingerprint: result.fingerprint });
  });

  app.post('/api/oci/profiles/discover', requireAuth, async (req: AuthedRequest, res) => {
    const b = req.body ?? {};
    let privateKeyPem = typeof b.privateKeyPem === 'string' ? b.privateKeyPem.trim() : '';
    let region = String(b.region || '').trim().toLowerCase();
    let tenancyOcid = String(b.tenancyOcid || '').trim();
    let userOcid = String(b.userOcid || '').trim();
    let compartmentOcid = String(b.compartmentOcid || '').trim();

    if (b.profileId) {
      const existing = store.getState().ociProfiles.find((p) => p.id === String(b.profileId));
      if (existing) {
        if (!privateKeyPem) privateKeyPem = store.getOciPrivateKey(existing.id);
        if (!region) region = existing.region;
        if (!tenancyOcid) tenancyOcid = existing.tenancyOcid;
        if (!userOcid) userOcid = existing.userOcid;
        if (!compartmentOcid) compartmentOcid = existing.compartmentOcid;
      }
    }

    if (!region || !tenancyOcid || !userOcid || !privateKeyPem) {
      res.status(400).json({ error: 'Region, Tenancy OCID, User OCID, and PEM Private Key are required for OCI discovery' });
      return;
    }

    const result = await discoverOciResources({
      region,
      tenancyOcid,
      userOcid,
      privateKeyPem,
      compartmentOcid: compartmentOcid || tenancyOcid,
    });

    if (!result.ok || !result.resources) {
      res.status(400).json({ error: result.error || 'OCI discovery failed' });
      return;
    }

    // If discovering for an existing profile, refresh its verified metadata automatically
    if (b.profileId) {
      const existing = store.getState().ociProfiles.find((p) => p.id === String(b.profileId));
      if (existing) {
        existing.fingerprint = result.resources.fingerprint;
        existing.homeRegion = result.resources.homeRegion;
        if (result.resources.availabilityDomains.length > 0) {
          existing.availabilityDomains = result.resources.availabilityDomains;
        }
        existing.instanceCount = result.resources.instanceCount;
        existing.status = 'active';
        existing.lastCheckedAt = new Date().toISOString();
        existing.updatedAt = existing.lastCheckedAt;
        store.save();
      }
    }

    store.appendAudit({
      category: 'oci',
      severity: 'success',
      action: 'OCI_RESOURCES_DISCOVERED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: region,
      details: `Auto-discovered ${result.resources.availabilityDomains.length} AD(s), ${result.resources.subnets.length} subnet(s), ${result.resources.compartments.length} compartment(s), ${result.resources.instanceCount} instance(s)`,
    });
    res.json(result.resources);
  });

  app.get('/api/oci/profiles/:id/images', requireAuth, async (req, res) => {
    const profile = store.getState().ociProfiles.find((p) => p.id === req.params.id);
    if (!profile) {
      res.status(404).json({ error: 'OCI profile not found' });
      return;
    }
    const pem = store.getOciPrivateKey(profile.id);
    if (!pem) {
      res.status(412).json({ error: 'Upload OCI PEM private key in this profile first' });
      return;
    }
    const shape = String(req.query.shape || 'VM.Standard.A1.Flex').trim();
    const result = await listOciImages(profile, pem, shape);
    if (!result.ok) {
      res.status(400).json({ error: result.error || 'Failed to fetch OCI OS images' });
      return;
    }
    res.json({ images: result.images });
  });

  app.get('/api/oci/profiles/:id/vnics', requireAuth, async (req, res) => {
    const profile = store.getState().ociProfiles.find((p) => p.id === req.params.id);
    if (!profile) {
      res.status(404).json({ error: 'OCI profile not found' });
      return;
    }
    const pem = store.getOciPrivateKey(profile.id);
    if (!pem) {
      res.status(412).json({ error: 'Upload OCI PEM private key in this profile first' });
      return;
    }
    const result = await discoverOciInstanceVnics(profile, pem);
    if (!result.ok) {
      res.status(400).json({ error: result.error || 'Failed to discover OCI instances/VNICs' });
      return;
    }
    profile.instanceCount = new Set(result.vnics.map((v) => v.instanceId)).size;
    profile.status = 'active';
    profile.lastCheckedAt = new Date().toISOString();
    store.save();
    res.json({ vnics: result.vnics });
  });

  // Helper to reconcile domain-scoped managedIps records from a DnsSyncRule
  const reconcileDomainManagedIps = (rule: DnsSyncRule) => {
    const state = store.getState();
    const now = new Date().toISOString();
    const fqdn = rule.recordName === '@' ? rule.domain : `${rule.recordName}.${rule.domain}`;
    const prof = rule.ociProfileId ? state.ociProfiles.find((p) => p.id === rule.ociProfileId) : undefined;

    // Remove previous OCI-managed entries strictly belonging to this rule
    state.managedIps = state.managedIps.filter((m) => m.dnsRuleId !== rule.id);

    if (rule.ipv4Address && net.isIPv4(rule.ipv4Address)) {
      state.managedIps.unshift({
        id: `ip-${crypto.randomBytes(4).toString('hex')}`,
        address: rule.ipv4Address,
        version: 'ipv4',
        label: `${fqdn} (IPv4)`,
        domain: rule.domain,
        dnsRuleId: rule.id,
        hostName: rule.ociInstanceName,
        provider: rule.ociProfileId ? 'oracle' : undefined,
        region: prof?.region,
        ociProfileId: rule.ociProfileId,
        ociVnicId: rule.ociVnicId,
        ociResourceId: rule.ociPublicIpId,
        ociPrivateIpId: rule.ociPrimaryPrivateIpId,
        ociLifetime: rule.ociPublicIpLifetime ?? 'EPHEMERAL',
        linkedDnsRuleIds: [rule.id],
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
    }

    for (const v6 of rule.ipv6Targets) {
      if (!v6.address || !net.isIPv6(v6.address)) continue;
      state.managedIps.unshift({
        id: `ip-${crypto.randomBytes(4).toString('hex')}`,
        address: v6.address,
        version: 'ipv6',
        label: `${v6.recordName === '@' ? rule.domain : `${v6.recordName}.${rule.domain}`} (IPv6)`,
        domain: rule.domain,
        dnsRuleId: rule.id,
        hostName: rule.ociInstanceName,
        provider: rule.ociProfileId ? 'oracle' : undefined,
        region: prof?.region,
        ociProfileId: rule.ociProfileId,
        ociVnicId: rule.ociVnicId,
        ociResourceId: v6.ociIpv6Id,
        ociLifetime: 'IPV6',
        linkedDnsRuleIds: [rule.id],
        status: v6.enabled ? 'active' : 'standby',
        createdAt: now,
        updatedAt: now,
      });
    }
  };

  // Bind a real OCI Instance VNIC to a Domain / DNS Sync Rule
  app.post('/api/oci/domains/:ruleId/bind-vnic', requireAuth, async (req: AuthedRequest, res) => {
    const state = store.getState();
    const rule = state.dnsRules.find((r) => r.id === req.params.ruleId);
    if (!rule) {
      res.status(404).json({ error: 'Domain DNS rule not found' });
      return;
    }

    const { profileId, instanceId, instanceName, vnicId, syncFromOci, syncDnsNow } = req.body ?? {};
    const profile = state.ociProfiles.find((p) => p.id === String(profileId || ''));
    if (!profile) {
      res.status(404).json({ error: 'OCI profile not found' });
      return;
    }
    const pem = store.getOciPrivateKey(profile.id);
    if (!pem) {
      res.status(412).json({ error: 'Selected OCI profile does not have a PEM private key configured' });
      return;
    }
    const cleanVnicId = String(vnicId || '').trim();
    if (!isValidOcid(cleanVnicId)) {
      res.status(400).json({ error: 'Valid OCI VNIC OCID is required' });
      return;
    }

    const vnicInspect = await inspectOciVnicIps(profile, pem, cleanVnicId);
    if (!vnicInspect.ok || !vnicInspect.vnic) {
      res.status(400).json({ error: vnicInspect.error || 'Failed to inspect OCI VNIC' });
      return;
    }

    const now = new Date().toISOString();
    rule.ociProfileId = profile.id;
    rule.ociInstanceId = instanceId ? String(instanceId).trim() : rule.ociInstanceId;
    rule.ociInstanceName = instanceName ? String(instanceName).trim() : vnicInspect.vnic.vnicName;
    rule.ociVnicId = vnicInspect.vnic.vnicId;
    rule.ociPrimaryPrivateIpId = vnicInspect.vnic.primaryPrivateIpId;
    rule.ociPublicIpId = vnicInspect.vnic.publicIpId;
    rule.ociPublicIpLifetime = vnicInspect.vnic.publicIpLifetime;

    if (syncFromOci !== false) {
      if (vnicInspect.vnic.publicIp) {
        rule.ipv4Address = vnicInspect.vnic.publicIp;
        rule.ipv4Source = 'cloud_host';
      }
      rule.ipv6Targets = vnicInspect.vnic.ipv6s.map((v, idx) => ({
        id: `v6-${crypto.randomBytes(4).toString('hex')}`,
        recordName: rule.ipv6Mode === 'round_robin' ? rule.recordName : `v6-${idx + 1}.${rule.recordName}`,
        address: v.ipAddress,
        ociIpv6Id: v.id,
        proxied: rule.proxied,
        enabled: true,
        lastStatus: 'pending',
      }));
    }
    rule.updatedAt = now;
    reconcileDomainManagedIps(rule);
    store.save();

    let dnsReport: DnsRuleSyncReport | null = null;
    if (syncDnsNow) {
      dnsReport = await executeDnsSyncRule(rule.id, req.sessionUser || 'admin', getClientIp(req));
    }

    store.appendAudit({
      category: 'ip',
      severity: 'success',
      action: 'DOMAIN_OCI_VNIC_BOUND',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${rule.recordName}.${rule.domain}`,
      details: `Bound to OCI ${profile.region} / ${rule.ociInstanceName} (${rule.ociVnicId}); IPv4=${rule.ipv4Address || 'none'}, IPv6=${rule.ipv6Targets.length}`,
    });
    res.json({ rule, vnic: vnicInspect.vnic, dnsReport });
  });

  // Pull live Public IPv4 & IPv6s from bound OCI VNIC into Domain rule
  app.post('/api/oci/domains/:ruleId/sync-ips', requireAuth, async (req: AuthedRequest, res) => {
    const state = store.getState();
    const rule = state.dnsRules.find((r) => r.id === req.params.ruleId);
    if (!rule || !rule.ociProfileId || !rule.ociVnicId) {
      res.status(400).json({ error: 'Domain is not bound to an OCI VNIC' });
      return;
    }
    const profile = state.ociProfiles.find((p) => p.id === rule.ociProfileId);
    if (!profile) {
      res.status(404).json({ error: 'Bound OCI profile not found' });
      return;
    }
    const pem = store.getOciPrivateKey(profile.id);
    if (!pem) {
      res.status(412).json({ error: 'Bound OCI profile is missing its PEM private key' });
      return;
    }

    const inspect = await inspectOciVnicIps(profile, pem, rule.ociVnicId);
    if (!inspect.ok || !inspect.vnic) {
      res.status(400).json({ error: inspect.error || 'Failed to read live IPs from OCI VNIC' });
      return;
    }

    rule.ociPrimaryPrivateIpId = inspect.vnic.primaryPrivateIpId || rule.ociPrimaryPrivateIpId;
    rule.ociPublicIpId = inspect.vnic.publicIpId;
    rule.ociPublicIpLifetime = inspect.vnic.publicIpLifetime;
    rule.ipv4Address = inspect.vnic.publicIp || '';

    const existingByAddr = new Map(rule.ipv6Targets.map((t) => [t.address, t]));
    rule.ipv6Targets = inspect.vnic.ipv6s.map((v, idx) => {
      const prev = existingByAddr.get(v.ipAddress);
      return {
        id: prev?.id || `v6-${crypto.randomBytes(4).toString('hex')}`,
        recordName: prev?.recordName || (rule.ipv6Mode === 'round_robin' ? rule.recordName : `v6-${idx + 1}.${rule.recordName}`),
        address: v.ipAddress,
        ociIpv6Id: v.id,
        proxied: prev?.proxied ?? rule.proxied,
        enabled: prev ? prev.enabled : true,
        lastStatus: prev?.lastStatus || 'pending',
      };
    });
    rule.updatedAt = new Date().toISOString();
    reconcileDomainManagedIps(rule);
    store.save();

    let dnsReport: DnsRuleSyncReport | null = null;
    if (req.body?.syncDnsNow) {
      dnsReport = await executeDnsSyncRule(rule.id, req.sessionUser || 'admin', getClientIp(req));
    }

    store.appendAudit({
      category: 'ip',
      severity: 'info',
      action: 'DOMAIN_OCI_IPS_SYNCED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${rule.recordName}.${rule.domain}`,
      details: `Pulled live OCI VNIC IPs: IPv4=${rule.ipv4Address || 'none'}, IPv6=${rule.ipv6Targets.length}`,
    });
    res.json({ rule, vnic: inspect.vnic, dnsReport });
  });

  // Real OCI Public IPv4 Swap (deletes old Ephemeral IP + creates brand new OCI Public IP + updates Domain DNS + Monitors)
  app.post('/api/oci/domains/:ruleId/swap-ipv4', requireAuth, async (req: AuthedRequest, res) => {
    const state = store.getState();
    const rule = state.dnsRules.find((r) => r.id === req.params.ruleId);
    if (!rule || !rule.ociProfileId || !rule.ociVnicId) {
      res.status(400).json({ error: 'Domain must be bound to an OCI VNIC to perform real Public IPv4 swap' });
      return;
    }
    const profile = state.ociProfiles.find((p) => p.id === rule.ociProfileId);
    if (!profile) {
      res.status(404).json({ error: 'Bound OCI profile not found' });
      return;
    }
    const pem = store.getOciPrivateKey(profile.id);
    if (!pem) {
      res.status(412).json({ error: 'Bound OCI profile has no PEM private key configured' });
      return;
    }

    let privateIpId = rule.ociPrimaryPrivateIpId;
    if (!privateIpId) {
      const inspect = await inspectOciVnicIps(profile, pem, rule.ociVnicId);
      if (!inspect.ok || !inspect.vnic?.primaryPrivateIpId) {
        res.status(400).json({ error: inspect.error || 'Could not resolve OCI Primary Private IP OCID' });
        return;
      }
      privateIpId = inspect.vnic.primaryPrivateIpId;
      rule.ociPrimaryPrivateIpId = privateIpId;
    }

    const swapped = await ociSwapPublicIpv4(profile, pem, privateIpId);
    if (!swapped.ok || !swapped.newAddress) {
      res.status(502).json({ error: swapped.error || 'OCI Public IPv4 swap failed' });
      return;
    }

    const oldIp = swapped.oldAddress || rule.ipv4Address;
    const now = new Date().toISOString();
    rule.ipv4Address = swapped.newAddress;
    rule.ociPublicIpId = swapped.publicIpId;
    rule.ociPublicIpLifetime = swapped.lifetime;
    rule.updatedAt = now;

    // Cascade to linked hosts & monitors
    for (const host of state.cloudHosts) {
      if (oldIp && host.ipv4 === oldIp) {
        host.ipv4 = swapped.newAddress;
        host.updatedAt = now;
      }
    }
    for (const mon of state.monitors) {
      if (oldIp && mon.target === oldIp) mon.target = swapped.newAddress;
      if (oldIp && mon.expectedIp === oldIp) mon.expectedIp = swapped.newAddress;
    }

    reconcileDomainManagedIps(rule);
    store.save();

    let dnsReport: DnsRuleSyncReport | null = null;
    if (req.body?.syncDnsNow !== false) {
      dnsReport = await executeDnsSyncRule(rule.id, req.sessionUser || 'admin', getClientIp(req));
    }

    const summary = `OCI Public IPv4 swapped for ${rule.recordName}.${rule.domain}: ${oldIp || 'none'} -> ${swapped.newAddress}`;
    store.appendAudit({
      category: 'ip',
      severity: 'success',
      action: 'OCI_IPV4_SWAPPED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${rule.recordName}.${rule.domain}`,
      details: summary,
    });
    if (req.body?.notify !== false) {
      await dispatchSystemNotification({
        event: 'ip_changed',
        title: `OCI IPv4 Replaced: ${rule.recordName}.${rule.domain}`,
        message: summary,
        actor: req.sessionUser || 'admin',
        ip: getClientIp(req),
      });
    }

    res.json({ rule, oldAddress: oldIp, newAddress: swapped.newAddress, dnsReport });
  });

  // Real OCI Add IPv6 on bound VNIC -> attach to Domain -> sync AAAA
  app.post('/api/oci/domains/:ruleId/add-ipv6', requireAuth, async (req: AuthedRequest, res) => {
    const state = store.getState();
    const rule = state.dnsRules.find((r) => r.id === req.params.ruleId);
    if (!rule || !rule.ociProfileId || !rule.ociVnicId) {
      res.status(400).json({ error: 'Domain must be bound to an OCI VNIC to allocate a real OCI IPv6' });
      return;
    }
    const profile = state.ociProfiles.find((p) => p.id === rule.ociProfileId);
    if (!profile) {
      res.status(404).json({ error: 'Bound OCI profile not found' });
      return;
    }
    const pem = store.getOciPrivateKey(profile.id);
    if (!pem) {
      res.status(412).json({ error: 'Bound OCI profile has no PEM private key configured' });
      return;
    }

    const specificIp = typeof req.body?.ipAddress === 'string' ? req.body.ipAddress.trim() : undefined;
    const added = await ociAddIpv6ToVnic(profile, pem, rule.ociVnicId, specificIp || undefined);
    if (!added.ok || !added.ipAddress || !added.ipv6Id) {
      res.status(502).json({ error: added.error || 'OCI IPv6 allocation failed' });
      return;
    }

    const customRecordName = typeof req.body?.recordName === 'string' && req.body.recordName.trim()
      ? req.body.recordName.trim()
      : rule.ipv6Mode === 'round_robin'
      ? rule.recordName
      : `v6-${rule.ipv6Targets.length + 1}.${rule.recordName}`;

    rule.syncIpv6 = true;
    rule.ipv6Targets.push({
      id: `v6-${crypto.randomBytes(4).toString('hex')}`,
      recordName: customRecordName,
      address: added.ipAddress,
      ociIpv6Id: added.ipv6Id,
      proxied: rule.proxied,
      enabled: true,
      lastStatus: 'pending',
    });
    rule.updatedAt = new Date().toISOString();
    reconcileDomainManagedIps(rule);
    store.save();

    let dnsReport: DnsRuleSyncReport | null = null;
    if (req.body?.syncDnsNow !== false) {
      dnsReport = await executeDnsSyncRule(rule.id, req.sessionUser || 'admin', getClientIp(req));
    }

    store.appendAudit({
      category: 'ip',
      severity: 'success',
      action: 'OCI_IPV6_ADDED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${rule.recordName}.${rule.domain}`,
      details: `Allocated real OCI IPv6 ${added.ipAddress} (${added.ipv6Id}) on VNIC ${rule.ociVnicId}`,
    });

    res.status(201).json({ rule, ipAddress: added.ipAddress, ipv6Id: added.ipv6Id, dnsReport });
  });

  // Real OCI Swap IPv6 (delete old OCI IPv6 + allocate fresh OCI IPv6 -> update Domain DNS + Monitors)
  app.post('/api/oci/domains/:ruleId/swap-ipv6', requireAuth, async (req: AuthedRequest, res) => {
    const state = store.getState();
    const rule = state.dnsRules.find((r) => r.id === req.params.ruleId);
    if (!rule || !rule.ociProfileId || !rule.ociVnicId) {
      res.status(400).json({ error: 'Domain must be bound to an OCI VNIC' });
      return;
    }
    const profile = state.ociProfiles.find((p) => p.id === rule.ociProfileId);
    if (!profile) {
      res.status(404).json({ error: 'Bound OCI profile not found' });
      return;
    }
    const pem = store.getOciPrivateKey(profile.id);
    if (!pem) {
      res.status(412).json({ error: 'Bound OCI profile has no PEM private key configured' });
      return;
    }

    const targetId = String(req.body?.targetId || '').trim();
    const target = rule.ipv6Targets.find((t) => t.id === targetId || t.ociIpv6Id === targetId);
    if (!target) {
      res.status(404).json({ error: 'IPv6 target not found on this domain' });
      return;
    }

    // Resolve ociIpv6Id from live VNIC if not cached yet
    let ociIpv6Id = target.ociIpv6Id;
    if (!ociIpv6Id) {
      const inspect = await inspectOciVnicIps(profile, pem, rule.ociVnicId);
      ociIpv6Id = inspect.vnic?.ipv6s.find((v) => v.ipAddress === target.address)?.id;
    }
    if (!ociIpv6Id) {
      res.status(400).json({ error: 'Could not locate matching OCI IPv6 resource ID on VNIC. Sync live OCI IPs first.' });
      return;
    }

    // 1. Delete old IPv6 on OCI
    const del = await ociDeleteIpv6(profile, pem, ociIpv6Id);
    if (!del.ok) {
      res.status(502).json({ error: `Failed to release old OCI IPv6: ${del.error}` });
      return;
    }

    // 2. Allocate replacement IPv6 on OCI
    const specificIp = typeof req.body?.newIpAddress === 'string' ? req.body.newIpAddress.trim() : undefined;
    const added = await ociAddIpv6ToVnic(profile, pem, rule.ociVnicId, specificIp || undefined);
    if (!added.ok || !added.ipAddress || !added.ipv6Id) {
      res.status(502).json({ error: `Released old IPv6, but failed to allocate new OCI IPv6: ${added.error}` });
      return;
    }

    const oldAddress = target.address;
    target.address = added.ipAddress;
    target.ociIpv6Id = added.ipv6Id;
    target.lastStatus = 'pending';
    rule.updatedAt = new Date().toISOString();

    for (const mon of state.monitors) {
      if (mon.target === oldAddress) mon.target = added.ipAddress;
      if (mon.expectedIp === oldAddress) mon.expectedIp = added.ipAddress;
    }

    reconcileDomainManagedIps(rule);
    store.save();

    let dnsReport: DnsRuleSyncReport | null = null;
    if (req.body?.syncDnsNow !== false) {
      dnsReport = await executeDnsSyncRule(rule.id, req.sessionUser || 'admin', getClientIp(req));
    }

    const summary = `OCI IPv6 swapped for ${rule.recordName}.${rule.domain}: ${oldAddress} -> ${added.ipAddress}`;
    store.appendAudit({
      category: 'ip',
      severity: 'success',
      action: 'OCI_IPV6_SWAPPED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${rule.recordName}.${rule.domain}`,
      details: summary,
    });
    if (req.body?.notify !== false) {
      await dispatchSystemNotification({
        event: 'ip_changed',
        title: `OCI IPv6 Replaced: ${rule.recordName}.${rule.domain}`,
        message: summary,
        actor: req.sessionUser || 'admin',
        ip: getClientIp(req),
      });
    }

    res.json({ rule, oldAddress, newAddress: added.ipAddress, ipv6Id: added.ipv6Id, dnsReport });
  });

  // Real OCI Delete IP (releases real OCI Public IPv4 or deletes real OCI IPv6 from VNIC)
  app.post('/api/oci/domains/:ruleId/delete-ip', requireAuth, async (req: AuthedRequest, res) => {
    const state = store.getState();
    const rule = state.dnsRules.find((r) => r.id === req.params.ruleId);
    if (!rule || !rule.ociProfileId || !rule.ociVnicId) {
      res.status(400).json({ error: 'Domain must be bound to an OCI VNIC to release real cloud IPs' });
      return;
    }
    const profile = state.ociProfiles.find((p) => p.id === rule.ociProfileId);
    if (!profile) {
      res.status(404).json({ error: 'Bound OCI profile not found' });
      return;
    }
    const pem = store.getOciPrivateKey(profile.id);
    if (!pem) {
      res.status(412).json({ error: 'Bound OCI profile has no PEM private key configured' });
      return;
    }

    const version = req.body?.version === 'ipv4' ? 'ipv4' : 'ipv6';
    if (version === 'ipv4') {
      let publicIpId = rule.ociPublicIpId;
      let lifetime = rule.ociPublicIpLifetime;
      if (!publicIpId) {
        const inspect = await inspectOciVnicIps(profile, pem, rule.ociVnicId);
        publicIpId = inspect.vnic?.publicIpId;
        lifetime = inspect.vnic?.publicIpLifetime;
      }
      if (!publicIpId) {
        res.status(400).json({ error: 'No active OCI Public IPv4 found on bound VNIC' });
        return;
      }
      const del = await ociDeletePublicIpv4(profile, pem, publicIpId, lifetime);
      if (!del.ok) {
        res.status(502).json({ error: `Failed to release OCI Public IPv4: ${del.error}` });
        return;
      }
      const removedIp = rule.ipv4Address;
      rule.ipv4Address = '';
      rule.ociPublicIpId = undefined;
      rule.updatedAt = new Date().toISOString();
      reconcileDomainManagedIps(rule);
      store.save();

      store.appendAudit({
        category: 'ip',
        severity: 'warning',
        action: 'OCI_IPV4_RELEASED',
        actor: req.sessionUser || 'admin',
        ip: getClientIp(req),
        target: `${rule.recordName}.${rule.domain}`,
        details: `Released OCI Public IPv4 ${removedIp} (${publicIpId})`,
      });
      res.json({ ok: true, rule });
      return;
    }

    // Delete IPv6 on OCI
    const targetId = String(req.body?.targetId || '').trim();
    const idx = rule.ipv6Targets.findIndex((t) => t.id === targetId || t.ociIpv6Id === targetId);
    if (idx === -1) {
      res.status(404).json({ error: 'IPv6 target not found on this domain' });
      return;
    }
    const target = rule.ipv6Targets[idx];
    let ociIpv6Id = target.ociIpv6Id;
    if (!ociIpv6Id) {
      const inspect = await inspectOciVnicIps(profile, pem, rule.ociVnicId);
      ociIpv6Id = inspect.vnic?.ipv6s.find((v) => v.ipAddress === target.address)?.id;
    }
    if (!ociIpv6Id) {
      res.status(400).json({ error: 'Could not locate OCI IPv6 OCID on bound VNIC' });
      return;
    }
    const del = await ociDeleteIpv6(profile, pem, ociIpv6Id);
    if (!del.ok) {
      res.status(502).json({ error: `Failed to delete OCI IPv6: ${del.error}` });
      return;
    }
    rule.ipv6Targets.splice(idx, 1);
    rule.updatedAt = new Date().toISOString();
    reconcileDomainManagedIps(rule);
    store.save();

    let dnsReport: DnsRuleSyncReport | null = null;
    if (req.body?.syncDnsNow) {
      dnsReport = await executeDnsSyncRule(rule.id, req.sessionUser || 'admin', getClientIp(req));
    }

    store.appendAudit({
      category: 'ip',
      severity: 'warning',
      action: 'OCI_IPV6_DELETED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${rule.recordName}.${rule.domain}`,
      details: `Deleted real OCI IPv6 ${target.address} (${ociIpv6Id}) from VNIC ${rule.ociVnicId}`,
    });
    res.json({ ok: true, rule, dnsReport });
  });

  app.get('/api/oci/profiles', requireAuth, (_req, res) => {
    res.json(store.getState().ociProfiles.map((p) => store.toPublicOciProfile(p)));
  });

  app.post('/api/oci/profiles', requireAuth, (req: AuthedRequest, res) => {
    const b = req.body ?? {};
    if (!b.name || !b.region || !b.tenancyOcid || !b.userOcid) {
      res.status(400).json({ error: 'Name, region, tenancyOcid, and userOcid are required' });
      return;
    }
    const cleanRegion = String(b.region).trim().toLowerCase();
    if (!OCI_REGION_REGEX.test(cleanRegion)) {
      res.status(400).json({ error: 'Invalid OCI region format (e.g. ap-tokyo-1)' });
      return;
    }

    // Always derive fingerprint automatically from normalized privateKeyPem
    let computedFingerprint = '';
    let normalizedPem: string | undefined;
    if (typeof b.privateKeyPem === 'string' && b.privateKeyPem.trim()) {
      const norm = normalizeOciPem(b.privateKeyPem);
      if (!norm.ok) {
        res.status(400).json({ error: norm.error });
        return;
      }
      const fp = computeOciFingerprint(norm.pem);
      if (!fp.ok) {
        res.status(400).json({ error: fp.error });
        return;
      }
      computedFingerprint = fp.fingerprint;
      normalizedPem = norm.pem;
    }

    const cleanTenancy = sanitizeOcid(String(b.tenancyOcid));
    const cleanUser = sanitizeOcid(String(b.userOcid));
    const cleanComp = sanitizeOcid(String(b.compartmentOcid || '')) || cleanTenancy;
    const now = new Date().toISOString();
    const profile: StoredOciProfile = {
      id: `oci-${crypto.randomBytes(5).toString('hex')}`,
      name: String(b.name).trim(),
      region: cleanRegion,
      homeRegion: b.homeRegion ? String(b.homeRegion).trim().toLowerCase() : undefined,
      tenancyOcid: cleanTenancy,
      userOcid: cleanUser,
      compartmentOcid: cleanComp,
      fingerprint: computedFingerprint,
      subnetOcid: String(b.subnetOcid || '').trim(),
      availabilityDomains: Array.isArray(b.availabilityDomains) && b.availabilityDomains.length
        ? b.availabilityDomains.map((v: unknown) => String(v).trim()).filter(Boolean)
        : [],
      instanceCount: Number(b.instanceCount) || 0,
      status: 'unverified',
      notes: b.notes ? String(b.notes).trim() : undefined,
      createdAt: now,
      updatedAt: now,
    };
    if (normalizedPem) {
      store.setOciPrivateKey(profile, normalizedPem);
    }
    store.getState().ociProfiles.unshift(profile);
    store.save();

    store.appendAudit({
      category: 'oci',
      severity: 'info',
      action: 'OCI_PROFILE_CREATED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${profile.name} (${profile.region})`,
      details: `Added OCI regional profile (fingerprint=${computedFingerprint || 'pending PEM'}, ADs=${profile.availabilityDomains.length})`,
    });
    res.status(201).json(store.toPublicOciProfile(profile));
  });

  app.put('/api/oci/profiles/:id', requireAuth, (req: AuthedRequest, res) => {
    const profile = store.getState().ociProfiles.find((p) => p.id === req.params.id);
    if (!profile) {
      res.status(404).json({ error: 'OCI profile not found' });
      return;
    }
    const b = req.body ?? {};
    if (b.region) {
      const cleanRegion = String(b.region).trim().toLowerCase();
      if (!OCI_REGION_REGEX.test(cleanRegion)) {
        res.status(400).json({ error: 'Invalid OCI region format (e.g. ap-tokyo-1)' });
        return;
      }
      profile.region = cleanRegion;
    }
    if (b.name) profile.name = String(b.name).trim();
    const prevTenancy = profile.tenancyOcid;
    if (b.tenancyOcid) {
      const nextTenancy = sanitizeOcid(String(b.tenancyOcid));
      profile.tenancyOcid = nextTenancy;
      // Keep default compartment aligned with tenancy when compartment was equal to old tenancy
      if (!b.compartmentOcid && (!profile.compartmentOcid || profile.compartmentOcid === prevTenancy)) {
        profile.compartmentOcid = nextTenancy;
      }
    }
    if (b.userOcid) profile.userOcid = sanitizeOcid(String(b.userOcid));
    if (b.homeRegion) profile.homeRegion = String(b.homeRegion).trim().toLowerCase();
    if (b.compartmentOcid) profile.compartmentOcid = sanitizeOcid(String(b.compartmentOcid));
    if (b.subnetOcid !== undefined) profile.subnetOcid = String(b.subnetOcid).trim();
    if (Array.isArray(b.availabilityDomains) && b.availabilityDomains.length > 0) {
      profile.availabilityDomains = b.availabilityDomains.map((v: unknown) => String(v).trim()).filter(Boolean);
    }
    if (b.notes !== undefined) profile.notes = String(b.notes).trim();
    if (typeof b.privateKeyPem === 'string' && b.privateKeyPem.trim()) {
      const norm = normalizeOciPem(b.privateKeyPem);
      if (!norm.ok) {
        res.status(400).json({ error: norm.error });
        return;
      }
      const fp = computeOciFingerprint(norm.pem);
      if (!fp.ok) {
        res.status(400).json({ error: fp.error });
        return;
      }
      store.setOciPrivateKey(profile, norm.pem);
      profile.fingerprint = fp.fingerprint;
      profile.status = 'unverified';
    }
    profile.updatedAt = new Date().toISOString();
    store.save();

    store.appendAudit({
      category: 'oci',
      severity: 'info',
      action: 'OCI_PROFILE_UPDATED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${profile.name} (${profile.region})`,
      details: `Updated OCI regional configuration${b.privateKeyPem ? ' & auto-computed fingerprint' : ''}`,
    });
    res.json(store.toPublicOciProfile(profile));
  });

  app.delete('/api/oci/profiles/:id', requireAuth, (req: AuthedRequest, res) => {
    const state = store.getState();
    const idx = state.ociProfiles.findIndex((p) => p.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'OCI profile not found' });
      return;
    }
    const [removed] = state.ociProfiles.splice(idx, 1);
    store.save();
    store.appendAudit({
      category: 'oci',
      severity: 'warning',
      action: 'OCI_PROFILE_DELETED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${removed.name} (${removed.region})`,
      details: 'Removed OCI regional profile',
    });
    res.json({ ok: true });
  });

  // OCI ARM Sniper Tasks (Unified on System Notifications · Zero main.tf Auto-Resolve)
  app.get('/api/oci/sniper', requireAuth, (_req, res) => {
    res.json(store.getState().ociSniperTasks.map((t) => store.toPublicSniperTask(t)));
  });

  // Zero-main.tf Auto-Resolve: automatically fetch Compartment, ADs, Public Subnet, and Official OS Images via OCI API
  app.post('/api/oci/sniper/auto-resolve', requireAuth, async (req: AuthedRequest, res) => {
    const b = req.body ?? {};
    const profileId = String(b.profileId || '').trim();
    const shape =
      b.shape === 'VM.Standard.E2.1.Micro' ? 'VM.Standard.E2.1.Micro' : 'VM.Standard.A1.Flex';
    const osHint = typeof b.osHint === 'string' ? b.osHint : undefined;
    const assignIpv6 = b.assignIpv6 !== false;

    const profile = store.getState().ociProfiles.find((p) => p.id === profileId);
    if (!profile) {
      res.status(404).json({ error: '未找到对应的 OCI 云凭据，请先在「多云主机管理 → 云账号凭据」中配置。' });
      return;
    }
    const pem = store.getOciPrivateKey(profile.id);
    if (!pem || !pem.includes('BEGIN')) {
      res.status(400).json({ error: `OCI 凭据「${profile.name}」尚未上传 PEM 私钥，请先在云凭证管理中上传。` });
      return;
    }

    const resolved = await autoResolveSniperParams(profile, pem, shape, { osHint, assignIpv6 });
    if (!resolved.ok) {
      res.status(502).json({ ok: false, error: resolved.error || '自动获取 OCI 抢注参数失败' });
      return;
    }

    store.appendAudit({
      category: 'oci',
      severity: 'info',
      action: 'OCI_SNIPER_AUTO_RESOLVED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${profile.name} (${profile.region})`,
      details: `Auto-resolved zero-main.tf params: ADs=${resolved.availabilityDomains?.length ?? 0}, Subnets=${resolved.subnets?.length ?? 0}, Images=${resolved.images?.length ?? 0}`,
    });

    res.json(resolved);
  });

  // Ephemeral Ed25519 SSH Keypair Generator (private key returned once, never stored on server)
  app.post('/api/oci/sniper/generate-ssh-key', requireAuth, (req: AuthedRequest, res) => {
    const comment = typeof req.body?.comment === 'string' ? req.body.comment : 'netpulse-oci-arm';
    const pair = generateEd25519SshKeypair(comment);
    res.json({ ok: true, ...pair });
  });

  app.post('/api/oci/sniper', requireAuth, (req: AuthedRequest, res) => {
    const b = req.body ?? {};
    const profileId = String(b.profileId || '').trim();
    if (!b.name || !profileId || !b.displayName) {
      res.status(400).json({ error: 'Task name, profileId, and displayName are required' });
      return;
    }
    const linkedProfile = store.getState().ociProfiles.find((p) => p.id === profileId);
    if (!linkedProfile) {
      res.status(400).json({ error: '所选 OCI 区域凭据不存在，请重新选择有效的 OCI 账号' });
      return;
    }
    const now = new Date().toISOString();
    const minInterval = Math.max(10, Math.min(300, Number(b.minIntervalSeconds ?? 20)));
    const initInterval = Math.max(minInterval, Math.min(600, Number(b.intervalSeconds ?? 30)));
    const maxInterval = Math.max(initInterval, Math.min(600, Number(b.maxIntervalSeconds ?? 120)));
    const task: StoredOciSniperTask = {
      id: `sniper-${crypto.randomBytes(5).toString('hex')}`,
      name: String(b.name).trim(),
      profileId: String(b.profileId),
      displayName: String(b.displayName).trim(),
      shape: b.shape === 'VM.Standard.E2.1.Micro' ? 'VM.Standard.E2.1.Micro' : 'VM.Standard.A1.Flex',
      ocpus: Math.min(4, Math.max(1, Number(b.ocpus) || 4)),
      memoryInGBs: Math.min(24, Math.max(1, Number(b.memoryInGBs) || 24)),
      bootVolumeSizeInGBs: Math.min(200, Math.max(50, Number(b.bootVolumeSizeInGBs) || 100)),
      imageOcid: String(b.imageOcid || '').trim(),
      osPreset: String(b.osPreset || 'Ubuntu 24.04 Minimal aarch64').trim(),
      sshPublicKey: String(b.sshPublicKey || '').trim(),
      availabilityDomains: Array.isArray(b.availabilityDomains) && b.availabilityDomains.length
        ? b.availabilityDomains.map((v: unknown) => String(v).trim()).filter(Boolean)
        : ['AD-1'],
      assignPublicIp: b.assignPublicIp !== false,
      assignIpv6: b.assignIpv6 !== false,
      adaptiveInterval: b.adaptiveInterval !== false,
      minIntervalSeconds: minInterval,
      intervalSeconds: initInterval,
      maxIntervalSeconds: maxInterval,
      stepUp429Seconds: Math.max(5, Math.min(120, Number(b.stepUp429Seconds ?? 15))),
      stepDownOkSeconds: Math.max(1, Math.min(60, Number(b.stepDownOkSeconds ?? 5))),
      currentIntervalSeconds: initInterval,
      consecutive429Count: 0,
      consecutiveOkCount: 0,
      jitterPercent: Math.min(50, Math.max(0, Number(b.jitterPercent ?? 15))),
      retryOnOutOfCapacity: b.retryOnOutOfCapacity !== false,
      backoffOn429Seconds: Math.max(30, Number(b.backoffOn429Seconds ?? 60)),
      maxAttempts: Math.max(0, Number(b.maxAttempts) || 0),
      autoStopOnSuccess: b.autoStopOnSuccess !== false,
      autoBindDnsRuleId: b.autoBindDnsRuleId || undefined,
      useSystemNotifications: b.useSystemNotifications !== false,
      notifyChannelIds: Array.isArray(b.notifyChannelIds) ? b.notifyChannelIds.map(String) : [],
      status: 'paused',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    store.getState().ociSniperTasks.unshift(task);
    store.save();

    store.appendAudit({
      category: 'oci',
      severity: 'info',
      action: 'OCI_SNIPER_CREATED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: task.name,
      details: `${task.shape} ${task.ocpus}C/${task.memoryInGBs}G · adaptive=${task.adaptiveInterval} (${task.minIntervalSeconds}-${task.maxIntervalSeconds}s, init=${task.intervalSeconds}s)`,
    });
    res.status(201).json(store.toPublicSniperTask(task));
  });

  app.put('/api/oci/sniper/:id', requireAuth, (req: AuthedRequest, res) => {
    const task = store.getState().ociSniperTasks.find((t) => t.id === req.params.id);
    if (!task) {
      res.status(404).json({ error: 'Sniper task not found' });
      return;
    }
    const b = req.body ?? {};
    if (b.name !== undefined) task.name = String(b.name).trim();
    if (b.profileId !== undefined) {
      const nextProfileId = String(b.profileId).trim();
      const linkedProfile = store.getState().ociProfiles.find((p) => p.id === nextProfileId);
      if (!linkedProfile) {
        res.status(400).json({ error: '所选 OCI 区域凭据不存在，请重新选择有效的 OCI 账号' });
        return;
      }
      if (task.profileId !== nextProfileId && task.status === 'failed') {
        task.status = 'paused';
        task.lastMessage = undefined;
      }
      task.profileId = nextProfileId;
    }
    if (b.displayName !== undefined) task.displayName = String(b.displayName).trim();
    if (b.shape !== undefined) task.shape = b.shape === 'VM.Standard.E2.1.Micro' ? 'VM.Standard.E2.1.Micro' : 'VM.Standard.A1.Flex';
    if (b.ocpus !== undefined) task.ocpus = Math.min(4, Math.max(1, Number(b.ocpus) || 1));
    if (b.memoryInGBs !== undefined) task.memoryInGBs = Math.min(24, Math.max(1, Number(b.memoryInGBs) || 6));
    if (b.bootVolumeSizeInGBs !== undefined) task.bootVolumeSizeInGBs = Math.min(200, Math.max(50, Number(b.bootVolumeSizeInGBs) || 50));
    if (b.imageOcid !== undefined) task.imageOcid = String(b.imageOcid).trim();
    if (b.osPreset !== undefined) task.osPreset = String(b.osPreset).trim();
    if (b.sshPublicKey !== undefined) task.sshPublicKey = String(b.sshPublicKey).trim();
    if (Array.isArray(b.availabilityDomains)) {
      task.availabilityDomains = b.availabilityDomains.map((v: unknown) => String(v).trim()).filter(Boolean);
    }
    if (b.assignPublicIp !== undefined) task.assignPublicIp = Boolean(b.assignPublicIp);
    if (b.assignIpv6 !== undefined) task.assignIpv6 = Boolean(b.assignIpv6);
    if (b.adaptiveInterval !== undefined) task.adaptiveInterval = Boolean(b.adaptiveInterval);
    if (b.minIntervalSeconds !== undefined) task.minIntervalSeconds = Math.max(10, Math.min(300, Number(b.minIntervalSeconds) || 20));
    if (b.intervalSeconds !== undefined) {
      task.intervalSeconds = Math.max(10, Math.min(600, Number(b.intervalSeconds) || 30));
      task.currentIntervalSeconds = task.intervalSeconds;
    }
    if (b.maxIntervalSeconds !== undefined) {
      task.maxIntervalSeconds = Math.max(task.minIntervalSeconds ?? 20, Math.min(600, Number(b.maxIntervalSeconds) || 120));
    }
    if (b.stepUp429Seconds !== undefined) task.stepUp429Seconds = Math.max(5, Math.min(120, Number(b.stepUp429Seconds) || 15));
    if (b.stepDownOkSeconds !== undefined) task.stepDownOkSeconds = Math.max(1, Math.min(60, Number(b.stepDownOkSeconds) || 5));
    if (b.jitterPercent !== undefined) task.jitterPercent = Math.min(50, Math.max(0, Number(b.jitterPercent) || 0));
    if (b.retryOnOutOfCapacity !== undefined) task.retryOnOutOfCapacity = Boolean(b.retryOnOutOfCapacity);
    if (b.backoffOn429Seconds !== undefined) task.backoffOn429Seconds = Math.max(30, Number(b.backoffOn429Seconds) || 60);
    if (b.maxAttempts !== undefined) task.maxAttempts = Math.max(0, Number(b.maxAttempts) || 0);
    if (b.autoStopOnSuccess !== undefined) task.autoStopOnSuccess = Boolean(b.autoStopOnSuccess);
    if (b.autoBindDnsRuleId !== undefined) task.autoBindDnsRuleId = b.autoBindDnsRuleId || undefined;
    if (b.useSystemNotifications !== undefined) task.useSystemNotifications = Boolean(b.useSystemNotifications);
    if (Array.isArray(b.notifyChannelIds)) task.notifyChannelIds = b.notifyChannelIds.map(String);
    if (b.status && ['running', 'paused', 'succeeded', 'failed'].includes(b.status)) {
      task.status = b.status;
      if (b.status === 'running') {
        task.nextAttemptAt = new Date().toISOString();
        task.consecutive429Count = 0;
        task.consecutiveOkCount = 0;
        if (!task.currentIntervalSeconds) task.currentIntervalSeconds = task.intervalSeconds || 30;
      } else {
        task.nextAttemptAt = undefined;
      }
    }
    task.updatedAt = new Date().toISOString();
    store.save();

    store.appendAudit({
      category: 'oci',
      severity: 'info',
      action: 'OCI_SNIPER_UPDATED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: task.name,
      details: `Status=${task.status}, ${task.ocpus}C/${task.memoryInGBs}G, adaptive=${task.adaptiveInterval !== false}, interval=${task.intervalSeconds}s`,
    });
    res.json(store.toPublicSniperTask(task));
  });

  app.post('/api/oci/sniper/:id/run-once', requireAuth, async (req: AuthedRequest, res) => {
    const result = await runOciSniperAttempt(req.params.id, req.sessionUser || 'admin', getClientIp(req));
    const task = store.getState().ociSniperTasks.find((t) => t.id === req.params.id);
    res.json({ result, task: task ? store.toPublicSniperTask(task) : null });
  });

  app.get('/api/oci/sniper/:id/script', requireAuth, (req, res) => {
    const state = store.getState();
    const task = state.ociSniperTasks.find((t) => t.id === req.params.id);
    if (!task) {
      res.status(404).json({ error: 'Sniper task not found' });
      return;
    }
    const profile = state.ociProfiles.find((p) => p.id === task.profileId);
    if (!profile) {
      res.status(404).json({ error: 'Linked OCI profile not found' });
      return;
    }
    const format = req.query.format === 'python' ? 'python' : 'bash';
    const out = generateStandaloneOciScript(profile, task, format);
    res.json(out);
  });

  app.delete('/api/oci/sniper/:id', requireAuth, (req: AuthedRequest, res) => {
    const state = store.getState();
    const idx = state.ociSniperTasks.findIndex((t) => t.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'Sniper task not found' });
      return;
    }
    const [removed] = state.ociSniperTasks.splice(idx, 1);
    store.save();
    store.appendAudit({
      category: 'oci',
      severity: 'warning',
      action: 'OCI_SNIPER_DELETED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: removed.name,
      details: 'Deleted OCI ARM sniper configuration',
    });
    res.json({ ok: true });
  });

  // ---- OCI Live Instance Inventory (with deduplication markers) ----
  app.get('/api/oci/profiles/:id/instances', requireAuth, async (req: AuthedRequest, res) => {
    const state = store.getState();
    const profile = state.ociProfiles.find((p) => p.id === req.params.id);
    if (!profile) {
      res.status(404).json({ error: 'OCI profile not found' });
      return;
    }
    const pem = store.getOciPrivateKey(profile.id);
    if (!pem) {
      res.status(400).json({ error: 'OCI profile has no private key configured' });
      return;
    }

    const result = await listOciInstancesDetailed(profile, pem);
    if (!result.ok) {
      profile.status = 'error';
      profile.lastCheckedAt = new Date().toISOString();
      store.save();
      res.status(502).json({ ok: false, instances: [], error: result.error || 'Failed to fetch OCI instances' });
      return;
    }

    const importedByInstanceId = new Map<string, string>();
    for (const h of state.cloudHosts) {
      if (h.instanceId) {
        importedByInstanceId.set(h.instanceId.trim(), h.id);
      }
    }

    profile.instanceCount = result.instances.length;
    profile.lastCheckedAt = new Date().toISOString();
    profile.status = 'active';
    store.save();

    const enriched = result.instances.map((inst) => {
      const existingHostId = importedByInstanceId.get(inst.instanceId.trim());
      return {
        ...inst,
        alreadyImported: Boolean(existingHostId),
        importedHostId: existingHostId,
      };
    });

    res.json({
      ok: true,
      profileId: profile.id,
      region: profile.region,
      instances: enriched,
    });
  });

  // ---- Multi-Cloud API Accounts (AWS EC2 / Aliyun ECS / GCP Compute Engine) ----
  const MANAGED_PROVIDERS = new Set(['oracle', 'aws', 'aliyun', 'gcp']);
  const EXTERNAL_CLOUD_PROVIDERS = new Set<ExternalCloudProvider>(['aws', 'aliyun', 'gcp']);

  app.get('/api/clouds/accounts', requireAuth, (_req, res) => {
    res.json(store.getState().cloudAccounts.map((a) => store.toPublicCloudAccount(a)));
  });

  app.post('/api/clouds/accounts/parse-gcp-json', requireAuth, (req, res) => {
    const raw = typeof req.body?.serviceAccountJson === 'string' ? req.body.serviceAccountJson : '';
    const parsed = parseGcpServiceAccountJson(raw);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    res.json({
      ok: true,
      projectId: parsed.data.projectId,
      clientEmail: parsed.data.clientEmail,
    });
  });

  app.post('/api/clouds/accounts', requireAuth, (req: AuthedRequest, res) => {
    const b = req.body ?? {};
    const provider = String(b.provider || '').trim().toLowerCase() as ExternalCloudProvider;
    if (!EXTERNAL_CLOUD_PROVIDERS.has(provider)) {
      res.status(400).json({ error: '仅支持配置 AWS (EC2)、阿里云 (ECS) 或 Google Cloud (GCP) 云账号凭据' });
      return;
    }
    const name = String(b.name || '').trim();
    if (!name) {
      res.status(400).json({ error: '请填写云账号配置名称' });
      return;
    }

    const region = String(b.region || (provider === 'gcp' ? 'all' : '')).trim().toLowerCase();
    if (!validateCloudRegion(provider, region)) {
      res.status(400).json({
        error:
          provider === 'aws'
            ? '无效的 AWS 区域格式（例如 ap-northeast-1、us-east-1）'
            : provider === 'aliyun'
              ? '无效的阿里云区域格式（例如 cn-hongkong、ap-southeast-1）'
              : '无效的 GCP 区域格式（可填 all 或 asia-east1 等）',
      });
      return;
    }

    let zone = b.zone ? String(b.zone).trim().toLowerCase() : undefined;
    if (zone && provider === 'gcp' && !GCP_ZONE_REGEX.test(zone)) {
      res.status(400).json({ error: '无效的 GCP Zone 格式（例如 asia-east1-b）' });
      return;
    }

    let projectId: string | undefined;
    let clientEmail: string | undefined;
    const accessKeyId = typeof b.accessKeyId === 'string' ? b.accessKeyId.trim() : '';
    const secretKey = typeof b.secretKey === 'string' ? b.secretKey.trim() : '';
    const serviceAccountJson = typeof b.serviceAccountJson === 'string' ? b.serviceAccountJson.trim() : '';

    if (provider === 'gcp') {
      if (!serviceAccountJson) {
        res.status(400).json({ error: '请粘贴或上传 GCP Service Account JSON 密钥文件' });
        return;
      }
      const parsed = parseGcpServiceAccountJson(serviceAccountJson);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      projectId = parsed.data.projectId;
      clientEmail = parsed.data.clientEmail;
    } else {
      if (!accessKeyId || !secretKey) {
        res.status(400).json({ error: '请填写完整的 AccessKey ID 与 AccessKey Secret' });
        return;
      }
    }

    const now = new Date().toISOString();
    const account: StoredCloudAccount = {
      id: `cld-${provider}-${crypto.randomBytes(4).toString('hex')}`,
      name,
      provider,
      region,
      zone: zone || undefined,
      projectId,
      clientEmail,
      instanceCount: 0,
      status: 'unverified',
      notes: b.notes ? String(b.notes).trim() : undefined,
      createdAt: now,
      updatedAt: now,
    };
    store.setCloudAccountSecrets(account, { accessKeyId, secretKey, serviceAccountJson });
    store.getState().cloudAccounts.unshift(account);
    store.save();

    store.appendAudit({
      category: 'cloud',
      severity: 'info',
      action: 'CLOUD_ACCOUNT_CREATED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${account.name} (${provider.toUpperCase()}/${region})`,
      details: `Added ${provider.toUpperCase()} API account${projectId ? ` project=${projectId}` : ''}`,
    });
    res.status(201).json(store.toPublicCloudAccount(account));
  });

  app.put('/api/clouds/accounts/:id', requireAuth, (req: AuthedRequest, res) => {
    const account = store.getState().cloudAccounts.find((a) => a.id === req.params.id);
    if (!account) {
      res.status(404).json({ error: 'Cloud account not found' });
      return;
    }
    const b = req.body ?? {};
    if (b.name !== undefined) account.name = String(b.name).trim() || account.name;
    if (b.region !== undefined) {
      const nextRegion = String(b.region).trim().toLowerCase();
      if (!validateCloudRegion(account.provider, nextRegion)) {
        res.status(400).json({ error: `无效的 ${account.provider.toUpperCase()} 区域格式` });
        return;
      }
      account.region = nextRegion;
    }
    if (b.zone !== undefined) {
      const nextZone = String(b.zone).trim().toLowerCase();
      if (nextZone && account.provider === 'gcp' && !GCP_ZONE_REGEX.test(nextZone)) {
        res.status(400).json({ error: '无效的 GCP Zone 格式（例如 asia-east1-b）' });
        return;
      }
      account.zone = nextZone || undefined;
    }
    if (b.notes !== undefined) account.notes = String(b.notes).trim() || undefined;

    if (account.provider === 'gcp' && typeof b.serviceAccountJson === 'string' && b.serviceAccountJson.trim()) {
      const parsed = parseGcpServiceAccountJson(b.serviceAccountJson);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      account.projectId = parsed.data.projectId;
      account.clientEmail = parsed.data.clientEmail;
      store.setCloudAccountSecrets(account, { serviceAccountJson: b.serviceAccountJson });
    } else if (account.provider !== 'gcp') {
      store.setCloudAccountSecrets(account, {
        accessKeyId: typeof b.accessKeyId === 'string' ? b.accessKeyId : undefined,
        secretKey: typeof b.secretKey === 'string' ? b.secretKey : undefined,
      });
    }

    account.updatedAt = new Date().toISOString();
    store.save();
    store.appendAudit({
      category: 'cloud',
      severity: 'info',
      action: 'CLOUD_ACCOUNT_UPDATED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${account.name} (${account.provider.toUpperCase()}/${account.region})`,
      details: 'Updated cloud API account credentials/settings',
    });
    res.json(store.toPublicCloudAccount(account));
  });

  app.delete('/api/clouds/accounts/:id', requireAuth, (req: AuthedRequest, res) => {
    const state = store.getState();
    const idx = state.cloudAccounts.findIndex((a) => a.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'Cloud account not found' });
      return;
    }
    const [removed] = state.cloudAccounts.splice(idx, 1);
    store.save();
    store.appendAudit({
      category: 'cloud',
      severity: 'warning',
      action: 'CLOUD_ACCOUNT_DELETED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${removed.name} (${removed.provider.toUpperCase()})`,
      details: 'Removed cloud API account',
    });
    res.json({ ok: true });
  });

  app.post('/api/clouds/accounts/:id/test', requireAuth, async (req: AuthedRequest, res) => {
    const account = store.getState().cloudAccounts.find((a) => a.id === req.params.id);
    if (!account) {
      res.status(404).json({ error: 'Cloud account not found' });
      return;
    }
    const secrets = store.getCloudAccountSecrets(account.id);
    const result = await testCloudAccount(account, secrets);
    const now = new Date().toISOString();
    account.lastCheckedAt = now;
    account.updatedAt = now;
    if (result.ok) {
      account.status = 'active';
      account.instanceCount = result.instanceCount;
    } else {
      account.status = 'error';
    }
    store.save();
    if (!result.ok) {
      res.status(502).json({ ok: false, error: result.error, account: store.toPublicCloudAccount(account) });
      return;
    }
    res.json({
      ok: true,
      instanceCount: result.instanceCount,
      account: store.toPublicCloudAccount(account),
    });
  });

  app.get('/api/clouds/accounts/:id/instances', requireAuth, async (req: AuthedRequest, res) => {
    const state = store.getState();
    const account = state.cloudAccounts.find((a) => a.id === req.params.id);
    if (!account) {
      res.status(404).json({ error: 'Cloud account not found' });
      return;
    }
    const secrets = store.getCloudAccountSecrets(account.id);
    const result = await listCloudAccountInstances(account, secrets);
    if (!result.ok) {
      account.status = 'error';
      account.lastCheckedAt = new Date().toISOString();
      store.save();
      res.status(502).json({ ok: false, instances: [], error: result.error || 'Failed to list cloud instances' });
      return;
    }

    const importedKeyMap = new Map<string, string>();
    for (const h of state.cloudHosts) {
      if (h.instanceId) {
        importedKeyMap.set(`${h.provider}:${h.instanceId.trim()}`, h.id);
      }
    }

    account.instanceCount = result.instances.length;
    account.status = 'active';
    account.lastCheckedAt = new Date().toISOString();
    store.save();

    const enriched = result.instances.map((inst) => {
      const existingHostId = importedKeyMap.get(`${inst.provider}:${inst.instanceId.trim()}`);
      return {
        ...inst,
        alreadyImported: Boolean(existingHostId),
        importedHostId: existingHostId,
      };
    });

    res.json({
      ok: true,
      accountId: account.id,
      provider: account.provider,
      region: account.region,
      instances: enriched,
    });
  });

  // ---- Multi-Cloud API-Managed Hosts (Oracle OCI / AWS EC2 / Aliyun ECS / GCP Compute Engine) ----
  app.get('/api/clouds/hosts', requireAuth, (_req, res) => {
    res.json(
      store
        .getState()
        .cloudHosts.filter((h) => MANAGED_PROVIDERS.has(h.provider))
        .map((h) => store.toPublicCloudHost(h))
    );
  });

  app.post('/api/clouds/hosts', requireAuth, (req: AuthedRequest, res) => {
    const b = req.body ?? {};
    if (!b.name) {
      res.status(400).json({ error: 'Host name is required' });
      return;
    }
    const provider = String(b.provider || 'oracle').trim().toLowerCase();
    if (!MANAGED_PROVIDERS.has(provider)) {
      res.status(400).json({
        error: '本项目仅保留支持 API 实控管理的云主机（Oracle OCI / AWS EC2 / 阿里云 ECS / GCP），不支持手动托管其他云服务商。',
      });
      return;
    }

    const state = store.getState();
    const ipv4 = String(b.ipv4 || '').trim();
    if (ipv4 && !net.isIPv4(ipv4)) {
      res.status(400).json({ error: 'Invalid IPv4 address format' });
      return;
    }

    const cleanInstanceId = String(b.instanceId || '').trim();
    let resolvedRegion = String(b.region || '').trim();
    let defaultGroup = '默认分组';
    let ociProfileId: string | undefined;
    let cloudAccountId: string | undefined;

    if (provider === 'oracle') {
      const pid = String(b.ociProfileId || '').trim();
      const profile = pid ? state.ociProfiles.find((p) => p.id === pid) : undefined;
      if (!profile) {
        res.status(400).json({ error: '请关联已配置的 Oracle OCI 区域凭据，或使用「从云端导入实例」自动添加。' });
        return;
      }
      if (!cleanInstanceId || !isValidOcid(cleanInstanceId)) {
        res.status(400).json({ error: '请提供有效的 OCI 实例 OCID。' });
        return;
      }
      ociProfileId = profile.id;
      resolvedRegion = resolvedRegion || profile.region;
      defaultGroup = profile.name || profile.region || '默认分组';
    } else {
      const aid = String(b.cloudAccountId || '').trim();
      const account = aid ? state.cloudAccounts.find((a) => a.id === aid && a.provider === provider) : undefined;
      if (!account) {
        res.status(400).json({ error: `请关联已配置的 ${provider.toUpperCase()} 云账号凭据，或使用「从云端导入实例」自动添加。` });
        return;
      }
      if (!cleanInstanceId || !CLOUD_INSTANCE_ID_REGEX.test(cleanInstanceId)) {
        res.status(400).json({ error: `请提供有效的 ${provider.toUpperCase()} 实例 ID。` });
        return;
      }
      cloudAccountId = account.id;
      resolvedRegion = resolvedRegion || account.region;
      defaultGroup = account.name || account.region || '默认分组';
    }

    if (
      state.cloudHosts.some(
        (h) => h.provider === provider && h.instanceId && h.instanceId.trim() === cleanInstanceId
      )
    ) {
      res.status(409).json({ error: '该实例已添加，不能重复添加 (Instance already exists)' });
      return;
    }

    const now = new Date().toISOString();
    const host: StoredCloudHost = {
      id: `host-${crypto.randomBytes(5).toString('hex')}`,
      name: String(b.name).trim(),
      groupName: String(b.groupName || defaultGroup).trim() || defaultGroup,
      provider: provider as StoredCloudHost['provider'],
      region: resolvedRegion,
      instanceId: cleanInstanceId,
      architecture: b.architecture === 'arm64' ? 'arm64' : 'x86_64',
      specs: String(b.specs || '').trim(),
      ipv4,
      ipv6List: sanitizeIpv6List(b.ipv6List),
      sshPort: Math.min(65535, Math.max(1, Number(b.sshPort) || 22)),
      sshUser: String(b.sshUser || 'ubuntu').trim(),
      linkedDnsRuleId: b.linkedDnsRuleId || undefined,
      ociProfileId,
      ociVnicId: b.ociVnicId ? String(b.ociVnicId).trim() : undefined,
      ociPrimaryPrivateIpId: b.ociPrimaryPrivateIpId ? String(b.ociPrimaryPrivateIpId).trim() : undefined,
      ociLifecycleState: b.ociLifecycleState ? String(b.ociLifecycleState).trim() : undefined,
      availabilityDomain: b.availabilityDomain ? String(b.availabilityDomain).trim() : undefined,
      cloudAccountId,
      cloudZone: b.cloudZone ? String(b.cloudZone).trim() : undefined,
      cloudNetworkInterfaceId: b.cloudNetworkInterfaceId ? String(b.cloudNetworkInterfaceId).trim() : undefined,
      cloudEipAllocationId: b.cloudEipAllocationId ? String(b.cloudEipAllocationId).trim() : undefined,
      cloudAllocationAssociationId: b.cloudAllocationAssociationId ? String(b.cloudAllocationAssociationId).trim() : undefined,
      status: b.status || 'online',
      lastCheckedAt: now,
      notes: b.notes ? String(b.notes).trim() : undefined,
      createdAt: now,
      updatedAt: now,
    };
    store.setCloudHostSecret(host, b.apiSecret);
    state.cloudHosts.unshift(host);
    store.save();

    store.appendAudit({
      category: 'cloud',
      severity: 'info',
      action: 'CLOUD_HOST_CREATED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${host.name} (${host.provider.toUpperCase()}/${host.groupName}/${host.region})`,
      details: `IPv4=${host.ipv4 || 'none'}, IPv6 count=${host.ipv6List.length}`,
    });
    res.status(201).json(store.toPublicCloudHost(host));
  });

  // Batch / Single Import from OCI Instance Discovery (with server-side dedup + group assignment + optional auto-monitor)
  app.post('/api/clouds/hosts/import-oci', requireAuth, async (req: AuthedRequest, res) => {
    const b = req.body ?? {};
    const profileId = String(b.profileId || '').trim();
    const rawInstances = Array.isArray(b.instances) ? b.instances : [];
    const autoMonitor = b.autoMonitor !== false;

    const state = store.getState();
    const profile = state.ociProfiles.find((p) => p.id === profileId);
    if (!profile) {
      res.status(404).json({ error: 'OCI profile not found' });
      return;
    }
    if (!store.getOciPrivateKey(profile.id)) {
      res.status(400).json({ error: 'OCI profile has no private key configured' });
      return;
    }
    if (rawInstances.length === 0) {
      res.status(400).json({ error: 'No instances selected to import' });
      return;
    }

    const assignedGroup = String(b.groupName || '').trim() || profile.name || profile.region || '默认分组';
    const existingIds = new Set(
      state.cloudHosts.map((h) => h.instanceId?.trim()).filter(Boolean) as string[]
    );
    const now = new Date().toISOString();
    const addedHosts: StoredCloudHost[] = [];
    const createdMonitors: MonitorTarget[] = [];
    let skippedCount = 0;

    for (const item of rawInstances) {
      const instanceId = String(item?.instanceId || '').trim();
      if (!instanceId || !isValidOcid(instanceId)) {
        skippedCount += 1;
        continue;
      }
      if (existingIds.has(instanceId)) {
        skippedCount += 1;
        continue;
      }

      const cleanV4 = String(item.publicIp || item.ipv4 || '').trim();
      const validV4 = cleanV4 && net.isIPv4(cleanV4) ? cleanV4 : '';
      const v6List = sanitizeIpv6List(item.ipv6List);
      const lifecycleState = String(item.lifecycleState || 'RUNNING').toUpperCase();

      const host: StoredCloudHost = {
        id: `host-${crypto.randomBytes(5).toString('hex')}`,
        name: String(item.displayName || item.name || instanceId.slice(-10)).trim(),
        groupName: assignedGroup,
        provider: 'oracle',
        region: String(item.region || profile.region).trim(),
        instanceId,
        architecture: item.architecture === 'arm64' ? 'arm64' : 'x86_64',
        specs: String(item.specs || item.shape || 'OCI Compute').trim(),
        ipv4: validV4,
        ipv6List: v6List,
        sshPort: 22,
        sshUser: 'ubuntu',
        ociProfileId: profile.id,
        ociVnicId: item.vnicId ? String(item.vnicId).trim() : undefined,
        ociPrimaryPrivateIpId: item.primaryPrivateIpId ? String(item.primaryPrivateIpId).trim() : undefined,
        ociPublicIpId: item.publicIpId ? String(item.publicIpId).trim() : undefined,
        ociPublicIpLifetime: item.publicIpLifetime === 'RESERVED' || item.publicIpLifetime === 'EPHEMERAL'
          ? item.publicIpLifetime
          : undefined,
        ociIpv6Entries: Array.isArray(item.ipv6Entries)
          ? item.ipv6Entries
              .filter((e: { id?: string; ipAddress?: string }) => e?.id && e?.ipAddress)
              .map((e: { id: string; ipAddress: string }) => ({ id: String(e.id), ipAddress: String(e.ipAddress) }))
          : undefined,
        ociLifecycleState: lifecycleState,
        availabilityDomain: item.availabilityDomain ? String(item.availabilityDomain).trim() : undefined,
        status: mapOciStateToHostStatus(lifecycleState),
        lastCheckedAt: now,
        createdAt: now,
        updatedAt: now,
      };

      state.cloudHosts.unshift(host);
      existingIds.add(instanceId);
      addedHosts.push(host);

      if (autoMonitor && (validV4 || v6List[0])) {
        const probeTarget = validV4 || v6List[0];
        const mon: MonitorTarget = {
          id: `mon-${crypto.randomBytes(5).toString('hex')}`,
          name: `${host.name} (SSH :${host.sshPort})`,
          type: 'tcp',
          target: probeTarget,
          port: host.sshPort,
          intervalSeconds: 60,
          timeoutMs: 5000,
          failureThreshold: 2,
          enabled: true,
          notifyOnAlert: true,
          linkedHostId: host.id,
          status: 'pending',
          consecutiveFailures: 0,
          uptimePercent: 100,
          history: [],
          createdAt: now,
          updatedAt: now,
        };
        state.monitors.unshift(mon);
        createdMonitors.push(mon);
      }
    }

    store.save();

    if (addedHosts.length > 0) {
      store.appendAudit({
        category: 'cloud',
        severity: 'success',
        action: 'CLOUD_HOSTS_IMPORTED_OCI',
        actor: req.sessionUser || 'admin',
        ip: getClientIp(req),
        target: `${profile.name} (${profile.region}) -> ${assignedGroup}`,
        details: `Imported ${addedHosts.length} OCI instance(s), skipped ${skippedCount} duplicate(s), created ${createdMonitors.length} monitor(s)`,
      });
    }

    res.status(201).json({
      ok: true,
      added: addedHosts.map((h) => store.toPublicCloudHost(h)),
      skippedCount,
      monitorsCreated: createdMonitors.length,
    });
  });

  // Batch / Single Import from AWS EC2 / Aliyun ECS / GCP Compute Engine Discovery
  app.post('/api/clouds/hosts/import-cloud', requireAuth, async (req: AuthedRequest, res) => {
    const b = req.body ?? {};
    const accountId = String(b.accountId || '').trim();
    const rawInstances = Array.isArray(b.instances) ? b.instances : [];
    const autoMonitor = b.autoMonitor !== false;

    const state = store.getState();
    const account = state.cloudAccounts.find((a) => a.id === accountId);
    if (!account) {
      res.status(404).json({ error: 'Cloud account not found' });
      return;
    }
    const secrets = store.getCloudAccountSecrets(account.id);
    const hasCreds =
      account.provider === 'gcp'
        ? Boolean(secrets.serviceAccountJson)
        : Boolean(secrets.accessKeyId && secrets.secretKey);
    if (!hasCreds) {
      res.status(400).json({ error: `${account.provider.toUpperCase()} 云账号未配置有效凭据` });
      return;
    }
    if (rawInstances.length === 0) {
      res.status(400).json({ error: 'No instances selected to import' });
      return;
    }

    const assignedGroup = String(b.groupName || '').trim() || account.name || account.region || '默认分组';
    const existingKeys = new Set(
      state.cloudHosts.map((h) => `${h.provider}:${h.instanceId?.trim() || ''}`)
    );
    const now = new Date().toISOString();
    const addedHosts: StoredCloudHost[] = [];
    const createdMonitors: MonitorTarget[] = [];
    let skippedCount = 0;

    for (const item of rawInstances) {
      const instanceId = String(item?.instanceId || '').trim();
      if (!instanceId || !CLOUD_INSTANCE_ID_REGEX.test(instanceId)) {
        skippedCount += 1;
        continue;
      }
      const dedupKey = `${account.provider}:${instanceId}`;
      if (existingKeys.has(dedupKey)) {
        skippedCount += 1;
        continue;
      }

      const cleanV4 = String(item.publicIp || item.ipv4 || '').trim();
      const validV4 = cleanV4 && net.isIPv4(cleanV4) ? cleanV4 : '';
      const v6List = sanitizeIpv6List(item.ipv6List);
      const lifecycleState = String(item.lifecycleState || 'RUNNING').toUpperCase();

      const host: StoredCloudHost = {
        id: `host-${crypto.randomBytes(5).toString('hex')}`,
        name: String(item.displayName || item.name || instanceId).trim(),
        groupName: assignedGroup,
        provider: account.provider,
        region: String(item.region || account.region).trim(),
        instanceId,
        architecture: item.architecture === 'arm64' ? 'arm64' : 'x86_64',
        specs: String(item.specs || item.shape || account.provider.toUpperCase()).trim(),
        ipv4: validV4,
        ipv6List: v6List,
        sshPort: 22,
        sshUser: account.provider === 'aliyun' ? 'root' : 'ubuntu',
        ociLifecycleState: lifecycleState,
        cloudAccountId: account.id,
        cloudZone: item.zone ? String(item.zone).trim() : account.zone,
        cloudNetworkInterfaceId: item.networkInterfaceId ? String(item.networkInterfaceId).trim() : undefined,
        cloudEipAllocationId: item.eipAllocationId ? String(item.eipAllocationId).trim() : undefined,
        cloudAllocationAssociationId: item.eipAssociationId ? String(item.eipAssociationId).trim() : undefined,
        status: mapCloudStateToHostStatus(lifecycleState),
        lastCheckedAt: now,
        createdAt: now,
        updatedAt: now,
      };

      state.cloudHosts.unshift(host);
      existingKeys.add(dedupKey);
      addedHosts.push(host);

      if (autoMonitor && (validV4 || v6List[0])) {
        const probeTarget = validV4 || v6List[0];
        const mon: MonitorTarget = {
          id: `mon-${crypto.randomBytes(5).toString('hex')}`,
          name: `${host.name} (SSH :${host.sshPort})`,
          type: 'tcp',
          target: probeTarget,
          port: host.sshPort,
          intervalSeconds: 60,
          timeoutMs: 5000,
          failureThreshold: 2,
          enabled: true,
          notifyOnAlert: true,
          linkedHostId: host.id,
          status: 'pending',
          consecutiveFailures: 0,
          uptimePercent: 100,
          history: [],
          createdAt: now,
          updatedAt: now,
        };
        state.monitors.unshift(mon);
        createdMonitors.push(mon);
      }
    }

    store.save();
    if (addedHosts.length > 0) {
      store.appendAudit({
        category: 'cloud',
        severity: 'success',
        action: 'CLOUD_HOSTS_IMPORTED',
        actor: req.sessionUser || 'admin',
        ip: getClientIp(req),
        target: `${account.name} (${account.provider.toUpperCase()}/${account.region}) -> ${assignedGroup}`,
        details: `Imported ${addedHosts.length} ${account.provider.toUpperCase()} instance(s), skipped ${skippedCount} duplicate(s), created ${createdMonitors.length} monitor(s)`,
      });
    }

    res.status(201).json({
      ok: true,
      added: addedHosts.map((h) => store.toPublicCloudHost(h)),
      skippedCount,
      monitorsCreated: createdMonitors.length,
    });
  });

  // One-click Multi-Cloud Sync: scans all configured OCI profiles + AWS/Aliyun/GCP accounts
  const handleSyncAllClouds = async (req: AuthedRequest, res: Response) => {
    const state = store.getState();
    const autoMonitor = req.body?.autoMonitor !== false;
    const readyOciProfiles = state.ociProfiles.filter((p) => Boolean(store.getOciPrivateKey(p.id)));
    const readyCloudAccounts = state.cloudAccounts.filter((a) => {
      const s = store.getCloudAccountSecrets(a.id);
      return a.provider === 'gcp' ? Boolean(s.serviceAccountJson) : Boolean(s.accessKeyId && s.secretKey);
    });

    if (readyOciProfiles.length === 0 && readyCloudAccounts.length === 0) {
      res.status(400).json({
        error: '尚未配置任何可用云凭据（OCI 私钥或 AWS / 阿里云 / GCP 账号），请先添加云账号凭据。',
      });
      return;
    }

    const now = new Date().toISOString();
    let importedCount = 0;
    let updatedCount = 0;
    const errors: string[] = [];

    // 1. Scan Oracle OCI profiles
    for (const profile of readyOciProfiles) {
      const pem = store.getOciPrivateKey(profile.id);
      if (!pem) continue;

      const discovered = await listOciInstancesDetailed(profile, pem);
      if (!discovered.ok) {
        errors.push(`OCI ${profile.name} (${profile.region}): ${discovered.error || 'OCI query failed'}`);
        continue;
      }

      profile.instanceCount = discovered.instances.length;
      profile.status = 'active';
      profile.lastCheckedAt = now;

      for (const inst of discovered.instances) {
        const existing = state.cloudHosts.find(
          (h) => h.provider === 'oracle' && h.instanceId.trim() === inst.instanceId.trim()
        );
        const validV4 = inst.publicIp && net.isIPv4(inst.publicIp) ? inst.publicIp : '';
        const v6List = sanitizeIpv6List(inst.ipv6List);
        const lifecycleState = String(inst.lifecycleState || 'RUNNING').toUpperCase();

        if (existing) {
          existing.ociProfileId = profile.id;
          existing.region = profile.region;
          existing.specs = inst.specs || existing.specs;
          existing.architecture = inst.architecture === 'arm64' ? 'arm64' : 'x86_64';
          existing.ipv4 = validV4;
          existing.ipv6List = v6List;
          existing.ociVnicId = inst.vnicId || existing.ociVnicId;
          existing.ociPrimaryPrivateIpId = inst.primaryPrivateIpId || existing.ociPrimaryPrivateIpId;
          existing.ociPublicIpId = inst.publicIpId;
          existing.ociPublicIpLifetime = inst.publicIpLifetime;
          existing.ociIpv6Entries = inst.ipv6Entries;
          existing.ociLifecycleState = lifecycleState;
          existing.availabilityDomain = inst.availabilityDomain || existing.availabilityDomain;
          existing.status = mapOciStateToHostStatus(lifecycleState);
          existing.lastCheckedAt = now;
          existing.updatedAt = now;
          updatedCount += 1;
        } else {
          const host: StoredCloudHost = {
            id: `host-${crypto.randomBytes(5).toString('hex')}`,
            name: String(inst.displayName || inst.instanceId.slice(-10)).trim(),
            groupName: profile.name || profile.region || '默认分组',
            provider: 'oracle',
            region: profile.region,
            instanceId: inst.instanceId,
            architecture: inst.architecture === 'arm64' ? 'arm64' : 'x86_64',
            specs: inst.specs || inst.shape || 'OCI Compute',
            ipv4: validV4,
            ipv6List: v6List,
            sshPort: 22,
            sshUser: 'ubuntu',
            ociProfileId: profile.id,
            ociVnicId: inst.vnicId,
            ociPrimaryPrivateIpId: inst.primaryPrivateIpId,
            ociPublicIpId: inst.publicIpId,
            ociPublicIpLifetime: inst.publicIpLifetime,
            ociIpv6Entries: inst.ipv6Entries,
            ociLifecycleState: lifecycleState,
            availabilityDomain: inst.availabilityDomain,
            status: mapOciStateToHostStatus(lifecycleState),
            lastCheckedAt: now,
            createdAt: now,
            updatedAt: now,
          };
          state.cloudHosts.unshift(host);
          importedCount += 1;

          if (autoMonitor && (validV4 || v6List[0])) {
            state.monitors.unshift({
              id: `mon-${crypto.randomBytes(5).toString('hex')}`,
              name: `${host.name} (SSH :22)`,
              type: 'tcp',
              target: validV4 || v6List[0],
              port: 22,
              intervalSeconds: 60,
              timeoutMs: 5000,
              failureThreshold: 2,
              enabled: true,
              notifyOnAlert: true,
              linkedHostId: host.id,
              status: 'pending',
              consecutiveFailures: 0,
              uptimePercent: 100,
              history: [],
              createdAt: now,
              updatedAt: now,
            });
          }
        }
      }
    }

    // 2. Scan AWS EC2 / Aliyun ECS / GCP Compute Engine accounts
    for (const account of readyCloudAccounts) {
      const secrets = store.getCloudAccountSecrets(account.id);
      const discovered = await listCloudAccountInstances(account, secrets);
      if (!discovered.ok) {
        account.status = 'error';
        account.lastCheckedAt = now;
        errors.push(`${account.provider.toUpperCase()} ${account.name}: ${discovered.error || 'API query failed'}`);
        continue;
      }

      account.instanceCount = discovered.instances.length;
      account.status = 'active';
      account.lastCheckedAt = now;

      for (const inst of discovered.instances) {
        const existing = state.cloudHosts.find(
          (h) => h.provider === account.provider && h.instanceId.trim() === inst.instanceId.trim()
        );
        const validV4 = inst.publicIp && net.isIPv4(inst.publicIp) ? inst.publicIp : '';
        const v6List = sanitizeIpv6List(inst.ipv6List);
        const lifecycleState = String(inst.lifecycleState || 'RUNNING').toUpperCase();

        if (existing) {
          existing.cloudAccountId = account.id;
          existing.region = inst.region || account.region;
          existing.cloudZone = inst.zone || existing.cloudZone;
          existing.specs = inst.specs || existing.specs;
          existing.architecture = inst.architecture === 'arm64' ? 'arm64' : 'x86_64';
          existing.ipv4 = validV4;
          existing.ipv6List = v6List;
          existing.cloudNetworkInterfaceId = inst.networkInterfaceId || existing.cloudNetworkInterfaceId;
          existing.cloudEipAllocationId = inst.eipAllocationId;
          existing.cloudAllocationAssociationId = inst.eipAssociationId;
          existing.ociLifecycleState = lifecycleState;
          existing.status = mapCloudStateToHostStatus(lifecycleState);
          existing.lastCheckedAt = now;
          existing.updatedAt = now;
          updatedCount += 1;
        } else {
          const host: StoredCloudHost = {
            id: `host-${crypto.randomBytes(5).toString('hex')}`,
            name: String(inst.displayName || inst.instanceId).trim(),
            groupName: account.name || account.region || '默认分组',
            provider: account.provider,
            region: inst.region || account.region,
            instanceId: inst.instanceId,
            architecture: inst.architecture === 'arm64' ? 'arm64' : 'x86_64',
            specs: inst.specs || inst.shape || account.provider.toUpperCase(),
            ipv4: validV4,
            ipv6List: v6List,
            sshPort: 22,
            sshUser: account.provider === 'aliyun' ? 'root' : 'ubuntu',
            ociLifecycleState: lifecycleState,
            cloudAccountId: account.id,
            cloudZone: inst.zone || account.zone,
            cloudNetworkInterfaceId: inst.networkInterfaceId,
            cloudEipAllocationId: inst.eipAllocationId,
            cloudAllocationAssociationId: inst.eipAssociationId,
            status: mapCloudStateToHostStatus(lifecycleState),
            lastCheckedAt: now,
            createdAt: now,
            updatedAt: now,
          };
          state.cloudHosts.unshift(host);
          importedCount += 1;

          if (autoMonitor && (validV4 || v6List[0])) {
            state.monitors.unshift({
              id: `mon-${crypto.randomBytes(5).toString('hex')}`,
              name: `${host.name} (SSH :22)`,
              type: 'tcp',
              target: validV4 || v6List[0],
              port: 22,
              intervalSeconds: 60,
              timeoutMs: 5000,
              failureThreshold: 2,
              enabled: true,
              notifyOnAlert: true,
              linkedHostId: host.id,
              status: 'pending',
              consecutiveFailures: 0,
              uptimePercent: 100,
              history: [],
              createdAt: now,
              updatedAt: now,
            });
          }
        }
      }
    }

    const totalSources = readyOciProfiles.length + readyCloudAccounts.length;
    store.save();
    store.appendAudit({
      category: 'cloud',
      severity: errors.length > 0 ? 'warning' : 'success',
      action: 'CLOUD_HOSTS_SYNC_ALL',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${totalSources} cloud account(s)/region(s)`,
      details: `Imported ${importedCount}, refreshed ${updatedCount}${errors.length ? `, errors: ${errors.join('; ')}` : ''}`,
    });

    res.json({
      ok: true,
      profilesScanned: totalSources,
      importedCount,
      updatedCount,
      errors,
    });
  };

  app.post('/api/clouds/hosts/sync-all', requireAuth, handleSyncAllClouds);
  app.post('/api/clouds/hosts/sync-all-oci', requireAuth, handleSyncAllClouds);

  app.put('/api/clouds/hosts/:id', requireAuth, (req: AuthedRequest, res) => {
    const host = store.getState().cloudHosts.find((h) => h.id === req.params.id);
    if (!host) {
      res.status(404).json({ error: 'Cloud host not found' });
      return;
    }
    const b = req.body ?? {};
    if (b.name !== undefined) host.name = String(b.name).trim() || host.name;
    if (b.groupName !== undefined) host.groupName = String(b.groupName).trim() || '默认分组';
    if (!MANAGED_PROVIDERS.has(host.provider)) {
      host.provider = 'oracle';
    }
    if (b.sshPort !== undefined) host.sshPort = Math.min(65535, Math.max(1, Number(b.sshPort) || 22));
    if (b.sshUser !== undefined) host.sshUser = String(b.sshUser).trim() || 'ubuntu';
    if (b.linkedDnsRuleId !== undefined) host.linkedDnsRuleId = b.linkedDnsRuleId || undefined;
    if (b.notes !== undefined) host.notes = String(b.notes).trim();
    host.updatedAt = new Date().toISOString();
    store.save();

    store.appendAudit({
      category: 'cloud',
      severity: 'info',
      action: 'CLOUD_HOST_UPDATED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${host.name} (${host.provider.toUpperCase()}/${host.groupName || '默认分组'})`,
      details: `Updated cloud host metadata (SSH ${host.sshUser}@:${host.sshPort})`,
    });
    res.json(store.toPublicCloudHost(host));
  });

  // Live Instance Status Refresh (OCI / AWS / Aliyun / GCP API + TCP Reachability Probe + linked Monitor sync)
  app.post('/api/clouds/hosts/:id/refresh-status', requireAuth, async (req: AuthedRequest, res) => {
    const state = store.getState();
    const host = state.cloudHosts.find((h) => h.id === req.params.id);
    if (!host) {
      res.status(404).json({ error: 'Cloud host not found' });
      return;
    }

    let ociRefreshed = false;
    let ociError: string | undefined;

    if (host.provider === 'oracle' && host.ociProfileId && host.instanceId && isValidOcid(host.instanceId)) {
      const profile = state.ociProfiles.find((p) => p.id === host.ociProfileId);
      const pem = profile ? store.getOciPrivateKey(profile.id) : '';
      if (profile && pem) {
        const detail = await getOciInstanceDetail(profile, pem, host.instanceId, host.ociVnicId);
        if (detail.ok) {
          ociRefreshed = true;
          if (detail.lifecycleState) {
            host.ociLifecycleState = detail.lifecycleState;
            host.status = mapOciStateToHostStatus(detail.lifecycleState);
          }
          if (detail.specs) host.specs = detail.specs;
          if (detail.availabilityDomain) host.availabilityDomain = detail.availabilityDomain;
          if (detail.vnicId) host.ociVnicId = detail.vnicId;
          if (detail.primaryPrivateIpId) host.ociPrimaryPrivateIpId = detail.primaryPrivateIpId;
          if (detail.publicIp !== undefined) host.ipv4 = detail.publicIp || '';
          host.ociPublicIpId = detail.publicIpId;
          host.ociPublicIpLifetime = detail.publicIpLifetime;
          if (detail.ipv6List) host.ipv6List = detail.ipv6List;
          if (detail.ipv6Entries) host.ociIpv6Entries = detail.ipv6Entries;
        } else {
          ociError = detail.error;
        }
      }
    } else if (
      (host.provider === 'aws' || host.provider === 'aliyun' || host.provider === 'gcp') &&
      host.cloudAccountId
    ) {
      const account = state.cloudAccounts.find((a) => a.id === host.cloudAccountId);
      if (account) {
        const secrets = store.getCloudAccountSecrets(account.id);
        const detail = await getCloudHostDetail(account, secrets, host);
        if (detail.ok) {
          ociRefreshed = true;
          if (detail.lifecycleState) {
            host.ociLifecycleState = detail.lifecycleState;
            host.status = mapCloudStateToHostStatus(detail.lifecycleState);
          }
          if (detail.specs) host.specs = detail.specs;
          if (detail.zone) host.cloudZone = detail.zone;
          if (detail.networkInterfaceId) host.cloudNetworkInterfaceId = detail.networkInterfaceId;
          if (detail.publicIp !== undefined) host.ipv4 = detail.publicIp || '';
          host.cloudEipAllocationId = detail.eipAllocationId;
          host.cloudAllocationAssociationId = detail.eipAssociationId;
          if (detail.ipv6List) host.ipv6List = detail.ipv6List;
        } else {
          ociError = detail.error;
        }
      }
    }

    // Run real TCP reachability probe on the host IP & SSH port
    const targetAddr = host.ipv4 || host.ipv6List[0];
    let probeResult: MonitorCheckSample | null = null;
    if (targetAddr) {
      probeResult = await probeTcp(targetAddr, host.sshPort || 22, 4500);
      host.lastLatencyMs = probeResult.latencyMs;
      host.lastProbeMessage = probeResult.message;
      if (!ociRefreshed) {
        host.status = probeResult.status === 'up' ? 'online' : probeResult.status === 'degraded' ? 'degraded' : 'offline';
      } else if (host.ociLifecycleState === 'RUNNING' && probeResult.status === 'down') {
        host.status = 'degraded';
      }
    }

    host.lastCheckedAt = new Date().toISOString();
    host.updatedAt = host.lastCheckedAt;
    store.save();

    // If a persistent MonitorTarget is linked to this host, sync & run it too
    const linkedMonitor = state.monitors.find((m) => m.linkedHostId === host.id);
    let updatedMonitor: MonitorTarget | null = null;
    if (linkedMonitor) {
      if (targetAddr) linkedMonitor.target = targetAddr;
      linkedMonitor.port = host.sshPort || 22;
      store.save();
      updatedMonitor = await runMonitorCheck(linkedMonitor.id, req.sessionUser || 'admin', getClientIp(req));
    }

    res.json({
      ok: true,
      host: store.toPublicCloudHost(host),
      ociRefreshed,
      ociError,
      probe: probeResult,
      monitor: updatedMonitor,
    });
  });

  // One-click Enable / Trigger Persistent Monitor for a Cloud Host
  app.post('/api/clouds/hosts/:id/monitor', requireAuth, async (req: AuthedRequest, res) => {
    const state = store.getState();
    const host = state.cloudHosts.find((h) => h.id === req.params.id);
    if (!host) {
      res.status(404).json({ error: 'Cloud host not found' });
      return;
    }

    const targetAddr = host.ipv4 || host.ipv6List[0];
    if (!targetAddr) {
      res.status(400).json({ error: '该实例暂无可探测的公网 IPv4/IPv6 地址' });
      return;
    }

    let mon = state.monitors.find((m) => m.linkedHostId === host.id);
    const now = new Date().toISOString();

    if (!mon) {
      mon = {
        id: `mon-${crypto.randomBytes(5).toString('hex')}`,
        name: `${host.name} (TCP :${host.sshPort || 22})`,
        type: 'tcp',
        target: targetAddr,
        port: host.sshPort || 22,
        intervalSeconds: 60,
        timeoutMs: 5000,
        failureThreshold: 2,
        enabled: true,
        notifyOnAlert: true,
        linkedHostId: host.id,
        status: 'pending',
        consecutiveFailures: 0,
        uptimePercent: 100,
        history: [],
        createdAt: now,
        updatedAt: now,
      };
      state.monitors.unshift(mon);
      store.save();

      store.appendAudit({
        category: 'monitor',
        severity: 'info',
        action: 'HOST_MONITOR_ENABLED',
        actor: req.sessionUser || 'admin',
        ip: getClientIp(req),
        target: host.name,
        details: `Enabled TCP :${mon.port} monitor on ${targetAddr}`,
      });
    } else if (req.body?.toggle === true) {
      mon.enabled = !mon.enabled;
      mon.updatedAt = now;
      store.save();
    }

    const checked = mon.enabled
      ? await runMonitorCheck(mon.id, req.sessionUser || 'admin', getClientIp(req))
      : mon;

    if (checked?.lastLatencyMs !== undefined) {
      host.lastLatencyMs = checked.lastLatencyMs;
      host.lastProbeMessage = checked.lastMessage;
      host.lastCheckedAt = checked.lastCheckedAt;
      store.save();
    }

    res.json({ ok: true, monitor: checked || mon, host: store.toPublicCloudHost(host) });
  });

  // Real Multi-Cloud Instance Power Control (OCI / AWS EC2 / Aliyun ECS / GCP Compute Engine)
  app.post('/api/clouds/hosts/:id/power', requireAuth, async (req: AuthedRequest, res) => {
    const state = store.getState();
    const host = state.cloudHosts.find((h) => h.id === req.params.id);
    if (!host) {
      res.status(404).json({ error: 'Cloud host not found' });
      return;
    }

    const rawAction = String(req.body?.action || '').trim().toUpperCase();
    const allowed: OciInstanceAction[] = ['SOFTRESET', 'RESET', 'START', 'SOFTSTOP', 'STOP'];
    if (!allowed.includes(rawAction as OciInstanceAction)) {
      res.status(400).json({ error: 'Invalid power action (allowed: SOFTRESET, RESET, START, SOFTSTOP, STOP)' });
      return;
    }
    const action = rawAction as OciInstanceAction;
    const providerTag = host.provider.toUpperCase();
    let result: { ok: boolean; lifecycleState?: string; error?: string };

    if (host.provider === 'oracle') {
      if (!host.ociProfileId || !host.instanceId || !isValidOcid(host.instanceId)) {
        res.status(400).json({ error: '该主机未关联有效的 OCI 实例凭据，无法执行云端电源操作' });
        return;
      }
      const profile = state.ociProfiles.find((p) => p.id === host.ociProfileId);
      const pem = profile ? store.getOciPrivateKey(profile.id) : '';
      if (!profile || !pem) {
        res.status(400).json({ error: '关联的 OCI 凭据不存在或未配置私钥 PEM' });
        return;
      }
      result = await ociInstancePowerAction(profile, pem, host.instanceId, action);
    } else if (host.provider === 'aws' || host.provider === 'aliyun' || host.provider === 'gcp') {
      const account = host.cloudAccountId
        ? state.cloudAccounts.find((a) => a.id === host.cloudAccountId)
        : undefined;
      if (!account) {
        res.status(400).json({ error: `该 ${providerTag} 主机未关联云账号凭据` });
        return;
      }
      const secrets = store.getCloudAccountSecrets(account.id);
      result = await cloudHostPowerAction(account, secrets, host, action);
    } else {
      res.status(400).json({ error: '不支持该云服务商的远程电源控制' });
      return;
    }

    if (!result.ok) {
      store.appendAudit({
        category: 'cloud',
        severity: 'error',
        action: `CLOUD_INSTANCE_${action}_FAILED`,
        actor: req.sessionUser || 'admin',
        ip: getClientIp(req),
        target: `${host.name} (${providerTag}/${host.region})`,
        details: result.error || `${providerTag} ${action} failed`,
      });
      res.status(502).json({ ok: false, error: result.error || `${providerTag} ${action} failed` });
      return;
    }

    const now = new Date().toISOString();
    host.ociLifecycleState = result.lifecycleState || host.ociLifecycleState;
    host.status =
      action === 'SOFTRESET' || action === 'RESET'
        ? 'provisioning'
        : host.provider === 'oracle'
          ? mapOciStateToHostStatus(result.lifecycleState)
          : mapCloudStateToHostStatus(result.lifecycleState);
    host.lastCheckedAt = now;
    host.updatedAt = now;
    store.save();

    store.appendAudit({
      category: 'cloud',
      severity: action === 'RESET' || action === 'STOP' ? 'warning' : 'success',
      action: `CLOUD_INSTANCE_${action}`,
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${host.name} (${providerTag}/${host.region})`,
      details: `Executed ${providerTag} ${action} on ${host.instanceId} -> state=${host.ociLifecycleState || 'PENDING'}`,
    });

    res.json({
      ok: true,
      action,
      lifecycleState: host.ociLifecycleState,
      host: store.toPublicCloudHost(host),
    });
  });

  // Helper: sync host's current IPv4/IPv6 + OCI metadata to ALL bound DNS rules and linked Monitors
  async function cascadeHostIpsToDomainAndMonitor(
    host: StoredCloudHost,
    actor: string,
    clientIp: string,
    triggerDnsSync = true,
    onlyRuleId?: string
  ) {
    const state = store.getState();
    const boundIds = getHostLinkedRuleIds(host);
    const targetIds = onlyRuleId ? boundIds.filter((id) => id === onlyRuleId) : boundIds;
    const reports: DnsRuleSyncReport[] = [];
    const nowIso = new Date().toISOString();

    for (const ruleId of targetIds) {
      const rule = state.dnsRules.find((r) => r.id === ruleId);
      if (!rule) continue;
      rule.ipv4Address = host.ipv4 || '';
      rule.linkedHostId = host.id;
      rule.ipv6Targets = host.ipv6List.map((addr, idx) => {
        const ociEntry = host.ociIpv6Entries?.find((e) => e.ipAddress.toLowerCase() === addr.toLowerCase());
        return {
          id: `v6-${host.id}-${idx + 1}`,
          recordName: rule.ipv6Mode === 'round_robin' ? rule.recordName : `v6-${idx + 1}.${rule.recordName}`,
          address: addr,
          proxied: rule.proxied,
          enabled: true,
          ociIpv6Id: ociEntry?.id,
          lastStatus: 'pending',
        };
      });
      if (host.provider === 'oracle' && host.ociProfileId) {
        rule.ociProfileId = host.ociProfileId;
        rule.ociInstanceId = host.instanceId;
        rule.ociInstanceName = host.name;
        rule.ociVnicId = host.ociVnicId;
        rule.ociPrimaryPrivateIpId = host.ociPrimaryPrivateIpId;
        rule.ociPublicIpId = host.ociPublicIpId;
        rule.ociPublicIpLifetime = host.ociPublicIpLifetime;
      }
      rule.updatedAt = nowIso;
    }
    store.save();

    if (triggerDnsSync) {
      for (const ruleId of targetIds) {
        const rep = await executeDnsSyncRule(ruleId, actor, clientIp);
        if (rep) reports.push(rep);
      }
    }

    const nextTarget = host.ipv4 || host.ipv6List[0];
    if (nextTarget) {
      for (const mon of state.monitors) {
        if (mon.linkedHostId === host.id && mon.type === 'tcp') {
          mon.target = nextTarget;
          mon.updatedAt = nowIso;
        }
      }
      store.save();
    }

    return reports[0] ?? null;
  }

  // Bind multiple DNS domain rules (add new / attach existing / unbind one or all) on a Cloud Host
  app.post('/api/clouds/hosts/:id/bind-domain', requireAuth, async (req: AuthedRequest, res) => {
    const state = store.getState();
    const host = state.cloudHosts.find((h) => h.id === req.params.id);
    if (!host) {
      res.status(404).json({ error: 'Cloud host not found' });
      return;
    }

    const b = req.body ?? {};
    const syncNow = Boolean(b.syncNow);
    const now = new Date().toISOString();
    const currentRuleIds = getHostLinkedRuleIds(host);

    if (b.unbind === true || (b.ruleId === '' && !b.createRule)) {
      const targetUnbindId = b.ruleId ? String(b.ruleId).trim() : '';
      if (targetUnbindId) {
        // Unbind a single specific domain rule
        const prevRule = state.dnsRules.find((r) => r.id === targetUnbindId);
        if (prevRule && prevRule.linkedHostId === host.id) {
          prevRule.linkedHostId = undefined;
        }
        setHostLinkedRuleIds(
          host,
          currentRuleIds.filter((id) => id !== targetUnbindId)
        );
      } else {
        // Unbind all domain rules on this host
        for (const id of currentRuleIds) {
          const prevRule = state.dnsRules.find((r) => r.id === id);
          if (prevRule && prevRule.linkedHostId === host.id) {
            prevRule.linkedHostId = undefined;
          }
        }
        setHostLinkedRuleIds(host, []);
      }
      host.updatedAt = now;
      store.save();

      store.appendAudit({
        category: 'cloud',
        severity: 'info',
        action: 'CLOUD_HOST_DOMAIN_UNBOUND',
        actor: req.sessionUser || 'admin',
        ip: getClientIp(req),
        target: host.name,
        details: targetUnbindId ? `Unbound DNS rule ${targetUnbindId}` : 'Unbound all DNS rules from host',
      });

      res.json({ ok: true, host: store.toPublicCloudHost(host) });
      return;
    }

    // Enforce 1-to-1 binding: a single FQDN can only be bound to ONE cloud host instance
    const buildRuleFqdn = (recName: string, dom: string) => {
      const cleanDom = String(dom || '').trim().toLowerCase().replace(/\.$/, '');
      const cleanRec = String(recName || '@').trim().toLowerCase().replace(/\.$/, '');
      if (!cleanRec || cleanRec === '@' || cleanRec === cleanDom) return cleanDom;
      return cleanRec.endsWith(`.${cleanDom}`) ? cleanRec : `${cleanRec}.${cleanDom}`;
    };

    const findHostOwningFqdn = (targetFqdn: string): StoredCloudHost | undefined => {
      const normalized = targetFqdn.trim().toLowerCase().replace(/\.$/, '');
      for (const other of state.cloudHosts) {
        if (other.id === host.id) continue;
        for (const rId of getHostLinkedRuleIds(other)) {
          const r = state.dnsRules.find((x) => x.id === rId);
          if (r && buildRuleFqdn(r.recordName, r.domain) === normalized) {
            return other;
          }
        }
      }
      return undefined;
    };

    let rule: DnsSyncRule | undefined;

    if (b.recordId && typeof b.recordId === 'string') {
      // Attach an existing pulled DNS record from DNS Management (auto-creating/reusing its DnsSyncRule)
      const rec = state.dnsRecords.find((r) => r.id === b.recordId.trim());
      if (!rec) {
        res.status(404).json({ error: '未找到所选的 DNS 域名记录，请先在 DNS 管理中拉取记录' });
        return;
      }
      const targetFqdn = buildRuleFqdn(rec.name, rec.domain);
      const conflictHost = findHostOwningFqdn(targetFqdn);
      if (conflictHost) {
        res.status(409).json({
          error: `域名 ${targetFqdn} 已绑定到云主机「${conflictHost.name}」，一个域名只能绑定一个云主机实例`,
        });
        return;
      }
      const provider = state.dnsProviders.find((p) => p.id === rec.providerId);
      if (!provider) {
        res.status(400).json({ error: '该域名记录关联的 DNS 服务商不存在' });
        return;
      }
      const secrets = store.getDnsProviderSecrets(provider.id);
      const isConfigured = provider.type === 'webhook' ? Boolean(provider.endpointUrl) : Boolean(secrets.secret);
      if (!isConfigured) {
        res.status(400).json({ error: `DNS 服务商「${provider.name}」尚未配置 API 凭据` });
        return;
      }

      // Reuse an existing unbound rule matching the same provider + FQDN if present
      const existingRule = state.dnsRules.find(
        (r) => r.providerId === provider.id && buildRuleFqdn(r.recordName, r.domain) === targetFqdn
      );
      if (existingRule) {
        rule = existingRule;
        rule.linkedHostId = host.id;
        rule.ipv4Source = 'cloud_host';
        rule.ipv4Address = host.ipv4 || '';
        rule.updatedAt = now;
      } else {
        const ipv6Mode: 'round_robin' | 'per_host' = 'round_robin';
        rule = {
          id: `rule-${crypto.randomBytes(5).toString('hex')}`,
          name: `${host.name} -> ${targetFqdn}`,
          providerId: provider.id,
          domain: rec.domain,
          resolvedZoneId: rec.zoneId || provider.zoneId,
          recordName: rec.name || '@',
          ttl: Math.max(60, rec.ttl || 120),
          proxied: Boolean(rec.proxied),
          line: rec.line || (provider.type === 'dnspod' ? '默认' : 'default'),
          syncIpv4: Boolean(host.ipv4) || true,
          ipv4Address: host.ipv4 || '',
          ipv4Source: 'cloud_host',
          syncIpv6: host.ipv6List.length > 0,
          ipv6Mode,
          ipv6Targets: host.ipv6List.map((addr, idx) => {
            const ociEntry = host.ociIpv6Entries?.find((e) => e.ipAddress.toLowerCase() === addr.toLowerCase());
            return {
              id: `v6-${host.id}-${idx + 1}`,
              recordName: rec.name || '@',
              address: addr,
              proxied: Boolean(rec.proxied),
              enabled: true,
              ociIpv6Id: ociEntry?.id,
              lastStatus: 'pending',
            };
          }),
          linkedHostId: host.id,
          ociProfileId: host.ociProfileId,
          ociInstanceId: host.provider === 'oracle' ? host.instanceId : undefined,
          ociInstanceName: host.provider === 'oracle' ? host.name : undefined,
          ociVnicId: host.ociVnicId,
          ociPrimaryPrivateIpId: host.ociPrimaryPrivateIpId,
          ociPublicIpId: host.ociPublicIpId,
          ociPublicIpLifetime: host.ociPublicIpLifetime,
          dryRun: false,
          enabled: true,
          lastStatus: 'pending',
          createdAt: now,
          updatedAt: now,
        };
        state.dnsRules.unshift(rule);
      }
    } else if (b.createRule && typeof b.createRule === 'object') {
      const cr = b.createRule;
      const providerId = String(cr.providerId || '').trim();
      const domain = String(cr.domain || '').trim().toLowerCase();
      const recordName = String(cr.recordName || '@').trim() || '@';
      const provider = state.dnsProviders.find((p) => p.id === providerId);
      if (!provider) {
        res.status(400).json({ error: '请选择有效的已配置 DNS 服务商' });
        return;
      }
      if (!domain) {
        res.status(400).json({ error: '请填写主域名（例如 example.com）' });
        return;
      }
      const fqdn = buildRuleFqdn(recordName, domain);
      const conflictHost = findHostOwningFqdn(fqdn);
      if (conflictHost) {
        res.status(409).json({
          error: `域名 ${fqdn} 已绑定到云主机「${conflictHost.name}」，一个域名只能绑定一个云主机实例`,
        });
        return;
      }
      const secrets = store.getDnsProviderSecrets(provider.id);
      const isConfigured = provider.type === 'webhook' ? Boolean(provider.endpointUrl) : Boolean(secrets.secret);
      if (!isConfigured) {
        res.status(400).json({ error: `DNS 服务商「${provider.name}」尚未配置凭据，请先在 DNS 域名管理中配置` });
        return;
      }

      let resolvedZoneId: string | undefined = provider.zoneId;
      if (provider.type === 'cloudflare' && secrets.secret) {
        const z = await resolveCloudflareZoneId(secrets.secret, domain, provider.zoneId, provider.accountEmail);
        if (z.zoneId) {
          resolvedZoneId = z.zoneId;
        }
      }

      const ipv6Mode: 'round_robin' | 'per_host' = cr.ipv6Mode === 'per_host' ? 'per_host' : 'round_robin';
      rule = {
        id: `rule-${crypto.randomBytes(5).toString('hex')}`,
        name: String(cr.name || `${host.name} -> ${fqdn}`).trim(),
        providerId: provider.id,
        domain,
        resolvedZoneId,
        recordName,
        ttl: Math.max(60, Number(cr.ttl) || 120),
        proxied: Boolean(cr.proxied),
        line: provider.type === 'dnspod' ? '默认' : 'default',
        syncIpv4: Boolean(host.ipv4) || true,
        ipv4Address: host.ipv4 || '',
        ipv4Source: 'cloud_host',
        syncIpv6: host.ipv6List.length > 0,
        ipv6Mode,
        ipv6Targets: host.ipv6List.map((addr, idx) => {
          const ociEntry = host.ociIpv6Entries?.find((e) => e.ipAddress.toLowerCase() === addr.toLowerCase());
          return {
            id: `v6-${host.id}-${idx + 1}`,
            recordName: ipv6Mode === 'round_robin' ? recordName : `v6-${idx + 1}.${recordName}`,
            address: addr,
            proxied: Boolean(cr.proxied),
            enabled: true,
            ociIpv6Id: ociEntry?.id,
            lastStatus: 'pending',
          };
        }),
        linkedHostId: host.id,
        ociProfileId: host.ociProfileId,
        ociInstanceId: host.provider === 'oracle' ? host.instanceId : undefined,
        ociInstanceName: host.provider === 'oracle' ? host.name : undefined,
        ociVnicId: host.ociVnicId,
        ociPrimaryPrivateIpId: host.ociPrimaryPrivateIpId,
        ociPublicIpId: host.ociPublicIpId,
        ociPublicIpLifetime: host.ociPublicIpLifetime,
        dryRun: false,
        enabled: true,
        lastStatus: 'pending',
        createdAt: now,
        updatedAt: now,
      };
      state.dnsRules.unshift(rule);
    } else {
      const ruleId = String(b.ruleId || '').trim();
      rule = state.dnsRules.find((r) => r.id === ruleId);
      if (!rule) {
        res.status(404).json({ error: 'Selected DNS rule not found' });
        return;
      }
      const targetFqdn = buildRuleFqdn(rule.recordName, rule.domain);
      const conflictHost = findHostOwningFqdn(targetFqdn);
      if (conflictHost) {
        res.status(409).json({
          error: `域名 ${targetFqdn} 已绑定到云主机「${conflictHost.name}」，一个域名只能绑定一个云主机实例`,
        });
        return;
      }
      const existingProvider = state.dnsProviders.find((p) => p.id === rule!.providerId);
      if (!existingProvider) {
        res.status(400).json({ error: '该域名规则关联的 DNS 服务商不存在，请重新选择已配置的 DNS 服务商。' });
        return;
      }
      const secrets = store.getDnsProviderSecrets(existingProvider.id);
      const isConfigured =
        existingProvider.type === 'webhook'
          ? Boolean(existingProvider.endpointUrl)
          : Boolean(secrets.secret);
      if (!isConfigured && !rule.dryRun) {
        res.status(400).json({
          error: `该域名绑定的 DNS 服务商「${existingProvider.name}」尚未配置 API 凭据，请先前往「DNS 服务商」配置后再绑定。`,
        });
        return;
      }
    }

    // Append rule to this host's bound domain list (preserving previously bound domains!)
    const updatedIds = setHostLinkedRuleIds(host, [...currentRuleIds, rule.id]);
    host.updatedAt = now;
    store.save();

    const dnsReport = await cascadeHostIpsToDomainAndMonitor(
      host,
      req.sessionUser || 'admin',
      getClientIp(req),
      syncNow,
      rule.id
    );

    store.appendAudit({
      category: 'cloud',
      severity: 'info',
      action: 'CLOUD_HOST_DOMAIN_BOUND',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${host.name} -> ${rule.recordName}.${rule.domain}`,
      details: `Bound DNS rule ${rule.id} (total bound=${updatedIds.length}, syncNow=${syncNow})`,
    });

    res.json({
      ok: true,
      host: store.toPublicCloudHost(host),
      rule,
      dnsReport,
    });
  });

  // Helper: resolve live OCI profile + VNIC metadata for a Cloud Host
  async function ensureHostOciNetwork(host: StoredCloudHost): Promise<
    | { ok: true; profile: StoredOciProfile; pem: string; vnicId: string; primaryPrivateIpId: string }
    | { ok: false; status: number; error: string }
  > {
    if (!host.ociProfileId || !host.instanceId || !isValidOcid(host.instanceId)) {
      return {
        ok: false,
        status: 400,
        error: '该 Oracle 主机未关联有效的 OCI 凭据与实例 OCID，请先通过「从 OCI 导入实例」导入',
      };
    }
    const profile = store.getState().ociProfiles.find((p) => p.id === host.ociProfileId);
    const pem = profile ? store.getOciPrivateKey(profile.id) : '';
    if (!profile || !pem) {
      return { ok: false, status: 400, error: '关联的 OCI 凭据不存在或未配置私钥 PEM' };
    }

    if (!host.ociVnicId || !host.ociPrimaryPrivateIpId) {
      const detail = await getOciInstanceDetail(profile, pem, host.instanceId, host.ociVnicId);
      if (!detail.ok || !detail.vnicId || !detail.primaryPrivateIpId) {
        return {
          ok: false,
          status: 502,
          error: detail.error || '无法从 OCI 获取该实例的主 VNIC 与主私有 IP 信息',
        };
      }
      host.ociVnicId = detail.vnicId;
      host.ociPrimaryPrivateIpId = detail.primaryPrivateIpId;
      if (detail.publicIp !== undefined) host.ipv4 = detail.publicIp || '';
      host.ociPublicIpId = detail.publicIpId;
      host.ociPublicIpLifetime = detail.publicIpLifetime;
      if (detail.ipv6List) host.ipv6List = detail.ipv6List;
      if (detail.ipv6Entries) host.ociIpv6Entries = detail.ipv6Entries;
      store.save();
    }

    return {
      ok: true,
      profile,
      pem,
      vnicId: host.ociVnicId!,
      primaryPrivateIpId: host.ociPrimaryPrivateIpId!,
    };
  }

  // Helper: resolve AWS / Aliyun / GCP account + decrypted secrets for a Cloud Host
  function ensureHostExternalCloud(host: StoredCloudHost):
    | { ok: true; account: StoredCloudAccount; secrets: { accessKeyId: string; secretKey: string; serviceAccountJson: string } }
    | { ok: false; status: number; error: string } {
    const providerTag = host.provider.toUpperCase();
    if (!host.cloudAccountId) {
      return { ok: false, status: 400, error: `该 ${providerTag} 主机未关联云账号凭据，请先在云账号管理中配置并同步` };
    }
    const account = store.getState().cloudAccounts.find((a) => a.id === host.cloudAccountId);
    if (!account) {
      return { ok: false, status: 400, error: `关联的 ${providerTag} 云账号凭据已被删除` };
    }
    const secrets = store.getCloudAccountSecrets(account.id);
    const ready =
      account.provider === 'gcp'
        ? Boolean(secrets.serviceAccountJson)
        : Boolean(secrets.accessKeyId && secrets.secretKey);
    if (!ready) {
      return { ok: false, status: 400, error: `关联的 ${providerTag} 云账号尚未保存完整 API 凭据` };
    }
    return { ok: true, account, secrets };
  }

  // Add IP (IPv4 or IPv6) on a Managed Cloud Host (OCI / AWS EC2 / Aliyun ECS / GCP)
  app.post('/api/clouds/hosts/:id/ips/add', requireAuth, async (req: AuthedRequest, res) => {
    const state = store.getState();
    const host = state.cloudHosts.find((h) => h.id === req.params.id);
    if (!host) {
      res.status(404).json({ error: 'Cloud host not found' });
      return;
    }

    const version = req.body?.version === 'ipv4' ? 'ipv4' : req.body?.version === 'ipv6' ? 'ipv6' : null;
    if (!version) {
      res.status(400).json({ error: 'Specify version: "ipv4" or "ipv6"' });
      return;
    }
    const requestedAddr = String(req.body?.address || '').trim();
    const actor = req.sessionUser || 'admin';
    const clientIp = getClientIp(req);

    // 1. Oracle OCI
    if (host.provider === 'oracle') {
      const ctx = await ensureHostOciNetwork(host);
      if (!ctx.ok) {
        res.status(ctx.status).json({ error: ctx.error });
        return;
      }

      if (version === 'ipv4') {
        if (host.ipv4) {
          res.status(400).json({
            error: `当前实例已有公网 IPv4 (${host.ipv4})；OCI 主私有 IP 仅支持绑定 1 个公网 IPv4，请点击换 IPv4 或先删除旧 IPv4`,
          });
          return;
        }
        const alloc = await ociAllocatePublicIpv4(ctx.profile, ctx.pem, ctx.primaryPrivateIpId);
        if (!alloc.ok || !alloc.ipAddress) {
          res.status(502).json({ error: alloc.error || 'OCI 申请公网 IPv4 失败' });
          return;
        }
        host.ipv4 = alloc.ipAddress;
        host.ociPublicIpId = alloc.publicIpId;
        host.ociPublicIpLifetime = alloc.lifetime;
        host.updatedAt = new Date().toISOString();
        store.save();

        const dnsReport = await cascadeHostIpsToDomainAndMonitor(host, actor, clientIp, true);
        store.appendAudit({
          category: 'ip',
          severity: 'success',
          action: 'HOST_OCI_IPV4_ADDED',
          actor,
          ip: clientIp,
          target: host.name,
          details: `Allocated OCI Ephemeral IPv4 ${alloc.ipAddress} (${alloc.publicIpId})`,
        });
        await dispatchSystemNotification({
          event: 'ip_changed',
          title: `OCI IPv4 Allocated: ${host.name}`,
          message: `Instance ${host.name} allocated new OCI Public IPv4 ${alloc.ipAddress}`,
          actor,
          ip: clientIp,
        });
        res.status(201).json({ ok: true, version: 'ipv4', address: alloc.ipAddress, host: store.toPublicCloudHost(host), dnsReport });
        return;
      }

      const added = await ociAddIpv6ToVnic(ctx.profile, ctx.pem, ctx.vnicId, requestedAddr || undefined);
      if (!added.ok || !added.ipAddress) {
        res.status(502).json({ error: added.error || 'OCI 新增 IPv6 失败' });
        return;
      }
      if (!host.ipv6List.includes(added.ipAddress)) {
        host.ipv6List.push(added.ipAddress);
      }
      host.ociIpv6Entries = [
        ...(host.ociIpv6Entries ?? []).filter((e) => e.ipAddress !== added.ipAddress),
        { id: added.ipv6Id || '', ipAddress: added.ipAddress },
      ];
      host.updatedAt = new Date().toISOString();
      store.save();

      const dnsReport = await cascadeHostIpsToDomainAndMonitor(host, actor, clientIp, true);
      store.appendAudit({
        category: 'ip',
        severity: 'success',
        action: 'HOST_OCI_IPV6_ADDED',
        actor,
        ip: clientIp,
        target: host.name,
        details: `Allocated OCI IPv6 ${added.ipAddress} (${added.ipv6Id}) on VNIC ${ctx.vnicId}`,
      });
      await dispatchSystemNotification({
        event: 'ip_changed',
        title: `OCI IPv6 Added: ${host.name}`,
        message: `Instance ${host.name} added OCI IPv6 ${added.ipAddress}`,
        actor,
        ip: clientIp,
      });
      res.status(201).json({ ok: true, version: 'ipv6', address: added.ipAddress, host: store.toPublicCloudHost(host), dnsReport });
      return;
    }

    // 2. AWS EC2 / Aliyun ECS / GCP Compute Engine
    if (host.provider === 'aws' || host.provider === 'aliyun' || host.provider === 'gcp') {
      const ctx = ensureHostExternalCloud(host);
      if (!ctx.ok) {
        res.status(ctx.status).json({ error: ctx.error });
        return;
      }
      const pTag = host.provider.toUpperCase();

      if (version === 'ipv4') {
        if (host.ipv4) {
          res.status(400).json({ error: `当前 ${pTag} 实例已有公网 IPv4 (${host.ipv4})，请点击「更换 IPv4」或先删除旧 IPv4` });
          return;
        }
        const alloc = await cloudHostAddIpv4(ctx.account, ctx.secrets, host);
        if (!alloc.ok || !alloc.newAddress) {
          res.status(502).json({ error: alloc.error || `${pTag} 申请公网 IPv4 失败` });
          return;
        }
        host.ipv4 = alloc.newAddress;
        host.cloudEipAllocationId = alloc.allocationId;
        host.cloudAllocationAssociationId = alloc.associationId;
        host.updatedAt = new Date().toISOString();
        store.save();

        const dnsReport = await cascadeHostIpsToDomainAndMonitor(host, actor, clientIp, true);
        store.appendAudit({
          category: 'ip',
          severity: 'success',
          action: 'HOST_CLOUD_IPV4_ADDED',
          actor,
          ip: clientIp,
          target: `${host.name} (${pTag})`,
          details: `Allocated ${pTag} IPv4 ${alloc.newAddress}`,
        });
        await dispatchSystemNotification({
          event: 'ip_changed',
          title: `${pTag} IPv4 Allocated: ${host.name}`,
          message: `Instance ${host.name} allocated new ${pTag} Public IPv4 ${alloc.newAddress}`,
          actor,
          ip: clientIp,
        });
        res.status(201).json({ ok: true, version: 'ipv4', address: alloc.newAddress, host: store.toPublicCloudHost(host), dnsReport });
        return;
      }

      const added = await cloudHostAddIpv6(ctx.account, ctx.secrets, host, requestedAddr || undefined);
      if (!added.ok || !added.ipAddress) {
        res.status(502).json({ error: added.error || `${pTag} 新增 IPv6 失败` });
        return;
      }
      if (!host.ipv6List.includes(added.ipAddress)) {
        host.ipv6List.push(added.ipAddress);
      }
      host.updatedAt = new Date().toISOString();
      store.save();

      const dnsReport = await cascadeHostIpsToDomainAndMonitor(host, actor, clientIp, true);
      store.appendAudit({
        category: 'ip',
        severity: 'success',
        action: 'HOST_CLOUD_IPV6_ADDED',
        actor,
        ip: clientIp,
        target: `${host.name} (${pTag})`,
        details: `Allocated ${pTag} IPv6 ${added.ipAddress}`,
      });
      await dispatchSystemNotification({
        event: 'ip_changed',
        title: `${pTag} IPv6 Added: ${host.name}`,
        message: `Instance ${host.name} added ${pTag} IPv6 ${added.ipAddress}`,
        actor,
        ip: clientIp,
      });
      res.status(201).json({ ok: true, version: 'ipv6', address: added.ipAddress, host: store.toPublicCloudHost(host), dnsReport });
      return;
    }

    res.status(400).json({ error: '仅支持通过 API 管理的云主机（OCI / AWS / 阿里云 / GCP）执行 IP 分配' });
  });

  // Swap IP (IPv4 or IPv6) on a Managed Cloud Host (OCI / AWS EC2 / Aliyun ECS / GCP)
  app.post('/api/clouds/hosts/:id/ips/swap', requireAuth, async (req: AuthedRequest, res) => {
    const state = store.getState();
    const host = state.cloudHosts.find((h) => h.id === req.params.id);
    if (!host) {
      res.status(404).json({ error: 'Cloud host not found' });
      return;
    }

    const version = req.body?.version === 'ipv4' ? 'ipv4' : req.body?.version === 'ipv6' ? 'ipv6' : null;
    if (!version) {
      res.status(400).json({ error: 'Specify version: "ipv4" or "ipv6"' });
      return;
    }

    const actor = req.sessionUser || 'admin';
    const clientIp = getClientIp(req);

    // 1. Oracle OCI
    if (host.provider === 'oracle') {
      const ctx = await ensureHostOciNetwork(host);
      if (!ctx.ok) {
        res.status(ctx.status).json({ error: ctx.error });
        return;
      }

      if (version === 'ipv4') {
        const swapped = await ociSwapPublicIpv4(ctx.profile, ctx.pem, ctx.primaryPrivateIpId);
        if (!swapped.ok || !swapped.newAddress) {
          res.status(502).json({ error: swapped.error || 'OCI 更换公网 IPv4 失败' });
          return;
        }
        host.ipv4 = swapped.newAddress;
        host.ociPublicIpId = swapped.publicIpId;
        host.ociPublicIpLifetime = swapped.lifetime;
        host.updatedAt = new Date().toISOString();
        store.save();

        const dnsReport = await cascadeHostIpsToDomainAndMonitor(host, actor, clientIp, true);
        store.appendAudit({
          category: 'ip',
          severity: 'success',
          action: 'HOST_OCI_IPV4_SWAPPED',
          actor,
          ip: clientIp,
          target: host.name,
          details: `Swapped OCI IPv4 ${swapped.oldAddress || 'none'} -> ${swapped.newAddress}`,
        });
        await dispatchSystemNotification({
          event: 'ip_changed',
          title: `OCI IPv4 Swapped: ${host.name}`,
          message: `${host.name}: ${swapped.oldAddress || 'none'} -> ${swapped.newAddress}`,
          actor,
          ip: clientIp,
        });
        res.json({ ok: true, oldAddress: swapped.oldAddress, newAddress: swapped.newAddress, host: store.toPublicCloudHost(host), dnsReport });
        return;
      }

      const oldAddress = String(req.body?.address || '').trim();
      let oldIpv6Id =
        String(req.body?.ociResourceId || '').trim() ||
        host.ociIpv6Entries?.find((e) => e.ipAddress.toLowerCase() === oldAddress.toLowerCase())?.id ||
        '';

      if (!oldIpv6Id) {
        const refreshed = await inspectOciVnicIps(ctx.profile, ctx.pem, ctx.vnicId);
        if (refreshed.ok && refreshed.vnic) {
          host.ociIpv6Entries = refreshed.vnic.ipv6s;
          oldIpv6Id = refreshed.vnic.ipv6s.find((e) => e.ipAddress.toLowerCase() === oldAddress.toLowerCase())?.id || '';
        }
      }
      if (!oldIpv6Id) {
        res.status(404).json({ error: '未在 OCI VNIC 上找到该 IPv6 的资源 ID，请先点击检测刷新状态' });
        return;
      }

      const added = await ociAddIpv6ToVnic(ctx.profile, ctx.pem, ctx.vnicId);
      if (!added.ok || !added.ipAddress) {
        res.status(502).json({ error: added.error || 'OCI 分配新 IPv6 失败' });
        return;
      }
      const deleted = await ociDeleteIpv6(ctx.profile, ctx.pem, oldIpv6Id);
      if (!deleted.ok) {
        res.status(502).json({ error: `新 IPv6 (${added.ipAddress}) 已创建，但删除旧 IPv6 失败：${deleted.error}` });
        return;
      }

      host.ipv6List = host.ipv6List.map((a) => (a.toLowerCase() === oldAddress.toLowerCase() ? added.ipAddress! : a));
      if (!host.ipv6List.includes(added.ipAddress)) host.ipv6List.push(added.ipAddress);
      host.ociIpv6Entries = [
        ...(host.ociIpv6Entries ?? []).filter((e) => e.id !== oldIpv6Id && e.ipAddress.toLowerCase() !== oldAddress.toLowerCase()),
        { id: added.ipv6Id || '', ipAddress: added.ipAddress },
      ];
      host.updatedAt = new Date().toISOString();
      store.save();

      const dnsReport = await cascadeHostIpsToDomainAndMonitor(host, actor, clientIp, true);
      store.appendAudit({
        category: 'ip',
        severity: 'success',
        action: 'HOST_OCI_IPV6_SWAPPED',
        actor,
        ip: clientIp,
        target: host.name,
        details: `Swapped OCI IPv6 ${oldAddress} -> ${added.ipAddress}`,
      });
      await dispatchSystemNotification({
        event: 'ip_changed',
        title: `OCI IPv6 Swapped: ${host.name}`,
        message: `${host.name}: ${oldAddress} -> ${added.ipAddress}`,
        actor,
        ip: clientIp,
      });
      res.json({ ok: true, oldAddress, newAddress: added.ipAddress, host: store.toPublicCloudHost(host), dnsReport });
      return;
    }

    // 2. AWS EC2 / Aliyun ECS / GCP Compute Engine
    if (host.provider === 'aws' || host.provider === 'aliyun' || host.provider === 'gcp') {
      const ctx = ensureHostExternalCloud(host);
      if (!ctx.ok) {
        res.status(ctx.status).json({ error: ctx.error });
        return;
      }
      const pTag = host.provider.toUpperCase();

      if (version === 'ipv4') {
        const swapped = await cloudHostSwapIpv4(ctx.account, ctx.secrets, host);
        if (!swapped.ok || !swapped.newAddress) {
          res.status(502).json({ error: swapped.error || `${pTag} 更换公网 IPv4 失败` });
          return;
        }
        host.ipv4 = swapped.newAddress;
        host.cloudEipAllocationId = swapped.allocationId;
        host.cloudAllocationAssociationId = swapped.associationId;
        host.updatedAt = new Date().toISOString();
        store.save();

        const dnsReport = await cascadeHostIpsToDomainAndMonitor(host, actor, clientIp, true);
        store.appendAudit({
          category: 'ip',
          severity: 'success',
          action: 'HOST_CLOUD_IPV4_SWAPPED',
          actor,
          ip: clientIp,
          target: `${host.name} (${pTag})`,
          details: `Swapped ${pTag} IPv4 ${swapped.oldAddress || 'none'} -> ${swapped.newAddress}`,
        });
        await dispatchSystemNotification({
          event: 'ip_changed',
          title: `${pTag} IPv4 Swapped: ${host.name}`,
          message: `${host.name}: ${swapped.oldAddress || 'none'} -> ${swapped.newAddress}`,
          actor,
          ip: clientIp,
        });
        res.json({ ok: true, oldAddress: swapped.oldAddress, newAddress: swapped.newAddress, host: store.toPublicCloudHost(host), dnsReport });
        return;
      }

      const oldAddress = String(req.body?.address || '').trim();
      if (!oldAddress) {
        res.status(400).json({ error: '缺少待更换的原 IPv6 地址' });
        return;
      }

      if (ctx.account.provider === 'gcp') {
        const del = await cloudHostDeleteIpv6(ctx.account, ctx.secrets, host, oldAddress);
        if (!del.ok) {
          res.status(502).json({ error: del.error || 'GCP 禁用旧 IPv6 失败' });
          return;
        }
        const added = await cloudHostAddIpv6(ctx.account, ctx.secrets, host);
        if (!added.ok || !added.ipAddress) {
          res.status(502).json({ error: added.error || 'GCP 重新分配 IPv6 失败' });
          return;
        }
        host.ipv6List = [added.ipAddress];
        host.updatedAt = new Date().toISOString();
        store.save();
        const dnsReport = await cascadeHostIpsToDomainAndMonitor(host, actor, clientIp, true);
        store.appendAudit({
          category: 'ip',
          severity: 'success',
          action: 'HOST_CLOUD_IPV6_SWAPPED',
          actor,
          ip: clientIp,
          target: `${host.name} (GCP)`,
          details: `Swapped GCP IPv6 ${oldAddress} -> ${added.ipAddress}`,
        });
        res.json({ ok: true, oldAddress, newAddress: added.ipAddress, host: store.toPublicCloudHost(host), dnsReport });
        return;
      }

      const added = await cloudHostAddIpv6(ctx.account, ctx.secrets, host);
      if (!added.ok || !added.ipAddress) {
        res.status(502).json({ error: added.error || `${pTag} 分配新 IPv6 失败` });
        return;
      }
      const deleted = await cloudHostDeleteIpv6(ctx.account, ctx.secrets, host, oldAddress);
      if (!deleted.ok) {
        res.status(502).json({ error: `新 IPv6 (${added.ipAddress}) 已创建，但删除旧 IPv6 失败：${deleted.error}` });
        return;
      }
      host.ipv6List = host.ipv6List.map((a) => (a.toLowerCase() === oldAddress.toLowerCase() ? added.ipAddress! : a));
      if (!host.ipv6List.includes(added.ipAddress)) host.ipv6List.push(added.ipAddress);
      host.updatedAt = new Date().toISOString();
      store.save();

      const dnsReport = await cascadeHostIpsToDomainAndMonitor(host, actor, clientIp, true);
      store.appendAudit({
        category: 'ip',
        severity: 'success',
        action: 'HOST_CLOUD_IPV6_SWAPPED',
        actor,
        ip: clientIp,
        target: `${host.name} (${pTag})`,
        details: `Swapped ${pTag} IPv6 ${oldAddress} -> ${added.ipAddress}`,
      });
      await dispatchSystemNotification({
        event: 'ip_changed',
        title: `${pTag} IPv6 Swapped: ${host.name}`,
        message: `${host.name}: ${oldAddress} -> ${added.ipAddress}`,
        actor,
        ip: clientIp,
      });
      res.json({ ok: true, oldAddress, newAddress: added.ipAddress, host: store.toPublicCloudHost(host), dnsReport });
      return;
    }

    res.status(400).json({ error: '仅支持通过 API 管理的云主机执行更换 IP' });
  });

  // Delete IP (IPv4 or IPv6) from a Managed Cloud Host (OCI / AWS EC2 / Aliyun ECS / GCP)
  app.post('/api/clouds/hosts/:id/ips/delete', requireAuth, async (req: AuthedRequest, res) => {
    const state = store.getState();
    const host = state.cloudHosts.find((h) => h.id === req.params.id);
    if (!host) {
      res.status(404).json({ error: 'Cloud host not found' });
      return;
    }

    const version = req.body?.version === 'ipv4' ? 'ipv4' : req.body?.version === 'ipv6' ? 'ipv6' : null;
    const address = String(req.body?.address || '').trim();
    if (!version || !address) {
      res.status(400).json({ error: 'Version ("ipv4" or "ipv6") and address are required' });
      return;
    }

    const actor = req.sessionUser || 'admin';
    const clientIp = getClientIp(req);

    // 1. Oracle OCI
    if (host.provider === 'oracle') {
      const ctx = await ensureHostOciNetwork(host);
      if (!ctx.ok) {
        res.status(ctx.status).json({ error: ctx.error });
        return;
      }

      if (version === 'ipv4') {
        let publicIpId = String(req.body?.ociResourceId || host.ociPublicIpId || '').trim();
        let lifetime = host.ociPublicIpLifetime;
        if (!publicIpId) {
          const refreshed = await inspectOciVnicIps(ctx.profile, ctx.pem, ctx.vnicId);
          if (refreshed.ok && refreshed.vnic) {
            publicIpId = refreshed.vnic.publicIpId || '';
            lifetime = refreshed.vnic.publicIpLifetime;
          }
        }
        if (!publicIpId) {
          res.status(404).json({ error: '未在 OCI VNIC 上找到该公网 IPv4 的资源 ID，请先点击检测刷新状态' });
          return;
        }
        const del = await ociDeletePublicIpv4(ctx.profile, ctx.pem, publicIpId, lifetime);
        if (!del.ok) {
          res.status(502).json({ error: del.error || 'OCI 删除/解绑公网 IPv4 失败' });
          return;
        }
        host.ipv4 = '';
        host.ociPublicIpId = undefined;
        host.ociPublicIpLifetime = undefined;
        host.updatedAt = new Date().toISOString();
        store.save();

        const dnsReport = await cascadeHostIpsToDomainAndMonitor(host, actor, clientIp, true);
        store.appendAudit({
          category: 'ip',
          severity: 'warning',
          action: 'HOST_OCI_IPV4_DELETED',
          actor,
          ip: clientIp,
          target: host.name,
          details: `Released OCI Public IPv4 ${address} (${publicIpId})`,
        });
        res.json({ ok: true, deletedAddress: address, host: store.toPublicCloudHost(host), dnsReport });
        return;
      }

      let ipv6Id =
        String(req.body?.ociResourceId || '').trim() ||
        host.ociIpv6Entries?.find((e) => e.ipAddress.toLowerCase() === address.toLowerCase())?.id ||
        '';
      if (!ipv6Id) {
        const refreshed = await inspectOciVnicIps(ctx.profile, ctx.pem, ctx.vnicId);
        if (refreshed.ok && refreshed.vnic) {
          host.ociIpv6Entries = refreshed.vnic.ipv6s;
          ipv6Id = refreshed.vnic.ipv6s.find((e) => e.ipAddress.toLowerCase() === address.toLowerCase())?.id || '';
        }
      }
      if (!ipv6Id) {
        res.status(404).json({ error: '未在 OCI VNIC 上找到该 IPv6 的资源 ID，请先点击检测刷新状态' });
        return;
      }
      const del = await ociDeleteIpv6(ctx.profile, ctx.pem, ipv6Id);
      if (!del.ok) {
        res.status(502).json({ error: del.error || 'OCI 删除 IPv6 失败' });
        return;
      }
      host.ipv6List = host.ipv6List.filter((a) => a.toLowerCase() !== address.toLowerCase());
      host.ociIpv6Entries = (host.ociIpv6Entries ?? []).filter(
        (e) => e.id !== ipv6Id && e.ipAddress.toLowerCase() !== address.toLowerCase()
      );
      host.updatedAt = new Date().toISOString();
      store.save();

      const dnsReport = await cascadeHostIpsToDomainAndMonitor(host, actor, clientIp, true);
      store.appendAudit({
        category: 'ip',
        severity: 'warning',
        action: 'HOST_OCI_IPV6_DELETED',
        actor,
        ip: clientIp,
        target: host.name,
        details: `Deleted OCI IPv6 ${address} (${ipv6Id})`,
      });
      res.json({ ok: true, deletedAddress: address, host: store.toPublicCloudHost(host), dnsReport });
      return;
    }

    // 2. AWS EC2 / Aliyun ECS / GCP Compute Engine
    if (host.provider === 'aws' || host.provider === 'aliyun' || host.provider === 'gcp') {
      const ctx = ensureHostExternalCloud(host);
      if (!ctx.ok) {
        res.status(ctx.status).json({ error: ctx.error });
        return;
      }
      const pTag = host.provider.toUpperCase();

      if (version === 'ipv4') {
        const del = await cloudHostDeleteIpv4(ctx.account, ctx.secrets, host);
        if (!del.ok) {
          res.status(502).json({ error: del.error || `${pTag} 删除/解绑公网 IPv4 失败` });
          return;
        }
        host.ipv4 = '';
        host.cloudEipAllocationId = undefined;
        host.cloudAllocationAssociationId = undefined;
        host.updatedAt = new Date().toISOString();
        store.save();

        const dnsReport = await cascadeHostIpsToDomainAndMonitor(host, actor, clientIp, true);
        store.appendAudit({
          category: 'ip',
          severity: 'warning',
          action: 'HOST_CLOUD_IPV4_DELETED',
          actor,
          ip: clientIp,
          target: `${host.name} (${pTag})`,
          details: `Released ${pTag} Public IPv4 ${address}`,
        });
        res.json({ ok: true, deletedAddress: address, host: store.toPublicCloudHost(host), dnsReport });
        return;
      }

      const del = await cloudHostDeleteIpv6(ctx.account, ctx.secrets, host, address);
      if (!del.ok) {
        res.status(502).json({ error: del.error || `${pTag} 删除 IPv6 失败` });
        return;
      }
      host.ipv6List = host.ipv6List.filter((a) => a.toLowerCase() !== address.toLowerCase());
      host.updatedAt = new Date().toISOString();
      store.save();

      const dnsReport = await cascadeHostIpsToDomainAndMonitor(host, actor, clientIp, true);
      store.appendAudit({
        category: 'ip',
        severity: 'warning',
        action: 'HOST_CLOUD_IPV6_DELETED',
        actor,
        ip: clientIp,
        target: `${host.name} (${pTag})`,
        details: `Deleted ${pTag} IPv6 ${address}`,
      });
      res.json({ ok: true, deletedAddress: address, host: store.toPublicCloudHost(host), dnsReport });
      return;
    }

    res.status(400).json({ error: '仅支持通过 API 管理的云主机执行删除 IP' });
  });

  app.post('/api/clouds/hosts/:id/push-dns', requireAuth, async (req: AuthedRequest, res) => {
    const state = store.getState();
    const host = state.cloudHosts.find((h) => h.id === req.params.id);
    if (!host) {
      res.status(404).json({ error: 'Cloud host not found' });
      return;
    }

    const explicitRuleId = req.body?.ruleId ? String(req.body.ruleId).trim() : '';
    const boundIds = getHostLinkedRuleIds(host);
    const targetRuleIds = explicitRuleId ? [explicitRuleId] : boundIds;

    const targetRules = targetRuleIds
      .map((id) => state.dnsRules.find((r) => r.id === id))
      .filter((r): r is DnsSyncRule => Boolean(r));

    if (targetRules.length === 0) {
      res.status(400).json({ error: '该主机尚未绑定域名，请先点击「绑定域名」并选择 DNS 服务商。' });
      return;
    }

    // Validate all target rules have valid configured providers (unless dryRun)
    for (const rule of targetRules) {
      const provider = state.dnsProviders.find((p) => p.id === rule.providerId);
      if (!provider) {
        res.status(400).json({ error: `绑定域名 ${rule.recordName}.${rule.domain} 对应的 DNS 服务商已删除，请重新绑定。` });
        return;
      }
      const secrets = store.getDnsProviderSecrets(provider.id);
      const providerReady =
        provider.type === 'webhook' ? Boolean(provider.endpointUrl) : Boolean(secrets.secret);
      if (!providerReady && !rule.dryRun) {
        res.status(400).json({
          error: `DNS 服务商「${provider.name}」尚未配置 API 凭据，请先前往「DNS 服务商」保存密钥。`,
        });
        return;
      }
    }

    const reports: DnsRuleSyncReport[] = [];
    for (const rule of targetRules) {
      rule.ipv4Address = host.ipv4 || '';
      rule.ipv6Targets = host.ipv6List.map((addr, idx) => {
        const ociEntry = host.ociIpv6Entries?.find((e) => e.ipAddress.toLowerCase() === addr.toLowerCase());
        return {
          id: `v6-${host.id}-${idx + 1}`,
          recordName: rule.ipv6Mode === 'round_robin' ? rule.recordName : `v6-${idx + 1}.${rule.recordName}`,
          address: addr,
          proxied: rule.proxied,
          enabled: true,
          ociIpv6Id: ociEntry?.id,
          lastStatus: 'pending',
        };
      });
      rule.linkedHostId = host.id;
      if (host.provider === 'oracle' && host.ociProfileId && host.ociVnicId) {
        rule.ociProfileId = host.ociProfileId;
        rule.ociInstanceId = host.instanceId;
        rule.ociInstanceName = host.name;
        rule.ociVnicId = host.ociVnicId;
        rule.ociPrimaryPrivateIpId = host.ociPrimaryPrivateIpId;
        rule.ociPublicIpId = host.ociPublicIpId;
        rule.ociPublicIpLifetime = host.ociPublicIpLifetime;
      }
      if (!boundIds.includes(rule.id)) {
        boundIds.push(rule.id);
      }
    }
    setHostLinkedRuleIds(host, boundIds);
    store.save();

    for (const rule of targetRules) {
      const rep = await executeDnsSyncRule(rule.id, req.sessionUser || 'admin', getClientIp(req));
      if (rep) reports.push(rep);
    }

    const syncedCount = reports.filter((r) => r.status !== 'failed').length;
    res.json({
      host: store.toPublicCloudHost(host),
      report: reports[0] ?? null,
      reports,
      syncedCount,
      totalCount: targetRules.length,
    });
  });

  app.delete('/api/clouds/hosts/:id', requireAuth, (req: AuthedRequest, res) => {
    const state = store.getState();
    const idx = state.cloudHosts.findIndex((h) => h.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'Cloud host not found' });
      return;
    }
    const [removed] = state.cloudHosts.splice(idx, 1);
    store.save();
    store.appendAudit({
      category: 'cloud',
      severity: 'warning',
      action: 'CLOUD_HOST_DELETED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: `${removed.name} (${removed.provider})`,
      details: 'Removed cloud host from inventory',
    });
    res.json({ ok: true });
  });

  // ---- Cron Jobs & Scheduled IP/DNS Sync Policies ----
  const ALLOWED_CRON_TYPES: CronJobType[] = [
    'oci_ip_dns_policy',
    'dns_batch_sync',
    'oci_sniper_sweep',
    'cloud_ip_refresh',
    'monitor_sweep',
    'audit_cleanup',
  ];
  const ALLOWED_POLICY_SCOPES: IpPolicyTargetScope[] = ['all', 'group', 'hosts'];
  const ALLOWED_POLICY_ACTIONS: IpPolicyAction[] = [
    'sync_dns_only',
    'swap_ipv4',
    'add_ipv6',
    'swap_all_ipv6',
    'delete_excess_ipv6',
    'rotate_dual_stack',
  ];

  function sanitizeCronIpPolicy(raw: unknown): { ok: true; policy: CronIpSyncPolicy } | { ok: false; error: string } {
    const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const scopeRaw = String(obj.scope || 'all').trim() as IpPolicyTargetScope;
    const actionRaw = String(obj.action || 'sync_dns_only').trim() as IpPolicyAction;
    if (!ALLOWED_POLICY_SCOPES.includes(scopeRaw)) {
      return { ok: false, error: '无效的目标范围 (scope)' };
    }
    if (!ALLOWED_POLICY_ACTIONS.includes(actionRaw)) {
      return { ok: false, error: '无效的 IP 操作策略 (action)' };
    }
    const targetGroups = Array.isArray(obj.targetGroups)
      ? Array.from(new Set(obj.targetGroups.map((g) => String(g).trim()).filter(Boolean))).slice(0, 50)
      : [];
    const targetHostIds = Array.isArray(obj.targetHostIds)
      ? Array.from(new Set(obj.targetHostIds.map((id) => String(id).trim()).filter(Boolean))).slice(0, 200)
      : [];

    if (scopeRaw === 'group' && targetGroups.length === 0) {
      return { ok: false, error: '按分组执行策略时，请至少选择一个云主机分组。' };
    }
    if (scopeRaw === 'hosts' && targetHostIds.length === 0) {
      return { ok: false, error: '指定实例执行策略时，请至少选择一台受管云主机 (OCI / AWS / 阿里云 / GCP)。' };
    }

    const ipv6Count = Math.min(8, Math.max(1, Math.floor(Number(obj.ipv6Count) || 1)));
    return {
      ok: true,
      policy: {
        scope: scopeRaw,
        targetGroups,
        targetHostIds,
        action: actionRaw,
        ipv6Count,
        syncDnsAfter: obj.syncDnsAfter !== false,
        notifyOnComplete: obj.notifyOnComplete !== false,
      },
    };
  }

  app.get('/api/cron/jobs', requireAuth, (_req, res) => {
    res.json(store.getState().cronJobs);
  });

  app.post('/api/cron/jobs', requireAuth, (req: AuthedRequest, res) => {
    const b = req.body ?? {};
    const expr = String(b.expression || '').trim();
    const jobType = String(b.type || '').trim() as CronJobType;
    if (!b.name || !ALLOWED_CRON_TYPES.includes(jobType) || !isValidCronExpression(expr)) {
      res.status(400).json({ error: 'Valid job name, type, and 5-field cron expression are required' });
      return;
    }

    let ipPolicy: CronIpSyncPolicy | undefined;
    if (jobType === 'oci_ip_dns_policy') {
      const checked = sanitizeCronIpPolicy(b.ipPolicy);
      if (!checked.ok) {
        res.status(400).json({ error: checked.error });
        return;
      }
      ipPolicy = checked.policy;
    }

    const now = new Date().toISOString();
    const job: CronJob = {
      id: `cron-${crypto.randomBytes(5).toString('hex')}`,
      name: String(b.name).trim(),
      type: jobType,
      expression: expr,
      targetIds: Array.isArray(b.targetIds) ? b.targetIds.map(String) : [],
      ipPolicy,
      enabled: b.enabled !== false,
      nextRunAt: computeNextCronRun(expr),
      runCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    store.getState().cronJobs.unshift(job);
    store.save();
    store.appendAudit({
      category: 'cron',
      severity: 'info',
      action: 'CRON_JOB_CREATED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: job.name,
      details: `Type=${job.type}, Expression=${job.expression}${ipPolicy ? `, Policy=${ipPolicy.scope}/${ipPolicy.action}` : ''}`,
    });
    res.status(201).json(job);
  });

  app.put('/api/cron/jobs/:id', requireAuth, (req: AuthedRequest, res) => {
    const job = store.getState().cronJobs.find((j) => j.id === req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Cron job not found' });
      return;
    }
    const b = req.body ?? {};
    if (b.expression !== undefined) {
      const expr = String(b.expression).trim();
      if (!isValidCronExpression(expr)) {
        res.status(400).json({ error: 'Invalid 5-field cron expression' });
        return;
      }
      job.expression = expr;
      job.nextRunAt = computeNextCronRun(expr);
    }
    if (b.name !== undefined) job.name = String(b.name).trim();
    if (b.type !== undefined) {
      const nextType = String(b.type).trim() as CronJobType;
      if (!ALLOWED_CRON_TYPES.includes(nextType)) {
        res.status(400).json({ error: 'Invalid cron job type' });
        return;
      }
      job.type = nextType;
    }
    if (job.type === 'oci_ip_dns_policy' && b.ipPolicy !== undefined) {
      const checked = sanitizeCronIpPolicy(b.ipPolicy);
      if (!checked.ok) {
        res.status(400).json({ error: checked.error });
        return;
      }
      job.ipPolicy = checked.policy;
    } else if (job.type !== 'oci_ip_dns_policy') {
      job.ipPolicy = undefined;
    }
    if (Array.isArray(b.targetIds)) job.targetIds = b.targetIds.map(String);
    if (b.enabled !== undefined) job.enabled = Boolean(b.enabled);
    job.updatedAt = new Date().toISOString();
    store.save();

    store.appendAudit({
      category: 'cron',
      severity: 'info',
      action: 'CRON_JOB_UPDATED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: job.name,
      details: `Enabled=${job.enabled}, Expression=${job.expression}${job.ipPolicy ? `, Policy=${job.ipPolicy.scope}/${job.ipPolicy.action}` : ''}`,
    });
    res.json(job);
  });

  app.post('/api/cron/jobs/:id/run', requireAuth, async (req: AuthedRequest, res) => {
    const job = await runCronJobNow(req.params.id, req.sessionUser || 'admin', getClientIp(req));
    if (!job) {
      res.status(404).json({ error: 'Cron job not found' });
      return;
    }
    res.json(job);
  });

  app.delete('/api/cron/jobs/:id', requireAuth, (req: AuthedRequest, res) => {
    const state = store.getState();
    const idx = state.cronJobs.findIndex((j) => j.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'Cron job not found' });
      return;
    }
    const [removed] = state.cronJobs.splice(idx, 1);
    store.save();
    store.appendAudit({
      category: 'cron',
      severity: 'warning',
      action: 'CRON_JOB_DELETED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      target: removed.name,
      details: `Deleted scheduled job (${removed.expression})`,
    });
    res.json({ ok: true });
  });

  // ---- Audit Logs & Size-Based Auto-Deletion ----
  app.get('/api/audit/logs', requireAuth, (req, res) => {
    const category = typeof req.query.category === 'string' ? req.query.category : 'all';
    const severity = typeof req.query.severity === 'string' ? req.query.severity : 'all';
    const search = typeof req.query.search === 'string' ? req.query.search : '';
    const limit = Math.min(500, Math.max(10, Number(req.query.limit) || 150));

    res.json({
      stats: store.getAuditStats(),
      entries: store.readAuditLogs({ category, severity, search, limit }),
    });
  });

  app.post('/api/audit/enforce', requireAuth, (_req, res) => {
    const result = store.enforceAuditSizeLimit();
    res.json({ result, stats: store.getAuditStats() });
  });

  app.post('/api/audit/purge', requireAuth, (req: AuthedRequest, res) => {
    store.purgeAuditLogs(req.sessionUser || 'admin', getClientIp(req));
    res.json({ ok: true, stats: store.getAuditStats() });
  });

  // ---- Security & Container Settings ----
  app.get('/api/security/config', requireAuth, (_req, res) => {
    res.json({
      config: store.getState().security,
      envManagedAdmin: store.isEnvAdminConfigured(),
      adminUsername: store.getAdminInitSummary().username,
      activeSessions: sessions.size,
      tlsStatus: tlsManager.inspectStatus(),
    });
  });

  app.put('/api/security/config', requireAuth, (req: AuthedRequest, res) => {
    const b = req.body as Partial<SecurityConfig>;
    const sec = store.getState().security;

    if (b.maxLoginAttempts !== undefined) sec.maxLoginAttempts = Math.min(20, Math.max(3, Number(b.maxLoginAttempts) || 5));
    if (b.lockoutMinutes !== undefined) sec.lockoutMinutes = Math.min(180, Math.max(1, Number(b.lockoutMinutes) || 15));
    if (b.rateLimitWindowSeconds !== undefined) sec.rateLimitWindowSeconds = Math.min(300, Math.max(10, Number(b.rateLimitWindowSeconds) || 60));
    if (b.rateLimitMaxRequests !== undefined) sec.rateLimitMaxRequests = Math.min(200, Math.max(5, Number(b.rateLimitMaxRequests) || 30));
    if (b.captchaDifficulty === 'standard' || b.captchaDifficulty === 'high') sec.captchaDifficulty = b.captchaDifficulty;
    if (b.powDifficulty !== undefined) sec.powDifficulty = Math.min(4, Math.max(1, Number(b.powDifficulty) || 3));
    if (b.requireSliderVerify !== undefined) sec.requireSliderVerify = Boolean(b.requireSliderVerify);
    if (b.sliderFailureThreshold !== undefined) {
      sec.sliderFailureThreshold = Math.min(10, Math.max(0, Math.floor(Number(b.sliderFailureThreshold) || 0)));
    }
    if (b.minFormDwellMs !== undefined) sec.minFormDwellMs = Math.min(5000, Math.max(300, Number(b.minFormDwellMs) || 800));
    if (b.sessionTimeoutMinutes !== undefined) sec.sessionTimeoutMinutes = Math.min(1440, Math.max(10, Number(b.sessionTimeoutMinutes) || 120));
    if (b.maxAuditSizeBytes !== undefined) sec.maxAuditSizeBytes = Math.min(500 * 1024 * 1024, Math.max(16384, Number(b.maxAuditSizeBytes) || 5242880));
    if (b.auditRetentionPercent !== undefined) sec.auditRetentionPercent = Math.min(90, Math.max(30, Number(b.auditRetentionPercent) || 75));

    store.save();
    store.enforceAuditSizeLimit();

    store.appendAudit({
      category: 'security',
      severity: 'warning',
      action: 'SECURITY_POLICY_UPDATED',
      actor: req.sessionUser || 'admin',
      ip: getClientIp(req),
      details: `MaxAudit=${sec.maxAuditSizeBytes}B (${sec.auditRetentionPercent}% keep), MaxLogin=${sec.maxLoginAttempts}, PoW=${sec.powDifficulty}, Slider=${sec.requireSliderVerify}`,
    });

    res.json({ config: sec, auditStats: store.getAuditStats() });
  });

  // Optional extension hook (not used in standalone production runs)
  options.configureApp?.(app, { createSession, setSessionCookie, getClientIp });

  // Start background scheduler
  schedulerEngine.start();

  // Frontend mounting: Vite middleware in dev, dist/ static in production
  const isProd = process.env.NODE_ENV === 'production';
  const serverDir = path.dirname(fileURLToPath(import.meta.url));
  const parentDist = path.resolve(serverDir, '../dist');
  const cwdDist = path.resolve(process.cwd(), 'dist');
  const localDist = path.resolve(serverDir, 'dist');
  const distPath =
    [parentDist, cwdDist, localDist].find((candidate) =>
      fs.existsSync(path.join(candidate, 'index.html'))
    ) || parentDist;
  let viteServer: {
    middlewares: express.RequestHandler;
    close: () => Promise<void>;
  } | null = null;
  let viteReadyPromise: Promise<void> | null = null;

  if (!isProd) {
    const disableHmr = process.env.DISABLE_HMR === 'true';
    viteReadyPromise = import('vite')
      .then(({ createServer: createViteServer }) =>
        createViteServer({
          server: {
            middlewareMode: true,
            ...(disableHmr ? { hmr: false, ws: false, watch: null } : {}),
          },
          appType: 'spa',
        })
      )
      .then((vite) => {
        viteServer = vite;
      });

    // Mount immediately so HTTP listens without waiting for Vite cold-start;
    // non-API requests transparently wait for Vite middleware readiness.
    app.use((req, res, next) => {
      if (viteServer) {
        viteServer.middlewares(req, res, next);
        return;
      }
      if (!viteReadyPromise) {
        next();
        return;
      }
      viteReadyPromise
        .then(() => {
          if (viteServer) {
            viteServer.middlewares(req, res, next);
          } else {
            next();
          }
        })
        .catch(next);
    });
  } else if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) {
        next();
        return;
      }
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Resolve listen port & host cleanly:
  // 1. Honor CLI --port / -p and --host arguments (e.g. `npm run dev --port 3000 --host 0.0.0.0`)
  // 2. In dev mode, avoid colliding with NGINX_PORT (e.g. Cloud Run PORT=8080 used by nginx proxy)
  let cliPort: number | undefined;
  let cliHost: string | undefined;
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if ((arg === '--port' || arg === '-p') && process.argv[i + 1]) {
      const parsed = Number(process.argv[i + 1]);
      if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) cliPort = parsed;
      i += 1;
    } else if (arg.startsWith('--port=')) {
      const parsed = Number(arg.slice('--port='.length));
      if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) cliPort = parsed;
    } else if (arg === '--host' && process.argv[i + 1]) {
      cliHost = process.argv[i + 1].trim() || undefined;
      i += 1;
    } else if (arg.startsWith('--host=')) {
      cliHost = arg.slice('--host='.length).trim() || undefined;
    }
  }

  const envPort = Number(process.env.PORT);
  const nginxPort = Number(process.env.NGINX_PORT);
  const defaultAppPort = Number(process.env.DEFAULT_APP_PORT) || 3000;
  const resolvedEnvPort =
    !isProd && envPort && nginxPort && envPort === nginxPort
      ? defaultAppPort
      : envPort || defaultAppPort;
  const port = cliPort || resolvedEnvPort;
  const host = cliHost || process.env.HOST?.trim() || '0.0.0.0';

  const server = app.listen(port, host, () => {
    const adminInfo = store.getAdminInitSummary();
    const generatedInitialPass = store.consumeGeneratedInitialPassword();
    const keyInfo = getEncryptionKeyInfo();
    const httpsPort = tlsManager.getHttpsPort();
    const auditCap = store.getState().security.maxAuditSizeBytes;
    const adminDesc =
      adminInfo.mode === 'env_seed'
        ? `seeded-from-env (user="${adminInfo.username}", editable in Web UI)`
        : adminInfo.mode === 'auto_generated'
        ? `auto-generated (user="${adminInfo.username}", see initial credentials banner below)`
        : `loaded-from-state (user="${adminInfo.username}")`;

    console.log(`[NetPlus] HTTP listening on http://${host}:${port} (${isProd ? 'production' : 'development'})`);
    console.log(
      `[NetPlus] Runtime Config: DATA_DIR=${store.getDataDirectory()} | HTTPS_PORT=${httpsPort || 'disabled'} | TLS_CERT_DIR=${tlsManager.getConfiguredDir()} | KEY=${keyInfo.source}${keyInfo.path ? `(${keyInfo.path})` : ''} | ADMIN=${adminDesc} | AUDIT_MAX=${auditCap}B`
    );
    if (generatedInitialPass) {
      console.log('========================================================================');
      console.log('[NetPlus][Auth] First-run initial administrator credentials generated:');
      console.log(`  Username: ${adminInfo.username}`);
      console.log(`  Password: ${generatedInitialPass}`);
      console.log('  (Displayed ONCE. Please sign in and change password in Security Settings.)');
      console.log('========================================================================');
    }
    // Automatically bind HTTPS asynchronously so HTTP responds to health probes immediately
    setImmediate(() => {
      void tlsManager.startHttpsIfAvailable(app).catch((err) => {
        console.warn('[NetPlus][TLS] Skipped HTTPS startup:', err instanceof Error ? err.message : err);
      });
    });
  });

  if (viteReadyPromise) {
    viteReadyPromise.catch((err) => {
      console.error('[NetPlus] Failed to initialize Vite dev middleware:', err);
      process.exit(1);
    });
  }

  server.on('error', (err) => {
    console.error(`[NetPulse] HTTP server error on ${host}:${port}:`, err);
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    schedulerEngine.stop();
    tlsManager.close();
    void viteServer?.close().catch(() => undefined);
    const forceExit = setTimeout(() => process.exit(0), 1000);
    forceExit.unref();
    server.close(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });
    server.closeAllConnections?.();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGHUP', shutdown);
}

const isDirectExecution =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectExecution) {
  createServer().catch((err) => {
    console.error('[NetPlus] Fatal startup error:', err);
    process.exit(1);
  });
}
