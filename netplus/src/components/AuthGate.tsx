import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Globe, Loader2, Lock, Moon, RefreshCw, ShieldCheck, Sun, User } from 'lucide-react';
import { LANGUAGE_OPTIONS, translate, type TranslationKeys } from '../i18n/translations';
import { ApiError, apiRequest, setAuthToken, solvePowChallenge } from '../lib/api';
import type { AuthStatusResponse, CaptchaChallengeResponse, LanguageCode, OAuthProviderId } from '../types/models';

const OAUTH_META: Record<OAuthProviderId, { label: string; shortLabel: string; accent: string }> = {
  wimotek: { label: 'wimotek/Oauth', shortLabel: 'wimotek/Oauth', accent: 'border-blue-300 dark:border-blue-700 hover:bg-blue-50 dark:hover:bg-blue-950/40' },
  microsoft: { label: 'Microsoft', shortLabel: 'Microsoft', accent: 'border-sky-200 dark:border-sky-800/70 hover:bg-sky-50 dark:hover:bg-sky-950/30' },
  github: { label: 'GitHub', shortLabel: 'GitHub', accent: 'border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800' },
  google: { label: 'Google', shortLabel: 'Google', accent: 'border-blue-200 dark:border-blue-800/70 hover:bg-blue-50 dark:hover:bg-blue-950/30' },
  apple: { label: 'Apple', shortLabel: 'Apple', accent: 'border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800' },
};

function ProviderBrandIcon({ provider }: { provider: OAuthProviderId }) {
  if (provider === 'wimotek') {
    return (
      <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="2" y="2" width="20" height="20" rx="5" fill="#2563EB" />
        <path
          d="M6.5 14.5L9.5 9.5L12.5 14L15 10.5L17.5 14.5"
          stroke="#FFFFFF"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="17.5" cy="8.5" r="1.5" fill="#93C5FD" />
      </svg>
    );
  }
  if (provider === 'microsoft') {
    return (
      <svg className="w-4 h-4 shrink-0" viewBox="0 0 21 21" aria-hidden="true">
        <rect x="1" y="1" width="9" height="9" fill="#f25022" />
        <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
        <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
        <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
      </svg>
    );
  }
  if (provider === 'github') {
    return (
      <svg className="w-4 h-4 shrink-0 fill-current" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 0.5C5.65 0.5 0.5 5.65 0.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.06 11.06 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14 0 1.54-.01 2.79-.01 3.17 0 .31.21.68.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35 0.5 12 0.5z" />
      </svg>
    );
  }
  if (provider === 'google') {
    return (
      <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.63v3h3.88c2.27-2.09 3.54-5.17 3.54-8.87z" />
        <path fill="#34A853" d="M12 24c3.24 0 5.95-1.07 7.94-2.91l-3.88-3c-1.08.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.72-4.96H1.29v3.09A12 12 0 0 0 12 24z" />
        <path fill="#FBBC05" d="M5.28 14.28A7.2 7.2 0 0 1 4.9 12c0-.79.14-1.56.38-2.28V6.63H1.29a12 12 0 0 0 0 10.74l3.99-3.09z" />
        <path fill="#EA4335" d="M12 4.76c1.76 0 3.34.61 4.58 1.8l3.43-3.43C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.29 6.63l3.99 3.09c.95-2.85 3.6-4.96 6.72-4.96z" />
      </svg>
    );
  }
  return (
    <svg className="w-4 h-4 shrink-0 fill-current" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.53 4.08zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
    </svg>
  );
}

interface AuthGateProps {
  status: AuthStatusResponse;
  lang: LanguageCode;
  onChangeLang: (lang: LanguageCode) => void;
  dark: boolean;
  onToggleDark: () => void;
  onAuthenticated: (username: string) => void;
}

export function AuthGate({
  status,
  lang,
  onChangeLang,
  dark,
  onToggleDark,
  onAuthenticated,
}: AuthGateProps) {
  const t = useCallback(
    (key: TranslationKeys, vars?: Record<string, string | number>) => translate(lang, key, vars),
    [lang]
  );

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [captchaAnswer, setCaptchaAnswer] = useState('');
  const [honeypot, setHoneypot] = useState('');
  const [sliderValue, setSliderValue] = useState(8);

  const [challenge, setChallenge] = useState<CaptchaChallengeResponse | null>(null);
  const [captchaBlobUrl, setCaptchaBlobUrl] = useState<string>('');
  const [powNonce, setPowNonce] = useState<string>('');
  const [powReady, setPowReady] = useState(false);

  const [initialUrlParams] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return {
      oauthError: params.get('oauth_error') || '',
      preferLocal: params.get('local') === '1',
      loggedOut: params.get('logged_out') === '1',
    };
  });

  const [preferLocalForm, setPreferLocalForm] = useState<boolean>(initialUrlParams.preferLocal);
  const [redirectingToOidc, setRedirectingToOidc] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [oauthBusy, setOauthBusy] = useState<OAuthProviderId | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(initialUrlParams.oauthError || null);
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null);
  const [lockoutSec, setLockoutSec] = useState<number>(0);

  const activeChallengeIdRef = useRef<string>('');
  const redirectTriggeredRef = useRef<boolean>(false);

  const isInIframe = (() => {
    try {
      return window.self !== window.top;
    } catch {
      return true;
    }
  })();

  const wimotekActive = Boolean(status.wimotekOAuth?.enabled && status.wimotekOAuth?.configured);
  const showWimotekPrimaryView = wimotekActive && !preferLocalForm;

  const enabledOAuthProviders = (status.oauthProviders ?? []).filter(
    (p) => p.enabled && p.configured
  );

  // When wimotek/Oauth is enabled with directLogin (default), automatically redirect standalone
  // sessions to /login (unless user explicitly requested local login, just logged out, or returned with error)
  useEffect(() => {
    if (
      wimotekActive &&
      status.wimotekOAuth?.directLogin !== false &&
      !preferLocalForm &&
      !initialUrlParams.oauthError &&
      !initialUrlParams.loggedOut &&
      !isInIframe &&
      !redirectTriggeredRef.current
    ) {
      redirectTriggeredRef.current = true;
      setRedirectingToOidc(true);
      window.location.assign('/login');
    }
  }, [
    wimotekActive,
    status.wimotekOAuth?.directLogin,
    preferLocalForm,
    initialUrlParams.oauthError,
    initialUrlParams.loggedOut,
    isInIframe,
  ]);

  // Listen for OAuth popup completion via postMessage (same-origin callback page)
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as
        | {
            type?: string;
            payload?: {
              mode?: 'login' | 'bind';
              token?: string;
              username?: string;
              error?: string;
            };
          }
        | null
        | undefined;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'OAUTH_AUTH_SUCCESS' && data.payload?.mode === 'login') {
        setOauthBusy(null);
        if (data.payload.token) {
          setAuthToken(data.payload.token);
        }
        onAuthenticated(data.payload.username || 'admin');
      } else if (data.type === 'OAUTH_AUTH_ERROR') {
        setOauthBusy(null);
        setErrorMsg(
          data.payload?.error ||
            (lang === 'zh-CN' ? '第三方账号登录失败，请确认已在安全设置中绑定该账号。' : 'OAuth login failed.')
        );
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [lang, onAuthenticated]);

  const handleOAuthLogin = async (provider: OAuthProviderId) => {
    if (oauthBusy) return;
    setErrorMsg(null);

    // For wimotek/Oauth in standalone browser tab, navigate directly to /login (standard OIDC redirect)
    if (provider === 'wimotek' && !isInIframe) {
      setOauthBusy('wimotek');
      window.location.assign('/login');
      return;
    }

    setOauthBusy(provider);
    try {
      const res = await apiRequest<{ ok?: boolean; url: string }>(
        `/api/auth/oauth/${provider}/url?mode=login&flow=popup`
      );
      const width = 560;
      const height = 680;
      const left = Math.max(0, Math.round((window.screen.width - width) / 2));
      const top = Math.max(0, Math.round((window.screen.height - height) / 2));
      const popup = window.open(
        res.url,
        'netplus_oauth_login',
        `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`
      );
      if (!popup) {
        setOauthBusy(null);
        setErrorMsg(
          lang === 'zh-CN'
            ? '浏览器拦截了授权弹窗，请允许本站点弹出窗口后重试。'
            : 'Popup blocked by browser. Please allow popups and try again.'
        );
        return;
      }
      // Reset busy state if user closes popup manually
      const pollClose = window.setInterval(() => {
        if (popup.closed) {
          window.clearInterval(pollClose);
          setOauthBusy((cur) => (cur === provider ? null : cur));
        }
      }, 600);
    } catch (err) {
      setOauthBusy(null);
      setErrorMsg(err instanceof Error ? err.message : 'Failed to initiate OAuth login');
    }
  };

  const loadCaptcha = useCallback(async () => {
    setPowReady(false);
    setPowNonce('');
    setCaptchaAnswer('');
    setSliderValue(8);
    try {
      const ch = await apiRequest<CaptchaChallengeResponse>('/api/auth/captcha');
      activeChallengeIdRef.current = ch.challengeId;
      setChallenge(ch);

      // Render SVG safely as Blob URL inside <img> (no raw HTML injection)
      const blob = new Blob([ch.svg], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      setCaptchaBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });

      const nonce = await solvePowChallenge(ch.powSalt, ch.powDifficulty);
      if (activeChallengeIdRef.current === ch.challengeId) {
        setPowNonce(nonce);
        setPowReady(true);
      }
    } catch (err) {
      console.error('[NetPlus] Failed to initialize auth challenge:', err);
      if (err instanceof ApiError && err.code === 'RATE_LIMITED') {
        const sec = Number(err.data.retryAfterSec) || 30;
        setLockoutSec(sec);
        setErrorMsg(t('errRateLimited', { sec }));
      } else {
        setErrorMsg(
          lang === 'zh-CN'
            ? `验证码初始化失败：${err instanceof Error ? err.message : '请点击刷新验证码重试'}`
            : `Failed to initialize verification challenge: ${err instanceof Error ? err.message : 'Please refresh and retry'}`
        );
      }
    }
  }, [lang, t]);

  useEffect(() => {
    if (showWimotekPrimaryView) return;
    void loadCaptcha();
    return () => {
      setCaptchaBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return '';
      });
    };
  }, [loadCaptcha, showWimotekPrimaryView]);

  useEffect(() => {
    if (lockoutSec <= 0) return;
    const timer = setInterval(() => {
      setLockoutSec((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [lockoutSec]);

  const sliderAligned =
    !challenge?.requireSlider || Math.abs(sliderValue - challenge.sliderTarget) <= 5;

  const mapServerError = (code: string, data: Record<string, unknown>): string => {
    switch (code) {
      case 'CAPTCHA_WRONG':
        return t('errCaptchaWrong');
      case 'CAPTCHA_EXPIRED':
      case 'CAPTCHA_EXPIRED_OR_INVALID':
        return t('errCaptchaExpired');
      case 'SLIDER_MISMATCH':
        return t('errSliderMismatch');
      case 'POW_INVALID':
        return t('errPowInvalid');
      case 'BOT_TOO_FAST':
      case 'BOT_HONEYPOT_TRIGGERED':
        return t('errTooFast');
      case 'INVALID_CREDENTIALS':
        return t('errInvalidCreds');
      case 'ACCOUNT_LOCKED':
        return t('lockoutNotice', { sec: Number(data.retryAfterSec) || 60 });
      case 'RATE_LIMITED':
        return t('errRateLimited', { sec: Number(data.retryAfterSec) || 30 });
      case 'INVALID_USERNAME':
        return t('usernameInvalid');
      case 'WEAK_PASSWORD':
        return t('passwordTooShort');
      default:
        return code;
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || lockoutSec > 0 || !challenge || !powReady) return;
    setErrorMsg(null);

    if (challenge.requireSlider && !sliderAligned) {
      setErrorMsg(t('errSliderMismatch'));
      return;
    }

    setSubmitting(true);
    try {
      const resp = await apiRequest<{ token: string; username: string }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          username: username.trim(),
          password,
          challengeId: challenge.challengeId,
          captchaAnswer: captchaAnswer.trim(),
          powNonce,
          sliderValue,
          honeypot,
        }),
      });
      setAuthToken(resp.token);
      onAuthenticated(resp.username);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrorMsg(mapServerError(err.code, err.data));
        if (typeof err.data.attemptsLeft === 'number') {
          setAttemptsLeft(err.data.attemptsLeft);
        }
        if (typeof err.data.retryAfterSec === 'number' && err.data.retryAfterSec > 0) {
          setLockoutSec(err.data.retryAfterSec);
        }
      } else {
        setErrorMsg('Network request failed');
      }
      void loadCaptcha();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      {/* Minimal clean header */}
      <header className="w-full border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between gap-6">
          <div className="font-display text-lg font-bold tracking-tight whitespace-nowrap shrink-0">
            {t('brandName')}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
              <Globe className="w-4 h-4 shrink-0" aria-hidden="true" />
              <select
                aria-label={t('language')}
                value={lang}
                onChange={(e) => onChangeLang(e.target.value as LanguageCode)}
                className="bg-transparent border border-slate-200 dark:border-slate-700 rounded-md px-2.5 py-1.5 text-xs font-medium text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-600"
              >
                {LANGUAGE_OPTIONS.map((opt) => (
                  <option key={opt.code} value={opt.code} className="bg-white dark:bg-slate-900">
                    {opt.native}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={onToggleDark}
              aria-label={dark ? t('themeLight') : t('themeDark')}
              className="p-2 rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </header>

      {/* Main 2-column desktop presence */}
      <main className="flex-1 flex items-center justify-center px-6 py-10">
        <div className="w-full max-w-5xl grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
          {/* Left Architecture & Security Summary */}
          <div className="lg:col-span-5 flex flex-col justify-between p-8 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
            <div className="space-y-6">
              <div>
                <p className="text-xs font-medium text-blue-600 dark:text-blue-400 mb-2">
                  {t('brandSubtitle')}
                </p>
                <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white [text-wrap:balance]">
                  {t('authLoginTitle')}
                </h1>
                <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                  {t('authLoginDesc')}
                </p>
              </div>

              <div className="border-t border-slate-200 dark:border-slate-800 pt-6 space-y-4">
                <div className="space-y-1">
                  <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {t('navDns')}
                  </div>
                  <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                    Cloudflare · DNSPod · Aliyun · Porkbun · Route 53 · IPv4 + Multi-IPv6 AAAA
                  </p>
                </div>
                <div className="space-y-1">
                  <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {t('navOci')}
                  </div>
                  <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                    Multi-Region OCI · VM.Standard.A1.Flex ARM Sniper · AD Cycling · Script Export
                  </p>
                </div>
                <div className="space-y-1">
                  <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {t('navAudit')}
                  </div>
                  <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                    audit.ndjson · Size-Capped Auto-Pruning · HTTPS / TLS Auto-Reload
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-8 pt-4 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
              <span>scrypt</span>
              <span aria-hidden="true">·</span>
              <span>AES-256-GCM</span>
              <span aria-hidden="true">·</span>
              <span>SHA-256 PoW</span>
              <span aria-hidden="true">·</span>
              <span>Rate Limit</span>
            </div>
          </div>

          {/* Right Sign-in Form */}
          <div className="lg:col-span-7 p-8 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
            {showWimotekPrimaryView ? (
              <div className="h-full flex flex-col justify-between space-y-6">
                <div className="space-y-5">
                  <div className="flex items-center justify-between gap-2 pb-4 border-b border-slate-200 dark:border-slate-800">
                    <div>
                      <div className="text-xs font-mono uppercase tracking-wide text-blue-600 dark:text-blue-400">
                        OIDC 1.0 · OAuth 2.0 PKCE (S256)
                      </div>
                      <h2 className="mt-1 font-display text-xl font-bold text-slate-900 dark:text-white">
                        {lang === 'zh-CN' ? '使用 wimotek/Oauth 统一登录' : 'Sign in with wimotek/Oauth'}
                      </h2>
                    </div>
                    <ProviderBrandIcon provider="wimotek" />
                  </div>

                  {errorMsg && (
                    <div
                      role="alert"
                      className="p-3.5 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 text-sm text-red-700 dark:text-red-300"
                    >
                      {errorMsg}
                    </div>
                  )}

                  {redirectingToOidc ? (
                    <div className="py-10 flex flex-col items-center justify-center gap-3 text-center">
                      <Loader2 className="w-7 h-7 animate-spin text-blue-600 dark:text-blue-400" />
                      <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
                        {lang === 'zh-CN'
                          ? '正在跳转至 wimotek/Oauth 统一认证页面...'
                          : 'Redirecting to wimotek/Oauth hosted sign-in...'}
                      </p>
                      <p className="text-xs font-mono text-slate-400">
                        {status.wimotekOAuth?.issuerUrl || 'http://ca.wimotek.com'}
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
                        {lang === 'zh-CN'
                          ? '当前控制台已启用 wimotek/Oauth 单点登录，将通过 Authorization Code + PKCE (S256) 与 RS256 ID Token 校验完成安全登录。'
                          : 'wimotek/Oauth SSO is active. Authentication uses Authorization Code + PKCE (S256) with RS256 JWKS ID Token verification.'}
                      </p>

                      <button
                        type="button"
                        disabled={Boolean(oauthBusy)}
                        onClick={() => void handleOAuthLogin('wimotek')}
                        className="w-full inline-flex items-center justify-center gap-2.5 px-5 py-3 rounded-lg text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 transition-colors"
                      >
                        {oauthBusy === 'wimotek' ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <ProviderBrandIcon provider="wimotek" />
                        )}
                        <span>
                          {lang === 'zh-CN'
                            ? '前往 wimotek/Oauth 授权登录'
                            : 'Continue with wimotek/Oauth'}
                        </span>
                      </button>

                      <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-950/60 space-y-1 text-[11px] font-mono text-slate-500 dark:text-slate-400">
                        <div className="flex items-center justify-between gap-2">
                          <span>Issuer</span>
                          <span className="text-slate-700 dark:text-slate-200 truncate">
                            {status.wimotekOAuth?.issuerUrl || 'http://ca.wimotek.com'}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span>Client ID</span>
                          <span className="text-slate-700 dark:text-slate-200 truncate">
                            {status.wimotekOAuth?.clientId || 'wimotek_ebb129ddb83c'}
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs">
                  <span className="text-slate-400 dark:text-slate-500">
                    {lang === 'zh-CN'
                      ? '在「安全设置」关闭 wimotek/Oauth 后将自动恢复本地登录页'
                      : 'Disabling wimotek/Oauth in Security Settings restores local login'}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setRedirectingToOidc(false);
                      setPreferLocalForm(true);
                    }}
                    className="font-medium text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap"
                  >
                    {lang === 'zh-CN' ? '使用本地管理员密码登录 →' : 'Use local admin password →'}
                  </button>
                </div>
              </div>
            ) : (
            <>
            {wimotekActive && (
              <div className="mb-4 pb-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 text-xs">
                <span className="text-slate-500 dark:text-slate-400">
                  {lang === 'zh-CN' ? '本地管理员回退登录' : 'Local administrator fallback'}
                </span>
                <button
                  type="button"
                  onClick={() => setPreferLocalForm(false)}
                  className="font-medium text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap"
                >
                  {lang === 'zh-CN' ? '← 返回 wimotek/Oauth 登录' : '← Back to wimotek/Oauth'}
                </button>
              </div>
            )}
            <form onSubmit={handleSubmit} className="space-y-5" autoComplete="on">
              {status.envManagedAdmin && (
                <div className="p-3 rounded-lg bg-slate-100 dark:bg-slate-800/70 text-xs text-slate-700 dark:text-slate-300">
                  {t('authEnvManaged')}
                </div>
              )}

              {errorMsg && (
                <div
                  role="alert"
                  className="p-3.5 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 text-sm text-red-700 dark:text-red-300"
                >
                  <div>{errorMsg}</div>
                  {attemptsLeft !== null && attemptsLeft > 0 && lockoutSec === 0 && (
                    <div className="mt-1 text-xs opacity-85">
                      {t('attemptsRemaining', { n: attemptsLeft })}
                    </div>
                  )}
                </div>
              )}

              {/* Invisible bot honeypot field */}
              <div className="sr-only" aria-hidden="true">
                <label htmlFor="website_hp">Website</label>
                <input
                  id="website_hp"
                  name="website_hp"
                  type="text"
                  tabIndex={-1}
                  autoComplete="off"
                  value={honeypot}
                  onChange={(e) => setHoneypot(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    {t('username')}
                  </label>
                  <div className="relative">
                    <User className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="text"
                      required
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      autoComplete="username"
                      className="w-full pl-9 pr-3 py-2.5 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-950/60 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
                      placeholder={lang === 'zh-CN' ? '输入管理员用户名' : 'Enter username'}
                    />
                  </div>
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    {t('password')}
                  </label>
                  <div className="relative">
                    <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="current-password"
                      placeholder={lang === 'zh-CN' ? '输入管理员密码' : 'Enter password'}
                      className="w-full pl-9 pr-10 py-2.5 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-950/60 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label="Toggle password visibility"
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </div>

              {/* Strong Distorted SVG CAPTCHA */}
              <div className="pt-2 border-t border-slate-200 dark:border-slate-800 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-xs font-medium text-slate-700 dark:text-slate-300">
                    {t('captchaLabel')}
                  </label>
                  <button
                    type="button"
                    onClick={() => void loadCaptcha()}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap shrink-0"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    {t('captchaRefresh')}
                  </button>
                </div>

                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                  <div className="shrink-0 h-16 w-[220px] rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
                    {captchaBlobUrl ? (
                      <img
                        src={captchaBlobUrl}
                        alt={t('captchaLabel')}
                        className="w-full h-full object-contain select-none"
                        draggable={false}
                      />
                    ) : (
                      <span className="text-xs text-slate-400">{t('loading')}</span>
                    )}
                  </div>
                  <input
                    type="text"
                    required
                    value={captchaAnswer}
                    onChange={(e) => setCaptchaAnswer(e.target.value.toUpperCase())}
                    placeholder={t('captchaPlaceholder')}
                    maxLength={8}
                    autoComplete="off"
                    spellCheck={false}
                    className="flex-1 min-w-0 px-3.5 py-2.5 text-sm font-mono tracking-widest uppercase rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-950/60 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
              </div>

              {/* Adaptive Human Slider Verification (shown automatically after repeated failures) */}
              {challenge?.requireSlider && (
                <div className="space-y-2 p-3.5 rounded-lg border border-amber-200/80 dark:border-amber-900/60 bg-amber-50/50 dark:bg-amber-950/20">
                  {typeof challenge.failedAttempts === 'number' &&
                    challenge.failedAttempts > 0 &&
                    (challenge.sliderThreshold ?? 2) > 0 && (
                      <div className="text-[11px] font-medium text-amber-700 dark:text-amber-300">
                        {lang === 'zh-CN'
                          ? `检测到连续验证失败（${challenge.failedAttempts} 次），已自动调出人机滑块验证`
                          : `Multiple failed attempts (${challenge.failedAttempts}) detected — slider verification enabled`}
                      </div>
                    )}
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-slate-700 dark:text-slate-300">
                      {t('sliderLabel')}
                    </span>
                    <span
                      className={`font-mono tabular-nums ${
                        sliderAligned
                          ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
                          : 'text-slate-500 dark:text-slate-400'
                      }`}
                    >
                      {sliderAligned ? t('sliderVerified') : `${sliderValue}% / ${challenge.sliderTarget}%`}
                    </span>
                  </div>
                  <div className="relative h-10 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 flex items-center px-3">
                    {/* Highlighted target zone */}
                    <div
                      className={`absolute top-1 bottom-1 rounded transition-colors pointer-events-none ${
                        sliderAligned
                          ? 'bg-emerald-500/25 border border-emerald-500/60'
                          : 'bg-blue-500/20 border border-blue-500/50'
                      }`}
                      style={{
                        left: `calc(${Math.max(4, challenge.sliderTarget - 5)}% )`,
                        width: '10%',
                      }}
                    />
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={sliderValue}
                      onChange={(e) => setSliderValue(Number(e.target.value))}
                      aria-label={t('sliderLabel')}
                      className="relative z-10 w-full accent-blue-600 cursor-pointer"
                    />
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{t('sliderHint')}</p>
                </div>
              )}

              {/* PoW status & Submit */}
              <div className="pt-2 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 min-w-0">
                  <ShieldCheck
                    className={`w-4 h-4 shrink-0 ${
                      powReady ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-500'
                    }`}
                  />
                  <span className="truncate">
                    {powReady ? t('powReady') : t('powComputing')}
                  </span>
                </div>

                <button
                  type="submit"
                  disabled={submitting || !powReady || lockoutSec > 0}
                  className="px-5 py-2.5 rounded-lg text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0"
                >
                  {lockoutSec > 0 ? `${lockoutSec}s` : t('signInButton')}
                </button>
              </div>

              <p className="text-[11px] leading-relaxed text-slate-400 dark:text-slate-500 pt-1">
                {lang === 'zh-CN'
                  ? '首次部署未指定 ADMIN_PASSWORD 时，随机初始密码已打印在容器启动日志（docker logs netplus）中，登录后可在「安全设置」修改。'
                  : 'On first boot without ADMIN_PASSWORD, a random initial password is printed once in container startup logs (docker logs netplus). Change it anytime in Security Settings.'}
              </p>
            </form>

            {/* Third-Party OAuth / SSO Sign-In (Microsoft, GitHub, Google, Apple) */}
            <div className="mt-6 pt-5 border-t border-slate-200 dark:border-slate-800 space-y-3">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-medium text-slate-600 dark:text-slate-300">
                  {lang === 'zh-CN'
                    ? '第三方已绑定账号快捷登录'
                    : 'Sign in with a bound third-party account'}
                </span>
                <span className="text-[11px] text-slate-400 dark:text-slate-500 font-mono">
                  OAuth 2.0 / OIDC
                </span>
              </div>

              {enabledOAuthProviders.length > 0 ? (
                <div className="grid grid-cols-2 gap-2.5">
                  {enabledOAuthProviders.map((prov) => {
                    const meta = OAUTH_META[prov.provider];
                    const isBusy = oauthBusy === prov.provider;
                    return (
                      <button
                        key={prov.provider}
                        type="button"
                        disabled={Boolean(oauthBusy)}
                        onClick={() => void handleOAuthLogin(prov.provider)}
                        className={`inline-flex items-center justify-center gap-2 px-3.5 py-2.5 rounded-lg border text-xs font-medium text-slate-800 dark:text-slate-100 bg-white dark:bg-slate-950/60 transition-colors disabled:opacity-50 ${meta.accent}`}
                      >
                        {isBusy ? (
                          <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                        ) : (
                          <ProviderBrandIcon provider={prov.provider} />
                        )}
                        <span className="truncate">
                          {lang === 'zh-CN' ? `使用 ${meta.shortLabel} 登录` : `Continue with ${meta.label}`}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200/80 dark:border-slate-800 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400 flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {lang === 'zh-CN'
                      ? '支持接入 wimotek/Oauth（OIDC 1.0 + PKCE）以及 Microsoft、GitHub、Google、Apple 账号免密登录。登录后前往「安全设置 → 第三方账号登录与绑定」开启即可。'
                      : 'Supports wimotek/Oauth (OIDC 1.0 + PKCE) as well as Microsoft, GitHub, Google, and Apple sign-in. Configure under Security Settings.'}
                  </span>
                </div>
              )}
            </div>
            </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
