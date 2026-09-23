'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Braces,
  Check,
  Copy,
  Download,
  FileSpreadsheet,
  FileText,
  Rows2,
  Table2,
} from 'lucide-react';
import { cn } from '../../lib/utils';

interface ActionButtonProps {
  icon: typeof Copy;
  label: string;
  title: string;
  active?: boolean;
  onClick: () => void;
  showLabel?: boolean;
}

function ActionButton({ icon: Icon, label, title, active, onClick, showLabel }: ActionButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-medium text-ink-secondary transition-colors hover:bg-surface-800 hover:text-white',
        active && 'text-success hover:text-success',
      )}
    >
      {active ? <Check className="h-3 w-3" /> : <Icon className="h-3 w-3" />}
      {showLabel ? label : null}
    </button>
  );
}

/** Read a table's rows as plain text arrays (th / td cells). */
function readRows(table: HTMLTableElement | null): string[][] {
  if (!table) return [];
  return Array.from(table.querySelectorAll('tr')).map((row) =>
    Array.from(row.querySelectorAll('th, td')).map((cell) =>
      ((cell as HTMLElement).innerText ?? '').replace(/\s+$/g, '').trim(),
    ),
  );
}

function slugify(header: string, index: number): string {
  const slug = header.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return slug || `column_${index + 1}`;
}

const escapeCell = (cell: string) => `"${cell.replace(/"/g, '""')}"`;

/**
 * Markdown table wrapper with a premium toolbar: copy / download in CSV, plus
 * Markdown, TSV, HTML and JSON exports, and a live rows×cols badge.
 */
export function TableWithExport({ children }: { children: ReactNode }) {
  const tableRef = useRef<HTMLTableElement>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [dims, setDims] = useState({ rows: 0, cols: 0 });

  useEffect(() => {
    const r = readRows(tableRef.current);
    const cols = r.length ? Math.max(...r.map((row) => row.length)) : 0;
    setDims({ rows: r.length, cols });
  }, [children]);

  const toCsv = (separator = ',') =>
    readRows(tableRef.current)
      .map((row) => row.map(escapeCell).join(separator))
      .join('\n');

  const toMarkdown = () =>
    readRows(tableRef.current)
      .map((row, i) => {
        const line = row.join(' | ');
        const divider = ' | '.repeat(Math.max(row.length - 1, 1)) + (row.length ? '---' : '');
        return i === 0 || i === 1 ? `| ${i === 1 ? divider : line} |` : `| ${line} |`;
      })
      .join('\n');

  const toTsv = () =>
    readRows(tableRef.current)
      .map((row) => row.map((cell) => cell.replace(/\t/g, ' ').replace(/[\r\n]+/g, ' ')).join('\t'))
      .join('\n');

  const toJson = () => {
    const r = readRows(tableRef.current);
    if (r.length === 0) return '[]';
    const headers = r[0].map(slugify);
    const body = r.slice(1).map((row) =>
      Object.fromEntries(headers.map((key, i) => [key, row[i] ?? null])),
    );
    return JSON.stringify(body, null, 2);
  };

  const toHtml = () => tableRef.current?.outerHTML ?? '';

  const flash = (key: string) => {
    setCopied(key);
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 1400);
  };

  const copyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      flash(key);
    } catch {
      /* ignore clipboard errors */
    }
  };

  const download = (filename: string, text: string, type: string) => {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const date = () => new Date().toISOString().split('T')[0];

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-surface-600 shadow-[0_14px_40px_-24px_rgba(0,0,0,0.85)]">
      <div className="flex items-center justify-between gap-2 border-b border-surface-700 bg-[linear-gradient(180deg,rgba(139,92,246,0.10),transparent)] px-3 py-1.5">
        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-ink-secondary">
          <span className="flex items-center gap-1.5">
            <Table2 className="h-3.5 w-3.5 text-primary" />
            Table
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-surface-600 bg-surface-900 px-1.5 py-0.5 normal-case tracking-normal text-ink-muted">
            <Rows2 className="h-2.5 w-2.5" />
            {dims.rows} × {dims.cols}
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          <ActionButton
            icon={Copy}
            label={copied === 'csv' ? 'Copied' : 'Copy CSV'}
            title="Copy table as CSV"
            active={copied === 'csv'}
            showLabel
            onClick={() => copyText('csv', toCsv())}
          />
          <ActionButton
            icon={Download}
            label="Download"
            title="Download table as CSV"
            onClick={() => download(`table_${date()}.csv`, toCsv(), 'text/csv;charset=utf-8')}
            showLabel
          />
          <span className="mx-1 h-4 w-px bg-surface-600" />
          <ActionButton
            icon={FileText}
            label=""
            title="Copy as Markdown"
            active={copied === 'md'}
            onClick={() => copyText('md', toMarkdown())}
          />
          <ActionButton
            icon={FileSpreadsheet}
            label=""
            title="Copy as TSV"
            active={copied === 'tsv'}
            onClick={() => copyText('tsv', toTsv())}
          />
          <ActionButton
            icon={Braces}
            label=""
            title="Copy as JSON"
            active={copied === 'json'}
            onClick={() => copyText('json', toJson())}
          />
          <ActionButton
            icon={Copy}
            label=""
            title="Copy as HTML"
            active={copied === 'html'}
            onClick={() => copyText('html', toHtml())}
          />
          <ActionButton
            icon={Download}
            label=""
            title="Download as JSON"
            onClick={() => download(`table_${date()}.json`, toJson(), 'application/json;charset=utf-8')}
          />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table ref={tableRef} className="m-0 w-full border-collapse text-sm">
          {children}
        </table>
      </div>
    </div>
  );
}