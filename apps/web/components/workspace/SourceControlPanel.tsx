'use client';

import { memo, useMemo } from 'react';
import { RefreshCw, GitBranch, Plus, Minus, Undo2, Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { ideApi, GIT_STATUS_META, type GitStatusEntry, type GitStatusResult } from '../../lib/ide-api';
import { FileIcon } from './FileIcon';

interface Props {
  workspaceRoot: string;
  status: GitStatusResult | null;
  loading?: boolean;
  onRefresh: () => void;
  onOpenDiff: (relPath: string) => void;
}

export const SourceControlPanel = memo(function SourceControlPanel({
  workspaceRoot,
  status,
  loading,
  onRefresh,
  onOpenDiff,
}: Props) {
  const { staged, changes } = useMemo(() => {
    const entries = status?.entries ?? [];
    return {
      staged: entries.filter((e) => e.x !== '?' && e.x !== ' '),
      changes: entries.filter((e) => e.y !== ' ' || e.x === '?'),
    };
  }, [status]);

  const total = staged.length + changes.length;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Branch header */}
      <div className="glass-border-bottom flex items-center justify-between px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <GitBranch className="h-3 w-3 shrink-0 text-ink-muted" />
          <span className="truncate text-[11px] font-medium text-foreground">
            {status?.branch ?? 'No repository'}
          </span>
          {(status?.ahead ?? 0) > 0 && (
            <span className="shrink-0 rounded-full bg-surface-800 px-1.5 text-[9px] text-ink-secondary">
              ↑{status!.ahead}
            </span>
          )}
          {(status?.behind ?? 0) > 0 && (
            <span className="shrink-0 rounded-full bg-surface-800 px-1.5 text-[9px] text-ink-secondary">
              ↓{status!.behind}
            </span>
          )}
        </div>
        <button
          onClick={onRefresh}
          title="Refresh"
          className="glass-hover rounded p-1 text-ink-muted transition-colors hover:text-foreground"
        >
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        </button>
      </div>

      <div className="scrollbar-thin flex-1 overflow-y-auto pb-2">
        {!workspaceRoot ? (
          <Empty title="No workspace" hint="Open a folder to see source control." />
        ) : status === null ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-ink-muted" />
          </div>
        ) : !status.isRepo ? (
          <Empty title="Not a git repository" hint="Initialize git in this workspace to track changes." />
        ) : total === 0 ? (
          <Empty title="No changes" hint="Your working tree is clean." />
        ) : (
          <>
            <Group label="Changes" count={changes.length}>
              {changes.map((e) => (
                <Row
                  key={`c-${e.path}`}
                  entry={e}
                  onOpenDiff={onOpenDiff}
                  actions={
                    <>
                      <ActBtn
                        title="Stage Changes"
                        onClick={() =>
                          void ideApi
                            .gitStage(workspaceRoot, [e.origPath && e.status === 'D' ? e.origPath : e.path], false)
                            .then(onRefresh)
                            .catch(() => {})
                        }
                      >
                        <Plus className="h-3 w-3" />
                      </ActBtn>
                      <ActBtn
                        title="Discard Changes"
                        danger
                        onClick={() => {
                          if (!window.confirm(`Discard changes in ${e.path}?`)) return;
                          void ideApi.gitDiscard(workspaceRoot, e.path, e.status === 'U').then(onRefresh).catch(() => {});
                        }}
                      >
                        <Undo2 className="h-3 w-3" />
                      </ActBtn>
                    </>
                  }
                />
              ))}
            </Group>

            {staged.length > 0 && (
              <Group label="Staged Changes" count={staged.length}>
                {staged.map((e) => (
                  <Row
                    key={`s-${e.path}`}
                    entry={e}
                    onOpenDiff={onOpenDiff}
                    actions={
                      <ActBtn
                        title="Unstage"
                        onClick={() =>
                          void ideApi.gitStage(workspaceRoot, [e.path], true).then(onRefresh).catch(() => {})
                        }
                      >
                        <Minus className="h-3 w-3" />
                      </ActBtn>
                    }
                  />
                ))}
              </Group>
            )}
          </>
        )}
      </div>
    </div>
  );
});

function Group({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  return (
    <div className="mt-1">
      <div className="flex items-center gap-1 px-2 py-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">{label}</span>
        <span className="ml-auto rounded-full bg-surface-800 px-1.5 text-[9px] font-semibold text-ink-secondary">
          {count}
        </span>
      </div>
      <div>{children}</div>
    </div>
  );
}

function Row({
  entry,
  onOpenDiff,
  actions,
}: {
  entry: GitStatusEntry;
  onOpenDiff: (relPath: string) => void;
  actions?: React.ReactNode;
}) {
  const meta = GIT_STATUS_META[entry.status];
  const name = entry.path.split('/').pop() || entry.path;
  const dir = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
  return (
    <div
      onClick={() => onOpenDiff(entry.path)}
      className="group flex h-[24px] cursor-pointer items-center gap-1.5 px-2 transition-colors hover:bg-white/[0.04]"
      title={`${meta.title}: ${entry.path}`}
    >
      <span className="w-3 shrink-0 text-center text-[10px] font-bold" style={{ color: meta.color }}>
        {meta.label}
      </span>
      <FileIcon name={name} />
      <span className="min-w-0 flex-1 truncate text-[11.5px]" style={{ color: meta.color }} title={entry.path}>
        {name}
      </span>
      {dir && <span className="max-w-[45%] shrink-0 truncate text-[9.5px] text-ink-muted">{dir}</span>}
      <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">{actions}</span>
    </div>
  );
}

function ActBtn({
  children,
  title,
  danger,
  onClick,
}: {
  children: React.ReactNode;
  title: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        'rounded p-0.5 text-ink-muted transition-colors hover:bg-white/10 hover:text-foreground',
        danger && 'hover:text-red-400',
      )}
    >
      {children}
    </button>
  );
}

function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-10 text-center">
      <p className="text-xs font-medium text-ink-secondary">{title}</p>
      {hint && <p className="mt-1 text-[10px] leading-relaxed text-ink-muted">{hint}</p>}
    </div>
  );
}
