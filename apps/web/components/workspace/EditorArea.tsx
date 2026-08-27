'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  X,
  SplitSquareHorizontal,
  FileCode2,
  FolderOpen,
  Search as SearchIcon,
  Bug,
  Sparkles,
  FlaskConical,
  RefreshCw,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { useWorkspace } from '../../hooks/useWorkspace';
import { FileIcon } from './FileIcon';
import type { FileViewerType } from '../../lib/file-types';
import { isEditableViewer } from '../../lib/file-types';
import { ImageViewer } from './viewers/ImageViewer';
import { MarkdownPreview } from './viewers/MarkdownPreview';
import { PdfViewer } from './viewers/PdfViewer';
import { CsvViewer } from './viewers/CsvViewer';
import { BinaryViewer } from './viewers/BinaryViewer';
import { SvgViewer } from './viewers/SvgViewer';

const MonacoCodeEditor = dynamic(
  () => import('./MonacoCodeEditor').then((m) => ({ default: m.MonacoCodeEditor })),
  { ssr: false, loading: () => <div className="flex-1 bg-[#080C12]" /> },
);

const GitDiffView = dynamic(
  () => import('./GitDiffView').then((m) => ({ default: m.GitDiffView })),
  { ssr: false, loading: () => <div className="flex-1 bg-[#080C12]" /> },
);

interface OpenFile {
  path: string;
  name: string;
  content: string;
  originalContent: string;
  modified: boolean;
  kind?: FileViewerType;
  raw?: { dataUrl?: string; blobUrl?: string; size?: number };
}

export interface GitDiffPayload {
  relPath: string;
  original: string;
  current: string;
}

interface EditorAreaProps {
  openFiles: OpenFile[];
  activeFileIndex: number;
  workspacePath: string;
  onSelectTab: (index: number) => void;
  onCloseFile: (index: number) => void;
  onSaveFile: (path: string, content: string) => void;
  onContentChange: (path: string, content: string) => void;
  conflictPath?: string | null;
  conflictDiskContent?: string | null;
  onConflictAction?: (path: string, action: 'compare' | 'reload' | 'keep') => void;
  gitDiff?: GitDiffPayload | null;
  onCloseGitDiff?: () => void;
  gotoLine?: number | undefined;
  recentFiles?: string[];
  onQuickOpen?: () => void;
  onAgentPrompt?: (prompt: string) => void;
  autoSave?: boolean;
  onToggleAutoSave?: () => void;
}

type TabMode = 'editor' | 'diff' | 'preview';

export const EditorArea = memo(function EditorArea({
  openFiles,
  activeFileIndex,
  workspacePath,
  onSelectTab,
  onCloseFile,
  onSaveFile,
  onContentChange,
  conflictPath,
  conflictDiskContent,
  onConflictAction,
  gitDiff,
  onCloseGitDiff,
  gotoLine,
  recentFiles,
  onQuickOpen,
  onAgentPrompt,
  autoSave,
  onToggleAutoSave,
}: EditorAreaProps) {
  const [modeByPath, setModeByPath] = useState<Record<string, TabMode>>({});
  const [comparingConflict, setComparingConflict] = useState(false);
  const activeFile = openFiles[activeFileIndex];

  const kindOf = (f: OpenFile | undefined): FileViewerType => f?.kind ?? 'code';
  const effectiveMode = (f: OpenFile): TabMode => {
    if (modeByPath[f.path]) return modeByPath[f.path];
    const k = kindOf(f);
    return k === 'markdown' || k === 'svg' ? 'preview' : 'editor';
  };

  // Auto-save: debounced write for dirty editable files
  const saveRef = useRef({ onSaveFile });
  saveRef.current = { onSaveFile };
  useEffect(() => {
    if (!autoSave) return;
    const dirty = openFiles.filter((f) => f.modified && isEditableViewer(kindOf(f)));
    if (dirty.length === 0) return;
    const timer = setTimeout(() => {
      for (const f of dirty) saveRef.current.onSaveFile(f.path, f.content);
    }, 800);
    return () => clearTimeout(timer);
  }, [openFiles, autoSave]);

  // Global shortcuts: ⌘S save, ⌘W close tab
  const handlersRef = useRef({ onSaveFile, openFiles, activeFileIndex, onCloseFile });
  handlersRef.current = { onSaveFile, openFiles, activeFileIndex, onCloseFile };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const h = handlersRef.current;
      if (e.key === 's') {
        e.preventDefault();
        const f = h.openFiles[h.activeFileIndex];
        if (f && f.modified) h.onSaveFile(f.path, f.content);
      } else if (e.key === 'w') {
        e.preventDefault();
        if (h.activeFileIndex >= 0) h.onCloseFile(h.activeFileIndex);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const setMode = useCallback(
    (path: string, m: TabMode) =>
      setModeByPath((prev) => ({ ...prev, [path]: prev[path] === m ? 'editor' : m })),
    [],
  );

  const showConflictBanner = conflictPath && conflictPath === activeFile?.path;

  /** Kind-aware content renderer: Monaco only for editable text/code. */
  const renderActiveFile = (file: OpenFile) => {
    const kind = kindOf(file);
    const mode = effectiveMode(file);

    if (mode === 'diff' && isEditableViewer(kind)) {
      return (
        <GitDiffView
          original={file.originalContent}
          modified={file.content}
          filePath={`${file.path} — unsaved`}
          className="h-full"
        />
      );
    }

    switch (kind) {
      case 'markdown':
        return mode === 'editor' ? (
          <MonacoCodeEditor
            filePath={file.path}
            content={file.content}
            readOnly={false}
            gotoLine={gotoLine}
            onSave={onSaveFile}
            onContentChange={onContentChange}
            className="h-full"
          />
        ) : (
          <MarkdownPreview content={file.content} />
        );
      case 'svg':
        return (
          <SvgViewer
            path={file.path}
            name={file.name}
            content={file.content}
            dataUrl={file.raw?.dataUrl ?? ''}
            size={file.raw?.size}
            onSave={onSaveFile}
            onContentChange={onContentChange}
          />
        );
      case 'image':
        return file.raw?.dataUrl
          ? <ImageViewer name={file.name} dataUrl={file.raw.dataUrl} size={file.raw.size} />
          : <BinaryViewer path={file.path} name={file.name} size={file.raw?.size} />;
      case 'pdf':
        return file.raw?.blobUrl
          ? <PdfViewer name={file.name} blobUrl={file.raw.blobUrl} size={file.raw.size} />
          : <BinaryViewer path={file.path} name={file.name} size={file.raw?.size} />;
      case 'csv':
        return <CsvViewer name={file.name} content={file.content} size={file.raw?.size} />;
      case 'binary':
        return <BinaryViewer path={file.path} name={file.name} size={file.raw?.size} />;
      default:
        return (
          <MonacoCodeEditor
            filePath={file.path}
            content={file.content}
            readOnly={false}
            gotoLine={gotoLine}
            onSave={onSaveFile}
            onContentChange={onContentChange}
            className="h-full"
          />
        );
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ── Tab strip ─────────────────────────────────────────────── */}
      <div className="glass-border-bottom flex h-9 shrink-0 items-stretch">
        <div className="scrollbar-thin flex min-w-0 flex-1 items-stretch overflow-x-auto">
          {openFiles.map((file, i) => {
            const isActive = i === activeFileIndex;
            return (
              <div
                key={file.path}
                onClick={() => onSelectTab(i)}
                onMouseDown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    onCloseFile(i);
                  }
                }}
                title={file.path}
                className={cn(
                  'group relative flex h-full min-w-[140px] max-w-[240px] cursor-pointer items-center gap-1.5 border-r border-border/50 px-3 transition-colors',
                  isActive
                    ? 'bg-[#0D131C] text-foreground'
                    : 'text-ink-muted hover:bg-white/[0.03] hover:text-ink-secondary',
                )}
              >
                {/* Active indicator */}
                <span
                  className={cn(
                    'absolute left-0 right-0 top-0 h-[1.5px] bg-primary transition-opacity',
                    isActive ? 'opacity-100' : 'opacity-0',
                  )}
                />
                <FileIcon name={file.name} />
                <span className="min-w-0 flex-1 truncate text-[11.5px]">{file.name}</span>
                {file.modified ? (
                  <span className="h-2 w-2 shrink-0 rounded-full bg-warning/90" title="Unsaved changes" />
                ) : (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseFile(i);
                    }}
                    className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-white/10 group-hover:opacity-100"
                    title="Close"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Right actions */}
        <div className="flex shrink-0 items-center gap-0.5 px-2">
          {onToggleAutoSave && (
            <button
              onClick={onToggleAutoSave}
              title={autoSave ? 'Auto Save is on — edits are written automatically. Click to disable.' : 'Auto Save is off — use ⌘S to save. Click to enable.'}
              className={cn(
                'mr-1 flex items-center gap-1 rounded px-1.5 py-1 text-[10px] transition-colors hover:bg-white/[0.06]',
                autoSave ? 'text-green-400/90' : 'text-ink-muted hover:text-foreground',
              )}
            >
              Auto Save: {autoSave ? 'On' : 'Off'}
            </button>
          )}
          {activeFile && kindOf(activeFile) === 'markdown' && (
            <>
              <button
                onClick={() => setModeByPath((prev) => ({ ...prev, [activeFile.path]: 'editor' }))}
                className={cn(
                  'rounded px-1.5 py-1 text-[10px] transition-colors',
                  effectiveMode(activeFile) === 'editor'
                    ? 'bg-primary-subtle text-foreground'
                    : 'text-ink-muted hover:bg-white/[0.06] hover:text-foreground',
                )}
                title="Show source"
              >
                Code
              </button>
              <button
                onClick={() => setModeByPath((prev) => ({ ...prev, [activeFile.path]: 'preview' }))}
                className={cn(
                  'rounded px-1.5 py-1 text-[10px] transition-colors',
                  effectiveMode(activeFile) !== 'editor'
                    ? 'bg-primary-subtle text-foreground'
                    : 'text-ink-muted hover:bg-white/[0.06] hover:text-foreground',
                )}
                title="Show preview"
              >
                Preview
              </button>
            </>
          )}
          {activeFile && isEditableViewer(kindOf(activeFile)) && kindOf(activeFile) !== 'markdown' && (
            <>
              <button
                onClick={() => setMode(activeFile.path, 'editor')}
                className={cn(
                  'rounded p-1 transition-colors',
                  (modeByPath[activeFile.path] ?? 'editor') === 'editor'
                    ? 'bg-primary-subtle text-foreground'
                    : 'text-ink-muted hover:text-foreground',
                )}
                title="Show editor"
              >
                <FileCode2 className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => setMode(activeFile.path, 'diff')}
                className={cn(
                  'rounded p-1 transition-colors',
                  modeByPath[activeFile.path] === 'diff'
                    ? 'bg-primary-subtle text-foreground'
                    : 'text-ink-muted hover:text-foreground',
                )}
                title="Compare unsaved changes"
              >
                <SplitSquareHorizontal className="h-3.5 w-3.5" />
              </button>
            </>
          )}
          {gitDiff && (
            <button
              onClick={() => onCloseGitDiff?.()}
              className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-ink-muted transition-colors hover:bg-white/[0.06] hover:text-foreground"
              title="Close diff"
            >
              <X className="h-3 w-3" /> Close diff
            </button>
          )}
        </div>
      </div>

      {/* ── External change conflict banner ──────────────────────── */}
      {showConflictBanner && (
        <div className="glass-border-bottom flex shrink-0 items-center gap-2 bg-warning-subtle px-3 py-1.5">
          <RefreshCw className="h-3.5 w-3.5 shrink-0 text-warning" />
          <span className="min-w-0 flex-1 truncate text-[11px] text-ink-secondary">
            <b className="text-foreground">{activeFile?.name}</b> was changed outside the editor.
          </span>
          <button
            onClick={() => setComparingConflict(true)}
            className="rounded glass-panel px-2 py-0.5 text-[10px] text-ink-secondary transition-colors hover:text-foreground"
          >
            Compare
          </button>
          <button
            onClick={() => {
              setComparingConflict(false);
              onConflictAction?.(conflictPath!, 'reload');
            }}
            className="rounded bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
          >
            Reload
          </button>
          <button
            onClick={() => {
              setComparingConflict(false);
              onConflictAction?.(conflictPath!, 'keep');
            }}
            className="rounded glass-panel px-2 py-0.5 text-[10px] text-ink-secondary transition-colors hover:text-foreground"
          >
            Keep Changes
          </button>
        </div>
      )}

      {/* ── Content ──────────────────────────────────────────────── */}
      <div className="min-h-0 flex-1 overflow-hidden bg-[#080C12]">
        {gitDiff ? (
          <GitDiffView
            original={gitDiff.original}
            modified={gitDiff.current}
            filePath={gitDiff.relPath}
            className="h-full"
          />
        ) : comparingConflict && conflictPath ? (
          <GitDiffView
            original={conflictDiskContent ?? openFiles.find((f) => f.path === conflictPath)?.originalContent ?? ''}
            modified={openFiles.find((f) => f.path === conflictPath)?.content ?? ''}
            filePath={`${conflictPath.split('/').pop()} — disk vs your changes`}
            className="h-full"
          />
        ) : activeFile ? (
          renderActiveFile(activeFile)
        ) : (
          <WelcomePane
            workspacePath={workspacePath}
            recentFiles={recentFiles}
            onQuickOpen={onQuickOpen}
            onOpenRecent={(p) => {
              const idx = openFiles.findIndex((f) => f.path === p);
              if (idx >= 0) onSelectTab(idx);
            }}
            onAgentPrompt={onAgentPrompt}
          />
        )}
      </div>
    </div>
  );
});

/* ── Welcome pane ─────────────────────────────────────────────────── */

function WelcomePane({
  workspacePath,
  recentFiles,
  onQuickOpen,
  onOpenRecent,
  onAgentPrompt,
}: {
  workspacePath: string;
  recentFiles?: string[];
  onQuickOpen?: () => void;
  onOpenRecent?: (path: string) => void;
  onAgentPrompt?: (prompt: string) => void;
}) {
  const suggestions = useMemo(
    () => [
      { icon: SearchIcon, label: 'Explore codebase', prompt: 'Explore this project structure and summarize what it does.' },
      { icon: Bug, label: 'Find and fix bugs', prompt: 'Find and fix bugs in this project.' },
      { icon: Sparkles, label: 'Add a feature', prompt: 'Add a new feature to this project.' },
      { icon: FlaskConical, label: 'Run tests', prompt: 'Run the tests and report failures.' },
    ],
    [],
  );

  return (
    <div className="flex h-full items-start justify-center overflow-y-auto scrollbar-thin">
      <div className="mt-[9vh] w-full max-w-xl px-8">
        {/* Brand */}
        <div className="mb-6 text-center">
          <p className="text-[11px] font-semibold uppercase tracking-[0.35em] text-primary-hover">Smoke Monkey</p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-foreground">
            Start building with your codebase
          </h1>
        </div>

        {/* Quick open */}
        <button
          onClick={onQuickOpen}
          className="group mx-auto mb-6 flex w-full items-center gap-2.5 rounded-lg border border-border/70 bg-surface-900/70 px-4 py-2.5 text-left transition-all hover:border-primary/40 hover:bg-surface-850"
        >
          <SearchIcon className="h-4 w-4 text-ink-muted" />
          <span className="flex-1 text-sm text-ink-muted">Ask Smoke Monkey or search files…</span>
          <kbd className="rounded glass-panel px-1.5 py-0.5 text-[10px] text-ink-muted">⌘P</kbd>
        </button>

        {/* Suggested actions */}
        <div className="mb-7 grid grid-cols-2 gap-2">
          {suggestions.map(({ icon: Icon, label, prompt }) => (
            <button
              key={label}
              onClick={() => onAgentPrompt?.(prompt)}
              className="flex items-center gap-2 rounded-lg border border-border/50 bg-surface-900/50 px-3 py-2 text-left transition-all hover:border-primary/30 hover:bg-surface-900"
            >
              <Icon className="h-3.5 w-3.5 text-primary-hover" />
              <span className="text-[12px] text-ink-secondary">{label}</span>
            </button>
          ))}
        </div>

        <div className="space-y-5">
          {/* Recent files */}
          {recentFiles && recentFiles.length > 0 && (
            <section>
              <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">Recent files</h3>
              <div className="space-y-px">
                {recentFiles.slice(0, 5).map((p) => {
                  const name = p.split('/').pop() || p;
                  return (
                    <button
                      key={p}
                      onClick={() => onOpenRecent?.(p)}
                      className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-white/[0.04]"
                    >
                      <FileIcon name={name} />
                      <span className="text-[12px] text-ink-secondary">{name}</span>
                      <span className="truncate text-[10px] text-ink-muted/70">
                        {p.startsWith(workspacePath + '/') ? p.slice(workspacePath.length + 1) : p}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* Workspace info */}
          <section>
            <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">Workspace</h3>
            {workspacePath ? (
              <div className="flex items-center gap-2 rounded px-1.5 py-1">
                <FolderOpen className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
                <span className="truncate font-mono text-[11px] text-ink-secondary">{workspacePath}</span>
              </div>
            ) : (
              <p className="px-1.5 text-[11px] text-ink-muted">No folder opened</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
