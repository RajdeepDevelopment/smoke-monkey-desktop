'use client';

import { memo, useState } from 'react';
import { ChevronDown, FileText, Globe, Sparkles } from 'lucide-react';
import type { CitationDto, WebSourceDto } from '@rag/contracts';
import { cn, domainFromUrl } from '../../lib/utils';

export type SourceItem =
  | { type: 'web'; source: WebSourceDto }
  | { type: 'knowledge'; source: CitationDto };

function faviconSources(domain: string): string[] {
  const d = encodeURIComponent(domain);
  return [
    `https://icons.duckduckgo.com/ip3/${d}.ico`,
    `https://www.google.com/s2/favicons?domain=${d}&sz=64`,
  ];
}

function Favicon({ domain, type }: { domain: string; type: SourceItem['type'] }) {
  const [failed, setFailed] = useState(0);
  if (type === 'knowledge' || !domain) {
    return (
      <span
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold uppercase',
          type === 'knowledge' ? 'bg-primary/15 text-primary-hover' : 'bg-cyan-500/15 text-cyan-300',
        )}
      >
        {type === 'knowledge' ? <FileText className="h-3.5 w-3.5" /> : (domain[0] ?? 'w')}
      </span>
    );
  }
  const sources = faviconSources(domain);
  if (failed >= sources.length) {
    return (
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-cyan-500/15 text-[11px] font-bold uppercase text-cyan-300">
        {domain[0] ?? 'w'}
      </span>
    );
  }
  return (
    <img
      key={sources[failed]}
      src={sources[failed]}
      alt=""
      width={28}
      height={28}
      onError={() => setFailed((n) => n + 1)}
      className="h-7 w-7 shrink-0 rounded-lg bg-surface-800 object-contain p-1"
    />
  );
}

interface SourceCardProps {
  item: SourceItem;
  index: number;
  active: boolean;
  onHighlight: (index: number | null) => void;
}

/** Single source card: favicon, domain, title, snippet, relevance score. */
export const SourceCard = memo(function SourceCard({
  item,
  index,
  active,
  onHighlight,
}: SourceCardProps) {
  const [expanded, setExpanded] = useState(false);

  if (item.type === 'web') {
    const s = item.source;
    const domain = domainFromUrl(s.url);
    const score = Math.round(s.score * 100);
    return (
      <div
        id={`source-${index}`}
        onMouseEnter={() => onHighlight(index + 1)}
        onMouseLeave={() => onHighlight(null)}
        className={cn(
          'scroll-mt-2 rounded-xl border bg-surface-900 transition-all',
          active
            ? 'border-primary/50 ring-2 ring-primary/25'
            : 'border-surface-800 hover:border-surface-700',
        )}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-start gap-3 p-3 text-left"
        >
          <Favicon domain={domain} type="web" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[11px] text-ink-muted">
              <Globe className="h-3 w-3" />
              <span className="truncate">{domain}</span>
              <span className="ml-auto shrink-0 rounded-full bg-surface-800 px-1.5 py-0.5 text-[10px] font-medium text-ink-secondary">
                {score}% · [{index + 1}]
              </span>
            </div>
            <h4 className="mt-1 truncate text-sm font-medium text-ink-primary">{s.title}</h4>
            <p
              className={cn(
                'mt-1 text-xs leading-relaxed text-ink-secondary',
                !expanded && 'line-clamp-2',
              )}
            >
              {s.content}
            </p>
            <span className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-primary-hover">
              <ChevronDown className={cn('h-3 w-3 transition-transform', expanded && 'rotate-180')} />
              {expanded ? 'Collapse' : 'Expand'}
            </span>
          </div>
        </button>
      </div>
    );
  }

  const c = item.source;
  return (
    <div
      id={`source-${index}`}
      onMouseEnter={() => onHighlight(index + 1)}
      onMouseLeave={() => onHighlight(null)}
      className={cn(
        'scroll-mt-2 rounded-xl border bg-surface-900 transition-all',
        active ? 'border-primary/50 ring-2 ring-primary/25' : 'border-surface-800 hover:border-surface-700',
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-start gap-3 p-3 text-left"
      >
        <Favicon domain="" type="knowledge" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11px] text-ink-muted">
            <Sparkles className="h-3 w-3 text-primary" />
            <span className="truncate">Knowledge Base</span>
            <span className="ml-auto shrink-0 rounded-full bg-surface-800 px-1.5 py-0.5 text-[10px] font-medium text-ink-secondary">
              {c.score > 0 && c.score < 1 ? `${Math.round(c.score * 100)}%` : `${c.score}%`} · [{index + 1}]
            </span>
          </div>
          <h4 className="mt-1 truncate text-sm font-medium text-ink-primary">{c.documentName}</h4>
          {typeof c.page === 'number' && (
            <p className="mt-0.5 text-[11px] text-ink-muted">Page {c.page}</p>
          )}
          <p className={cn('mt-1 text-xs leading-relaxed text-ink-secondary', !expanded && 'line-clamp-2')}>
            {c.text}
          </p>
          <span className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-primary-hover">
            <ChevronDown className={cn('h-3 w-3 transition-transform', expanded && 'rotate-180')} />
            {expanded ? 'Collapse' : 'Expand'}
          </span>
        </div>
      </button>
    </div>
  );
});
