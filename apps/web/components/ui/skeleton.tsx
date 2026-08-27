import { cn } from '../../lib/utils';

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'animate-pulse rounded-md bg-gradient-to-r from-surface-800 via-surface-700 to-surface-800 bg-[length:400px_100%]',
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
