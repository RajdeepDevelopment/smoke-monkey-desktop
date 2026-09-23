'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Check, Copy, Download, ListOrdered, WrapText } from 'lucide-react';
import { cn } from '../../lib/utils';

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

/** Distinct accent dot per language family — keeps the palette on-dark. */
const DOT_BY_LANG: Record<string, string> = {
  bash: 'bg-emerald-400',
  sh: 'bg-emerald-400',
  shell: 'bg-emerald-400',
  javascript: 'bg-yellow-400',
  js: 'bg-yellow-400',
  jsx: 'bg-cyan-400',
  typescript: 'bg-yellow-300',
  ts: 'bg-yellow-300',
  tsx: 'bg-cyan-300',
  python: 'bg-sky-400',
  py: 'bg-sky-400',
  html: 'bg-orange-400',
  css: 'bg-violet-400',
  scss: 'bg-pink-400',
  json: 'bg-cyan-300',
  markdown: 'bg-slate-300',
  md: 'bg-slate-300',
  yaml: 'bg-amber-400',
  yml: 'bg-amber-400',
  sql: 'bg-amber-500',
  xml: 'bg-orange-300',
  dockerfile: 'bg-sky-300',
  diff: 'bg-fuchsia-400',
};

function ToolButton({
  icon: Icon,
  title,
  onClick,
  active,
}: {
  icon: typeof Copy;
  title: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={cn(
        'flex h-6 w-6 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-800 hover:text-white',
        active && 'text-accent hover:text-accent',
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

/**
 * Fenced code block with a premium toolbar: macOS-style traffic lights,
 * language badge + stats, line numbers, word-wrap toggle, copy + download.
 * Renders the highlighted code that rehype-highlight already produced
 * (kept in `children`) so syntax colors come free.
 */
export function CodeBlock({ language, children }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [showLines, setShowLines] = useState(true);

  const ext = EXT_BY_LANG[language] ?? language ?? 'txt';
  const dot = DOT_BY_LANG[language] ?? 'bg-primary';

  // Children are the highlighted <span> tree; extract raw source text from it.
  const raw = extractText(children).replace(/\n$/, '');
  const lineCount = raw ? raw.split('\n').length : 1;

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

  const showGutter = showLines && !wrap;

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-surface-600 bg-surface-950 shadow-[0_16px_44px_-26px_rgba(0,0,0,0.9)]">
      <div className="flex items-center justify-between gap-2 border-b border-surface-700 bg-[linear-gradient(180deg,rgba(139,92,246,0.10),transparent)] px-3 py-2">
        <div className="flex items-center gap-2.5">
          <span className="flex items-center gap-1" aria-hidden>
            <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f58] shadow-[0_0_6px_rgba(255,95,88,0.6)]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e] shadow-[0_0_6px_rgba(254,188,46,0.5)]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#28c840] shadow-[0_0_6px_rgba(40,200,64,0.5)]" />
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-surface-600 bg-surface-900 px-2 py-0.5 text-[10px] font-medium text-ink-secondary">
            <span className={cn('h-1.5 w-1.5 rounded-full', dot)} />
            {language || 'code'}
          </span>
          <span className="hidden text-[10px] text-ink-muted sm:inline">
            {lineCount} line{lineCount === 1 ? '' : 's'} · {raw.length} chars
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          <ToolButton
            icon={ListOrdered}
            title={showLines ? 'Hide line numbers' : 'Show line numbers'}
            onClick={() => setShowLines((v) => !v)}
            active={showLines}
          />
          <ToolButton
            icon={WrapText}
            title={wrap ? 'Disable word wrap' : 'Enable word wrap'}
            onClick={() => setWrap((v) => !v)}
            active={wrap}
          />
          <span className="mx-1 h-4 w-px bg-surface-600" />
          <ToolButton
            icon={copied ? Check : Copy}
            title={copied ? 'Copied' : 'Copy code'}
            onClick={copy}
            active={copied}
          />
          <ToolButton icon={Download} title="Download code" onClick={download} />
        </div>
      </div>
      <div className="flex max-w-full">
        {showGutter && (
          <div
            aria-hidden
            className="shrink-0 select-none border-r border-surface-700/70 pl-3 pr-2.5 pt-3 pb-3 text-right"
          >
            {Array.from({ length: lineCount }, (_, i) => (
              <div
                key={i}
                className="font-mono text-[13px] leading-relaxed text-ink-muted/50"
              >
                {i + 1}
              </div>
            ))}
          </div>
        )}
        <pre
          className={cn(
            'm-0 min-w-0 flex-1 overflow-x-auto p-3 text-[13px] leading-relaxed',
            wrap && 'whitespace-pre-wrap break-words',
          )}
        >
          <code className="bg-transparent p-0 font-mono">{children}</code>
        </pre>
      </div>
    </div>
  );
}