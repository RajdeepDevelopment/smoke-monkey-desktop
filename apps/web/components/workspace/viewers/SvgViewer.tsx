'use client';

import { memo, useState } from 'react';
import dynamic from 'next/dynamic';
import { cn } from '../../../lib/utils';
import { formatBytes } from '../../../lib/file-types';

const MonacoCodeEditor = dynamic(
  () => import('../MonacoCodeEditor').then((m) => ({ default: m.MonacoCodeEditor })),
  { ssr: false, loading: () => <div className="flex-1 bg-[#080C12]" /> },
);

/** SVG: rendered preview by default, Monaco source on demand.
 *  The preview renders through <img src={dataUrl}> — scripts inside the SVG
 *  can never execute in an <img> context. */

interface SvgViewerProps {
  path: string;
  name: string;
  content: string;
  dataUrl: string;
  size?: number;
  onSave: (path: string, content: string) => void;
  onContentChange: (path: string, content: string) => void;
}

export const SvgViewer = memo(function SvgViewer({
  path, name, content, dataUrl, size, onSave, onContentChange,
}: SvgViewerProps) {
  const [showSource, setShowSource] = useState(false);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  return (
    <div className="flex h-full flex-col">
      <div className="glass-border-bottom flex h-8 shrink-0 items-center justify-between px-2">
        <div className="flex items-center gap-3 text-[10px] text-ink-muted">
          <span className="truncate">{name}</span>
          {dims && <span>{dims.w} × {dims.h}</span>}
          {size !== undefined && <span>{formatBytes(size)}</span>}
        </div>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setShowSource(false)}
            className={cn(
              'rounded px-2 py-0.5 text-[10px] transition-colors',
              !showSource ? 'bg-primary-subtle text-foreground' : 'text-ink-muted hover:text-foreground',
            )}
          >
            Preview
          </button>
          <button
            onClick={() => setShowSource(true)}
            className={cn(
              'rounded px-2 py-0.5 text-[10px] transition-colors',
              showSource ? 'bg-primary-subtle text-foreground' : 'text-ink-muted hover:text-foreground',
            )}
          >
            Source
          </button>
        </div>
      </div>

      {showSource ? (
        <MonacoCodeEditor
          filePath={path}
          content={content}
          readOnly={false}
          onSave={onSave}
          onContentChange={onContentChange}
          className="min-h-0 flex-1"
        />
      ) : (
        <div className="checkerboard min-h-0 flex-1 overflow-auto scrollbar-thin">
          <div className="flex h-full w-full items-center justify-center p-6">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={dataUrl}
              alt={name}
              draggable={false}
              onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
              className="select-none"
            />
          </div>
        </div>
      )}
    </div>
  );
});
