export type ToastKind = 'success' | 'error' | 'info' | 'warning';

export interface ToastItem {
  id: string;
  kind: ToastKind;
  message: string;
  durationMs: number;
}

type Listener = (items: ToastItem[]) => void;

const listeners = new Set<Listener>();
let items: ToastItem[] = [];
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function emit() {
  const snapshot = [...items];
  for (const fn of listeners) {
    fn(snapshot);
  }
}

function dismiss(id: string) {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  const next = items.filter((item) => item.id !== id);
  if (next.length !== items.length) {
    items = next;
    emit();
  }
}

function show(message: string, kind: ToastKind = 'info', durationMs?: number): string {
  const text = String(message ?? '').trim();
  if (!text) return '';

  const effectiveDuration =
    durationMs ?? (kind === 'error' ? 6500 : kind === 'warning' ? 5200 : 4200);

  // Deduplicate identical active toast by refreshing its timer
  const existing = items.find((i) => i.message === text && i.kind === kind);
  if (existing) {
    const oldTimer = timers.get(existing.id);
    if (oldTimer) clearTimeout(oldTimer);
    timers.set(
      existing.id,
      setTimeout(() => dismiss(existing.id), effectiveDuration)
    );
    return existing.id;
  }

  const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  items = [...items, { id, kind, message: text, durationMs: effectiveDuration }];

  // Keep at most 4 stacked floating toasts so screen stays clean
  while (items.length > 4) {
    const oldest = items.shift();
    if (oldest) {
      const oldTimer = timers.get(oldest.id);
      if (oldTimer) {
        clearTimeout(oldTimer);
        timers.delete(oldest.id);
      }
    }
  }

  timers.set(
    id,
    setTimeout(() => dismiss(id), effectiveDuration)
  );
  emit();
  return id;
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  listener([...items]);
  return () => {
    listeners.delete(listener);
  };
}

export const toast = {
  show,
  dismiss,
  success: (message: string, durationMs?: number) => show(message, 'success', durationMs),
  error: (message: string, durationMs?: number) => show(message, 'error', durationMs),
  info: (message: string, durationMs?: number) => show(message, 'info', durationMs),
  warning: (message: string, durationMs?: number) => show(message, 'warning', durationMs),
};
