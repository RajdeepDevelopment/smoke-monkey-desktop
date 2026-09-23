'use client';

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  Plus, Trash2, MessageSquare, Search as SearchIcon,
  ChevronDown, ChevronRight, Shield, Terminal as TerminalIcon,
  PanelBottom, RefreshCw, FolderDown, GitCompare,
  FileSearch, TextSearch, Loader2, Sparkles,
  FilePlus2, FolderPlus, Minus,
} from 'lucide-react';
import type { AgentSession, ChatSearchResult } from '../../lib/agent-api';
import { agentApi } from '../../lib/agent-api';
import type { GitStatusEntry, GitStatusResult } from '../../lib/ide-api';
import { FileExplorer } from '../workspace/FileExplorer';
import type { WorkspaceClient } from '../../lib/workspace-client';
import { SearchPanel } from '../workspace/SearchPanel';
import { SourceControlPanel } from '../workspace/SourceControlPanel';
import { SshPanel } from '../ssh/SshPanel';
import { useWorkspace } from '../../hooks/useWorkspace';
import { cn } from '../../lib/utils';

interface ModelProvider {
  id: string;
  label: string;
  models: string[];
}

interface SidePanelContentProps {
  sessions: AgentSession[];
  activeSession: AgentSession | null;
  workspacePath: string;
  selectedModel: string;
  selectedProvider: string;
  providers: ModelProvider[];

  // Explorer
  fileTree: import('../../lib/ide-api').TreeNode[];
  fileTreeLoading: boolean;
  activeFile?: string;
  dirtyPaths?: Set<string>;
  gitEntries?: Map<string, GitStatusEntry>;
  onSelectSession: (session: AgentSession) => void;
  onDeleteSession: (id: string) => void;
  onCreateSession: (agentId: string) => void;
  onFileSelect: (path: string) => void;
  onRefreshFileTree: () => void;
  onOpenFolder: () => void;

  // Source control
  gitStatus: GitStatusResult | null;
  gitLoading: boolean;
  onRefreshGit: () => void;
  /** Fetch the next page of git changes (infinite scroll). */
  onLoadMoreGit?: () => void;
  /** True while the next git changes page is being fetched. */
  gitMoreLoading?: boolean;
  /** True when there are more git changes to load. */
  gitHasMore?: boolean;

  // Search
  onSearchResultOpen: (path: string, line?: number) => void;

  // Git diff open (from SCM / explorer)
  onOpenGitDiff: (relPath: string) => void;

  onModelChange: (model: string) => void;
  onProviderChange: (provider: string) => void;
  /** Optional mode-aware client for Remote-SSH; forwards to the file explorer. */
  client?: WorkspaceClient;
  /** Active remote (SSH) profile id, when the whole IDE is on a remote host. */
  activeSshProfileId?: string | null;
  /** Connect to a host — flips Explorer/Agent/terminal to remote. */
  onConnectRemote?: (profileId: string) => void;
  /** Disconnect back to local workspace. */
  onDisconnectRemote?: () => void;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    running: 'bg-blue-400',
    completed: 'bg-green-400',
    failed: 'bg-red-400',
    interrupted: 'bg-yellow-400',
  };
  return <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', colors[status] || 'bg-zinc-500')} />;
}

function PanelHeader({ title, children }: { title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="glass-border-bottom flex h-9 shrink-0 items-center justify-between gap-2 px-3">
      <span className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-wider text-ink-muted">{title}</span>
      <div className="flex shrink-0 items-center gap-1">{children}</div>
    </div>
  );
}

function SessionGroup({
  label, sessions, activeSession, onSelect, onDelete,
}: {
  label: string;
  sessions: AgentSession[];
  activeSession: AgentSession | null;
  onSelect: (s: AgentSession) => void;
  onDelete: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <div>
      <button onClick={() => setExpanded(!expanded)}
        className="glass-hover flex w-full items-center gap-1 rounded px-2 py-1 text-left transition-colors">
        {expanded ? <ChevronDown className="h-2.5 w-2.5 text-ink-muted" /> : <ChevronRight className="h-2.5 w-2.5 text-ink-muted" />}
        <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">{label}</span>
        <span className="ml-auto text-[9px] text-ink-muted/50">{sessions.length}</span>
      </button>
      {expanded && (
        <div className="mt-0.5 space-y-0.5">
          {sessions.map((s) => (
            <div key={s.id} role="button" tabIndex={0} onClick={() => onSelect(s)}
              onKeyDown={(e) => { if (e.key === 'Enter') onSelect(s); }}
              className={cn(
                'group flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04]',
                activeSession?.id === s.id && 'bg-primary-subtle',
              )}>
              <StatusDot status={s.status} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] font-medium">{s.title || 'Untitled'}</p>
                <p className="text-[9px] text-ink-muted">{fmtDate(s.updatedAt)} · {s.messageCount || 0} msgs</p>
              </div>
              <button onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}
                className="hidden shrink-0 p-0.5 text-ink-muted hover:text-red-500 group-hover:block">
                <Trash2 className="h-2.5 w-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SidePanelContent({
  sessions,
  activeSession,
  workspacePath,
  selectedModel,
  selectedProvider,
  providers,
  fileTree,
  fileTreeLoading,
  activeFile,
  dirtyPaths,
  gitEntries,
  onSelectSession,
  onDeleteSession,
  onCreateSession,
  onFileSelect,
  onRefreshFileTree,
  onOpenFolder,
  gitStatus,
  gitLoading,
  onRefreshGit,
  onLoadMoreGit,
  gitMoreLoading,
  gitHasMore,
  onSearchResultOpen,
  onOpenGitDiff,
  onModelChange,
  onProviderChange,
  client,
  activeSshProfileId,
  onConnectRemote,
  onDisconnectRemote,
}: SidePanelContentProps) {
  const { state, setActivePanel, expandBottomPanel } = useWorkspace();
  const [showNewSession, setShowNewSession] = useState(false);
  const [newSessionTitle, setNewSessionTitle] = useState('');
  const [sessionSearch, setSessionSearch] = useState('');
  const [chatSearchMode, setChatSearchMode] = useState<'titles' | 'chats'>('chats');
  const [chatResults, setChatResults] = useState<ChatSearchResult[]>([]);
  const [chatSearching, setChatSearching] = useState(false);
  const chatDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestChatQueryRef = useRef('');
  // Toolbar-driven explorer actions (VS Code-style header buttons).
  const [createSignal, setCreateSignal] = useState<{ nonce: number; type: 'file' | 'directory' } | null>(null);
  const [collapseSignal, setCollapseSignal] = useState<{ nonce: number } | null>(null);

  const runChatSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      latestChatQueryRef.current = '';
      setChatResults([]);
      setChatSearching(false);
      return;
    }
    latestChatQueryRef.current = q;
    setChatSearching(true);
    try {
      const res = await agentApi.searchChats(q);
      if (latestChatQueryRef.current === q) setChatResults(res ?? []);
    } catch {
      if (latestChatQueryRef.current === q) setChatResults([]);
    } finally {
      if (latestChatQueryRef.current === q) setChatSearching(false);
    }
  }, []);

  useEffect(() => {
    if (chatSearchMode !== 'chats') return;
    if (chatDebounceRef.current) clearTimeout(chatDebounceRef.current);
    chatDebounceRef.current = setTimeout(() => void runChatSearch(sessionSearch), 250);
    return () => {
      if (chatDebounceRef.current) clearTimeout(chatDebounceRef.current);
    };
  }, [sessionSearch, chatSearchMode, runChatSearch]);

  const handleOpenSearchSession = useCallback(async (result: ChatSearchResult) => {
    const known = sessions.find((s) => s.id === result.sessionId);
    if (known) {
      onSelectSession(known);
      return;
    }
    try {
      const s = await agentApi.getSession(result.sessionId);
      onSelectSession(s);
    } catch { /* session may have been deleted */ }
  }, [sessions, onSelectSession]);

  const highlight = (text: string, q: string) => {
    if (!q || !q.trim()) return text;
    try {
      const escaped = q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(${escaped})`, 'ig');
      return text.split(re).map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-sm bg-primary-subtle px-0 text-primary-hover">{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      );
    } catch {
      return text;
    }
  };

  const currentModels = providers.find((p) => p.id === selectedProvider)?.models || [];

  const filteredSessions = useMemo(() => {
    if (!sessionSearch) return sessions;
    const q = sessionSearch.toLowerCase();
    return sessions.filter((s) => (s.title || '').toLowerCase().includes(q) || (s.agentId || '').toLowerCase().includes(q));
  }, [sessions, sessionSearch]);

  const groupedSessions = useMemo(() => {
    const now = new Date();
    const today: AgentSession[] = [];
    const yesterday: AgentSession[] = [];
    const older: AgentSession[] = [];
    for (const s of filteredSessions) {
      const d = new Date(s.updatedAt);
      const diff = now.getTime() - d.getTime();
      if (diff < 86400000) today.push(s);
      else if (diff < 172800000) yesterday.push(s);
      else older.push(s);
    }
    return { today, yesterday, older };
  }, [filteredSessions]);

  const handleCreateSession = useCallback((agentId: string) => {
    onCreateSession(agentId);
    setShowNewSession(false);
    setNewSessionTitle('');
  }, [onCreateSession]);

  if (!state.sidePanelOpen) return null;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#0B0F17]/80">
      {/* ── Explorer ─────────────────────────────────────────────── */}
      {state.activePanel === 'explorer' && (
        <>
          <PanelHeader
            title={
              <span className="flex min-w-0 items-baseline gap-1">
                <span className="shrink-0">Explorer</span>
                {workspacePath && (
                  <>
                    <span className="text-ink-muted/40">:</span>
                    <span
                      className="min-w-0 max-w-[150px] truncate font-semibold normal-case text-ink-secondary"
                      title={workspacePath}
                    >
                      {workspacePath.split('/').pop()}
                    </span>
                  </>
                )}
              </span>
            }
          >
            <button onClick={() => setCreateSignal({ nonce: Date.now(), type: 'file' })} className="glass-hover rounded p-1 text-ink-muted transition-colors hover:text-foreground" title="New File">
              <FilePlus2 className="h-3 w-3" />
            </button>
            <button onClick={() => setCreateSignal({ nonce: Date.now(), type: 'directory' })} className="glass-hover rounded p-1 text-ink-muted transition-colors hover:text-foreground" title="New Folder">
              <FolderPlus className="h-3 w-3" />
            </button>
            <button onClick={onRefreshFileTree} className="glass-hover rounded p-1 text-ink-muted transition-colors hover:text-foreground" title="Refresh Explorer">
              <RefreshCw className={cn('h-3 w-3', fileTreeLoading && 'animate-spin')} />
            </button>
            {!client?.isRemote() && (
              <button onClick={onOpenFolder} className="glass-hover rounded p-1 text-ink-muted transition-colors hover:text-foreground" title="Open Folder">
                <FolderDown className="h-3 w-3" />
              </button>
            )}
            <button onClick={() => setCollapseSignal({ nonce: Date.now() })} className="glass-hover rounded p-1 text-ink-muted transition-colors hover:text-foreground" title="Collapse Folders">
              <Minus className="h-3 w-3" />
            </button>
          </PanelHeader>
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
            <FileExplorer
              entries={fileTree}
              workspaceRoot={workspacePath}
              activeFile={activeFile}
              selectedFile={activeFile}
              dirtyPaths={dirtyPaths}
              gitEntries={gitEntries}
              onFileSelect={onFileSelect}
              onOpenGitDiff={onOpenGitDiff}
              onRefresh={onRefreshFileTree}
              loading={fileTreeLoading}
              client={client}
              createSignal={createSignal}
              collapseSignal={collapseSignal}
              className="py-1"
            />
          </div>
        </>
      )}

      {/* ── Search ───────────────────────────────────────────────── */}
      {state.activePanel === 'search' && (
        <>
          <PanelHeader title="Search" />
          <div className="min-h-0 flex-1 overflow-hidden">
            <SearchPanel workspaceRoot={workspacePath} onOpenResult={onSearchResultOpen} />
          </div>
        </>
      )}

      {/* ── Source Control ───────────────────────────────────────── */}
      {state.activePanel === 'scm' && (
        <>
          <PanelHeader title="Source Control" />
          <div className="min-h-0 flex-1 overflow-hidden">
            <SourceControlPanel
              workspaceRoot={workspacePath}
              status={gitStatus}
              loading={gitLoading}
              onRefresh={onRefreshGit}
              onLoadMore={onLoadMoreGit}
              loadingMore={gitMoreLoading}
              hasMore={gitHasMore}
              onOpenDiff={(relPath) => onOpenGitDiff(relPath)}
              model={selectedModel}
              provider={selectedProvider}
            />
          </div>
        </>
      )}

      {/* ── Agent Sessions ───────────────────────────────────────── */}
      {state.activePanel === 'agent' && (
        <>
          <PanelHeader title="Agent">
            <button onClick={() => setShowNewSession(!showNewSession)} className="glass-hover rounded p-1 text-ink-muted transition-colors hover:text-foreground" title="New Session">
              <Plus className="h-3.5 w-3.5" />
            </button>
          </PanelHeader>

          {showNewSession && (
            <div className="glass-panel mx-2 my-2 space-y-2 rounded-lg p-2.5">
              <input value={newSessionTitle} onChange={(e) => setNewSessionTitle(e.target.value)}
                placeholder="Session title (optional)"
                className="glass-panel w-full rounded-md px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
                autoFocus onKeyDown={(e) => { if (e.key === 'Enter') handleCreateSession('build'); }} />
              <div className="grid grid-cols-2 gap-1">
                {[
                  { id: 'build', label: 'Build', desc: 'Read + Write + Run' },
                  { id: 'explore', label: 'Explore', desc: 'Search + Read' },
                  { id: 'plan', label: 'Plan', desc: 'Read only' },
                  { id: 'general', label: 'General', desc: 'Full access' },
                ].map((a) => (
                  <button key={a.id} onClick={() => handleCreateSession(a.id)}
                    className="glass-panel glass-hover rounded-md p-1.5 text-left transition-colors">
                    <p className="text-[11px] font-medium">{a.label}</p>
                    <p className="text-[9px] text-ink-muted">{a.desc}</p>
                  </button>
                ))}
              </div>
              <button onClick={() => setShowNewSession(false)} className="w-full text-[10px] text-ink-muted hover:text-foreground">Cancel</button>
            </div>
          )}

          <div className="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto px-1.5 py-1">
            <div className="space-y-1 pb-1">
              <div className="relative">
                <SearchIcon className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-ink-muted" />
                <input value={sessionSearch} onChange={(e) => setSessionSearch(e.target.value)}
                  placeholder={chatSearchMode === 'chats' ? 'Search chat contents…' : 'Search sessions…'}
                  className="glass-panel w-full rounded-md py-1 pl-7 pr-2 text-[11px] outline-none placeholder:text-ink-muted/50 focus:ring-1 focus:ring-ring" />
                {chatSearching && <Loader2 className="absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 animate-spin text-primary-hover" />}
              </div>
              <div className="flex items-center gap-1">
                <div className="flex overflow-hidden rounded border border-border/70">
                  <button onClick={() => setChatSearchMode('titles')} title="Search by session title"
                    className={cn('flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium transition-colors',
                      chatSearchMode === 'titles' ? 'bg-primary-subtle text-foreground' : 'text-ink-muted hover:text-foreground')}>
                    <FileSearch className="h-3 w-3" /> Titles
                  </button>
                  <button onClick={() => setChatSearchMode('chats')} title="Search inside the chat messages"
                    className={cn('flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium transition-colors',
                      chatSearchMode === 'chats' ? 'bg-primary-subtle text-foreground' : 'text-ink-muted hover:text-foreground')}>
                    <TextSearch className="h-3 w-3" /> Contents
                  </button>
                </div>
                {chatSearchMode === 'chats' && sessionSearch.trim() && (
                  <span className="ml-auto max-w-[50%] truncate text-[9px] text-ink-muted">
                    {chatSearching ? 'searching…' : `${chatResults.reduce((n, r) => n + r.matchCount, 0)} match${chatResults.length === 1 ? '' : 'es'} · ${chatResults.length} chat${chatResults.length === 1 ? '' : 's'}`}
                  </span>
                )}
              </div>
            </div>

            {chatSearchMode === 'chats' && sessionSearch.trim() !== '' ? (
              chatResults.length === 0 && !chatSearching ? (
                <div className="flex h-28 flex-col items-center justify-center px-4 text-center text-ink-muted">
                  <SearchIcon className="mb-1 h-5 w-5 opacity-30" />
                  <p className="text-[10px]">No chats mention “{sessionSearch}”</p>
                  <p className="mt-0.5 text-[9px] text-ink-muted/60">Try a phrase, a command, or a file name from the conversation</p>
                </div>
              ) : (
                <div className="space-y-2.5 pt-0.5">
                  {chatResults.map((r) => (
                    <div key={r.sessionId}>
                      <button onClick={() => void handleOpenSearchSession(r)}
                        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-white/[0.04]">
                        <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{r.title || 'Untitled'}</span>
                        <span className="shrink-0 text-[9px] text-ink-muted">{fmtDate(r.updatedAt)}</span>
                        <span className="shrink-0 rounded-full bg-primary-subtle px-1.5 text-[9px] font-medium text-primary-hover">{r.matchCount}</span>
                      </button>
                      <div className="ml-2 mt-0.5 space-y-0.5 border-l border-border/40 pl-2">
                        {r.snippets.map((sn, i) => (
                          <button key={i} onClick={() => void handleOpenSearchSession(r)}
                            className="block w-full rounded px-1.5 py-0.5 text-left transition-colors hover:bg-white/[0.04]">
                            <span className="mb-0.5 flex items-center gap-1 text-[8.5px] font-semibold uppercase tracking-wide text-ink-muted">
                              {sn.role === 'user' ? 'You' : (
                                <span className="inline-flex items-center gap-1"><Sparkles className="h-2.5 w-2.5 text-primary-hover" /> Agent</span>
                              )}
                              <span className="font-normal normal-case text-ink-muted/60">· {fmtDate(sn.createdAt)}</span>
                            </span>
                            <span className="line-clamp-2 whitespace-pre-wrap break-words text-[10.5px] leading-snug text-ink-secondary">
                              {highlight(sn.content, sessionSearch)}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                  {chatResults.length === 0 && chatSearching && (
                    <div className="flex h-20 items-center justify-center text-[10px] text-ink-muted">Searching chats…</div>
                  )}
                </div>
              )
            ) : (
              <>
                {groupedSessions.today.length > 0 && (
                  <SessionGroup label="Today" sessions={groupedSessions.today} activeSession={activeSession}
                    onSelect={(s) => onSelectSession(s)}
                    onDelete={onDeleteSession} />
                )}
                {groupedSessions.yesterday.length > 0 && (
                  <SessionGroup label="Yesterday" sessions={groupedSessions.yesterday} activeSession={activeSession}
                    onSelect={(s) => onSelectSession(s)}
                    onDelete={onDeleteSession} />
                )}
                {groupedSessions.older.length > 0 && (
                  <SessionGroup label="Older" sessions={groupedSessions.older} activeSession={activeSession}
                    onSelect={(s) => onSelectSession(s)}
                    onDelete={onDeleteSession} />
                )}
                {sessions.length === 0 && (
                  <div className="flex flex-col items-center justify-center h-32 text-ink-muted">
                    <MessageSquare className="mb-1 h-6 w-6 opacity-30" />
                    <p className="text-[10px]">No sessions yet</p>
                  </div>
                )}
                {sessions.length > 0 && sessionSearch.trim() === '' && groupedSessions.today.length === 0 && groupedSessions.yesterday.length === 0 && groupedSessions.older.length === 0 && (
                  <div className="flex flex-col items-center justify-center h-24 text-ink-muted">
                    <MessageSquare className="mb-1 h-5 w-5 opacity-30" />
                    <p className="text-[10px]">Start a chat to see it here</p>
                  </div>
                )}
                {sessions.length > 0 && sessionSearch.trim() !== '' && filteredSessions.length === 0 && (
                  <div className="flex flex-col items-center justify-center h-24 text-ink-muted">
                    <SearchIcon className="mb-1 h-4 w-4 opacity-40" />
                    <p className="text-[10px]">No sessions match “{sessionSearch}”</p>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}

      {/* ── SSH ──────────────────────────────────────────────────── */}
      {state.activePanel === 'ssh' && (
        <>
          <PanelHeader title="SSH" />
          <div className="min-h-0 flex-1 overflow-hidden">
            <SshPanel className="h-full"
              activeProfileId={activeSshProfileId}
              onConnect={(p) => onConnectRemote?.(p.id)}
              onDisconnect={onDisconnectRemote}
            />
          </div>
        </>
      )}

      {/* ── Terminal hint panel ──────────────────────────────────── */}
      {state.activePanel === 'terminal' && (
        <>
          <PanelHeader title="Terminal" />
          <div className="flex flex-1 items-center justify-center p-4 text-ink-muted">
            <div className="text-center">
              <TerminalIcon className="mx-auto mb-2 h-7 w-7 opacity-30" />
              <p className="text-[11px] font-medium text-ink-secondary">Integrated terminal</p>
              <p className="mt-1 text-[10px] leading-relaxed">The terminal lives in the bottom panel.</p>
              <button
                onClick={() => {
                  expandBottomPanel();
                  setActivePanel('explorer');
                }}
                className="mx-auto mt-3 flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
              >
                <PanelBottom className="h-3 w-3" /> Open Terminal Panel
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── Settings ─────────────────────────────────────────────── */}
      {state.activePanel === 'settings' && (
        <>
          <PanelHeader title="Settings" />
          <div className="space-y-3 p-3">
            <div>
              <label className="text-[10px] font-medium uppercase tracking-wider text-ink-muted">Provider</label>
              <select value={selectedProvider}
                onChange={(e) => onProviderChange(e.target.value)}
                className="glass-panel mt-1 w-full rounded-md px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring">
                {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-medium uppercase tracking-wider text-ink-muted">Model</label>
              <select value={selectedModel}
                onChange={(e) => onModelChange(e.target.value)}
                className="glass-panel mt-1 w-full rounded-md px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring">
                {currentModels.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <a href="/settings" className="flex items-center gap-1.5 text-[10px] text-ink-muted transition-colors hover:text-foreground">
              <Shield className="h-3 w-3" /> API Key Settings
            </a>
          </div>
        </>
      )}
    </div>
  );
}
