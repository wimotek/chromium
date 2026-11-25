import React, { useState } from 'react';
import {
  Copy,
  Check,
  Database,
  Layers,
  Shield,
  ExternalLink,
  RefreshCw,
  Zap,
  RotateCcw,
} from 'lucide-react';
import type { Locale, SystemConfig } from '../types';
import { TRANSLATIONS } from '../lib/i18n';

interface OverviewViewProps {
  locale: Locale;
  config: SystemConfig;
  counts: { applications: number; enabledConnectors: number; totalConnectors: number };
  jwksKid: string;
  cacheStats: { mode: string; redisKeys: number; sqlFallbackKeys: number };
  onSimulateCacheFailover: (simulatedDown: boolean) => Promise<void>;
  onJumpToLoginLab: () => void;
  onRerunWizard: () => Promise<void>;
}

export function OverviewView({
  locale,
  config,
  counts,
  jwksKid,
  cacheStats,
  onSimulateCacheFailover,
  onJumpToLoginLab,
  onRerunWizard,
}: OverviewViewProps) {
  const t = TRANSLATIONS[locale];
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [liveJson, setLiveJson] = useState<{ title: string; body: string } | null>(null);
  const [togglingCache, setTogglingCache] = useState(false);

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
      // ignore clipboard errors in headless mode
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

  return (
    <div className="space-y-8">
      {/* Section Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-white text-balance">
            {t.overviewTitle}
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400 i18n-safe">
            {t.overviewSubtitle}
          </p>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap">
          <button
            type="button"
            onClick={onRerunWizard}
            className="min-h-[40px] px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#111827] hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>{t.rerunSetupWizard}</span>
          </button>

          <button
            type="button"
            onClick={onJumpToLoginLab}
            className="min-h-[40px] px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
          >
            <Zap className="w-3.5 h-3.5" />
            <span>{t.oneClickLogin}</span>
          </button>
        </div>
      </div>

      {/* Key Operational Summary Row (flat hairline grid, tabular numerals, zero pills) */}
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
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">RS256 Signing Key</div>
          <div className="mt-2 font-mono text-lg font-semibold tabular-nums text-slate-900 dark:text-white truncate">
            {jwksKid || 'loading...'}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">RSA-2048 · AES-256-GCM vault</div>
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
        {/* Dual-mode Database Panel */}
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

        {/* Resilient Cache Failover Panel */}
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
    </div>
  );
}
