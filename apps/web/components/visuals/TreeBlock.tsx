'use client';

import { memo, useMemo } from 'react';
import { ChevronRight, File, FileText, Folder, FolderOpen } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * Directory / object TREE block. The model wraps JSON between
 * <tree-st>…<tree-ed>:
 *
 *   <tree-st>
 *   { "name": "project", "children": [ … ] }
 *   <tree-ed>
 *
 * Rendered as an indented, aligned file-tree (folders / files) in a premium
 * dark card. All labels are escaped React text — never raw HTML.
 */

export function parseTree(json: string): { name: string; children: TreeChild[] } | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const root = parsed as Record<string, unknown>;
    const children = Array.isArray(root.children) ? (root.children.map(asChild).filter(Boolean) as TreeChild[]) : [];
    return { name: str(root.name ?? 'root'), children };
  } catch {
    return null;
  }
}

interface TreeChild {
  name: string;
  children: TreeChild[];
}

function str(v: unknown): string {
  return v == null ? '' : String(v);
}

function asChild(v: unknown): TreeChild | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    const name = str(v);
    if (!name) return null;
    return { name, children: [] };
  }
  const o = v as Record<string, unknown>;
  const name = str(o.name ?? o.label ?? o.path);
  if (!name) return null;
  const children = Array.isArray(o.children) ? (o.children.map(asChild).filter(Boolean) as TreeChild[]) : [];
  return { name, children };
}

const LEAF_EXTS = new Set(['js', 'ts', 'jsx', 'tsx', 'json', 'md', 'css', 'py', 'go', 'rs', 'vue', 'svelte', 'html']);

function isFolder(node: TreeChild): boolean {
  return node.children.length > 0;
}

function NodeRow({ node, depth }: { node: TreeChild; depth: number }) {
  const folder = isFolder(node);
  const Icon: LucideIcon = folder ? (depth === 0 ? FolderOpen : Folder) : File;
  const ext = node.name.includes('.') ? node.name.split('.').pop() ?? '' : '';
  const FileIcon: LucideIcon = LEAF_EXTS.has(ext) ? FileText : File;
  return (
    <li role="treeitem" aria-expanded={folder ? true : undefined}>
      <div
        className="flex items-center gap-1.5 py-[3px]"
        style={{ paddingLeft: depth * 16 }}
      >
        {folder ? (
          <>
            <ChevronRight className="h-3 w-3 shrink-0 rotate-90 text-ink-muted" />
            <Icon className="h-3.5 w-3.5 shrink-0 text-sky-400" fill="currentColor" strokeWidth={1.6} />
          </>
        ) : (
          <>
            <ChevronRight className="h-3 w-3 shrink-0 text-transparent" />
            <FileIcon className="h-3.5 w-3.5 shrink-0 text-ink-secondary" />
          </>
        )}
        <span
          className={cn(
            'truncate text-[12px] leading-snug',
            folder ? 'font-medium text-foreground' : 'text-ink-secondary',
          )}
        >
          {node.name}
        </span>
      </div>
      {folder && (
        <ul role="group" className="list-none">
          {node.children.map((c, i) => (
            <NodeRow key={`${depth}-${i}-${c.name}`} node={c} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Renders a <tree-st>…<tree-ed> JSON body as an indented file-tree card. */
export const TreeBlock = memo(function TreeBlock({ json }: { json: string }) {
  const tree = useMemo(() => parseTree(json), [json]);
  if (!tree) {
    return (
      <div className="my-1.5 rounded-md border border-surface-700 bg-surface-900 px-2.5 py-1.5 text-[11px] text-ink-muted">
        Couldn’t render tree block.
      </div>
    );
  }
  return (
    <section className="premium-card relative my-1.5 overflow-hidden rounded-lg border border-surface-700 bg-gradient-to-b from-surface-850 to-surface-900 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.5)]">
      <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />
      <header className="flex items-center gap-2 border-b border-surface-700/60 bg-gradient-to-b from-white/[0.02] to-transparent px-2.5 py-1.5">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-emerald-500/10">
          <FolderOpen className="h-3 w-3 text-emerald-400" fill="currentColor" strokeWidth={1.6} />
        </span>
        <h4 className="flex items-center gap-1.5 truncate text-[11px] font-semibold tracking-tight text-foreground">
          {tree.name}
        </h4>
        <span className="ml-auto shrink-0 rounded-full bg-surface-800 px-1.5 py-px text-[9.5px] font-medium tabular-nums text-ink-muted">
          {countNodes(tree)} files
        </span>
      </header>
      <div className="px-2 py-2">
        <ul role="tree" className="max-h-72 overflow-auto px-2 py-1">
          {tree.children.map((c, i) => (
            <NodeRow key={`r-${i}-${c.name}`} node={c} depth={0} />
          ))}
        </ul>
      </div>
    </section>
  );
});

function countNodes(node: TreeChild): number {
  return node.children.reduce((acc, c) => acc + countLeaves(c), 0);
}
function countLeaves(node: TreeChild): number {
  if (!isFolder(node)) return 1;
  return node.children.reduce((acc, c) => acc + countLeaves(c), 0);
}