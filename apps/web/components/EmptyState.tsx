import type { ReactNode } from 'react';
import { motion } from 'framer-motion';

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
  compact?: boolean;
}

/** Intentional, polished empty state used across every screen. */
export function EmptyState({ icon, title, description, action, compact }: EmptyStateProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className="flex flex-col items-center justify-center rounded-card border border-dashed border-surface-700 bg-surface-900/40 px-6 py-12 text-center"
    >
      {icon && (
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-surface-700 bg-surface-850 text-ink-secondary shadow-soft-panel">
          {icon}
        </div>
      )}
      <h3 className={`font-semibold text-ink-primary ${compact ? 'text-sm' : 'text-base'}`}>
        {title}
      </h3>
      <p className={`mt-1.5 max-w-sm text-sm leading-relaxed text-ink-muted ${compact ? 'text-xs' : ''}`}>
        {description}
      </p>
      {action && <div className="mt-5">{action}</div>}
    </motion.div>
  );
}
