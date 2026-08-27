'use client';

import { memo, useState } from 'react';
import { ZoomIn, ZoomOut, Maximize2, RotateCw } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { formatBytes } from '../../../lib/file-types';

interface ImageViewerProps {
  name: string;
  dataUrl: string;
  size?: number;
}

const MIN_SCALE = 10;
const MAX_SCALE = 800;

export const ImageViewer = memo(function ImageViewer({ name, dataUrl, size }: ImageViewerProps) {
  const [scale, setScale] = useState(100);
  const [fitMode, setFitMode] = useState(true);
  const [rotation, setRotation] = useState(0);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  const clamp = (v: number) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.round(v)));

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="glass-border-bottom flex h-8 shrink-0 items-center justify-center gap-1 px-3">
        <button onClick={() => { setFitMode(false); setScale((s) => clamp(s - 20)); }}
          className="rounded p-1 text-ink-muted transition-colors hover:bg-white/[0.06] hover:text-foreground" title="Zoom out">
          <ZoomOut className="h-3.5 w-3.5" />
        </button>
        <span className="w-12 text-center text-[10px] tabular-nums text-ink-secondary">{fitMode ? 'Fit' : `${scale}%`}</span>
        <button onClick={() => { setFitMode(false); setScale((s) => clamp(s + 20)); }}
          className="rounded p-1 text-ink-muted transition-colors hover:bg-white/[0.06] hover:text-foreground" title="Zoom in">
          <ZoomIn className="h-3.5 w-3.5" />
        </button>
        <span className="mx-1 h-4 w-px bg-border/60" />
        <button onClick={() => setFitMode(true)}
          className={cn('rounded px-1.5 py-0.5 text-[10px] transition-colors hover:bg-white/[0.06]',
            fitMode ? 'bg-primary-subtle text-foreground' : 'text-ink-muted hover:text-foreground')} title="Fit to screen">
          <Maximize2 className="h-3 w-3" />
        </button>
        <button onClick={() => { setFitMode(false); setScale(100); }}
          className={cn('rounded px-1.5 py-0.5 text-[10px] transition-colors hover:bg-white/[0.06]',
            !fitMode && scale === 100 ? 'bg-primary-subtle text-foreground' : 'text-ink-muted hover:text-foreground')} title="Actual size">
          1:1
        </button>
        <span className="mx-1 h-4 w-px bg-border/60" />
        <button onClick={() => setRotation((r) => (r + 90) % 360)}
          className="rounded p-1 text-ink-muted transition-colors hover:bg-white/[0.06] hover:text-foreground" title="Rotate 90°">
          <RotateCw className="h-3 w-3" />
        </button>
      </div>

      {/* Canvas */}
      <div className="checkerboard min-h-0 flex-1 overflow-auto scrollbar-thin">
        <div className="flex h-full w-full items-center justify-center p-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={dataUrl}
            alt={name}
            draggable={false}
            onLoad={(e) => {
              const img = e.currentTarget;
              setDims({ w: img.naturalWidth, h: img.naturalHeight });
            }}
            style={{
              transform: `rotate(${rotation}deg)`,
              ...(fitMode
                ? { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' as const }
                : { width: `${scale}%`, height: 'auto', imageRendering: scale > 300 ? ('pixelated' as const) : undefined }),
            }}
            className="select-none shadow-lg"
          />
        </div>
      </div>

      {/* Meta strip */}
      <div className="glass-border-top flex h-7 shrink-0 items-center gap-3 px-3 text-[10px] text-ink-muted">
        <span className="truncate">{name}</span>
        {dims && <span>{dims.w} × {dims.h}</span>}
        {size !== undefined && <span>{formatBytes(size)}</span>}
      </div>
    </div>
  );
});
