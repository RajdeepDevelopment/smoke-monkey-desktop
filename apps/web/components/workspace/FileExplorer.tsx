'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  FilePlus2,
  FolderPlus,
  RefreshCw,
  Pencil,
  Trash2,
  Copy,
  ExternalLink,
  GitCompare,
  TerminalSquare,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { ideApi, GIT_STATUS_META, type TreeNode, type GitStatusEntry } from '../../lib/ide-api';
import { createWorkspaceClient, type WorkspaceClient } from '../../lib/workspace-client';
import { FileIcon } from './FileIcon';
import { useContextMenu } from './ContextMenu';

interface Row {
  entry: TreeNode;
  depth: number;
}

interface Props {
  entries: TreeNode[];
  workspaceRoot: string;
  selectedFile?: string;
  activeFile?: string;
  dirtyPaths?: Set<string>;
  gitEntries?: Map<string, GitStatusEntry>;
  onFileSelect: (path: string) => void;
  onOpenGitDiff?: (relPath: string) => void;
  onRefresh?: () => void;
  loading?: boolean;
  className?: string;
  /** Optional mode-aware client for Remote-SSH. Defaults to local. */
  client?: WorkspaceClient;
  /** External create trigger (explorer toolbar): bump `nonce` to open a root-level inline create row. */
  createSignal?: { nonce: number; type: 'file' | 'directory' } | null;
  /** External collapse trigger (explorer toolbar): bump `nonce` to collapse every directory. */
  collapseSignal?: { nonce: number } | null;
}

function sortEntries(list: TreeNode[]): TreeNode[] {
  return [...list].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function ancestorsOf(path: string, root: string): string[] {
  const rel = path.startsWith(root + '/') ? path.slice(root.length + 1) : path;
  const parts = rel.split('/').filter(Boolean);
  parts.pop();
  const out: string[] = [];
  let acc = root;
  for (const p of parts) {
    acc = `${acc}/${p}`;
    out.push(acc);
  }
  return out;
}

export const FileExplorer = memo(function FileExplorer({
  entries,
  workspaceRoot,
  selectedFile,
  activeFile,
  dirtyPaths,
  gitEntries,
  onFileSelect,
  onOpenGitDiff,
  onRefresh,
  loading,
  className,
  client: clientProp,
  createSignal,
  collapseSignal,
}: Props) {
  const client = clientProp ?? createWorkspaceClient('local');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [lazyChildren, setLazyChildren] = useState<Record<string, TreeNode[]>>({});
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [focusedIndex, setFocusedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  // Inline create/rename input state
  const [inputState, setInputState] = useState<
    | { mode: 'create'; parentDir: string; type: 'file' | 'directory' }
    | { mode: 'rename'; target: TreeNode }
    | null
  >(null);
  const { openMenu, contextMenu } = useContextMenu();

  // Explorer toolbar actions (VS Code-style header buttons).
  useEffect(() => {
    if (!createSignal) return;
    setInputState({ mode: 'create', parentDir: workspaceRoot, type: createSignal.type });
  }, [createSignal, workspaceRoot]);

  useEffect(() => {
    if (!collapseSignal) return;
    setExpanded(new Set());
  }, [collapseSignal]);

  // Auto-expand the first two levels on initial load
  const initialExpanded = useRef(false);
  useEffect(() => {
    if (initialExpanded.current || entries.length === 0) return;
    initialExpanded.current = true;
    setExpanded(() => {
      const next = new Set<string>();
      const walk = (list: TreeNode[], depth: number) => {
        for (const e of list) {
          if (e.type === 'directory' && depth < 2) {
            next.add(e.path);
            if (e.children?.length) walk(e.children, depth + 1);
          }
        }
      };
      walk(entries, 0);
      return next;
    });
  }, [entries]);

  // Reset lazy children when the tree is refreshed by the parent
  useEffect(() => {
    setLazyChildren({});
  }, [entries]);

  // Reveal the active file when it changes
  useEffect(() => {
    if (!activeFile || !workspaceRoot) return;
    const needed = ancestorsOf(activeFile, workspaceRoot).filter((p) => !expanded.has(p));
    if (needed.length > 0) {
      setExpanded((prev) => new Set([...prev, ...needed]));
    }
  }, [activeFile, workspaceRoot]); // eslint-disable-line react-hooks/exhaustive-deps

  const childrenOf = useCallback(
    (dir: TreeNode): TreeNode[] | undefined => {
      if (lazyChildren[dir.path]) return lazyChildren[dir.path];
      return dir.children;
    },
    [lazyChildren],
  );

  // Visible rows in tree order (directories already sort before files)
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const walk = (list: TreeNode[], depth: number) => {
      for (const entry of sortEntries(list)) {
        out.push({ entry, depth });
        if (entry.type === 'directory' && expanded.has(entry.path)) {
          const kids = childrenOf(entry);
          if (kids) walk(kids, depth + 1);
        }
      }
    };
    walk(entries, 0);
    return out;
  }, [entries, expanded, childrenOf]);

  useEffect(() => {
    if (focusedIndex >= rows.length) setFocusedIndex(Math.max(0, rows.length - 1));
  }, [rows.length, focusedIndex]);

  const toggleDir = useCallback(
    async (entry: TreeNode) => {
      const isOpen = expanded.has(entry.path);
      if (!isOpen && entry.children === undefined && !lazyChildren[entry.path]) {
        // Lazy-load deeper levels on first expand
        setLoadingDirs((prev) => new Set(prev).add(entry.path));
        try {
          const kids = await client.fileTree(entry.path, 1);
          setLazyChildren((prev) => ({ ...prev, [entry.path]: kids }));
        } catch { /* leave collapsed */ } finally {
          setLoadingDirs((prev) => {
            const next = new Set(prev);
            next.delete(entry.path);
            return next;
          });
        }
      }
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        return next;
      });
    },
    [expanded, lazyChildren, client],
  );

  const handleKeyDown = useCallback(
    (ev: React.KeyboardEvent) => {
      if (inputState) return;
      const row = rows[focusedIndex];
      switch (ev.key) {
        case 'ArrowDown':
          ev.preventDefault();
          setFocusedIndex((i) => Math.min(rows.length - 1, i + 1));
          break;
        case 'ArrowUp':
          ev.preventDefault();
          setFocusedIndex((i) => Math.max(0, i - 1));
          break;
        case 'ArrowRight':
          ev.preventDefault();
          if (row?.entry.type === 'directory' && !expanded.has(row.entry.path)) void toggleDir(row.entry);
          else if (row) setFocusedIndex((i) => Math.min(rows.length - 1, i + 1));
          break;
        case 'ArrowLeft':
          ev.preventDefault();
          if (row?.entry.type === 'directory' && expanded.has(row.entry.path)) void toggleDir(row.entry);
          else if (row) {
            const parentDir = row.entry.path.split('/').slice(0, -1).join('/');
            const idx = rows.findIndex((r) => r.entry.path === parentDir);
            if (idx >= 0) setFocusedIndex(idx);
          }
          break;
        case 'Enter':
          ev.preventDefault();
          if (!row) break;
          if (row.entry.type === 'directory') void toggleDir(row.entry);
          else onFileSelect(row.entry.path);
          break;
      }
    },
    [rows, focusedIndex, expanded, toggleDir, onFileSelect, inputState],
  );

  // ── Mutations ───────────────────────────────────────────────────────────

  const relOf = useCallback(
    (abs: string) => (workspaceRoot && abs.startsWith(workspaceRoot + '/') ? abs.slice(workspaceRoot.length + 1) : abs),
    [workspaceRoot],
  );

  const commitInput = useCallback(
    async (name: string) => {
      if (!inputState || !name.trim()) {
        setInputState(null);
        return;
      }
      try {
        if (inputState.mode === 'create') {
          await client.createEntry(`${inputState.parentDir}/${name.trim()}`, inputState.type);
        } else if (inputState.mode === 'rename') {
          const dir = inputState.target.path.split('/').slice(0, -1).join('/');
          await client.renameEntry(inputState.target.path, `${dir}/${name.trim()}`);
        }
        setInputState(null);
        onRefresh?.();
      } catch (err) {
        // Surface duplicate-name errors without losing the input
        if (String(err).toLowerCase().includes('exists')) return;
        setInputState(null);
      }
    },
    [inputState, onRefresh, client],
  );

  const deleteEntry = useCallback(
    async (target: TreeNode) => {
      if (!window.confirm(`Delete ${target.name}?`)) return;
      try {
        await client.deletePath(target.path);
        onRefresh?.();
      } catch { /* ignore */ }
    },
    [onRefresh, client],
  );

  const copyPath = useCallback((path: string) => {
    navigator.clipboard.writeText(path).catch(() => {});
  }, []);

  const fileMenuItems = useCallback(
    (entry: TreeNode): import('./ContextMenu').MenuItem[] => [
      { label: 'Open', icon: <FileIcon name={entry.name} />, onSelect: () => onFileSelect(entry.path) },
      ...(gitEntries?.has(relOf(entry.path)) && onOpenGitDiff
        ? [
            {
              label: 'Open Changes',
              icon: <GitCompare className="h-3 w-3" />,
              onSelect: () => onOpenGitDiff(relOf(entry.path)),
            },
          ]
        : []),
      { label: 'sep1', separator: true },
      { label: 'Rename…', icon: <Pencil className="h-3 w-3" />, onSelect: () => setInputState({ mode: 'rename', target: entry }) },
      { label: 'Delete', icon: <Trash2 className="h-3 w-3" />, danger: true, onSelect: () => void deleteEntry(entry) },
      { label: 'sep2', separator: true },
      { label: 'Copy Path', icon: <Copy className="h-3 w-3" />, onSelect: () => copyPath(entry.path) },
      { label: 'Copy Relative Path', onSelect: () => copyPath(relOf(entry.path)) },
      {
        label: 'Open in Terminal',
        icon: <TerminalSquare className="h-3 w-3" />,
        onSelect: () =>
          window.dispatchEvent(
            new CustomEvent('sm-open-terminal', {
              detail: { cwd: entry.type === 'directory' ? entry.path : entry.path.slice(0, entry.path.lastIndexOf('/')) },
            }),
          ),
      },
      { label: 'Reveal in Finder', icon: <ExternalLink className="h-3 w-3" />, onSelect: () => void client.revealInFinder(entry.path) },
    ],
    [gitEntries, onFileSelect, onOpenGitDiff, relOf, deleteEntry, copyPath],
  );

  const folderMenuItems = useCallback(
    (entry: TreeNode): import('./ContextMenu').MenuItem[] => [
      {
        label: 'New File…',
        icon: <FilePlus2 className="h-3 w-3" />,
        onSelect: () => {
          if (!expanded.has(entry.path)) void toggleDir(entry);
          setInputState({ mode: 'create', parentDir: entry.path, type: 'file' });
        },
      },
      {
        label: 'New Folder…',
        icon: <FolderPlus className="h-3 w-3" />,
        onSelect: () => {
          if (!expanded.has(entry.path)) void toggleDir(entry);
          setInputState({ mode: 'create', parentDir: entry.path, type: 'directory' });
        },
      },
      { label: 'sep1', separator: true },
      { label: 'Rename…', icon: <Pencil className="h-3 w-3" />, onSelect: () => setInputState({ mode: 'rename', target: entry }) },
      { label: 'Delete', icon: <Trash2 className="h-3 w-3" />, danger: true, onSelect: () => void deleteEntry(entry) },
      { label: 'sep2', separator: true },
      { label: 'Copy Path', icon: <Copy className="h-3 w-3" />, onSelect: () => copyPath(entry.path) },
      {
        label: 'Reveal in Finder',
        icon: <ExternalLink className="h-3 w-3" />,
        onSelect: () => void client.revealInFinder(entry.path),
      },
    ],
    [expanded, toggleDir, deleteEntry, copyPath],
  );

  const rootMenuItems = useCallback(
    (): import('./ContextMenu').MenuItem[] => [
      {
        label: 'New File…',
        icon: <FilePlus2 className="h-3 w-3" />,
        onSelect: () => setInputState({ mode: 'create', parentDir: workspaceRoot, type: 'file' }),
      },
      {
        label: 'New Folder…',
        icon: <FolderPlus className="h-3 w-3" />,
        onSelect: () => setInputState({ mode: 'create', parentDir: workspaceRoot, type: 'directory' }),
      },
      { label: 'sep', separator: true },
      { label: 'Refresh Explorer', icon: <RefreshCw className="h-3 w-3" />, onSelect: () => onRefresh?.() },
    ],
    [workspaceRoot, onRefresh],
  );

  // ── Render ──────────────────────────────────────────────────────────────

  const renderInputRow = (depth: number, key: string) => {
    if (!inputState) return null;
    return (
      <div key={key} className="flex items-center gap-1.5 py-0.5 pr-2" style={{ paddingLeft: depth * 12 + 22 }}>
      {inputState.mode === 'create' ? (
        <FileIcon name={inputState.type === 'file' ? 'placeholder.txt' : ''} />
      ) : (
        <span className="w-3.5 shrink-0" />
      )}
      <input
        autoFocus
        defaultValue={inputState.mode === 'rename' ? inputState.target.name : ''}
        placeholder={inputState.mode === 'create' ? (inputState.type === 'file' ? 'File name' : 'Folder name') : ''}
        onBlur={(e) => void commitInput(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commitInput(e.currentTarget.value);
          if (e.key === 'Escape') setInputState(null);
        }}
        className="h-5 w-full rounded-sm border border-primary/60 bg-surface-900 px-1.5 text-[11px] text-foreground outline-none"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
    );
  };

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onContextMenu={(e) => openMenu(e, rootMenuItems())}
      className={cn('outline-none select-none', className)}
    >
      {loading && entries.length === 0 ? (
        <div className="flex items-center justify-center p-4 text-xs text-ink-muted">Loading files…</div>
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center px-4 py-10 text-center">
          <p className="text-xs font-medium text-ink-secondary">No folder opened</p>
          <p className="mt-1 text-[10px] leading-relaxed text-ink-muted">Open a workspace to start coding.</p>
        </div>
      ) : (
        <>
          {rows.map((row, i) => {
            const { entry, depth } = row;
            const isDir = entry.type === 'directory';
            const isOpen = expanded.has(entry.path);
            const isSelected = entry.path === selectedFile;
            const isActive = entry.path === activeFile;
            const isDirty = dirtyPaths?.has(entry.path);
            const focused = i === focusedIndex;
            const gitMeta = gitEntries?.get(relOf(entry.path));

            return (
              <div key={entry.path} className="group/row relative">
                <button
                  onClick={() => {
                    setFocusedIndex(i);
                    if (isDir) void toggleDir(entry);
                    else onFileSelect(entry.path);
                  }}
                  onDoubleClick={() => !isDir && onFileSelect(entry.path)}
                  onContextMenu={(e) =>
                    openMenu(e, isDir ? folderMenuItems(entry) : fileMenuItems(entry))
                  }
                  title={entry.path}
                  className={cn(
                    'group flex h-[22px] w-full items-center gap-1 pr-7 text-left text-xs transition-colors',
                    focused && !isSelected && 'bg-white/[0.04]',
                    isActive
                      ? 'bg-primary-subtle text-foreground'
                      : isSelected
                        ? 'bg-white/[0.07] text-foreground'
                        : 'text-ink-secondary hover:bg-white/[0.03]',
                    gitMeta && !isActive && 'hover:brightness-110',
                  )}
                  style={{ paddingLeft: depth * 12 + 8 }}
                >
                  {isDir ? (
                    <ChevronRight
                      className={cn(
                        'h-3 w-3 shrink-0 text-ink-muted transition-transform',
                        isOpen && 'rotate-90',
                      )}
                    />
                  ) : (
                    <span className="w-3 shrink-0" />
                  )}
                  {isDir ? (
                    <FolderGlyph open={isOpen} />
                  ) : (
                    <FileIcon name={entry.name} />
                  )}
                  <span
                    className="min-w-0 flex-1 truncate"
                    style={gitMeta ? { color: GIT_STATUS_META[gitMeta.status].color } : undefined}
                  >
                    {entry.name}
                  </span>
                  {isDirty && !gitMeta && (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" title="Unsaved changes" />
                  )}
                  {gitMeta && (
                    <span
                      className="shrink-0 text-[9px] font-semibold opacity-80"
                      style={{ color: GIT_STATUS_META[gitMeta.status].color }}
                      title={GIT_STATUS_META[gitMeta.status].title}
                    >
                      {GIT_STATUS_META[gitMeta.status].label}
                    </span>
                  )}
                  {loadingDirs.has(entry.path) && (
                    <RefreshCw className="h-2.5 w-2.5 animate-spin text-ink-muted" />
                  )}
                </button>

                {/* VS Code-style hover quick actions: rename / delete */}
                <div className="absolute right-1 top-[1.5px] z-10 flex h-[19px] shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setInputState({ mode: 'rename', target: entry });
                    }}
                    className="flex h-4 w-4 items-center justify-center rounded-sm text-ink-muted hover:bg-white/10 hover:text-foreground"
                    title="Rename…"
                    aria-label={`Rename ${entry.name}`}
                  >
                    <Pencil className="h-2.5 w-2.5" />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteEntry(entry);
                    }}
                    className="flex h-4 w-4 items-center justify-center rounded-sm text-ink-muted hover:bg-red-500/20 hover:text-red-300"
                    title="Delete"
                    aria-label={`Delete ${entry.name}`}
                  >
                    <Trash2 className="h-2.5 w-2.5" />
                  </button>
                </div>

                {inputState &&
                  ((inputState.mode === 'rename' && inputState.target.path === entry.path) ||
                    (inputState.mode === 'create' &&
                      isOpen &&
                      inputState.parentDir === entry.path)) &&
                  renderInputRow(depth + (inputState.mode === 'create' ? 1 : 0), `${entry.path}-input`)}
              </div>
            );
          })}

          {/* Root-level create input */}
          {inputState?.mode === 'create' && inputState.parentDir === workspaceRoot &&
            renderInputRow(0, 'root-input')}
        </>
      )}
      {contextMenu}
    </div>
  );
});

function FolderGlyph({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="#7A94B8" aria-hidden>
      {open ? (
        <path d="M1.5 12.5v-8A1.5 1.5 0 0 1 3 3h3l1.5 1.5H13A1.5 1.5 0 0 1 14.5 6v1H4.2L2.6 12.5H1.5Zm1.6 0 1.6-5h9.8l-1.6 5a1 1 0 0 1-.96.72H4.06a1 1 0 0 1-.96-.72Z" />
      ) : (
        <path d="M1.5 12.5v-8A1.5 1.5 0 0 1 3 3h3l1.5 1.5H13A1.5 1.5 0 0 1 14.5 6v6.5h-13Z" />
      )}
    </svg>
  );
}
