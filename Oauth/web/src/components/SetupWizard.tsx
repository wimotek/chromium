import React, { useState } from 'react';
import {
  Database,
  Layers,
  Globe,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  ArrowLeft,
  Sun,
  Moon,
} from 'lucide-react';
import type { DbDriver, Locale, SystemConfig } from '../types';
import { SUPPORTED_LOCALES, TRANSLATIONS } from '../lib/i18n';
import { BrandMark } from './ProviderIcons';

interface SetupWizardProps {
  locale: Locale;
  onLocaleChange: (loc: Locale) => void;
  darkMode: boolean;
  onToggleDark: () => void;
  initialConfig: SystemConfig;
  onComplete: (payload: {
    dbDriver: DbDriver;
    dbDsn: string;
    redisEnabled: boolean;
    redisAddr: string;
    issuerUrl: string;
    adminEmail: string;
    adminPassword: string;
  }) => Promise<void>;
}

export function SetupWizard({
  locale,
  onLocaleChange,
  darkMode,
  onToggleDark,
  initialConfig,
  onComplete,
}: SetupWizardProps) {
  const t = TRANSLATIONS[locale];
  const [step, setStep] = useState(0);

  const [dbDriver, setDbDriver] = useState<DbDriver>(initialConfig.dbDriver);
  const [dbDsn, setDbDsn] = useState(initialConfig.dbDsn);
  const [dbTest, setDbTest] = useState<{ ok: boolean; msg: string } | null>(null);
  const [testingDb, setTestingDb] = useState(false);

  const [redisEnabled, setRedisEnabled] = useState(initialConfig.redisEnabled);
  const [redisAddr, setRedisAddr] = useState(initialConfig.redisAddr || '127.0.0.1:6379');
  const [redisTest, setRedisTest] = useState<{ ok: boolean; msg: string } | null>(null);
  const [testingRedis, setTestingRedis] = useState(false);

  const [issuerUrl, setIssuerUrl] = useState(initialConfig.issuerUrl || window.location.origin);
  const [adminEmail, setAdminEmail] = useState(
    initialConfig.initialized && initialConfig.adminEmail && initialConfig.adminEmail !== 'admin@wimotek.dev'
      ? initialConfig.adminEmail
      : ''
  );
  const [adminPassword, setAdminPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const steps = [
    { label: t.setupStepDb, icon: Database },
    { label: t.setupStepCache, icon: Layers },
    { label: t.setupStepSite, icon: Globe },
    { label: t.setupStepAdmin, icon: ShieldCheck },
  ];

  async function handleTestDb() {
    setTestingDb(true);
    setDbTest(null);
    try {
      const res = await fetch('/api/setup/test-db', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dbDriver, dbDsn }),
      });
      const data = await res.json();
      setDbTest({ ok: Boolean(data.ok), msg: data.details || data.message || 'Checked' });
    } catch {
      setDbTest({ ok: false, msg: 'Unable to reach setup test endpoint' });
    } finally {
      setTestingDb(false);
    }
  }

  async function handleTestRedis() {
    setTestingRedis(true);
    setRedisTest(null);
    try {
      const res = await fetch('/api/setup/test-redis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redisAddr }),
      });
      const data = await res.json();
      setRedisTest({ ok: Boolean(data.ok), msg: data.details || data.message || 'Checked' });
    } catch {
      setRedisTest({ ok: false, msg: 'Unable to reach Redis test endpoint' });
    } finally {
      setTestingRedis(false);
    }
  }

  async function handleFinish(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (adminPassword.length < 8) {
      setError('Admin password must be at least 8 characters.');
      return;
    }
    setSubmitting(true);
    try {
      await onComplete({
        dbDriver,
        dbDsn,
        redisEnabled,
        redisAddr,
        issuerUrl,
        adminEmail,
        adminPassword,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Initialization failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-[#0B0F19] text-slate-900 dark:text-slate-100 flex flex-col">
      <header className="w-full border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] px-6 py-3.5">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-6">
          <div className="flex items-center gap-2.5 shrink-0">
            <BrandMark className="w-7 h-7" />
            <span className="font-display text-base font-bold tracking-tight whitespace-nowrap">
              wimotek/Oauth
            </span>
          </div>

          <div className="flex items-center gap-3 flex-wrap justify-end">
            <label className="sr-only" htmlFor="wizard-locale-select">Language</label>
            <select
              id="wizard-locale-select"
              value={locale}
              onChange={(e) => onLocaleChange(e.target.value as Locale)}
              className="text-xs font-medium px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
            >
              {SUPPORTED_LOCALES.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.nativeLabel}
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={onToggleDark}
              aria-label="Toggle color theme"
              className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-4xl w-full mx-auto px-4 sm:px-6 py-10 sm:py-14">
        <div className="max-w-2xl mb-8">
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white text-balance">
            {t.setupWizardTitle}
          </h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-400 leading-relaxed i18n-safe">
            {t.setupWizardSubtitle}
          </p>
        </div>

        <nav aria-label="Setup steps" className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-6">
          {steps.map((s, idx) => {
            const Icon = s.icon;
            const active = idx === step;
            const done = idx < step;
            return (
              <button
                key={s.label}
                type="button"
                onClick={() => setStep(idx)}
                className={`flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg border text-left transition-colors ${
                  active
                    ? 'border-indigo-600 bg-indigo-50/70 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300'
                    : done
                      ? 'border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] text-slate-800 dark:text-slate-200'
                      : 'border-slate-200 dark:border-slate-800 bg-white/60 dark:bg-[#111827]/60 text-slate-500 dark:text-slate-400'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="text-xs font-medium min-w-0 i18n-safe leading-snug">
                  {idx + 1}. {s.label}
                </span>
              </button>
            );
          })}
        </nav>

        <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-6 sm:p-8">
          {step === 0 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
                  1. {t.setupStepDb}
                </h2>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                  SQLite3 enables <code className="font-mono text-xs">PRAGMA journal_mode=WAL</code>,{' '}
                  <code className="font-mono text-xs">busy_timeout=5000ms</code>, and serialized writer pooling to prevent <code className="font-mono text-xs">SQLITE_BUSY</code>.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setDbDriver('sqlite3');
                    setDbDsn('/data/wimotek_oauth.db');
                    setDbTest(null);
                  }}
                  className={`p-4 rounded-lg border text-left transition-colors ${
                    dbDriver === 'sqlite3'
                      ? 'border-indigo-600 bg-indigo-50/60 dark:bg-indigo-950/30'
                      : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                  }`}
                >
                  <div className="text-sm font-semibold text-slate-900 dark:text-white">SQLite3 (WAL Mode)</div>
                  <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Zero external dependency · Single file under /data
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setDbDriver('mysql');
                    setDbDsn('wimotek:password@tcp(mysql:3306)/wimotek_oauth?parseTime=true');
                    setDbTest(null);
                  }}
                  className={`p-4 rounded-lg border text-left transition-colors ${
                    dbDriver === 'mysql'
                      ? 'border-indigo-600 bg-indigo-50/60 dark:bg-indigo-950/30'
                      : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                  }`}
                >
                  <div className="text-sm font-semibold text-slate-900 dark:text-white">MySQL 8.x</div>
                  <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    High-throughput clustered deployment · Connection pool (25)
                  </div>
                </button>
              </div>

              <div>
                <label htmlFor="setup-db-dsn" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  {dbDriver === 'sqlite3' ? 'SQLite File Path' : 'MySQL DSN'}
                </label>
                <div className="flex flex-col sm:flex-row gap-2.5">
                  <input
                    id="setup-db-dsn"
                    type="text"
                    value={dbDsn}
                    onChange={(e) => setDbDsn(e.target.value)}
                    className="flex-1 min-h-[42px] px-3.5 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                  />
                  <button
                    type="button"
                    onClick={handleTestDb}
                    disabled={testingDb}
                    className="min-h-[42px] px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-sm font-medium whitespace-nowrap shrink-0 transition-colors"
                  >
                    {testingDb ? '...' : t.testConnection}
                  </button>
                </div>
                {dbTest && (
                  <div
                    className={`mt-2.5 flex items-center gap-2 text-xs ${
                      dbTest.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'
                    }`}
                  >
                    {dbTest.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                    <span>{dbTest.msg}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
                  2. {t.setupStepCache}
                </h2>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                  Stores OAuth authorization codes, CSRF state/nonce, rate limits, and token blacklists. If skipped or disconnected at runtime, seamlessly falls back to <code className="font-mono text-xs">sys_caches</code> SQL table with background TTL cleanup.
                </p>
              </div>

              <div className="flex items-center gap-3">
                <input
                  id="setup-skip-redis"
                  type="checkbox"
                  checked={!redisEnabled}
                  onChange={(e) => {
                    setRedisEnabled(!e.target.checked);
                    setRedisTest(null);
                  }}
                  className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                />
                <label htmlFor="setup-skip-redis" className="text-sm font-medium text-slate-800 dark:text-slate-200">
                  {t.skipRedis}
                </label>
              </div>

              {redisEnabled && (
                <div>
                  <label htmlFor="setup-redis-addr" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    Redis Address (host:port)
                  </label>
                  <div className="flex flex-col sm:flex-row gap-2.5">
                    <input
                      id="setup-redis-addr"
                      type="text"
                      value={redisAddr}
                      onChange={(e) => setRedisAddr(e.target.value)}
                      className="flex-1 min-h-[42px] px-3.5 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                    />
                    <button
                      type="button"
                      onClick={handleTestRedis}
                      disabled={testingRedis}
                      className="min-h-[42px] px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-sm font-medium whitespace-nowrap shrink-0 transition-colors"
                    >
                      {testingRedis ? '...' : t.testConnection}
                    </button>
                  </div>
                  {redisTest && (
                    <div
                      className={`mt-2.5 flex items-center gap-2 text-xs ${
                        redisTest.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'
                      }`}
                    >
                      {redisTest.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
                      <span>{redisTest.msg}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="space-y-6">
              <div>
                <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
                  3. {t.setupStepSite}
                </h2>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                  Used as the OIDC <code className="font-mono text-xs">iss</code> claim and base URL in <code className="font-mono text-xs">/.well-known/openid-configuration</code>.
                </p>
              </div>

              <div>
                <label htmlFor="setup-issuer-url" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  External Issuer URL
                </label>
                <input
                  id="setup-issuer-url"
                  type="url"
                  value={issuerUrl}
                  onChange={(e) => setIssuerUrl(e.target.value)}
                  placeholder="https://auth.company.com"
                  className="w-full min-h-[42px] px-3.5 py-2 text-sm font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                />
              </div>

              <div className="pt-4 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-400 space-y-1.5">
                <div className="font-medium text-slate-800 dark:text-slate-200">{t.tlsCertStatus}</div>
                <p>
                  Read-only <code className="font-mono">/certs:ro</code> is checked first for <code className="font-mono">tls.crt</code>/<code className="font-mono">tls.key</code>. When absent, the server never writes to <code className="font-mono">/certs</code> and automatically persists a self-signed TLS certificate in <code className="font-mono">/data/certs/</code>.
                </p>
              </div>
            </div>
          )}

          {step === 3 && (
            <form id="setup-complete-form" onSubmit={handleFinish} className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
                  4. {t.setupStepAdmin}
                </h2>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                  Create the initial super-admin account. Once saved, the wizard locks atomically to prevent re-initialization.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="setup-admin-email" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    {t.emailLabel}
                  </label>
                  <input
                    id="setup-admin-email"
                    type="email"
                    required
                    value={adminEmail}
                    onChange={(e) => setAdminEmail(e.target.value)}
                    placeholder="admin@example.com"
                    className="w-full min-h-[42px] px-3.5 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                  />
                </div>
                <div>
                  <label htmlFor="setup-admin-pass" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    {t.passwordLabel} (min 8 chars)
                  </label>
                  <input
                    id="setup-admin-pass"
                    type="password"
                    required
                    minLength={8}
                    value={adminPassword}
                    onChange={(e) => setAdminPassword(e.target.value)}
                    placeholder="Create strong password"
                    className="w-full min-h-[42px] px-3.5 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                  />
                </div>
              </div>

              {error && (
                <div role="alert" className="flex items-center gap-2 text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 rounded-lg px-3.5 py-2.5">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
            </form>
          )}

          <div className="mt-8 pt-5 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-4">
            <button
              type="button"
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              disabled={step === 0}
              className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 flex items-center gap-1.5 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Back</span>
            </button>

            {step < 3 ? (
              <button
                type="button"
                onClick={() => setStep((s) => Math.min(3, s + 1))}
                className="min-h-[40px] px-5 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-white text-sm font-medium flex items-center gap-1.5 transition-colors"
              >
                <span>Continue</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            ) : (
              <button
                type="submit"
                form="setup-complete-form"
                disabled={submitting}
                className="min-h-[40px] px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium flex items-center gap-2 transition-colors disabled:opacity-60"
              >
                <ShieldCheck className="w-4 h-4" />
                <span>{submitting ? '...' : t.completeSetup}</span>
              </button>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
