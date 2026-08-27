'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AddonShell } from './AddonShell';
import { buildSrcDoc } from './htmlDoc';

interface IsolatedHtmlProps {
  code: string;
}

const DEFAULT_HEIGHT = 360;
const MIN_HEIGHT = 140;

/**
 * Renders a raw HTML visual (the RDS-Visuals-st … RDS-Visuals-ed block) in a
 * sandboxed iframe. If the block contains a full <html> document it is used
 * as-is; a bare fragment (e.g. <style> + <div>s) is wrapped by the browser.
 * The wrapper auto-sizes to the rendered content height.
 */
export function IsolatedHtml({ code }: IsolatedHtmlProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [expanded, setExpanded] = useState(false);

  const srcDoc = useMemo(() => buildSrcDoc(code), [code]);

  useEffect(() => {
    setHeight(DEFAULT_HEIGHT);
  }, [srcDoc]);

  // Scripts inside the sandbox post { type: 'rag:resize', height } to grow.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; height?: number } | null;
      if (
        data &&
        data.type === 'rag:resize' &&
        typeof data.height === 'number' &&
        Number.isFinite(data.height)
      ) {
        setHeight(Math.max(MIN_HEIGHT, Math.floor(data.height)));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Fallback measurement for sandboxes where the resize bridge script
  // was stripped or ran before the content settled.
  const remeasure = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    try {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!doc) return;
      const h = doc.documentElement.scrollHeight;
      if (h > 0) setHeight(Math.max(MIN_HEIGHT, h));
    } catch {
      /* cross-origin sandbox — rely on the resize bridge instead */
    }
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const t = window.setTimeout(remeasure, 80);
    return () => window.clearTimeout(t);
  }, [expanded, remeasure]);

  return (
    <AddonShell type="visuals" label="HTML preview">
      <div
        className={
          expanded
            ? 'fixed inset-0 z-[60] flex flex-col bg-[#0B1120]/95 p-4 backdrop-blur-sm'
            : ''
        }
      >
        <div className="flex items-center justify-between pb-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">
            Preview
          </span>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="rounded-md border border-surface-600 px-2 py-1 text-[10px] font-semibold text-ink-muted transition hover:border-accent hover:text-accent"
          >
            {expanded ? 'Close' : 'Expand'}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <iframe
            ref={iframeRef}
            title="html-preview"
            sandbox="allow-same-origin allow-scripts allow-modals allow-forms allow-popups allow-downloads allow-pointer-lock"
            srcDoc={srcDoc}
            onLoad={remeasure}
            loading="lazy"
            className="block w-full border-0"
            style={{ height: `${height}px` }}
          />
        </div>
      </div>
    </AddonShell>
  );
}
