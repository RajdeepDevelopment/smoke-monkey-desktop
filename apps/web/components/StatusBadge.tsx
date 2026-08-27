import { cn } from '../lib/utils';

type StatusTone = 'success' | 'warning' | 'error' | 'info' | 'neutral' | 'primary';

const TONES: Record<StatusTone, string> = {
  success: 'border-success/25 bg-success-subtle text-emerald-300 [&>i]:bg-success',
  warning: 'border-warning/25 bg-warning-subtle text-amber-300 [&>i]:bg-warning',
  error: 'border-destructive/25 bg-error-subtle text-red-300 [&>i]:bg-destructive',
  info: 'border-accent/25 bg-accent-subtle text-cyan-300 [&>i]:bg-accent',
  neutral: 'border-surface-600 bg-surface-800/70 text-ink-secondary [&>i]:bg-ink-muted',
  primary: 'border-primary/25 bg-primary-subtle text-primary-hover [&>i]:bg-primary',
};

interface StatusBadgeProps {
  label: string;
  tone?: StatusTone;
  pulse?: boolean;
  className?: string;
}

/** Small status pill with a dot indicator. Never relies on color alone. */
export function StatusBadge({ label, tone = 'neutral', pulse, className }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        TONES[tone],
        className,
      )}
    >
      <i
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          pulse && 'animate-pulse-soft',
        )}
        aria-hidden
      />
      {label}
    </span>
  );
}
