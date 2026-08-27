'use client';

import type { ReactNode } from 'react';

interface AddonShellProps {
  type: 'mermaid' | 'visuals' | 'files' | 'streaming';
  label: string;
  children: ReactNode;
}

const BADGE: Record<AddonShellProps['type'], string> = {
  mermaid: 'bg-primary/20 text-primary',
  visuals: 'bg-accent/20 text-accent',
  files: 'bg-emerald-500/20 text-emerald-400',
  streaming: 'bg-surface-700 text-ink-muted',
};

const BADGE_LABEL: Record<AddonShellProps['type'], string> = {
  mermaid: 'Diagram',
  visuals: 'Visual',
  files: 'Project',
  streaming: 'Building…',
};

/** Uniform frame + type badge around every extracted add-on widget. */
export function AddonShell({ type, label, children }: AddonShellProps) {
  return (
    <div className="addon-shell relative my-3 overflow-hidden rounded-lg border border-surface-600 bg-surface-900">
      <div className="flex items-center gap-2 border-b border-surface-700/70 px-3 py-1.5">
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${BADGE[type]}`}
        >
          {type === 'streaming' ? (
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-muted" />
          ) : null}
          {BADGE_LABEL[type]}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">{label}</span>
      </div>
      {children}
    </div>
  );
}
