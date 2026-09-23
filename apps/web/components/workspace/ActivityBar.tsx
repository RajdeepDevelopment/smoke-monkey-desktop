'use client';

import { memo } from 'react';
import {
  Files,
  Search,
  GitBranch,
  MessageSquare,
  Terminal as TerminalIcon,
  Server,
} from 'lucide-react';
import { useWorkspace, type ActivityPanel } from '../../hooks/useWorkspace';
import type { RemoteConnectionState } from './StatusBar';
import { RailRoot, RailBrand, RailButton, RailSections, RailDivider, RailLogout } from '../rail';

interface ActivityBarProps {
  isAgentRunning?: boolean;
  gitChangeCount?: number;
  /** Simple mode: terminal panel is hidden (dev-only chrome). */
  simple?: boolean;
  /** Connection state for the Local/SSH indicator under the SSH rail icon. */
  remote?: RemoteConnectionState;
  /** Opens the SSH side panel (connection management lives there). */
  onOpenSsh?: () => void;
}

const PANEL_ITEMS: { panel: ActivityPanel; icon: typeof Files; label: string }[] = [
  { panel: 'explorer', icon: Files, label: 'Files' },
  { panel: 'search', icon: Search, label: 'Search' },
  { panel: 'scm', icon: GitBranch, label: 'Source Control (git changes)' },
  { panel: 'agent', icon: MessageSquare, label: 'Chat history' },
  { panel: 'terminal', icon: TerminalIcon, label: 'Terminal' },
  { panel: 'ssh', icon: Server, label: 'SSH' },
];

export const ActivityBar = memo(function ActivityBar({
  isAgentRunning,
  gitChangeCount,
  simple = false,
  remote,
  onOpenSsh,
}: ActivityBarProps) {
  const { state, setActivePanel } = useWorkspace();

  const isRemote = Boolean(remote?.connected && remote.profile);

  const handleTerminalClick = () => {
    setActivePanel('terminal');
  };

  const handleSshClick = () => {
    if (onOpenSsh) onOpenSsh();
    else setActivePanel('ssh');
  };

  return (
    <RailRoot>
      {/* Brand */}
      <RailBrand />

      {/* Workspace tools — top group */}
      <div className="w-full flex-1 flex flex-col items-center gap-px py-1.5">
        {PANEL_ITEMS.filter(({ panel }) => !(simple && panel === 'terminal')).map(({ panel, icon: Icon, label }) => {
          const isActive = state.activePanel === panel && state.sidePanelOpen;
          const showBadge = panel === 'scm' && (gitChangeCount ?? 0) > 0;
          const onClick = panel === 'terminal' ? handleTerminalClick : panel === 'ssh' ? handleSshClick : () => setActivePanel(panel);
          return (
            <RailButton
              key={panel}
              active={isActive}
              running={panel === 'agent' && Boolean(isAgentRunning)}
              badge={showBadge ? gitChangeCount! : undefined}
              dot={panel === 'ssh'}
              dotColor={isRemote ? 'emerald' : 'muted'}
              onClick={onClick}
              title={label}
            >
              <Icon className="h-[18px] w-[18px]" strokeWidth={isActive ? 2.2 : 1.8} />
            </RailButton>
          );
        })}
      </div>

      <RailDivider />

      {/* App sections — bottom group (redirects) */}
      <RailSections />

      {/* User / sign out */}
      <RailLogout />
    </RailRoot>
  );
});