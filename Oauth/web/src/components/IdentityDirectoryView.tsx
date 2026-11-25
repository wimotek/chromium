import React, { useState } from 'react';
import {
  UserPlus,
  Ban,
  CheckCircle2,
  Webhook,
  Trash2,
  ShieldAlert,
  Link2,
  Fingerprint,
  KeyRound,
  AlertCircle,
} from 'lucide-react';
import type {
  IdentityProviderType,
  IdentityUser,
  Locale,
  WebhookDeliveryLog,
  WebhookSubscription,
} from '../types';
import { TRANSLATIONS } from '../lib/i18n';

interface IdentityDirectoryViewProps {
  locale: Locale;
  users: IdentityUser[];
  webhooks: WebhookSubscription[];
  webhookLogs: WebhookDeliveryLog[];
  jitAutoLinkEnabled: boolean;
  onSimulateJit: (payload: {
    email: string;
    displayName: string;
    provider: IdentityProviderType;
    emailVerified: boolean;
  }) => Promise<{ action: string; user: IdentityUser } | null>;
  onToggleUserStatus: (userId: string, nextStatus: 'active' | 'banned') => Promise<void>;
  onCreateWebhook: (payload: { name: string; targetUrl: string; signingSecret: string }) => Promise<void>;
  onDeleteWebhook: (id: string) => Promise<void>;
}

export function IdentityDirectoryView({
  locale,
  users,
  webhooks,
  webhookLogs,
  jitAutoLinkEnabled,
  onSimulateJit,
  onToggleUserStatus,
  onCreateWebhook,
  onDeleteWebhook,
}: IdentityDirectoryViewProps) {
  const t = TRANSLATIONS[locale];
  const [jitEmail, setJitEmail] = useState('');
  const [jitName, setJitName] = useState('');
  const [jitProvider, setJitProvider] = useState<IdentityProviderType>('microsoft');
  const [jitEmailVerified, setJitEmailVerified] = useState(true);
  const [jitResult, setJitResult] = useState<string | null>(null);
  const [simulating, setSimulating] = useState(false);

  const [whName, setWhName] = useState('');
  const [whUrl, setWhUrl] = useState('');
  const [whSecret, setWhSecret] = useState('');
  const [whError, setWhError] = useState<string | null>(null);

  async function handleRunJit(e: React.FormEvent) {
    e.preventDefault();
    setSimulating(true);
    setJitResult(null);
    try {
      const res = await onSimulateJit({
        email: jitEmail.trim(),
        displayName: jitName.trim(),
        provider: jitProvider,
        emailVerified: jitEmailVerified,
      });
      if (res) {
        if (res.action === 'linked_existing_verified_email') {
          setJitResult(`Smoothly linked ${jitProvider} onto existing verified account ${res.user.email} (${res.user.id}) — zero duplicate users.`);
        } else if (res.action === 'provisioned_new_user') {
          setJitResult(`JIT provisioned new lightweight identity ${res.user.email} (${res.user.id}).`);
        } else {
          setJitResult(`Matched existing identity link on ${res.user.email}.`);
        }
      }
    } finally {
      setSimulating(false);
    }
  }

  async function handleAddWebhook(e: React.FormEvent) {
    e.preventDefault();
    setWhError(null);
    try {
      await onCreateWebhook({ name: whName.trim(), targetUrl: whUrl.trim(), signingSecret: whSecret.trim() });
      setWhName('');
      setWhSecret('');
    } catch (err) {
      setWhError(err instanceof Error ? err.message : 'Failed to create webhook');
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
          {t.usersTitle}
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400 i18n-safe">
          {t.usersSubtitle}
        </p>
      </div>

      {/* JIT + Verified-Email Account Linking Simulator */}
      <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Link2 className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
              JIT Sync &amp; Verified-Email Legacy Account Linking Test
            </h2>
          </div>
          <span className="text-xs font-mono text-slate-500 dark:text-slate-400">
            Auto-link verified email: {jitAutoLinkEnabled ? 'ON' : 'OFF'}
          </span>
        </div>

        <form onSubmit={handleRunJit} className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
          <div className="md:col-span-4">
            <label htmlFor="jit-email" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
              User Email
            </label>
            <input
              id="jit-email"
              type="email"
              required
              value={jitEmail}
              onChange={(e) => setJitEmail(e.target.value)}
              placeholder="user@example.com"
              className="w-full min-h-[38px] px-3 py-1.5 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
            />
          </div>

          <div className="md:col-span-3">
            <label htmlFor="jit-provider" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
              Upstream Login Channel
            </label>
            <select
              id="jit-provider"
              value={jitProvider}
              onChange={(e) => setJitProvider(e.target.value as IdentityProviderType)}
              className="w-full min-h-[38px] px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
            >
              <option value="microsoft">Microsoft (Entra ID)</option>
              <option value="google">Google</option>
              <option value="wechat">微信 WeChat</option>
              <option value="apple">Apple</option>
              <option value="github">GitHub</option>
              <option value="passkey">Passkey (WebAuthn)</option>
            </select>
          </div>

          <div className="md:col-span-2 flex items-center gap-2 min-h-[38px]">
            <input
              id="jit-verified"
              type="checkbox"
              checked={jitEmailVerified}
              onChange={(e) => setJitEmailVerified(e.target.checked)}
              className="w-4 h-4 rounded border-slate-300 text-indigo-600"
            />
            <label htmlFor="jit-verified" className="text-xs text-slate-700 dark:text-slate-300">
              email_verified
            </label>
          </div>

          <div className="md:col-span-3">
            <button
              type="submit"
              disabled={simulating}
              className="w-full min-h-[38px] px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium flex items-center justify-center gap-1.5 whitespace-nowrap transition-colors"
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>{simulating ? '...' : 'Simulate JIT / Link'}</span>
            </button>
          </div>
        </form>

        {jitResult && (
          <div className="flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-400 bg-emerald-50/80 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/50 rounded-lg px-3.5 py-2.5">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{jitResult}</span>
          </div>
        )}
      </section>

      {/* Lightweight Identity Table (`users` + `user_identities`) */}
      <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-4">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
            Core Users &amp; Linked Identities ({users.length})
          </h2>
          <span className="text-xs font-mono text-slate-500 dark:text-slate-400">
            tables: users · user_identities
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400 bg-slate-50/70 dark:bg-slate-900/40">
                <th className="py-3 px-5">User / Email</th>
                <th className="py-3 px-5">Linked Channels (user_identities)</th>
                <th className="py-3 px-5">Security Factors</th>
                <th className="py-3 px-5">Status</th>
                <th className="py-3 px-5 text-right">Session Control</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80 text-xs">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/30">
                  <td className="py-3.5 px-5 align-top">
                    <div className="font-medium text-sm text-slate-900 dark:text-white">{u.displayName}</div>
                    <div className="font-mono text-slate-600 dark:text-slate-400">{u.email}</div>
                    <div className="mt-0.5 text-[11px] font-mono text-slate-400">
                      {u.id} · {u.emailVerified ? 'email_verified' : 'unverified'}
                    </div>
                  </td>

                  <td className="py-3.5 px-5 align-top">
                    <div className="space-y-1 text-slate-700 dark:text-slate-300">
                      {u.identities.map((ident) => (
                        <div key={ident.id} className="flex items-center gap-2">
                          <span className="font-medium">{ident.providerLabel}</span>
                          <span className="text-slate-400">·</span>
                          <code className="font-mono text-[11px] text-slate-500">{ident.providerSub}</code>
                        </div>
                      ))}
                    </div>
                  </td>

                  <td className="py-3.5 px-5 align-top space-y-1 text-slate-600 dark:text-slate-400">
                    <div className="flex items-center gap-1.5">
                      <KeyRound className="w-3.5 h-3.5 text-slate-400" />
                      <span>Hash: {u.passwordAlgo}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <ShieldAlert className="w-3.5 h-3.5 text-slate-400" />
                      <span>TOTP 2FA: {u.totpEnabled ? 'Enabled' : 'Not enrolled'}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Fingerprint className="w-3.5 h-3.5 text-slate-400" />
                      <span className="tabular-nums">Passkeys: {u.passkeyCount}</span>
                    </div>
                  </td>

                  <td className="py-3.5 px-5 align-top">
                    <span
                      className={`font-medium ${
                        u.status === 'active'
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : 'text-red-600 dark:text-red-400'
                      }`}
                    >
                      {u.status === 'active' ? 'Active' : 'Banned (Revoked)'}
                    </span>
                  </td>

                  <td className="py-3.5 px-5 align-top text-right">
                    <button
                      type="button"
                      onClick={() => onToggleUserStatus(u.id, u.status === 'active' ? 'banned' : 'active')}
                      className={`px-3 py-1.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap transition-colors ${
                        u.status === 'active'
                          ? 'border border-red-200 dark:border-red-900/60 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40'
                          : 'border border-emerald-200 dark:border-emerald-900/60 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/40'
                      }`}
                    >
                      <Ban className="w-3.5 h-3.5" />
                      <span>{u.status === 'active' ? 'Ban & Push Webhook' : 'Restore Access'}</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Account Ban / Session Revocation Webhooks */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <section className="lg:col-span-6 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
          <div className="flex items-center gap-2">
            <Webhook className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
              Account Ban Webhooks (Downstream Session Kick)
            </h2>
          </div>

          <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
            {webhooks.map((wh) => (
              <div key={wh.id} className="py-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium text-slate-900 dark:text-white">{wh.name}</div>
                  <div className="font-mono text-slate-500 truncate">{wh.targetUrl}</div>
                  <div className="mt-0.5 text-[11px] font-mono text-slate-400">
                    events: {wh.events.join(', ')} · secret: {wh.secretMasked}
                  </div>
                </div>
                <button
                  type="button"
                  aria-label={`Delete webhook ${wh.name}`}
                  onClick={() => onDeleteWebhook(wh.id)}
                  className="p-1.5 text-slate-400 hover:text-red-600"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>

          <form onSubmit={handleAddWebhook} className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input
                type="text"
                required
                value={whName}
                onChange={(e) => setWhName(e.target.value)}
                placeholder="Downstream App Name"
                aria-label="Webhook Name"
                className="min-h-[38px] px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
              <input
                type="password"
                value={whSecret}
                onChange={(e) => setWhSecret(e.target.value)}
                placeholder="HMAC Secret (auto if blank)"
                aria-label="Webhook Signing Secret"
                className="min-h-[38px] px-3 py-1.5 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
            <div className="flex gap-2">
              <input
                type="url"
                required
                value={whUrl}
                onChange={(e) => setWhUrl(e.target.value)}
                placeholder="https://app.company.com/webhooks/oauth"
                aria-label="Webhook Target URL"
                className="flex-1 min-w-0 min-h-[38px] px-3 py-1.5 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
              <button
                type="submit"
                className="px-3.5 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs font-medium whitespace-nowrap"
              >
                Add Endpoint
              </button>
            </div>
            {whError && (
              <div role="alert" className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>{whError}</span>
              </div>
            )}
          </form>
        </section>

        {/* Signed Delivery Log */}
        <section className="lg:col-span-6 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
              Recent Signed Webhook Deliveries
            </h2>
            <span className="text-xs font-mono text-slate-500">X-Wimotek-Signature-256</span>
          </div>

          {webhookLogs.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400 py-8 text-center">
              Click <strong>Ban &amp; Push Webhook</strong> on any user above to dispatch a signed <code className="font-mono">user.banned</code> event.
            </p>
          ) : (
            <div className="space-y-3 max-h-72 overflow-y-auto">
              {webhookLogs.map((log) => (
                <div
                  key={log.id}
                  className="p-3 rounded-lg bg-slate-50 dark:bg-[#0B0F19] border border-slate-200 dark:border-slate-800 text-xs space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2 font-mono">
                    <span className="font-semibold text-red-600 dark:text-red-400">{log.event}</span>
                    <span className="text-slate-500">{log.userEmail}</span>
                  </div>
                  <div className="font-mono text-[11px] text-slate-500 truncate">POST {log.targetUrl}</div>
                  <div className="font-mono text-[11px] text-indigo-600 dark:text-indigo-400 truncate">
                    {log.signatureHeader}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
