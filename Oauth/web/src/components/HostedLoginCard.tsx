import React, { useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  KeyRound,
  Zap,
  AlertCircle,
  Mail,
  Fingerprint,
  Smartphone,
  ShieldCheck,
  CheckCircle2,
  Sparkles,
} from 'lucide-react';
import type { AuthPolicyConfig, Locale, OidcFlowTrace, SocialConnector } from '../types';
import { TRANSLATIONS, partitionConnectors } from '../lib/i18n';
import { BrandMark, ProviderIcon } from './ProviderIcons';

type AuthModeTab = 'password' | 'email_otp' | 'passkey' | 'device';

interface HostedLoginCardProps {
  locale: Locale;
  connectors: SocialConnector[];
  authPolicy?: AuthPolicyConfig;
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
  const [mode, setMode] = useState<AuthModeTab>('password');
  const [email, setEmail] = useState('admin@wimotek.dev');
  const [password, setPassword] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  // Email OTP / Magic Link state
  const [otpChallenge, setOtpChallenge] = useState<{
    code: string;
    magicToken: string;
    magicLinkUrl: string;
  } | null>(null);
  const [otpInput, setOtpInput] = useState('');

  // Device Flow (RFC 8628) state
  const [deviceSession, setDeviceSession] = useState<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    approved?: boolean;
  } | null>(null);

  // Turnstile / hCaptcha checkbox verification state
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
    captchaSiteKey: '0x4AAAAAA_demo_turnstile_slot',
  };

  const { primary, overflow } = partitionConnectors(connectors, 3);
  const enabledCount = primary.length + overflow.length;

  const availableTabs: { id: AuthModeTab; label: string }[] = [
    ...(policy.enablePasswordArgon2id ? [{ id: 'password' as const, label: t.tabPassword }] : []),
    ...(policy.enableEmailOtpMagicLink ? [{ id: 'email_otp' as const, label: t.tabEmailOtp }] : []),
    ...(policy.enablePasskeysWebAuthn ? [{ id: 'passkey' as const, label: t.tabPasskey }] : []),
    ...(policy.enableDeviceFlowRfc8628 ? [{ id: 'device' as const, label: t.tabDeviceFlow }] : []),
  ];

  async function handleSubmitPassword(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);
    if (policy.captchaProvider !== 'none' && !captchaVerified) {
      setLocalError('Please complete human verification first.');
      return;
    }
    if (!email.trim() || !password) {
      setLocalError('Please enter both email and password, or use One-Click Login.');
      return;
    }
    if (onPasswordSignIn) {
      await onPasswordSignIn(email.trim(), password);
    } else {
      await onSocialSignIn('local_password');
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
      setOtpChallenge(data.sandboxPreview);
      setOtpInput(data.sandboxPreview.code);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'OTP failed');
    } finally {
      setWorking(false);
    }
  }

  async function handleVerifyOtp(useMagic = false) {
    setLocalError(null);
    setWorking(true);
    try {
      const res = await fetch('/api/auth/email-otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          useMagic && otpChallenge
            ? { magicToken: otpChallenge.magicToken, clientId }
            : { email: email.trim(), code: otpInput.trim(), clientId }
        ),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Verification failed');
      setOtpChallenge(null);
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
      const chRes = await fetch('/api/auth/passkey/challenge', { method: 'POST' });
      const ch = await chRes.json();
      const authRes = await fetch('/api/auth/passkey/authenticate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challenge: ch.challenge,
          email: email.trim() || 'admin@wimotek.dev',
          clientId,
          authenticator: 'TouchID / FaceID / Windows Hello',
        }),
      });
      const data = await authRes.json();
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
        body: JSON.stringify({ client_id: clientId }),
      });
      const data = await res.json();
      setDeviceSession(data);
    } catch {
      setLocalError('Failed to start Device Flow');
    } finally {
      setWorking(false);
    }
  }

  async function handleApproveAndPollDevice() {
    if (!deviceSession) return;
    setLocalError(null);
    setWorking(true);
    try {
      await fetch('/api/oauth/device/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userCode: deviceSession.user_code, email: email.trim() || 'admin@wimotek.dev' }),
      });
      const pollRes = await fetch('/api/oauth/device/poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode: deviceSession.device_code }),
      });
      const data = await pollRes.json();
      if (!pollRes.ok) throw new Error(data.message || 'Device poll failed');
      setDeviceSession({ ...deviceSession, approved: true });
      onAuthCompleted?.(data);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Device authorization failed');
    } finally {
      setWorking(false);
    }
  }

  return (
    <div
      dir={rtl ? 'rtl' : 'ltr'}
      className={`w-full ${compact ? 'max-w-sm' : 'max-w-[440px]'} mx-auto bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl shadow-sm p-6 sm:p-7 transition-colors`}
    >
      {/* Header */}
      <div className="flex flex-col items-center text-center mb-5">
        <BrandMark className="w-10 h-10 mb-3.5" />
        <h2 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-50 i18n-safe text-balance leading-snug">
          {t.loginTitle}
        </h2>
        <p className="mt-1 text-xs sm:text-sm text-slate-600 dark:text-slate-400 i18n-safe leading-relaxed">
          {t.loginSubtitle}
        </p>
      </div>

      {/* Primary One-Click SSO button */}
      <button
        type="button"
        onClick={() => onSocialSignIn('one_click')}
        disabled={Boolean(busyProvider) || working}
        className="w-full min-h-[42px] px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 disabled:opacity-60 text-white text-sm font-medium flex items-center justify-center gap-2 transition-colors"
      >
        <Zap className="w-4 h-4 shrink-0" />
        <span className="i18n-safe leading-snug">{t.oneClickLogin}</span>
      </button>

      {/* Multi-Auth Mode Switcher */}
      {availableTabs.length > 1 && (
        <div
          role="tablist"
          aria-label="Authentication methods"
          className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800/80"
        >
          {availableTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={mode === tab.id}
              onClick={() => {
                setMode(tab.id);
                setLocalError(null);
              }}
              className={`px-2 py-1.5 text-[11px] font-medium rounded-md transition-colors truncate ${
                mode === tab.id
                  ? 'bg-white dark:bg-[#111827] text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {/* Mode 1: Argon2id Email + Password */}
      {mode === 'password' && (
        <form onSubmit={handleSubmitPassword} className="mt-4 space-y-3">
          <div>
            <label htmlFor="hosted-login-email" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1 i18n-safe">
              {t.emailLabel}
            </label>
            <input
              id="hosted-login-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              className="w-full min-h-[40px] px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
            />
          </div>

          <div>
            <label htmlFor="hosted-login-password" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1 i18n-safe">
              {t.passwordLabel}
            </label>
            <input
              id="hosted-login-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="••••••••••••"
              className="w-full min-h-[40px] px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
            />
          </div>

          {/* Cloudflare Turnstile / hCaptcha Slot */}
          {policy.captchaProvider !== 'none' && (
            <label className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-900/60 text-xs cursor-pointer">
              <span className="flex items-center gap-2 text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={captchaVerified}
                  onChange={(e) => setCaptchaVerified(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-300 text-indigo-600"
                />
                <span>
                  {captchaVerified ? 'Human verified' : 'Verify you are human'}
                </span>
              </span>
              <span className="text-[10px] font-mono text-slate-400">
                {policy.captchaProvider === 'turnstile' ? 'Cloudflare Turnstile' : 'hCaptcha'}
              </span>
            </label>
          )}

          <button
            type="submit"
            disabled={Boolean(busyProvider) || working}
            className="w-full min-h-[40px] px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-white text-sm font-medium flex items-center justify-center gap-2 transition-colors disabled:opacity-60"
          >
            <KeyRound className="w-4 h-4 shrink-0" />
            <span className="i18n-safe">{t.signInButton}</span>
          </button>
        </form>
      )}

      {/* Mode 2: Passwordless Email OTP & Magic Link */}
      {mode === 'email_otp' && (
        <div className="mt-4 space-y-3">
          <form onSubmit={handleSendOtp} className="space-y-2.5">
            <div>
              <label htmlFor="otp-email" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                {t.emailLabel}
              </label>
              <input
                id="otp-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full min-h-[40px] px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
            <button
              type="submit"
              disabled={working}
              className="w-full min-h-[40px] px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-sm font-medium flex items-center justify-center gap-2"
            >
              <Mail className="w-4 h-4 shrink-0" />
              <span>Send 6-Digit OTP &amp; Magic Link</span>
            </button>
          </form>

          {otpChallenge && (
            <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-[#0B0F19] border border-slate-200 dark:border-slate-800 space-y-2.5 text-xs">
              <div className="flex items-center justify-between text-slate-500">
                <span>Sandbox Email Preview (5m TTL)</span>
                <code className="font-mono font-bold text-indigo-600 dark:text-indigo-400 tabular-nums">
                  {otpChallenge.code}
                </code>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={otpInput}
                  onChange={(e) => setOtpInput(e.target.value)}
                  placeholder="6-digit OTP"
                  aria-label="6-digit email OTP"
                  className="flex-1 min-w-0 min-h-[36px] px-3 py-1 font-mono text-sm tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                />
                <button
                  type="button"
                  onClick={() => handleVerifyOtp(false)}
                  disabled={working}
                  className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-medium whitespace-nowrap"
                >
                  Verify OTP
                </button>
              </div>
              <button
                type="button"
                onClick={() => handleVerifyOtp(true)}
                disabled={working}
                className="w-full py-1.5 rounded-md border border-indigo-200 dark:border-indigo-900/60 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 font-medium flex items-center justify-center gap-1.5"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>Click Magic Link to Sign In</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* Mode 3: Passkeys (WebAuthn / FIDO2) */}
      {mode === 'passkey' && (
        <div className="mt-4 space-y-3 text-center">
          <div className="p-4 rounded-lg bg-slate-50 dark:bg-[#0B0F19] border border-slate-200 dark:border-slate-800 space-y-2">
            <Fingerprint className="w-8 h-8 mx-auto text-indigo-600 dark:text-indigo-400" />
            <div className="text-xs font-medium text-slate-900 dark:text-white">
              Phishing-Resistant Passkey (WebAuthn / FIDO2)
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
              Cryptographically bound to this domain RP ID. Works with FaceID, TouchID, Windows Hello, and YubiKey without passwords.
            </p>
          </div>
          <button
            type="button"
            onClick={handlePasskeySignIn}
            disabled={working}
            className="w-full min-h-[42px] px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-sm font-medium flex items-center justify-center gap-2"
          >
            <ShieldCheck className="w-4 h-4 shrink-0" />
            <span>{working ? 'Verifying Passkey...' : 'Sign in with Passkey (FaceID / TouchID)'}</span>
          </button>
        </div>
      )}

      {/* Mode 4: OAuth 2.0 Device Flow (RFC 8628) */}
      {mode === 'device' && (
        <div className="mt-4 space-y-3">
          {!deviceSession ? (
            <button
              type="button"
              onClick={handleStartDeviceFlow}
              disabled={working}
              className="w-full min-h-[42px] px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-sm font-medium flex items-center justify-center gap-2"
            >
              <Smartphone className="w-4 h-4 shrink-0" />
              <span>Generate Device Code (RFC 8628)</span>
            </button>
          ) : (
            <div className="p-4 rounded-lg bg-slate-50 dark:bg-[#0B0F19] border border-slate-200 dark:border-slate-800 text-center space-y-2.5">
              <div className="text-[11px] text-slate-500">Enter this code on your phone or CLI verification URL</div>
              <div className="font-mono text-2xl font-bold tracking-widest text-slate-900 dark:text-white tabular-nums">
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
                  onClick={handleApproveAndPollDevice}
                  disabled={working}
                  className="w-full min-h-[38px] px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium"
                >
                  Confirm on Phone &amp; Complete Login
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {(localError || errorMessage) && (
        <div
          role="alert"
          className="mt-3 flex items-start gap-2 text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 rounded-lg px-3 py-2 leading-relaxed"
        >
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="i18n-safe">{localError || errorMessage}</span>
        </div>
      )}

      {/* Divider */}
      <div className="relative my-5">
        <div className="absolute inset-0 flex items-center" aria-hidden="true">
          <div className="w-full border-t border-slate-200 dark:border-slate-800" />
        </div>
        <div className="relative flex justify-center">
          <span className="bg-white dark:bg-[#111827] px-3 text-xs text-slate-500 dark:text-slate-400 i18n-safe">
            {t.orContinueWith}
          </span>
        </div>
      </div>

      {/* Adaptive Social Connectors Zone */}
      {enabledCount === 0 ? (
        <p className="text-xs text-center text-slate-500 dark:text-slate-400 py-2 i18n-safe leading-relaxed">
          {t.noConnectorsEnabled}
        </p>
      ) : (
        <div className="space-y-2">
          <div className="grid grid-cols-1 gap-2">
            {primary.map((conn) => (
              <button
                key={conn.id}
                type="button"
                onClick={() => onSocialSignIn(conn.provider)}
                disabled={Boolean(busyProvider) || working}
                className="w-full min-h-[40px] px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900/70 hover:bg-slate-50 dark:hover:bg-slate-800/80 text-slate-800 dark:text-slate-100 text-sm font-medium flex items-center justify-center gap-2.5 transition-colors disabled:opacity-50"
              >
                <ProviderIcon provider={conn.provider} className="w-4 h-4 shrink-0" />
                <span className="min-w-0 i18n-safe text-center leading-snug">
                  {t.continueWithProvider.replace('{provider}', conn.displayName)}
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
                      className="min-h-[40px] px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900/70 hover:bg-slate-50 dark:hover:bg-slate-800/80 text-slate-800 dark:text-slate-100 text-xs font-medium flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
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
                className="w-full py-1.5 text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 flex items-center justify-center gap-1.5 transition-colors"
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
      <div className="mt-5 pt-3.5 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between text-[11px] text-slate-400 dark:text-slate-500 gap-2 flex-wrap">
        <span>wimotek/Oauth</span>
        <span className="font-mono">OIDC · Passkey · OTP · RFC 8628</span>
      </div>
    </div>
  );
}
