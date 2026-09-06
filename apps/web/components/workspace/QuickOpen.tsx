'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ideApi } from '../../lib/ide-api';
import { FileIcon } from './FileIcon';
import { cn } from '../../lib/utils';

interface Props {
  open: boolean;
  workspaceRoot: string;
  recentFiles?: string[];
  onClose: () => void;
  onOpenFile: (path: string, line?: number) => void;
}

/**
 * VS Code-style Quick Open (⌘P). Fuzzy-filters a filename search of the
 * workspace; Enter/click opens the selected result.
 */
export function QuickOpen({ open, workspaceRoot, recentFiles, onClose, onOpenFile }: Props) {
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Load the file list once per workspace when opened
  useEffect(() => {
    if (!open || !workspaceRoot) return;
    setQuery('');
    setSelected(0);
    let cancelled = false;
    setLoading(true);
    ideApi
      .fileTree(workspaceRoot, 6)
      .catch(() => [])
      .then((tree) => {
        if (cancelled) return;
        const out: string[] = [];
        const walk = (nodes: typeof tree) => {
          for (const n of nodes ?? []) {
            if (n.type === 'file') out.push(n.path);
            else if (n.children?.length && out.length < 8000) walk(n.children);
          }
        };
        walk(tree);
        setFiles(out.sort());
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, workspaceRoot]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  const scored = useMemo(() => {
    if (!query.trim()) {
      // VS Code-style: recently-visited files on top, then the indexed list.
      const indexed = files.slice(0, 50);
      const recent: string[] = [];
      for (const p of recentFiles ?? []) {
        if (files.includes(p) && !recent.includes(p)) recent.push(p);
      }
      const rest = indexed.filter((p) => !recent.includes(p));
      return [...recent, ...rest].slice(0, 50).map((path) => ({ path, score: 0 }));
    }
    const q = query.toLowerCase().replace(/\s+/g, '');
    const results: { path: string; score: number }[] = [];
    for (const path of files) {
      const rel = path.startsWith(workspaceRoot + '/') ? path.slice(workspaceRoot.length + 1) : path;
      const lower = rel.toLowerCase();
      // Subsequence fuzzy match with bonus for consecutive + basename matches
      let score = 0;
      let qi = 0;
      let consecutive = 0;
      for (let i = 0; i < lower.length && qi < q.length; i++) {
        if (lower[i] === q[qi]) {
          consecutive++;
          score += 1 + consecutive + (i === 0 || '/-_.'.includes(lower[i - 1]) ? 2 : 0);
          qi++;
        } else {
          consecutive = 0;
        }
      }
      if (qi === q.length) {
        if (lower.includes(q)) score += 20;
        results.push({ path, score });
      }
    }
    return results.sort((a, b) => b.score - a.score).slice(0, 50);
  }, [files, query, workspaceRoot, recentFiles]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  if (!open || typeof document === 'undefined') return null;

  const commit = (path?: string) => {
    const target = path ?? scored[selected]?.path;
    if (target) onOpenFile(target);
    onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-[110] flex justify-center pt-[10vh]" onMouseDown={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative w-[560px] max-w-[90vw] h-fit overflow-hidden rounded-lg border border-border bg-popover shadow-card-lift animate-fade-in"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'Enter') commit();
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSelected((i) => Math.min(scored.length - 1, i + 1));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSelected((i) => Math.max(0, i - 1));
            }
          }}
          placeholder="Search files by name…"
          className="w-full border-b border-border/70 bg-transparent px-3.5 py-2.5 text-sm outline-none placeholder:text-ink-muted/50"
        />
        <div ref={listRef} className="max-h-[46vh] overflow-y-auto scrollbar-thin py-1">
          {loading ? (
            <div className="px-4 py-3 text-xs text-ink-muted">Indexing workspace…</div>
          ) : scored.length === 0 ? (
            <div className="px-4 py-3 text-xs text-ink-muted">No matching files</div>
          ) : (
            scored.map(({ path }, i) => {
              const name = path.split('/').pop() || path;
              const dir = path.slice(workspaceRoot.length + 1, -name.length - 1);
              return (
                <button
                  key={path}
                  data-index={i}
                  onMouseMove={() => setSelected(i)}
                  onClick={() => commit(path)}
                  className={cn(
                    'flex w-full items-center gap-2 px-2.5 py-1 text-left',
                    i === selected ? 'bg-primary-subtle' : 'hover:bg-white/[0.04]',
                  )}
                >
                  <FileIcon name={name} />
                  <span className="text-[12px] text-foreground">{name}</span>
                  {dir && <span className="ml-auto max-w-[55%] truncate text-[10px] text-ink-muted">{dir}</span>}
                </button>
              );
            })
          )}
        </div>
        <div className="glass-border-top flex items-center gap-3 px-3 py-1 text-[9.5px] text-ink-muted/70">
          <span>↑↓ navigate</span>
          <span>⏎ open</span>
          <span>esc dismiss</span>
          <span className="ml-auto">{scored.length} results</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
