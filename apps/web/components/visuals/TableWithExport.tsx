'use client';

import { useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Markdown table wrapper with export options (copy as CSV / download CSV),
 * a leaner port of RDS-Power-AI's TableWithExport that avoids the xlsx dep.
 */
export function TableWithExport({ children }: { children: ReactNode }) {
  const tableRef = useRef<HTMLTableElement>(null);
  const [copied, setCopied] = useState(false);

  const toCsv = (): string => {
    const table = tableRef.current;
    if (!table) return '';
    const rows = Array.from(table.querySelectorAll('tr'));
    return rows
      .map((row) =>
        Array.from(row.querySelectorAll('th, td'))
          .map((cell) => {
            const text = (cell as HTMLElement).innerText.replace(/"/g, '""').trim();
            return `"${text}"`;
          })
          .join(','),
      )
      .join('\n');
  };

  const copyCsv = async () => {
    try {
      await navigator.clipboard.writeText(toCsv());
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const downloadCsv = () => {
    const blob = new Blob([toCsv()], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `table_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="my-3 overflow-hidden rounded-lg border border-surface-600">
      <div className="flex items-center justify-end gap-1 border-b border-surface-700 bg-surface-900 px-3 py-1.5">
        <button
          type="button"
          onClick={copyCsv}
          className="rounded-md px-2 py-1 text-[10px] font-medium text-ink-secondary transition-colors hover:bg-surface-800 hover:text-white"
          title="Copy table as CSV"
        >
          {copied ? 'Copied' : 'Copy CSV'}
        </button>
        <button
          type="button"
          onClick={downloadCsv}
          className="rounded-md px-2 py-1 text-[10px] font-medium text-ink-secondary transition-colors hover:bg-surface-800 hover:text-white"
          title="Download table as CSV"
        >
          Download CSV
        </button>
      </div>
      <div className="overflow-x-auto">
        <table ref={tableRef} className="m-0 w-full border-collapse text-sm">
          {children}
        </table>
      </div>
    </div>
  );
}
