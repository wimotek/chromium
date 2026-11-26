import React, { useEffect } from 'react';
import { AlertCircle, CheckCircle2, X } from 'lucide-react';

interface FloatingToastProps {
  error?: string;
  notice?: string;
  onDismissError?: () => void;
  onDismissNotice?: () => void;
  noticeDurationMs?: number;
  errorDurationMs?: number;
}

export const FloatingToast: React.FC<FloatingToastProps> = ({
  error,
  notice,
  onDismissError,
  onDismissNotice,
  noticeDurationMs = 5000,
  errorDurationMs = 8000,
}) => {
  useEffect(() => {
    if (!notice || !onDismissNotice || noticeDurationMs <= 0) return;
    const timer = window.setTimeout(onDismissNotice, noticeDurationMs);
    return () => window.clearTimeout(timer);
  }, [notice, onDismissNotice, noticeDurationMs]);

  useEffect(() => {
    if (!error || !onDismissError || errorDurationMs <= 0) return;
    const timer = window.setTimeout(onDismissError, errorDurationMs);
    return () => window.clearTimeout(timer);
  }, [error, onDismissError, errorDurationMs]);

  if (!error && !notice) return null;

  return (
    <div
      className="fixed top-20 end-6 z-[60] flex max-w-md flex-col gap-2 pointer-events-none"
      aria-live="polite"
      aria-atomic="true"
    >
      {error && (
        <div
          role="alert"
          className="pointer-events-auto flex items-start gap-2.5 rounded-xl border border-rose-200 bg-white/95 px-4 py-3 text-sm text-rose-800 shadow-lg ring-1 ring-rose-500/10 backdrop-blur"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
          <div className="min-w-0 flex-1 break-words leading-snug">{error}</div>
          {onDismissError && (
            <button
              type="button"
              onClick={onDismissError}
              aria-label="Dismiss error"
              className="shrink-0 rounded-md p-0.5 text-rose-500 transition-colors hover:bg-rose-50 hover:text-rose-700"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      )}
      {notice && (
        <div
          role="status"
          className="pointer-events-auto flex items-start gap-2.5 rounded-xl border border-emerald-200 bg-white/95 px-4 py-3 text-sm text-emerald-900 shadow-lg ring-1 ring-emerald-500/10 backdrop-blur"
        >
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
          <div className="min-w-0 flex-1 break-words leading-snug">{notice}</div>
          {onDismissNotice && (
            <button
              type="button"
              onClick={onDismissNotice}
              aria-label="Dismiss message"
              className="shrink-0 rounded-md p-0.5 text-emerald-600 transition-colors hover:bg-emerald-50 hover:text-emerald-800"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      )}
    </div>
  );
};
