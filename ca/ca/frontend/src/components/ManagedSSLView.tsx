import React, { useCallback, useEffect, useState } from 'react';
import {
  RefreshCw,
  Plus,
  Trash2,
  Send,
  KeyRound,
  Activity,
  X,
  Download,
  Globe,
  ShieldCheck,
} from 'lucide-react';
import {
  api,
  type DnsProviderType,
  type ManagedCertificateRecord,
  type ManagedChallengeMethod,
  type ManagedEngineMode,
  type ManagedOverviewResponse,
  type ManagedProxyPolicy,
  type ManagedUpstreamRecord,
  type UpstreamProviderType,
  type UserProfile,
} from '../lib/api';
import type { LocaleDict } from '../lib/i18n';
import { formatUnixUtc } from '../lib/pki-utils';
import { triggerBlobDownload } from '../lib/download';
import { CodeBlock, CopyButton } from './CopyButton';
import { FloatingToast } from './Toast';

type SubTab = 'certs' | 'upstreams' | 'dns' | 'logs';

const UPSTREAM_PRESETS: Record<
  UpstreamProviderType,
  { name: string; directory_url: string; requires_eab: boolean }
> = {
  letsencrypt_prod: {
    name: "Let's Encrypt (Production)",
    directory_url: 'https://acme-v02.api.letsencrypt.org/directory',
    requires_eab: false,
  },
  google_trust: {
    name: 'Google Trust Services (GTS)',
    directory_url: 'https://dv.acme-v02.api.pki.goog/directory',
    requires_eab: true,
  },
  zerossl: {
    name: 'ZeroSSL (ACME v2 DV90)',
    directory_url: 'https://acme.zerossl.com/v2/DV90',
    requires_eab: true,
  },
  letsencrypt_staging: {
    name: "Let's Encrypt (Staging / Sandbox)",
    directory_url: 'https://acme-staging-v02.api.letsencrypt.org/directory',
    requires_eab: false,
  },
  custom: {
    name: '',
    directory_url: '',
    requires_eab: false,
  },
};

export const ManagedSSLView: React.FC<{
  t: LocaleDict;
  currentUser?: UserProfile | null;
}> = ({ t, currentUser }) => {
  const m = t.managed;
  const isAdmin = !currentUser || currentUser.role === 'admin';

  const [subTab, setSubTab] = useState<SubTab>('certs');
  const [data, setData] = useState<ManagedOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState('');

  // New managed cert form
  const [domainsInput, setDomainsInput] = useState('');
  const [engineMode, setEngineMode] = useState<ManagedEngineMode>('upstream_public');
  const [upstreamId, setUpstreamId] = useState('auto');
  const [challengeMethod, setChallengeMethod] = useState<ManagedChallengeMethod>('cname_delegation');
  const [dnsCredentialId, setDnsCredentialId] = useState('');
  const [renewBeforeDays, setRenewBeforeDays] = useState(30);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [creatingCert, setCreatingCert] = useState(false);

  // DNS check results map per cert ID
  const [dnsCheckMap, setDnsCheckMap] = useState<
    Record<string, { all_matched: boolean; checks: Array<{ domain: string; host: string; expected: string; observed: string[]; matched: boolean }> }>
  >({});

  // Bundle preview modal
  const [bundleModal, setBundleModal] = useState<{
    common_name: string;
    serial_hex: string;
    chain_pem: string;
    private_key_pem: string;
  } | null>(null);

  // Upstream CA modal & form (admin)
  const [upstreamModalOpen, setUpstreamModalOpen] = useState(false);
  const [upEditId, setUpEditId] = useState('');
  const [upProvider, setUpProvider] = useState<UpstreamProviderType>('google_trust');
  const [upName, setUpName] = useState(UPSTREAM_PRESETS.google_trust.name);
  const [upDirUrl, setUpDirUrl] = useState(UPSTREAM_PRESETS.google_trust.directory_url);
  const [upPriority, setUpPriority] = useState(2);
  const [upEmail, setUpEmail] = useState('');
  const [upRequiresEab, setUpRequiresEab] = useState(true);
  const [upEabKid, setUpEabKid] = useState('');
  const [upEabHmac, setUpEabHmac] = useState('');
  const [upEnabled, setUpEnabled] = useState(true);
  const [savingUp, setSavingUp] = useState(false);

  // DNS credential form
  const [dnsName, setDnsName] = useState('');
  const [dnsProvider, setDnsProvider] = useState<DnsProviderType>('cloudflare');
  const [dnsZoneHint, setDnsZoneHint] = useState('');
  const [dnsToken, setDnsToken] = useState('');
  const [dnsSecret, setDnsSecret] = useState('');
  const [savingDns, setSavingDns] = useState(false);

  // Policy draft (admin)
  const [policyDraft, setPolicyDraft] = useState<ManagedProxyPolicy>({
    mode: 'dual_engine',
    auto_failover: true,
    default_renew_before_days: 30,
    cname_delegation_zone: '',
  });
  const [savingPolicy, setSavingPolicy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api
      .getManagedOverview(isAdmin)
      .then((res) => {
        setData(res);
        setPolicyDraft(res.proxy_policy);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load managed SSL overview');
      })
      .finally(() => setLoading(false));
  }, [isAdmin]);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreateCert = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    const domains = domainsInput
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (domains.length === 0) return;
    setCreatingCert(true);
    try {
      const res = await api.createManagedCert({
        domains,
        engine_mode: engineMode,
        upstream_id: upstreamId,
        challenge_method: challengeMethod,
        dns_credential_id: dnsCredentialId,
        auto_renew: true,
        renew_before_days: renewBeforeDays,
        deploy_webhook_url: webhookUrl.trim() || undefined,
        deploy_webhook_secret: webhookSecret.trim() || undefined,
      });
      setDomainsInput('');
      setWebhookUrl('');
      setWebhookSecret('');
      setNotice(`${res.certificate.common_name} (${res.certificate.status})`);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create managed certificate');
    } finally {
      setCreatingCert(false);
    }
  };

  const handleCheckDns = async (cert: ManagedCertificateRecord) => {
    setBusyId(`dns:${cert.id}`);
    setError('');
    try {
      const res = await api.checkManagedCertDns(cert.id);
      setDnsCheckMap((prev) => ({ ...prev, [cert.id]: res }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'DNS check failed');
    } finally {
      setBusyId('');
    }
  };

  const handleVerifyOrRenew = async (cert: ManagedCertificateRecord, isRenew: boolean) => {
    setBusyId(`${isRenew ? 'renew' : 'verify'}:${cert.id}`);
    setError('');
    setNotice('');
    try {
      const res = isRenew ? await api.renewManagedCert(cert.id) : await api.verifyManagedCert(cert.id);
      setNotice(`${res.certificate.common_name}: ${res.certificate.status} ${res.certificate.serial_hex || ''}`);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Issuance/renewal failed');
      load();
    } finally {
      setBusyId('');
    }
  };

  const handleDeploy = async (cert: ManagedCertificateRecord) => {
    setBusyId(`deploy:${cert.id}`);
    setError('');
    setNotice('');
    try {
      const res = await api.deployManagedCert(cert.id);
      setNotice(`${cert.common_name}: ${res.detail}`);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deploy webhook failed');
    } finally {
      setBusyId('');
    }
  };

  const handleOpenBundle = async (cert: ManagedCertificateRecord) => {
    setBusyId(`bundle:${cert.id}`);
    setError('');
    try {
      const res = await api.downloadManagedBundle(cert.id);
      setBundleModal({
        common_name: res.common_name,
        serial_hex: res.serial_hex,
        chain_pem: res.chain_pem,
        private_key_pem: res.private_key_pem,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load certificate bundle');
    } finally {
      setBusyId('');
    }
  };

  const handleDeleteCert = async (id: string) => {
    setBusyId(`del:${id}`);
    setError('');
    try {
      await api.deleteManagedCert(id);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusyId('');
    }
  };

  const handleScanRenew = async () => {
    setBusyId('scan');
    setError('');
    setNotice('');
    try {
      const res = await api.scanRenewManagedCerts();
      setNotice(`Scanned ${res.scanned} · Due ${res.due} · Renewed ${res.renewed.length}`);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setBusyId('');
    }
  };

  const handleProbeUpstream = async (up: ManagedUpstreamRecord) => {
    setBusyId(`probe:${up.id}`);
    setError('');
    setNotice('');
    try {
      const res = await api.probeManagedUpstream(up.id);
      setNotice(`${up.name}: HTTP 200 (${res.latency_ms} ms)`);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Probe failed');
      load();
    } finally {
      setBusyId('');
    }
  };

  useEffect(() => {
    if (!upstreamModalOpen) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setUpstreamModalOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [upstreamModalOpen]);

  const openAddUpstreamModal = () => {
    const nextPriority = (data?.upstreams?.length || 0) + 1;
    setUpEditId('');
    setUpProvider('google_trust');
    setUpName(UPSTREAM_PRESETS.google_trust.name);
    setUpDirUrl(UPSTREAM_PRESETS.google_trust.directory_url);
    setUpPriority(nextPriority);
    setUpEmail('');
    setUpRequiresEab(UPSTREAM_PRESETS.google_trust.requires_eab);
    setUpEabKid('');
    setUpEabHmac('');
    setUpEnabled(true);
    setUpstreamModalOpen(true);
  };

  const handleEditUpstream = (up: ManagedUpstreamRecord) => {
    setUpEditId(up.id);
    setUpProvider(up.provider);
    setUpName(up.name);
    setUpDirUrl(up.directory_url);
    setUpPriority(up.priority);
    setUpEmail(up.contact_email);
    setUpRequiresEab(up.requires_eab);
    setUpEabKid(up.eab_kid);
    setUpEabHmac('');
    setUpEnabled(up.enabled);
    setUpstreamModalOpen(true);
  };

  const handleSaveUpstream = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingUp(true);
    setError('');
    setNotice('');
    try {
      await api.saveManagedUpstream({
        id: upEditId || undefined,
        name: upName.trim(),
        provider: upProvider,
        directory_url: upDirUrl.trim(),
        requires_eab: upRequiresEab,
        eab_kid: upEabKid.trim(),
        eab_hmac: upEabHmac.trim() || undefined,
        contact_email: upEmail.trim(),
        priority: upPriority,
        enabled: upEnabled,
      });
      setUpEditId('');
      setUpEabHmac('');
      setUpstreamModalOpen(false);
      setNotice(`${upName.trim()} saved`);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save upstream CA');
    } finally {
      setSavingUp(false);
    }
  };

  const handleDeleteUpstream = async (id: string) => {
    setBusyId(`delup:${id}`);
    setError('');
    try {
      await api.deleteManagedUpstream(id);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusyId('');
    }
  };

  const handleCreateDnsCred = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingDns(true);
    setError('');
    try {
      await api.createManagedDnsCred({
        name: dnsName.trim(),
        provider: dnsProvider,
        zone_hint: dnsZoneHint.trim(),
        api_token: dnsProvider === 'cloudflare' || dnsProvider === 'webhook' ? dnsToken.trim() : undefined,
        access_key_id: dnsProvider === 'aliyun' || dnsProvider === 'dnspod' ? dnsToken.trim() : undefined,
        access_key_secret: dnsSecret.trim() || undefined,
      });
      setDnsName('');
      setDnsZoneHint('');
      setDnsToken('');
      setDnsSecret('');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save DNS credential');
    } finally {
      setSavingDns(false);
    }
  };

  const handleDeleteDnsCred = async (id: string) => {
    setError('');
    try {
      await api.deleteManagedDnsCred(id);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const handleSavePolicy = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingPolicy(true);
    setError('');
    setNotice('');
    try {
      await api.updateManagedPolicy(policyDraft);
      setNotice(m.savePolicyBtn);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save policy');
    } finally {
      setSavingPolicy(false);
    }
  };

  const downloadTextFile = (filename: string, content: string) => {
    const blob = new Blob([content], { type: 'application/x-pem-file' });
    triggerBlobDownload(blob, filename);
  };

  const stats = data?.stats || {
    total_certs: 0,
    active_certs: 0,
    pending_certs: 0,
    due_renewal: 0,
    enabled_upstreams: 0,
  };
  const managedCerts = data?.certificates ?? [];
  const upstreams = data?.upstreams ?? [];
  const dnsCredentials = data?.dns_credentials ?? [];
  const deployLogs = data?.deploy_logs ?? [];

  return (
    <div className="space-y-6">
      {/* Header & Top Metrics Strip */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
          <div className="space-y-1.5 max-w-3xl">
            <h2 className="font-display text-xl font-bold text-slate-900">{m.title}</h2>
            <p className="text-sm text-slate-600 leading-relaxed">{m.subtitle}</p>
          </div>
          {isAdmin && (
            <button
              type="button"
              onClick={handleScanRenew}
              disabled={busyId === 'scan'}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-60 transition-colors cursor-pointer shrink-0"
            >
              <RefreshCw className={`w-4 h-4 ${busyId === 'scan' ? 'animate-spin' : ''}`} />
              <span>{m.scanRenew}</span>
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 pt-4 border-t border-slate-100">
          <div>
            <div className="text-xs text-slate-500">{m.statActive}</div>
            <div className="mt-1 font-mono tabular-nums text-2xl font-bold text-slate-900">
              {stats.active_certs}
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-500">{m.statPending}</div>
            <div className="mt-1 font-mono tabular-nums text-2xl font-bold text-amber-700">
              {stats.pending_certs}
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-500">{m.statDue}</div>
            <div className="mt-1 font-mono tabular-nums text-2xl font-bold text-slate-900">
              {stats.due_renewal}
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-500">{m.statUpstreams}</div>
            <div className="mt-1 font-mono tabular-nums text-2xl font-bold text-teal-700">
              {stats.enabled_upstreams}
            </div>
          </div>
        </div>
      </div>

      {/* Segmented Navigation */}
      <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 rounded-xl w-fit">
        {(
          [
            ['certs', m.tabCerts],
            ['upstreams', m.tabUpstreams],
            ['dns', m.tabDns],
            ['logs', m.tabLogs],
          ] as Array<[SubTab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setSubTab(key)}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors cursor-pointer ${
              subTab === key
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <FloatingToast
        error={error}
        notice={notice}
        onDismissError={() => setError('')}
        onDismissNotice={() => setNotice('')}
      />

      {/* TAB 1: Managed Certificates */}
      {subTab === 'certs' && (
        <div className="space-y-6">
          {/* Create Managed Certificate Form */}
          <form
            onSubmit={handleCreateCert}
            className="bg-white border border-slate-200 rounded-xl p-6 space-y-5"
          >
            <div className="flex items-center justify-between gap-4">
              <h3 className="font-display text-base font-bold text-slate-900">{m.newCertTitle}</h3>
              <span className="text-xs text-slate-500 font-mono">
                {data?.proxy_policy.cname_delegation_zone}
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  {m.domainsLabel}
                </label>
                <input
                  type="text"
                  required
                  value={domainsInput}
                  onChange={(e) => setDomainsInput(e.target.value)}
                  placeholder={m.domainsPlaceholder}
                  className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  {m.engineLabel}
                </label>
                <select
                  value={engineMode}
                  onChange={(e) => setEngineMode(e.target.value as ManagedEngineMode)}
                  className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-teal-500"
                >
                  <option value="upstream_public">{m.engineUpstream}</option>
                  <option value="private_ca">{m.enginePrivate}</option>
                </select>
              </div>

              {engineMode === 'upstream_public' && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    {m.upstreamLabel}
                  </label>
                  <select
                    value={upstreamId}
                    onChange={(e) => setUpstreamId(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-teal-500"
                  >
                    <option value="auto">{m.upstreamAuto}</option>
                    {(data?.upstreams || []).map((u) => (
                      <option key={u.id} value={u.id}>
                        P{u.priority} · {u.name} {u.enabled ? '' : '(Disabled)'}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  {m.methodLabel}
                </label>
                <select
                  value={challengeMethod}
                  onChange={(e) => setChallengeMethod(e.target.value as ManagedChallengeMethod)}
                  className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-teal-500"
                >
                  <option value="cname_delegation">{m.methodCname}</option>
                  <option value="dns_manual">{m.methodDnsManual}</option>
                  <option value="dns_api">{m.methodDnsApi}</option>
                  <option value="http_01">{m.methodHttp}</option>
                </select>
              </div>

              {challengeMethod === 'dns_api' && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    {m.dnsCredsTitle}
                  </label>
                  <select
                    value={dnsCredentialId}
                    onChange={(e) => setDnsCredentialId(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-teal-500"
                  >
                    <option value="">-- Select DNS API Credential --</option>
                    {(data?.dns_credentials || []).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.provider})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  {m.renewDaysLabel}
                </label>
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={renewBeforeDays}
                  onChange={(e) => setRenewBeforeDays(Number(e.target.value) || 30)}
                  className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 text-sm font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  {m.webhookUrlLabel}
                </label>
                <input
                  type="url"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder="https://deploy.example.com/hooks/ssl"
                  className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  {m.webhookSecretLabel}
                </label>
                <input
                  type="password"
                  value={webhookSecret}
                  onChange={(e) => setWebhookSecret(e.target.value)}
                  placeholder="Optional HMAC-SHA256 signing secret"
                  className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={creatingCert}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-teal-600 text-white text-sm font-medium hover:bg-teal-700 disabled:opacity-60 transition-colors cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>{m.createCertBtn}</span>
              </button>
            </div>
          </form>

          {/* Managed Certificates List */}
          <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-200">
            {loading && !data ? (
              <div className="p-8 text-center text-sm text-slate-500">Loading...</div>
            ) : managedCerts.length === 0 ? (
              <div className="p-10 text-center text-sm text-slate-500">{m.emptyCerts}</div>
            ) : (
              managedCerts.map((cert) => {
                const dnsResult = dnsCheckMap[cert.id];
                const daysLeft =
                  cert.not_after > 0
                    ? Math.max(0, Math.floor((cert.not_after - Date.now() / 1000) / 86400))
                    : null;
                return (
                  <div key={cert.id} className="p-6 space-y-4">
                    <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
                      <div className="space-y-1.5 min-w-0">
                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                          <h4 className="font-mono text-base font-semibold text-slate-900 break-all">
                            {cert.common_name}
                          </h4>
                          <span
                            className={`text-xs font-semibold ${
                              cert.status === 'active'
                                ? 'text-emerald-700'
                                : cert.status === 'pending_validation'
                                ? 'text-amber-700'
                                : 'text-rose-700'
                            }`}
                          >
                            {cert.status}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                          <span>{cert.resolved_issuer_name || cert.engine_mode}</span>
                          <span aria-hidden="true">·</span>
                          <span>{cert.challenge_method}</span>
                          <span aria-hidden="true">·</span>
                          <span>SANs: {cert.domains.join(', ')}</span>
                          {cert.serial_hex && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono">{cert.serial_hex}</span>
                            </>
                          )}
                          {daysLeft !== null && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono tabular-nums">
                                {daysLeft}d left (auto-renew ≤ {cert.renew_before_days}d)
                              </span>
                            </>
                          )}
                        </div>
                        {cert.deploy_webhook_url && (
                          <div className="text-xs text-slate-500 font-mono truncate">
                            Webhook: {cert.deploy_webhook_url}
                            {cert.last_deploy_status ? ` · ${cert.last_deploy_status}` : ''}
                          </div>
                        )}
                        {cert.last_error && (
                          <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 mt-2">
                            {cert.last_error}
                          </div>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        {cert.engine_mode === 'upstream_public' && (
                          <button
                            type="button"
                            onClick={() => handleCheckDns(cert)}
                            disabled={busyId === `dns:${cert.id}`}
                            className="px-3 py-2 rounded-lg border border-slate-300 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                          >
                            {m.checkDnsBtn}
                          </button>
                        )}
                        {cert.status !== 'active' ? (
                          <button
                            type="button"
                            onClick={() => handleVerifyOrRenew(cert, false)}
                            disabled={busyId === `verify:${cert.id}`}
                            className="px-3.5 py-2 rounded-lg bg-teal-600 text-white text-xs font-medium hover:bg-teal-700 cursor-pointer"
                          >
                            {m.verifyIssueBtn}
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => handleVerifyOrRenew(cert, true)}
                              disabled={busyId === `renew:${cert.id}`}
                              className="px-3 py-2 rounded-lg border border-slate-300 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                            >
                              {m.renewNowBtn}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleOpenBundle(cert)}
                              disabled={busyId === `bundle:${cert.id}`}
                              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 cursor-pointer"
                            >
                              <KeyRound className="w-3.5 h-3.5" />
                              <span>{m.downloadBundleBtn}</span>
                            </button>
                            {cert.deploy_webhook_url && (
                              <button
                                type="button"
                                onClick={() => handleDeploy(cert)}
                                disabled={busyId === `deploy:${cert.id}`}
                                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-teal-300 text-teal-800 text-xs font-medium hover:bg-teal-50 cursor-pointer"
                              >
                                <Send className="w-3.5 h-3.5" />
                                <span>{m.deployNowBtn}</span>
                              </button>
                            )}
                          </>
                        )}
                        <button
                          type="button"
                          onClick={() => handleDeleteCert(cert.id)}
                          disabled={busyId === `del:${cert.id}`}
                          className="p-2 rounded-lg border border-slate-200 text-slate-500 hover:text-rose-700 hover:border-rose-200 cursor-pointer"
                          title={m.deleteBtn}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {/* DNS / CNAME Delegation Records */}
                    {cert.challenges.length > 0 && (
                      <div className="pt-3 border-t border-slate-100 space-y-2">
                        <div className="text-xs font-medium text-slate-600">{m.cnameGuideTitle}</div>
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs text-left">
                            <thead className="text-slate-500 border-b border-slate-100">
                              <tr>
                                <th className="py-1.5 pe-3 font-medium">Type</th>
                                <th className="py-1.5 pe-3 font-medium">Host / Record</th>
                                <th className="py-1.5 pe-3 font-medium">Value / Target</th>
                                <th className="py-1.5 font-medium">Status</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 font-mono">
                              {cert.challenges.map((ch, idx) => {
                                const displayHost = ch.delegation_cname_host || ch.record_host;
                                const displayVal =
                                  ch.record_type === 'CNAME'
                                    ? ch.delegation_cname_target || ch.record_value
                                    : ch.record_value;
                                return (
                                  <tr key={`${cert.id}-${idx}`}>
                                    <td className="py-2 pe-3 font-semibold text-slate-700">
                                      {ch.record_type}
                                    </td>
                                    <td className="py-2 pe-3 text-slate-800">
                                      <div className="flex items-center gap-2">
                                        <span className="break-all">{displayHost}</span>
                                        <CopyButton
                                          value={displayHost}
                                          label={t.common.copy}
                                          copiedLabel={t.common.copied}
                                          compact
                                        />
                                      </div>
                                    </td>
                                    <td className="py-2 pe-3 text-slate-800">
                                      <div className="flex items-center gap-2">
                                        <span className="break-all">{displayVal}</span>
                                        <CopyButton
                                          value={displayVal}
                                          label={t.common.copy}
                                          copiedLabel={t.common.copied}
                                          compact
                                        />
                                      </div>
                                    </td>
                                    <td className="py-2 text-slate-600">{ch.status}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                        {dnsResult && (
                          <div className="text-xs bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1">
                            {dnsResult.checks.map((ck, i) => (
                              <div key={i} className="font-mono flex flex-wrap gap-2">
                                <span className={ck.matched ? 'text-emerald-700 font-semibold' : 'text-amber-700 font-semibold'}>
                                  {ck.matched ? 'MATCH' : 'PENDING'}
                                </span>
                                <span className="text-slate-700">{ck.host}</span>
                                <span className="text-slate-500">
                                  Observed: {ck.observed.length > 0 ? ck.observed.join(', ') : '(none)'}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* TAB 2: Upstream Public CAs & Failover */}
      {subTab === 'upstreams' && (
        <div className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
              <div>
                <h3 className="font-display text-base font-bold text-slate-900">{m.upstreamsTitle}</h3>
                <p className="text-sm text-slate-600 mt-1">{m.upstreamsDesc}</p>
              </div>
              {isAdmin && (
                <button
                  type="button"
                  onClick={openAddUpstreamModal}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#0F766E] hover:bg-[#115E59] text-white text-sm font-medium transition-colors cursor-pointer shrink-0 self-start"
                >
                  <Plus className="w-4 h-4" />
                  <span>{m.addUpstreamBtn}</span>
                </button>
              )}
            </div>

            <div className="divide-y divide-slate-200 border-t border-slate-200">
              {upstreams.map((u) => {
                const proxyUrl = `${data?.proxy_base_url || ''}/${u.id}/directory`;
                return (
                  <div key={u.id} className="py-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                    <div className="space-y-1.5 min-w-0">
                      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                        <span className="font-mono text-xs font-bold text-teal-700">P{u.priority}</span>
                        <span className="font-semibold text-sm text-slate-900">{u.name}</span>
                        <span className={`text-xs font-medium ${u.enabled ? 'text-emerald-700' : 'text-slate-400'}`}>
                          {u.enabled ? 'Enabled' : 'Disabled'}
                        </span>
                        {u.requires_eab && (
                          <span className="text-xs text-slate-500">
                            · EAB {u.eab_hmac_configured ? `(${u.eab_kid})` : '(Required)'}
                          </span>
                        )}
                      </div>
                      <div className="text-xs font-mono text-slate-600 break-all">{u.directory_url}</div>
                      {u.enabled && (
                        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                          <span>{m.proxyUrlLabel}:</span>
                          <code className="font-mono text-slate-800 break-all">{proxyUrl}</code>
                          <CopyButton
                            value={proxyUrl}
                            label={t.common.copy}
                            copiedLabel={t.common.copied}
                            compact
                          />
                        </div>
                      )}
                      {u.last_probe_at > 0 && (
                        <div className="text-xs text-slate-500 font-mono tabular-nums">
                          Probe: {u.last_probe_ok ? `OK · ${u.last_probe_ms} ms` : `Error: ${u.last_probe_error}`} ·{' '}
                          {formatUnixUtc(u.last_probe_at)}
                        </div>
                      )}
                    </div>

                    {isAdmin && (
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleProbeUpstream(u)}
                          disabled={busyId === `probe:${u.id}`}
                          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                        >
                          <Activity className="w-3.5 h-3.5" />
                          <span>{m.probeBtn}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleEditUpstream(u)}
                          className="px-3 py-2 rounded-lg border border-slate-300 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteUpstream(u.id)}
                          disabled={busyId === `delup:${u.id}`}
                          className="p-2 rounded-lg border border-slate-200 text-slate-500 hover:text-rose-700 cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Upstream Public CA Add / Edit Modal (Admin) */}
      {isAdmin && upstreamModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-[1px] flex items-center justify-center p-4"
          onClick={(ev) => {
            if (ev.target === ev.currentTarget) setUpstreamModalOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="upstream-modal-title"
            className="bg-white border border-slate-200 rounded-2xl max-w-2xl w-full max-h-[90vh] flex flex-col overflow-hidden shadow-xl"
          >
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
              <div>
                <h3 id="upstream-modal-title" className="font-display text-base font-bold text-slate-900">
                  {upEditId ? m.editUpstreamTitle : m.addUpstreamTitle}
                </h3>
                {upEditId && (
                  <div className="text-xs text-slate-500 font-mono mt-0.5">{upEditId}</div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setUpstreamModalOpen(false)}
                aria-label="Close modal"
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveUpstream} className="p-6 space-y-5 overflow-y-auto">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    {m.upstreamProvider}
                  </label>
                  <select
                    value={upProvider}
                    onChange={(e) => {
                      const p = e.target.value as UpstreamProviderType;
                      setUpProvider(p);
                      if (!upEditId && p !== 'custom') {
                        setUpName(UPSTREAM_PRESETS[p].name);
                        setUpDirUrl(UPSTREAM_PRESETS[p].directory_url);
                        setUpRequiresEab(UPSTREAM_PRESETS[p].requires_eab);
                      }
                    }}
                    className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 text-sm bg-white focus:border-teal-600 focus:outline-none"
                  >
                    <option value="letsencrypt_prod">Let&apos;s Encrypt (Production)</option>
                    <option value="google_trust">Google Trust Services (GTS)</option>
                    <option value="zerossl">ZeroSSL (ACME v2 DV90)</option>
                    <option value="letsencrypt_staging">Let&apos;s Encrypt (Staging)</option>
                    <option value="custom">Custom Commercial ACME CA (Sectigo / DigiCert)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    {m.upstreamName}
                  </label>
                  <input
                    type="text"
                    required
                    value={upName}
                    onChange={(e) => setUpName(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 text-sm focus:border-teal-600 focus:outline-none"
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    {m.upstreamDirectory}
                  </label>
                  <input
                    type="url"
                    required
                    value={upDirUrl}
                    onChange={(e) => setUpDirUrl(e.target.value)}
                    placeholder="https://dv.acme-v02.api.pki.goog/directory"
                    className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 text-sm font-mono focus:border-teal-600 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    {m.upstreamPriority}
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={99}
                    value={upPriority}
                    onChange={(e) => setUpPriority(Number(e.target.value) || 1)}
                    className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 text-sm font-mono tabular-nums focus:border-teal-600 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    {m.upstreamEmail}
                  </label>
                  <input
                    type="email"
                    value={upEmail}
                    onChange={(e) => setUpEmail(e.target.value)}
                    placeholder="pki-ops@example.com"
                    className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 text-sm focus:border-teal-600 focus:outline-none"
                  />
                </div>

                <div className="md:col-span-2 flex flex-wrap gap-6 pt-1">
                  <label className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={upRequiresEab}
                      onChange={(e) => setUpRequiresEab(e.target.checked)}
                      className="rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                    />
                    <span>{m.upstreamRequiresEab}</span>
                  </label>
                  <label className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={upEnabled}
                      onChange={(e) => setUpEnabled(e.target.checked)}
                      className="rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                    />
                    <span>{m.upstreamEnabled}</span>
                  </label>
                </div>

                {upRequiresEab && (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1.5">
                        {m.upstreamEabKid}
                      </label>
                      <input
                        type="text"
                        value={upEabKid}
                        onChange={(e) => setUpEabKid(e.target.value)}
                        className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 text-sm font-mono focus:border-teal-600 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1.5">
                        {m.upstreamEabHmac}
                      </label>
                      <input
                        type="password"
                        value={upEabHmac}
                        onChange={(e) => setUpEabHmac(e.target.value)}
                        placeholder={upEditId ? 'Leave blank to keep existing key' : ''}
                        className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 text-sm font-mono focus:border-teal-600 focus:outline-none"
                      />
                    </div>
                  </>
                )}
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-4 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setUpstreamModalOpen(false)}
                  className="px-4 py-2.5 rounded-lg border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50 cursor-pointer"
                >
                  {m.cancelBtn}
                </button>
                <button
                  type="submit"
                  disabled={savingUp}
                  className="px-5 py-2.5 rounded-lg bg-[#0F766E] hover:bg-[#115E59] text-white text-sm font-medium disabled:opacity-60 cursor-pointer"
                >
                  {m.saveUpstreamBtn}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* TAB 3: DNS Credentials & Global Proxy Policy */}
      {subTab === 'dns' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* DNS Credentials Vault */}
          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
            <div>
              <h3 className="font-display text-base font-bold text-slate-900">{m.dnsCredsTitle}</h3>
              <p className="text-sm text-slate-600 mt-1">{m.dnsCredsDesc}</p>
            </div>

            <form onSubmit={handleCreateDnsCred} className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">{m.dnsName}</label>
                  <input
                    type="text"
                    required
                    value={dnsName}
                    onChange={(e) => setDnsName(e.target.value)}
                    placeholder="Cloudflare Production"
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">{m.dnsProvider}</label>
                  <select
                    value={dnsProvider}
                    onChange={(e) => setDnsProvider(e.target.value as DnsProviderType)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white"
                  >
                    <option value="cloudflare">Cloudflare DNS</option>
                    <option value="aliyun">Aliyun DNS (阿里云解析)</option>
                    <option value="dnspod">Tencent DNSPod (腾讯云解析)</option>
                    <option value="webhook">Custom DNS Webhook</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">{m.dnsZoneHint}</label>
                <input
                  type="text"
                  value={dnsZoneHint}
                  onChange={(e) => setDnsZoneHint(e.target.value)}
                  placeholder="example.com"
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">{m.dnsToken}</label>
                <input
                  type="password"
                  required
                  value={dnsToken}
                  onChange={(e) => setDnsToken(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm font-mono"
                />
              </div>
              {(dnsProvider === 'aliyun' || dnsProvider === 'dnspod') && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">{m.dnsSecret}</label>
                  <input
                    type="password"
                    required
                    value={dnsSecret}
                    onChange={(e) => setDnsSecret(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm font-mono"
                  />
                </div>
              )}
              <button
                type="submit"
                disabled={savingDns}
                className="px-4 py-2 rounded-lg bg-teal-600 text-white text-sm font-medium hover:bg-teal-700 disabled:opacity-60 cursor-pointer"
              >
                {m.saveDnsBtn}
              </button>
            </form>

            <div className="divide-y divide-slate-100 border-t border-slate-100 pt-2">
              {dnsCredentials.length === 0 ? (
                <div className="py-4 text-xs text-slate-500">{m.emptyDns}</div>
              ) : (
                dnsCredentials.map((c) => (
                  <div key={c.id} className="py-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-900">{c.name}</div>
                      <div className="text-xs text-slate-500 font-mono">
                        {c.provider} · {c.zone_hint || '*'} · {c.secret_prefix}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDeleteDnsCred(c.id)}
                      className="p-2 text-slate-400 hover:text-rose-700 cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Global Proxy & Delegation Policy (Admin) */}
          <form
            onSubmit={handleSavePolicy}
            className="bg-white border border-slate-200 rounded-xl p-6 space-y-5 h-fit"
          >
            <div className="flex items-center gap-2">
              <Globe className="w-4 h-4 text-teal-600" />
              <h3 className="font-display text-base font-bold text-slate-900">{m.policyTitle}</h3>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  {m.policyMode}
                </label>
                <select
                  disabled={!isAdmin}
                  value={policyDraft.mode}
                  onChange={(e) =>
                    setPolicyDraft((p) => ({
                      ...p,
                      mode: e.target.value as ManagedProxyPolicy['mode'],
                    }))
                  }
                  className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 text-sm bg-white disabled:bg-slate-50"
                >
                  <option value="dual_engine">{m.modeDual}</option>
                  <option value="upstream_proxy">{m.modeUpstream}</option>
                  <option value="private_ca">{m.modePrivate}</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  {m.policyZone}
                </label>
                <input
                  type="text"
                  disabled={!isAdmin}
                  value={policyDraft.cname_delegation_zone}
                  onChange={(e) =>
                    setPolicyDraft((p) => ({ ...p, cname_delegation_zone: e.target.value }))
                  }
                  className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 text-sm font-mono disabled:bg-slate-50"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  {m.renewDaysLabel}
                </label>
                <input
                  type="number"
                  min={1}
                  max={60}
                  disabled={!isAdmin}
                  value={policyDraft.default_renew_before_days}
                  onChange={(e) =>
                    setPolicyDraft((p) => ({
                      ...p,
                      default_renew_before_days: Number(e.target.value) || 30,
                    }))
                  }
                  className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 text-sm font-mono tabular-nums disabled:bg-slate-50"
                />
              </div>

              <label className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  disabled={!isAdmin}
                  checked={policyDraft.auto_failover}
                  onChange={(e) =>
                    setPolicyDraft((p) => ({ ...p, auto_failover: e.target.checked }))
                  }
                  className="rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                />
                <span>{m.policyFailover}</span>
              </label>
            </div>

            {isAdmin && (
              <div className="flex justify-end pt-2">
                <button
                  type="submit"
                  disabled={savingPolicy}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-60 cursor-pointer"
                >
                  <ShieldCheck className="w-4 h-4" />
                  <span>{m.savePolicyBtn}</span>
                </button>
              </div>
            )}
          </form>
        </div>
      )}

      {/* TAB 4: Deploy & Renewal Logs */}
      {subTab === 'logs' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {deployLogs.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-500">{m.emptyLogs}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-600">
                  <tr>
                    <th className="px-4 py-3 font-medium">UTC</th>
                    <th className="px-4 py-3 font-medium">Domain</th>
                    <th className="px-4 py-3 font-medium">Action</th>
                    <th className="px-4 py-3 font-medium">Target</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Detail</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {deployLogs.map((log) => (
                    <tr key={log.id}>
                      <td className="px-4 py-3 font-mono tabular-nums text-slate-500 whitespace-nowrap">
                        {formatUnixUtc(log.created_at)}
                      </td>
                      <td className="px-4 py-3 font-mono font-medium text-slate-900">
                        {log.common_name}
                      </td>
                      <td className="px-4 py-3 font-mono text-slate-700">{log.action}</td>
                      <td className="px-4 py-3 font-mono text-slate-600 max-w-[220px] truncate">
                        {log.target}
                      </td>
                      <td
                        className={`px-4 py-3 font-semibold ${
                          log.status === 'ok' ? 'text-emerald-700' : 'text-rose-700'
                        }`}
                      >
                        {log.status}
                      </td>
                      <td className="px-4 py-3 text-slate-600 max-w-xs truncate">{log.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Bundle Modal (PEM Chain & Private Key) */}
      {bundleModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-3xl w-full max-h-[85vh] flex flex-col overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 className="font-display text-base font-bold text-slate-900">
                  {m.bundleModalTitle}
                </h3>
                <div className="text-xs text-slate-500 font-mono">
                  {bundleModal.common_name} · {bundleModal.serial_hex}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setBundleModal(null)}
                className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6 overflow-y-auto space-y-5">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-700">{m.certChainLabel}</span>
                  <button
                    type="button"
                    onClick={() =>
                      downloadTextFile(`${bundleModal.common_name}-fullchain.pem`, bundleModal.chain_pem)
                    }
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-teal-700 hover:underline cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>fullchain.pem</span>
                  </button>
                </div>
                <CodeBlock
                  code={bundleModal.chain_pem}
                  title="fullchain.pem"
                  copyLabel={t.common.copy}
                  copiedLabel={t.common.copied}
                  maxHeightClass="max-h-48"
                />
              </div>

              {bundleModal.private_key_pem && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-700">{m.privateKeyLabel}</span>
                    <button
                      type="button"
                      onClick={() =>
                        downloadTextFile(`${bundleModal.common_name}.key`, bundleModal.private_key_pem)
                      }
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-teal-700 hover:underline cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>privkey.key</span>
                    </button>
                  </div>
                  <CodeBlock
                    code={bundleModal.private_key_pem}
                    title="privkey.key"
                    copyLabel={t.common.copy}
                    copiedLabel={t.common.copied}
                    maxHeightClass="max-h-48"
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
