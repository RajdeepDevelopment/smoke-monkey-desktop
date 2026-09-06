'use client';

import { memo } from 'react';
import { FolderOpen } from 'lucide-react';
import { cn } from '../../lib/utils';

interface TopBarProps {
  workspacePath?: string;
  breadcrumbs?: { name: string; path: string }[];
  onSwitchWorkspace?: () => void;
  children?: React.ReactNode;
}

export const TopBar = memo(function TopBar({ workspacePath, breadcrumbs, onSwitchWorkspace, children }: TopBarProps) {
  return (
    <div className="flex items-center justify-between glass-border-bottom px-3 py-0.5 shrink-0 h-9">
      <div className="flex items-center gap-2 min-w-0">
        <button
          type="button"
          onClick={onSwitchWorkspace}
          disabled={!onSwitchWorkspace}
          title={workspacePath || 'No workspace — click to choose a folder'}
          className={cn(
            'group flex items-center gap-1.5 rounded px-1.5 py-0.5 text-left transition-colors',
            onSwitchWorkspace ? 'hover:bg-surface-800 cursor-pointer' : 'cursor-default',
          )}
        >
          <FolderOpen
            className={cn('h-3 w-3 shrink-0', onSwitchWorkspace ? 'text-ink-muted group-hover:text-ink-primary' : 'text-ink-muted/50')}
          />
          <span className="text-[11px] font-medium text-foreground/80 truncate max-w-[80vw] sm:max-w-[40vw]">
            {workspacePath ? workspacePath.split('/').pop() : 'No workspace'}
          </span>
        </button>
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
