import React, { useState } from 'react';
import { Monitor, Smartphone, ArrowLeftRight, CheckCircle2, ShieldCheck } from 'lucide-react';
import type { AuthPolicyConfig, Locale, OAuthApplication, OidcFlowTrace, SocialConnector } from '../types';
import { TRANSLATIONS } from '../lib/i18n';
import { HostedLoginCard } from './HostedLoginCard';

interface LoginLabViewProps {
  locale: Locale;
  connectors: SocialConnector[];
  applications: OAuthApplication[];
  authPolicy?: AuthPolicyConfig;
  selectedClientId: string;
  onSelectClientId: (clientId: string) => void;
  onRunOidcLogin: (provider: string, clientId: string) => Promise<OidcFlowTrace | null>;
  onAuthCompleted?: (result: { user: any; sessionToken: string; trace: OidcFlowTrace }) => void;
  latestTrace: OidcFlowTrace | null;
}

export function LoginLabView({
  locale,
  connectors,
  applications,
  authPolicy,
  selectedClientId,
  onSelectClientId,
  onRunOidcLogin,
  onAuthCompleted,
  latestTrace,
}: LoginLabViewProps) {
  const t = TRANSLATIONS[locale];
  const [viewport, setViewport] = useState<'desktop' | 'mobile'>('desktop');
  const [rtl, setRtl] = useState(false);
  const [busyProvider, setBusyProvider] = useState<string | null>(null);

  async function handleSignIn(provider: string) {
    setBusyProvider(provider);
    try {
      await onRunOidcLogin(provider, selectedClientId);
    } finally {
      setBusyProvider(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header + Toolbar */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            {t.loginLabTitle}
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400 i18n-safe">
            {t.loginLabSubtitle}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap w-full lg:w-auto min-w-0">
          <label className="sr-only" htmlFor="lab-app-select">Target Application</label>
          <select
            id="lab-app-select"
            value={selectedClientId}
            onChange={(e) => onSelectClientId(e.target.value)}
            className="w-full sm:w-auto max-w-full min-w-0 min-h-[38px] px-3 py-1.5 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#111827] text-slate-800 dark:text-slate-200"
          >
            {applications.map((app) => (
              <option key={app.id} value={app.clientId}>
                {app.name} ({app.clientId})
              </option>
            ))}
          </select>

          <div className="inline-flex items-center p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700">
            <button
              type="button"
              onClick={() => setViewport('desktop')}
              className={`px-2.5 py-1.5 text-xs font-medium rounded-md flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                viewport === 'desktop'
                  ? 'bg-white dark:bg-[#111827] text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              <Monitor className="w-3.5 h-3.5" />
              <span>{t.viewportDesktop}</span>
            </button>
            <button
              type="button"
              onClick={() => setViewport('mobile')}
              className={`px-2.5 py-1.5 text-xs font-medium rounded-md flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                viewport === 'mobile'
                  ? 'bg-white dark:bg-[#111827] text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              <Smartphone className="w-3.5 h-3.5" />
              <span>{t.viewportMobile}</span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => setRtl((v) => !v)}
            className={`min-h-[38px] px-3 py-1.5 text-xs font-medium rounded-lg border flex items-center gap-1.5 whitespace-nowrap transition-colors ${
              rtl
                ? 'border-indigo-600 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300'
                : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-[#111827] text-slate-700 dark:text-slate-300'
            }`}
          >
            <ArrowLeftRight className="w-3.5 h-3.5" />
            <span>{t.rtlPreview}</span>
          </button>
        </div>
      </div>

      {/* Main Split: Live Hosted Login Canvas + Live OIDC PKCE Handshake Trace */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <div className="xl:col-span-6 bg-slate-100/80 dark:bg-[#0D1321] border border-slate-200 dark:border-slate-800 rounded-xl p-6 sm:p-8 flex justify-center">
          <div className={`w-full transition-all ${viewport === 'mobile' ? 'max-w-[360px]' : 'max-w-[440px]'}`}>
            <HostedLoginCard
              locale={locale}
              connectors={connectors}
              authPolicy={authPolicy}
              clientId={selectedClientId}
              rtl={rtl}
              compact={viewport === 'mobile'}
              onSocialSignIn={handleSignIn}
              onAuthCompleted={onAuthCompleted}
              busyProvider={busyProvider}
            />
          </div>
        </div>

        {/* Live OIDC Flow Inspector */}
        <section className="xl:col-span-6 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5">
          <div className="flex items-center justify-between gap-3 pb-3 border-b border-slate-100 dark:border-slate-800">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
              {t.oidcTraceTitle}
            </h2>
            {latestTrace && (
              <span className="text-xs font-mono tabular-nums text-emerald-700 dark:text-emerald-400 flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5" />
                RS256 Verified · {latestTrace.elapsedMs}ms
              </span>
            )}
          </div>

          {!latestTrace ? (
            <div className="py-14 text-center space-y-2">
              <ShieldCheck className="w-8 h-8 mx-auto text-slate-300 dark:text-slate-700" />
              <p className="text-sm text-slate-600 dark:text-slate-400">
                Click <strong>{t.oneClickLogin}</strong> or any social connector on the left to execute a live OIDC Authorization Code + PKCE (S256) flow.
              </p>
            </div>
          ) : (
            <div className="space-y-4 text-xs">
              <dl className="divide-y divide-slate-100 dark:divide-slate-800">
                <div className="py-2 flex justify-between gap-4">
                  <dt className="text-slate-500 dark:text-slate-400">Upstream Provider</dt>
                  <dd className="font-medium text-slate-900 dark:text-slate-100">{latestTrace.provider}</dd>
                </div>
                {latestTrace.authMethod && (
                  <div className="py-2 flex justify-between gap-4">
                    <dt className="text-slate-500 dark:text-slate-400">Auth Method</dt>
                    <dd className="font-mono text-slate-800 dark:text-slate-200">{latestTrace.authMethod}</dd>
                  </div>
                )}
                {latestTrace.jitAction && (
                  <div className="py-2 flex justify-between gap-4">
                    <dt className="text-slate-500 dark:text-slate-400">Identity Linking (JIT)</dt>
                    <dd className="font-mono text-emerald-700 dark:text-emerald-400">{latestTrace.jitAction}</dd>
                  </div>
                )}
                <div className="py-2 flex justify-between gap-4">
                  <dt className="text-slate-500 dark:text-slate-400">Client ID</dt>
                  <dd className="font-mono text-slate-800 dark:text-slate-200">{latestTrace.clientId}</dd>
                </div>
                <div className="py-2 flex justify-between gap-4">
                  <dt className="text-slate-500 dark:text-slate-400">Cache Backend Used</dt>
                  <dd className="font-mono text-indigo-600 dark:text-indigo-400">{latestTrace.cacheBackendUsed}</dd>
                </div>
                <div className="py-2 flex justify-between gap-4">
                  <dt className="text-slate-500 dark:text-slate-400">PKCE S256 Challenge</dt>
                  <dd className="font-mono text-slate-700 dark:text-slate-300 truncate max-w-[260px]">
                    {latestTrace.codeChallenge}
                  </dd>
                </div>
                <div className="py-2 flex justify-between gap-4">
                  <dt className="text-slate-500 dark:text-slate-400">Authorization Code</dt>
                  <dd className="font-mono text-slate-700 dark:text-slate-300 truncate max-w-[260px]">
                    {latestTrace.authorizationCode}
                  </dd>
                </div>
              </dl>

              <div>
                <div className="font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Decoded ID Token Payload (RS256 Signature Verified: {String(latestTrace.decodedIdToken.signatureVerified)})
                </div>
                <pre className="p-3.5 rounded-lg bg-slate-50 dark:bg-[#0B0F19] border border-slate-200 dark:border-slate-800 font-mono text-[11px] text-slate-800 dark:text-slate-200 overflow-x-auto leading-relaxed">
                  {JSON.stringify(latestTrace.decodedIdToken.payload, null, 2)}
                </pre>
              </div>

              <div>
                <div className="font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  GET /oauth/userinfo Response
                </div>
                <pre className="p-3.5 rounded-lg bg-slate-50 dark:bg-[#0B0F19] border border-slate-200 dark:border-slate-800 font-mono text-[11px] text-slate-800 dark:text-slate-200 overflow-x-auto leading-relaxed">
                  {JSON.stringify(latestTrace.userInfo, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
