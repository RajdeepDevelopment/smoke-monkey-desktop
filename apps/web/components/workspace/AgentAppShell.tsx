'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { WorkspaceProvider, useWorkspace } from './WorkspaceProvider';
import { ActivityBar } from './ActivityBar';
import { WorkspaceShortcuts } from './WorkspaceShortcuts';
import { SidePanel } from './SidePanel';
import { TopBar } from './TopBar';
import { BottomPanel } from './BottomPanel';
import { GlobalNavDrawer } from './GlobalNavDrawer';
import { cn } from '../../lib/utils';

interface AgentAppShellProps {
  editorArea: ReactNode;
  agentPanel: ReactNode;
  bottomPanelContent: ReactNode;
  sidePanelContent: ReactNode;
  workspacePath?: string;
  breadcrumbs?: { name: string; path: string }[];
  topBarActions?: ReactNode;
  isAgentRunning?: boolean;
  gitChangeCount?: number;
}

export function AgentAppShell({
  editorArea,
  agentPanel,
  bottomPanelContent,
  sidePanelContent,
  workspacePath,
  breadcrumbs,
  topBarActions,
  isAgentRunning,
  gitChangeCount,
}: AgentAppShellProps) {
  const [navOpen, setNavOpen] = useState(false);
  return (
    <WorkspaceProvider>
      <WorkspaceShortcuts />
      <div className="workspace-bg flex h-screen overflow-hidden">
        {/* Activity Bar */}
        <ActivityBar
          isAgentRunning={isAgentRunning}
          gitChangeCount={gitChangeCount}
          onToggleGlobalNav={() => setNavOpen((v) => !v)}
        />

        {/* Global sections sidebar — pushes content, never overlays */}
        <GlobalNavDrawer open={navOpen} onClose={() => setNavOpen(false)} />

        {/* Side Panel (Explorer/Search/SCM/Sessions) */}
        <SidePanel>{sidePanelContent}</SidePanel>

        {/* Main Workspace */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <TopBar workspacePath={workspacePath} breadcrumbs={breadcrumbs}>
            {topBarActions}
          </TopBar>

          <EditorAgentSplit editorArea={editorArea} agentPanel={agentPanel} />

          {/* Bottom Panel (Terminal) */}
          <BottomPanel>{bottomPanelContent}</BottomPanel>
        </div>
      </div>
    </WorkspaceProvider>
  );
}

/** Editor + resizable agent panel. */
function EditorAgentSplit({ editorArea, agentPanel }: { editorArea: ReactNode; agentPanel: ReactNode }) {
  const { state, dispatch } = useWorkspace();
  const [dragging, setDragging] = useState(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setDragging(true);
      dragStartX.current = e.clientX;
      dragStartWidth.current = state.agentWidth;
    },
    [state.agentWidth],
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const delta = dragStartX.current - e.clientX;
      dispatch({ type: 'SET_AGENT_WIDTH', width: dragStartWidth.current + delta });
    };
    const onUp = () => setDragging(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [dragging, dispatch]);

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* Editor Area */}
      <div className="min-w-0 flex-1 overflow-hidden">{editorArea}</div>

      {/* Resize handle */}
      <div
        onMouseDown={handleMouseDown}
        className={cn(
          'relative z-10 w-px shrink-0 cursor-col-resize transition-colors',
          dragging ? 'bg-primary/50' : 'bg-transparent hover:bg-primary/30',
        )}
      >
        <div className="-mx-1 absolute inset-y-0 left-0 right-0" />
      </div>

      {/* Agent Panel */}
      <div className="glass-border-left shrink-0 overflow-hidden" style={{ width: state.agentWidth }}>
        {agentPanel}
      </div>
    </div>
  );
}
