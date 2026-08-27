'use client';

import { memo } from 'react';
import { ExternalLink } from 'lucide-react';
import { Markdown } from '../Markdown';
import { cn } from '../../lib/utils';

interface CitationTextProps {
  children: string;
  onCite: (index: number) => void;
  sources?: Array<{ url?: string | null } | null | undefined>;
}

/**
 * Splits a text node on "[n]" citation markers and renders each as a small
 * interactive chip. The regex keeps capture groups so we can interleave the
 * plain text and the citations in order. When the nth source has a real URL
 * (web sources always do), the chip becomes a link that opens it in a new tab.
 */
function CitationText({ children, onCite, sources }: CitationTextProps) {
  const parts = children.split(/(\[\d+\])/g);
  return (
    <>
      {parts.map((part, i) => {
        const match = /^\[(\d+)\]$/.exec(part);
        if (match) {
          const index = Number(match[1]);
          const url = sources?.[index - 1]?.url;
          const chip = (
            <>
              {index}
              {url && <ExternalLink className="h-2.5 w-2.5" />}
            </>
          );
          const className = cn(
            'mx-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center gap-0.5 rounded px-1 align-middle text-[10px] font-semibold',
            'bg-primary/15 text-primary-hover transition-colors hover:bg-primary/30 hover:text-white',
          );
          if (url) {
            return (
              <a
                key={i}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => onCite(index)}
                className={className}
                aria-label={`Open source ${index}`}
                title={url}
              >
                {chip}
              </a>
            );
          }
          return (
            <button
              key={i}
              type="button"
              onClick={() => onCite(index)}
              className={className}
              aria-label={`Open citation ${index}`}
            >
              {chip}
            </button>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

interface CitationMarkdownProps {
  content: string;
  onCite: (index: number) => void;
  /** Merged source list (web first, then knowledge) used to resolve URLs. */
  sources?: Array<{ url?: string | null } | null | undefined>;
}

/** Markdown where "[n]" markers render as clickable citation chips/links. */
export const CitationMarkdown = memo(function CitationMarkdown({
  content,
  onCite,
  sources,
}: CitationMarkdownProps) {
  return (
    <Markdown
      content={content}
      components={{
        // Override text nodes: code spans/blocks are separate nodes so they
        // are not affected by this transform.
        text: ({ children }) => (
          <CitationText onCite={onCite} sources={sources}>
            {children as string}
          </CitationText>
        ),
      }}
    />
  );
});
