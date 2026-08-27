import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring/60',
  {
    variants: {
      variant: {
        default: 'border border-primary/30 bg-primary-subtle text-primary-hover',
        secondary: 'border border-border bg-surface-800 text-ink-secondary',
        outline: 'border border-border bg-transparent text-ink-secondary',
        success: 'border border-success/30 bg-success-subtle text-emerald-300',
        warning: 'border border-warning/30 bg-warning-subtle text-amber-300',
        destructive: 'border border-destructive/30 bg-error-subtle text-red-300',
        accent: 'border border-accent/30 bg-accent/10 text-cyan-300',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
