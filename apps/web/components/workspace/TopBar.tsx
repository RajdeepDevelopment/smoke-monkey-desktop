'use client';

import { memo } from 'react';
import { useWorkspace } from '../../hooks/useWorkspace';
import { cn } from '../../lib/utils';

interface TopBarProps {
  workspacePath?: string;
  breadcrumbs?: { name: string; path: string }[];
  children?: React.ReactNode;
}

export const TopBar = memo(function TopBar({ workspacePath, breadcrumbs, children }: TopBarProps) {
  return (
    <div className="flex items-center justify-between glass-border-bottom px-3 py-0.5 shrink-0 h-9">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-[11px] font-medium text-foreground/80 truncate">
          {workspacePath ? workspacePath.split('/').pop() : 'No workspace'}
        </span>
        {breadcrumbs && breadcrumbs.length > 0 && (
          <div className="flex items-center gap-0.5 text-[10px] text-ink-muted">
            {breadcrumbs.map((bc, i) => (
              <span key={i} className="flex items-center gap-0.5">
                {i > 0 && <span className="text-ink-muted/30">/</span>}
                <span>{bc.name}</span>
              </span>
            ))}
          </div>
        )}
      </div>
      {children && (
        <div className="flex items-center gap-1.5">
          {children}
        </div>
      )}
    </div>
  );
});
