'use client';

import { memo } from 'react';
import { FileText } from 'lucide-react';
import { formatBytes } from '../../../lib/file-types';

/** PDF preview using the platform renderer (WKWebView renders PDFs natively,
 *  including scroll/page navigation and zoom controls). Content is passed as a
 *  blob URL — no third-party dependency, no script execution from the file. */

interface PdfViewerProps {
  name: string;
  blobUrl: string;
  size?: number;
}

export const PdfViewer = memo(function PdfViewer({ name, blobUrl, size }: PdfViewerProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="glass-border-bottom flex h-7 shrink-0 items-center gap-2 px-3 text-[10px] text-ink-muted">
        <FileText className="h-3 w-3 shrink-0" />
        <span className="truncate">{name}</span>
        {size !== undefined && <span>{formatBytes(size)}</span>}
      </div>
      <iframe
        src={blobUrl}
        title={name}
        className="min-h-0 flex-1 border-0 bg-[#202124]"
      />
    </div>
  );
});
