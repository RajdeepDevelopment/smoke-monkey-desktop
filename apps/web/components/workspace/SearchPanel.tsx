'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, Type, CaseSensitive, Loader2, FileSearch, TextSearch } from 'lucide-react';
import { cn } from '../../lib/utils';
import { ideApi, type ContentMatch } from '../../lib/ide-api';
import { FileIcon } from './FileIcon';

interface Props {
  workspaceRoot: string;
  onOpenResult: (path: string, line?: number) => void;
}

type Mode = 'files' | 'content';

export const SearchPanel = memo(function SearchPanel({ workspaceRoot, onOpenResult }: Props) {
  const [mode, setMode] = useState<Mode>('content');
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [include, setInclude] = useState('');
  const [fileResults, setFileResults] = useState<string[]>([]);
  const [contentResults, setContentResults] = useState<ContentMatch[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const runSearch = useCallback(
    async (q: string) => {
      // Never stack searches: the previous request is cancelled the moment a
      // new one starts, on both the client and the gateway.
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      if (!workspaceRoot || !q.trim()) {
        setFileResults([]);
        setContentResults([]);
        setSearched('');
        setSearching(false);
        return;
      }
      setSearching(true);
      try {
        if (mode === 'files') {
          const res = await ideApi.searchFiles(workspaceRoot, q, ac.signal);
          if (ac.signal.aborted) return;
          setFileResults(res.files);
          setContentResults([]);
          setTruncated(false);
        } else {
          const res = await ideApi.searchContent(workspaceRoot, q, {
            caseSensitive,
            include: include.trim() || undefined,
            signal: ac.signal,
          });
          if (ac.signal.aborted) return;
          setContentResults(res.matches);
          setFileResults([]);
          setTruncated(res.truncated);
        }
        setSearched(q);
      } catch (err) {
        if ((err as Error)?.name === 'AbortError' || ac.signal.aborted) return;
        /* ignore real errors */
      } finally {
        if (!ac.signal.aborted) setSearching(false);
      }
    },
    [workspaceRoot, mode, caseSensitive, include],
  );

  // Debounced auto-run
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void runSearch(query), 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, runSearch]);

  // Cancel any in-flight search when the panel unmounts
  useEffect(() => () => abortRef.current?.abort(), []);

  const grouped = useMemo(() => {
    const map = new Map<string, ContentMatch[]>();
    for (const m of contentResults) {
      if (!map.has(m.path)) map.set(m.path, []);
      map.get(m.path)!.push(m);
    }
    return [...map.entries()];
  }, [contentResults]);

  const highlight = (text: string) => {
    if (!searched) return text;
    try {
      const escaped = searched.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(${escaped})`, caseSensitive ? 'g' : 'gi');
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

  const totalMatches = contentResults.length;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Input */}
      <div className="space-y-1.5 px-2 pb-2 pt-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-ink-muted" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={mode === 'files' ? 'Search files…' : 'Search in files…'}
            className="w-full rounded-md border border-border/70 bg-surface-900 py-1 pl-7 pr-7 text-xs outline-none transition-colors placeholder:text-ink-muted/50 focus:border-primary/50"
            data-sm-search-input
          />
          {(query || searching) && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-ink-muted hover:text-foreground"
            >
              {searching ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
            </button>
          )}
        </div>

        <div className="flex items-center gap-1">
          {/* Mode toggle */}
          <div className="flex overflow-hidden rounded border border-border/70">
            <button
              onClick={() => setMode('files')}
              title="Search by filename"
              className={cn(
                'flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium transition-colors',
                mode === 'files' ? 'bg-primary-subtle text-foreground' : 'text-ink-muted hover:text-foreground',
              )}
            >
              <FileSearch className="h-3 w-3" /> Files
            </button>
            <button
              onClick={() => setMode('content')}
              title="Search in contents"
              className={cn(
                'flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium transition-colors',
                mode === 'content' ? 'bg-primary-subtle text-foreground' : 'text-ink-muted hover:text-foreground',
              )}
            >
              <TextSearch className="h-3 w-3" /> Contents
            </button>
          </div>

          {mode === 'content' && (
            <>
              <button
                onClick={() => setCaseSensitive((v) => !v)}
                title="Match case"
                className={cn(
                  'flex items-center rounded border px-1 py-0.5 transition-colors',
                  caseSensitive
                    ? 'border-primary/60 bg-primary-subtle text-foreground'
                    : 'border-transparent text-ink-muted hover:text-foreground',
                )}
              >
                <CaseSensitive className="h-3.5 w-3.5" />
              </button>
              <input
                value={include}
                onChange={(e) => setInclude(e.target.value)}
                placeholder="*.ts"
                title="Filter by glob"
                className="min-w-0 flex-1 rounded border border-border/70 bg-surface-900 px-1.5 py-0.5 text-[10px] outline-none placeholder:text-ink-muted/40 focus:border-primary/50"
              />
            </>
          )}
        </div>
      </div>

      {/* Results summary */}
      {searched && (
        <div className="glass-border-bottom px-3 py-1 text-[10px] text-ink-muted">
          {mode === 'files'
            ? `${fileResults.length} file${fileResults.length === 1 ? '' : 's'}`
            : `${totalMatches} match${totalMatches === 1 ? '' : 'es'}${truncated ? ' (truncated)' : ''}`}
          {' '}in <Type className="mx-0.5 inline h-2.5 w-2.5" />
          {`"${searched}"`}
        </div>
      )}

      {/* Results */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {!workspaceRoot ? (
          <EmptyState title="No workspace" hint="Select a project folder to search." />
        ) : !query ? (
          <EmptyState title="Search your workspace" hint="Find filenames or code across the project." />
        ) : mode === 'files' ? (
          fileResults.map((path) => {
            const name = path.split('/').pop() || path;
            const dir = path.slice(workspaceRoot.length + 1, -name.length - 1);
            return (
              <button
                key={path}
                onClick={() => onOpenResult(path)}
                className="group flex h-[24px] w-full items-center gap-1.5 px-2 text-left transition-colors hover:bg-white/[0.04]"
              >
                <FileIcon name={name} />
                <span className="truncate text-[11.5px] text-foreground">{highlight(name)}</span>
                {dir && <span className="shrink-0 truncate text-[9.5px] text-ink-muted">{dir}</span>}
              </button>
            );
          })
        ) : (
          grouped.map(([path, matches]) => {
            const name = path.split('/').pop() || path;
            const relDir = path.startsWith(workspaceRoot + '/')
              ? path.slice(workspaceRoot.length + 1, path.length - name.length - 1)
              : '';
            return (
              <div key={path} className="pb-1">
                <div className="flex items-center gap-1.5 px-2 py-1">
                  <FileIcon name={name} />
                  <span className="truncate text-[11px] font-medium text-foreground">{name}</span>
                  {relDir && <span className="shrink-0 truncate text-[9.5px] text-ink-muted">{relDir}</span>}
                  <span className="ml-auto shrink-0 rounded-full bg-surface-800 px-1.5 text-[9px] text-ink-muted">
                    {matches.length}
                  </span>
                </div>
                {matches.map((m, i) => (
                  <button
                    key={`${m.line}-${i}`}
                    onClick={() => onOpenResult(path, m.line)}
                    className="flex w-full items-baseline gap-2 py-0.5 pl-8 pr-2 text-left transition-colors hover:bg-white/[0.04]"
                  >
                    <span className="w-8 shrink-0 text-right font-mono text-[9.5px] text-ink-muted">{m.line}</span>
                    <span className="truncate font-mono text-[10.5px] text-ink-secondary">{highlight(m.text.trim())}</span>
                  </button>
                ))}
              </div>
            );
          })
        )}

        {query && searched === query && !searching &&
          ((mode === 'files' && fileResults.length === 0) ||
            (mode === 'content' && contentResults.length === 0)) && (
            <div className="px-4 pt-6 text-center">
              <p className="text-[11px] text-ink-secondary">No results found</p>
              <p className="mt-1 text-[10px] text-ink-muted">Try a different query or adjust filters.</p>
            </div>
          )}
      </div>
    </div>
  );
});

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-10 text-center">
      <p className="text-xs font-medium text-ink-secondary">{title}</p>
      <p className="mt-1 text-[10px] leading-relaxed text-ink-muted">{hint}</p>
    </div>
  );
}
