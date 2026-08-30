'use client';

import dynamic from 'next/dynamic';
import { useMemo } from 'react';
import { SM_THEME, defineSmokeMonkeyTheme } from '../../lib/monaco-theme';
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

export interface DiffHunk {
  /** lines present only in the "before" (original) side */
  original: string[];
  /** lines present only in the "after" (modified) side */
  modified: string[];
  /** 1-based line number in the original file where the hunk starts */
  startLine: number;
  /** optional display filename */
  filePath?: string;
}

/**
 * Parse a ```diff fenced block (as returned by the agent's edit tools) into
 * original/modified line pairs so the change can be rendered as a real diff.
 *
 * Tolerates standard unified-diff headers (`---`, `+++`, `@@`) as well as the
 * minimal "+/-" lines produced by the edit_file tool. Blank lines split hunks
 * when they don't carry a leading sign.
 */
export function parseUnifiedDiff(text: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let filePath: string | undefined;
  let original: string[] = [];
  let modified: string[] = [];
  let startLine = 1;

  const flush = () => {
    if (original.length > 0 || modified.length > 0) {
      hunks.push({ original, modified, startLine, filePath });
    }
    original = [];
    modified = [];
  };

  const lines = text.replace(/\r\n/g, '\n').split('\n');

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');

    if (line.startsWith('--- a/') || line.startsWith('--- ')) {
      // --- a/path/to/file -> capture source path
      const p = line.replace(/^---\s+(?:a\/)?/, '').trim();
      if (p && p !== '/dev/null') filePath = p;
      continue;
    }
    if (line.startsWith('@@ ') || line.startsWith('@@-')) {
      // @@ -start,count +start,count @@
      const m = /@@\s+-(\d+)/.exec(line);
      if (m) startLine = parseInt(m[1], 10);
      continue;
    }
    if (line.startsWith('+++ ')) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      modified.push(line.slice(1));
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      original.push(line.slice(1));
      continue;
    }

    // Context line: ends the current hunk's sign groups but keeps continuity.
    if (line.trim() === '') {
      flush();
    } else if (original.length > 0 || modified.length > 0) {
      // context line between +/- lines — push to both sides to keep alignment
      original.push(line);
      modified.push(line);
    }
  }

  flush();
  return hunks.filter((h) => h.original.length > 0 || h.modified.length > 0);
}

interface Props {
  diffText: string;
  filePath?: string;
  language?: string;
  className?: string;
  maxHeight?: number;
}

export function InlineDiff({ diffText, filePath, language, className, maxHeight = 320 }: Props) {
  const hunks = useMemo(() => parseUnifiedDiff(diffText), [diffText]);

  return (
    <div className={cn('flex flex-col', className)}>
      {hunks.map((hunk, i) => (
        <HunkEditor key={i} hunk={hunk} filePath={filePath || hunk.filePath} language={language} maxHeight={maxHeight} />
      ))}
    </div>
  );
}

function HunkEditor({ hunk, filePath, language, maxHeight }: { hunk: DiffHunk; filePath?: string; language?: string; maxHeight: number }) {
  const original = hunk.original.join('\n');
  const modified = hunk.modified.join('\n');

  return (
    <div className={cn('mb-2 overflow-hidden rounded-lg border border-border/50 bg-surface-950/70')}>
      <div className="flex h-7 items-center justify-between border-b border-border/40 bg-black/20 px-2.5">
        <div className="flex min-w-0 items-center gap-2">
          {filePath && (
            <span className="truncate font-mono text-[10px] text-ink-secondary">{filePath}</span>
          )}
          <span className="shrink-0 font-mono text-[9px] text-ink-muted/60">L{hunk.startLine}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-[9px] font-mono font-medium">
          <span className="text-[#7DCB7D]">+{hunk.modified.length}</span>
          <span className="text-[#F87171]">−{hunk.original.length}</span>
        </div>
      </div>
      <div className="relative" style={{ height: heightFor(original, modified, maxHeight) }}>
        <div className="absolute inset-0">
          <MonacoDiffEditor
            original={original}
            modified={modified}
            language={language || detectLanguage(filePath)}
            keepCurrentOriginalModel
            keepCurrentModifiedModel
            beforeMount={defineSmokeMonkeyTheme}
            theme={SM_THEME}
            options={{
              readOnly: true,
              renderSideBySide: true,
              fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, monospace",
              fontSize: 12,
              lineHeight: 18,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              padding: { top: 6, bottom: 6 },
              renderOverviewRuler: false,
              hideUnchangedRegions: { enabled: false },
              scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false },
            }}
          />
        </div>
      </div>
    </div>
  );
}

function heightFor(original: string, modified: string, cap: number): number {
  const n = Math.max(original.split('\n').length, modified.split('\n').length);
  const ideal = n * 18 + 12; // lineHeight + padding
  return Math.max(96, Math.min(ideal, cap));
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
