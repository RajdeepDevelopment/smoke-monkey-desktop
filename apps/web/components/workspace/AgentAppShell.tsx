'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { FolderOpen, History, Plus } from 'lucide-react';
import { WorkspaceProvider, useWorkspace } from './WorkspaceProvider';
import { ActivityBar } from './ActivityBar';
import { WorkspaceShortcuts } from './WorkspaceShortcuts';
import { SidePanel } from './SidePanel';
import { TopBar } from './TopBar';
import { BottomPanel } from './BottomPanel';
import type { RemoteConnectionState } from './StatusBar';
import { ModeSwitcher } from './ModeSwitcher';
import { type SimplePreviewFile } from './SimpleFilePreview';
import { cn } from '../../lib/utils';
import { initExternalLinkHandling } from '../../lib/external-links';

interface AgentAppShellProps {
  editorArea: ReactNode;
  agentPanel: ReactNode;
  bottomPanelContent: ReactNode;
  sidePanelContent: ReactNode;
  workspacePath?: string;
  breadcrumbs?: { name: string; path: string }[];
  topBarActions?: ReactNode;
  /** Clicking the workspace path in the top bar (e.g. to switch the IDE dir). */
  onSwitchWorkspace?: () => void;
  isAgentRunning?: boolean;
  gitChangeCount?: number;
  /** Remote-SSH connection state (shown as the rail indicator). */
  remote?: RemoteConnectionState;
  /** Called with a profile id to connect, or null to disconnect (local). */
  onRemoteChange?: (profileId: string | null) => void;
  /** Currently opened file to surface in Simple mode's left-side preview. */
  filePreview?: { file: SimplePreviewFile; onClose: () => void } | null;
  // Simple-mode merged top bar controls (the chat header is hidden there).
  sessionTitle?: string;
  sessions?: { id: string; title?: string | null; status?: string; updatedAt?: string; messageCount?: number }[];
  activeSessionId?: string;
  onNewSession?: () => void;
  onSelectSession?: (session: SimpleSession) => void;
}

interface SimpleSession {
  id: string;
  title?: string | null;
  status?: string;
  updatedAt?: string;
  messageCount?: number;
}

export function AgentAppShell(props: AgentAppShellProps) {
  useEffect(() => {
    initExternalLinkHandling();
  }, []);

  return (
    <WorkspaceProvider>
      <ShellInner {...props} />
    </WorkspaceProvider>
  );
}

function ShellInner({
  editorArea,
  agentPanel,
  bottomPanelContent,
  sidePanelContent,
  workspacePath,
  breadcrumbs,
  topBarActions,
  onSwitchWorkspace,
  isAgentRunning,
  gitChangeCount,
  remote,
  onRemoteChange,
  filePreview,
  sessionTitle,
  sessions,
  activeSessionId,
  onNewSession,
  onSelectSession,
}: AgentAppShellProps) {
  const { state, setUiMode } = useWorkspace();
  const simple = state.uiMode === 'simple';

  return (
    <>
      <WorkspaceShortcuts />
      <div className="workspace-bg flex h-screen flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* Activity Bar — workspace tools + app-section redirects in one rail */}
          <ActivityBar
            isAgentRunning={isAgentRunning}
            gitChangeCount={gitChangeCount}
            simple={simple}
            remote={remote}
          />

          {/* Side Panel (Explorer/Search/SCM/Sessions) — slides in, pushing content */}
          <SidePanel pushAnimation={simple}>{sidePanelContent}</SidePanel>

          {/* Main Workspace */}
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {simple ? (
              <SimpleTopBar
                workspacePath={workspacePath}
                onSwitchWorkspace={onSwitchWorkspace}
                sessionTitle={sessionTitle}
                sessions={sessions}
                activeSessionId={activeSessionId}
                onNewSession={onNewSession}
                onSelectSession={onSelectSession}
              />
            ) : (
              <TopBar
                workspacePath={workspacePath}
                breadcrumbs={breadcrumbs}
                onSwitchWorkspace={onSwitchWorkspace}
              >
                <ModeSwitcher mode={state.uiMode} onChange={setUiMode} size="sm" className="mr-1" />
                {topBarActions}
              </TopBar>
            )}

            <div className="flex min-h-0 flex-1 overflow-hidden">
              {/* Simple mode: reuse the exact dev-mode EditorArea (tabs +
                  Monaco) as a left-side panel whenever a file is open. */}
              {simple && filePreview && (
                <div
                  className="glass-border-right shrink-0 overflow-hidden"
                  style={{ width: 'clamp(340px, 46%, 720px)' }}
                >
                  {editorArea}
                </div>
              )}

              <EditorAgentSplit editorArea={editorArea} agentPanel={agentPanel} simple={simple} />
            </div>

            {/* Bottom Panel (Terminal) — Developer mode only. */}
            {!simple && <BottomPanel>{bottomPanelContent}</BottomPanel>}
          </div>
        </div>

        {/* Connection location indicator moved into the left rail (ActivityBar). */}
      </div>
    </>
  );
}

/** Simple-mode merged top bar: workspace + session title + mode + new/history. */
function SimpleTopBar({
  workspacePath,
  onSwitchWorkspace,
  sessionTitle,
  sessions = [],
  activeSessionId,
  onNewSession,
  onSelectSession,
}: {
  workspacePath?: string;
  onSwitchWorkspace?: () => void;
  sessionTitle?: string;
  sessions?: SimpleSession[];
  activeSessionId?: string;
  onNewSession?: () => void;
  onSelectSession?: (session: SimpleSession) => void;
}) {
  const { state, setUiMode } = useWorkspace();
  const [historyOpen, setHistoryOpen] = useState(false);
  const workspaceName = workspacePath ? workspacePath.split('/').pop() : 'No workspace';

  return (
    <div className="relative flex h-9 shrink-0 items-center gap-1.5 border-b border-border/30 bg-background px-2.5">
      {/* Workspace / folder — left of the merged bar */}
      <button
        type="button"
        onClick={onSwitchWorkspace}
        disabled={!onSwitchWorkspace}
        title={workspacePath || 'No workspace — click to choose a folder'}
        className={cn(
          'group flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-left transition-colors',
          onSwitchWorkspace ? 'hover:bg-surface-800' : 'cursor-default',
        )}
      >
        <FolderOpen className={cn('h-3 w-3 shrink-0', onSwitchWorkspace ? 'text-ink-muted group-hover:text-ink-primary' : 'text-ink-muted/50')} />
        <span className="max-w-[26vw] truncate text-[11px] font-medium text-foreground/80 sm:max-w-[18vw]">{workspaceName}</span>
      </button>

      <span className="mx-1 h-3.5 w-px shrink-0 bg-border/40" />

      {/* Session title */}
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground/85">
        {sessionTitle || 'Smoke Monkey'}
      </span>

      <ModeSwitcher mode={state.uiMode} onChange={setUiMode} size="sm" className="mr-0.5" />

      {onNewSession && (
        <button
          onClick={onNewSession}
          title="New chat"
          aria-label="New chat"
          className="glass-hover rounded-md p-1 text-ink-muted transition-colors hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      )}

      {onSelectSession && (
        <button
          onClick={() => setHistoryOpen((v) => !v)}
          title="Chat history"
          aria-label="Chat history"
          aria-expanded={historyOpen}
          className={cn(
            'glass-hover rounded-md p-1 transition-colors',
            historyOpen ? 'text-foreground' : 'text-ink-muted hover:text-foreground',
          )}
        >
          <History className="h-3.5 w-3.5" />
        </button>
      )}

      {/* Recent chats dropdown */}
      {historyOpen && onSelectSession && (
        <>
          <button
            aria-label="Close chat history"
            onClick={() => setHistoryOpen(false)}
            className="fixed inset-0 z-20 cursor-default bg-transparent"
          />
          <div className="absolute right-2 top-full z-30 mt-1 max-h-[70vh] w-72 overflow-hidden overflow-y-auto glass-panel rounded-lg border border-border/60 p-1.5 shadow-xl scrollbar-thin">
            {(() => {
              const now = new Date();
              const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
              const groups: Array<{ label: string; items: SimpleSession[] }> = [
                { label: 'Today', items: [] },
                { label: 'Yesterday', items: [] },
                { label: 'Older', items: [] },
              ];
              for (const s of sessions) {
                const t = new Date(s.updatedAt || '').getTime();
                if (!Number.isFinite(t)) continue;
                if (t >= startOfToday) groups[0].items.push(s);
                else if (t >= startOfToday - 86_400_000) groups[1].items.push(s);
                else groups[2].items.push(s);
              }
              return (
                <>
                  {groups.map(({ label, items }) =>
                    items.length === 0 ? null : (
                      <div key={label} className="mb-0.5">
                        <p className="px-2 py-1 text-[9px] font-semibold uppercase tracking-wider text-ink-muted">{label}</p>
                        {items.map((s) => (
                          <button
                            key={s.id}
                            onClick={() => { onSelectSession(s); setHistoryOpen(false); }}
                            className={cn(
                              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/[0.05]',
                              s.id === activeSessionId && 'bg-primary-subtle',
                            )}
                          >
                            <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', s.status === 'running' ? 'bg-blue-400' : s.status === 'completed' ? 'bg-green-400' : s.status === 'failed' ? 'bg-red-400' : s.status === 'interrupted' ? 'bg-yellow-400' : 'bg-zinc-500')} />
                            <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{s.title || 'Untitled'}</span>
                            <span className="shrink-0 text-[9px] text-ink-muted">{s.messageCount ?? 0} msgs</span>
                          </button>
                        ))}
                      </div>
                    ),
                  )}
                  {groups.every((g) => g.items.length === 0) && (
                    <p className="px-2 py-3 text-center text-[10px] text-ink-muted">No chats yet</p>
                  )}
                </>
              );
            })()}
          </div>
        </>
      )}
    </div>
  );
}


/** Editor + resizable agent panel. In Simple mode only the agent (chat) fills the area. */
function EditorAgentSplit({
  editorArea,
  agentPanel,
  simple,
}: {
  editorArea: ReactNode;
  agentPanel: ReactNode;
  simple: boolean;
}) {
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

  if (simple) {
    // Chat-first: full width, no editor, no resize handle.
    return <div className="min-h-0 flex-1 overflow-hidden">{agentPanel}</div>;
  }

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