'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, AlertTriangle, Info, X, Loader2 } from 'lucide-react';
import { cn } from '../lib/utils';

type ToastKind = 'success' | 'error' | 'info' | 'loading';

interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
  duration: number;
}

interface ToastApi {
  success: (title: string, description?: string, duration?: number) => void;
  error: (title: string, description?: string, duration?: number) => void;
  info: (title: string, description?: string, duration?: number) => void;
  loading: (title: string, description?: string) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>');
  return ctx;
}

const KIND_STYLES: Record<ToastKind, { icon: React.ReactNode; ring: string }> = {
  success: {
    icon: <CheckCircle2 className="h-4 w-4 text-success" />,
    ring: 'border-success/30',
  },
  error: {
    icon: <AlertTriangle className="h-4 w-4 text-error" />,
    ring: 'border-destructive/30',
  },
  info: {
    icon: <Info className="h-4 w-4 text-accent" />,
    ring: 'border-accent/30',
  },
  loading: {
    icon: <Loader2 className="h-4 w-4 animate-spin text-primary" />,
    ring: 'border-primary/30',
  },
};

let toastSeq = 0;

/**
 * Minimal, dependency-light toast system built on React context + Framer
 * Motion. Success/error/info toasts auto-dismiss; the `loading` variant
 * sticks until dismissed, so long operations can resolve into a success or
 * error toast via `dismiss`.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (kind: ToastKind, title: string, description?: string, duration = 3200) => {
      const id = ++toastSeq;
      setToasts((prev) => [...prev.slice(-3), { id, kind, title, description, duration }]);
      if (kind !== 'loading' && duration > 0) {
        const timer = setTimeout(() => dismiss(id), duration);
        timers.current.set(id, timer);
      }
      return id;
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (title, description, duration) => void push('success', title, description, duration),
      error: (title, description, duration) => void push('error', title, description, duration),
      info: (title, description, duration) => void push('info', title, description, duration),
      loading: (title, description) => void push('loading', title, description, 0),
      dismiss,
    }),
    [push, dismiss],
  );

  // Cleanup all timers on unmount.
  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((t) => clearTimeout(t));
      map.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[90] flex flex-col items-center gap-2 px-4 sm:items-end sm:right-4 sm:left-auto sm:px-0">
        <AnimatePresence>
          {toasts.map((toast) => {
            const style = KIND_STYLES[toast.kind];
            return (
              <motion.div
                key={toast.id}
                layout
                initial={{ opacity: 0, y: 12, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.97 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                className={cn(
                  'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border bg-surface-900/95 px-4 py-3 shadow-card-lift backdrop-blur',
                  style.ring,
                )}
                role="status"
                aria-live="polite"
              >
                <span className="mt-0.5 shrink-0">{style.icon}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink-primary">{toast.title}</p>
                  {toast.description && (
                    <p className="mt-0.5 text-xs leading-relaxed text-ink-secondary">
                      {toast.description}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => dismiss(toast.id)}
                  className="shrink-0 rounded-md p-1 text-ink-muted transition-colors hover:bg-surface-800 hover:text-ink-primary"
                  aria-label="Dismiss notification"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
