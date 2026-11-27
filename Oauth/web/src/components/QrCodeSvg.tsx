import React, { useMemo, useState } from 'react';
import { Check, CheckCircle2, ChevronDown, ChevronRight, Copy, ShieldCheck, Smartphone, X } from 'lucide-react';
import { buildQrSvgData } from '../lib/qrCodeSvg';
import type { Locale } from '../types';

export function QrCodeSvg({
  value,
  size = 204,
  label = 'TOTP QR Code',
}: {
  value: string;
  size?: number;
  label?: string;
}) {
  const qr = useMemo(() => {
    try {
      return buildQrSvgData(value, 4);
    } catch {
      return null;
    }
  }, [value]);

  if (!qr) {
    return (
      <div
        style={{ width: size, height: size }}
        className="flex items-center justify-center rounded-xl border border-red-200 bg-red-50 text-xs text-red-600 p-4 text-center"
      >
        QR payload too long
      </div>
    );
  }

  return (
    <div className="inline-flex items-center justify-center p-3 bg-white rounded-xl border border-slate-200 shadow-xs">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${qr.viewBoxSize} ${qr.viewBoxSize}`}
        role="img"
        aria-label={label}
        shapeRendering="crispEdges"
      >
        <rect width={qr.viewBoxSize} height={qr.viewBoxSize} fill="#ffffff" />
        <path d={qr.pathD} fill="#0f172a" />
      </svg>
    </div>
  );
}

export interface TotpEnrollDraft {
  email: string;
  secret: string;
  otpauthUri: string;
  recoveryCodes: string[];
}

interface TotpEnrollModalProps {
  open: boolean;
  locale: Locale;
  draft: TotpEnrollDraft | null;
  busy?: boolean;
  error?: string | null;
  verifiedRecoveryCodes?: string[] | null;
  onClose: () => void;
  onVerify: (code: string) => Promise<void>;
}

export function TotpEnrollModal({
  open,
  locale,
  draft,
  busy = false,
  error = null,
  verifiedRecoveryCodes = null,
  onClose,
  onVerify,
}: TotpEnrollModalProps) {
  const isZh = locale === 'zh-CN' || locale === 'zh-TW';
  const [code, setCode] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  if (!open || !draft) return null;

  async function copyText(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1500);
    } catch {
      // ignore clipboard errors
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const cleaned = code.replace(/\s+/g, '');
    if (cleaned.length < 6) return;
    await onVerify(cleaned);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label={isZh ? '绑定 TOTP 动态验证器' : 'Set up Authenticator App (TOTP 2FA)'}
    >
      <div className="w-full max-w-md bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Smartphone className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                {verifiedRecoveryCodes
                  ? isZh
                    ? 'TOTP 动态口令已成功绑定'
                    : 'Authenticator App Enabled'
                  : isZh
                    ? '绑定身份验证器 (TOTP 2FA)'
                    : 'Set Up Authenticator App (TOTP)'}
              </h3>
              <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate">
                {draft.email}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {verifiedRecoveryCodes ? (
          <div className="p-5 space-y-4">
            <div className="flex items-start gap-2.5 p-3.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/50 text-xs text-emerald-800 dark:text-emerald-300">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold">
                  {isZh ? '验证成功！两步验证已开启' : 'Verified! Two-factor authentication is active.'}
                </div>
                <p className="mt-0.5 opacity-90">
                  {isZh
                    ? '请妥善保存以下 8 个一次性备用恢复码，手机丢失时可用于应急登录。'
                    : 'Save these 8 one-time recovery codes in a safe place in case you lose your device.'}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 font-mono text-xs bg-slate-50 dark:bg-[#0B0F19] p-3.5 rounded-lg border border-slate-200 dark:border-slate-800">
              {verifiedRecoveryCodes.map((rc) => (
                <div key={rc} className="text-center py-1 text-slate-800 dark:text-slate-200 tabular-nums">
                  {rc}
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between gap-2 pt-1">
              <button
                type="button"
                onClick={() => void copyText('codes', verifiedRecoveryCodes.join('\n'))}
                className="px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                {copiedKey === 'codes' ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedKey === 'codes' ? (isZh ? '已复制恢复码' : 'Copied') : isZh ? '复制全部恢复码' : 'Copy All Codes'}</span>
              </button>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium whitespace-nowrap"
              >
                {isZh ? '完成' : 'Done'}
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-5 space-y-5">
            <div className="space-y-3 text-center">
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                {isZh
                  ? '1. 请打开 Google Authenticator、Microsoft Authenticator、1Password 或苹果「密码」扫描下方二维码：'
                  : '1. Scan this QR code using Google Authenticator, Microsoft Authenticator, 1Password, or Apple Passwords:'}
              </p>
              <div className="flex justify-center">
                <QrCodeSvg value={draft.otpauthUri} size={196} />
              </div>

              <div className="text-left">
                <button
                  type="button"
                  onClick={() => setShowManual((v) => !v)}
                  className="mx-auto flex items-center gap-1 text-[11px] font-medium text-slate-500 hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-400 transition-colors"
                >
                  {showManual ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  <span>{isZh ? '无法扫码？手动输入 Base32 密钥' : "Can't scan? Enter setup key manually"}</span>
                </button>
                {showManual && (
                  <div className="mt-2 p-2.5 rounded-lg bg-slate-50 dark:bg-[#0B0F19] border border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
                    <code className="font-mono text-[11px] text-slate-800 dark:text-slate-200 break-all">
                      {draft.secret}
                    </code>
                    <button
                      type="button"
                      onClick={() => void copyText('secret', draft.secret)}
                      className="p-1.5 rounded-md text-slate-400 hover:text-indigo-600 shrink-0"
                      title={isZh ? '复制密钥' : 'Copy secret'}
                    >
                      {copiedKey === 'secret' ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-2 pt-2 border-t border-slate-100 dark:border-slate-800">
              <label
                htmlFor="modal-totp-code"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                {isZh ? '2. 输入验证器 App 显示的 6 位动态数字完成确认' : '2. Enter the 6-digit code from your authenticator app'}
              </label>
              <input
                id="modal-totp-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                required
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
                placeholder="000000"
                className="w-full min-h-[44px] px-4 py-2 text-center font-mono text-xl tracking-[0.45em] rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
              />
            </div>

            {error && (
              <div className="text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="min-h-[38px] px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                {isZh ? '取消' : 'Cancel'}
              </button>
              <button
                type="submit"
                disabled={busy || code.length < 6}
                className="min-h-[38px] px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>{busy ? '...' : isZh ? '确认并完成绑定' : 'Verify & Enable'}</span>
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
