'use client';

import { memo, useMemo } from 'react';
import { formatBytes } from '../../../lib/file-types';

/** CSV/TSV table viewer. Parses in one pass (RFC-4180 quotes) and renders a
 *  capped window so huge files never blow up React memory. */

interface CsvViewerProps {
  name: string;
  content: string;
  size?: number;
}

const MAX_ROWS = 500;

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      if (field === '' && text[i + 1] === '"' ) { /* quoted field start */ }
      i++;
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          i++;
          break;
        }
        field += text[i++];
      }
    } else if (ch === delimiter) {
      row.push(field); field = ''; i++;
    } else if (ch === '\r') {
      i++;
    } else if (ch === '\n') {
      row.push(field); rows.push(row); row = []; field = ''; i++;
      if (rows.length > MAX_ROWS + 1) break; // stop early on huge files
    } else {
      field += ch; i++;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

export const CsvViewer = memo(function CsvViewer({ name, content, size }: CsvViewerProps) {
  const { header, rows, totalRows, truncated } = useMemo(() => {
    const isTsv = /\.tsv$/i.test(name);
    const all = parseDelimited(content.replace(/\r\n/g, '\n'), isTsv ? '\t' : ',');
    return {
      header: all[0] ?? [],
      rows: all.slice(1, MAX_ROWS + 1),
      totalRows: Math.max(0, all.length - 1),
      truncated: all.length - 1 > MAX_ROWS,
    };
  }, [content, name]);

  return (
    <div className="flex h-full flex-col">
      <div className="glass-border-bottom flex h-7 shrink-0 items-center gap-3 px-3 text-[10px] text-ink-muted">
        <span className="truncate">{name}</span>
        <span>{totalRows.toLocaleString()} rows</span>
        <span>{header.length} cols</span>
        {size !== undefined && <span>{formatBytes(size)}</span>}
        {truncated && <span className="text-warning">showing first {MAX_ROWS}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        <table className="w-full border-collapse text-[11px]">
          <thead className="sticky top-0 z-10 bg-surface-850">
            <tr>
              <th className="border-b border-r border-border/60 px-2 py-1 text-left font-medium text-ink-muted">#</th>
              {header.map((h, i) => (
                <th key={i} className="border-b border-r border-border/60 px-2 py-1 text-left font-semibold text-foreground">
                  {h || <span className="text-ink-muted">col{i + 1}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r} className={r % 2 ? 'bg-white/[0.02]' : ''}>
                <td className="border-b border-r border-border/40 px-2 py-0.5 text-right tabular-nums text-ink-muted">{r + 1}</td>
                {header.map((_, c) => (
                  <td key={c} className="max-w-[320px] truncate border-b border-border/40 px-2 py-0.5 text-ink-secondary" title={row[c] ?? ''}>
                    {row[c] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
});
