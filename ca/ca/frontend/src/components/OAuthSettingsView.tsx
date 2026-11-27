import React, { useCallback, useEffect, useState } from 'react';
import { KeyRound, Link2, RotateCcw, Settings2, Unlink, X } from 'lucide-react';
import {
  api,
  type DirectOAuthProviderConfig,
  type OAuthGatewayConfig,
  type OAuthProvider,
  type OAuthProviderInfo,
  type UserProfile,
} from '../lib/api';
import type { LocaleDict } from '../lib/i18n';
import { CopyButton } from './CopyButton';
import { FloatingToast } from './Toast';

type DirectProviderKey = 'microsoft' | 'github' | 'google';

interface OAuthSettingsViewProps {
  t: LocaleDict;
  user: UserProfile | null;
  isAdmin?: boolean;
  previewMode?: boolean;
  onUpdated: (u: UserProfile) => void;
}

const DIRECT_PROVIDERS: Array<{ key: DirectProviderKey; fallbackLabel: string; subtitle: string }> = [
  { key: 'microsoft', fallbackLabel: 'Microsoft Entra ID', subtitle: 'Azure AD / Work & Personal Accounts' },
  { key: 'github', fallbackLabel: 'GitHub', subtitle: 'GitHub OAuth App' },
  { key: 'google', fallbackLabel: 'Google', subtitle: 'Google Workspace / Cloud OAuth 2.0' },
];

export const OAuthSettingsView: React.FC<OAuthSettingsViewProps> = ({
  t,
  user,
  isAdmin = true,
  previewMode = false,
  onUpdated,
}) => {
  const [loading, setLoading] = useState(true);
  const [gwConfig, setGwConfig] = useState<OAuthGatewayConfig | null>(null);
  const [directConfigs, setDirectConfigs] = useState<DirectOAuthProviderConfig[]>([]);
  const [providers, setProviders] = useState<OAuthProviderInfo[]>([]);

  // Gateway config modal state
  const [gwEditorOpen, setGwEditorOpen] = useState(false);
  const [gwIssuer, setGwIssuer] = useState('');
  const [gwClientId, setGwClientId] = useState('');
  const [gwClientSecret, setGwClientSecret] = useState('');
  const [gwClearSecret, setGwClearSecret] = useState(false);
  const [gwRedirectUri, setGwRedirectUri] = useState('');
  const [gwScopes, setGwScopes] = useState('openid profile email');
  const [gwAuthEndpoint, setGwAuthEndpoint] = useState('');
  const [gwTokenEndpoint, setGwTokenEndpoint] = useState('');
  const [gwUserinfoEndpoint, setGwUserinfoEndpoint] = useState('');
  const [gwSaving, setGwSaving] = useState(false);

  // Direct IdP config modal state
  const [directEditorProvider, setDirectEditorProvider] = useState<DirectProviderKey | null>(null);
  const [dpClientId, setDpClientId] = useState('');
  const [dpClientSecret, setDpClientSecret] = useState('');
  const [dpClearSecret, setDpClearSecret] = useState(false);
  const [dpTenantId, setDpTenantId] = useState('common');
  const [dpRedirectUri, setDpRedirectUri] = useState('');
  const [dpSaving, setDpSaving] = useState(false);

  const [socialBusy, setSocialBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const originFallback = typeof window !== 'undefined' ? window.location.origin : 'https://localhost:8443';

  const getDefaultGatewayCallback = useCallback(
    (cfg?: OAuthGatewayConfig | null) =>
      cfg?.default_callback_url || `${originFallback}/auth/callback`,
    [originFallback]
  );

  const getDefaultDirectCallback = useCallback(
    (prov: DirectProviderKey, cfg?: DirectOAuthProviderConfig | null) =>
      cfg?.default_callback_url || `${originFallback}/api/auth/oauth/${prov}/callback`,
    [originFallback]
  );

  const syncGatewayForm = useCallback(
    (cfg: OAuthGatewayConfig) => {
      const defCb = getDefaultGatewayCallback(cfg);
      setGwConfig(cfg);
      setGwIssuer(cfg.issuer || '');
      setGwClientId(cfg.client_id || '');
      setGwClientSecret('');
      setGwClearSecret(false);
      // Prefill actual default callback URL rather than leaving empty
      setGwRedirectUri(cfg.redirect_uri?.trim() || defCb);
      setGwScopes(cfg.scopes || 'openid profile email');
      setGwAuthEndpoint(cfg.authorization_endpoint || '');
      setGwTokenEndpoint(cfg.token_endpoint || '');
      setGwUserinfoEndpoint(cfg.userinfo_endpoint || '');
    },
    [getDefaultGatewayCallback]
  );

  const openDirectEditor = (prov: DirectProviderKey) => {
    const cfg = directConfigs.find((d) => d.provider === prov) || null;
    const defCb = getDefaultDirectCallback(prov, cfg);
    setDpClientId(cfg?.client_id || '');
    setDpClientSecret('');
    setDpClearSecret(false);
    setDpTenantId(cfg?.tenant_id || 'common');
    // Prefill actual default callback URL
    setDpRedirectUri(cfg?.redirect_uri?.trim() || defCb);
    setError('');
    setNotice('');
    setDirectEditorProvider(prov);
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([
      isAdmin ? api.getOAuthGatewayConfig().catch(() => null) : Promise.resolve(null),
      api.getOAuthProviders().catch(() => null),
    ])
      .then(([gwRes, provRes]) => {
        if (!active) return;
        if (gwRes?.gateway) syncGatewayForm(gwRes.gateway);
        if (gwRes?.direct_providers) setDirectConfigs(gwRes.direct_providers);
        if (gwRes?.providers) {
          setProviders(gwRes.providers);
        } else if (provRes?.providers) {
          setProviders(provRes.providers);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [isAdmin, syncGatewayForm]);

  useEffect(() => {
    if (!gwEditorOpen && !directEditorProvider) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setGwEditorOpen(false);
        setDirectEditorProvider(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [gwEditorOpen, directEditorProvider]);

  // Handle same-tab OAuth bind callback query params (?oauth_linked=... / ?oauth_bind_error=...)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const linkedProv = params.get('oauth_linked');
    const bindErr = params.get('oauth_bind_error');
    if (!linkedProv && !bindErr) return;

    params.delete('oauth_linked');
    params.delete('oauth_bind_error');
    const nextQuery = params.toString();
    const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}${window.location.hash}`;
    window.history.replaceState(null, '', nextUrl);

    if (bindErr) {
      setError(bindErr);
      return;
    }
    if (linkedProv) {
      const label =
        linkedProv === 'wimotek'
          ? 'wimotek/OAuth'
          : DIRECT_PROVIDERS.find((d) => d.key === linkedProv)?.fallbackLabel || linkedProv;
      setNotice(`Linked ${label} account successfully.`);
      api
        .getProfile()
        .then((res) => onUpdated(res.user))
        .catch(() => {});
    }
  }, [onUpdated]);

  // Listen for OAuth popup completion when running inside an embedded iframe preview
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'OAUTH_AUTH_ERROR') {
        setSocialBusy(null);
        setError(String(data.error || 'OAuth binding failed'));
        return;
      }
      if (data.type === 'OAUTH_AUTH_SUCCESS' && data.mode === 'bind') {
        setSocialBusy(null);
        setError('');
        const prov = String(data.provider || 'SSO');
        const label =
          prov === 'wimotek'
            ? 'wimotek/OAuth'
            : DIRECT_PROVIDERS.find((d) => d.key === prov)?.fallbackLabel || prov;
        setNotice(`Linked ${label} account successfully.`);
        if (data.user) {
          onUpdated(data.user as UserProfile);
        } else {
          api
            .getProfile()
            .then((res) => onUpdated(res.user))
            .catch(() => {});
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onUpdated]);

  const applyAdminResponse = (res: {
    gateway?: OAuthGatewayConfig;
    direct_providers?: DirectOAuthProviderConfig[];
    providers?: OAuthProviderInfo[];
  }) => {
    if (res.gateway) syncGatewayForm(res.gateway);
    if (res.direct_providers) setDirectConfigs(res.direct_providers);
    if (res.providers) setProviders(res.providers);
  };

  const handleSaveGateway = async (e: React.FormEvent) => {
    e.preventDefault();
    setGwSaving(true);
    setError('');
    setNotice('');
    try {
      const defCb = getDefaultGatewayCallback(gwConfig);
      const trimmedRedirect = gwRedirectUri.trim();
      const res = await api.saveOAuthGatewayConfig({
        issuer: gwIssuer.trim(),
        client_id: gwClientId.trim(),
        client_secret: gwClientSecret.trim() || undefined,
        clear_secret: gwClearSecret,
        // Save empty override when equal to default so host changes continue to auto-resolve
        redirect_uri: trimmedRedirect === defCb ? '' : trimmedRedirect,
        scopes: gwScopes.trim() || 'openid profile email',
        authorization_endpoint: gwAuthEndpoint.trim(),
        token_endpoint: gwTokenEndpoint.trim(),
        userinfo_endpoint: gwUserinfoEndpoint.trim(),
      });
      applyAdminResponse(res);
      setGwEditorOpen(false);
      setNotice(t.profile.gatewaySaved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save gateway parameters');
    } finally {
      setGwSaving(false);
    }
  };

  const handleResetGateway = async () => {
    setGwSaving(true);
    setError('');
    setNotice('');
    try {
      const res = await api.saveOAuthGatewayConfig({
        issuer: '',
        client_id: '',
        client_secret: '',
        clear_secret: true,
        redirect_uri: '',
        scopes: 'openid profile email',
        authorization_endpoint: '',
        token_endpoint: '',
        userinfo_endpoint: '',
      });
      applyAdminResponse(res);
      setGwEditorOpen(false);
      setNotice(t.profile.gatewaySaved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset gateway parameters');
    } finally {
      setGwSaving(false);
    }
  };

  const handleSaveDirectProvider = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!directEditorProvider) return;
    setDpSaving(true);
    setError('');
    setNotice('');
    try {
      const existing = directConfigs.find((d) => d.provider === directEditorProvider) || null;
      const defCb = getDefaultDirectCallback(directEditorProvider, existing);
      const trimmedRedirect = dpRedirectUri.trim();
      const res = await api.saveDirectOAuthProviderConfig(directEditorProvider, {
        client_id: dpClientId.trim(),
        client_secret: dpClientSecret.trim() || undefined,
        clear_secret: dpClearSecret,
        tenant_id: directEditorProvider === 'microsoft' ? dpTenantId.trim() || 'common' : undefined,
        redirect_uri: trimmedRedirect === defCb ? '' : trimmedRedirect,
      });
      applyAdminResponse(res);
      setDirectEditorProvider(null);
      setNotice(t.profile.gatewaySaved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save provider configuration');
    } finally {
      setDpSaving(false);
    }
  };

  const handleResetDirectProvider = async () => {
    if (!directEditorProvider) return;
    setDpSaving(true);
    setError('');
    setNotice('');
    try {
      const res = await api.saveDirectOAuthProviderConfig(directEditorProvider, {
        client_id: '',
        client_secret: '',
        clear_secret: true,
        tenant_id: directEditorProvider === 'microsoft' ? 'common' : undefined,
        redirect_uri: '',
      });
      applyAdminResponse(res);
      setDirectEditorProvider(null);
      setNotice(t.profile.gatewaySaved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset provider configuration');
    } finally {
      setDpSaving(false);
    }
  };

  const handleBindSocial = async (provider: OAuthProvider) => {
    setSocialBusy(provider);
    setError('');
    setNotice('');
    try {
      const info = await api.getOAuthUrl(provider, 'bind');
      if (info.configured && info.url) {
        const inIframe = typeof window !== 'undefined' && window.self !== window.top;
        if (!inIframe) {
          window.location.href = info.url;
          return;
        }
        const popup = window.open(
          info.url,
          `wimotek_oauth_${provider}`,
          'width=540,height=680,menubar=no,toolbar=no,status=no'
        );
        if (!popup) {
          setSocialBusy(null);
          setError('Popup blocked by browser. Please allow popups for this site.');
        }
        return;
      }
      if (info.preview_mode || previewMode) {
        const sim = await api.demoOAuthSimulate(provider, 'bind');
        if (sim.user) {
          onUpdated(sim.user);
        }
        setNotice(`Preview mode: linked ${provider} account.`);
        setSocialBusy(null);
        return;
      }
      setError(
        provider === 'wimotek'
          ? 'wimotek/OAuth gateway is not configured yet. Click Configure to set Issuer, Client ID & Client Secret.'
          : `${DIRECT_PROVIDERS.find((d) => d.key === provider)?.fallbackLabel || provider} is not configured yet. Click Configure to add Client ID & Client Secret.`
      );
      setSocialBusy(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to initiate SSO binding');
      setSocialBusy(null);
    }
  };

  const handleUnbindSocial = async (provider: OAuthProvider) => {
    setSocialBusy(provider);
    setError('');
    setNotice('');
    try {
      const res = await api.unlinkSocialAccount(provider);
      onUpdated(res.user);
      setNotice(`Unlinked ${provider}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unlink account');
    } finally {
      setSocialBusy(null);
    }
  };

  const wMeta = providers.find((p) => p.provider === 'wimotek');
  const activeIssuer = gwConfig?.issuer || wMeta?.issuer || '';
  const isGatewayConfigured = Boolean(gwConfig ? gwConfig.configured : wMeta?.configured);
  const defaultGatewayCallback = getDefaultGatewayCallback(gwConfig);
  const activeGatewayCallback =
    gwConfig?.callback_url || wMeta?.callback_url || defaultGatewayCallback;
  const isCustomGatewayCallback = Boolean(gwConfig?.redirect_uri?.trim());

  const linkedMap = new Map((user?.social_accounts || []).map((s) => [s.provider, s]));
  const wLinked = linkedMap.get('wimotek');

  const activeDirectConfig = directEditorProvider
    ? directConfigs.find((d) => d.provider === directEditorProvider) || null
    : null;
  const activeDirectMeta = directEditorProvider
    ? DIRECT_PROVIDERS.find((d) => d.key === directEditorProvider) || null
    : null;
  const activeDirectDefaultCb = directEditorProvider
    ? getDefaultDirectCallback(directEditorProvider, activeDirectConfig)
    : '';

  const formatSource = (src?: string) =>
    src === 'database' ? 'Database' : src === 'env' ? 'Environment' : '';

  return (
    <div className="max-w-4xl space-y-6">
      <FloatingToast
        error={error}
        notice={notice}
        onDismissError={() => setError('')}
        onDismissNotice={() => setNotice('')}
      />

      {/* Unified Page Header */}
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <KeyRound className="w-5 h-5 text-teal-700 shrink-0" aria-hidden="true" />
          <h2 className="font-display text-xl font-bold text-slate-900">{t.nav.oauth}</h2>
        </div>
        <p className="text-sm text-slate-600">{t.profile.wimotekGatewayDesc}</p>
      </div>

      {loading ? (
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3" aria-busy="true">
          <div className="h-12 bg-slate-100 rounded-lg animate-pulse" />
          <div className="h-10 bg-slate-100 rounded-lg animate-pulse" />
          <div className="h-10 bg-slate-100 rounded-lg animate-pulse" />
        </div>
      ) : (
        <>
          {/* Section 1: Unified Primary Gateway (wimotek/OAuth) */}
          <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="p-5 sm:p-6 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 border-b border-slate-100">
              <div className="space-y-1.5 min-w-0">
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  <h3 className="font-display text-base font-bold text-slate-900">
                    {t.profile.wimotekGatewayTitle}
                  </h3>
                  <span
                    className={`text-xs font-semibold ${
                      isGatewayConfigured ? 'text-emerald-700' : 'text-amber-700'
                    }`}
                  >
                    {isGatewayConfigured
                      ? t.profile.gatewayConfigured
                      : t.profile.gatewayNotConfigured}
                  </span>
                  {formatSource(gwConfig?.source) && (
                    <span className="text-[11px] font-mono text-slate-400">
                      · {formatSource(gwConfig?.source)}
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-500">
                  OIDC 1.0 · OAuth 2.0 PKCE S256
                  {activeIssuer && (
                    <>
                      {' · '}
                      <code dir="ltr" className="font-mono text-slate-700 break-all">
                        {activeIssuer}
                      </code>
                    </>
                  )}
                </div>
                {user && (
                  <div className="text-xs pt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className={wLinked ? 'text-teal-700 font-medium' : 'text-slate-500'}>
                      {wLinked ? t.profile.socialLinked : t.profile.socialNotLinked}
                    </span>
                    {wLinked && (
                      <span className="text-slate-600 font-mono text-[11px] break-all">
                        ({wLinked.email || wLinked.display_name})
                      </span>
                    )}
                  </div>
                )}
              </div>

              <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 shrink-0">
                {isAdmin && (
                  <button
                    type="button"
                    onClick={() => {
                      if (gwConfig) {
                        syncGatewayForm(gwConfig);
                      } else {
                        setGwRedirectUri(defaultGatewayCallback);
                      }
                      setError('');
                      setNotice('');
                      setGwEditorOpen(true);
                    }}
                    className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 min-h-[38px] rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 text-xs font-medium cursor-pointer whitespace-nowrap"
                  >
                    <Settings2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    <span>{t.profile.gatewayEditBtn}</span>
                  </button>
                )}

                {user &&
                  (wLinked ? (
                    <button
                      type="button"
                      disabled={socialBusy === 'wimotek'}
                      onClick={() => handleUnbindSocial('wimotek')}
                      className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 min-h-[38px] rounded-lg border border-red-200 bg-white text-red-700 hover:bg-red-50 text-xs font-medium cursor-pointer whitespace-nowrap"
                    >
                      <Unlink className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>{t.common.unbind}</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={socialBusy === 'wimotek' || (!isGatewayConfigured && !previewMode)}
                      title={
                        !isGatewayConfigured && !previewMode
                          ? t.profile.gatewayUnconfiguredNotice
                          : undefined
                      }
                      onClick={() => handleBindSocial('wimotek')}
                      className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 min-h-[38px] rounded-lg bg-[#0F766E] hover:bg-[#115E59] disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium cursor-pointer whitespace-nowrap"
                    >
                      <Link2 className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>{socialBusy === 'wimotek' ? '...' : t.common.bind}</span>
                    </button>
                  ))}
              </div>
            </div>

            {/* Compact Configuration Summary Rows */}
            <dl className="px-5 sm:px-6 divide-y divide-slate-100 text-xs bg-slate-50/50">
              <div className="py-2.5 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4">
                <dt className="font-medium text-slate-500 sm:w-36 shrink-0">
                  Callback URL{' '}
                  <span className="font-normal text-slate-400">
                    ({isCustomGatewayCallback ? t.profile.gatewayCallbackCustomTag : t.profile.gatewayCallbackAutoTag})
                  </span>
                </dt>
                <dd className="flex items-center justify-between gap-2 min-w-0 flex-1">
                  <code dir="ltr" className="font-mono text-slate-800 break-all sm:truncate">
                    {activeGatewayCallback}
                  </code>
                  <CopyButton
                    compact
                    value={activeGatewayCallback}
                    label={t.common.copy}
                    copiedLabel={t.common.copied}
                  />
                </dd>
              </div>

              {isAdmin && (gwConfig?.client_id || gwConfig?.has_client_secret) && (
                <div className="py-2.5 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4">
                  <dt className="font-medium text-slate-500 sm:w-36 shrink-0">Credentials</dt>
                  <dd className="flex flex-wrap items-center gap-x-4 gap-y-1 min-w-0 flex-1 font-mono text-slate-700">
                    {gwConfig?.client_id && (
                      <span className="truncate">
                        ID: <strong className="font-medium text-slate-900">{gwConfig.client_id}</strong>
                      </span>
                    )}
                    {gwConfig?.has_client_secret && (
                      <span className="text-emerald-700">
                        Secret: {gwConfig.client_secret_masked || '****'}
                      </span>
                    )}
                    <span className="text-slate-500">
                      Scopes: {gwConfig?.scopes || 'openid profile email'}
                    </span>
                  </dd>
                </div>
              )}
            </dl>
          </section>

          {/* Section 2: Direct IdP Connections (Microsoft / GitHub / Google) */}
          <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 sm:px-6 py-4 border-b border-slate-100">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Direct IdP Connections
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Configure and link Microsoft Entra ID, GitHub, or Google directly alongside or instead of wimotek/OAuth.
              </p>
            </div>

            <div className="divide-y divide-slate-100">
              {DIRECT_PROVIDERS.map(({ key, fallbackLabel, subtitle }) => {
                const cfg = directConfigs.find((d) => d.provider === key);
                const meta = providers.find((p) => p.provider === key);
                const linked = linkedMap.get(key);
                const configured = Boolean(cfg ? cfg.configured : meta?.configured);
                const callbackUrl =
                  cfg?.callback_url ||
                  meta?.callback_url ||
                  getDefaultDirectCallback(key, cfg);
                const label = cfg?.label || meta?.label || fallbackLabel;
                const src = formatSource(cfg?.source);

                return (
                  <div key={key} className="p-5 sm:px-6 space-y-3">
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                          <span className="font-semibold text-slate-900">{label}</span>
                          <span
                            className={`text-xs font-medium ${
                              configured ? 'text-emerald-700' : 'text-slate-400'
                            }`}
                          >
                            · {configured ? t.profile.gatewayConfigured : t.profile.gatewayNotConfigured}
                          </span>
                          {src && (
                            <span className="text-[11px] font-mono text-slate-400">· {src}</span>
                          )}
                        </div>
                        <div className="text-xs text-slate-500 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span>{subtitle}</span>
                          {key === 'microsoft' && cfg?.tenant_id && configured && (
                            <span className="font-mono text-[11px] text-slate-500">
                              · Tenant: {cfg.tenant_id}
                            </span>
                          )}
                        </div>
                        {user && (
                          <div className="text-xs flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className={linked ? 'text-teal-700 font-medium' : 'text-slate-500'}>
                              {linked ? t.profile.socialLinked : t.profile.socialNotLinked}
                            </span>
                            {linked && (
                              <span className="font-mono text-[11px] text-slate-600 break-all">
                                ({linked.email || linked.display_name})
                              </span>
                            )}
                          </div>
                        )}
                      </div>

                      <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 shrink-0">
                        {isAdmin && (
                          <button
                            type="button"
                            onClick={() => openDirectEditor(key)}
                            className="inline-flex items-center justify-center gap-1.5 px-3 py-2 min-h-[36px] rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 text-xs font-medium cursor-pointer whitespace-nowrap"
                          >
                            <Settings2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                            <span>{t.profile.gatewayEditBtn}</span>
                          </button>
                        )}
                        {user &&
                          (linked ? (
                            <button
                              type="button"
                              disabled={socialBusy === key}
                              onClick={() => handleUnbindSocial(key)}
                              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 min-h-[36px] rounded-lg border border-red-200 bg-white text-red-700 hover:bg-red-50 text-xs font-medium cursor-pointer whitespace-nowrap"
                            >
                              <Unlink className="w-3.5 h-3.5" aria-hidden="true" />
                              <span>{t.common.unbind}</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={socialBusy === key || (!configured && !previewMode)}
                              title={
                                !configured && !previewMode
                                  ? `Configure ${label} credentials first`
                                  : undefined
                              }
                              onClick={() => handleBindSocial(key)}
                              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 min-h-[36px] rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-45 disabled:cursor-not-allowed text-white text-xs font-medium cursor-pointer whitespace-nowrap"
                            >
                              <Link2 className="w-3.5 h-3.5" aria-hidden="true" />
                              <span>{socialBusy === key ? '...' : t.common.bind}</span>
                            </button>
                          ))}
                      </div>
                    </div>

                    {/* Callback URL Strip */}
                    <div className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 border border-slate-200/70 px-3 py-1.5 text-[11px]">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-slate-500 shrink-0">Callback:</span>
                        <code dir="ltr" className="font-mono text-slate-700 truncate">
                          {callbackUrl}
                        </code>
                      </div>
                      <CopyButton
                        compact
                        value={callbackUrl}
                        label={t.common.copy}
                        copiedLabel={t.common.copied}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}

      {/* Modal 1: Admin-Editable wimotek/OAuth Gateway Modal */}
      {gwEditorOpen && isAdmin && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-[1px] flex items-center justify-center p-4"
          onClick={(ev) => {
            if (ev.target === ev.currentTarget) setGwEditorOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="oauth-gateway-modal-title"
            className="bg-white border border-slate-200 rounded-2xl max-w-2xl w-full max-h-[90vh] flex flex-col overflow-hidden shadow-xl"
          >
            <div className="px-5 sm:px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <h3
                  id="oauth-gateway-modal-title"
                  className="font-display text-base font-bold text-slate-900 truncate"
                >
                  {t.profile.wimotekGatewayTitle}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">{t.profile.gatewayEditBtn}</p>
              </div>
              <button
                type="button"
                onClick={() => setGwEditorOpen(false)}
                aria-label="Close modal"
                className="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 cursor-pointer shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveGateway} className="p-5 sm:p-6 space-y-4 overflow-y-auto">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                <div className="md:col-span-2">
                  <label htmlFor="gw-issuer" className="block text-xs font-medium text-slate-700 mb-1">
                    {t.profile.gatewayIssuerLabel}
                  </label>
                  <input
                    id="gw-issuer"
                    type="url"
                    value={gwIssuer}
                    onChange={(e) => setGwIssuer(e.target.value)}
                    placeholder={t.profile.gatewayIssuerPlaceholder}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                  />
                </div>

                <div>
                  <label htmlFor="gw-client-id" className="block text-xs font-medium text-slate-700 mb-1">
                    {t.profile.gatewayClientIdLabel}
                  </label>
                  <input
                    id="gw-client-id"
                    type="text"
                    value={gwClientId}
                    onChange={(e) => setGwClientId(e.target.value)}
                    placeholder={t.profile.gatewayClientIdPlaceholder}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                  />
                </div>

                <div>
                  <label htmlFor="gw-scopes" className="block text-xs font-medium text-slate-700 mb-1">
                    {t.profile.gatewayScopesLabel}
                  </label>
                  <input
                    id="gw-scopes"
                    type="text"
                    value={gwScopes}
                    onChange={(e) => setGwScopes(e.target.value)}
                    placeholder="openid profile email"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                  />
                </div>

                <div className="md:col-span-2">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                    <label htmlFor="gw-client-secret" className="block text-xs font-medium text-slate-700">
                      {t.profile.gatewayClientSecretLabel}
                    </label>
                    {gwConfig?.has_client_secret && (
                      <span className="text-[11px] font-mono text-emerald-700">
                        Saved: {gwConfig.client_secret_masked}
                      </span>
                    )}
                  </div>
                  <input
                    id="gw-client-secret"
                    type="password"
                    autoComplete="new-password"
                    value={gwClientSecret}
                    onChange={(e) => {
                      setGwClientSecret(e.target.value);
                      if (e.target.value) setGwClearSecret(false);
                    }}
                    placeholder={
                      gwConfig?.has_client_secret
                        ? t.profile.gatewayClientSecretKeepPlaceholder
                        : t.profile.gatewayClientSecretPlaceholder
                    }
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                  />
                  {gwConfig?.has_client_secret && (
                    <label className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] text-slate-600 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={gwClearSecret}
                        onChange={(e) => setGwClearSecret(e.target.checked)}
                        className="h-3.5 w-3.5 rounded border-slate-300 text-teal-700"
                      />
                      <span>{t.profile.gatewayClearSecret}</span>
                    </label>
                  )}
                </div>

                <div className="md:col-span-2">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <label htmlFor="gw-redirect-uri" className="block text-xs font-medium text-slate-700">
                      {t.profile.gatewayCallbackLabel}
                    </label>
                    {gwRedirectUri.trim() !== defaultGatewayCallback && (
                      <button
                        type="button"
                        onClick={() => setGwRedirectUri(defaultGatewayCallback)}
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-teal-700 hover:text-teal-900 cursor-pointer"
                      >
                        <RotateCcw className="w-3 h-3" aria-hidden="true" />
                        <span>Default</span>
                      </button>
                    )}
                  </div>
                  <input
                    id="gw-redirect-uri"
                    type="url"
                    value={gwRedirectUri}
                    onChange={(e) => setGwRedirectUri(e.target.value)}
                    placeholder={defaultGatewayCallback}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                  />
                  <p className="mt-1.5 text-[11px] text-slate-500 leading-relaxed">
                    {t.profile.gatewayCallbackHint}
                  </p>
                </div>
              </div>

              <details className="text-xs border-t border-slate-100 pt-3">
                <summary className="cursor-pointer font-medium text-slate-600 hover:text-slate-900 select-none">
                  {t.profile.gatewayAdvancedEndpoints}
                </summary>
                <p className="mt-2 text-[11px] text-slate-500 leading-relaxed">
                  Optional: if the CA container cannot resolve your public OAuth hostname via Docker DNS (127.0.0.11), set internal container/LAN URLs for Token &amp; Userinfo endpoints below while keeping Issuer set to your public browser URL.
                </p>
                <div className="mt-3 grid grid-cols-1 gap-3">
                  <div>
                    <label htmlFor="gw-auth-ep" className="block text-[11px] font-medium text-slate-600 mb-1">
                      Authorization Endpoint (Browser)
                    </label>
                    <input
                      id="gw-auth-ep"
                      type="url"
                      value={gwAuthEndpoint}
                      onChange={(e) => setGwAuthEndpoint(e.target.value)}
                      placeholder="Auto — e.g. https://auth.example.com/oauth/authorize"
                      className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-mono text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label htmlFor="gw-token-ep" className="block text-[11px] font-medium text-slate-600 mb-1">
                      Token Endpoint (Server-to-Server / Internal)
                    </label>
                    <input
                      id="gw-token-ep"
                      type="url"
                      value={gwTokenEndpoint}
                      onChange={(e) => setGwTokenEndpoint(e.target.value)}
                      placeholder="Auto — e.g. http://oauth-service:8080/oauth/token"
                      className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-mono text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label htmlFor="gw-userinfo-ep" className="block text-[11px] font-medium text-slate-600 mb-1">
                      Userinfo Endpoint (Server-to-Server / Internal)
                    </label>
                    <input
                      id="gw-userinfo-ep"
                      type="url"
                      value={gwUserinfoEndpoint}
                      onChange={(e) => setGwUserinfoEndpoint(e.target.value)}
                      placeholder="Auto — e.g. http://oauth-service:8080/oauth/userinfo"
                      className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-mono text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                    />
                  </div>
                </div>
              </details>

              <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2.5 pt-4 border-t border-slate-100">
                <button
                  type="button"
                  disabled={gwSaving}
                  onClick={handleResetGateway}
                  className="px-3.5 py-2 min-h-[40px] rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-xs font-medium cursor-pointer w-full sm:w-auto"
                >
                  {t.profile.gatewayResetBtn}
                </button>
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setGwEditorOpen(false)}
                    className="px-3.5 py-2 min-h-[40px] rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-xs font-medium cursor-pointer"
                  >
                    {t.common.close}
                  </button>
                  <button
                    type="submit"
                    disabled={gwSaving}
                    className="px-4 py-2 min-h-[40px] rounded-lg bg-[#0F766E] hover:bg-[#115E59] disabled:opacity-60 text-white text-xs font-medium cursor-pointer whitespace-nowrap"
                  >
                    {gwSaving ? '...' : t.profile.gatewaySaveBtn}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal 2: Admin-Editable Direct IdP Modal (Microsoft / GitHub / Google) */}
      {directEditorProvider && isAdmin && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-[1px] flex items-center justify-center p-4"
          onClick={(ev) => {
            if (ev.target === ev.currentTarget) setDirectEditorProvider(null);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="direct-idp-modal-title"
            className="bg-white border border-slate-200 rounded-2xl max-w-lg w-full max-h-[90vh] flex flex-col overflow-hidden shadow-xl"
          >
            <div className="px-5 sm:px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <h3
                  id="direct-idp-modal-title"
                  className="font-display text-base font-bold text-slate-900 truncate"
                >
                  {activeDirectConfig?.label || activeDirectMeta?.fallbackLabel}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">{activeDirectMeta?.subtitle}</p>
              </div>
              <button
                type="button"
                onClick={() => setDirectEditorProvider(null)}
                aria-label="Close modal"
                className="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 cursor-pointer shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveDirectProvider} className="p-5 sm:p-6 space-y-4 overflow-y-auto">
              {directEditorProvider === 'microsoft' && (
                <div>
                  <label htmlFor="dp-tenant-id" className="block text-xs font-medium text-slate-700 mb-1">
                    Tenant ID
                  </label>
                  <input
                    id="dp-tenant-id"
                    type="text"
                    value={dpTenantId}
                    onChange={(e) => setDpTenantId(e.target.value)}
                    placeholder="common"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                  />
                  <p className="mt-1 text-[11px] text-slate-500">
                    Use <code className="font-mono">common</code> for multi-tenant + personal accounts, or your Entra Directory (tenant) ID.
                  </p>
                </div>
              )}

              <div>
                <label htmlFor="dp-client-id" className="block text-xs font-medium text-slate-700 mb-1">
                  {t.profile.gatewayClientIdLabel}
                </label>
                <input
                  id="dp-client-id"
                  type="text"
                  value={dpClientId}
                  onChange={(e) => setDpClientId(e.target.value)}
                  placeholder="Enter OAuth Client ID"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                />
              </div>

              <div>
                <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                  <label htmlFor="dp-client-secret" className="block text-xs font-medium text-slate-700">
                    {t.profile.gatewayClientSecretLabel}
                  </label>
                  {activeDirectConfig?.has_client_secret && (
                    <span className="text-[11px] font-mono text-emerald-700">
                      Saved: {activeDirectConfig.client_secret_masked}
                    </span>
                  )}
                </div>
                <input
                  id="dp-client-secret"
                  type="password"
                  autoComplete="new-password"
                  value={dpClientSecret}
                  onChange={(e) => {
                    setDpClientSecret(e.target.value);
                    if (e.target.value) setDpClearSecret(false);
                  }}
                  placeholder={
                    activeDirectConfig?.has_client_secret
                      ? t.profile.gatewayClientSecretKeepPlaceholder
                      : t.profile.gatewayClientSecretPlaceholder
                  }
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                />
                {activeDirectConfig?.has_client_secret && (
                  <label className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] text-slate-600 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={dpClearSecret}
                      onChange={(e) => setDpClearSecret(e.target.checked)}
                      className="h-3.5 w-3.5 rounded border-slate-300 text-teal-700"
                    />
                    <span>{t.profile.gatewayClearSecret}</span>
                  </label>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <label htmlFor="dp-redirect-uri" className="block text-xs font-medium text-slate-700">
                    {t.profile.gatewayCallbackLabel}
                  </label>
                  {dpRedirectUri.trim() !== activeDirectDefaultCb && (
                    <button
                      type="button"
                      onClick={() => setDpRedirectUri(activeDirectDefaultCb)}
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-teal-700 hover:text-teal-900 cursor-pointer"
                    >
                      <RotateCcw className="w-3 h-3" aria-hidden="true" />
                      <span>Default</span>
                    </button>
                  )}
                </div>
                <input
                  id="dp-redirect-uri"
                  type="url"
                  value={dpRedirectUri}
                  onChange={(e) => setDpRedirectUri(e.target.value)}
                  placeholder={activeDirectDefaultCb}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                />
                <p className="mt-1 text-[11px] text-slate-500">
                  Register this exact redirect URI in your {activeDirectMeta?.fallbackLabel} OAuth application.
                </p>
              </div>

              <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2.5 pt-4 border-t border-slate-100">
                <button
                  type="button"
                  disabled={dpSaving}
                  onClick={handleResetDirectProvider}
                  className="px-3.5 py-2 min-h-[40px] rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-xs font-medium cursor-pointer w-full sm:w-auto"
                >
                  {t.profile.gatewayResetBtn}
                </button>
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setDirectEditorProvider(null)}
                    className="px-3.5 py-2 min-h-[40px] rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-xs font-medium cursor-pointer"
                  >
                    {t.common.close}
                  </button>
                  <button
                    type="submit"
                    disabled={dpSaving}
                    className="px-4 py-2 min-h-[40px] rounded-lg bg-[#0F766E] hover:bg-[#115E59] disabled:opacity-60 text-white text-xs font-medium cursor-pointer whitespace-nowrap"
                  >
                    {dpSaving ? '...' : t.profile.gatewaySaveBtn}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
