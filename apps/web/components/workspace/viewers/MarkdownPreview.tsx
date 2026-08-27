'use client';

import { memo, useMemo, useState, useEffect, useId } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';

/** Rendered markdown preview.
 *  - GFM: tables, task lists, strikethrough, autolinks
 *  - Inline HTML allowed but sanitized through rehype-sanitize (no scripts)
 *  - ```mermaid blocks render as diagrams via the lazy-loaded mermaid lib */

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    // keep language-* classes on code blocks for highlighters / mermaid
    code: [...(defaultSchema.attributes?.code ?? []), 'className'],
    span: [...(defaultSchema.attributes?.span ?? []), 'className'],
    div: [...(defaultSchema.attributes?.div ?? []), 'className'],
  },
};

function MermaidBlock({ chart }: { chart: string }) {
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const rawId = useId();
  const id = `mmd-${rawId.replace(/[^a-zA-Z0-9]/g, '')}`;

  useEffect(() => {
    let alive = true;
    setError('');
    setSvg('');
    if (!chart.trim()) return;
    (async () => {
      try {
        // Isolated rendering: parse-first + contained render target so mermaid
        // never appends error diagnostics to the page body.
        const { renderMermaidSafely } = await import('../../../lib/mermaid');
        const out = await renderMermaidSafely(id, chart);
        if (alive) setSvg(out);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { alive = false; };
  }, [chart, id]);

  if (error || !svg) {
    return (
      <div className="my-3 overflow-x-auto rounded-lg border border-border/50 bg-surface-900 p-3">
        <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-ink-muted">
          {error ? 'Mermaid diagram — invalid syntax' : 'Mermaid diagram'}
        </p>
        <pre className="font-mono text-[12px] text-ink-secondary">{chart}</pre>
      </div>
    );
  }

  return (
    <div
      className="mermaid-render my-3 overflow-x-auto rounded-lg border border-border/50 bg-surface-900 p-3 [&_svg]:mx-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

interface MarkdownPreviewProps {
  content: string;
}

export const MarkdownPreview = memo(function MarkdownPreview({ content }: MarkdownPreviewProps) {
  const components = useMemo(() => ({
    a: ({ href, children }: any) => (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary-hover underline decoration-primary/30 hover:decoration-primary"
      >
        {children}
      </a>
    ),
    img: ({ src, alt }: any) => {
      const url = typeof src === 'string' && !/^(https?:|data:image\/)/.test(src) ? undefined : src;
      if (!url) return <span className="text-xs italic text-ink-muted">[{alt || 'image'}]</span>;
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={url} alt={alt} className="max-w-full rounded border border-border/50" />;
    },
    code: ({ className, children }: any) => {
      const text = String(children ?? '').replace(/\n$/, '');
      if (/language-mermaid/i.test(className || '')) return <MermaidBlock chart={text} />;
      return <code className={className}>{children}</code>;
    },
    pre: ({ children }: any) => {
      const child = Array.isArray(children) ? children[0] : children;
      const cls: string = child?.props?.className || '';
      if (/language-mermaid/i.test(cls)) return <>{children}</>; // rendered by MermaidBlock
      return (
        <pre className="mb-3 overflow-x-auto rounded-lg border border-border/50 bg-surface-900 p-3 font-mono text-[12px] leading-relaxed">
          {children}
        </pre>
      );
    },
  }), []);

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-3xl px-8 py-6 text-[13px] leading-relaxed text-ink-secondary [&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-3 [&_blockquote]:text-ink-muted [&_h1]:mb-3 [&_h1]:mt-5 [&_h1]:text-xl [&_h1]:font-semibold [&_h1]:text-foreground [&_h1:first-child]:mt-0 [&_h2]:mb-2.5 [&_h2]:mt-5 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-foreground [&_h2:first-child]:mt-0 [&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:text-foreground [&_hr]:my-4 [&_hr]:border-border/60 [&_input[type=checkbox]]:mr-1.5 [&_li]:ml-4 [&_li]:mt-0.5 [&_ol]:list-decimal [&_p]:mb-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-[12px] [&_tbody_tr:nth-child(odd)]:bg-white/[0.02] [&_td]:border [&_td]:border-border/50 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border/50 [&_th]:bg-white/[0.04] [&_th]:px-2 [&_th]:py-1 [&_ul]:list-disc">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
          components={components}
        >
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
});
