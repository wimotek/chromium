import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Globe, Lock, Moon, RefreshCw, ShieldCheck, Sun, User } from 'lucide-react';
import { LANGUAGE_OPTIONS, translate, type TranslationKeys } from '../i18n/translations';
import { ApiError, apiRequest, setAuthToken, solvePowChallenge } from '../lib/api';
import type { AuthStatusResponse, CaptchaChallengeResponse, LanguageCode } from '../types/models';

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

  const isBootstrap = status.requiresBootstrap;

  const [username, setUsername] = useState(isBootstrap ? 'admin' : '');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [captchaAnswer, setCaptchaAnswer] = useState('');
  const [honeypot, setHoneypot] = useState('');
  const [sliderValue, setSliderValue] = useState(8);

  const [challenge, setChallenge] = useState<CaptchaChallengeResponse | null>(null);
  const [captchaBlobUrl, setCaptchaBlobUrl] = useState<string>('');
  const [powNonce, setPowNonce] = useState<string>('');
  const [powReady, setPowReady] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null);
  const [lockoutSec, setLockoutSec] = useState<number>(0);

  const activeChallengeIdRef = useRef<string>('');

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
      if (err instanceof ApiError && err.code === 'RATE_LIMITED') {
        const sec = Number(err.data.retryAfterSec) || 30;
        setLockoutSec(sec);
        setErrorMsg(t('errRateLimited', { sec }));
      }
    }
  }, [t]);

  useEffect(() => {
    void loadCaptcha();
    return () => {
      setCaptchaBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return '';
      });
    };
  }, [loadCaptcha]);

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

    if (isBootstrap) {
      if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username.trim())) {
        setErrorMsg(t('usernameInvalid'));
        return;
      }
      if (password.length < 8) {
        setErrorMsg(t('passwordTooShort'));
        return;
      }
      if (password !== confirmPassword) {
        setErrorMsg(t('passwordMismatch'));
        return;
      }
    }

    if (challenge.requireSlider && !sliderAligned) {
      setErrorMsg(t('errSliderMismatch'));
      return;
    }

    setSubmitting(true);
    try {
      const endpoint = isBootstrap ? '/api/auth/bootstrap' : '/api/auth/login';
      const resp = await apiRequest<{ token: string; username: string }>(endpoint, {
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
                  {isBootstrap ? t('authSetupTitle') : t('authLoginTitle')}
                </h1>
                <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                  {isBootstrap ? t('authSetupDesc') : t('authLoginDesc')}
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
                    audit.ndjson · Size-Capped Auto-Pruning · Multi-Stage Docker · GHCR & Docker Hub
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

          {/* Right Sign-in / Bootstrap Form */}
          <div className="lg:col-span-7 p-8 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
            <form onSubmit={handleSubmit} className="space-y-5" autoComplete="on">
              {status.envManagedAdmin && !isBootstrap && (
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
                      placeholder="admin"
                    />
                  </div>
                </div>

                <div className={isBootstrap ? 'sm:col-span-1' : 'sm:col-span-2'}>
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
                      autoComplete={isBootstrap ? 'new-password' : 'current-password'}
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

                {isBootstrap && (
                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      {t('confirmPassword')}
                    </label>
                    <input
                      type={showPassword ? 'text' : 'password'}
                      required
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      autoComplete="new-password"
                      className="w-full px-3 py-2.5 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-950/60 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
                    />
                  </div>
                )}
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
                  {lockoutSec > 0
                    ? `${lockoutSec}s`
                    : isBootstrap
                    ? t('setupButton')
                    : t('signInButton')}
                </button>
              </div>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}
