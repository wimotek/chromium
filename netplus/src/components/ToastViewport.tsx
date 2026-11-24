import React, { useEffect, useState } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { subscribeToasts, toast, type ToastItem } from '../lib/toast';

export function ToastViewport() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => subscribeToasts(setItems), []);

  if (items.length === 0) return null;

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="fixed top-16 right-4 z-[90] pointer-events-none flex flex-col gap-2 w-[min(420px,calc(100vw-2rem))]"
    >
      {items.map((item) => {
        const isError = item.kind === 'error';
        const isSuccess = item.kind === 'success';
        const isWarning = item.kind === 'warning';

        const containerStyle = isError
          ? 'border-red-200 dark:border-red-900/80 bg-white dark:bg-slate-900 text-red-700 dark:text-red-300'
          : isSuccess
            ? 'border-emerald-200 dark:border-emerald-900/80 bg-white dark:bg-slate-900 text-emerald-700 dark:text-emerald-300'
            : isWarning
              ? 'border-amber-200 dark:border-amber-900/80 bg-white dark:bg-slate-900 text-amber-800 dark:text-amber-300'
              : 'border-blue-200 dark:border-blue-900/80 bg-white dark:bg-slate-900 text-blue-700 dark:text-blue-300';

        const Icon = isError
          ? AlertCircle
          : isSuccess
            ? CheckCircle2
            : isWarning
              ? AlertTriangle
              : Info;

        return (
          <div
            key={item.id}
            role={isError ? 'alert' : 'status'}
            className={`pointer-events-auto flex items-start gap-2.5 px-3.5 py-2.5 rounded-xl border shadow-lg shadow-slate-950/10 dark:shadow-slate-950/40 text-xs leading-relaxed ${containerStyle}`}
          >
            <Icon className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            <div className="flex-1 min-w-0 break-words font-medium">{item.message}</div>
            <button
              type="button"
              onClick={() => toast.dismiss(item.id)}
              aria-label="Dismiss notification"
              className="p-0.5 -mr-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
