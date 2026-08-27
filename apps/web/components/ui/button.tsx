import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground shadow-sm shadow-primary/20 hover:bg-primary-hover hover:shadow-md hover:shadow-primary/25',
        secondary:
          'border border-border bg-surface-850 text-ink-secondary shadow-soft-panel hover:bg-surface-800 hover:text-ink-primary',
        ghost: 'text-ink-secondary hover:bg-surface-800 hover:text-ink-primary',
        outline:
          'border border-border bg-transparent text-ink-secondary hover:bg-surface-800 hover:text-ink-primary',
        destructive:
          'border border-destructive/40 bg-destructive/10 text-red-300 hover:bg-destructive/20 hover:text-red-200',
        link: 'text-accent underline-offset-4 hover:underline',
        glow: 'bg-primary text-primary-foreground shadow-glow hover:bg-primary-hover',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-11 rounded-lg px-6 text-[15px]',
        icon: 'h-9 w-9',
        'icon-sm': 'h-8 w-8 rounded-md',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
