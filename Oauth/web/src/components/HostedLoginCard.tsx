import React, { useId, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  KeyRound,
  AlertCircle,
  Mail,
  Fingerprint,
  Smartphone,
  ShieldCheck,
  CheckCircle2,
} from 'lucide-react';
import type { AuthPolicyConfig, Locale, LoginThemeConfig, OidcFlowTrace, SocialConnector } from '../types';
import { TRANSLATIONS, partitionConnectors } from '../lib/i18n';
import {
  DEFAULT_LOGIN_THEME,
  getFontFamilyClass,
  getRadiusClasses,
  normalizeLoginTheme,
} from '../lib/loginTheme';
import { type AuthModeTab, resolveActiveAuthMode } from '../lib/authPolicy';
import { authenticateBrowserPasskey } from '../lib/webauthn';
import { BrandMark, ProviderIcon } from './ProviderIcons';

interface HostedLoginCardProps {
  locale: Locale;
  connectors: SocialConnector[];
  authPolicy?: AuthPolicyConfig;
  theme?: LoginThemeConfig;
  clientId?: string;
  rtl?: boolean;
  compact?: boolean;
  onPasswordSignIn?: (email: string, password: string) => Promise<void>;
  onSocialSignIn: (provider: string) => Promise<void>;
  onAuthCompleted?: (result: { user: any; sessionToken: string; trace: OidcFlowTrace }) => void;
  busyProvider?: string | null;
  errorMessage?: string | null;
}

export function HostedLoginCard({
  locale,
  connectors,
  authPolicy,
  theme,
  clientId = 'wimotek_erp_portal',
  rtl = false,
  compact = false,
  onPasswordSignIn,
  onSocialSignIn,
  onAuthCompleted,
  busyProvider = null,
  errorMessage = null,
}: HostedLoginCardProps) {
  const t = TRANSLATIONS[locale];
  const scopeUid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const scopeAttr = `wm-${scopeUid}`;
  const resolvedTheme = useMemo(() => normalizeLoginTheme(theme), [theme]);
  const radius = getRadiusClasses(resolvedTheme.borderRadius);
  const fontClass = getFontFamilyClass(resolvedTheme.fontFamily);

  const [mode, setMode] = useState<AuthModeTab>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  // Email OTP state
  const [otpSent, setOtpSent] = useState(false);
  const [otpInput, setOtpInput] = useState('');

  // Device Flow (RFC 8628) state
  const [deviceSession, setDeviceSession] = useState<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    approved?: boolean;
  } | null>(null);

  const [captchaVerified, setCaptchaVerified] = useState(true);

  const policy: AuthPolicyConfig = authPolicy || {
    enablePasswordArgon2id: true,
    enableEmailOtpMagicLink: true,
    enableTotp2fa: true,
    enablePasskeysWebAuthn: true,
    enableDeviceFlowRfc8628: true,
    jitVerifiedEmailAutoLink: true,
    ipRateLimitPerMin: 60,
    lockoutThreshold: 3,
    captchaProvider: 'turnstile',
    captchaSiteKey: '',
  };

  const { primary, overflow } = partitionConnectors(connectors, 3);
  const enabledCount = primary.length + overflow.length;

  const availableTabs: { id: AuthModeTab; label: string }[] = [
    ...(policy.enablePasswordArgon2id ? [{ id: 'password' as const, label: t.tabPassword }] : []),
    ...(policy.enableEmailOtpMagicLink ? [{ id: 'email_otp' as const, label: t.tabEmailOtp }] : []),
    ...(policy.enablePasskeysWebAuthn ? [{ id: 'passkey' as const, label: t.tabPasskey }] : []),
    ...(policy.enableDeviceFlowRfc8628 ? [{ id: 'device' as const, label: t.tabDeviceFlow }] : []),
  ];
  const activeMode = resolveActiveAuthMode(policy, mode);

  const isSplit = !compact && (resolvedTheme.layout === 'split_left' || resolvedTheme.layout === 'split_right');
  const isMinimal = resolvedTheme.layout === 'minimal';
  const hasExplicitSurface =
    resolvedTheme.surfaceMode !== 'auto' ||
    resolvedTheme.cardColor.toLowerCase() !== DEFAULT_LOGIN_THEME.cardColor.toLowerCase() ||
    resolvedTheme.textColor.toLowerCase() !== DEFAULT_LOGIN_THEME.textColor.toLowerCase() ||
    resolvedTheme.backgroundColor.toLowerCase() !== DEFAULT_LOGIN_THEME.backgroundColor.toLowerCase();

  const isDarkSurface = resolvedTheme.surfaceMode === 'dark';

  const scopedThemeCss = useMemo(() => {
    const sel = `[data-wimotek-scope="${scopeAttr}"]`;
    const surfaceRules = hasExplicitSurface
      ? `
${sel} [data-wimotek-login-card] {
  background-color: ${isMinimal ? 'transparent' : resolvedTheme.cardColor};
  color: ${resolvedTheme.textColor};
}
${sel} .wm-divider-chip {
  background-color: ${isMinimal ? resolvedTheme.backgroundColor : resolvedTheme.cardColor};
}
`
      : '';

    return `
${sel} {
  --wm-primary: ${resolvedTheme.primaryColor};
  --wm-bg: ${resolvedTheme.backgroundColor};
  --wm-card: ${resolvedTheme.cardColor};
  --wm-text: ${resolvedTheme.textColor};
}
${sel} .wm-primary-btn {
  background-color: var(--wm-primary);
  color: #FFFFFF;
}
${sel} .wm-primary-btn:hover {
  filter: brightness(0.93);
}
${sel} .wm-accent-text {
  color: var(--wm-primary);
}
${sel} .wm-hero-panel {
  background: linear-gradient(145deg, ${resolvedTheme.primaryColor} 0%, #0F172A 100%);
}
${surfaceRules}
${resolvedTheme.customCss || ''}
`;
  }, [scopeAttr, resolvedTheme, hasExplicitSurface, isMinimal]);

  const headingText =
    resolvedTheme.brandTitle && resolvedTheme.brandTitle !== DEFAULT_LOGIN_THEME.brandTitle
      ? resolvedTheme.brandTitle
      : t.loginTitle;
  const subtitleText = resolvedTheme.brandSubtitle || t.loginSubtitle;

  async function handleSubmitPassword(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);
    if (policy.captchaProvider !== 'none' && !captchaVerified) {
      setLocalError('Please complete human verification first.');
      return;
    }
    if (!email.trim() || !password) {
      setLocalError('Please enter both email and password.');
      return;
    }
    if (onPasswordSignIn) {
      await onPasswordSignIn(email.trim(), password);
    }
  }

  async function handleSendOtp(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);
    setWorking(true);
    try {
      const res = await fetch('/api/auth/email-otp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Failed to send OTP');
      setOtpSent(true);
      setOtpInput('');
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'OTP failed');
    } finally {
      setWorking(false);
    }
  }

  async function handleVerifyOtp() {
    setLocalError(null);
    setWorking(true);
    try {
      const res = await fetch('/api/auth/email-otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), code: otpInput.trim(), clientId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Verification failed');
      setOtpSent(false);
      onAuthCompleted?.(data);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setWorking(false);
    }
  }

  async function handlePasskeySignIn() {
    setLocalError(null);
    setWorking(true);
    try {
      const chRes = await fetch('/api/auth/passkey/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ email: email.trim() }),
      });
      const ch = await chRes.json().catch(() => ({}));
      if (!chRes.ok) {
        throw new Error(
          ch.message ||
            (locale === 'zh-CN' || locale === 'zh-TW'
              ? '系统中尚未注册任何通行密钥（Passkey）。请先使用管理员邮箱与密码登录，在「用户与身份目录」中创建并绑定 Passkey。'
              : 'No Passkeys are registered yet. Sign in with your email and password first, then register a Passkey in Identity Directory.')
        );
      }

      const assertion = await authenticateBrowserPasskey(ch);
      const authRes = await fetch('/api/auth/passkey/authenticate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({
          ...assertion,
          clientId,
        }),
      });
      const data = await authRes.json().catch(() => ({}));
      if (!authRes.ok) throw new Error(data.message || 'Passkey sign-in failed');
      onAuthCompleted?.(data);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Passkey authentication failed');
    } finally {
      setWorking(false);
    }
  }

  async function handleStartDeviceFlow() {
    setLocalError(null);
    setWorking(true);
    try {
      const res = await fetch('/oauth/device_authorization', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ client_id: clientId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Failed to start Device Flow');
      setDeviceSession(data);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to start Device Flow');
    } finally {
      setWorking(false);
    }
  }

  async function handlePollDevice() {
    if (!deviceSession) return;
    setLocalError(null);
    setWorking(true);
    try {
      const pollRes = await fetch('/api/oauth/device/poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ deviceCode: deviceSession.device_code }),
      });
      const data = await pollRes.json().catch(() => ({}));
      if (!pollRes.ok) {
        throw new Error(
          data.message ||
            (locale === 'zh-CN' || locale === 'zh-TW'
              ? '设备码尚未被已登录账户批准，请先在已登录终端授权后再检查状态。'
              : 'Authorization is still pending. Approve this user code from an authenticated session first.')
        );
      }
      setDeviceSession({ ...deviceSession, approved: true });
      onAuthCompleted?.(data);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Device authorization failed');
    } finally {
      setWorking(false);
    }
  }

  const inputClass = `w-full min-h-[40px] px-3 py-2 text-sm ${radius.control} border ${
    isDarkSurface
      ? 'border-slate-700 bg-slate-900/90 text-slate-100 placeholder:text-slate-500'
      : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100'
  }`;

  const mutedTextClass = isDarkSurface ? 'text-slate-400' : 'text-slate-600 dark:text-slate-400';
  const labelTextClass = isDarkSurface ? 'text-slate-300' : 'text-slate-700 dark:text-slate-300';
  const socialBtnClass = `w-full min-h-[40px] px-3 py-2 ${radius.control} border text-sm font-medium flex items-center justify-center gap-2 transition-colors disabled:opacity-50 ${
    isDarkSurface
      ? 'border-slate-700 bg-slate-900/70 hover:bg-slate-800 text-slate-100'
      : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900/70 hover:bg-slate-50 dark:hover:bg-slate-800/80 text-slate-800 dark:text-slate-100'
  }`;

  const heroPanel = (
    <div className="wm-hero-panel md:col-span-5 p-6 sm:p-7 text-white flex flex-col justify-between gap-6">
      <div className="space-y-4">
        <div className="inline-flex items-center gap-2.5">
          {resolvedTheme.logoUrl ? (
            <img
              src={resolvedTheme.logoUrl}
              alt={resolvedTheme.brandTitle}
              className="h-8 max-w-[140px] object-contain"
            />
          ) : (
            <BrandMark className="w-8 h-8" />
          )}
          <span className="font-display text-sm font-semibold tracking-tight text-white/95">
            {resolvedTheme.brandTitle || 'wimotek/Oauth'}
          </span>
        </div>

        <div className="space-y-2.5 pt-2">
          <h3 className="font-display text-xl font-bold tracking-tight leading-snug text-balance">
            {resolvedTheme.heroTitle}
          </h3>
          <p className="text-xs leading-relaxed text-white/80">
            {resolvedTheme.heroSubtitle}
          </p>
        </div>
      </div>

      <div className="pt-4 border-t border-white/15 flex items-center justify-between gap-2 flex-wrap text-[11px] font-mono text-white/75">
        <span>OIDC 1.0 · PKCE</span>
        <span>RS256</span>
      </div>
    </div>
  );

  const cardBody = (
    <div
      data-wimotek-login-card=""
      className={`${
        isSplit
          ? 'md:col-span-7 p-6 sm:p-7'
          : isMinimal
            ? `w-full ${compact ? 'max-w-sm' : 'max-w-[440px]'} mx-auto p-4 sm:p-6`
            : `w-full ${compact ? 'max-w-sm' : 'max-w-[440px]'} mx-auto bg-white dark:bg-[#111827] border ${
                isDarkSurface ? 'border-slate-800' : 'border-slate-200 dark:border-slate-800'
              } ${radius.card} shadow-sm p-6 sm:p-7`
      } transition-colors`}
    >
      {/* Header */}
      <div className="flex flex-col items-center text-center mb-5">
        {!isSplit &&
          (resolvedTheme.logoUrl ? (
            <img
              src={resolvedTheme.logoUrl}
              alt={resolvedTheme.brandTitle}
              className="h-10 max-w-[160px] object-contain mb-3.5"
            />
          ) : (
            <BrandMark className="w-10 h-10 mb-3.5" />
          ))}
        <h2 className="text-xl font-semibold tracking-tight i18n-safe text-balance leading-snug">
          {headingText}
        </h2>
        <p className={`mt-1 text-xs sm:text-sm ${mutedTextClass} i18n-safe leading-relaxed`}>
          {subtitleText}
        </p>
      </div>

      {/* Multi-Auth Mode Switcher */}
      {availableTabs.length > 1 && (
        <div
          role="tablist"
          aria-label="Authentication methods"
          className={`mt-4 grid grid-cols-2 sm:grid-cols-4 gap-1 p-1 ${radius.control} ${
            isDarkSurface ? 'bg-slate-800/80' : 'bg-slate-100 dark:bg-slate-800/80'
          }`}
        >
          {availableTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeMode === tab.id}
              onClick={() => {
                setMode(tab.id);
                setLocalError(null);
              }}
              className={`px-2 py-1.5 text-[11px] font-medium ${radius.control} transition-colors truncate ${
                activeMode === tab.id
                  ? isDarkSurface
                    ? 'bg-slate-900 text-white shadow-xs'
                    : 'bg-white dark:bg-[#111827] text-slate-900 dark:text-white shadow-xs'
                  : isDarkSurface
                    ? 'text-slate-400 hover:text-white'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {/* Mode 1: Argon2id Email + Password */}
      {activeMode === 'password' && policy.enablePasswordArgon2id && (
        <form onSubmit={handleSubmitPassword} className="mt-4 space-y-3">
          <div>
            <label htmlFor={`hosted-login-email-${scopeUid}`} className={`block text-xs font-medium ${labelTextClass} mb-1 i18n-safe`}>
              {t.emailLabel}
            </label>
            <input
              id={`hosted-login-email-${scopeUid}`}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="username"
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor={`hosted-login-password-${scopeUid}`} className={`block text-xs font-medium ${labelTextClass} mb-1 i18n-safe`}>
              {t.passwordLabel}
            </label>
            <input
              id={`hosted-login-password-${scopeUid}`}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="••••••••••••"
              className={inputClass}
            />
          </div>

          {policy.captchaProvider !== 'none' && (
            <label
              className={`flex items-center justify-between gap-3 px-3 py-2 ${radius.control} border text-xs cursor-pointer ${
                isDarkSurface
                  ? 'border-slate-700 bg-slate-900/60 text-slate-300'
                  : 'border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-900/60 text-slate-700 dark:text-slate-300'
              }`}
            >
              <span className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={captchaVerified}
                  onChange={(e) => setCaptchaVerified(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-300 text-indigo-600"
                />
                <span>{captchaVerified ? 'Human verified' : 'Verify you are human'}</span>
              </span>
              <span className="text-[10px] font-mono text-slate-400">
                {policy.captchaProvider === 'turnstile' ? 'Cloudflare Turnstile' : 'hCaptcha'}
              </span>
            </label>
          )}

          <button
            type="submit"
            disabled={Boolean(busyProvider) || working}
            className={`wm-primary-btn w-full min-h-[40px] px-4 py-2 ${radius.control} text-sm font-medium flex items-center justify-center gap-2 transition-all disabled:opacity-60`}
          >
            <KeyRound className="w-4 h-4 shrink-0" />
            <span className="i18n-safe">{t.signInButton}</span>
          </button>
        </form>
      )}

      {/* Mode 2: Passwordless Email OTP */}
      {activeMode === 'email_otp' && policy.enableEmailOtpMagicLink && (
        <div className="mt-4 space-y-3">
          <form onSubmit={handleSendOtp} className="space-y-2.5">
            <div>
              <label htmlFor={`otp-email-${scopeUid}`} className={`block text-xs font-medium ${labelTextClass} mb-1`}>
                {t.emailLabel}
              </label>
              <input
                id={`otp-email-${scopeUid}`}
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className={inputClass}
              />
            </div>
            <button
              type="submit"
              disabled={working}
              className={`wm-primary-btn w-full min-h-[40px] px-4 py-2 ${radius.control} text-sm font-medium flex items-center justify-center gap-2`}
            >
              <Mail className="w-4 h-4 shrink-0" />
              <span>Send 6-Digit OTP &amp; Magic Link</span>
            </button>
          </form>

          {otpSent && (
            <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-[#0B0F19] border border-slate-200 dark:border-slate-800 space-y-2.5 text-xs">
              <div className={mutedTextClass}>
                A 6-digit verification code has been sent to your email (valid for 5 minutes).
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={otpInput}
                  onChange={(e) => setOtpInput(e.target.value)}
                  placeholder="6-digit OTP"
                  aria-label="6-digit email OTP"
                  className={`flex-1 min-w-0 min-h-[36px] px-3 py-1 font-mono text-sm tabular-nums ${radius.control} border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900`}
                />
                <button
                  type="button"
                  onClick={handleVerifyOtp}
                  disabled={working}
                  className={`wm-primary-btn px-3 py-1.5 ${radius.control} font-medium whitespace-nowrap`}
                >
                  Verify OTP
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Mode 3: Passkeys (WebAuthn / FIDO2) */}
      {activeMode === 'passkey' && policy.enablePasskeysWebAuthn && (
        <div className="mt-4 space-y-3">
          <div className="text-left">
            <label htmlFor={`passkey-email-${scopeUid}`} className={`block text-xs font-medium ${labelTextClass} mb-1`}>
              {t.emailLabel} ({locale === 'zh-CN' || locale === 'zh-TW' ? '可选' : 'Optional'})
            </label>
            <input
              id={`passkey-email-${scopeUid}`}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@company.com"
              autoComplete="username webauthn"
              className={inputClass}
            />
          </div>
          <div
            className={`p-3.5 ${radius.control} border text-center space-y-1.5 ${
              isDarkSurface
                ? 'bg-slate-900/70 border-slate-800'
                : 'bg-slate-50 dark:bg-[#0B0F19] border-slate-200 dark:border-slate-800'
            }`}
          >
            <Fingerprint className="w-7 h-7 mx-auto wm-accent-text" />
            <div className="text-xs font-medium">
              {locale === 'zh-CN' || locale === 'zh-TW'
                ? 'WebAuthn / FIDO2 通行密钥认证'
                : 'Phishing-Resistant Passkey (WebAuthn / FIDO2)'}
            </div>
            <p className={`text-[11px] ${mutedTextClass} leading-relaxed`}>
              {locale === 'zh-CN' || locale === 'zh-TW'
                ? '仅支持已在后台「用户与身份目录」中注册并保存公钥的 Passkey，通过硬件签名校验身份。'
                : 'Requires a Passkey registered and saved in Identity Directory. Verified cryptographically via WebAuthn.'}
            </p>
          </div>
          <button
            type="button"
            onClick={handlePasskeySignIn}
            disabled={working}
            className={`wm-primary-btn w-full min-h-[42px] px-4 py-2 ${radius.control} text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-60`}
          >
            <ShieldCheck className="w-4 h-4 shrink-0" />
            <span>
              {working
                ? locale === 'zh-CN' || locale === 'zh-TW'
                  ? '正在校验 Passkey...'
                  : 'Verifying Passkey...'
                : locale === 'zh-CN' || locale === 'zh-TW'
                  ? '使用已注册 Passkey 登录'
                  : 'Sign in with Registered Passkey'}
            </span>
          </button>
        </div>
      )}

      {/* Mode 4: OAuth 2.0 Device Flow (RFC 8628) */}
      {activeMode === 'device' && policy.enableDeviceFlowRfc8628 && (
        <div className="mt-4 space-y-3">
          {!deviceSession ? (
            <button
              type="button"
              onClick={handleStartDeviceFlow}
              disabled={working}
              className={`wm-primary-btn w-full min-h-[42px] px-4 py-2 ${radius.control} text-sm font-medium flex items-center justify-center gap-2`}
            >
              <Smartphone className="w-4 h-4 shrink-0" />
              <span>Generate Device Code (RFC 8628)</span>
            </button>
          ) : (
            <div
              className={`p-4 ${radius.control} border text-center space-y-2.5 ${
                isDarkSurface
                  ? 'bg-slate-900/70 border-slate-800'
                  : 'bg-slate-50 dark:bg-[#0B0F19] border-slate-200 dark:border-slate-800'
              }`}
            >
              <div className="text-[11px] text-slate-500">
                {locale === 'zh-CN' || locale === 'zh-TW'
                  ? '请在已登录设备打开验证地址并输入下方授权码'
                  : 'Approve this code on an already signed-in device'}
              </div>
              <div className="font-mono text-2xl font-bold tracking-widest tabular-nums">
                {deviceSession.user_code}
              </div>
              <div className="text-[11px] font-mono text-slate-500 truncate">{deviceSession.verification_uri}</div>
              {deviceSession.approved ? (
                <div className="inline-flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                  <CheckCircle2 className="w-4 h-4" /> Approved &amp; Tokens Issued
                </div>
              ) : (
                <button
                  type="button"
                  onClick={handlePollDevice}
                  disabled={working}
                  className={`wm-primary-btn w-full min-h-[38px] px-3 py-1.5 ${radius.control} text-xs font-medium`}
                >
                  {working
                    ? locale === 'zh-CN' || locale === 'zh-TW'
                      ? '检查授权状态...'
                      : 'Checking approval...'
                    : locale === 'zh-CN' || locale === 'zh-TW'
                      ? '检查设备授权状态'
                      : 'Check Approval Status'}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {(localError || errorMessage) && (
        <div
          role="alert"
          className={`mt-3 flex items-start gap-2 text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 ${radius.control} px-3 py-2 leading-relaxed`}
        >
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="i18n-safe">{localError || errorMessage}</span>
        </div>
      )}

      {/* Notice when all first-party auth methods and social connectors are disabled */}
      {activeMode === null && enabledCount === 0 && (
        <div
          className={`mt-4 p-3.5 ${radius.control} border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 text-xs text-amber-800 dark:text-amber-300 text-center leading-relaxed`}
        >
          {locale === 'zh-CN' || locale === 'zh-TW'
            ? '所有第一方登录方式与社交连接器均已关闭。请在「认证与风控策略」或「社交连接器」中至少开启一种登录方式。'
            : 'All first-party authentication methods and social connectors are disabled. Enable at least one method in Auth & Risk Policy or Social Connectors.'}
        </div>
      )}

      {/* Divider (only when both first-party auth and social connectors are active) */}
      {activeMode !== null && enabledCount > 0 && (
        <div className="relative my-5">
          <div className="absolute inset-0 flex items-center" aria-hidden="true">
            <div className={`w-full border-t ${isDarkSurface ? 'border-slate-800' : 'border-slate-200 dark:border-slate-800'}`} />
          </div>
          <div className="relative flex justify-center">
            <span className="wm-divider-chip bg-white dark:bg-[#111827] px-3 text-xs text-slate-500 dark:text-slate-400 i18n-safe">
              {t.orContinueWith}
            </span>
          </div>
        </div>
      )}

      {/* Adaptive Social Connectors Zone */}
      {enabledCount === 0 ? (
        activeMode !== null ? (
          <p className={`text-xs text-center ${mutedTextClass} mt-4 py-2 i18n-safe leading-relaxed`}>
            {t.noConnectorsEnabled}
          </p>
        ) : null
      ) : (
        <div className="space-y-2">
          <div className={`grid ${resolvedTheme.socialLayout === 'grid' ? 'grid-cols-2' : 'grid-cols-1'} gap-2`}>
            {primary.map((conn) => (
              <button
                key={conn.id}
                type="button"
                onClick={() => onSocialSignIn(conn.provider)}
                disabled={Boolean(busyProvider) || working}
                className={socialBtnClass}
              >
                <ProviderIcon provider={conn.provider} className="w-4 h-4 shrink-0" />
                <span className="min-w-0 i18n-safe text-center leading-snug truncate">
                  {resolvedTheme.socialLayout === 'grid'
                    ? conn.displayName
                    : t.continueWithProvider.replace('{provider}', conn.displayName)}
                </span>
              </button>
            ))}
          </div>

          {overflow.length > 0 && (
            <div className="pt-1">
              {expanded && (
                <div className="grid grid-cols-2 gap-2 mb-2">
                  {overflow.map((conn) => (
                    <button
                      key={conn.id}
                      type="button"
                      onClick={() => onSocialSignIn(conn.provider)}
                      disabled={Boolean(busyProvider) || working}
                      className={`${socialBtnClass} text-xs`}
                    >
                      <ProviderIcon provider={conn.provider} className="w-4 h-4 shrink-0" />
                      <span className="min-w-0 truncate">{conn.displayName}</span>
                    </button>
                  ))}
                </div>
              )}

              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpanded((v) => !v)}
                className="w-full py-1.5 text-xs font-medium wm-accent-text hover:opacity-80 flex items-center justify-center gap-1.5 transition-opacity"
              >
                <span className="i18n-safe">
                  {expanded ? t.fewerSignInMethods : `${t.moreSignInMethods} (${overflow.length})`}
                </span>
                {expanded ? <ChevronUp className="w-3.5 h-3.5 shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 shrink-0" />}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Quiet protocol footer */}
      <div
        className={`mt-5 pt-3.5 border-t ${
          isDarkSurface ? 'border-slate-800/80' : 'border-slate-100 dark:border-slate-800/80'
        } flex items-center justify-between text-[11px] text-slate-400 dark:text-slate-500 gap-2 flex-wrap`}
      >
        <span>{resolvedTheme.footerText || 'wimotek/Oauth'}</span>
        <span className="font-mono">OIDC · Passkey · OTP</span>
      </div>
    </div>
  );

  return (
    <div
      dir={rtl ? 'rtl' : 'ltr'}
      data-wimotek-login-root=""
      data-wimotek-scope={scopeAttr}
      data-layout={resolvedTheme.layout}
      data-surface={resolvedTheme.surfaceMode}
      className={`w-full ${fontClass} ${isDarkSurface ? 'dark' : ''}`}
    >
      <style>{scopedThemeCss}</style>

      {isSplit ? (
        <div
          className={`w-full max-w-[820px] mx-auto grid grid-cols-1 md:grid-cols-12 overflow-hidden border ${
            isDarkSurface ? 'border-slate-800 bg-[#111827]' : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827]'
          } ${radius.card} shadow-md`}
        >
          {resolvedTheme.layout === 'split_left' ? (
            <>
              {heroPanel}
              {cardBody}
            </>
          ) : (
            <>
              {cardBody}
              {heroPanel}
            </>
          )}
        </div>
      ) : (
        cardBody
      )}
    </div>
  );
}
