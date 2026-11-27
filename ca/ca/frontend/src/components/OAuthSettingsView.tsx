import React, { useEffect, useState } from 'react';
import { KeyRound, Link2, Settings2, Unlink, X } from 'lucide-react';
import {
  api,
  type OAuthGatewayConfig,
  type OAuthProvider,
  type OAuthProviderInfo,
  type UserProfile,
} from '../lib/api';
import type { LocaleDict } from '../lib/i18n';
import { CopyButton } from './CopyButton';
import { FloatingToast } from './Toast';

interface OAuthSettingsViewProps {
  t: LocaleDict;
  user: UserProfile | null;
  previewMode?: boolean;
  onUpdated: (u: UserProfile) => void;
}

export const OAuthSettingsView: React.FC<OAuthSettingsViewProps> = ({
  t,
  user,
  previewMode = false,
  onUpdated,
}) => {
  const [loading, setLoading] = useState(true);
  const [gwEditorOpen, setGwEditorOpen] = useState(false);
  const [gwConfig, setGwConfig] = useState<OAuthGatewayConfig | null>(null);
  const [providers, setProviders] = useState<OAuthProviderInfo[]>([]);

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
  const [socialBusy, setSocialBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const syncGatewayForm = (cfg: OAuthGatewayConfig) => {
    setGwConfig(cfg);
    setGwIssuer(cfg.issuer || '');
    setGwClientId(cfg.client_id || '');
    setGwClientSecret('');
    setGwClearSecret(false);
    setGwRedirectUri(cfg.redirect_uri || '');
    setGwScopes(cfg.scopes || 'openid profile email');
    setGwAuthEndpoint(cfg.authorization_endpoint || '');
    setGwTokenEndpoint(cfg.token_endpoint || '');
    setGwUserinfoEndpoint(cfg.userinfo_endpoint || '');
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([
      api.getOAuthGatewayConfig().catch(() => null),
      api.getOAuthProviders().catch(() => null),
    ])
      .then(([gwRes, provRes]) => {
        if (!active) return;
        if (gwRes?.gateway) syncGatewayForm(gwRes.gateway);
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
  }, []);

  useEffect(() => {
    if (!gwEditorOpen) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setGwEditorOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [gwEditorOpen]);

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
      setNotice(
        `Linked ${linkedProv === 'wimotek' ? 'wimotek/OAuth' : linkedProv} account successfully.`
      );
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
        setNotice(
          `Linked ${data.provider === 'wimotek' ? 'wimotek/OAuth' : data.provider || 'SSO'} account successfully.`
        );
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

  const handleSaveGateway = async (e: React.FormEvent) => {
    e.preventDefault();
    setGwSaving(true);
    setError('');
    setNotice('');
    try {
      const res = await api.saveOAuthGatewayConfig({
        issuer: gwIssuer.trim(),
        client_id: gwClientId.trim(),
        client_secret: gwClientSecret.trim() || undefined,
        clear_secret: gwClearSecret,
        redirect_uri: gwRedirectUri.trim(),
        scopes: gwScopes.trim() || 'openid profile email',
        authorization_endpoint: gwAuthEndpoint.trim(),
        token_endpoint: gwTokenEndpoint.trim(),
        userinfo_endpoint: gwUserinfoEndpoint.trim(),
      });
      if (res.gateway) syncGatewayForm(res.gateway);
      if (res.providers) {
        setProviders(res.providers);
      } else {
        const refreshed = await api.getOAuthProviders().catch(() => null);
        if (refreshed?.providers) setProviders(refreshed.providers);
      }
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
      if (res.gateway) syncGatewayForm(res.gateway);
      if (res.providers) {
        setProviders(res.providers);
      } else {
        const refreshed = await api.getOAuthProviders().catch(() => null);
        if (refreshed?.providers) setProviders(refreshed.providers);
      }
      setGwEditorOpen(false);
      setNotice(t.profile.gatewaySaved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset gateway parameters');
    } finally {
      setGwSaving(false);
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
          ? 'wimotek/OAuth gateway credentials are not configured yet. Configure Issuer, Client ID & Client Secret above.'
          : `OAuth credentials for ${provider} are not configured on this server.`
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
  const isConfigured = Boolean(gwConfig ? gwConfig.configured : wMeta?.configured);
  const defaultCallback =
    gwConfig?.default_callback_url || `${window.location.origin}/auth/callback`;
  const activeCallback =
    gwConfig?.callback_url || wMeta?.callback_url || defaultCallback;
  const isCustomCallback = Boolean(gwConfig?.redirect_uri?.trim());
  const sourceLabel =
    gwConfig?.source === 'database'
      ? 'Database'
      : gwConfig?.source === 'env'
      ? 'Environment'
      : '—';

  const linkedMap = new Map((user?.social_accounts || []).map((s) => [s.provider, s]));
  const wLinked = linkedMap.get('wimotek');

  return (
    <div className="max-w-4xl space-y-6">
      <FloatingToast
        error={error}
        notice={notice}
        onDismissError={() => setError('')}
        onDismissNotice={() => setNotice('')}
      />

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2">
            <KeyRound className="w-5 h-5 text-teal-700 shrink-0" aria-hidden="true" />
            <h2 className="font-display text-xl font-bold text-slate-900">
              {t.profile.wimotekGatewayTitle}
            </h2>
          </div>
          <p className="text-sm text-slate-600">{t.profile.wimotekGatewayDesc}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            if (gwConfig) syncGatewayForm(gwConfig);
            setError('');
            setNotice('');
            setGwEditorOpen(true);
          }}
          className="inline-flex items-center justify-center gap-2 px-4 py-2.5 min-h-[40px] rounded-lg bg-[#0F766E] hover:bg-[#115E59] text-white text-xs font-medium cursor-pointer whitespace-nowrap shrink-0 w-full sm:w-auto"
        >
          <Settings2 className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>{t.profile.gatewayEditBtn}</span>
        </button>
      </div>

      {/* System Gateway Status & Synchronized Configuration */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-5">
        {loading ? (
          <div className="space-y-3" aria-busy="true">
            <div className="h-12 bg-slate-100 rounded-lg animate-pulse" />
            <div className="h-10 bg-slate-100 rounded-lg animate-pulse" />
            <div className="h-10 bg-slate-100 rounded-lg animate-pulse" />
          </div>
        ) : (
          <>
            {/* Status Summary Strip */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pb-5 border-b border-slate-100">
              <div>
                <div className="text-xs text-slate-500">Status</div>
                <div
                  className={`text-sm font-semibold mt-1 ${
                    isConfigured ? 'text-emerald-700' : 'text-amber-700'
                  }`}
                >
                  {isConfigured ? t.profile.gatewayConfigured : t.profile.gatewayNotConfigured}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Configuration Source</div>
                <div className="text-sm font-medium text-slate-900 mt-1">{sourceLabel}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Protocol</div>
                <div className="text-sm font-mono text-slate-800 mt-1">OIDC 1.0 · PKCE S256</div>
              </div>
            </div>

            {/* Key-Value Details (Mobile-stacked, Desktop-aligned) */}
            <dl className="divide-y divide-slate-100 text-xs">
              <div className="py-3 flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-4">
                <dt className="font-medium text-slate-600 sm:w-40 shrink-0">Issuer URL</dt>
                <dd className="flex items-center justify-between gap-2 min-w-0 flex-1">
                  {activeIssuer ? (
                    <>
                      <code dir="ltr" className="font-mono text-slate-900 break-all sm:truncate">
                        {activeIssuer}
                      </code>
                      <CopyButton
                        compact
                        value={activeIssuer}
                        label={t.common.copy}
                        copiedLabel={t.common.copied}
                      />
                    </>
                  ) : (
                    <span className="text-slate-400 italic">{t.profile.gatewayNotConfigured}</span>
                  )}
                </dd>
              </div>

              <div className="py-3 flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-4">
                <dt className="font-medium text-slate-600 sm:w-40 shrink-0">
                  {t.profile.gatewayClientIdLabel}
                </dt>
                <dd className="flex items-center justify-between gap-2 min-w-0 flex-1">
                  {gwConfig?.client_id ? (
                    <>
                      <code dir="ltr" className="font-mono text-slate-900 break-all sm:truncate">
                        {gwConfig.client_id}
                      </code>
                      <CopyButton
                        compact
                        value={gwConfig.client_id}
                        label={t.common.copy}
                        copiedLabel={t.common.copied}
                      />
                    </>
                  ) : (
                    <span className="text-slate-400 italic">{t.profile.gatewayNotConfigured}</span>
                  )}
                </dd>
              </div>

              <div className="py-3 flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-4">
                <dt className="font-medium text-slate-600 sm:w-40 shrink-0">
                  {t.profile.gatewayClientSecretLabel}
                </dt>
                <dd className="min-w-0 flex-1">
                  {gwConfig?.has_client_secret ? (
                    <span className="font-mono text-emerald-700">
                      {gwConfig.client_secret_masked || '****'}
                    </span>
                  ) : (
                    <span className="text-slate-400 italic">{t.profile.gatewayNotConfigured}</span>
                  )}
                </dd>
              </div>

              <div className="py-3 flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-4">
                <dt className="font-medium text-slate-600 sm:w-40 shrink-0">
                  Callback URL{' '}
                  <span className="font-normal text-slate-400">
                    ({isCustomCallback ? t.profile.gatewayCallbackCustomTag : t.profile.gatewayCallbackAutoTag})
                  </span>
                </dt>
                <dd className="flex items-center justify-between gap-2 min-w-0 flex-1">
                  <code dir="ltr" className="font-mono text-slate-900 break-all sm:truncate">
                    {activeCallback}
                  </code>
                  <CopyButton
                    compact
                    value={activeCallback}
                    label={t.common.copy}
                    copiedLabel={t.common.copied}
                  />
                </dd>
              </div>

              <div className="py-3 flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-4">
                <dt className="font-medium text-slate-600 sm:w-40 shrink-0">
                  {t.profile.gatewayScopesLabel}
                </dt>
                <dd className="font-mono text-slate-800 break-words">
                  {gwConfig?.scopes || 'openid profile email'}
                </dd>
              </div>
            </dl>

            <p className="text-xs text-slate-500 leading-relaxed pt-2 border-t border-slate-100">
              {t.profile.gatewayCallbackHint}
            </p>
          </>
        )}
      </div>

      {/* Linked SSO Accounts (moved out of My Profile into OAuth / SSO) */}
      {user && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Link2 className="w-4 h-4 text-teal-700 shrink-0" aria-hidden="true" />
              <h3 className="font-display text-base font-semibold text-slate-900">
                {t.profile.linkedAccountsTitle}
              </h3>
            </div>
            <p className="text-xs text-slate-600">{t.profile.linkedAccountsDesc}</p>
          </div>

          <div className="pt-4 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="space-y-1 min-w-0">
              <div className="font-semibold text-sm text-slate-900">
                {t.profile.wimotekGatewayTitle}
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                <span className={wLinked ? 'text-teal-700 font-medium' : 'text-slate-500'}>
                  {wLinked ? t.profile.socialLinked : t.profile.socialNotLinked}
                </span>
                {activeIssuer && (
                  <>
                    <span className="text-slate-300" aria-hidden="true">·</span>
                    <span className="font-mono text-[11px] text-slate-500 break-all">
                      {activeIssuer.replace(/^https?:\/\//i, '')}
                    </span>
                  </>
                )}
              </div>
              {wLinked && (
                <div className="text-xs text-slate-700 pt-0.5 break-words">
                  <span className="font-medium">{wLinked.display_name}</span>
                  {wLinked.email && (
                    <span className="font-mono text-[11px] text-slate-500 ms-2 break-all">
                      {wLinked.email}
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="shrink-0">
              {wLinked ? (
                <button
                  type="button"
                  disabled={socialBusy === 'wimotek'}
                  onClick={() => handleUnbindSocial('wimotek')}
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-4 py-2 min-h-[40px] rounded-lg border border-red-200 bg-white text-red-700 hover:bg-red-50 text-xs font-medium cursor-pointer whitespace-nowrap"
                >
                  <Unlink className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{t.common.unbind}</span>
                </button>
              ) : (
                <button
                  type="button"
                  disabled={socialBusy === 'wimotek'}
                  onClick={() => handleBindSocial('wimotek')}
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-4 py-2 min-h-[40px] rounded-lg bg-[#0F766E] hover:bg-[#115E59] text-white text-xs font-medium cursor-pointer whitespace-nowrap"
                >
                  <Link2 className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{socialBusy === 'wimotek' ? '...' : t.common.bind}</span>
                </button>
              )}
            </div>
          </div>

          <details className="pt-3 border-t border-slate-100 text-xs">
            <summary className="cursor-pointer font-medium text-slate-500 hover:text-slate-800 select-none">
              Optional Direct IdP Connections (Microsoft / GitHub / Google)
            </summary>
            <div className="mt-3 divide-y divide-slate-100">
              {(['microsoft', 'github', 'google'] as OAuthProvider[]).map((prov) => {
                const linked = linkedMap.get(prov);
                const meta = providers.find((p) => p.provider === prov);
                const label = meta?.label || prov.charAt(0).toUpperCase() + prov.slice(1);
                return (
                  <div
                    key={prov}
                    className="py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-x-2 text-xs">
                        <span className="font-semibold text-slate-900">{label}</span>
                        <span className="text-slate-300" aria-hidden="true">·</span>
                        <span className={`font-medium ${linked ? 'text-emerald-700' : 'text-slate-500'}`}>
                          {linked ? t.profile.socialLinked : t.profile.socialNotLinked}
                        </span>
                      </div>
                      {linked && (
                        <div className="text-[11px] font-mono text-slate-500 break-all">
                          {linked.email || linked.display_name}
                        </div>
                      )}
                    </div>
                    {linked ? (
                      <button
                        type="button"
                        disabled={socialBusy === prov}
                        onClick={() => handleUnbindSocial(prov)}
                        className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-3 py-2 min-h-[38px] rounded-lg border border-red-200 text-red-700 hover:bg-red-50 text-xs font-medium cursor-pointer whitespace-nowrap"
                      >
                        <Unlink className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>{t.common.unbind}</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={socialBusy === prov}
                        onClick={() => handleBindSocial(prov)}
                        className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-3 py-2 min-h-[38px] rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium cursor-pointer whitespace-nowrap"
                      >
                        <Link2 className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>{socialBusy === prov ? '...' : t.common.bind}</span>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </details>
        </div>
      )}

      {/* Admin-Editable Gateway Parameters Modal Dialog */}
      {gwEditorOpen && (
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
              {!isConfigured && (
                <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 leading-relaxed">
                  {t.profile.gatewayUnconfiguredNotice}
                </div>
              )}

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
                  <label htmlFor="gw-redirect-uri" className="block text-xs font-medium text-slate-700 mb-1">
                    {t.profile.gatewayCallbackLabel}
                  </label>
                  <input
                    id="gw-redirect-uri"
                    type="url"
                    value={gwRedirectUri}
                    onChange={(e) => setGwRedirectUri(e.target.value)}
                    placeholder={defaultCallback}
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
                <div className="mt-3 grid grid-cols-1 gap-3">
                  <div>
                    <label htmlFor="gw-auth-ep" className="block text-[11px] font-medium text-slate-600 mb-1">
                      Authorization Endpoint
                    </label>
                    <input
                      id="gw-auth-ep"
                      type="url"
                      value={gwAuthEndpoint}
                      onChange={(e) => setGwAuthEndpoint(e.target.value)}
                      placeholder="Auto-discovered — e.g. https://oauth.example.com/oauth/authorize"
                      className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-mono text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label htmlFor="gw-token-ep" className="block text-[11px] font-medium text-slate-600 mb-1">
                      Token Endpoint
                    </label>
                    <input
                      id="gw-token-ep"
                      type="url"
                      value={gwTokenEndpoint}
                      onChange={(e) => setGwTokenEndpoint(e.target.value)}
                      placeholder="Auto-discovered — e.g. https://oauth.example.com/oauth/token"
                      className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-mono text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label htmlFor="gw-userinfo-ep" className="block text-[11px] font-medium text-slate-600 mb-1">
                      Userinfo Endpoint
                    </label>
                    <input
                      id="gw-userinfo-ep"
                      type="url"
                      value={gwUserinfoEndpoint}
                      onChange={(e) => setGwUserinfoEndpoint(e.target.value)}
                      placeholder="Auto-discovered — e.g. https://oauth.example.com/oauth/userinfo"
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
    </div>
  );
};
