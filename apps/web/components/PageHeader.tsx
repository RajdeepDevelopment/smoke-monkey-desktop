import type { ReactNode } from 'react';
import { motion } from 'framer-motion';

interface PageHeaderProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  actions?: ReactNode;
}

/** Consistent page hero: title, optional description, and slot for actions. */
export function PageHeader({ title, description, icon, actions }: PageHeaderProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="flex flex-wrap items-end justify-between gap-4"
    >
      <div className="flex min-w-0 items-center gap-3.5">
        {icon && (
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary-subtle text-primary">
            {icon}
          </div>
        )}
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-ink-primary sm:text-[26px]">
            {title}
          </h1>
          {description && (
            <p className="mt-1 text-sm leading-relaxed text-ink-secondary">{description}</p>
          )}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </motion.div>
  );
}
