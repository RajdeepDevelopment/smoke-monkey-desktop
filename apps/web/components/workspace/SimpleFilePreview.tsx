'use client';

import { useEffect, type ReactNode } from 'react';
import { FileText, X, Code2, Lock } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface SimplePreviewFile {
  path: string;
  name: string;
  content: string;
  kind?: string;
  raw?: { dataUrl?: string; blobUrl?: string; size?: number };
}

interface SimpleFilePreviewProps {
  file: SimplePreviewFile | null;
  onClose: () => void;
  onOpenInDev: () => void;
}

/**
 * Simple-mode file viewer. Rendered as an inline panel on the LEFT of the
 * chat (matching Developer mode's editor position) so the conversation is
 * pushed aside instead of covered by a modal. Changes to `file` are rendered
 * by the caller mounting/unmounting this component per file.
 */
export function SimpleFilePreview({ file, onClose, onOpenInDev }: SimpleFilePreviewProps) {
  useEffect(() => {
    if (!file) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [file, onClose]);

  if (!file) return null;

  const dir = file.path.split('/').slice(0, -1).join('/') || '.';

  let body: ReactNode;
  if ((file.kind === 'image' || file.kind === 'svg') && file.raw?.dataUrl) {
    body = (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/30 p-4">
        <img src={file.raw.dataUrl} alt={file.name} className="max-h-full max-w-full rounded-lg object-contain" />
      </div>
    );
  } else if (file.kind === 'pdf' && file.raw?.blobUrl) {
    body = (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-black/30">
        <embed src={file.raw.blobUrl} type="application/pdf" className="h-full w-full" />
      </div>
    );
  } else {
    const tooLarge = file.content.length > 2_000_000;
    body = (
      <div className="scrollbar-thin min-h-0 flex-1 overflow-auto bg-black/20 p-4">
        <pre className="whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed text-ink-primary/90">
          {file.content || (tooLarge ? '% File is too large to preview — open in Developer mode to edit %' : '% Empty file %')}
        </pre>
      </div>
    );
  }

  return (
    <div
      className="glass-border-right flex shrink-0 flex-col overflow-hidden bg-surface-900/60"
      style={{ width: 'clamp(340px, 46%, 720px)' }}
    >
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2.5 border-b border-border/50 bg-surface-800/60 px-3 py-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary-hover">
          <FileText className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-foreground">{file.name}</p>
          <p className="truncate text-[10px] text-ink-muted">{dir}</p>
        </div>
        <span className="hidden shrink-0 items-center gap-1 rounded-full border border-border/50 bg-surface-900/70 px-2 py-1 text-[10px] text-ink-muted lg:inline-flex">
          <Lock className="h-3 w-3" /> Read-only
        </span>
        <button
          onClick={onOpenInDev}
          title="Switch to Developer mode to edit this file"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border/50 px-2.5 py-1.5 text-[11px] font-medium text-ink-secondary transition-colors hover:bg-surface-700 hover:text-foreground"
        >
          <Code2 className="h-3.5 w-3.5" />
          <span className="hidden xl:inline">Edit in Developer</span>
        </button>
        <button
          onClick={onClose}
          title="Close preview (Esc)"
          aria-label="Close file preview"
          className="shrink-0 rounded-lg p-1.5 text-ink-muted transition-colors hover:bg-surface-700 hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Body */}
      {body}
    </div>
  );
}