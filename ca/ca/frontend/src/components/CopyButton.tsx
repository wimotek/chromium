import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';

export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fallback for sandboxed iframes / HTTP contexts
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

interface CopyButtonProps {
  value: string;
  label?: string;
  copiedLabel?: string;
  compact?: boolean;
  dark?: boolean;
  className?: string;
  ariaLabel?: string;
}

export const CopyButton: React.FC<CopyButtonProps> = ({
  value,
  label,
  copiedLabel = 'Copied',
  compact = false,
  dark = false,
  className = '',
  ariaLabel,
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await copyToClipboard(value);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  };

  if (compact) {
    return (
      <button
        type="button"
        onClick={handleCopy}
        title={copied ? copiedLabel : ariaLabel || label || 'Copy'}
        aria-label={copied ? copiedLabel : ariaLabel || label || 'Copy'}
        className={`inline-flex items-center justify-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors cursor-pointer shrink-0 ${
          dark
            ? copied
              ? 'bg-emerald-500/20 text-emerald-300'
              : 'text-slate-300 hover:bg-slate-800 hover:text-white'
            : copied
            ? 'bg-emerald-50 text-emerald-700'
            : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
        } ${className}`}
      >
        {copied ? (
          <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <Copy className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        )}
        {label && <span>{copied ? copiedLabel : label}</span>}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={ariaLabel || label || 'Copy'}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
        dark
          ? copied
            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
            : 'bg-slate-800 text-slate-200 hover:bg-slate-700 border border-slate-700'
          : copied
          ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
          : 'bg-white text-slate-700 hover:bg-slate-50 border border-slate-200'
      } ${className}`}
    >
      {copied ? (
        <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <Copy className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      )}
      <span>{copied ? copiedLabel : label || 'Copy'}</span>
    </button>
  );
};

interface CodeBlockProps {
  code: string;
  title?: string;
  copyLabel?: string;
  copiedLabel?: string;
  maxHeightClass?: string;
}

export const CodeBlock: React.FC<CodeBlockProps> = ({
  code,
  title,
  copyLabel = 'Copy',
  copiedLabel = 'Copied',
  maxHeightClass = 'max-h-72',
}) => {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950 overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3.5 py-2 border-b border-slate-800 bg-slate-900/70">
        <span className="text-[11px] font-mono text-slate-400 truncate">{title || 'Command'}</span>
        <CopyButton value={code} label={copyLabel} copiedLabel={copiedLabel} compact dark />
      </div>
      <pre
        dir="ltr"
        className={`p-3.5 text-[11px] font-mono text-slate-200 overflow-x-auto leading-relaxed ${maxHeightClass}`}
      >
        {code}
      </pre>
    </div>
  );
};
