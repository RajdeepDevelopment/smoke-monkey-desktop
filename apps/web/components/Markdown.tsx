'use client';

import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import { ExternalLink } from 'lucide-react';
import { ErrorBoundary } from './ErrorBoundary';
import { AddonShell } from './visuals/AddonShell';
import { CodeBlock } from './visuals/CodeBlock';
import { FileBasedViewer } from './visuals/FileBasedViewer';
import { IsolatedHtml } from './visuals/IsolatedHtml';
import { MermaidDiagram } from './visuals/MermaidDiagram';
import { StreamingVisual } from './visuals/StreamingVisual';
import { TableWithExport } from './visuals/TableWithExport';
import { FileCard, FileCardPlaceholder, FILE_MARKER_RE } from './visuals/FileCard';
import { CardBlock, CardSkeleton, WidgetCard } from './visuals/CardBlock';
import type { WidgetHint } from './visuals/CardBlock';
import { ChartBlock, ChartSkeleton } from './visuals/ChartBlock';
import type { ChartKind } from './visuals/ChartBlock';
import { TreeBlock } from './visuals/TreeBlock';
import { WorkflowBlock } from './visuals/WorkflowBlock';
import {
  extractProjectName,
  parseFiles,
  parseProjectMetadata,
} from './visuals/fileUtils';
import type { FileEntry, ProjectMetadata } from './visuals/fileUtils';
import { cn } from '../lib/utils';
import { faviconForUrl } from './BrandIconResolver';

interface MarkdownProps {
  content: string;
  /** Extra react-markdown components merged over the built-in ones. */
  components?: React.ComponentProps<typeof ReactMarkdown>['components'];
  /** Called when a <file-SM-st> card is clicked (agent workspace uses this). */
  onFileSelect?: (path: string) => void;
}

export type Segment =
  | { kind: 'text'; content: string }
  | { kind: 'mermaid'; code: string }
  | { kind: 'visuals'; code: string }
  | { kind: 'files'; files: FileEntry[]; projectName: string; metadata: ProjectMetadata | null }
  | { kind: 'streaming'; lang: string }
  | { kind: 'streamingVisuals'; code: string }
  | { kind: 'streamingFiles'; files: FileEntry[]; projectName: string; metadata: ProjectMetadata | null }
  | { kind: 'streamingMeta' }
  | { kind: 'file'; path: string }
  | { kind: 'streaming-file' }
  | { kind: 'card'; json: string }
  | { kind: 'streaming-card' }
  | { kind: 'chart'; sub: ChartKind; json: string }
  | { kind: 'tree'; json: string }
  | { kind: 'workflow'; json: string }
  | { kind: 'widget'; hint: WidgetHint; json: string }
  | { kind: 'widget-mermaid'; code: string }
  | { kind: 'streaming-widget'; widget: 'chart' | 'card' };

/**
 * Add-on extraction pattern, ported from RDS-Power-AI's MarkdownRenderer.
 *
 * The assistant can emit three kinds of widgets that this renderer pulls OUT
 * of normal markdown and turns into rich blocks:
 *
 * 1. A mermaid diagram (a fenced block tagged `mermaid`).
 *
 * 2. A dynamic HTML visual using the RDS marker contract — ONE complete HTML
 *    document (`<!DOCTYPE html>` … `</html>`) wrapped between
 *    `RDS-Visuals-st` and `RDS-Visuals-ed`, no code fence. Rendered in a
 *    sandboxed iframe preview instead of leaking as raw HTML.
 *
 * 3. A multi-file project using `File-Based-st`/`File-Based-ed` (each file a
 *    `File: <path>` line + content) optionally preceded by a
 *    `Project-Metadata-st`/`Project-Metadata-ed` block. Rendered as a project
 *    explorer with a file tree, code viewer, copy/download and HTML preview.
 *
 * Any marker block that is still streaming (opened but not yet closed) becomes
 * a live tail widget — a streaming file explorer, a live HTML preview, or a
 * "building…" placeholder — so the message never flashes raw marker text.
 */
const MERMAID_FENCE_RE = /```mermaid[ \t]*\r?\n([\s\S]*?)```/g;
const OPEN_FENCE_RE = /```mermaid[ \t]*\r?\n([\s\S]*)$/;
const VISUALS_RE = /RDS-Visuals-st[ \t]*\r?\n?([\s\S]*?)[ \t]*\r?\n?RDS-Visuals-ed/g;
const FILES_RE = /File-Based-st[ \t]*\r?\n?([\s\S]*?)[ \t]*\r?\n?File-Based-ed/g;
const METADATA_RE = /Project-Metadata-st[ \t]*\r?\n?([\s\S]*?)[ \t]*\r?\n?Project-Metadata-ed/g;
/** Close-tag variants the LLM may emit for a marker pair: <end>, </start>, </end>.
 *  Models often close XML-style (<card-st>…</card-st>) instead of the canonical
 *  <card-ed>, so the parser accepts every spelling (plus optional inner spaces). */
function closeTagRe(start: string, end: string): RegExp {
  return new RegExp(`<\\s*/?\\s*(?:${end}|${start})\\s*>`);
}

const CARD_RE =
  /<card-st>[ \t]*\r?\n?([\s\S]*?)[ \t]*\r?\n?<\s*\/?\s*(?:card-ed|card-st)\s*>/g;

/** Dedicated JSON widgets wrapped in their own marker pairs. */
interface WidgetDef {
  start: string;
  end: string;
  kind: 'chart' | 'tree' | 'workflow' | 'widget' | 'widget-mermaid';
  sub?: ChartKind;
  hint?: WidgetHint;
}

const WIDGET_DEFS: WidgetDef[] = [
  { start: 'bar-chart-st', end: 'bar-chart-ed', kind: 'chart', sub: 'bar' },
  { start: 'line-chart-st', end: 'line-chart-ed', kind: 'chart', sub: 'line' },
  { start: 'pie-chart-st', end: 'pie-chart-ed', kind: 'chart', sub: 'pie' },
  { start: 'scatter-chart-st', end: 'scatter-chart-ed', kind: 'chart', sub: 'scatter' },
  { start: 'tree-st', end: 'tree-ed', kind: 'tree' },
  { start: 'workflow-st', end: 'workflow-ed', kind: 'workflow' },
  { start: 'mermaid-st', end: 'mermaid-ed', kind: 'widget-mermaid' },
  { start: 'timeline-st', end: 'timeline-ed', kind: 'widget', hint: 'timeline' },
  { start: 'progress-st', end: 'progress-ed', kind: 'widget', hint: 'progress' },
  { start: 'status-st', end: 'status-ed', kind: 'widget', hint: 'status' },
  { start: 'alert-st', end: 'alert-ed', kind: 'widget', hint: 'alert' },
  { start: 'callout-st', end: 'callout-ed', kind: 'widget', hint: 'callout' },
];

function widgetRe(def: WidgetDef): RegExp {
  return new RegExp(
    `<${def.start}>[ \\t]*\\r?\\n?([\\s\\S]*?)[ \\t]*\\r?\\n?<\\s*/?\\s*(?:${def.end}|${def.start})\\s*>`,
    'g',
  );
}

const WIDGET_MARKER_TAGS: string[] = WIDGET_DEFS.flatMap((d) => [d.start, d.end]);

const MARKERS = [
  'RDS-Visuals-st',
  'RDS-Visuals-ed',
  'File-Based-st',
  'File-Based-ed',
  'Project-Metadata-st',
  'Project-Metadata-ed',
  'file-SM-st',
  'file-sm-ed',
  'pdf-SM-st',
  'pdf-sm-ed',
  'card-st',
  'card-ed',
  ...WIDGET_MARKER_TAGS,
];

/** LLMs sometimes wrap marker blocks in a code fence — strip those fences so
 *  the markers (and only them) are never treated as normal code. */
function stripMarkerFences(text: string): string {
  let out = text;
  for (const marker of MARKERS) {
    out = out
      .replace(new RegExp('```[\\w-]*?(?=\\s*' + marker + ')', 'g'), '')
      .replace(new RegExp('(?<=' + marker + ')\\s*```[\\w-]*', 'g'), '');
  }
  return out;
}

/** Returns the index of the last unclosed block of a marker pair, or -1. */
function lastUnclosed(text: string, start: string, end: string, boundary?: (after: string) => boolean): number {
  const i = text.lastIndexOf(start);
  if (i === -1) return -1;
  const after = text.slice(i + start.length);
  if (boundary && !boundary(after)) return -1;
  if (after.includes(end)) return -1;
  return i;
}

interface OpenTail {
  kind: 'visuals' | 'files' | 'metadata' | 'mermaid' | 'file' | 'card' | 'widget';
  index: number;
  def?: WidgetDef;
}

/** True when the last <file-SM-st> open tag has no matching close yet. */
function lastUnclosedFile(text: string): number {
  const openRe = /<(?:pdf|file)-sm-st\s*>/gi;
  let last = -1;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(text)) !== null) last = m.index;
  if (last === -1) return -1;
  const after = text.slice(last);
  const closeRe = /<(?:pdf|file)-sm-ed\s*>/gi;
  return closeRe.test(after) ? -1 : last;
}

/** True when a complete <start> block appears before `atIndex` with no close yet. */
function hasUnclosedOpenBefore(text: string, atIndex: number, start: string, end: string): boolean {
  const open = '<' + start + '>';
  const closed = closeTagRe(start, end);
  let o = text.indexOf(open);
  while (o !== -1 && o < atIndex) {
    if (!text.slice(o + open.length).match(closed)) return true;
    o = text.indexOf(open, o + 1);
  }
  return false;
}

/**
 * Find the last still-streaming <…> robot block (card/widget markers). Returns
 * the index of the opening "<" so the opening bracket is never left in the
 * rendered text; a streaming tag name ("<bar-ch…) is treated as a tail
 * immediately (no raw prefix flash), and a streaming close tag ("<card-ed"
 * without ">") keeps the skeleton until it lands (no raw JSON flash). Close
 * tags written either canonically (<card-ed>) or XML-style (</card-st>) are
 * both recognized as closed.
 */
function lastStreamingOpen(text: string, start: string, end: string): number {
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] !== '<') continue;
    const after = text.slice(i + 1);
    if (after[0] === '/') continue; // a close tag can never be an opening tail
    if (after.startsWith(start)) {
      const rest = after.slice(start.length);
      if (rest[0] === '>' && closeTagRe(start, end).test(after)) continue;
      return i;
    }
    if (after.length > 0 && start.startsWith(after)) {
      const realOpen = hasUnclosedOpenBefore(text, i, start, end);
      if (!realOpen) return i;
    }
  }
  return -1;
}

/** Find the first (earliest) marker block that is still streaming. */
function detectTail(normalized: string): OpenTail | null {
  const candidates: OpenTail[] = [];

  const visuals = lastUnclosed(normalized, 'RDS-Visuals-st', 'RDS-Visuals-ed');
  if (visuals !== -1) candidates.push({ kind: 'visuals', index: visuals });

  const files = lastUnclosed(normalized, 'File-Based-st', 'File-Based-ed');
  if (files !== -1) candidates.push({ kind: 'files', index: files });

  const metadata = lastUnclosed(normalized, 'Project-Metadata-st', 'Project-Metadata-ed');
  if (metadata !== -1) candidates.push({ kind: 'metadata', index: metadata });

  const mermaid = lastUnclosed(normalized, '```mermaid', '```', (after) => !after || /[\s]/.test(after[0]));
  if (mermaid !== -1) candidates.push({ kind: 'mermaid', index: mermaid });

  const file = lastUnclosedFile(normalized);
  if (file !== -1) candidates.push({ kind: 'file', index: file });

  const card = lastStreamingOpen(normalized, 'card-st', 'card-ed');
  if (card !== -1) candidates.push({ kind: 'card', index: card });

  for (const def of WIDGET_DEFS) {
    const i = lastStreamingOpen(normalized, def.start, def.end);
    if (i !== -1) candidates.push({ kind: 'widget', index: i, def });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.index - b.index);
  return candidates[0];
}

/** Build the live tail widget for a still-streaming marker block. */
function buildTail(
  normalized: string,
  open: OpenTail,
  metadata: ProjectMetadata | null,
): Segment | null {
  if (open.kind === 'visuals') {
    let code = normalized.slice(open.index + 'RDS-Visuals-st'.length);
    code = code.replace(/^[ \t]*\r?\n?/, '');
    return { kind: 'streamingVisuals', code };
  }
  if (open.kind === 'files') {
    let content = normalized.slice(open.index + 'File-Based-st'.length);
    content = content.replace(/^[ \t]*\r?\n?/, '');
    return {
      kind: 'streamingFiles',
      files: parseFiles(content),
      projectName: extractProjectName(content) ?? metadata?.projectName ?? 'Streaming Project',
      metadata,
    };
  }
  if (open.kind === 'metadata') return { kind: 'streamingMeta' };
  if (open.kind === 'file') return { kind: 'streaming-file' };
  if (open.kind === 'card') return { kind: 'streaming-card' };
  if (open.kind === 'widget' && open.def) {
    if (open.def.kind === 'chart') return { kind: 'streaming-widget', widget: 'chart' };
    if (open.def.kind === 'widget-mermaid') return { kind: 'streaming', lang: 'mermaid' };
    return { kind: 'streaming-widget', widget: 'card' };
  }
  return { kind: 'streaming', lang: 'mermaid' };
}

/** Handle an unfinished mermaid fence at the tail of a text segment. */
function splitMermaidTail(text: string): Segment[] {
  const m = OPEN_FENCE_RE.exec(text);
  if (!m) return [{ kind: 'text', content: text }];
  const out: Segment[] = [];
  if (m.index > 0) out.push({ kind: 'text', content: text.slice(0, m.index) });
  out.push({ kind: 'streaming', lang: 'mermaid' });
  return out;
}

/**
 * If a marker block reaches the end of the message with a broken/missing close
 * tag but its body is ALREADY a complete widget, render it now instead of
 * showing a streaming skeleton forever (a common LLM truncation edge case).
 * During live streaming the body is usually still partial, so JSON.parse
 * keeps failing and the skeleton stays exactly as intended.
 */
function tryFinalizeTail(normalized: string, open: OpenTail): Segment | null {
  const start = open.def ? open.def.start : 'card-st';
  const end = open.def ? open.def.end : 'card-ed';
  const openTag = '<' + start + '>';
  if (!normalized.startsWith(openTag, open.index)) return null;
  let content = normalized.slice(open.index + openTag.length);
  content = content
    .replace(/^[ \t]*\r?\n?/, '')
    .replace(/[ \t]*\r?\n?$/, '')
    .replace(/<\s*\/?\s*[a-zA-Z0-9-]+\s*>\s*$/, '');
  try {
    JSON.parse(content);
  } catch {
    return null;
  }
  if (open.def) {
    switch (open.def.kind) {
      case 'chart':
        if (open.def.sub === undefined) return null;
        return { kind: 'chart', sub: open.def.sub, json: content };
      case 'tree':
        return { kind: 'tree', json: content };
      case 'workflow':
        return { kind: 'workflow', json: content };
      case 'widget-mermaid':
        return { kind: 'widget-mermaid', code: content };
      case 'widget':
        if (open.def.hint === undefined) return null;
        return { kind: 'widget', hint: open.def.hint, json: content };
    }
  }
  return { kind: 'card', json: content };
}

/** Segment complete (closed) blocks, stripping + parsing Project-Metadata. */
function segmentMain(main: string): { segments: Segment[]; metadata: ProjectMetadata | null } {
  let metadata: ProjectMetadata | null = null;
  METADATA_RE.lastIndex = 0;
  let mm: RegExpExecArray | null;
  while ((mm = METADATA_RE.exec(main)) !== null) {
    const parsed = parseProjectMetadata(mm[1]);
    if (parsed) metadata = parsed;
  }
  const cleaned = main.replace(METADATA_RE, '');

  const segments: Segment[] = [];
  let last = 0;

  const findNext = (from: number): { index: number; end: number; seg: Segment } | null => {
    let best: { index: number; end: number; seg: Segment } | null = null;
    const scan = (re: RegExp, make: (m: RegExpExecArray) => { seg: Segment; end: number } | null) => {
      re.lastIndex = from;
      const m = re.exec(cleaned);
      if (m) {
        const r = make(m);
        if (r && (!best || m.index < best.index)) {
          best = { index: m.index, end: r.end, seg: r.seg };
        }
      }
    };

    scan(VISUALS_RE, (m) => ({
      seg: { kind: 'visuals', code: m[1].trim() },
      end: m.index + m[0].length,
    }));
    scan(MERMAID_FENCE_RE, (m) => ({
      seg: { kind: 'mermaid', code: m[1] },
      end: m.index + m[0].length,
    }));
    scan(FILES_RE, (m) => {
      const files = parseFiles(m[1]);
      if (files.length === 0) return null;
      return {
        seg: {
          kind: 'files',
          files,
          projectName: extractProjectName(m[1]) ?? metadata?.projectName ?? 'Project',
          metadata,
        },
        end: m.index + m[0].length,
      };
    });
    scan(FILE_MARKER_RE, (m) => {
      const path = (m[1] ?? '').trim();
      if (!path) return null;
      return { seg: { kind: 'file', path }, end: m.index + m[0].length };
    });
    scan(CARD_RE, (m) => {
      const json = (m[1] ?? '').trim();
      if (!json) return null;
      return { seg: { kind: 'card', json }, end: m.index + m[0].length };
    });

    for (const def of WIDGET_DEFS) {
      scan(widgetRe(def), (m) => {
        const json = (m[1] ?? '').trim();
        const end = m.index + m[0].length;
        switch (def.kind) {
          case 'chart':
            if (!json || def.sub === undefined) return null;
            return { seg: { kind: 'chart', sub: def.sub, json }, end };
          case 'tree':
            if (!json) return null;
            return { seg: { kind: 'tree', json }, end };
          case 'workflow':
            if (!json) return null;
            return { seg: { kind: 'workflow', json }, end };
          case 'widget-mermaid':
            return { seg: { kind: 'widget-mermaid', code: json }, end };
          case 'widget':
            if (!json || def.hint === undefined) return null;
            return { seg: { kind: 'widget', hint: def.hint, json }, end };
        }
      });
    }

    return best;
  };

  let next: ReturnType<typeof findNext>;
  while ((next = findNext(last))) {
    if (next.index > last) {
      const text = cleaned.slice(last, next.index);
      if (text.trim()) segments.push(...splitMermaidTail(text));
    }
    segments.push(next.seg);
    last = next.end;
  }
  if (last < cleaned.length) {
    const text = cleaned.slice(last);
    if (text.trim()) segments.push(...splitMermaidTail(text));
  }
  if (segments.length === 0 && cleaned.trim()) {
    segments.push(...splitMermaidTail(cleaned.trim()));
  }
  return { segments, metadata };
}

/** Strip Smoke Monkey inline ask_user blocks. These are real tool-call
 *  invocations that get parsed into popup dialogs server-side, but when the
 *  model streams them as raw text the block flashes in the chat UI. Closing
 *  tags are matched; an unclosed opening tag (still mid-stream) is also removed
 *  so nothing appears before the popup arrives. */
function stripAskUserBlocks(text: string): string {
  return text
    .replace(/<ask_user\s*>[\s\S]*?<\/ask_user\s*>/gi, '')
    .replace(/<ask_user[ \t]*>[\s\S]*$/gi, '');
}

export function splitAddons(content: string): Segment[] {
  const normalized = stripAskUserBlocks(stripMarkerFences(content));
  const tail = detectTail(normalized);
  const main = tail ? normalized.slice(0, tail.index) : normalized;
  const { segments, metadata } = segmentMain(main);
  if (tail) {
    const finalized = tryFinalizeTail(normalized, tail);
    if (finalized) segments.push(finalized);
    else {
      const tailSeg = buildTail(normalized, tail, metadata);
      if (tailSeg) segments.push(tailSeg);
    }
  }
  if (segments.length === 0 && !tail) segments.push({ kind: 'text', content: normalized });
  return segments;
}

function StreamingAddon({ lang }: { lang: string }) {
  const label = lang === 'mermaid' ? 'Drawing diagram…' : 'Building visualization…';
  return (
    <AddonShell type="streaming" label={label}>
      <div className="h-14 animate-pulse bg-surface-800/60" />
    </AddonShell>
  );
}

function StreamingMetaAddon() {
  return (
    <AddonShell type="streaming" label="Parsing project…">
      <div className="h-14 animate-pulse bg-surface-800/60" />
    </AddonShell>
  );
}

function MarkdownBody({ content, components, onFileSelect }: MarkdownProps) {
  const segments = splitAddons(content);
  return (
    <div className="md-body">
      {segments.map((seg, i) => {
        if (seg.kind === 'mermaid') return <MermaidDiagram key={i} code={seg.code} />;
        if (seg.kind === 'visuals') return <IsolatedHtml key={i} code={seg.code} />;
        if (seg.kind === 'files') {
          return (
            <FileBasedViewer
              key={i}
              files={seg.files}
              projectName={seg.projectName}
              metadata={seg.metadata}
            />
          );
        }
        if (seg.kind === 'streaming') return <StreamingAddon key={i} lang={seg.lang} />;
        if (seg.kind === 'streamingVisuals') return <StreamingVisual key={i} code={seg.code} />;
        if (seg.kind === 'streamingFiles') {
          return (
            <FileBasedViewer
              key={i}
              files={seg.files}
              projectName={seg.projectName}
              metadata={seg.metadata}
              streaming
            />
          );
        }
        if (seg.kind === 'streamingMeta') return <StreamingMetaAddon key={i} />;
        if (seg.kind === 'file') return <FileCard key={i} path={seg.path} onOpenInEditor={onFileSelect} />;
        if (seg.kind === 'streaming-file') return <FileCardPlaceholder key={i} />;
        if (seg.kind === 'card') return <CardBlock key={i} json={seg.json} />;
        if (seg.kind === 'streaming-card') return <CardSkeleton key={i} />;
        if (seg.kind === 'chart') return <ChartBlock key={i} kind={seg.sub} json={seg.json} />;
        if (seg.kind === 'tree') return <TreeBlock key={i} json={seg.json} />;
        if (seg.kind === 'workflow') return <WorkflowBlock key={i} json={seg.json} />;
        if (seg.kind === 'widget') return <WidgetCard key={i} hint={seg.hint} json={seg.json} />;
        if (seg.kind === 'widget-mermaid') return <MermaidDiagram key={i} code={seg.code} />;
        if (seg.kind === 'streaming-widget') {
          return seg.widget === 'chart' ? <ChartSkeleton key={i} /> : <CardSkeleton key={i} />;
        }
        return (
          <ErrorBoundary key={i}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={{
                ...(components ?? {}),
                pre:
                  components?.pre ??
                  (({ children }) => (
                    <CodeBlock language={getLanguage(children)}>{children}</CodeBlock>
                  )),
                table:
                  components?.table ??
                  (({ children }) => <TableWithExport>{children}</TableWithExport>),
                a:
                  components?.a ??
                  (({ href, children }) => {
                    if (!href) return <a>{children}</a>;
                    if (/^https?:\/\//i.test(href)) {
                      const fav = faviconForUrl(href);
                      if (fav) {
                        const FavIcon = fav.Icon;
                        return (
                          <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1">
                            <span className={cn('shrink-0 leading-none', fav.color)}>
                              <FavIcon className="h-3.5 w-3.5 fill-current" />
                            </span>
                            {children}
                          </a>
                        );
                      }
                      return (
                        <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1">
                          <ExternalLink className="h-3 w-3 shrink-0 text-ink-muted/60" />
                          {children}
                        </a>
                      );
                    }
                    return <a href={href}>{children}</a>;
                  }),
              }}
            >
              {seg.content}
            </ReactMarkdown>
          </ErrorBoundary>
        );
      })}
    </div>
  );
}

/**
 * react-markdown's `pre` receives the `<code>` element as its child; the
 * language lives on that element's className (e.g. "language-python hljs").
 */
function getLanguage(children: unknown): string {
  const props = (children as { props?: { className?: string } } | null)?.props;
  const m = /language-([\w-]+)/.exec(props?.className ?? '');
  return m ? m[1] : 'code';
}

/**
 * Renders assistant markdown (GFM + code highlighting + copy/download code
 * blocks + table CSV export + mermaid diagrams + RDS-Visuals HTML previews +
 * File-Based project explorers). Memoized so only the streaming message
 * re-renders on token updates.
 */
export const Markdown = memo(function Markdown({ content, components, onFileSelect }: MarkdownProps) {
  return <MarkdownBody content={content} components={components} onFileSelect={onFileSelect} />;
});
