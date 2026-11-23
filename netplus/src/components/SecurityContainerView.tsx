import React, { useEffect, useState } from 'react';
import { Check, Copy, Download, Lock, RefreshCw, Save, Sparkles } from 'lucide-react';
import { translate, type TranslationKeys } from '../i18n/translations';
import { apiRequest, getAuthToken } from '../lib/api';
import type { LanguageCode, SecurityConfig, TlsCertificateStatus } from '../types/models';

interface SecurityContainerViewProps {
  lang: LanguageCode;
  onRefreshOverview: () => Promise<void>;
}

const GHCR_DOCKERHUB_GUIDE = `# 1. Compile source FIRST (tsc + Vite frontend dist/ + esbuild backend dist-server/server.mjs) & push
./scripts/build-and-push.sh wimotek/netplus latest
# Or push to GHCR:
./scripts/build-and-push.sh ghcr.io/wimotek/netplus latest

# Or step-by-step manual compile + release image push:
npm run build:all
docker buildx build -f Dockerfile.release \\
  --platform linux/amd64,linux/arm64 --push \\
  -t wimotek/netplus:latest \\
  -t ghcr.io/wimotek/netplus:latest .

# 2. Run container with persistent /data volume + Baota (宝塔) SSL mounted read-only to /certs:ro
# Entrypoint stages root-owned 0600 Baota certs to /tmp/netpulse-certs (UID 1001) before dropping root.
docker run -d --name netplus --restart unless-stopped \\
  -p 3000:3000 \\
  -p 3443:3443 \\
  -v netpulse_data:/data \\
  -v /www/server/panel/vhost/cert/<your-domain>:/certs:ro \\
  -e HTTPS_PORT=3443 \\
  -e AUDIT_MAX_SIZE_BYTES=5242880 \\
  wimotek/netplus:latest

# 3. GitHub Actions (.github/workflows/docker-publish.yml, unified WORKING_DIR: netplus)
# - Job 1 (compile-and-verify): tsc + vite + esbuild + production /api/health smoke test
# - Job 2 (build-and-push): packages verified dist/ & dist-server/ via Dockerfile.release
#   -> Docker Hub: wimotek/netplus | GHCR: ghcr.io/wimotek/netplus`;

export function SecurityContainerView({ lang, onRefreshOverview }: SecurityContainerViewProps) {
  const t = (key: TranslationKeys) => translate(lang, key);
  const [config, setConfig] = useState<SecurityConfig | null>(null);
  const [tlsStatus, setTlsStatus] = useState<TlsCertificateStatus | null>(null);
  const [envManaged, setEnvManaged] = useState(false);
  const [activeSessions, setActiveSessions] = useState(1);
  const [saving, setSaving] = useState(false);
  const [reloadingTls, setReloadingTls] = useState(false);
  const [generatingCert, setGeneratingCert] = useState(false);
  const [showCustomCertForm, setShowCustomCertForm] = useState(false);
  const [customCertForm, setCustomCertForm] = useState({
    commonName: 'netpulse.local',
    sanDomains: '',
    sanIps: '',
    days: 825,
  });
  const [tlsMsg, setTlsMsg] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passMsg, setPassMsg] = useState<string | null>(null);
  const [copiedGuide, setCopiedGuide] = useState(false);

  useEffect(() => {
    void apiRequest<{
      config: SecurityConfig;
      envManagedAdmin: boolean;
      activeSessions: number;
      tlsStatus?: TlsCertificateStatus;
    }>('/api/security/config').then((res) => {
      setConfig(res.config);
      setEnvManaged(res.envManagedAdmin);
      setActiveSessions(res.activeSessions);
      if (res.tlsStatus) setTlsStatus(res.tlsStatus);
    });
  }, []);

  const handleReloadTls = async () => {
    setReloadingTls(true);
    setTlsMsg(null);
    try {
      const res = await apiRequest<{ ok: boolean; message: string; status: TlsCertificateStatus }>(
        '/api/tls/reload',
        { method: 'POST' }
      );
      setTlsStatus(res.status);
      setTlsMsg(res.message);
      await onRefreshOverview();
    } catch (err) {
      setTlsMsg(err instanceof Error ? err.message : 'TLS reload failed');
    } finally {
      setReloadingTls(false);
    }
  };

  const handleGenerateCustomCert = async (e: React.FormEvent) => {
    e.preventDefault();
    setGeneratingCert(true);
    setTlsMsg(null);
    try {
      const res = await apiRequest<{ ok: boolean; message: string; status: TlsCertificateStatus }>(
        '/api/tls/generate',
        {
          method: 'POST',
          body: JSON.stringify(customCertForm),
        }
      );
      setTlsStatus(res.status);
      setTlsMsg(res.message);
      setShowCustomCertForm(false);
      await onRefreshOverview();
    } catch (err) {
      setTlsMsg(err instanceof Error ? err.message : 'Failed to generate certificate');
    } finally {
      setGeneratingCert(false);
    }
  };

  const handleDownloadPublicCert = async () => {
    try {
      const token = getAuthToken();
      const res = await fetch('/api/tls/cert.pem', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return;
      const pem = await res.text();
      const blob = new Blob([pem], { type: 'application/x-pem-file' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'netpulse-cert.pem';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!config) return;
    setSaving(true);
    try {
      const res = await apiRequest<{ config: SecurityConfig }>('/api/security/config', {
        method: 'PUT',
        body: JSON.stringify(config),
      });
      setConfig(res.config);
      await onRefreshOverview();
      setToastMsg(t('savedSuccessfully'));
      setTimeout(() => setToastMsg(null), 3500);
    } finally {
      setSaving(false);
    }
  };

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPassMsg(null);
    try {
      await apiRequest('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setCurrentPassword('');
      setNewPassword('');
      setPassMsg(t('savedSuccessfully'));
    } catch (err) {
      setPassMsg(err instanceof Error ? err.message : 'Failed');
    }
  };

  if (!config) {
    return <div className="h-64 rounded-xl bg-slate-200/60 dark:bg-slate-800/60 animate-pulse" />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
          {t('securityTitle')}
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{t('securitySubtitle')}</p>
      </div>

      {toastMsg && (
        <div className="px-4 py-3 rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50/70 dark:bg-emerald-950/30 text-xs text-emerald-700 dark:text-emerald-300">
          {toastMsg}
        </div>
      )}

      <form onSubmit={handleSaveConfig} className="space-y-6">
        {/* Anti-Bot & Rate-Limit Settings */}
        <div className="p-6 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-200 dark:border-slate-800">
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-white">
              {t('antiBotSection')}
            </h2>
            <span className="font-mono text-xs text-slate-500 tabular-nums">
              Active sessions: {activeSessions}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 text-xs">
            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('maxLoginAttempts')}
              </label>
              <input
                type="number"
                min={3}
                max={20}
                value={config.maxLoginAttempts}
                onChange={(e) => setConfig({ ...config, maxLoginAttempts: Number(e.target.value) })}
                className="w-full px-3 py-2 font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
              />
            </div>

            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('lockoutMinutes')}
              </label>
              <input
                type="number"
                min={1}
                max={180}
                value={config.lockoutMinutes}
                onChange={(e) => setConfig({ ...config, lockoutMinutes: Number(e.target.value) })}
                className="w-full px-3 py-2 font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
              />
            </div>

            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('sessionTimeout')}
              </label>
              <input
                type="number"
                min={10}
                max={1440}
                value={config.sessionTimeoutMinutes}
                onChange={(e) => setConfig({ ...config, sessionTimeoutMinutes: Number(e.target.value) })}
                className="w-full px-3 py-2 font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
              />
            </div>

            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('rateLimitWindow')}
              </label>
              <input
                type="number"
                min={10}
                max={300}
                value={config.rateLimitWindowSeconds}
                onChange={(e) => setConfig({ ...config, rateLimitWindowSeconds: Number(e.target.value) })}
                className="w-full px-3 py-2 font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
              />
            </div>

            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('rateLimitMax')}
              </label>
              <input
                type="number"
                min={5}
                max={200}
                value={config.rateLimitMaxRequests}
                onChange={(e) => setConfig({ ...config, rateLimitMaxRequests: Number(e.target.value) })}
                className="w-full px-3 py-2 font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
              />
            </div>

            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('captchaDifficulty')}
              </label>
              <select
                value={config.captchaDifficulty}
                onChange={(e) =>
                  setConfig({ ...config, captchaDifficulty: e.target.value as 'standard' | 'high' })
                }
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
              >
                <option value="standard">{t('captchaStandard')}</option>
                <option value="high">{t('captchaHigh')}</option>
              </select>
            </div>

            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('powDifficulty')}
              </label>
              <input
                type="number"
                min={1}
                max={4}
                value={config.powDifficulty}
                onChange={(e) => setConfig({ ...config, powDifficulty: Number(e.target.value) })}
                className="w-full px-3 py-2 font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
              />
            </div>

            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('minDwellMs')}
              </label>
              <input
                type="number"
                min={300}
                max={5000}
                step={100}
                value={config.minFormDwellMs}
                onChange={(e) => setConfig({ ...config, minFormDwellMs: Number(e.target.value) })}
                className="w-full px-3 py-2 font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
              />
            </div>

            <div className="flex flex-col justify-end gap-2 pb-1">
              <label className="inline-flex items-center gap-2 font-medium text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={config.requireSliderVerify}
                  onChange={(e) => setConfig({ ...config, requireSliderVerify: e.target.checked })}
                  className="rounded accent-blue-600"
                />
                {t('requireSlider')}
              </label>
              {config.requireSliderVerify && (
                <div className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                  <span>
                    {lang === 'zh-CN' ? '连续失败触发次数（0=始终）：' : 'Trigger after failures (0=always):'}
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={10}
                    value={config.sliderFailureThreshold ?? 2}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        sliderFailureThreshold: Math.max(0, Math.min(10, Number(e.target.value) || 0)),
                      })
                    }
                    className="w-16 px-2 py-1 font-mono text-xs rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-white"
                  />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Audit Auto-Deletion Quota Settings */}
        <div className="p-6 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-5">
          <h2 className="font-display text-base font-semibold text-slate-900 dark:text-white pb-3 border-b border-slate-200 dark:border-slate-800">
            {t('auditRetentionSection')}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('maxAuditMb')}
              </label>
              <input
                type="number"
                min={16}
                max={512000}
                value={Math.round(config.maxAuditSizeBytes / 1024)}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    maxAuditSizeBytes: Math.max(16384, Number(e.target.value) * 1024),
                  })
                }
                className="w-full px-3 py-2 font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('auditKeepPercent')}
              </label>
              <input
                type="number"
                min={30}
                max={90}
                value={config.auditRetentionPercent}
                onChange={(e) => setConfig({ ...config, auditRetentionPercent: Number(e.target.value) })}
                className="w-full px-3 py-2 font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
              />
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
            >
              <Save className="w-3.5 h-3.5" />
              {t('save')}
            </button>
          </div>
        </div>
      </form>

      {/* Password Rotation */}
      {!envManaged && (
        <form
          onSubmit={handleUpdatePassword}
          className="p-6 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-4"
        >
          <h2 className="font-display text-base font-semibold text-slate-900 dark:text-white pb-3 border-b border-slate-200 dark:border-slate-800">
            {t('passwordSection')}
          </h2>
          {passMsg && <div className="text-xs text-blue-600 dark:text-blue-400">{passMsg}</div>}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
            <div>
              <label className="block font-medium mb-1.5">{t('currentPassword')}</label>
              <input
                type="password"
                required
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block font-medium mb-1.5">{t('newPassword')}</label>
              <input
                type="password"
                required
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
              />
            </div>
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              className="px-4 py-2 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
            >
              {t('updatePassword')}
            </button>
          </div>
        </form>
      )}

      {/* Baota / SSL Certificate (/certs:ro) & Auto/Custom Self-Signed TLS */}
      {tlsStatus && (
        <div className="p-6 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-200 dark:border-slate-800">
            <div className="flex items-center gap-2 min-w-0">
              <Lock className="w-4 h-4 text-slate-400 shrink-0" aria-hidden="true" />
              <h2 className="font-display text-base font-semibold text-slate-900 dark:text-white truncate">
                {lang === 'zh-CN'
                  ? 'SSL 证书管理（宝塔 /certs:ro 挂载 · 未挂载自动/自定义生成）'
                  : 'SSL Certificate (Baota /certs:ro Mount · Auto / Custom Self-Signed)'}
              </h2>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {tlsStatus.readable && (
                <button
                  type="button"
                  onClick={() => void handleDownloadPublicCert()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" />
                  {lang === 'zh-CN' ? '下载公钥 (.pem)' : 'Download .pem'}
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowCustomCertForm((v) => !v)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/40 whitespace-nowrap"
              >
                <Sparkles className="w-3.5 h-3.5" />
                {lang === 'zh-CN' ? '生成自定义证书' : 'Generate Custom Cert'}
              </button>
              <button
                type="button"
                disabled={reloadingTls}
                onClick={() => void handleReloadTls()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${reloadingTls ? 'animate-spin' : ''}`} />
                {lang === 'zh-CN' ? '热重载证书' : 'Reload Certificate'}
              </button>
            </div>
          </div>

          {tlsMsg && (
            <div className="px-3.5 py-2.5 rounded-lg bg-slate-100 dark:bg-slate-800/70 text-xs font-mono text-slate-700 dark:text-slate-300">
              {tlsMsg}
            </div>
          )}

          {tlsStatus.permissionIssue && (
            <div className="px-3.5 py-2.5 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50/70 dark:bg-amber-950/30 text-xs text-amber-800 dark:text-amber-300">
              {tlsStatus.permissionIssue}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
            <div>
              <div className="text-slate-500 dark:text-slate-400">HTTPS Listener</div>
              <div
                className={`mt-1 font-mono font-semibold ${
                  tlsStatus.httpsListening
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-slate-500 dark:text-slate-400'
                }`}
              >
                {tlsStatus.httpsListening ? `ACTIVE :${tlsStatus.httpsPort}` : `STANDBY (:${tlsStatus.httpsPort})`}
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                {tlsStatus.source === 'mounted'
                  ? lang === 'zh-CN'
                    ? '来源：宝塔 /certs:ro 挂载'
                    : 'Source: Mounted /certs:ro'
                  : tlsStatus.source === 'self_signed'
                  ? lang === 'zh-CN'
                    ? '来源：自定义自签证书'
                    : 'Source: Custom Self-Signed'
                  : lang === 'zh-CN'
                  ? '来源：未检测到证书'
                  : 'Source: None'}
              </div>
            </div>
            <div>
              <div className="text-slate-500 dark:text-slate-400">Active Path</div>
              <div className="mt-1 font-mono text-slate-800 dark:text-slate-200 truncate" title={tlsStatus.activeDir}>
                {tlsStatus.source === 'mounted' && tlsStatus.stagedFromReadOnly
                  ? `${tlsStatus.certDir} → ${tlsStatus.activeDir}`
                  : tlsStatus.activeDir}
              </div>
            </div>
            <div>
              <div className="text-slate-500 dark:text-slate-400">Subject / Expiry</div>
              <div className="mt-1 font-mono text-slate-800 dark:text-slate-200 truncate" title={tlsStatus.subject}>
                {tlsStatus.subject || 'No cert active'}
              </div>
              {tlsStatus.daysRemaining !== undefined && (
                <div
                  className={`mt-0.5 font-mono text-[11px] tabular-nums ${
                    tlsStatus.daysRemaining < 14
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-emerald-600 dark:text-emerald-400'
                  }`}
                >
                  {tlsStatus.daysRemaining}d remaining ({tlsStatus.validTo?.slice(0, 10)})
                </div>
              )}
            </div>
            <div>
              <div className="text-slate-500 dark:text-slate-400">SANs (Domains / IPs)</div>
              <div
                className="mt-1 font-mono text-[11px] text-slate-600 dark:text-slate-300 truncate"
                title={tlsStatus.sanList?.join(', ')}
              >
                {tlsStatus.sanList && tlsStatus.sanList.length > 0
                  ? tlsStatus.sanList.join(', ')
                  : '—'}
              </div>
            </div>
          </div>

          {showCustomCertForm && (
            <form
              onSubmit={handleGenerateCustomCert}
              className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3 text-xs"
            >
              <div className="font-medium text-slate-800 dark:text-slate-200">
                {lang === 'zh-CN'
                  ? '自定义 ECDSA P-256 自签证书参数（保存至 /data/certs，未挂载 /certs:ro 时立即生效）'
                  : 'Custom ECDSA P-256 Self-Signed Certificate (saved to /data/certs; active immediately when /certs:ro is unmounted)'}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <div>
                  <label className="block font-medium text-slate-600 dark:text-slate-400 mb-1">
                    {lang === 'zh-CN' ? '主域名 / CN' : 'Common Name (CN)'}
                  </label>
                  <input
                    required
                    value={customCertForm.commonName}
                    onChange={(e) => setCustomCertForm({ ...customCertForm, commonName: e.target.value })}
                    placeholder="panel.example.com"
                    className="w-full px-3 py-2 font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-600 dark:text-slate-400 mb-1">
                    {lang === 'zh-CN' ? '附加域名 SAN（逗号分隔）' : 'Extra DNS SANs (comma sep)'}
                  </label>
                  <input
                    value={customCertForm.sanDomains}
                    onChange={(e) => setCustomCertForm({ ...customCertForm, sanDomains: e.target.value })}
                    placeholder="nas.lan, *.home.arpa"
                    className="w-full px-3 py-2 font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-600 dark:text-slate-400 mb-1">
                    {lang === 'zh-CN' ? '附加 IP SAN（IPv4/IPv6）' : 'Extra IP SANs (IPv4/IPv6)'}
                  </label>
                  <input
                    value={customCertForm.sanIps}
                    onChange={(e) => setCustomCertForm({ ...customCertForm, sanIps: e.target.value })}
                    placeholder="192.168.1.10, 203.0.113.5"
                    className="w-full px-3 py-2 font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-600 dark:text-slate-400 mb-1">
                    {lang === 'zh-CN' ? '有效期（天，30-3650）' : 'Validity Days (30-3650)'}
                  </label>
                  <input
                    type="number"
                    min={30}
                    max={3650}
                    value={customCertForm.days}
                    onChange={(e) => setCustomCertForm({ ...customCertForm, days: Number(e.target.value) })}
                    className="w-full px-3 py-2 font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowCustomCertForm(false)}
                  className="px-3.5 py-1.5 font-medium rounded-lg border border-slate-200 dark:border-slate-700"
                >
                  {t('cancel')}
                </button>
                <button
                  type="submit"
                  disabled={generatingCert}
                  className="px-4 py-1.5 font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {generatingCert
                    ? lang === 'zh-CN'
                      ? '正在签发...'
                      : 'Generating...'
                    : lang === 'zh-CN'
                    ? '签发并热重载 HTTPS'
                    : 'Generate & Hot-Reload HTTPS'}
                </button>
              </div>
            </form>
          )}

          <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            {lang === 'zh-CN'
              ? '优先使用只读挂载的宝塔证书 /certs:ro（自动将 root:root 0600 副本安全中转至 UID 1001）；未挂载外部证书时，系统自动在 /data/certs 生成持久化自定义 ECDSA 证书并启动 HTTPS，可随时自定义域名/IP 重新签发。'
              : 'Mounted Baota /certs:ro certificates take top priority (safely staged from root:root 0600 to UID 1001). When no external cert is mounted, NetPulse automatically generates a persistent custom ECDSA certificate in /data/certs and enables HTTPS immediately.'}
          </p>
        </div>
      )}

      {/* Multi-Stage Docker & GitHub Actions Container Deployment Guide */}
      <div className="p-6 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-white">
              {t('containerSection')}
            </h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {lang === 'zh-CN'
                ? '先编译并校验源码（dist/ + dist-server/），再打包推送 linux/amd64 & linux/arm64 多架构镜像至 Docker Hub (wimotek/netplus) 与 GHCR (ghcr.io/wimotek/netplus)。'
                : 'Compile and verify source first (dist/ + dist-server/), then publish multi-arch images to Docker Hub (wimotek/netplus) and GHCR (ghcr.io/wimotek/netplus).'}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(GHCR_DOCKERHUB_GUIDE);
                setCopiedGuide(true);
                setTimeout(() => setCopiedGuide(false), 1800);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              {copiedGuide ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copiedGuide ? t('copied') : t('copy')}
            </button>
          </div>
        </div>
        <pre className="p-4 rounded-lg bg-slate-950 text-slate-100 font-mono text-xs leading-relaxed overflow-x-auto">
          {GHCR_DOCKERHUB_GUIDE}
        </pre>
      </div>
    </div>
  );
}
