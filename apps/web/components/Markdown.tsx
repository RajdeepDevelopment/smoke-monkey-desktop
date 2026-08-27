'use client';

import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import { ErrorBoundary } from './ErrorBoundary';
import { AddonShell } from './visuals/AddonShell';
import { CodeBlock } from './visuals/CodeBlock';
import { FileBasedViewer } from './visuals/FileBasedViewer';
import { IsolatedHtml } from './visuals/IsolatedHtml';
import { MermaidDiagram } from './visuals/MermaidDiagram';
import { StreamingVisual } from './visuals/StreamingVisual';
import { TableWithExport } from './visuals/TableWithExport';
import {
  extractProjectName,
  parseFiles,
  parseProjectMetadata,
} from './visuals/fileUtils';
import type { FileEntry, ProjectMetadata } from './visuals/fileUtils';

interface MarkdownProps {
  content: string;
  /** Extra react-markdown components merged over the built-in ones. */
  components?: React.ComponentProps<typeof ReactMarkdown>['components'];
}

type Segment =
  | { kind: 'text'; content: string }
  | { kind: 'mermaid'; code: string }
  | { kind: 'visuals'; code: string }
  | { kind: 'files'; files: FileEntry[]; projectName: string; metadata: ProjectMetadata | null }
  | { kind: 'streaming'; lang: string }
  | { kind: 'streamingVisuals'; code: string }
  | { kind: 'streamingFiles'; files: FileEntry[]; projectName: string; metadata: ProjectMetadata | null }
  | { kind: 'streamingMeta' };

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

const MARKERS = [
  'RDS-Visuals-st',
  'RDS-Visuals-ed',
  'File-Based-st',
  'File-Based-ed',
  'Project-Metadata-st',
  'Project-Metadata-ed',
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
  kind: 'visuals' | 'files' | 'metadata' | 'mermaid';
  index: number;
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

function splitAddons(content: string): Segment[] {
  const normalized = stripMarkerFences(content);
  const tail = detectTail(normalized);
  const main = tail ? normalized.slice(0, tail.index) : normalized;
  const { segments, metadata } = segmentMain(main);
  if (tail) {
    const tailSeg = buildTail(normalized, tail, metadata);
    if (tailSeg) segments.push(tailSeg);
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

function MarkdownBody({ content, components }: MarkdownProps) {
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
        return (
          <ErrorBoundary key={i}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={{
                ...components,
                pre: ({ children }) => (
                  <CodeBlock language={getLanguage(children)}>{children}</CodeBlock>
                ),
                table: ({ children }) => <TableWithExport>{children}</TableWithExport>,
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
export const Markdown = memo(function Markdown({ content, components }: MarkdownProps) {
  return <MarkdownBody content={content} components={components} />;
});
