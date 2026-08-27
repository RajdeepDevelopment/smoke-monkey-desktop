'use client';

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { AddonShell } from './AddonShell';
import { buildSrcDoc } from './htmlDoc';
import { downloadProjectZip } from './zip';
import type { FileEntry, ProjectMetadata } from './fileUtils';

interface FileBasedViewerProps {
  files: FileEntry[];
  projectName?: string;
  metadata?: ProjectMetadata | null;
  streaming?: boolean;
}

interface TreeItem {
  file?: FileEntry;
  folders?: Record<string, TreeItem>;
}

function buildTree(files: FileEntry[]): Record<string, TreeItem> {
  const tree: Record<string, TreeItem> = {};
  for (const f of files) {
    const parts = f.filename.split('/');
    let node = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      if (!node[name]) node[name] = { folders: {} };
      node = node[name].folders!;
    }
    node[parts[parts.length - 1]] = { file: f };
  }
  return tree;
}

/* --- tiny inline icons (no icon dependency) ------------------------------ */

function FolderIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke={expanded ? '#7C3AED' : '#94A3B8'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
      style={{ color: '#94A3B8' }}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

const FILE_COLORS: Record<string, string> = {
  js: '#FBBF24',
  jsx: '#FBBF24',
  ts: '#60A5FA',
  tsx: '#60A5FA',
  html: '#FB923C',
  htm: '#FB923C',
  css: '#C084FC',
  scss: '#C084FC',
  json: '#EAB308',
  md: '#94A3B8',
  py: '#34D399',
  java: '#F87171',
  cpp: '#93C5FD',
  c: '#93C5FD',
  php: '#818CF8',
  rb: '#F87171',
  go: '#22D3EE',
  rs: '#FB923C',
  sql: '#60A5FA',
  xml: '#FDBA74',
  svg: '#4ADE80',
  yaml: '#22D3EE',
  yml: '#22D3EE',
  toml: '#94A3B8',
  sh: '#4ADE80',
  env: '#94A3B8',
};

function FileIcon({ filename }: { filename: string }) {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const color = FILE_COLORS[ext] ?? '#64748B';
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function ZipIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 8v13H3V8" />
      <path d="M1 3h22v5H1z" />
      <line x1="10" y1="12" x2="14" y2="12" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/* --- viewer -------------------------------------------------------------- */

function ToolButton({
  onClick,
  title,
  disabled,
  children,
}: {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 rounded-md border border-surface-600 px-2 py-1 text-[10px] font-medium text-ink-secondary transition-colors hover:border-accent hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-surface-600 disabled:hover:text-ink-secondary"
    >
      {children}
    </button>
  );
}

/**
 * Multi-file project explorer (RDS File-Based block). Shows a collapsible file
 * tree + code viewer with copy / per-file download / whole-project ZIP, plus an
 * HTML preview modal for CDN-style projects. Rendered read-only; `streaming`
 * shows a "Streaming…" pill while the block is still being generated.
 */
export function FileBasedViewer({
  files,
  projectName = 'Project',
  metadata,
  streaming,
}: FileBasedViewerProps) {
  const [activeFilename, setActiveFilename] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  const tree = useMemo(() => buildTree(files), [files]);

  const activeFile =
    files.find((f) => f.filename === activeFilename) ?? files[0] ?? null;

  const htmlEntry = useMemo(() => {
    const byMeta = metadata?.mainEntryPoint
      ? files.find(
          (f) =>
            f.filename === metadata.mainEntryPoint && /\.html?$/i.test(f.filename),
        )
      : undefined;
    if (byMeta) return byMeta;
    return files.find((f) => /\.html?$/i.test(f.filename)) ?? null;
  }, [files, metadata]);

  const previewSrcDoc = useMemo(
    () => (previewOpen && htmlEntry ? buildSrcDoc(htmlEntry.content) : ''),
    [previewOpen, htmlEntry],
  );

  const name = metadata?.projectName || projectName || 'Project';

  const copyActive = async () => {
    if (!activeFile) return;
    try {
      await navigator.clipboard.writeText(activeFile.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const downloadActive = () => {
    if (!activeFile) return;
    const base = activeFile.filename.split('/').pop() ?? 'file';
    const blob = new Blob([activeFile.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = base;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const toggleFolder = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderTree = (items: Record<string, TreeItem>, depth: number, path = ''): ReactNode =>
    Object.entries(items).map(([name, item]) => {
      const fullPath = path ? `${path}/${name}` : name;
      if (item.file) {
        const active = activeFile?.filename === fullPath;
        return (
          <button
            key={fullPath}
            type="button"
            onClick={() => setActiveFilename(fullPath)}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors ${
              active
                ? 'bg-accent/10 text-accent'
                : 'text-ink-secondary hover:bg-surface-800 hover:text-white'
            }`}
            style={{ paddingLeft: `${8 + depth * 16}px` }}
          >
            <FileIcon filename={name} />
            <span className="min-w-0 truncate">{name}</span>
          </button>
        );
      }
      const isCollapsed = collapsed.has(fullPath);
      const childCount = Object.keys(item.folders ?? {}).length;
      return (
        <div key={fullPath}>
          <button
            type="button"
            onClick={() => toggleFolder(fullPath)}
            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px] font-medium text-ink-primary transition-colors hover:bg-surface-800"
            style={{ paddingLeft: `${8 + depth * 16}px` }}
          >
            <ChevronIcon open={!isCollapsed} />
            <FolderIcon expanded={!isCollapsed} />
            <span className="min-w-0 flex-1 truncate">{name}</span>
            <span className="rounded bg-surface-800 px-1.5 py-0.5 text-[10px] font-semibold text-ink-muted">
              {childCount}
            </span>
          </button>
          {!isCollapsed && (
            <div>{renderTree(item.folders ?? {}, depth + 1, fullPath)}</div>
          )}
        </div>
      );
    });

  return (
    <AddonShell type="files" label={name}>
      <div className="flex flex-col">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-surface-700/70 bg-surface-900/60 px-3 py-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-[12px] font-semibold text-ink-primary">
              {name}
            </span>
            <span className="rounded-full bg-surface-800 px-2 py-0.5 text-[10px] font-semibold text-ink-muted">
              {files.length} {files.length === 1 ? 'file' : 'files'}
            </span>
            {metadata?.framework && (
              <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">
                {metadata.framework}
              </span>
            )}
            {metadata?.canRunWithCDN && (
              <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">
                CDN preview
              </span>
            )}
            {streaming && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-yellow-500/10 px-2 py-0.5 text-[10px] font-semibold text-yellow-400">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-yellow-400" />
                Streaming…
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <ToolButton
              onClick={() => htmlEntry && setPreviewOpen(true)}
              title="Preview the HTML entry point"
              disabled={!htmlEntry}
            >
              <EyeIcon />
              Preview
            </ToolButton>
            <ToolButton
              onClick={() => downloadProjectZip(files, name)}
              title="Download project as .zip"
            >
              <ZipIcon />
              Source
            </ToolButton>
          </div>
        </div>

        {/* Body */}
        <div className="flex min-h-[220px]">
          {/* File tree */}
          <div className="max-h-[420px] w-52 shrink-0 overflow-y-auto border-r border-surface-700/70 bg-surface-950/40 p-2">
            {files.length === 0 ? (
              <div className="flex items-center gap-2 px-2 py-3 text-[12px] text-ink-muted">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-muted" />
                Extracting files…
              </div>
            ) : (
              renderTree(tree, 0)
            )}
          </div>

          {/* Code viewer */}
          <div className="flex min-w-0 flex-1 flex-col">
            {activeFile ? (
              <>
                <div className="flex items-center justify-between gap-2 border-b border-surface-700/70 px-3 py-1.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <FileIcon filename={activeFile.filename} />
                    <span className="truncate text-[12px] font-medium text-ink-primary">
                      {activeFile.filename}
                    </span>
                    <span className="shrink-0 rounded bg-surface-800 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-muted">
                      {activeFile.language}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <ToolButton onClick={copyActive} title="Copy file">
                      <CopyIcon />
                      {copied ? 'Copied' : 'Copy'}
                    </ToolButton>
                    <ToolButton onClick={downloadActive} title="Download file">
                      <DownloadIcon />
                    </ToolButton>
                  </div>
                </div>
                <pre className="m-0 max-h-[420px] min-h-[180px] flex-1 overflow-auto bg-surface-950 p-3 text-[12px] leading-relaxed text-ink-primary">
                  <code className="font-mono">{activeFile.content || ' '}</code>
                </pre>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center p-6 text-[12px] text-ink-muted">
                No files to show yet.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* HTML preview modal */}
      {previewOpen && htmlEntry && (
        <div className="fixed inset-0 z-[70] flex flex-col bg-[#0B1120]/95 p-4 backdrop-blur-sm">
          <div className="flex items-center justify-between pb-2">
            <span className="truncate text-[11px] font-medium uppercase tracking-wide text-ink-muted">
              Preview — {htmlEntry.filename}
            </span>
            <button
              type="button"
              onClick={() => setPreviewOpen(false)}
              className="rounded-md border border-surface-600 px-2 py-1 text-[10px] font-semibold text-ink-muted transition hover:border-accent hover:text-accent"
            >
              Close
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto bg-white">
            <iframe
              title="project-preview"
              sandbox="allow-same-origin allow-scripts allow-modals allow-forms allow-popups allow-downloads allow-pointer-lock"
              srcDoc={previewSrcDoc}
              className="block w-full"
              style={{ height: '100%', minHeight: 400 }}
            />
          </div>
        </div>
      )}
    </AddonShell>
  );
}
