'use client';

import { memo, useMemo, useState } from 'react';
import { Check, Copy, FileText, Globe, Zap } from 'lucide-react';
import type { CitationDto, WebSourceDto } from '@rag/contracts';
import { BrandIcon } from './BrandIcon';
import { CitationMarkdown } from './chat/CitationMarkdown';
import { GenerationStages, type StageItem } from './chat/GenerationStages';
import { cn } from '../lib/utils';

export interface BubbleMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: CitationDto[] | null;
  webSources?: WebSourceDto[] | null;
  confidence?: number | null;
  pending?: boolean;
  /** Transient explanation (e.g. "answered via the free OmniRoute fallback…"). */
  notice?: string | null;
}

interface MessageBubbleProps {
  message: BubbleMessage;
  stages?: StageItem[];
  /** Open the sources panel, optionally jumping to a specific citation. */
  onOpenSources?: (citations: CitationDto[], webSources: WebSourceDto[], highlight?: number) => void;
  /** Streams hover-highlight from the source cards back to the citation chip. */
  onHighlight?: (index: number | null) => void;
}

/** Hover/tap to copy. Rendered only for assistant messages. */
function CopyButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  if (!content) return null;
  return (
    <button
      type="button"
      aria-label="Copy response"
      onClick={() => {
        void navigator.clipboard.writeText(content).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        });
      }}
      className="flex h-7 w-7 items-center justify-center rounded-lg border border-surface-700 bg-surface-900/60 text-ink-muted opacity-0 transition-all hover:border-primary/40 hover:text-white group-hover:opacity-100"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

function Confidence({ confidence }: { confidence: number }) {
  if (!confidence) return null;
  const pct = Math.round(confidence * 100);
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center rounded-full px-2 text-[10px] font-semibold tabular-nums',
        pct >= 80
          ? 'bg-success/10 text-success'
          : pct >= 50
            ? 'bg-warning/10 text-warning'
            : 'bg-surface-800 text-ink-muted',
      )}
      title={`Response confidence ${pct}%`}
    >
      {pct}%
    </span>
  );
}

/**
 * A single chat bubble. Memoized with a shallow compare so token-by-token
 * streaming updates only re-render the bubble whose content changed — every
 * other message in the thread is skipped.
 */
export const MessageBubble = memo(function MessageBubble({
  message,
  stages,
  onOpenSources,
  onHighlight,
}: MessageBubbleProps) {
  const { role, content, citations, webSources, pending, confidence, notice } = message;
  const isUser = role === 'user';
  const knowledgeCount = (citations ?? []).filter((c) => c.text && c.text.trim().length > 0).length;
  const webCount = (webSources ?? []).filter((s) => s.url || s.content).length;
  const totalSources = knowledgeCount + webCount;

  // Merged source list in panel order (web first, then knowledge). Chip numbers
  // [n] map 1:1 to this list, so the nth item is the nth numbered source.
  const mergedSources = useMemo(() => {
    const web = webSources ?? [];
    const k = citations ?? [];
    return [...web.map((s) => ({ url: s.url || null })), ...k.map((c) => ({ url: null }))] as Array<
      { url?: string | null }
    >;
  }, [webSources, citations]);

  const openSources = (highlight?: number) => {
    const web = webSources ?? [];
    // [n] refers to the merged web-first ordering, so no offset is needed.
    onOpenSources?.(citations ?? [], web, highlight);
  };

  if (isUser) {
    return (
      <div className="flex w-full justify-end animate-mobile-bubble">
        <div className="flex max-w-[88%] flex-col items-end gap-1 sm:max-w-[75%]">
          <div className="rounded-2xl rounded-tr-md border border-primary/25 bg-primary px-3.5 py-2.5 text-sm leading-relaxed text-white shadow-lg shadow-primary/10 sm:px-4 sm:py-3">
            <div className="whitespace-pre-wrap break-words overflow-wrap-anywhere">{content}</div>
          </div>
          <span className="pr-1 text-[10px] text-ink-muted">You</span>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex w-full justify-start animate-mobile-bubble">
      <div className="flex w-full items-start gap-2.5 sm:gap-3">
        <div className="relative mt-0.5 shrink-0">
          <BrandIcon size={34} className="rounded-xl" />
          <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-bg bg-accent" />
        </div>
        <div className="min-w-0 flex-1 max-w-full overflow-hidden">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-xs font-semibold text-ink-primary">Smoke Monkey</span>
            {!pending && <Confidence confidence={confidence ?? 0} />}
            {message.id.startsWith('tmp-') && (
              <span className="text-[10px] text-ink-muted">streaming…</span>
            )}
          </div>

          {stages && stages.length > 0 && pending && <GenerationStages stages={stages} streaming />}

          <div className="relative rounded-2xl rounded-tl-md border border-surface-700/70 bg-surface-900/70 px-3.5 py-2.5 text-sm leading-relaxed text-ink-primary shadow-sm break-words overflow-wrap-anywhere min-w-0 sm:px-4 sm:py-3">
            <CitationMarkdown
              content={content}
              onCite={(i) => openSources(i)}
              sources={mergedSources}
            />
            {pending && <span className="ml-0.5 animate-pulse text-ink-muted">▍</span>}
          </div>

          {notice && (
            <div className="mt-1.5 flex items-start gap-1.5 rounded-lg border border-accent/25 bg-accent/10 px-2.5 py-1.5 text-[11px] leading-snug text-accent">
              <Zap className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{notice}</span>
            </div>
          )}

          <div className="mt-1.5 flex items-center gap-1.5">
            {totalSources > 0 && !pending && (
              <button
                type="button"
                onClick={() => openSources()}
                className="inline-flex items-center gap-1.5 rounded-full border border-surface-700 bg-surface-900/60 px-2.5 py-1 text-[11px] font-medium text-ink-secondary transition-colors hover:border-primary/40 hover:text-white"
              >
                {webCount > 0 && knowledgeCount > 0 ? (
                  <>
                    <Globe className="h-3 w-3 text-accent" />
                    {webCount} web · {knowledgeCount} knowledge
                  </>
                ) : webCount > 0 ? (
                  <>
                    <Globe className="h-3 w-3 text-accent" />
                    {webCount} web sources
                  </>
                ) : (
                  <>
                    <FileText className="h-3 w-3 text-primary" />
                    {knowledgeCount} sources
                  </>
                )}
              </button>
            )}
            <CopyButton content={content} />
          </div>
        </div>
      </div>
    </div>
  );
});
