import React, { useEffect, useRef, useState } from 'react';
import {
  ShieldCheck,
  QrCode,
  CheckCircle2,
  AlertCircle,
  Lock,
  Activity,
  Bot,
} from 'lucide-react';
import type { AuthPolicyConfig, CaptchaProvider, Locale } from '../types';
import { TRANSLATIONS } from '../lib/i18n';

interface SecurityPolicyViewProps {
  locale: Locale;
  policy: AuthPolicyConfig;
  sessionToken: string;
  onSavePolicy: (next: AuthPolicyConfig) => Promise<void>;
}

/**
 * Deterministic decorative SVG QR visual derived from otpauth URI for zero-dependency TOTP enrollment preview.
 */
function SimpleQrPreview({ seed }: { seed: string }) {
  const size = 15;
  const cells: boolean[][] = Array.from({ length: size }, (_, r) =>
    Array.from({ length: size }, (_, c) => {
      // Corner finder patterns
      const inTL = r < 5 && c < 5;
      const inTR = r < 5 && c >= size - 5;
      const inBL = r >= size - 5 && c < 5;
      if (inTL || inTR || inBL) {
        const lr = inBL ? r - (size - 5) : r;
        const lc = inTR ? c - (size - 5) : c;
        return lr === 0 || lr === 4 || lc === 0 || lc === 4 || (lr === 2 && lc === 2);
      }
      const code = seed.charCodeAt((r * size + c) % seed.length);
      return ((code + r * 7 + c * 13) % 3) === 0;
    })
  );

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="w-32 h-32 p-2 bg-white rounded-lg border border-slate-200 shrink-0"
      aria-label="TOTP Authenticator QR Code"
    >
      {cells.map((row, r) =>
        row.map((on, c) =>
          on ? <rect key={`${r}-${c}`} x={c} y={r} width="1" height="1" fill="#0F172A" /> : null
        )
      )}
    </svg>
  );
}

export function SecurityPolicyView({
  locale,
  policy,
  sessionToken,
  onSavePolicy,
}: SecurityPolicyViewProps) {
  const t = TRANSLATIONS[locale];
  const [draft, setDraft] = useState<AuthPolicyConfig>(policy);
  const draftRef = useRef<AuthPolicyConfig>(policy);
  const pendingSavesRef = useRef(0);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);

  useEffect(() => {
    if (pendingSavesRef.current === 0) {
      draftRef.current = policy;
      setDraft(policy);
    }
  }, [policy]);

  async function handleToggleSwitch(key: keyof AuthPolicyConfig, nextValue: boolean) {
    const nextPolicy: AuthPolicyConfig = { ...draftRef.current, [key]: nextValue };
    draftRef.current = nextPolicy;
    setDraft(nextPolicy);
    pendingSavesRef.current += 1;
    setSaving(true);
    setSavedOk(false);
    try {
      await onSavePolicy(nextPolicy);
      if (pendingSavesRef.current === 1) {
        setSavedOk(true);
        window.setTimeout(() => setSavedOk(false), 1800);
      }
    } finally {
      pendingSavesRef.current = Math.max(0, pendingSavesRef.current - 1);
      if (pendingSavesRef.current === 0) {
        setSaving(false);
      }
    }
  }

  // Live TOTP 2FA Enrollment State
  const [totpEnroll, setTotpEnroll] = useState<{
    secret: string;
    otpauthUri: string;
    currentCode: string;
    recoveryCodes: string[];
  } | null>(null);
  const [totpInput, setTotpInput] = useState('');
  const [totpVerifyMsg, setTotpVerifyMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Live Risk Control Backoff Probe State
  const [riskProbe, setRiskProbe] = useState<{
    attempts: number;
    backoffSec: number;
    locked: boolean;
    cacheBackend: string;
  } | null>(null);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSavedOk(false);
    try {
      await onSavePolicy(draft);
      setSavedOk(true);
      setTimeout(() => setSavedOk(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  async function handleStartTotpEnroll() {
    setTotpVerifyMsg(null);
    const res = await fetch('/api/auth/totp/enroll', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    if (res.ok) {
      const data = await res.json();
      setTotpEnroll(data);
      setTotpInput(data.currentCode);
    }
  }

  async function handleVerifyTotp(e: React.FormEvent) {
    e.preventDefault();
    setTotpVerifyMsg(null);
    const res = await fetch('/api/auth/totp/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ code: totpInput }),
    });
    const data = await res.json();
    setTotpVerifyMsg({ ok: Boolean(data.ok), text: data.message });
  }

  async function handleSimulateBruteForce() {
    const res = await fetch('/api/security/risk/test-bruteforce', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ email: 'bruteforce-probe@acme-corp.com' }),
    });
    if (res.ok) {
      setRiskProbe(await res.json());
    }
  }

  const toggleItems: {
    key: keyof AuthPolicyConfig;
    phase: string;
    title: string;
    desc: string;
  }[] = [
    {
      key: 'enablePasswordArgon2id',
      phase: 'Phase 1 Core',
      title: 'Email + Password (Argon2id Strong Hash)',
      desc: '64 MiB memory-hard Argon2id hashing resistant to GPU/ASIC brute-force attacks.',
    },
    {
      key: 'enableEmailOtpMagicLink',
      phase: 'Phase 1 Core',
      title: 'Passwordless Email OTP (6-digit) & Magic Link',
      desc: 'Zero-SMS-cost passwordless login and account recovery backed by 5-minute TTL cache.',
    },
    {
      key: 'enableTotp2fa',
      phase: 'Phase 1 Core',
      title: 'TOTP 2FA (RFC 6238 Authenticator + Recovery Codes)',
      desc: 'Zero-cost MFA compatible with Microsoft/Google Authenticator & 1Password plus 8 single-use recovery codes.',
    },
    {
      key: 'enablePasskeysWebAuthn',
      phase: 'Phase 2 Plus',
      title: 'Passkeys (WebAuthn / FIDO2 Phishing-Resistant)',
      desc: 'Domain-bound TouchID / FaceID / Windows Hello sign-in that never leaks credentials to lookalike domains.',
    },
    {
      key: 'enableDeviceFlowRfc8628',
      phase: 'Phase 2 Plus',
      title: 'OAuth 2.0 Device Flow (RFC 8628 Cross-Device QR)',
      desc: 'Standard Device Authorization Grant for CLI tools, TVs, and mobile-confirmed desktop login.',
    },
    {
      key: 'jitVerifiedEmailAutoLink',
      phase: 'Progressive Identity',
      title: 'JIT Sync + Verified-Email Smooth Account Linking',
      desc: 'Automatically links upstream Microsoft/Google/WeChat logins onto existing legacy accounts when email_verified is true.',
    },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
          {t.securityTitle}
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400 i18n-safe">
          {t.securitySubtitle}
        </p>
      </div>

      {/* Auth Method Matrix + Risk Control Form */}
      <form onSubmit={handleSave} className="space-y-6">
        <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl divide-y divide-slate-100 dark:divide-slate-800 overflow-hidden">
          <div className="px-6 py-4 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                Authentication Methods &amp; Rollout Priority
              </h2>
            </div>
            <span className="text-xs text-slate-500 flex items-center gap-1.5">
              {savedOk ? (
                <span className="text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1 font-medium">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  {locale === 'zh-CN' || locale === 'zh-TW' ? '已实时生效' : 'Applied live'}
                </span>
              ) : (
                <span>
                  {locale === 'zh-CN' || locale === 'zh-TW' ? '开关切换即时生效于托管登录页' : 'Immediate effect on Hosted Login'}
                </span>
              )}
            </span>
          </div>

          {toggleItems.map((item) => {
            const checked = Boolean(draft[item.key]);
            return (
              <div key={item.key} className="px-6 py-4 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-slate-900 dark:text-white">{item.title}</span>
                    <span className="text-xs font-mono text-slate-400">· {item.phase}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{item.desc}</p>
                </div>

                <button
                  type="button"
                  role="switch"
                  aria-checked={checked}
                  aria-label={item.title}
                  onClick={() => void handleToggleSwitch(item.key, !checked)}
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                    checked ? 'bg-indigo-600' : 'bg-slate-300 dark:bg-slate-700'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      checked ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
            );
          })}
        </section>

        {/* Invisible Risk Control & Anti-Abuse Settings */}
        <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5">
          <div className="flex items-center gap-2">
            <Bot className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
              Invisible Risk Control &amp; Bot Protection Slot
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label htmlFor="policy-rl" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                IP Rate Limit (req/min)
              </label>
              <input
                id="policy-rl"
                type="number"
                min={5}
                max={1000}
                value={draft.ipRateLimitPerMin}
                onChange={(e) => setDraft((p) => ({ ...p, ipRateLimitPerMin: Number(e.target.value) }))}
                className="w-full min-h-[38px] px-3 py-1.5 text-sm font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>

            <div>
              <label htmlFor="policy-lock" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Backoff Lockout Threshold
              </label>
              <input
                id="policy-lock"
                type="number"
                min={2}
                max={10}
                value={draft.lockoutThreshold}
                onChange={(e) => setDraft((p) => ({ ...p, lockoutThreshold: Number(e.target.value) }))}
                className="w-full min-h-[38px] px-3 py-1.5 text-sm font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>

            <div>
              <label htmlFor="policy-captcha" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Human Verification Slot
              </label>
              <select
                id="policy-captcha"
                value={draft.captchaProvider}
                onChange={(e) => setDraft((p) => ({ ...p, captchaProvider: e.target.value as CaptchaProvider }))}
                className="w-full min-h-[38px] px-3 py-1.5 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              >
                <option value="turnstile">Cloudflare Turnstile</option>
                <option value="hcaptcha">hCaptcha</option>
                <option value="none">Disabled</option>
              </select>
            </div>

            <div>
              <label htmlFor="policy-sitekey" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Captcha Site Key
              </label>
              <input
                id="policy-sitekey"
                type="text"
                value={draft.captchaSiteKey}
                onChange={(e) => setDraft((p) => ({ ...p, captchaSiteKey: e.target.value }))}
                className="w-full min-h-[38px] px-3 py-1.5 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
          </div>

          <div className="pt-4 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleSimulateBruteForce}
                className="px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium flex items-center gap-1.5"
              >
                <Activity className="w-3.5 h-3.5" />
                <span>Simulate Failed Login Attempt</span>
              </button>
              {riskProbe && (
                <span className="text-xs font-mono text-slate-600 dark:text-slate-300">
                  Attempts: {riskProbe.attempts} · Backoff: {riskProbe.backoffSec}s · {riskProbe.locked ? 'LOCKED' : 'Open'} ({riskProbe.cacheBackend})
                </span>
              )}
            </div>

            <div className="flex items-center gap-3">
              {savedOk && (
                <span className="text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-1">
                  <CheckCircle2 className="w-4 h-4" /> Policy applied
                </span>
              )}
              <button
                type="submit"
                disabled={saving}
                className="min-h-[38px] px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium transition-colors"
              >
                {saving ? '...' : 'Save Policy & Apply'}
              </button>
            </div>
          </div>
        </section>
      </form>

      {/* Interactive TOTP 2FA Enrollment & Recovery Codes Lab */}
      <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <QrCode className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
              TOTP 2FA (RFC 6238) &amp; Single-Use Recovery Codes Enrollment
            </h2>
          </div>
          <button
            type="button"
            onClick={handleStartTotpEnroll}
            className="min-h-[38px] px-3.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium flex items-center gap-1.5 whitespace-nowrap"
          >
            <Lock className="w-3.5 h-3.5" />
            <span>Generate New TOTP Secret &amp; Recovery Codes</span>
          </button>
        </div>

        {totpEnroll && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 pt-3 border-t border-slate-100 dark:border-slate-800">
            <div className="lg:col-span-7 flex flex-col sm:flex-row gap-5 items-start">
              <SimpleQrPreview seed={totpEnroll.otpauthUri} />
              <div className="space-y-3 min-w-0 flex-1 text-xs">
                <div>
                  <div className="text-slate-500 mb-0.5">Base32 Secret (Encrypted at rest via AES-256-GCM)</div>
                  <code className="font-mono text-slate-900 dark:text-white break-all">{totpEnroll.secret}</code>
                </div>
                <div>
                  <div className="text-slate-500 mb-0.5">Live 6-Digit Authenticator Code (30s window)</div>
                  <code className="font-mono text-base font-bold text-indigo-600 dark:text-indigo-400 tabular-nums">
                    {totpEnroll.currentCode}
                  </code>
                </div>

                <form onSubmit={handleVerifyTotp} className="flex items-center gap-2 pt-1">
                  <input
                    type="text"
                    value={totpInput}
                    onChange={(e) => setTotpInput(e.target.value)}
                    placeholder="Enter 6-digit code"
                    aria-label="TOTP 6-digit code"
                    className="w-40 min-h-[36px] px-3 py-1.5 text-sm font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                  />
                  <button
                    type="submit"
                    className="min-h-[36px] px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium"
                  >
                    Verify &amp; Bind 2FA
                  </button>
                </form>

                {totpVerifyMsg && (
                  <div
                    className={`flex items-center gap-1.5 text-xs ${
                      totpVerifyMsg.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
                    }`}
                  >
                    {totpVerifyMsg.ok ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                    <span>{totpVerifyMsg.text}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="lg:col-span-5 bg-slate-50 dark:bg-[#0B0F19] border border-slate-200 dark:border-slate-800 rounded-lg p-4">
              <div className="text-xs font-semibold text-slate-800 dark:text-slate-200 mb-2">
                8 Single-Use Recovery Codes
              </div>
              <div className="grid grid-cols-2 gap-2 font-mono text-xs tabular-nums text-slate-700 dark:text-slate-300">
                {totpEnroll.recoveryCodes.map((rc) => (
                  <div key={rc} className="px-2 py-1 rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-center">
                    {rc}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
