import React, { useEffect, useState } from 'react';
import {
  Globe,
  KeyRound,
  Plus,
  Trash2,
  ShieldCheck,
  Sliders,
  Check,
  Infinity as InfinityIcon,
} from 'lucide-react';
import {
  api,
  type ACMEOverviewResponse,
  type ACMEPolicy,
  type OverviewData,
  type UserProfile,
} from '../lib/api';
import type { LocaleDict } from '../lib/i18n';
import { formatUnixUtc } from '../lib/pki-utils';
import { CodeBlock, CopyButton } from './CopyButton';

export const AcmeEabPanel: React.FC<{
  t: LocaleDict;
  overview: OverviewData | null;
  currentUser?: UserProfile | null;
}> = ({ t, overview, currentUser }) => {
  const [data, setData] = useState<ACMEOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [freshEab, setFreshEab] = useState<{ kid: string; hmac: string } | null>(null);
  const [clientTab, setClientTab] = useState<'acmesh' | 'certbot' | 'caddy' | 'k8s'>('acmesh');

  // Admin policy editor state
  const [policyDraft, setPolicyDraft] = useState<ACMEPolicy>({
    require_eab: true,
    default_ttl_days: 90,
    rate_limit_orders_per_hour: 50,
    rate_limit_req_per_min: 300,
    allow_wildcard: true,
    terms_url: '',
  });
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [policySaved, setPolicySaved] = useState(false);

  const isAdmin = currentUser?.role === 'admin';

  const load = () => {
    setLoading(true);
    api
      .getAcmeOverview(isAdmin)
      .then((res) => {
        setData(res);
        if (res.policy) setPolicyDraft(res.policy);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load ACME configuration');
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, [isAdmin]);

  const handleCreateEab = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setCreating(true);
    try {
      const res = await api.createAcmeEab(label.trim() || 'ACME EAB Credential');
      setFreshEab({ kid: res.eab_kid, hmac: res.eab_hmac });
      setLabel('');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create EAB credential');
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteEab = async (kid: string) => {
    setError('');
    try {
      await api.deleteAcmeEab(kid);
      if (freshEab?.kid === kid) setFreshEab(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke EAB credential');
    }
  };

  const handleSavePolicy = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setPolicySaved(false);
    setSavingPolicy(true);
    try {
      const res = await api.updateAcmePolicy(policyDraft);
      setPolicyDraft(res.policy);
      setPolicySaved(true);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save ACME policy');
    } finally {
      setSavingPolicy(false);
    }
  };

  const baseUrl = (overview?.base_url || window.location.origin).replace(/\/+$/, '');
  const directoryUrl = data?.directory_url || `${baseUrl}/acme/directory`;
  const sampleKid = freshEab?.kid || data?.credentials?.[0]?.kid || 'eab_YOUR_EAB_KID';
  const sampleHmac = freshEab?.hmac || 'YOUR_EAB_HMAC_KEY_BASE64URL';
  const sampleEmail = currentUser?.email || 'ops@example.com';

  const acmeShSnippet = `# 1. Register ACME account bound to your Wimotek account via EAB (once per server)
acme.sh --register-account \\
  --server ${directoryUrl} \\
  --eab-kid "${sampleKid}" \\
  --eab-hmac-key "${sampleHmac}" \\
  -m "${sampleEmail}"

# 2a. Issue public TLS certificate via HTTP-01 (unlimited ACME quota)
acme.sh --issue \\
  --server ${directoryUrl} \\
  -d app.example.com -d www.example.com \\
  --webroot /var/www/html

# 2b. Issue wildcard certificate (*.example.com) via DNS-01
acme.sh --issue \\
  --server ${directoryUrl} \\
  -d example.com -d '*.example.com' \\
  --dns dns_cf`;

  const certbotSnippet = `# Certbot with External Account Binding (RFC 8555 §7.3.4 — ZeroSSL compatible)
certbot certonly --nginx \\
  --server ${directoryUrl} \\
  --eab-kid "${sampleKid}" \\
  --eab-hmac-key "${sampleHmac}" \\
  --email "${sampleEmail}" \\
  --agree-tos --no-eff-email \\
  -d app.example.com

# Wildcard via DNS-01 (manual or DNS provider plugin):
certbot certonly --manual --preferred-challenges dns \\
  --server ${directoryUrl} \\
  --eab-kid "${sampleKid}" \\
  --eab-hmac-key "${sampleHmac}" \\
  -d '*.example.com' -d example.com`;

  const caddySnippet = `# Caddyfile — Public ACME v2 with EAB Account Binding
{
  email ${sampleEmail}
  acme_ca ${directoryUrl}
  acme_eab {
    key_id ${sampleKid}
    mac_key ${sampleHmac}
  }
  # Optional when using private Root CA in managed enterprise fleets:
  # acme_ca_root /etc/ssl/certs/wimotek-root.crt
}

app.example.com {
  reverse_proxy 127.0.0.1:8080
}`;

  const k8sCertManagerSnippet = `# 1. Store your EAB HMAC key as a Kubernetes Secret
kubectl create secret generic wimotek-acme-eab \\
  --namespace cert-manager \\
  --from-literal=secret="${sampleHmac}"

# 2. Configure ClusterIssuer (supports unlimited automated ingress certs)
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: wimotek-acme-commercial
spec:
  acme:
    email: ${sampleEmail}
    server: ${directoryUrl}
    externalAccountBinding:
      keyID: ${sampleKid}
      keySecretRef:
        name: wimotek-acme-eab
        key: secret
    privateKeySecretRef:
      name: wimotek-acme-account-key
    solvers:
      - http01:
          ingress:
            ingressClassName: nginx`;

  const manualQuotaLabel =
    data == null
      ? '—'
      : data.manual_quota < 0
      ? `${data.manual_active_certs} / ${t.profile.unlimited}`
      : `${data.manual_active_certs} / ${data.manual_quota}`;

  const formatIdentifiers = (raw: string): string => {
    try {
      const list = JSON.parse(raw) as Array<{ value?: string }>;
      return list.map((i) => i.value || '').filter(Boolean).join(', ') || '—';
    } catch {
      return raw || '—';
    }
  };

  return (
    <div className="space-y-6">
      {/* Header + Directory URL + ZeroSSL-Style Quota Separation Metrics */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="space-y-1">
          <h3 className="font-display text-base font-semibold text-slate-900">
            {t.automation.acmeTitle}
          </h3>
          <p className="text-xs text-slate-600 leading-relaxed wrap-anywhere">
            {t.automation.acmeSubtitle}
          </p>
        </div>

        {/* Public Directory URL */}
        <div className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] font-medium text-slate-500 flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5 text-teal-700" aria-hidden="true" />
              <span>{t.automation.acmeDirectoryLabel}</span>
            </div>
            <code dir="ltr" className="block font-mono text-xs text-slate-900 mt-1 break-all">
              {directoryUrl}
            </code>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <CopyButton value={directoryUrl} label={t.common.copy} copiedLabel={t.common.copied} />
          </div>
        </div>

        {/* Commercial Quota Separation Metric Strip */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="border border-slate-200 rounded-lg p-3.5 bg-white">
            <div className="text-[11px] font-medium text-slate-500">{t.automation.acmeManualQuota}</div>
            <div className="mt-1 font-display text-lg font-bold text-slate-900 tabular-nums">
              {manualQuotaLabel}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              Web Console &amp; REST manual issuance
            </div>
          </div>

          <div className="border border-teal-200 bg-teal-50/40 rounded-lg p-3.5">
            <div className="text-[11px] font-medium text-teal-800 flex items-center gap-1.5">
              <InfinityIcon className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{t.automation.acmeUnlimitedLabel}</span>
            </div>
            <div className="mt-1 font-display text-lg font-bold text-teal-900 tabular-nums">
              {data ? `${data.acme_active_certs} ${t.automation.acmeActiveIssued}` : '—'}
            </div>
            <div className="text-[11px] text-teal-800/80 mt-0.5">
              HTTP-01 &amp; DNS-01 · {data?.policy?.default_ttl_days ?? 90}d TTL
            </div>
          </div>

          <div className="border border-slate-200 rounded-lg p-3.5 bg-white">
            <div className="text-[11px] font-medium text-slate-500">
              {t.automation.acmeRateLimitLabel}
            </div>
            <div className="mt-1 font-display text-lg font-bold text-slate-900 tabular-nums">
              {data ? `${data.policy.rate_limit_orders_per_hour}/hr` : '—'}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              {data?.policy?.require_eab ? 'EAB Required (ZeroSSL Mode)' : 'Open ACME Registration'} ·{' '}
              {data?.policy?.rate_limit_req_per_min ?? 300} req/min/IP
            </div>
          </div>
        </div>
      </div>

      {/* EAB Credentials Manager */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-display text-base font-semibold text-slate-900 flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-teal-700" aria-hidden="true" />
              <span>{t.automation.acmeEabTitle}</span>
            </h3>
          </div>
        </div>

        <form
          onSubmit={handleCreateEab}
          className="flex flex-col sm:flex-row items-stretch sm:items-end gap-3 bg-slate-50/70 border border-slate-200 rounded-xl p-4"
        >
          <div className="flex-1">
            <label htmlFor="eab-label" className="block text-xs font-medium text-slate-700 mb-1">
              {t.automation.acmeEabLabel}
            </label>
            <input
              id="eab-label"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t.automation.acmeEabPlaceholder}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-teal-600 focus:outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={creating}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-[#0F766E] hover:bg-[#115E59] disabled:opacity-60 text-white text-xs font-medium cursor-pointer whitespace-nowrap h-[38px]"
          >
            <Plus className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{t.automation.acmeCreateEab}</span>
          </button>
        </form>

        {error && (
          <div
            role="alert"
            className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3.5 py-2.5"
          >
            {error}
          </div>
        )}

        {freshEab && (
          <div className="bg-teal-50/70 border border-teal-200 rounded-xl p-4 space-y-3 text-xs">
            <div className="font-semibold text-teal-900">{t.automation.acmeEabNotice}</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="bg-white border border-teal-200 rounded-lg px-3 py-2 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    EAB KID
                  </div>
                  <code dir="ltr" className="block font-mono text-slate-900 break-all mt-0.5">
                    {freshEab.kid}
                  </code>
                </div>
                <CopyButton
                  compact
                  value={freshEab.kid}
                  label={t.common.copy}
                  copiedLabel={t.common.copied}
                />
              </div>
              <div className="bg-white border border-teal-200 rounded-lg px-3 py-2 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    EAB HMAC Key (Base64URL)
                  </div>
                  <code dir="ltr" className="block font-mono text-slate-900 break-all mt-0.5">
                    {freshEab.hmac}
                  </code>
                </div>
                <CopyButton
                  compact
                  value={freshEab.hmac}
                  label={t.common.copy}
                  copiedLabel={t.common.copied}
                />
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <div className="h-16 bg-slate-100 rounded-lg animate-pulse" />
        ) : !data || data.credentials.length === 0 ? (
          <p className="text-xs text-slate-500">{t.automation.acmeEabEmpty}</p>
        ) : (
          <div className="overflow-x-auto border-t border-slate-100 pt-2">
            <table className="w-full text-xs text-start">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-2.5 pe-3 font-medium text-start">{t.automation.acmeEabLabel}</th>
                  <th className="py-2.5 pe-3 font-medium text-start">EAB KID</th>
                  <th className="py-2.5 pe-3 font-medium text-start">HMAC Prefix</th>
                  {isAdmin && <th className="py-2.5 pe-3 font-medium text-start">{t.automation.owner}</th>}
                  <th className="py-2.5 pe-3 font-medium text-start">Bound ACME Clients</th>
                  <th className="py-2.5 font-medium text-end">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.credentials.map((cred) => (
                  <tr key={cred.kid} className="hover:bg-slate-50/70">
                    <td className="py-3 pe-3 font-medium text-slate-900">{cred.label}</td>
                    <td className="py-3 pe-3 font-mono text-slate-700 whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5">
                        <span>{cred.kid}</span>
                        <CopyButton
                          compact
                          value={cred.kid}
                          ariaLabel={t.common.copy}
                          copiedLabel={t.common.copied}
                        />
                      </span>
                    </td>
                    <td className="py-3 pe-3 font-mono text-slate-500 whitespace-nowrap">
                      {cred.hmac_prefix}
                    </td>
                    {isAdmin && (
                      <td className="py-3 pe-3 text-slate-700 whitespace-nowrap">
                        {cred.owner_username}
                      </td>
                    )}
                    <td className="py-3 pe-3 font-mono text-[11px] text-slate-600 whitespace-nowrap tabular-nums">
                      {cred.bound_count} bound ·{' '}
                      {cred.last_used_at ? formatUnixUtc(cred.last_used_at) : 'Never'}
                    </td>
                    <td className="py-3 text-end whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => handleDeleteEab(cred.kid)}
                        className="inline-flex items-center gap-1 text-red-700 hover:text-red-900 font-medium cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>{t.automation.deleteToken}</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Ready-to-Run ACME Client Commands */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-display text-base font-semibold text-slate-900">
            {t.automation.acmeClientsTitle}
          </h3>
          <div className="flex flex-wrap gap-1 border border-slate-200 rounded-lg p-0.5 bg-slate-50 text-xs">
            {(
              [
                ['acmesh', 'acme.sh'],
                ['certbot', 'Certbot'],
                ['caddy', 'Caddy'],
                ['k8s', 'K8s cert-manager'],
              ] as const
            ).map(([key, lbl]) => (
              <button
                key={key}
                type="button"
                onClick={() => setClientTab(key)}
                className={`px-3 py-1.5 rounded-md font-medium transition-colors cursor-pointer ${
                  clientTab === key
                    ? 'bg-white text-[#0F766E] shadow-xs border border-slate-200/80'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>

        {clientTab === 'acmesh' && (
          <CodeBlock
            title="acme.sh — EAB Account Binding + HTTP-01 & Wildcard DNS-01"
            code={acmeShSnippet}
            copyLabel={t.common.copy}
            copiedLabel={t.common.copied}
          />
        )}
        {clientTab === 'certbot' && (
          <CodeBlock
            title="Certbot — RFC 8555 ACME v2 with External Account Binding"
            code={certbotSnippet}
            copyLabel={t.common.copy}
            copiedLabel={t.common.copied}
          />
        )}
        {clientTab === 'caddy' && (
          <CodeBlock
            title="Caddy — Zero-Touch Automatic HTTPS (acme_ca + acme_eab)"
            code={caddySnippet}
            copyLabel={t.common.copy}
            copiedLabel={t.common.copied}
          />
        )}
        {clientTab === 'k8s' && (
          <CodeBlock
            title="Kubernetes cert-manager — ClusterIssuer with EAB"
            code={k8sCertManagerSnippet}
            copyLabel={t.common.copy}
            copiedLabel={t.common.copied}
          />
        )}
      </div>

      {/* Bound ACME Accounts & Recent Orders */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
          <h3 className="font-display text-sm font-semibold text-slate-900 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-teal-700" aria-hidden="true" />
            <span>{t.automation.acmeAccountsTitle} ({data?.accounts?.length || 0})</span>
          </h3>
          {!data || data.accounts.length === 0 ? (
            <p className="text-xs text-slate-500">
              No ACME client accounts registered yet. Run acme.sh or Certbot with your EAB KID to register.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-start">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="py-2 pe-2 font-medium text-start">Account ID / EAB</th>
                    <th className="py-2 pe-2 font-medium text-start">JWK Thumbprint</th>
                    <th className="py-2 font-medium text-end">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.accounts.map((a) => (
                    <tr key={a.id}>
                      <td className="py-2.5 pe-2">
                        <div className="font-mono text-slate-900">{a.id}</div>
                        <div className="text-[11px] text-slate-500 font-mono">
                          {a.owner_username} · {a.eab_kid || 'open'}
                        </div>
                      </td>
                      <td className="py-2.5 pe-2 font-mono text-[11px] text-slate-600">
                        {a.jwk_thumbprint.slice(0, 16)}…
                      </td>
                      <td className="py-2.5 text-end font-mono text-[11px] text-emerald-700">
                        {a.status}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
          <h3 className="font-display text-sm font-semibold text-slate-900">
            Recent ACME Orders ({data?.orders?.length || 0})
          </h3>
          {!data || data.orders.length === 0 ? (
            <p className="text-xs text-slate-500">No ACME orders submitted yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-start">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="py-2 pe-2 font-medium text-start">Domains</th>
                    <th className="py-2 pe-2 font-medium text-start">Status</th>
                    <th className="py-2 font-medium text-end">Cert Serial</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.orders.map((o) => (
                    <tr key={o.id}>
                      <td className="py-2.5 pe-2">
                        <div className="font-mono text-slate-900 break-all">
                          {formatIdentifiers(o.identifiers_json)}
                        </div>
                        <div className="text-[10px] text-slate-500 font-mono">
                          {o.owner_username} · {formatUnixUtc(o.created_at)}
                        </div>
                      </td>
                      <td className="py-2.5 pe-2 font-mono text-[11px]">
                        <span
                          className={
                            o.status === 'valid'
                              ? 'text-emerald-700 font-semibold'
                              : o.status === 'invalid'
                              ? 'text-red-700 font-semibold'
                              : 'text-amber-700'
                          }
                        >
                          {o.status}
                        </span>
                      </td>
                      <td className="py-2.5 text-end font-mono text-[11px] text-slate-600 whitespace-nowrap">
                        {o.cert_serial ? (
                          <span className="inline-flex items-center gap-1">
                            <span>{o.cert_serial.slice(0, 12)}…</span>
                            <CopyButton
                              compact
                              value={o.cert_serial}
                              ariaLabel={t.common.copy}
                              copiedLabel={t.common.copied}
                            />
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Admin Commercial ACME Policy Controls */}
      {isAdmin && (
        <form
          onSubmit={handleSavePolicy}
          className="bg-white border border-slate-200 rounded-xl p-6 space-y-4"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-display text-base font-semibold text-slate-900 flex items-center gap-2">
              <Sliders className="w-4 h-4 text-teal-700" aria-hidden="true" />
              <span>{t.automation.acmePolicyTitle}</span>
            </h3>
            {policySaved && (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
                <Check className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{t.automation.acmePolicySaved}</span>
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            <label className="flex items-center gap-2.5 p-3 rounded-lg border border-slate-200 bg-slate-50/70 cursor-pointer">
              <input
                type="checkbox"
                checked={policyDraft.require_eab}
                onChange={(e) =>
                  setPolicyDraft((prev) => ({ ...prev, require_eab: e.target.checked }))
                }
                className="rounded border-slate-300 text-teal-700 focus:ring-teal-600"
              />
              <span className="font-medium text-slate-800">{t.automation.acmePolicyRequireEab}</span>
            </label>

            <label className="flex items-center gap-2.5 p-3 rounded-lg border border-slate-200 bg-slate-50/70 cursor-pointer">
              <input
                type="checkbox"
                checked={policyDraft.allow_wildcard}
                onChange={(e) =>
                  setPolicyDraft((prev) => ({ ...prev, allow_wildcard: e.target.checked }))
                }
                className="rounded border-slate-300 text-teal-700 focus:ring-teal-600"
              />
              <span className="font-medium text-slate-800">
                {t.automation.acmePolicyAllowWildcard}
              </span>
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label htmlFor="acme-ttl" className="block text-xs font-medium text-slate-700 mb-1">
                {t.automation.acmePolicyTtl}
              </label>
              <input
                id="acme-ttl"
                type="number"
                min={1}
                max={365}
                value={policyDraft.default_ttl_days}
                onChange={(e) =>
                  setPolicyDraft((prev) => ({
                    ...prev,
                    default_ttl_days: Number(e.target.value) || 90,
                  }))
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono tabular-nums text-slate-900"
              />
            </div>

            <div>
              <label
                htmlFor="acme-hourly"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                {t.automation.acmePolicyHourlyLimit}
              </label>
              <input
                id="acme-hourly"
                type="number"
                min={1}
                max={10000}
                value={policyDraft.rate_limit_orders_per_hour}
                onChange={(e) =>
                  setPolicyDraft((prev) => ({
                    ...prev,
                    rate_limit_orders_per_hour: Number(e.target.value) || 50,
                  }))
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono tabular-nums text-slate-900"
              />
            </div>

            <div>
              <label htmlFor="acme-rpm" className="block text-xs font-medium text-slate-700 mb-1">
                {t.automation.acmePolicyIpRpm}
              </label>
              <input
                id="acme-rpm"
                type="number"
                min={10}
                max={10000}
                value={policyDraft.rate_limit_req_per_min}
                onChange={(e) =>
                  setPolicyDraft((prev) => ({
                    ...prev,
                    rate_limit_req_per_min: Number(e.target.value) || 300,
                  }))
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono tabular-nums text-slate-900"
              />
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={savingPolicy}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#0F766E] hover:bg-[#115E59] disabled:opacity-60 text-white text-xs font-medium cursor-pointer"
            >
              <span>{t.automation.acmePolicySave}</span>
            </button>
          </div>
        </form>
      )}
    </div>
  );
};
