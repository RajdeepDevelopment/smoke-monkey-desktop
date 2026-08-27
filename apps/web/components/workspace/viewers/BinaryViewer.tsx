'use client';

import { memo } from 'react';
import { Binary, FolderOpen } from 'lucide-react';
import { ideApi } from '../../../lib/ide-api';
import { formatBytes } from '../../../lib/file-types';

/** Binary files are never rendered as text — just metadata + reveal action. */

interface BinaryViewerProps {
  path: string;
  name: string;
  size?: number;
}

export const BinaryViewer = memo(function BinaryViewer({ path, name, size }: BinaryViewerProps) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex w-64 flex-col items-center gap-3 rounded-xl glass-panel px-6 py-8 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/[0.04]">
          <Binary className="h-5 w-5 text-ink-muted" />
        </div>
        <div>
          <p className="truncate text-sm font-medium text-foreground">{name}</p>
          <p className="mt-1 text-[11px] text-ink-muted">Binary file{size !== undefined ? ` · ${formatBytes(size)}` : ''}</p>
        </div>
        <button
          onClick={() => void ideApi.revealInFinder(path).catch(() => {})}
          className="mt-1 flex items-center gap-1.5 rounded-lg glass-panel px-3 py-1.5 text-[11px] text-ink-secondary transition-colors hover:text-foreground"
        >
          <FolderOpen className="h-3 w-3" /> Reveal in Finder
        </button>
      </div>
    </div>
  );
});
