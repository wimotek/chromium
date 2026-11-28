import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { Locale } from '../types';

export interface CollapsibleCodeBlockProps {
  locale: Locale;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  code: string;
  language?: string;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  headerBanner?: React.ReactNode;
  variant?: 'card' | 'inline';
  tone?: 'auto' | 'dark';
  wrap?: boolean;
  maxHeightClass?: string;
  defaultOpen?: boolean;
  resetKey?: string;
  lineCountOverride?: number;
  className?: string;
}

export function CollapsibleCodeBlock({
  locale,
  title,
  subtitle,
  code,
  language,
  icon,
  actions,
  headerBanner,
  variant = 'inline',
  tone = 'auto',
  wrap = false,
  maxHeightClass = '',
  defaultOpen = false,
  resetKey,
  lineCountOverride,
  className = '',
}: CollapsibleCodeBlockProps) {
  const isZh = locale === 'zh-CN' || locale === 'zh-TW';
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    if (resetKey !== undefined) {
      setOpen(defaultOpen);
    }
  }, [resetKey, defaultOpen]);

  const lineCount = useMemo(() => {
    if (typeof lineCountOverride === 'number') return lineCountOverride;
    const trimmed = code.trimEnd();
    if (!trimmed) return 0;
    return trimmed.split(/\r?\n/).length;
  }, [code, lineCountOverride]);

  const statusText = open
    ? isZh
      ? '收起'
      : 'Collapse'
    : isZh
      ? '点击展开'
      : 'Expand';

  const countText = isZh ? `${lineCount} 行` : `${lineCount} lines`;

  const preColorClass =
    tone === 'dark'
      ? 'bg-slate-950 text-slate-100'
      : 'bg-slate-50/70 dark:bg-[#0B0F19] text-slate-800 dark:text-slate-200';

  if (variant === 'card') {
    return (
      <section
        className={`bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden ${className}`}
      >
        <div
          className={`flex items-center justify-between gap-2 pr-3.5 bg-slate-50/80 dark:bg-[#0D1321] hover:bg-slate-100/70 dark:hover:bg-slate-800/40 transition-colors ${
            open ? 'border-b border-slate-200 dark:border-slate-800' : ''
          }`}
        >
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((prev) => !prev)}
            className="flex-1 px-4 py-3 text-left flex items-center gap-2.5 min-w-0 cursor-pointer"
          >
            {open ? (
              <ChevronDown className="w-4 h-4 shrink-0 text-indigo-600 dark:text-indigo-400" />
            ) : (
              <ChevronRight className="w-4 h-4 shrink-0 text-slate-500 dark:text-slate-400" />
            )}
            {icon && <span className="shrink-0 flex items-center">{icon}</span>}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs sm:text-sm font-semibold text-slate-900 dark:text-white">
                  {title}
                </span>
                <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                  {language ? `${language} · ${countText}` : countText}
                </span>
                <span className="text-[11px] font-medium text-indigo-600 dark:text-indigo-400">
                  {statusText}
                </span>
              </div>
              {subtitle && (
                <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                  {subtitle}
                </div>
              )}
            </div>
          </button>
          {actions && <div className="flex items-center gap-1.5 shrink-0">{actions}</div>}
        </div>

        {open && (
          <>
            {headerBanner && (
              <div className="px-5 py-2.5 border-b border-slate-100 dark:border-slate-800/80 bg-indigo-50/40 dark:bg-indigo-950/20 text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                {headerBanner}
              </div>
            )}
            <pre
              className={`p-4 sm:p-5 text-xs font-mono overflow-x-auto leading-relaxed ${preColorClass} ${
                wrap ? 'whitespace-pre-wrap break-words' : ''
              } ${maxHeightClass}`}
            >
              {code}
            </pre>
          </>
        )}
      </section>
    );
  }

  return (
    <div
      className={`border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden ${className}`}
    >
      <div
        className={`flex items-center justify-between gap-2 pr-2.5 bg-slate-50/90 dark:bg-[#0D1321] hover:bg-slate-100/80 dark:hover:bg-slate-800/40 transition-colors ${
          open ? 'border-b border-slate-200 dark:border-slate-800' : ''
        }`}
      >
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
          className="flex-1 px-3 py-2 text-left flex items-center gap-2 min-w-0 cursor-pointer"
        >
          {open ? (
            <ChevronDown className="w-3.5 h-3.5 shrink-0 text-indigo-600 dark:text-indigo-400" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 shrink-0 text-slate-500 dark:text-slate-400" />
          )}
          {icon && <span className="shrink-0 flex items-center">{icon}</span>}
          <span className="text-[11px] font-medium text-slate-800 dark:text-slate-200 truncate">
            {title}
          </span>
          <span className="text-[10.5px] font-mono text-slate-500 dark:text-slate-400 shrink-0">
            {language ? `${language} · ${countText}` : countText}
          </span>
          <span className="text-[10.5px] font-medium text-indigo-600 dark:text-indigo-400 shrink-0">
            {statusText}
          </span>
        </button>
        {actions && <div className="flex items-center gap-1.5 shrink-0">{actions}</div>}
      </div>

      {open && (
        <pre
          className={`p-3 font-mono text-[11px] overflow-x-auto leading-relaxed ${preColorClass} ${
            wrap ? 'whitespace-pre-wrap break-words' : ''
          } ${maxHeightClass}`}
        >
          {code}
        </pre>
      )}
    </div>
  );
}
