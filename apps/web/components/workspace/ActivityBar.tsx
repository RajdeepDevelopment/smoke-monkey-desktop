'use client';

import { memo } from 'react';
import {
  Files,
  Search,
  GitBranch,
  MessageSquare,
  Terminal as TerminalIcon,
  Settings,
  PanelLeft,
} from 'lucide-react';
import { useWorkspace, type ActivityPanel } from '../../hooks/useWorkspace';
import { cn } from '../../lib/utils';

interface ActivityBarProps {
  isAgentRunning?: boolean;
  gitChangeCount?: number;
  onToggleGlobalNav?: () => void;
}

const PANEL_ITEMS: { panel: ActivityPanel; icon: typeof Files; label: string; key: string }[] = [
  { panel: 'explorer', icon: Files, label: 'Explorer', key: 'explorer' },
  { panel: 'search', icon: Search, label: 'Search', key: 'search' },
  { panel: 'scm', icon: GitBranch, label: 'Source Control', key: 'scm' },
  { panel: 'agent', icon: MessageSquare, label: 'Agent', key: 'agent' },
  { panel: 'terminal', icon: TerminalIcon, label: 'Terminal', key: 'terminal' },
];

export const ActivityBar = memo(function ActivityBar({ isAgentRunning, gitChangeCount, onToggleGlobalNav }: ActivityBarProps) {
  const { state, setActivePanel } = useWorkspace();

  return (
    <div className="glass-panel w-12 shrink-0 flex flex-col items-center border-r">
      {/* Main panels */}
      <div className="w-full flex-1 flex flex-col items-center gap-px py-1.5">
        {PANEL_ITEMS.map(({ panel, icon: Icon, label }) => {
          const isActive = state.activePanel === panel && state.sidePanelOpen;
          const showBadge = panel === 'scm' && (gitChangeCount ?? 0) > 0;
          return (
            <button
              key={panel}
              onClick={() => setActivePanel(panel)}
              className={cn(
                'relative flex h-10 w-12 items-center justify-center transition-colors',
                isActive ? 'text-foreground' : 'text-ink-muted hover:text-foreground',
              )}
              title={label}
              aria-label={label}
            >
              {/* Active indicator — VS Code style left bar */}
              <span
                className={cn(
                  'absolute left-0 top-0 h-full w-[2px] bg-primary transition-opacity',
                  isActive ? 'opacity-100' : 'opacity-0',
                )}
              />
              <span
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-md transition-colors',
                  isActive ? 'bg-primary-subtle' : 'hover:bg-white/[0.05]',
                )}
              >
                <Icon className="h-[18px] w-[18px]" strokeWidth={isActive ? 2.2 : 1.8} />
                {panel === 'agent' && isAgentRunning && (
                  <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
                )}
              </span>
              {showBadge && (
                <span className="absolute bottom-1 right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[8px] font-bold text-primary-foreground">
                  {gitChangeCount! > 99 ? '99+' : gitChangeCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Global nav + Settings */}
      <div className="w-full flex flex-col items-center border-t glass-border py-1.5">
        {onToggleGlobalNav && (
          <button
            onClick={onToggleGlobalNav}
            title="App sections (toggle)"
            aria-label="Open app navigation"
            className="flex h-9 w-12 items-center justify-center text-ink-muted transition-colors hover:text-foreground"
          >
            <PanelLeft className="h-[18px] w-[18px]" strokeWidth={1.8} />
          </button>
        )}
        <button
          onClick={() => setActivePanel('settings')}
          title="Settings"
          aria-label="Settings"
          className={cn(
            'flex h-9 w-12 items-center justify-center transition-colors',
            state.activePanel === 'settings' && state.sidePanelOpen
              ? 'text-foreground'
              : 'text-ink-muted hover:text-foreground',
          )}
        >
          <Settings
            className={cn(
              'h-[18px] w-[18px]',
              state.activePanel === 'settings' && state.sidePanelOpen && 'text-primary-hover',
            )}
            strokeWidth={1.8}
          />
        </button>
      </div>
    </div>
  );
});
