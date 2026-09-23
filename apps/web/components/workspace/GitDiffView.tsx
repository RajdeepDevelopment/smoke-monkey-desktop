'use client';

import dynamic from 'next/dynamic';
import { useMemo } from 'react';
import { SM_THEME, defineSmokeMonkeyTheme } from '../../lib/monaco-theme';
import { FileIcon } from './FileIcon';
import { cn } from '../../lib/utils';

const MonacoDiffEditor = dynamic(
  () => import('@monaco-editor/react').then((mod) => ({ default: mod.DiffEditor })),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-xs text-ink-muted">Loading diff…</div>
    ),
  },
);

interface Props {
  original: string;
  modified: string;
  filePath?: string;
  language?: string;
  className?: string;
  renderSideBySide?: boolean;
}

function detectLanguage(path?: string): string {
  if (!path) return 'plaintext';
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    md: 'markdown', sql: 'sql', sh: 'shell', bash: 'shell',
    xml: 'xml', c: 'c', cpp: 'cpp', h: 'c', cs: 'csharp', php: 'php',
    svg: 'xml', vue: 'html', svelte: 'html',
  };
  return map[ext] || 'plaintext';
}

export function GitDiffView({
  original,
  modified,
  filePath,
  language,
  className,
  renderSideBySide = true,
}: Props) {
  const lang = language ?? detectLanguage(filePath);
  const stats = useMemo(() => {
    const a = (original || '').split('\n');
    const b = (modified || '').split('\n');
    const setA = new Set(a);
    const setB = new Set(b);
    const removed = a.filter((l) => !setB.has(l)).length;
    const added = b.filter((l) => !setA.has(l)).length;
    return { added, removed };
  }, [original, modified]);

  return (
    <div className={cn('flex flex-col overflow-hidden', className ?? 'h-full')}>
      {/* Header */}
      <div className="glass-border-bottom flex h-8 shrink-0 items-center justify-between px-3">
        <div className="flex min-w-0 items-center gap-2">
          {filePath && (
            <>
              <FileIcon name={filePath.split('/').pop() || ''} />
              <span className="truncate font-mono text-[11px] text-ink-secondary">{filePath}</span>
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 text-[10px] font-medium">
          <span className="text-[#7DCB7D]">+{stats.added}</span>
          <span className="text-[#F87171]">−{stats.removed}</span>
        </div>
      </div>

      {/* Absolutely-positioned diff so it can never collapse to 0 height */}
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0">
          <MonacoDiffEditor
            key={`${filePath}-${lang}`}
            original={original}
            modified={modified}
            language={lang}
            keepCurrentOriginalModel
            keepCurrentModifiedModel
            beforeMount={defineSmokeMonkeyTheme}
            theme={SM_THEME}
            options={{
              readOnly: true,
              renderSideBySide,
              fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, monospace",
              fontSize: 13,
              lineHeight: 20,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              padding: { top: 0, bottom: 0 },
              renderOverviewRuler: false,
              hideUnchangedRegions: { enabled: false },
              scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
            }}
          />
        </div>
      </div>
    </div>
  );
}
