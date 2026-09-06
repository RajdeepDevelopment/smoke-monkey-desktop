'use client';

import { cn } from '../../lib/utils';

interface StepperProps {
  current: number;
  total: number;
  labels?: string[];
  className?: string;
}

/** A minimal, animated progress stepper used by the onboarding wizard. */
export function Stepper({ current, total, labels, className }: StepperProps) {
  const pct = ((current + 1) / total) * 100;

  return (
    <div className={cn('w-full', className)}>
      <div className="h-1 w-full overflow-hidden rounded-full bg-surface-700">
        <div
          className="h-full rounded-full bg-gradient-to-r from-primary via-accent to-accent transition-all duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      {labels && labels.length > 0 && (
        <div className="mt-2 flex justify-between">
          {labels.slice(0, total).map((label, i) => (
            <span
              key={i}
              className={cn(
                'text-[10px] font-medium uppercase tracking-wide transition-colors duration-300',
                i === current ? 'text-primary' : i < current ? 'text-success' : 'text-ink-muted',
              )}
            >
              {label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
