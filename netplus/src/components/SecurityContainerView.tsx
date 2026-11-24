import React, { useCallback, useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  ExternalLink,
  KeyRound,
  Link2,
  Loader2,
  Lock,
  RefreshCw,
  Save,
  Sparkles,
  Unlink,
} from 'lucide-react';
import { translate, type TranslationKeys } from '../i18n/translations';
import { apiRequest, formatTimeAgo, getAuthToken } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { toast } from '../lib/toast';
import type {
  BoundOAuthAccount,
  LanguageCode,
  OAuthProviderId,
  OAuthProviderPublicConfig,
  SecurityConfig,
  TlsCertificateStatus,
} from '../types/models';

const OAUTH_PROVIDER_INFO: Record<
  OAuthProviderId,
  { name: string; docsHintZh: string; docsHintEn: string; consoleUrl: string }
> = {
  microsoft: {
    name: 'Microsoft (Entra ID / MSA)',
    docsHintZh: 'Azure Portal → 应用注册 → 添加 Web 重定向 URI，租户填 common 支持个人微软与工作账号。',
    docsHintEn: 'Azure Portal → App registrations → Web Redirect URI. Use tenant "common" for personal & work accounts.',
    consoleUrl: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
  },
  github: {
    name: 'GitHub',
    docsHintZh: 'GitHub Settings → Developer settings → OAuth Apps → New OAuth App。',
    docsHintEn: 'GitHub Settings → Developer settings → OAuth Apps → New OAuth App.',
    consoleUrl: 'https://github.com/settings/developers',
  },
  google: {
    name: 'Google',
    docsHintZh: 'Google Cloud Console → API 和服务 → 凭据 → 创建 OAuth 2.0 Web 客户端 ID。',
    docsHintEn: 'Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Web Client ID.',
    consoleUrl: 'https://console.cloud.google.com/apis/credentials',
  },
  apple: {
    name: 'Sign in with Apple',
    docsHintZh: 'Apple Developer → Identifiers (Services ID) + Keys (Sign in with Apple .p8 私钥)。',
    docsHintEn: 'Apple Developer → Identifiers (Services ID) + Keys (Sign in with Apple .p8 private key).',
    consoleUrl: 'https://developer.apple.com/account/resources/identifiers/list/serviceId',
  },
};

interface SecurityContainerViewProps {
  lang: LanguageCode;
  currentUsername: string;
  onUsernameChanged: (nextUsername: string) => void;
  onRefreshOverview: () => Promise<void>;
}

export function SecurityContainerView({
  lang,
  currentUsername,
  onUsernameChanged,
  onRefreshOverview,
}: SecurityContainerViewProps) {
  const t = (key: TranslationKeys) => translate(lang, key);
  const isZh = lang === 'zh-CN';
  const [config, setConfig] = useState<SecurityConfig | null>(null);
  const [tlsStatus, setTlsStatus] = useState<TlsCertificateStatus | null>(null);
  const [envManaged, setEnvManaged] = useState(false);
  const [activeSessions, setActiveSessions] = useState(1);
  const [saving, setSaving] = useState(false);
  const [reloadingTls, setReloadingTls] = useState(false);
  const [generatingCert, setGeneratingCert] = useState(false);
  const [showCustomCertForm, setShowCustomCertForm] = useState(false);
  const [customCertForm, setCustomCertForm] = useState({
    commonName: 'netplus.local',
    sanDomains: '',
    sanIps: '',
    days: 825,
  });
  const [updatingCreds, setUpdatingCreds] = useState(false);

  const [newUsername, setNewUsername] = useState(currentUsername);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  // Third-party OAuth providers & bound accounts state
  const [oauthProviders, setOauthProviders] = useState<OAuthProviderPublicConfig[]>([]);
  const [boundAccounts, setBoundAccounts] = useState<BoundOAuthAccount[]>([]);
  const [expandedOAuth, setExpandedOAuth] = useState<OAuthProviderId | null>(null);
  const [oauthForm, setOauthForm] = useState<{
    enabled: boolean;
    clientId: string;
    clientSecret: string;
    tenantId: string;
    teamId: string;
    keyId: string;
    privateKey: string;
  }>({
    enabled: true,
    clientId: '',
    clientSecret: '',
    tenantId: 'common',
    teamId: '',
    keyId: '',
    privateKey: '',
  });
  const [savingOAuth, setSavingOAuth] = useState<OAuthProviderId | null>(null);
  const [bindingOAuth, setBindingOAuth] = useState<OAuthProviderId | null>(null);
  const [unbindingId, setUnbindingId] = useState<string | null>(null);
  const [copiedCallback, setCopiedCallback] = useState<string | null>(null);

  const loadOAuthConfig = useCallback(async () => {
    try {
      const res = await apiRequest<{
        providers: OAuthProviderPublicConfig[];
        boundAccounts: BoundOAuthAccount[];
      }>('/api/security/oauth');
      setOauthProviders(res.providers || []);
      setBoundAccounts(res.boundAccounts || []);
    } catch {
      // ignore if endpoint unavailable
    }
  }, []);

  useEffect(() => {
    void apiRequest<{
      config: SecurityConfig;
      envManagedAdmin: boolean;
      adminUsername?: string;
      activeSessions: number;
      tlsStatus?: TlsCertificateStatus;
    }>('/api/security/config').then((res) => {
      setConfig(res.config);
      setEnvManaged(res.envManagedAdmin);
      if (res.adminUsername) setNewUsername(res.adminUsername);
      setActiveSessions(res.activeSessions);
      if (res.tlsStatus) setTlsStatus(res.tlsStatus);
    });
    void loadOAuthConfig();
  }, [loadOAuthConfig]);

  // Listen for OAuth bind popup postMessage
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as
        | {
            type?: string;
            payload?: {
              mode?: 'login' | 'bind';
              provider?: OAuthProviderId;
              account?: BoundOAuthAccount;
              error?: string;
            };
          }
        | null
        | undefined;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'OAUTH_AUTH_SUCCESS' && data.payload?.mode === 'bind') {
        setBindingOAuth(null);
        void loadOAuthConfig();
        const acct = data.payload.account;
        toast.success(
          isZh
            ? `已成功绑定 ${data.payload.provider?.toUpperCase()} 账号：${acct?.email || acct?.displayName || ''}`
            : `Bound ${data.payload.provider?.toUpperCase()} account: ${acct?.email || acct?.displayName || ''}`
        );
      } else if (data.type === 'OAUTH_AUTH_ERROR' && bindingOAuth) {
        setBindingOAuth(null);
        toast.error(data.payload?.error || (isZh ? '第三方账号绑定失败' : 'Account binding failed'));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [bindingOAuth, isZh, loadOAuthConfig]);

  const openProviderConfig = (p: OAuthProviderPublicConfig) => {
    if (expandedOAuth === p.provider) {
      setExpandedOAuth(null);
      return;
    }
    setExpandedOAuth(p.provider);
    setOauthForm({
      enabled: p.enabled,
      clientId: p.clientId || '',
      clientSecret: '',
      tenantId: p.tenantId || 'common',
      teamId: p.teamId || '',
      keyId: p.keyId || '',
      privateKey: '',
    });
  };

  const handleSaveOAuthProvider = async (e: React.FormEvent, provider: OAuthProviderId) => {
    e.preventDefault();
    setSavingOAuth(provider);
    try {
      await apiRequest(`/api/security/oauth/${provider}`, {
        method: 'PUT',
        body: JSON.stringify({
          enabled: oauthForm.enabled,
          clientId: oauthForm.clientId.trim(),
          clientSecret: oauthForm.clientSecret.trim() || undefined,
          tenantId: provider === 'microsoft' ? oauthForm.tenantId.trim() || 'common' : undefined,
          teamId: provider === 'apple' ? oauthForm.teamId.trim() : undefined,
          keyId: provider === 'apple' ? oauthForm.keyId.trim() : undefined,
          privateKey: provider === 'apple' && oauthForm.privateKey.trim() ? oauthForm.privateKey.trim() : undefined,
        }),
      });
      await loadOAuthConfig();
      setOauthForm((prev) => ({ ...prev, clientSecret: '', privateKey: '' }));
      toast.success(isZh ? `已保存 ${provider.toUpperCase()} OAuth 配置` : `Saved ${provider.toUpperCase()} OAuth config`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save OAuth config failed');
    } finally {
      setSavingOAuth(null);
    }
  };

  const handleStartBindOAuth = async (provider: OAuthProviderId) => {
    setBindingOAuth(provider);
    try {
      const res = await apiRequest<{ ok: boolean; url: string }>(
        `/api/auth/oauth/${provider}/url?mode=bind`
      );
      const width = 560;
      const height = 680;
      const left = Math.max(0, Math.round((window.screen.width - width) / 2));
      const top = Math.max(0, Math.round((window.screen.height - height) / 2));
      const popup = window.open(
        res.url,
        'netplus_oauth_bind',
        `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`
      );
      if (!popup) {
        setBindingOAuth(null);
        toast.error(
          isZh
            ? '浏览器拦截了授权弹窗，请允许本站点弹出窗口后重试'
            : 'Popup blocked by browser. Please allow popups and try again.'
        );
        return;
      }
      const pollClose = window.setInterval(() => {
        if (popup.closed) {
          window.clearInterval(pollClose);
          setBindingOAuth((cur) => (cur === provider ? null : cur));
        }
      }, 600);
    } catch (err) {
      setBindingOAuth(null);
      toast.error(err instanceof Error ? err.message : 'Failed to start OAuth binding');
    }
  };

  const handleUnbindAccount = async (acct: BoundOAuthAccount) => {
    setUnbindingId(acct.id);
    try {
      await apiRequest(`/api/security/oauth/bindings/${acct.id}`, { method: 'DELETE' });
      await loadOAuthConfig();
      toast.success(
        isZh
          ? `已解绑 ${acct.provider.toUpperCase()} 账号 (${acct.email || acct.displayName})`
          : `Unbound ${acct.provider.toUpperCase()} account`
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Unbind failed');
    } finally {
      setUnbindingId(null);
    }
  };

  const handleCopyCallback = async (provider: string, uri: string) => {
    const ok = await copyText(uri);
    if (ok) {
      setCopiedCallback(provider);
      setTimeout(() => setCopiedCallback((prev) => (prev === provider ? null : prev)), 1600);
      toast.success(isZh ? '已复制回调地址 (Redirect URI)' : 'Copied callback URI');
    }
  };

  const handleReloadTls = async () => {
    setReloadingTls(true);
    try {
      const res = await apiRequest<{ ok: boolean; message: string; status: TlsCertificateStatus }>(
        '/api/tls/reload',
        { method: 'POST' }
      );
      setTlsStatus(res.status);
      await onRefreshOverview();
      toast.show(res.message, res.ok ? 'success' : 'error');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'TLS reload failed';
      toast.error(msg);
    } finally {
      setReloadingTls(false);
    }
  };

  const handleGenerateCustomCert = async (e: React.FormEvent) => {
    e.preventDefault();
    setGeneratingCert(true);
    try {
      const res = await apiRequest<{ ok: boolean; message: string; status: TlsCertificateStatus }>(
        '/api/tls/generate',
        {
          method: 'POST',
          body: JSON.stringify(customCertForm),
        }
      );
      setTlsStatus(res.status);
      setShowCustomCertForm(false);
      await onRefreshOverview();
      toast.show(res.message, res.ok ? 'success' : 'error');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to generate certificate';
      toast.error(msg);
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
      if (!res.ok) {
        toast.error(isZh ? '下载公钥证书失败' : 'Failed to download certificate');
        return;
      }
      const pem = await res.text();
      const blob = new Blob([pem], { type: 'application/x-pem-file' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'netplus-cert.pem';
      a.click();
      URL.revokeObjectURL(url);
      toast.success(isZh ? '已下载公钥证书 netplus-cert.pem' : 'Downloaded netplus-cert.pem');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : isZh ? '下载公钥证书失败' : 'Download failed');
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
      toast.success(t('savedSuccessfully'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : isZh ? '保存配置失败' : 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedUser = newUsername.trim();
    if (trimmedUser && !/^[a-zA-Z0-9._-]{3,32}$/.test(trimmedUser)) {
      toast.error(t('usernameInvalid'));
      return;
    }
    if (newPassword && newPassword.length < 8) {
      toast.error(t('passwordTooShort'));
      return;
    }
    setUpdatingCreds(true);
    try {
      const res = await apiRequest<{
        ok: boolean;
        username: string;
        usernameChanged: boolean;
        passwordChanged: boolean;
      }>('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({
          currentPassword,
          newUsername: trimmedUser || undefined,
          newPassword: newPassword || undefined,
        }),
      });
      setCurrentPassword('');
      setNewPassword('');
      if (res.username) {
        setNewUsername(res.username);
        onUsernameChanged(res.username);
      }
      const successText = isZh
        ? res.usernameChanged && res.passwordChanged
          ? `管理员用户名（${res.username}）与密码均已更新`
          : res.usernameChanged
          ? `管理员用户名已修改为：${res.username}`
          : '管理员密码已更新'
        : t('savedSuccessfully');
      toast.success(successText);
    } catch (err) {
      const code = err instanceof Error ? err.message : 'Failed';
      const friendly =
        code === 'INVALID_CURRENT_PASSWORD'
          ? isZh
            ? '当前密码验证失败，请核对后重试'
            : 'Current password is incorrect'
          : code === 'NO_CHANGES_REQUESTED'
          ? isZh
            ? '请修改用户名或输入新密码后再保存'
            : 'Please change the username or enter a new password'
          : code === 'INVALID_USERNAME'
          ? t('usernameInvalid')
          : code === 'WEAK_PASSWORD'
          ? t('passwordTooShort')
          : code;
      toast.error(friendly);
    } finally {
      setUpdatingCreds(false);
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
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              {t('save')}
            </button>
          </div>
        </div>
      </form>

      {/* Administrator Account & Password Rotation */}
      {!envManaged && (
        <form
          onSubmit={handleUpdateCredentials}
          className="p-6 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-4"
        >
          <div className="pb-3 border-b border-slate-200 dark:border-slate-800">
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-white">
              {isZh ? '管理员账号与密码修改' : 'Administrator Account & Password'}
            </h2>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {isZh
                ? '可单独修改管理员用户名、单独修改密码或同时修改；保存前需验证当前密码。'
                : 'Update the administrator username, password, or both. Current password is required to authorize changes.'}
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
            <div>
              <label className="block font-medium mb-1.5">
                {isZh ? '管理员用户名' : 'Admin Username'}
              </label>
              <input
                type="text"
                required
                minLength={3}
                maxLength={32}
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                placeholder={isZh ? '3-32 位字母/数字/._-' : '3-32 chars (letters, digits, ._-)'}
                className="w-full px-3 py-2 font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block font-medium mb-1.5">
                {t('currentPassword')}
              </label>
              <input
                type="password"
                required
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder={isZh ? '输入当前密码验证身份' : 'Enter current password'}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block font-medium mb-1.5">
                {isZh ? '新密码（留空则仅改用户名）' : 'New Password (optional)'}
              </label>
              <input
                type="password"
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder={isZh ? '至少 8 位；不改密码请留空' : 'Min 8 chars; blank to keep'}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
              />
            </div>
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={updatingCreds}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
            >
              {updatingCreds && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {isZh ? '更新管理员凭据' : 'Update Credentials'}
            </button>
          </div>
        </form>
      )}

      {/* Third-Party OAuth Account Binding & SSO (Microsoft / GitHub / Google / Apple) */}
      <div className="p-6 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-200 dark:border-slate-800">
          <div>
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-white flex items-center gap-2">
              <Link2 className="w-4 h-4 text-blue-600 dark:text-blue-400" />
              {isZh
                ? '第三方账号登录与绑定（Microsoft / GitHub / Google / Apple）'
                : 'Third-Party SSO & Account Binding (Microsoft / GitHub / Google / Apple)'}
            </h2>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {isZh
                ? '为管理员账号绑定 Microsoft、GitHub、Google 或 Apple 账号后，可在登录页一键授权登录（仅已绑定的白名单账号允许登录，未绑定账号会被自动拒绝）。'
                : 'Bind your administrator account to Microsoft, GitHub, Google, or Apple to allow one-click OAuth sign-in. Only explicitly bound accounts can log in.'}
            </p>
          </div>
          <span className="font-mono text-xs text-slate-500 tabular-nums">
            {isZh ? `已绑定 ${boundAccounts.length} 个账号` : `${boundAccounts.length} bound account(s)`}
          </span>
        </div>

        {/* Bound Accounts List */}
        {boundAccounts.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-medium text-slate-700 dark:text-slate-300">
              {isZh ? '已绑定的登录账号' : 'Bound Accounts'}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
              {boundAccounts.map((acct) => (
                <div
                  key={acct.id}
                  className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 flex items-center justify-between gap-3 text-xs"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-950/70 text-blue-700 dark:text-blue-300 font-mono text-[10px] uppercase font-semibold">
                        {acct.provider}
                      </span>
                      <span className="font-semibold text-slate-900 dark:text-white truncate">
                        {acct.displayName || acct.email || acct.subject}
                      </span>
                    </div>
                    <div className="mt-1 font-mono text-[11px] text-slate-500 dark:text-slate-400 truncate">
                      {acct.email || acct.subject}
                      {acct.lastLoginAt
                        ? ` · ${isZh ? '最近登录' : 'Last login'} ${formatTimeAgo(acct.lastLoginAt)}`
                        : ` · ${isZh ? '绑定于' : 'Bound'} ${formatTimeAgo(acct.boundAt)}`}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={unbindingId === acct.id}
                    onClick={() => void handleUnbindAccount(acct)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-red-200 dark:border-red-900/60 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50 shrink-0"
                  >
                    {unbindingId === acct.id ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Unlink className="w-3.5 h-3.5" />
                    )}
                    {isZh ? '解绑' : 'Unbind'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* OAuth Provider Cards */}
        <div className="space-y-2.5">
          {oauthProviders.map((prov) => {
            const meta = OAUTH_PROVIDER_INFO[prov.provider];
            const isExpanded = expandedOAuth === prov.provider;
            const boundForProv = boundAccounts.filter((b) => b.provider === prov.provider);
            return (
              <div
                key={prov.provider}
                className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-950/40 overflow-hidden"
              >
                <div className="p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-slate-900 dark:text-white">{meta.name}</span>
                      <span
                        className={`font-mono text-[11px] font-medium ${
                          prov.configured && prov.enabled
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : prov.configured
                            ? 'text-amber-600 dark:text-amber-400'
                            : 'text-slate-400'
                        }`}
                      >
                        {prov.configured && prov.enabled
                          ? isZh
                            ? '已启用'
                            : 'Enabled'
                          : prov.configured
                          ? isZh
                            ? '已配置（未启用）'
                            : 'Configured (Disabled)'
                          : isZh
                          ? '未配置凭据'
                          : 'Not Configured'}
                      </span>
                      {prov.envManaged && (
                        <span className="text-[10px] font-mono text-slate-400">(ENV)</span>
                      )}
                      {boundForProv.length > 0 && (
                        <span className="text-[11px] text-blue-600 dark:text-blue-400 font-medium">
                          · {isZh ? `已绑 ${boundForProv.length} 个` : `${boundForProv.length} bound`}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                      <span>{isZh ? '回调 URI:' : 'Callback URI:'}</span>
                      <code className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800/80 font-mono text-[11px] text-slate-700 dark:text-slate-300 break-all">
                        {prov.callbackUri || ''}
                      </code>
                      <button
                        type="button"
                        onClick={() => void handleCopyCallback(prov.provider, prov.callbackUri || '')}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-700 hover:bg-white dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300"
                      >
                        {copiedCallback === prov.provider ? (
                          <Check className="w-3 h-3 text-emerald-500" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                        {isZh ? '复制' : 'Copy'}
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={!prov.configured || Boolean(bindingOAuth)}
                      onClick={() => void handleStartBindOAuth(prov.provider)}
                      title={
                        !prov.configured
                          ? isZh
                            ? '请先点击右侧「配置」填写 Client ID / Secret'
                            : 'Configure Client ID & Secret first'
                          : undefined
                      }
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-45 disabled:cursor-not-allowed whitespace-nowrap"
                    >
                      {bindingOAuth === prov.provider ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Link2 className="w-3.5 h-3.5" />
                      )}
                      {isZh ? '授权绑定账号' : 'Bind Account'}
                    </button>
                    <button
                      type="button"
                      onClick={() => openProviderConfig(prov)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
                    >
                      <KeyRound className="w-3.5 h-3.5" />
                      {isZh ? '配置' : 'Configure'}
                      {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <form
                    onSubmit={(e) => void handleSaveOAuthProvider(e, prov.provider)}
                    className="p-4 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-3.5 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                      <span>{isZh ? meta.docsHintZh : meta.docsHintEn}</span>
                      <a
                        href={meta.consoleUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline shrink-0"
                      >
                        {isZh ? '前往开发者后台' : 'Developer Console'}
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block font-medium mb-1">
                          {prov.provider === 'apple' ? 'Services ID (Client ID) *' : 'Client ID *'}
                        </label>
                        <input
                          required
                          value={oauthForm.clientId}
                          onChange={(e) => setOauthForm({ ...oauthForm, clientId: e.target.value })}
                          placeholder={
                            prov.provider === 'apple'
                              ? 'com.example.netplus.signin'
                              : 'OAuth Client ID'
                          }
                          className="w-full px-3 py-2 font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                        />
                      </div>

                      {prov.provider !== 'apple' && (
                        <div>
                          <label className="block font-medium mb-1">
                            Client Secret{' '}
                            {prov.hasClientSecret && (
                              <span className="text-emerald-600 dark:text-emerald-400 font-normal">
                                ({isZh ? '已加密保存，留空不改' : 'stored; blank to keep'})
                              </span>
                            )}
                          </label>
                          <input
                            type="password"
                            required={!prov.hasClientSecret}
                            value={oauthForm.clientSecret}
                            onChange={(e) => setOauthForm({ ...oauthForm, clientSecret: e.target.value })}
                            placeholder={prov.hasClientSecret ? '••••••••' : 'OAuth Client Secret'}
                            className="w-full px-3 py-2 font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                          />
                        </div>
                      )}

                      {prov.provider === 'microsoft' && (
                        <div>
                          <label className="block font-medium mb-1">
                            Tenant ID ({isZh ? '默认 common 支持个人微软与工作账号' : 'default: common'})
                          </label>
                          <input
                            value={oauthForm.tenantId}
                            onChange={(e) => setOauthForm({ ...oauthForm, tenantId: e.target.value })}
                            placeholder="common / consumers / organizations / <tenant-guid>"
                            className="w-full px-3 py-2 font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                          />
                        </div>
                      )}

                      {prov.provider === 'apple' && (
                        <>
                          <div>
                            <label className="block font-medium mb-1">Apple Team ID *</label>
                            <input
                              required
                              value={oauthForm.teamId}
                              onChange={(e) => setOauthForm({ ...oauthForm, teamId: e.target.value })}
                              placeholder="10-char Team ID"
                              className="w-full px-3 py-2 font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                            />
                          </div>
                          <div>
                            <label className="block font-medium mb-1">Apple Key ID *</label>
                            <input
                              required
                              value={oauthForm.keyId}
                              onChange={(e) => setOauthForm({ ...oauthForm, keyId: e.target.value })}
                              placeholder="10-char Key ID"
                              className="w-full px-3 py-2 font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                            />
                          </div>
                          <div className="sm:col-span-2">
                            <label className="block font-medium mb-1">
                              Apple Private Key (.p8 PEM){' '}
                              {prov.hasPrivateKey && (
                                <span className="text-emerald-600 dark:text-emerald-400 font-normal">
                                  ({isZh ? '已加密保存，留空不改' : 'stored; blank to keep'})
                                </span>
                              )}
                            </label>
                            <textarea
                              rows={3}
                              required={!prov.hasPrivateKey}
                              value={oauthForm.privateKey}
                              onChange={(e) => setOauthForm({ ...oauthForm, privateKey: e.target.value })}
                              placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"
                              className="w-full px-3 py-2 font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
                            />
                          </div>
                        </>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100 dark:border-slate-800">
                      <label className="inline-flex items-center gap-2 font-medium text-slate-700 dark:text-slate-300">
                        <input
                          type="checkbox"
                          checked={oauthForm.enabled}
                          onChange={(e) => setOauthForm({ ...oauthForm, enabled: e.target.checked })}
                          className="rounded accent-blue-600"
                        />
                        {isZh ? '在登录页显示并启用此登录方式' : 'Enable this provider on sign-in page'}
                      </label>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setExpandedOAuth(null)}
                          className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700"
                        >
                          {t('cancel')}
                        </button>
                        <button
                          type="submit"
                          disabled={savingOAuth === prov.provider}
                          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-50"
                        >
                          {savingOAuth === prov.provider ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Save className="w-3.5 h-3.5" />
                          )}
                          {t('save')}
                        </button>
                      </div>
                    </div>
                  </form>
                )}
              </div>
            );
          })}
        </div>
      </div>

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
              ? '优先使用只读挂载的外部 SSL 证书 /certs:ro（自动安全中转权限）；未挂载外部证书时，系统自动在 /data/certs 生成持久化自定义 ECDSA 证书并默认监听 HTTPS 3443 端口，可随时自定义域名/IP 重新签发。'
              : 'Mounted /certs:ro certificates take top priority. When no external cert is mounted, NetPlus automatically generates a persistent ECDSA self-signed certificate in /data/certs and enables HTTPS on port 3443.'}
          </p>
        </div>
      )}
    </div>
  );
}
