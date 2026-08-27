'use client';

import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import dynamic from 'next/dynamic';
import {
  Plus, FolderDown, Code2, X, Cpu,
} from 'lucide-react';
import type { AgentSession } from '../../lib/agent-api';
import { agentApi } from '../../lib/agent-api';
import { AgentChat } from '../../components/agent/AgentChat';
import { AgentAppShell } from '../../components/workspace/AgentAppShell';
import { SidePanelContent } from '../../components/workspace/SidePanelContent';
import { EditorArea, type GitDiffPayload } from '../../components/workspace/EditorArea';
import { QuickOpen } from '../../components/workspace/QuickOpen';
import { ideApi, type TreeNode, type GitStatusEntry } from '../../lib/ide-api';
import { getFileViewerType, isEditableViewer, type FileViewerType } from '../../lib/file-types';
import { nativeFetch, API_URL, getToken } from '../../lib/api';
import { useAuth } from '../../components/AuthProvider';

const TerminalView = dynamic(
  () => import('../../components/agent/TerminalView').then(m => ({ default: m.TerminalView })),
  { ssr: false, loading: () => <div className="h-full bg-[#080C12] flex items-center justify-center text-ink-muted text-xs">Loading terminal...</div> }
);

async function openFolderPicker(): Promise<string | null> {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({ directory: true, multiple: false, title: 'Select Project Folder' });
    if (typeof selected === 'string') return selected;
    if (selected && typeof selected === 'object' && 'path' in selected) return (selected as any).path;
    return null;
  } catch {
    return null;
  }
}

interface ModelProvider {
  id: string;
  label: string;
  models: string[];
}

interface OpenFile {
  path: string;
  name: string;
  content: string;
  originalContent: string;
  modified: boolean;
  kind?: FileViewerType;
  raw?: { dataUrl?: string; blobUrl?: string; size?: number };
}

function getFileName(path: string): string {
  return path.split('/').pop() || path;
}

function bytesToBlobUrl(base64: string, mime: string): string {
  try {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: mime || 'application/octet-stream' }));
  } catch {
    return '';
  }
}

export default function AgentPage() {
  const { user } = useAuth();
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [activeSession, setActiveSession] = useState<AgentSession | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [fileTree, setFileTree] = useState<TreeNode[]>([]);
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeFileIndex, setActiveFileIndex] = useState(-1);
  const [workspacePath, setWorkspacePath] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedModel, setSelectedModel] = useState('nvidia/nemotron-3-nano-30b-a3b');
  const [selectedProvider, setSelectedProvider] = useState('nvidia');
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [fileTreeLoading, setFileTreeLoading] = useState(false);

  // IDE state
  const [gitStatus, setGitStatus] = useState<Awaited<ReturnType<typeof ideApi.gitStatus>> | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [conflicts, setConflicts] = useState<Record<string, string>>({}); // path -> disk content
  const [gotoLine, setGotoLine] = useState<number | undefined>(undefined);
  const [gitDiff, setGitDiff] = useState<GitDiffPayload | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  const [injectedPrompt, setInjectedPrompt] = useState<{ text: string; nonce: number } | null>(null);
  const [autoSave, setAutoSave] = useState(true);

  useEffect(() => {
    try { setAutoSave(localStorage.getItem('sm-autosave') !== 'off'); } catch { /* ignore */ }
  }, []);
  const toggleAutoSave = useCallback(() => {
    setAutoSave((prev) => {
      const next = !prev;
      try { localStorage.setItem('sm-autosave', next ? 'on' : 'off'); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const workspacePathRef = useRef(workspacePath);
  workspacePathRef.current = workspacePath;

  useEffect(() => { loadSessions(); loadModels(); }, []);

  useEffect(() => {
    if (activeSession?.workspacePath && !workspacePath) {
      setWorkspacePath(activeSession.workspacePath);
    }
  }, [activeSession]);

  // ── Data loaders ────────────────────────────────────────────────────────
  async function loadSessions() {
    try {
      setLoading(true);
      const list = await agentApi.listSessions();
      setSessions(list);
      setActiveSession((prev) => prev ?? list[0] ?? null);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }

  async function loadModels() {
    try {
      const res = await nativeFetch(`${API_URL}/api/agent/models`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      const data = await res.json();
      setProviders(data.providers || []);
    } catch { /* ignore */ }
  }

  const loadFileTree = useCallback(async (root: string) => {
    if (!root) return;
    try {
      setFileTreeLoading(true);
      const tree = await ideApi.fileTree(root, 3);
      setFileTree(tree);
    } catch {
      setFileTree([]);
    } finally {
      setFileTreeLoading(false);
    }
  }, []);

  const loadGitStatus = useCallback(async (root: string) => {
    if (!root) return;
    try {
      setGitLoading(true);
      setGitStatus(await ideApi.gitStatus(root));
    } catch {
      setGitStatus(null);
    } finally {
      setGitLoading(false);
    }
  }, []);

  // Workspace switch → reload everything
  useEffect(() => {
    if (!workspacePath) return;
    loadFileTree(workspacePath);
    loadGitStatus(workspacePath);
  }, [workspacePath, loadFileTree, loadGitStatus]);

  // ── FS watcher: debounced tree/git refresh + external-change detection ──
  const openFilesRef = useRef(openFiles);
  openFilesRef.current = openFiles;
  const conflictsRef = useRef(conflicts);
  conflictsRef.current = conflicts;

  const checkExternalChanges = useCallback(async () => {
    const root = workspacePathRef.current;
    if (!root) return;
    const snapshot = openFilesRef.current;
    await Promise.all(snapshot.map(async (f) => {
      if (conflictsRef.current[f.path]) return; // already conflicted
      try {
        const disk = await ideApi.readFile(f.path);
        if (disk.binary) return;
        if (!f.modified && disk.content !== f.originalContent) {
          // Clean editor → auto-reload with new disk content
          setOpenFiles((prev) => prev.map((x) =>
            x.path === f.path ? { ...x, content: disk.content, originalContent: disk.content, modified: false } : x));
        } else if (f.modified && disk.content !== f.originalContent) {
          // Dirty editor whose baseline moved on disk → conflict
          setConflicts((prev) => ({ ...prev, [f.path]: disk.content }));
        }
      } catch {
        // File may have been deleted externally
        if (!f.modified) {
          setOpenFiles((prev) => prev.filter((x) => x.path !== f.path));
        }
      }
    }));
  }, []);

  useEffect(() => {
    if (!workspacePath) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        loadFileTree(workspacePathRef.current);
        loadGitStatus(workspacePathRef.current);
        checkExternalChanges();
      }, 400);
    };
    const unsubscribe = ideApi.subscribeFsEvents(workspacePath, schedule);
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [workspacePath, loadFileTree, loadGitStatus, checkExternalChanges]);

  // ── Sessions ────────────────────────────────────────────────────────────
  const handleNewSession = useCallback(async (agentId = 'build') => {
    try {
      const session = await agentApi.createSession(agentId, workspacePath || undefined);
      setSessions((prev) => [session, ...prev]);
      setActiveSession(session);
    } catch (err) { console.error('Failed to create session:', err); }
  }, [workspacePath]);

  const handleDeleteSession = useCallback(async (id: string) => {
    try {
      await agentApi.deleteSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (activeSession?.id === id) {
        const remaining = sessions.filter((s) => s.id !== id);
        setActiveSession(remaining[0] ?? null);
      }
    } catch { /* ignore */ }
  }, [activeSession, sessions]);

  const handleStatusChange = useCallback((running: boolean) => {
    setIsRunning(running);
    if (!running && activeSession) {
      agentApi.getSession(activeSession.id).then(setActiveSession).catch(() => {});
      loadSessions();
    }
  }, [activeSession]);

  // ── Editor operations ───────────────────────────────────────────────────
  const handleFileSelect = useCallback(async (path: string, line?: number) => {
    if (line !== undefined) {
      setGotoLine(undefined);
      setTimeout(() => setGotoLine(line), 60);
    }
    const existingIndex = openFiles.findIndex((f) => f.path === path);
    if (existingIndex >= 0) {
      setActiveFileIndex(existingIndex);
      setRecentFiles((prev) => [path, ...prev.filter((p) => p !== path)].slice(0, 8));
      return;
    }

    const kind = getFileViewerType(path);
    let content = '';
    let raw: OpenFile['raw'];

    try {
      if (isEditableViewer(kind) || kind === 'csv') {
        // Text-based: read as UTF-8 through the text endpoint
        const res = await ideApi.readFile(path);
        if (res.binary) {
          // Registry said text, disk disagrees — fall back safely
          const bin = await ideApi.readRawFile(path);
          raw = { blobUrl: bytesToBlobUrl(bin.base64, bin.mime), size: bin.size };
          if (bin.mime.startsWith('image/')) raw.dataUrl = `data:${bin.mime};base64,${bin.base64}`;
        } else {
          content = res.truncated
            ? `${res.content}\n\n% File truncated at 2 MB — edit via terminal for full content %`
            : res.content;
        }
      } else {
        // Binary-ish viewers (image / svg preview / pdf / binary)
        const res = await ideApi.readRawFile(path);
        raw = { blobUrl: bytesToBlobUrl(res.base64, res.mime), size: res.size };
        if (res.mime.startsWith('image/') || res.mime === 'image/svg+xml') {
          raw.dataUrl = `data:${res.mime};base64,${res.base64}`;
        }
      }
      if (kind === 'svg' && !content) {
        // SVG needs both source (editable) and dataUrl (preview)
        try {
          const txt = await ideApi.readFile(path);
          if (!txt.binary && !txt.truncated) content = txt.content;
        } catch { /* keep empty source */ }
      }
      const newIndex = openFiles.length;
      setOpenFiles((prev) => [...prev, { path, name: getFileName(path), content, originalContent: content, modified: false, kind, raw }]);
      setActiveFileIndex(newIndex);
      setRecentFiles((prev) => [path, ...prev.filter((p) => p !== path)].slice(0, 8));
    } catch (err) {
      console.error('Failed to read file:', err);
    }
  }, [openFiles]);

  const handleSaveFile = useCallback(async (path: string, content: string) => {
    try {
      await ideApi.writeFile(path, content);
      setOpenFiles((prev) => prev.map((f) =>
        f.path === path ? { ...f, originalContent: content, modified: false } : f));
      setConflicts((prev) => {
        if (!prev[path]) return prev;
        const next = { ...prev };
        delete next[path];
        return next;
      });
      loadGitStatus(workspacePathRef.current);
    } catch (err) { console.error('Save failed:', err); }
  }, [loadGitStatus]);

  const handleContentChange = useCallback((path: string, content: string) => {
    setOpenFiles((prev) => prev.map((f) =>
      f.path === path ? { ...f, content, modified: f.originalContent !== content } : f));
  }, []);

  const closeFile = useCallback((index: number) => {
    const file = openFiles[index];
    if (file?.modified && !window.confirm(`${file.name} has unsaved changes. Close anyway?`)) return;
    if (file?.raw?.blobUrl) {
      try { URL.revokeObjectURL(file.raw.blobUrl); } catch { /* ignore */ }
    }
    setOpenFiles((prev) => {
      const next = prev.filter((_, i) => i !== index);
      setActiveFileIndex((ai) => {
        if (ai >= next.length) return Math.max(0, next.length - 1);
        if (ai > index) return ai - 1;
        return ai;
      });
      return next;
    });
    setConflicts((prev) => {
      if (!file || !prev[file.path]) return prev;
      const next = { ...prev };
      delete next[file.path];
      return next;
    });
  }, [openFiles]);

  const handleConflictAction = useCallback(async (path: string, action: 'compare' | 'reload' | 'keep') => {
    if (action === 'compare') return; // handled inside EditorArea
    const disk = conflicts[path];
    if (action === 'reload' && disk !== undefined) {
      setOpenFiles((prev) => prev.map((f) =>
        f.path === path ? { ...f, content: disk, originalContent: disk, modified: false } : f));
    } else if (action === 'keep') {
      const local = openFiles.find((f) => f.path === path);
      if (local) {
        try {
          await ideApi.writeFile(path, local.content);
          setOpenFiles((prev) => prev.map((f) =>
            f.path === path ? { ...f, originalContent: local.content, modified: false } : f));
        } catch (err) { console.error('Keep-changes write failed:', err); }
      }
    }
    setConflicts((prev) => {
      const next = { ...prev };
      delete next[path];
      return next;
    });
    loadGitStatus(workspacePathRef.current);
  }, [conflicts, openFiles, loadGitStatus]);

  const handleOpenGitDiff = useCallback(async (relPath: string) => {
    const root = workspacePathRef.current;
    if (!root) return;
    try {
      const res = await ideApi.gitDiffFile(root, relPath);
      if (res.isBinary) return;
      setGitDiff({
        relPath,
        original: res.original,
        current: res.current,
      });
    } catch (err) { console.error('Git diff failed:', err); }
  }, []);

  // ── Derived state ───────────────────────────────────────────────────────
  const gitEntries = useMemo(() => {
    const m = new Map<string, GitStatusEntry>();
    for (const e of gitStatus?.entries ?? []) m.set(e.path, e);
    return m;
  }, [gitStatus]);

  const dirtyPaths = useMemo(
    () => new Set(openFiles.filter((f) => f.modified).map((f) => f.path)),
    [openFiles],
  );

  const breadcrumbs = useMemo(() => {
    const activeFile = openFiles[activeFileIndex];
    if (!activeFile) return [];
    const parts = activeFile.path.replace(workspacePath, '').split('/').filter(Boolean);
    return parts.map((part, i) => ({
      name: part,
      path: parts.slice(0, i + 1).join('/'),
    }));
  }, [activeFileIndex, openFiles, workspacePath]);

  // ⌘P quick open
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p' && !e.shiftKey) {
        e.preventDefault();
        setQuickOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Test hook: lets external harnesses open files programmatically
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__smOpenFile = (p: string, l?: number) => void handleFileSelect(p, l);
    (window as unknown as Record<string, unknown>).__smOpenDiff = (rel: string) => void handleOpenGitDiff(rel);
  }, [handleFileSelect, handleOpenGitDiff]);

  const handleProviderChange = useCallback((provider: string) => {
    setSelectedProvider(provider);
    const first = providers.find((p) => p.id === provider)?.models?.[0];
    if (first) setSelectedModel(first);
  }, [providers]);

  const currentModels = providers.find((p) => p.id === selectedProvider)?.models || [];

  // Empty state — no sessions yet
  if (!activeSession) {
    return (
      <div className="flex h-screen items-center justify-center workspace-bg">
        <div className="text-center space-y-4 max-w-sm">
          <div className="mx-auto h-12 w-12 rounded-xl glass-panel flex items-center justify-center">
            <Code2 className="h-6 w-6 text-ink-muted/50" />
          </div>
          <div>
            <h2 className="text-base font-medium text-foreground/80">Smoke Monkey Agent</h2>
            <p className="text-xs text-ink-muted/60 mt-1">Set a workspace and start building.</p>
          </div>

          <div className="mx-auto max-w-xs space-y-1.5">
            <div className="flex items-center gap-2 rounded-lg glass-panel px-3 py-2">
              <FolderDown className="h-3.5 w-3.5 text-ink-muted shrink-0" />
              <input value={workspacePath} onChange={(e) => setWorkspacePath(e.target.value)}
                placeholder="/path/to/your/project"
                className="flex-1 bg-transparent text-xs outline-none placeholder:text-ink-muted" />
              <button onClick={async () => {
                const folder = await openFolderPicker();
                if (folder) setWorkspacePath(folder);
              }} className="px-2 py-0.5 text-[10px] font-medium rounded glass-panel glass-hover text-foreground transition-colors">
                Browse
              </button>
            </div>
          </div>

          <div className="flex justify-center gap-2">
            <button onClick={() => handleNewSession('build')} disabled={loading}
              className="flex items-center gap-1 rounded-lg bg-primary px-3 py-2 text-xs text-primary-foreground hover:bg-primary-hover transition-colors">
              <Plus className="h-3 w-3" /> Build
            </button>
            <button onClick={() => handleNewSession('explore')} disabled={loading}
              className="flex items-center gap-1 rounded-lg glass-panel px-3 py-2 text-xs text-ink-muted glass-hover transition-colors">
              <Plus className="h-3 w-3" /> Explore
            </button>
            <button onClick={() => handleNewSession('plan')} disabled={loading}
              className="flex items-center gap-1 rounded-lg glass-panel px-3 py-2 text-xs text-ink-muted glass-hover transition-colors">
              <Plus className="h-3 w-3" /> Plan
            </button>
          </div>
        </div>
      </div>
    );
  }

  const activeFilePath = openFiles[activeFileIndex]?.path;
  const activeConflictPath = activeFilePath && conflicts[activeFilePath] ? activeFilePath : null;

  return (
    <>
      <AgentAppShell
        workspacePath={workspacePath}
        breadcrumbs={breadcrumbs}
        isAgentRunning={isRunning}
        gitChangeCount={gitStatus?.entries.length ?? 0}
        topBarActions={
          <>
            <div className="flex items-center gap-1 rounded glass-panel px-1.5 py-0.5">
              <Cpu className="h-3 w-3 text-ink-muted" />
              <select value={selectedProvider}
                onChange={(e) => handleProviderChange(e.target.value)}
                className="bg-transparent text-[10px] text-foreground outline-none cursor-pointer">
                {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              <span className="text-ink-muted/30 text-[10px]">/</span>
              <select value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)}
                className="bg-transparent text-[10px] text-foreground outline-none cursor-pointer max-w-[140px]">
                {currentModels.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            {isRunning && (
              <button onClick={() => agentApi.interrupt(activeSession.id).then(() => setIsRunning(false))}
                className="flex items-center gap-1 rounded bg-red-600/90 px-2 py-0.5 text-[10px] text-white hover:bg-red-700 transition-colors">
                <X className="h-2.5 w-2.5" /> Stop
              </button>
            )}
          </>
        }
        sidePanelContent={
          <SidePanelContent
            sessions={sessions}
            activeSession={activeSession}
            fileTree={fileTree}
            fileTreeLoading={fileTreeLoading}
            workspacePath={workspacePath}
            selectedModel={selectedModel}
            selectedProvider={selectedProvider}
            providers={providers}
            activeFile={activeFilePath}
            dirtyPaths={dirtyPaths}
            gitEntries={gitEntries}
            gitStatus={gitStatus}
            gitLoading={gitLoading}
            onSelectSession={(s) => { setActiveSession(s); setIsRunning(s.status === 'running'); }}
            onDeleteSession={handleDeleteSession}
            onCreateSession={handleNewSession}
            onFileSelect={handleFileSelect}
            onRefreshFileTree={() => { loadFileTree(workspacePath); loadGitStatus(workspacePath); }}
            onOpenFolder={async () => {
              const folder = await openFolderPicker();
              if (folder) setWorkspacePath(folder);
            }}
            onRefreshGit={() => loadGitStatus(workspacePath)}
            onSearchResultOpen={handleFileSelect}
            onOpenGitDiff={handleOpenGitDiff}
            onModelChange={setSelectedModel}
            onProviderChange={handleProviderChange}
          />
        }
        editorArea={
          <EditorArea
            openFiles={openFiles}
            activeFileIndex={activeFileIndex}
            workspacePath={workspacePath}
            onSelectTab={(i) => { setActiveFileIndex(i); setGitDiff(null); }}
            onCloseFile={closeFile}
            onSaveFile={handleSaveFile}
            onContentChange={handleContentChange}
            conflictPath={activeConflictPath}
            conflictDiskContent={activeConflictPath ? conflicts[activeConflictPath] : null}
            onConflictAction={handleConflictAction}
            gitDiff={gitDiff}
            onCloseGitDiff={() => setGitDiff(null)}
            gotoLine={gotoLine}
            recentFiles={recentFiles}
            onQuickOpen={() => setQuickOpen(true)}
            onAgentPrompt={(text) => setInjectedPrompt({ text, nonce: Date.now() })}
            autoSave={autoSave}
            onToggleAutoSave={toggleAutoSave}
          />
        }
        agentPanel={
          <AgentChat
            sessionId={activeSession.id}
            workspacePath={workspacePath}
            isRunning={isRunning}
            onStatusChange={handleStatusChange}
            onFileSelect={handleFileSelect}
            model={selectedModel}
            provider={selectedProvider}
            onModelChange={(p, m) => { setSelectedProvider(p); setSelectedModel(m); }}
            injectedPrompt={injectedPrompt}
            sessions={sessions}
            activeSessionId={activeSession.id}
            onSelectSession={(s) => { setActiveSession(s); setIsRunning(s.status === 'running'); }}
            onNewSession={() => handleNewSession('build')}
          />
        }
        bottomPanelContent={
          <TerminalView
            sessionId={activeSession.id}
            workspacePath={workspacePath}
            className="h-full"
          />
        }
      />
      <QuickOpen
        open={quickOpen}
        workspaceRoot={workspacePath}
        onClose={() => setQuickOpen(false)}
        onOpenFile={(p) => handleFileSelect(p)}
      />
    </>
  );
}
