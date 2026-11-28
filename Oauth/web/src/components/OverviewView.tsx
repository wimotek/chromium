import React, { useState } from 'react';
import {
  Copy,
  Check,
  Database,
  Layers,
  Shield,
  ExternalLink,
  RefreshCw,
  Eye,
  EyeOff,
  KeyRound,
  ShieldAlert,
  CheckCircle2,
  Trash2,
} from 'lucide-react';
import type { Locale, SigningKeyStatus, SystemConfig } from '../types';
import { TRANSLATIONS } from '../lib/i18n';
import { DatabaseBackupSection } from './DatabaseBackupSection';

interface OverviewViewProps {
  locale: Locale;
  config: SystemConfig;
  counts: { applications: number; enabledConnectors: number; totalConnectors: number };
  jwksKid: string;
  signingKeyStatus: SigningKeyStatus | null;
  cacheStats: { mode: string; redisKeys: number; sqlFallbackKeys: number };
  onSimulateCacheFailover: (simulatedDown: boolean) => Promise<void>;
  onRotateSigningKey: (
    mode: 'graceful' | 'emergency',
    graceMinutes?: number
  ) => Promise<{ ok: boolean; mode: 'graceful' | 'emergency'; previousKid: string; jwksKid: string; signingKeyStatus: SigningKeyStatus } | null>;
  onPurgeRetiringKeys: () => Promise<void>;
}

export function OverviewView({
  locale,
  config,
  counts,
  jwksKid,
  signingKeyStatus,
  cacheStats,
  onSimulateCacheFailover,
  onRotateSigningKey,
  onPurgeRetiringKeys,
}: OverviewViewProps) {
  const t = TRANSLATIONS[locale];
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [showSigningKey, setShowSigningKey] = useState(false);
  const [liveJson, setLiveJson] = useState<{ title: string; body: string } | null>(null);
  const [togglingCache, setTogglingCache] = useState(false);

  const [graceMinutes, setGraceMinutes] = useState<number>(120);
  const [rotatingMode, setRotatingMode] = useState<'graceful' | 'emergency' | 'purge' | null>(null);
  const [confirmEmergency, setConfirmEmergency] = useState(false);
  const [rotationNotice, setRotationNotice] = useState<{
    kind: 'graceful' | 'emergency' | 'purge' | 'error';
    text: string;
  } | null>(null);

  const retiringKeys = signingKeyStatus?.retiringKeys || [];
  const jwksKeyCount = signingKeyStatus?.jwksKeyCount || 1;

  const issuer = config.issuerUrl.replace(/\/$/, '');
  const endpoints = [
    { label: 'OIDC Discovery', url: `${issuer}/.well-known/openid-configuration`, inspectPath: '/.well-known/openid-configuration' },
    { label: 'JWKS (RS256)', url: `${issuer}/.well-known/jwks.json`, inspectPath: '/.well-known/jwks.json' },
    { label: 'Authorization', url: `${issuer}/oauth/authorize` },
    { label: 'Token Exchange', url: `${issuer}/oauth/token` },
    { label: 'UserInfo', url: `${issuer}/oauth/userinfo` },
    { label: 'End Session', url: `${issuer}/oauth/logout` },
  ];

  async function copyText(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1600);
    } catch {
      // ignore clipboard errors
    }
  }

  async function inspectEndpoint(label: string, path: string) {
    const res = await fetch(path);
    const json = await res.json();
    setLiveJson({ title: `${label} (${path})`, body: JSON.stringify(json, null, 2) });
  }

  async function handleToggleRedis() {
    setTogglingCache(true);
    try {
      await onSimulateCacheFailover(!config.redisSimulatedDown);
    } finally {
      setTogglingCache(false);
    }
  }

  async function handleGracefulRotate() {
    setRotatingMode('graceful');
    setRotationNotice(null);
    setConfirmEmergency(false);
    try {
      const res = await onRotateSigningKey('graceful', graceMinutes);
      if (res) {
        setRotationNotice({
          kind: 'graceful',
          text: `Graceful rotation complete. New RSA-2048 key is active; previous public key remains in JWKS for ${graceMinutes} min (${res.signingKeyStatus.jwksKeyCount} keys published).`,
        });
      }
    } catch (err) {
      setRotationNotice({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Graceful rotation failed',
      });
    } finally {
      setRotatingMode(null);
    }
  }

  async function handleEmergencyRotate() {
    setRotatingMode('emergency');
    setRotationNotice(null);
    try {
      const res = await onRotateSigningKey('emergency');
      setConfirmEmergency(false);
      if (res) {
        setRotationNotice({
          kind: 'emergency',
          text: `Emergency revocation complete. Previous key removed immediately from JWKS (1 active key) and refresh tokens invalidated. Clear downstream JWKS caches to kick compromised sessions immediately.`,
        });
      }
    } catch (err) {
      setRotationNotice({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Emergency revocation failed',
      });
    } finally {
      setRotatingMode(null);
    }
  }

  async function handlePurgeRetiring() {
    setRotatingMode('purge');
    setRotationNotice(null);
    try {
      await onPurgeRetiringKeys();
      setRotationNotice({
        kind: 'purge',
        text: 'All retiring public keys purged from /.well-known/jwks.json. Only the active RS256 key is now trusted.',
      });
    } finally {
      setRotatingMode(null);
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-white text-balance">
            {t.overviewTitle}
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400 i18n-safe">
            {t.overviewSubtitle}
          </p>
        </div>

      </div>

      {/* Key Operational Summary Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-[#111827] divide-y sm:divide-y-0 sm:divide-x divide-slate-200 dark:divide-slate-800">
        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">{t.navApplications}</div>
          <div className="mt-2 font-mono text-2xl font-semibold tabular-nums text-slate-900 dark:text-white">
            {counts.applications}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">OIDC PKCE S256 clients</div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">{t.navConnectors}</div>
          <div className="mt-2 font-mono text-2xl font-semibold tabular-nums text-slate-900 dark:text-white">
            {counts.enabledConnectors} / {counts.totalConnectors}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">Active social adapters</div>
        </div>

        <div className="p-5">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400">RS256 Signing Key</div>
            <button
              type="button"
              onClick={() => setShowSigningKey((v) => !v)}
              aria-label={showSigningKey ? 'Hide RS256 signing key' : 'Show RS256 signing key'}
              title={showSigningKey ? 'Hide key ID' : 'Show key ID'}
              className="p-1 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              {showSigningKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
          </div>
          <div className="mt-2 font-mono text-lg font-semibold tabular-nums text-slate-900 dark:text-white truncate">
            {showSigningKey ? (jwksKid || '—') : '••••••••••••'}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Signs OIDC JWTs · JWKS: {jwksKeyCount} {jwksKeyCount > 1 ? 'keys (grace)' : 'key'}
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">{t.cacheEngineTitle}</div>
          <div className="mt-2 text-lg font-semibold text-slate-900 dark:text-white flex items-center gap-2">
            <span className={config.activeCacheMode === 'redis' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>
              {config.activeCacheMode === 'redis' ? 'Redis Active' : 'SQL Fallback'}
            </span>
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            Redis: {cacheStats.redisKeys} · SQL: {cacheStats.sqlFallbackKeys}
          </div>
        </div>
      </div>

      {/* OIDC Protocol Endpoints Table */}
      <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-4">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
            {t.oidcEndpointsTitle}
          </h2>
          <span className="text-xs text-slate-500 dark:text-slate-400 font-mono">
            RFC 6749 · RFC 7636 · OIDC 1.0
          </span>
        </div>

        <div className="divide-y divide-slate-100 dark:divide-slate-800/80">
          {endpoints.map((ep) => (
            <div
              key={ep.label}
              className="px-6 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 hover:bg-slate-50/70 dark:hover:bg-slate-800/30 transition-colors"
            >
              <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 min-w-0">
                <span className="text-xs font-medium text-slate-700 dark:text-slate-300 w-32 shrink-0">
                  {ep.label}
                </span>
                <code className="text-xs font-mono text-slate-600 dark:text-slate-400 truncate">
                  {ep.url}
                </code>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {ep.inspectPath && (
                  <button
                    type="button"
                    onClick={() => inspectEndpoint(ep.label, ep.inspectPath!)}
                    className="px-2.5 py-1.5 text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 rounded-md flex items-center gap-1 transition-colors whitespace-nowrap"
                  >
                    <ExternalLink className="w-3 h-3" />
                    <span>Inspect JSON</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => copyText(ep.label, ep.url)}
                  aria-label={`Copy ${ep.label} URL`}
                  className="p-1.5 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                >
                  {copiedKey === ep.label ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
          ))}
        </div>

        {liveJson && (
          <div className="border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0F19] p-5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-200 font-mono">
                {liveJson.title}
              </span>
              <button
                type="button"
                onClick={() => setLiveJson(null)}
                className="text-xs text-slate-500 hover:text-slate-900 dark:hover:text-white"
              >
                Close
              </button>
            </div>
            <pre className="text-xs font-mono text-slate-800 dark:text-slate-200 overflow-x-auto max-h-72 leading-relaxed">
              {liveJson.body}
            </pre>
          </div>
        )}
      </section>

      {/* Storage + Cache + TLS Architecture Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
          <div className="flex items-center gap-2.5">
            <Database className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
              {t.storageEngineTitle}
            </h2>
          </div>

          <dl className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
            <div className="py-2.5 flex items-center justify-between gap-4">
              <dt className="text-slate-500 dark:text-slate-400">Active Driver</dt>
              <dd className="font-mono font-medium text-slate-900 dark:text-slate-100">{config.dbDriver}</dd>
            </div>
            <div className="py-2.5 flex items-center justify-between gap-4">
              <dt className="text-slate-500 dark:text-slate-400">DSN / Data Path</dt>
              <dd className="font-mono text-slate-700 dark:text-slate-300 truncate max-w-[260px]">{config.dbDsn}</dd>
            </div>
            <div className="py-2.5 flex items-center justify-between gap-4">
              <dt className="text-slate-500 dark:text-slate-400">Concurrency Guard</dt>
              <dd className="font-mono text-slate-700 dark:text-slate-300">
                WAL · busy_timeout={config.sqliteBusyTimeoutMs}ms · MaxWriteConns({config.sqliteMaxWriteConns})
              </dd>
            </div>
            <div className="py-2.5 flex items-center justify-between gap-4">
              <dt className="text-slate-500 dark:text-slate-400">{t.tlsCertStatus}</dt>
              <dd className="text-slate-700 dark:text-slate-300 text-right">{config.tlsSource}</dd>
            </div>
          </dl>
        </section>

        <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-6 flex flex-col justify-between gap-4">
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2.5">
                <Layers className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                  {t.cacheEngineTitle}
                </h2>
              </div>
              <span
                className={`text-xs font-medium ${
                  config.activeCacheMode === 'redis'
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-amber-700 dark:text-amber-400'
                }`}
              >
                {config.activeCacheMode === 'redis' ? 'Primary: Redis' : 'Degraded: SQL sys_caches'}
              </span>
            </div>

            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              Authorization codes, PKCE state/nonce, rate-limit counters, and token blacklists prefer Redis. Toggle below to verify zero-downtime automatic failover into the <code className="font-mono">sys_caches</code> table with periodic GC sweeps.
            </p>
          </div>

          <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <Shield className="w-3.5 h-3.5" />
              <span>Non-root UID/GID 1000:1000 · Read-only /certs:ro safe</span>
            </div>
            <button
              type="button"
              onClick={handleToggleRedis}
              disabled={togglingCache}
              className="min-h-[38px] px-3.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium text-slate-800 dark:text-slate-100 flex items-center gap-1.5 whitespace-nowrap transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${togglingCache ? 'animate-spin' : ''}`} />
              <span>{config.redisSimulatedDown ? t.restoreRedis : t.simulateRedisFailover}</span>
            </button>
          </div>
        </section>
      </div>

      {/* RS256 Signing Key Rotation & Emergency Revocation */}
      <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <KeyRound className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
              RS256 Signing Key Rotation &amp; Emergency Revocation
            </h2>
          </div>
          <div className="flex items-center gap-3 text-xs font-mono text-slate-500 dark:text-slate-400">
            <span>JWKS keys: {jwksKeyCount}</span>
            <span>·</span>
            <span>/data/keys/oidc_rs256.pem</span>
          </div>
        </div>

        <div className="p-6 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-lg bg-slate-50 dark:bg-[#0B0F19] border border-slate-200 dark:border-slate-800 text-xs">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-slate-500 dark:text-slate-400">Active Signing Key ID:</span>
                <code className="font-mono font-semibold text-slate-900 dark:text-white">
                  {showSigningKey ? (jwksKid || '—') : '••••••••••••'}
                </code>
                <button
                  type="button"
                  onClick={() => setShowSigningKey((v) => !v)}
                  className="text-indigo-600 dark:text-indigo-400 hover:underline font-medium"
                >
                  {showSigningKey ? 'Hide' : 'Reveal'}
                </button>
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                Replacing the RS256 key only affects OIDC JWT signatures — user accounts, passwords, and encrypted social connector secrets (<code className="font-mono">WIMOTEK_MASTER_KEY</code>) are unaffected.
              </div>
            </div>

            <button
              type="button"
              onClick={() => inspectEndpoint('JWKS (RS256)', '/.well-known/jwks.json')}
              className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-white dark:hover:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>Inspect Live JWKS</span>
            </button>
          </div>

          {retiringKeys.length > 0 && (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-lg bg-amber-50/70 dark:bg-amber-950/25 border border-amber-200 dark:border-amber-900/50 text-xs">
              <div className="space-y-1">
                <div className="font-semibold text-amber-800 dark:text-amber-300">
                  Grace Window Active ({retiringKeys.length} retiring public {retiringKeys.length > 1 ? 'keys' : 'key'} still published in JWKS)
                </div>
                <div className="space-y-0.5 text-amber-700/90 dark:text-amber-400/90 font-mono text-[11px]">
                  {retiringKeys.map((rk) => (
                    <div key={rk.kid}>
                      retiring kid: {showSigningKey ? rk.kid : '••••••••••••'} · auto-expires {new Date(rk.expiresAt).toLocaleTimeString()}
                    </div>
                  ))}
                </div>
              </div>
              <button
                type="button"
                onClick={handlePurgeRetiring}
                disabled={rotatingMode !== null}
                className="px-3 py-1.5 rounded-lg border border-amber-300 dark:border-amber-800 hover:bg-amber-100/70 dark:hover:bg-amber-900/40 text-amber-900 dark:text-amber-200 font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>{rotatingMode === 'purge' ? 'Purging...' : 'Purge Previous Keys Now'}</span>
              </button>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="p-5 rounded-lg border border-slate-200 dark:border-slate-800 space-y-3 flex flex-col justify-between">
              <div className="space-y-1.5">
                <div className="text-xs font-semibold text-slate-900 dark:text-white">
                  1. Graceful Key Rotation (Zero Downtime)
                </div>
                <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                  Recommended for scheduled security hygiene. Signs all new tokens with a fresh RSA-2048 key while keeping the previous public key in <code className="font-mono">/.well-known/jwks.json</code> during the grace window so active users stay signed in.
                </p>
              </div>

              <div className="pt-2 flex flex-wrap items-center gap-2.5">
                <label htmlFor="grace-window-select" className="text-xs text-slate-600 dark:text-slate-400">
                  Grace window:
                </label>
                <select
                  id="grace-window-select"
                  value={graceMinutes}
                  onChange={(e) => setGraceMinutes(Number(e.target.value))}
                  className="text-xs font-mono px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200"
                >
                  <option value={60}>1 hour (60m)</option>
                  <option value={120}>2 hours (120m)</option>
                  <option value={360}>6 hours (360m)</option>
                  <option value={1440}>24 hours (1440m)</option>
                </select>

                <button
                  type="button"
                  onClick={handleGracefulRotate}
                  disabled={rotatingMode !== null}
                  className="ml-auto min-h-[36px] px-3.5 py-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-white text-xs font-medium flex items-center gap-1.5 whitespace-nowrap transition-colors disabled:opacity-60"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${rotatingMode === 'graceful' ? 'animate-spin' : ''}`} />
                  <span>{rotatingMode === 'graceful' ? 'Rotating...' : 'Graceful Rotate Key'}</span>
                </button>
              </div>
            </div>

            <div className="p-5 rounded-lg border border-red-200/80 dark:border-red-900/50 bg-red-50/30 dark:bg-red-950/15 space-y-3 flex flex-col justify-between">
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-red-700 dark:text-red-400">
                  <ShieldAlert className="w-3.5 h-3.5" />
                  <span>2. Emergency Revoke &amp; Replace (Key Compromise)</span>
                </div>
                <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                  Use immediately if <code className="font-mono">oidc_rs256.pem</code> is leaked. Generates a new RSA-2048 key, purges all old public keys from JWKS immediately, and revokes active refresh tokens. Existing user tokens will fail verification once apps refresh JWKS.
                </p>
              </div>

              <div className="pt-2">
                {!confirmEmergency ? (
                  <button
                    type="button"
                    onClick={() => setConfirmEmergency(true)}
                    disabled={rotatingMode !== null}
                    className="min-h-[36px] px-3.5 py-1.5 rounded-lg border border-red-300 dark:border-red-800 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/50 text-xs font-medium flex items-center gap-1.5 whitespace-nowrap transition-colors"
                  >
                    <ShieldAlert className="w-3.5 h-3.5" />
                    <span>Emergency Revoke &amp; Replace...</span>
                  </button>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={handleEmergencyRotate}
                      disabled={rotatingMode !== null}
                      className="min-h-[36px] px-3.5 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-medium flex items-center gap-1.5 whitespace-nowrap transition-colors disabled:opacity-60"
                    >
                      <ShieldAlert className="w-3.5 h-3.5" />
                      <span>{rotatingMode === 'emergency' ? 'Revoking...' : 'Confirm Immediate Revocation'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmEmergency(false)}
                      disabled={rotatingMode !== null}
                      className="min-h-[36px] px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-800"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {rotationNotice && (
            <div
              role="status"
              className={`flex items-start gap-2 text-xs rounded-lg px-3.5 py-2.5 border ${
                rotationNotice.kind === 'error'
                  ? 'text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900/60'
                  : rotationNotice.kind === 'emergency'
                    ? 'text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900/60'
                    : 'text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900/60'
              }`}
            >
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{rotationNotice.text}</span>
            </div>
          )}
        </div>
      </section>

      {/* Database Backup & Retention Policy */}
      <DatabaseBackupSection locale={locale} />
    </div>
  );
}
