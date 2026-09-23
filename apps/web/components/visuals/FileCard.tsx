'use client';

import { memo, useEffect, useMemo, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  File, FileText, Presentation, Sheet, Image as ImageIcon, Code2, FolderOpen, ExternalLink, Loader2, Check, AlertTriangle, Download, Video, Music,
} from 'lucide-react';
import { ideApi } from '../../lib/ide-api';
import { getFileViewerType, isEditableViewer } from '../../lib/file-types';
import { cn } from '../../lib/utils';
import { agentAssetToBlob, downloadAgentAsset, fetchAgentAsset, probeAgentAsset } from '../../lib/api';

/**
 * The backend instructs the agent to wrap every generated file path in this
 * marker so the frontend can render it as a clickable card:
 *
 *   <file-SM-st>/abs/path/report.pdf<file-sm-ed>
 *
 * Both prefixes (`file`/`pdf`) and both close-tag spellings (with/without `/`)
 * are accepted, case-insensitively — the agent may emit any variant.
 */
export const FILE_MARKER_RE =
  /<(?:pdf|file)-sm-st\s*>([\s\S]*?)[\t ]*<(?:\/)?(?:pdf|file)-sm-ed\s*>/gi;

interface FileMarker {
  path: string;
  /** Full matched marker text (replaced by the rendered card). */
  raw: string;
}

/** Extract every complete <file-SM-st>…<file-sm-ed> wrapper from a message. */
export function extractFileMarkers(text: string): FileMarker[] {
  const markers: FileMarker[] = [];
  FILE_MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_MARKER_RE.exec(text)) !== null) {
    const path = m[1].trim();
    if (path) markers.push({ path, raw: m[0] });
  }
  FILE_MARKER_RE.lastIndex = 0;
  return markers;
}

/** Remove complete markers plus any still-streaming (unclosed) open tags. */
export function stripFileMarkers(text: string): string {
  const cleaned = text.replace(FILE_MARKER_RE, '');
  return cleaned.replace(/<(?:pdf|file)-sm-st\s*>\s*[^<\n]*$/gi, '').replace(/^[ \t]*<(?:pdf|file)-sm-ed\s*>?[ \t]*$/gim, '');
}

export type FileSegment =
  | { kind: 'text'; content: string }
  | { kind: 'file'; path: string }
  | { kind: 'streaming-file' };

/**
 * Splits a message into text and FileCard segments. Complete wrappers become
 * file cards; an unclosed (still-streaming) open tag becomes a placeholder.
 */
export function splitFileSegments(text: string): FileSegment[] {
  const markers = extractFileMarkers(text);
  if (markers.length === 0) {
    if (/<(?:pdf|file)-sm-st\s*>[\s\S]*$/i.test(text)) {
      const before = stripFileMarkers(text);
      const out: FileSegment[] = [];
      if (before.trim()) out.push({ kind: 'text', content: before });
      out.push({ kind: 'streaming-file' });
      return out;
    }
    return [{ kind: 'text', content: text }];
  }

  const segments: FileSegment[] = [];
  let last = 0;
  for (const marker of markers) {
    const idx = text.indexOf(marker.raw, last);
    const start = idx === -1 ? last : idx;
    if (start > last) {
      const before = text.slice(last, start);
      if (before.trim()) segments.push({ kind: 'text', content: before });
    }
    segments.push({ kind: 'file', path: marker.path });
    last = start + marker.raw.length;
  }
  const tail = text.slice(last);
  if (tail.trim()) segments.push({ kind: 'text', content: tail });
  if (segments.length === 0) return [{ kind: 'text', content: text }];
  return segments;
}

const isMac = () => /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent);
const isWindows = () => /win/i.test(navigator.platform || navigator.userAgent);

function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function fileExt(path: string): string {
  const name = fileName(path);
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}

interface FileTypeMeta {
  icon: LucideIcon;
  label: string;
  chip: string;
}

function typeMeta(path: string): FileTypeMeta {
  const ext = fileExt(path);
  switch (ext) {
    case 'pdf':
      return { icon: FileText, label: 'PDF Document', chip: 'text-red-400 bg-red-500/10' };
    case 'ppt':
    case 'pptx':
      return { icon: Presentation, label: 'PowerPoint', chip: 'text-orange-400 bg-orange-500/10' };
    case 'xls':
    case 'xlsx':
      return { icon: Sheet, label: 'Excel Workbook', chip: 'text-emerald-400 bg-emerald-500/10' };
    case 'csv':
      return { icon: Sheet, label: 'CSV Spreadsheet', chip: 'text-emerald-400 bg-emerald-500/10' };
    case 'doc':
    case 'docx':
      return { icon: FileText, label: 'Word Document', chip: 'text-sky-400 bg-sky-500/10' };
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'svg':
    case 'avif':
      return { icon: ImageIcon, label: 'Image', chip: 'text-purple-400 bg-purple-500/10' };
    case 'mp4':
    case 'webm':
    case 'mkv':
    case 'mov':
    case 'avi':
      return { icon: Video, label: 'Video', chip: 'text-sky-400 bg-sky-500/10' };
    case 'mp3':
    case 'wav':
    case 'flac':
    case 'ogg':
    case 'm4a':
      return { icon: Music, label: 'Audio', chip: 'text-amber-400 bg-amber-500/10' };
    default:
      return { icon: File, label: isEditableViewer(getFileViewerType(path)) ? 'Source File' : 'File', chip: 'text-ink-muted bg-surface-700' };
  }
}

interface FileCardProps {
  path: string;
  /** Optional; when set and the file is editable text, renders an extra
   *  "Open in Editor" action (wired to the caller's IDE file opener). */
  onOpenInEditor?: (path: string) => void;
}

function useFileAction() {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setDone(false);
    try {
      await action();
      setDone(true);
      setTimeout(() => setDone(false), 1600);
    } catch {
      /* the OS app simply could not be launched */
    } finally {
      setBusy(false);
    }
  };
  return { busy, done, run };
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'ico']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mkv', 'mov', 'avi']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'flac', 'ogg', 'm4a']);

/** Inline preview for image mentions: fetched through the gateway asset
 *  endpoint (works in the Tauri app AND the browser build), center-aligned,
 *  sized between a floor and a ceiling so it never dominates the message or
 *  disappears into a 1-px dot. Clicking downloads the original file.
 */
function FileImagePreview({ path }: { path: string }) {
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [src, setSrc] = useState<string | null>(null);
  const [name, setName] = useState('');

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    fetchAgentAsset(path)
      .then((asset) => {
        if (cancelled) return;
        setName(asset.name || '');
        const blob = typeof asset.b64 === 'string' ? agentAssetToBlob(asset) : null;
        if (blob) setSrc(URL.createObjectURL(blob));
        setState(blob ? 'ok' : 'error');
      })
      .catch(() => { if (!cancelled) setState('error'); });
    return () => {
      cancelled = true;
      setSrc((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, [path]);

  const onDownload = async () => {
    try { downloadAgentAsset(await fetchAgentAsset(path)); } catch { /* unreachable */ }
  };

  if (state === 'loading') {
    return (
      <div className="flex h-32 items-center justify-center bg-surface-800/50">
        <Loader2 className="h-4 w-4 animate-spin text-ink-muted" />
        <span className="ml-2 text-[11px] text-ink-muted">Loading preview…</span>
      </div>
    );
  }
  if (state === 'error' || !src) {
    return (
      <div className="flex h-20 items-center justify-center bg-surface-800/50 px-3">
        <AlertTriangle className="h-4 w-4 text-ink-muted" />
        <span className="ml-2 text-[11px] text-ink-muted">Preview unavailable — use Download</span>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center bg-black/40 p-2">
      <img
        src={src}
        alt={name || path}
        onClick={onDownload}
        title={name || path}
        className="max-w-full cursor-pointer object-contain select-none"
        style={{ minHeight: 120, maxHeight: 480 }}
        draggable={false}
      />
    </div>
  );
}

/** Inline playable preview for generated video/audio assets (fetched through
 *  the gateway asset endpoint the same way images are). <video>/<audio> with
 *  native controls; clicking opens the original system file.
 */
function FileMediaPreview({ path, kind }: { path: string; kind: 'video' | 'audio' }) {
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    fetchAgentAsset(path)
      .then((asset) => {
        if (cancelled) return;
        const blob = typeof asset.b64 === 'string' ? agentAssetToBlob(asset) : null;
        if (blob) setSrc(URL.createObjectURL(blob));
        setState(blob ? 'ok' : 'error');
      })
      .catch(() => { if (!cancelled) setState('error'); });
    return () => {
      cancelled = true;
      setSrc((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, [path]);

  if (state === 'loading') {
    return (
      <div className="flex h-32 items-center justify-center bg-surface-800/50">
        <Loader2 className="h-4 w-4 animate-spin text-ink-muted" />
        <span className="ml-2 text-[11px] text-ink-muted">Loading preview…</span>
      </div>
    );
  }
  if (state === 'error' || !src) {
    return (
      <div className="flex h-20 items-center justify-center bg-surface-800/50 px-3">
        <AlertTriangle className="h-4 w-4 text-ink-muted" />
        <span className="ml-2 text-[11px] text-ink-muted">Preview unavailable — use Download</span>
      </div>
    );
  }

  return (
    <div className="bg-black/40 p-2">
      {kind === 'video' ? (
        <video src={src} controls preload="metadata" className="max-h-[420px] w-full cursor-pointer object-contain" />
      ) : (
        <audio src={src} controls preload="metadata" className="w-full cursor-pointer" />
      )}
    </div>
  );
}

export const FileCard = memo(function FileCard({ path, onOpenInEditor }: FileCardProps) {
  const meta = useMemo(() => typeMeta(path), [path]);
  const Icon = meta.icon;
  const name = fileName(path);
  const open = useFileAction();
  const reveal = useFileAction();
  const download = useFileAction();
  const openInEditor = useFileAction();
  const revealLabel = isWindows() ? 'Show in Explorer' : isMac() ? 'Show in Finder' : 'Show in File Manager';
  const isImage = IMAGE_EXTS.has(fileExt(path));
  const isVideo = VIDEO_EXTS.has(fileExt(path));
  const isAudio = AUDIO_EXTS.has(fileExt(path));

  // ── Existence probe ──────────────────────────────────────────────────────
  // Prevents showing a full action card (Download / Open / Reveal) for a
  // hallucinated path that was never actually written to disk. The backend
  // sanitiser strips markers before persist when possible, but some older
  // messages may already have bogus paths — this catches them client-side.
  const [exists, setExists] = useState<'checking' | 'found' | 'missing'>('checking');
  useEffect(() => {
    let cancelled = false;
    probeAgentAsset(path)
      .then(() => { if (!cancelled) setExists('found'); })
      .catch(() => { if (!cancelled) setExists('missing'); });
    return () => { cancelled = true; };
  }, [path]);

  const runDownload = () =>
    download.run(async () => {
      downloadAgentAsset(await fetchAgentAsset(path));
    });

  /** Open the file in the in-app editor whenever a handler is wired up. If the
   *  editor read fails (remote profile, path not in this workspace yet), fall
   *  back to launching the OS-default app so the action always "works". */
  const runOpenInEditor = () =>
    openInEditor.run(async () => {
      if (!onOpenInEditor) return;
      try {
        await onOpenInEditor(path);
      } catch {
        await ideApi.openFile(path);
      }
    });

  // ── Degraded state: file not found ───────────────────────────────────────
  if (exists === 'missing') {
    return (
      <div className="addon-shell relative mx-0 my-2.5 overflow-hidden rounded-lg border border-amber-500/30 bg-amber-950/20">
        <div className="flex items-center gap-3 px-3 py-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-amber-400 bg-amber-500/10">
            <AlertTriangle className="h-[18px] w-[18px]" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12.5px] font-medium text-amber-200" title={path}>
              {name}
            </p>
            <p className="truncate text-[10.5px] text-amber-300/70" title={path}>
              ⚠ File not found — the reported path does not exist on disk.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── Checking state: lightweight spinner ───────────────────────────────────
  if (exists === 'checking') {
    return (
      <div className="addon-shell relative mx-0 my-2.5 overflow-hidden rounded-lg border border-surface-600 bg-surface-900">
        <div className="flex items-center gap-3 px-3 py-2.5">
          <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-md', meta.chip)}>
            <Icon className="h-[18px] w-[18px]" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12.5px] font-medium text-foreground" title={path}>{name}</p>
            <p className="flex items-center gap-1.5 text-[10.5px] text-ink-muted">
              <Loader2 className="h-3 w-3 animate-spin" /> Checking file…
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── Full card: file exists ────────────────────────────────────────────────
  return (
    <div className="addon-shell relative mx-0 my-2.5 overflow-hidden rounded-lg border border-surface-600 bg-surface-900">
      {isImage && <FileImagePreview path={path} />}
      {isVideo && <FileMediaPreview path={path} kind="video" />}
      {isAudio && <FileMediaPreview path={path} kind="audio" />}
      <div className="flex items-center gap-3 px-3 py-2.5">
        <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-md', meta.chip)}>
          <Icon className="h-[18px] w-[18px]" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-medium text-foreground" title={path}>
            {name}
          </p>
          <p className="truncate text-[10.5px] text-ink-muted" title={path}>
            {meta.label}
            <span className="mx-1 opacity-60">·</span>
            <span className="font-mono">{path}</span>
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-t border-surface-700/70 px-2.5 py-2">
        <button
          onClick={runDownload}
          disabled={download.busy}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary/15 px-2.5 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-primary/25 disabled:opacity-50"
        >
          {download.busy ? <Loader2 className="h-3 w-3 animate-spin" /> : download.done ? <Check className="h-3 w-3" /> : <Download className="h-3 w-3" />}
          {download.done ? 'Downloaded' : 'Download'}
        </button>
        <button
          onClick={() => void open.run(() => ideApi.openFile(path))}
          disabled={open.busy}
          className="inline-flex items-center gap-1.5 rounded-md bg-surface-800 px-2.5 py-1 text-[11px] text-ink-muted transition-colors hover:bg-surface-700 hover:text-foreground disabled:opacity-50"
        >
          {open.busy ? <Loader2 className="h-3 w-3 animate-spin" /> : open.done ? <Check className="h-3 w-3" /> : <ExternalLink className="h-3 w-3" />}
          {open.done ? 'Opened' : 'Open'}
        </button>
        <button
          onClick={() => void reveal.run(() => ideApi.revealInFinder(path))}
          disabled={reveal.busy}
          className="inline-flex items-center gap-1.5 rounded-md bg-surface-800 px-2.5 py-1 text-[11px] text-ink-muted transition-colors hover:bg-surface-700 hover:text-foreground disabled:opacity-50"
        >
          {reveal.busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <FolderOpen className="h-3 w-3" />}
          {revealLabel}
        </button>
        {onOpenInEditor && (
          <button
            onClick={runOpenInEditor}
            disabled={openInEditor.busy}
            title="Open in the in-app editor (falls back to your default app)"
            className="inline-flex items-center gap-1.5 rounded-md bg-surface-800 px-2.5 py-1 text-[11px] text-ink-muted transition-colors hover:bg-surface-700 hover:text-foreground disabled:opacity-50"
          >
            {openInEditor.busy ? <Loader2 className="h-3 w-3 animate-spin" /> : openInEditor.done ? <Check className="h-3 w-3" /> : <Code2 className="h-3 w-3" />}
            {openInEditor.done ? 'Opened' : 'Open in Editor'}
          </button>
        )}
      </div>
    </div>
  );
});

/** A slim card to show while the marker is still streaming (unclosed). */
export const FileCardPlaceholder = memo(function FileCardPlaceholder() {
  return (
    <div className="addon-shell relative mx-0 my-2.5 flex items-center gap-3 overflow-hidden rounded-lg border border-surface-600 bg-surface-900 px-3 py-2.5">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-800">
        <AlertTriangle className="h-4 w-4 text-ink-muted" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] text-ink-muted">Generating file…</p>
      </div>
    </div>
  );
});