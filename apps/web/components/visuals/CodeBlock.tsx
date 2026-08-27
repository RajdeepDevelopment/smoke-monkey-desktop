'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';

interface CodeBlockProps {
  language: string;
  children: ReactNode;
}

/** Recursively pull plain text out of the highlighted <code> token tree. */
function extractText(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (typeof node === 'object' && 'props' in (node as object)) {
    return extractText((node as { props?: { children?: unknown } }).props?.children);
  }
  return '';
}

const EXT_BY_LANG: Record<string, string> = {
  bash: 'sh',
  sh: 'sh',
  javascript: 'js',
  js: 'js',
  jsx: 'jsx',
  typescript: 'ts',
  ts: 'ts',
  tsx: 'tsx',
  python: 'py',
  py: 'py',
  html: 'html',
  css: 'css',
  json: 'json',
  markdown: 'md',
  md: 'md',
  yaml: 'yml',
  yml: 'yml',
  sql: 'sql',
  xml: 'xml',
};

/**
 * Fenced code block with a toolbar (language badge, copy, download).
 * Renders the highlighted code that rehype-highlight already produced
 * (kept in `children`) so syntax colors come free.
 */
export function CodeBlock({ language, children }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const ext = EXT_BY_LANG[language] ?? language ?? 'txt';

  // Children are the highlighted <span> tree; extract raw source text from it.
  const raw = extractText(children).replace(/\n$/, '');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const download = () => {
    const blob = new Blob([raw], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `snippet.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="my-3 overflow-hidden rounded-lg border border-surface-600 bg-surface-950">
      <div className="flex items-center justify-between gap-2 border-b border-surface-700 px-3 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
          {language || 'code'}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={copy}
            className="rounded-md px-2 py-1 text-[10px] font-medium text-ink-secondary transition-colors hover:bg-surface-800 hover:text-white"
            title="Copy code"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            onClick={download}
            className="rounded-md px-2 py-1 text-[10px] font-medium text-ink-secondary transition-colors hover:bg-surface-800 hover:text-white"
            title="Download code"
          >
            Download
          </button>
        </div>
      </div>
      <pre className="m-0 overflow-x-auto p-3">
        <code className="bg-transparent p-0">{children}</code>
      </pre>
    </div>
  );
}
