'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { motion, useInView, useReducedMotion } from 'framer-motion';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { cn } from '../lib/utils';

interface MetricCardProps {
  label: string;
  value: string;
  hint?: string;
  icon?: ReactNode;
  accent?: 'primary' | 'accent' | 'success' | 'warning';
  trend?: number | null;
  loading?: boolean;
}

const ACCENT_TEXT: Record<NonNullable<MetricCardProps['accent']>, string> = {
  primary: 'text-primary',
  accent: 'text-accent',
  success: 'text-success',
  warning: 'text-warning',
};

const ACCENT_BG: Record<NonNullable<MetricCardProps['accent']>, string> = {
  primary: 'bg-primary/12 text-primary',
  accent: 'bg-accent/12 text-accent',
  success: 'bg-success/12 text-success',
  warning: 'bg-warning/12 text-warning',
};

/**
 * Premium dashboard metric card with an animated count-up for numeric values,
 * subtle hover elevation and an optional trend indicator.
 */
export function MetricCard({
  label,
  value,
  hint,
  icon,
  accent = 'primary',
  trend,
  loading,
}: MetricCardProps) {
  const [display, setDisplay] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: '-40px' });
  const reduced = useReducedMotion();

  const parsed = parseFloat(value.replace(/[^0-9.\-]/g, ''));
  const isNumeric = !Number.isNaN(parsed) && /[0-9]/.test(value);
  const suffix = isNumeric ? value.replace(/[0-9.,\-]/g, '') : '';

  useEffect(() => {
    if (!inView || !isNumeric || reduced) return;
    let raf = 0;
    const duration = 700;
    const start = performance.now();
    const from = 0;
    const to = parsed;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(from + (to - from) * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inView, isNumeric, parsed, reduced]);

  const formatted = isNumeric
    ? `${display.toLocaleString('en-US', { maximumFractionDigits: 2 })}${suffix}`
    : value;

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 10 }}
      animate={inView ? { opacity: 1, y: 0 } : undefined}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className={cn(
        'card group relative overflow-hidden p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/20 sm:p-5',
      )}
    >
      <div
        className="pointer-events-none absolute -right-8 -top-8 h-28 w-28 rounded-full opacity-0 blur-2xl transition-opacity duration-300 group-hover:opacity-100"
        style={{ background: `hsl(var(--${accent}) / 0.12)` }}
      />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{label}</p>
          {loading ? (
            <div className="mt-2 h-8 w-24 animate-pulse rounded-md bg-surface-700/60" />
          ) : (
            <p className={cn('mt-1.5 truncate text-2xl font-semibold tracking-tight sm:text-[28px]', ACCENT_TEXT[accent])}>
              {formatted}
            </p>
          )}
          {hint && !loading && <p className="mt-1 truncate text-xs text-ink-muted">{hint}</p>}
        </div>
        {icon && !loading && (
          <div
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/5',
              ACCENT_BG[accent],
            )}
          >
            {icon}
          </div>
        )}
      </div>
      {trend != null && !loading && (
        <div className="mt-3 flex items-center gap-1.5">
          {trend > 0 ? (
            <TrendingUp className="h-3.5 w-3.5 text-success" />
          ) : trend < 0 ? (
            <TrendingDown className="h-3.5 w-3.5 text-error" />
          ) : (
            <Minus className="h-3.5 w-3.5 text-ink-muted" />
          )}
          <span
            className={cn(
              'text-xs font-medium tabular-nums',
              trend > 0 ? 'text-success' : trend < 0 ? 'text-error' : 'text-ink-muted',
            )}
          >
            {trend > 0 ? '+' : ''}
            {trend}%
          </span>
          <span className="text-xs text-ink-muted">this week</span>
        </div>
      )}
    </motion.div>
  );
}
