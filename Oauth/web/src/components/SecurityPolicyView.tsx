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
import { TotpEnrollModal, type TotpEnrollDraft } from './QrCodeSvg';
import { AdminApiTokensSection } from './AdminApiTokensSection';

interface SecurityPolicyViewProps {
  locale: Locale;
  policy: AuthPolicyConfig;
  sessionToken: string;
  issuerUrl?: string;
  onSavePolicy: (next: AuthPolicyConfig) => Promise<void>;
}

export function SecurityPolicyView({
  locale,
  policy,
  sessionToken,
  issuerUrl,
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

  const isZh = locale === 'zh-CN' || locale === 'zh-TW';

  // Live TOTP 2FA Modal Enrollment State
  const [totpEnroll, setTotpEnroll] = useState<TotpEnrollDraft | null>(null);
  const [totpBusy, setTotpBusy] = useState(false);
  const [totpError, setTotpError] = useState<string | null>(null);
  const [totpVerifiedCodes, setTotpVerifiedCodes] = useState<string[] | null>(null);
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

  function buildAuthHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { 'X-Requested-With': 'XMLHttpRequest', ...extra };
    if (sessionToken && sessionToken !== 'cookie_session') {
      h.Authorization = `Bearer ${sessionToken}`;
    }
    return h;
  }

  async function handleStartTotpEnroll() {
    if (!draft.enableTotp2fa) {
      setTotpVerifyMsg({
        ok: false,
        text: isZh ? '管理员已在上方策略中全局禁用 TOTP 2FA。' : 'TOTP 2FA is disabled in Security Policy above.',
      });
      return;
    }
    setTotpVerifyMsg(null);
    setTotpError(null);
    setTotpVerifiedCodes(null);
    setTotpBusy(true);
    try {
      const res = await fetch('/api/auth/totp/enroll', {
        method: 'POST',
        credentials: 'include',
        headers: buildAuthHeaders(),
      });
      const data = await res.json();
      if (!res.ok) {
        setTotpVerifyMsg({ ok: false, text: data.message || 'Failed to start TOTP enrollment.' });
        return;
      }
      setTotpEnroll({
        email: data.email || 'Admin Account',
        secret: data.secret,
        otpauthUri: data.otpauthUri,
        recoveryCodes: Array.isArray(data.recoveryCodes) ? data.recoveryCodes : [],
      });
    } finally {
      setTotpBusy(false);
    }
  }

  async function handleVerifyTotpCode(code: string) {
    setTotpBusy(true);
    setTotpError(null);
    try {
      const res = await fetch('/api/auth/totp/verify', {
        method: 'POST',
        credentials: 'include',
        headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setTotpError(data.message || (isZh ? '验证码无效，请核对手机验证器。' : 'Invalid 6-digit code.'));
        return;
      }
      setTotpVerifiedCodes(totpEnroll?.recoveryCodes || []);
      setTotpVerifyMsg({ ok: true, text: isZh ? 'TOTP 动态验证器已绑定生效。' : data.message || 'TOTP 2FA enabled.' });
    } finally {
      setTotpBusy(false);
    }
  }

  async function handleSimulateBruteForce() {
    const res = await fetch('/api/security/risk/test-bruteforce', {
      method: 'POST',
      credentials: 'include',
      headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
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

      {/* Interactive TOTP 2FA Enrollment (Modal QR Flow) */}
      <section className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <QrCode className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                {isZh
                  ? 'TOTP 动态口令 (2FA) 扫码绑定'
                  : 'TOTP 2FA (RFC 6238) Authenticator Enrollment'}
              </h2>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {!draft.enableTotp2fa
                ? isZh
                  ? 'TOTP 2FA 已在上方全局策略中关闭，用户无法新绑定或启用验证器。'
                  : 'TOTP 2FA is currently disabled in global policy; enrollment is locked.'
                : isZh
                  ? '点击右侧按钮弹出标准二维码，用 Google / Microsoft Authenticator 或 1Password 扫码并输入 6 位验证码即可完成绑定。'
                  : 'Click to open a scannable QR code modal for Google/Microsoft Authenticator or 1Password, then confirm with the 6-digit code.'}
            </p>
          </div>
          <button
            type="button"
            disabled={!draft.enableTotp2fa || totpBusy}
            onClick={() => void handleStartTotpEnroll()}
            className="min-h-[38px] px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-45 disabled:cursor-not-allowed text-white text-xs font-medium flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
          >
            <Lock className="w-3.5 h-3.5" />
            <span>{isZh ? '扫码添加 TOTP 验证器' : 'Add Authenticator App (QR)'}</span>
          </button>
        </div>

        {totpVerifyMsg && (
          <div
            className={`flex items-center gap-2 text-xs rounded-lg px-3.5 py-2.5 border ${
              totpVerifyMsg.ok
                ? 'text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900/50'
                : 'text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900/50'
            }`}
          >
            {totpVerifyMsg.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
            <span>{totpVerifyMsg.text}</span>
          </div>
        )}
      </section>

      {/* Admin API Tokens ($WIMOTEK_ADMIN_TOKEN) & MCP Server */}
      <AdminApiTokensSection
        locale={locale}
        sessionToken={sessionToken}
        issuerUrl={issuerUrl}
      />

      <TotpEnrollModal
        open={Boolean(totpEnroll)}
        locale={locale}
        draft={totpEnroll}
        busy={totpBusy}
        error={totpError}
        verifiedRecoveryCodes={totpVerifiedCodes}
        onClose={() => {
          setTotpEnroll(null);
          setTotpError(null);
          setTotpVerifiedCodes(null);
        }}
        onVerify={handleVerifyTotpCode}
      />
    </div>
  );
}
