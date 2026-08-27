'use client';

import { useEffect, useMemo, useState } from 'react';
import { FileText, Globe, Search } from 'lucide-react';
import type { CitationDto, WebSourceDto } from '@rag/contracts';
import { cn } from '../../lib/utils';
import { SourceCard, type SourceItem } from './SourceCard';

interface SourcesPanelProps {
  webSources: WebSourceDto[];
  citations: CitationDto[];
  /** Citation index currently hovered from the message body, or null. */
  activeIndex: number | null;
  onHighlight: (index: number | null) => void;
  className?: string;
}

type Filter = 'all' | 'web' | 'knowledge';

/**
 * Ordered source list backing the citation chips: web sources first, then
 * knowledge citations. Desktop: right-side panel. Mobile: rendered inside a
 * bottom Sheet by the caller.
 */
export function SourcesPanel({
  webSources,
  citations,
  activeIndex,
  onHighlight,
  className,
}: SourcesPanelProps) {
  const [filter, setFilter] = useState<Filter>('all');

  const items = useMemo<SourceItem[]>(() => {
    const list: SourceItem[] = [];
    for (const s of webSources) list.push({ type: 'web', source: s });
    for (const c of citations) list.push({ type: 'knowledge', source: c });
    return list;
  }, [webSources, citations]);

  const visible = items.filter((it) => filter === 'all' || it.type === filter);
  const counts = {
    all: items.length,
    web: webSources.length,
    knowledge: citations.length,
  };

  useEffect(() => {
    if (activeIndex == null) return;
    const el = document.getElementById(`source-${activeIndex - 1}`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeIndex]);

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-1">
        <h3 className="text-sm font-semibold text-ink-primary">Sources</h3>
        <div className="flex items-center gap-1 rounded-lg bg-surface-850 p-0.5">
          {(['all', 'web', 'knowledge'] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                'rounded-md px-2 py-1 text-[11px] font-medium capitalize transition-colors',
                filter === f ? 'bg-surface-700 text-white' : 'text-ink-muted hover:text-ink-secondary',
              )}
            >
              {f}
              {counts[f] > 0 && <span className="ml-1 text-[10px] text-ink-muted">{counts[f]}</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 pb-4 scrollbar-thin">
        {visible.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-800">
              <Search className="h-4 w-4 text-ink-muted" />
            </div>
            <p className="text-xs text-ink-muted">No {filter === 'all' ? '' : filter + ' '}sources yet.</p>
          </div>
        )}
        {visible.map((item, i) => {
          const sourceIndex = items.findIndex((it) => it === item);
          return (
            <SourceCard
              key={`${item.type}-${sourceIndex}`}
              item={item}
              index={sourceIndex}
              active={activeIndex === sourceIndex + 1}
              onHighlight={onHighlight}
            />
          );
        })}
        {webSources.length === 0 && citations.length > 0 && (
          <p className="flex items-center gap-1.5 px-1 text-[11px] text-ink-muted">
            <Globe className="h-3 w-3" />
            Web search was not used for this response.
          </p>
        )}
        {citations.length === 0 && webSources.length > 0 && (
          <p className="flex items-center gap-1.5 px-1 text-[11px] text-ink-muted">
            <FileText className="h-3 w-3" />
            No knowledge base matches for this response.
          </p>
        )}
      </div>
    </div>
  );
}
