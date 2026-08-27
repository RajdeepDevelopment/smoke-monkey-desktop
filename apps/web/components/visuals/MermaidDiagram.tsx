'use client';

import { useEffect, useId, useState } from 'react';
import { AddonShell } from './AddonShell';
import { renderMermaidSafely } from '../../lib/mermaid';

interface MermaidDiagramProps {
  code: string;
}

/**
 * Renders a ```mermaid fence body into a live SVG diagram.
 *
 * Rendering goes through lib/mermaid which isolates all failure modes:
 * invalid syntax and render errors stay inside this card (inline notice +
 * raw source fallback) — nothing is appended to the page body.
 */
export function MermaidDiagram({ code }: MermaidDiagramProps) {
  const rawId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);

    (async () => {
      try {
        const rendered = await renderMermaidSafely(rawId, code);
        if (!cancelled) setSvg(rendered);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [rawId, code]);

  return (
    <AddonShell type="mermaid" label="Flow diagram">
      {error ? (
        <div>
          <div className="border-b border-red-500/20 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-300">
            Diagram could not be rendered — showing source
          </div>
          <pre className="m-0 max-h-64 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs text-red-300">
            {code}
          </pre>
        </div>
      ) : svg ? (
        <div
          className="w-full max-w-full overflow-x-auto [&_svg]:mx-auto [&_svg]:block [&_svg]:min-w-[520px] [&_svg]:max-w-none"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div className="h-16 animate-pulse bg-surface-800/60" aria-label="Rendering diagram…" />
      )}
    </AddonShell>
  );
}
