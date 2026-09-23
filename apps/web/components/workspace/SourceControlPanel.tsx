'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  RefreshCw, GitBranch, Plus, Minus, Undo2, Loader2,
  Download, Upload, CloudDownload, Check, Square, Archive, Eye, Sparkles,
  ChevronDown, ChevronRight, X, Star,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { ideApi, GIT_STATUS_META, type GitStatusEntry, type GitStatusResult } from '../../lib/ide-api';
import { gitApi } from '../../lib/git-api';
import { FileIcon } from './FileIcon';
import { Popover, PopoverTrigger, PopoverContent } from '../ui/popover';

// Lazy markdown — heavier visuals only when a review is actually open.
const Markdown = dynamic(() => import('../Markdown').then((m) => m.Markdown), {
  ssr: false,
  loading: () => <span className="text-ink-muted">…</span>,
});

interface Props {
  workspaceRoot: string;
  status: GitStatusResult | null;
  loading?: boolean;
  onRefresh: () => void;
  onOpenDiff: (relPath: string) => void;
  /** Fetch the next window of git changes (infinite scroll). */
  onLoadMore?: () => void;
  /** True while the next page of git changes is being fetched. */
  loadingMore?: boolean;
  /** True when the backend still has more changes beyond the loaded window. */
  hasMore?: boolean;
  /** Currently selected model on the Agent page — used for AI Git operations. */
  model?: string;
  provider?: string;
}

interface Notice {
  kind: 'error' | 'ok' | 'info';
  text: string;
}

function stripCommitFences(text: string): string {
  return text
    .replace(/^```(?:markdown|md|text)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

function stashName(line: string): string | undefined {
  const m = /^(stash@\{\d+\})/.exec(line.trim());
  return m ? m[1] : undefined;
}

export const SourceControlPanel = memo(function SourceControlPanel({
  workspaceRoot,
  status,
  loading,
  onRefresh,
  onOpenDiff,
  onLoadMore,
  loadingMore,
  hasMore,
  model,
  provider,
}: Props) {
  const { staged, changes } = useMemo(() => {
    const entries = status?.entries ?? [];
    return {
      staged: entries.filter((e) => e.x !== '?' && e.x !== ' '),
      changes: entries.filter((e) => e.y !== ' ' || e.x === '?'),
    };
  }, [status]);

  const total = status?.total ?? (staged.length + changes.length);
  const isRepo = !!status?.isRepo && !!workspaceRoot;

  const handleStageAll = async () => {
    if (!isRepo) return;
    await runOp(
      'stage',
      async () => {
        await ideApi.gitStage(workspaceRoot, [], false, true);
        return { ok: true };
      },
      'All changes staged.',
    );
  };

  const handleUnstageAll = async () => {
    if (!isRepo) return;
    await runOp(
      'stage',
      async () => {
        await ideApi.gitStage(workspaceRoot, [], true, true);
        return { ok: true };
      },
      'Staged changes unstaged.',
    );
  };

  // ── UI state ────────────────────────────────────────────────────────────
  const [commitMsg, setCommitMsg] = useState('');
  const [genMode, setGenMode] = useState<'auto' | 'wording'>('auto');
  const [instruction, setInstruction] = useState('');
  const [wordingOpen, setWordingOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [reviewMd, setReviewMd] = useState('');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [stashes, setStashes] = useState<string[]>([]);
  const [stashMsg, setStashMsg] = useState('');
  const [stashOpen, setStashOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [branchName, setBranchName] = useState('');
  const [branchOpen, setBranchOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Infinite scroll: when the user reaches the bottom of the list and the
  // backend still has changes, pull the next page. Guarded by hasMore so we
  // never fetch when everything is already loaded.
  const onScroll = useCallback(() => {
    if (!onLoadMore || loadingMore || !hasMore) return;
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 64) {
      onLoadMore();
    }
  }, [onLoadMore, loadingMore, hasMore]);

  const loadStashes = useCallback(() => {
    if (!workspaceRoot) return;
    ideApi.gitStashes(workspaceRoot).then((r) => setStashes(r.stashes || [])).catch(() => {});
  }, [workspaceRoot]);

  const loadBranches = useCallback(() => {
    if (!workspaceRoot) return;
    ideApi.gitBranches(workspaceRoot).then((r) => setBranches(r.branches || [])).catch(() => {});
  }, [workspaceRoot]);

  // Stashes follow the git status (reloads on every refresh / commit).
  useEffect(() => {
    loadStashes();
  }, [status, loadStashes]);

  // Abort any in-flight Git-agent stream when the panel unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  const canGenerate = isRepo && total > 0 && !generating && !reviewing;

  // ── Helpers ─────────────────────────────────────────────────────────────
  const flash = (kind: Notice['kind'], text: string) => setNotice({ kind, text });

  const runOp = async (
    op: string,
    run: () => Promise<{ ok?: boolean; error?: string } | undefined>,
    successText: string,
    refresh = true,
  ): Promise<boolean> => {
    setBusy(op);
    setNotice(null);
    try {
      const res = await run();
      if (res && res.ok === false) {
        flash('error', res.error || 'Operation failed.');
        return false;
      }
      flash('ok', successText);
      if (refresh) onRefresh();
      return true;
    } catch (err: any) {
      flash('error', String(err?.message || err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const handleGenerate = async () => {
    if (!canGenerate) return;
    setGenerating(true);
    setNotice(null);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    let acc = '';
    try {
      const wording = genMode === 'wording' ? instruction.trim() || undefined : undefined;
      for await (const ev of gitApi.streamCommitMessage(
        { cwd: workspaceRoot, instruction: wording, model, provider },
        controller.signal,
      )) {
        if (ev.type === 'git.delta' && ev.delta) {
          acc += ev.delta;
          setCommitMsg(stripCommitFences(acc));
        } else if (ev.type === 'git.done' && ev.message && !acc) {
          // Non-streaming providers skip git.delta — land the full message at once.
          setCommitMsg(stripCommitFences(ev.message));
        } else if (ev.type === 'git.error' && ev.error) {
          flash('error', ev.error);
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      flash('error', err?.message || 'Commit-message generation failed.');
    } finally {
      setGenerating(false);
      abortRef.current = null;
    }
  };

  const handleReview = async () => {
    if (!canGenerate) return;
    setReviewing(true);
    setNotice(null);
    setReviewMd('');
    setReviewOpen(true);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    let md = '';
    try {
      const wording = genMode === 'wording' ? instruction.trim() || undefined : undefined;
      for await (const ev of gitApi.streamReview(
        { cwd: workspaceRoot, instruction: wording, model, provider },
        controller.signal,
      )) {
        if (ev.type === 'git.delta' && ev.delta) {
          md += ev.delta;
          setReviewMd(md);
        } else if (ev.type === 'git.done' && ev.markdown && !md) {
          setReviewMd(ev.markdown);
        } else if (ev.type === 'git.error' && ev.error) {
          flash('error', ev.error);
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      flash('error', err?.message || 'Review failed.');
    } finally {
      setReviewing(false);
      abortRef.current = null;
    }
  };

  const stopStreaming = () => abortRef.current?.abort();

  const handleCommit = async () => {
    if (!commitMsg.trim()) {
      flash('error', 'Write (or generate) a commit message first.');
      return;
    }
    const ok = await runOp(
      'commit',
      () => ideApi.gitCommit(workspaceRoot, stripCommitFences(commitMsg), false),
      'Committed.',
    );
    if (ok) setCommitMsg('');
  };

  const handleInit = async () => {
    await runOp('init', () => ideApi.gitInit(workspaceRoot), 'Repository initialized.');
  };

  const handleStashPush = async () => {
    const ok = await runOp(
      'stash',
      async () => {
        const res = await ideApi.gitStashPush(workspaceRoot, stashMsg.trim() || undefined);
        loadStashes();
        return res;
      },
      'Changes stashed.',
    );
    if (ok) {
      setStashMsg('');
      setStashOpen(false);
    }
  };

  const handleStashApply = async (name?: string) => {
    await runOp('stash', () => ideApi.gitStashApply(workspaceRoot, name), 'Stash applied.');
  };

  const handleStashPop = async (name?: string) => {
    await runOp('stash', async () => {
      const res = await ideApi.gitStashPop(workspaceRoot, name);
      loadStashes();
      return res;
    }, 'Stash popped.');
  };

  const handleStashDrop = async (name: string) => {
    if (!window.confirm(`Drop ${name}?`)) return;
    await runOp('stash', async () => {
      const res = await ideApi.gitStashDrop(workspaceRoot, name);
      loadStashes();
      return res;
    }, 'Stash dropped.');
  };

  const handleCreateBranch = async () => {
    const name = branchName.trim();
    if (!/^[A-Za-z0-9._/-]+$/.test(name)) {
      flash('error', 'Enter a valid branch name.');
      return;
    }
    const ok = await runOp('branch', async () => {
      const res = await ideApi.gitCreateBranch(workspaceRoot, name);
      loadBranches();
      return res;
    }, `Created + switched to ${name}.`);
    if (ok) {
      setBranchName('');
      setBranchOpen(false);
    }
  };

  const handleSwitchBranch = async (name: string) => {
    if (name === status?.branch) {
      setBranchOpen(false);
      return;
    }
    await runOp('branch', () => ideApi.gitSwitchBranch(workspaceRoot, name), `Switched to ${name}.`);
    setBranchOpen(false);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Branch header */}
      <div className="glass-border-bottom flex items-center justify-between px-3 py-1.5">
        {isRepo ? (
          <>
            <Popover open={branchOpen} onOpenChange={setBranchOpen}>
              <PopoverTrigger asChild>
                <button
                  className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-white/[0.04]"
                  title="Branches · click to switch / create"
                >
                  <GitBranch className="h-3 w-3 shrink-0 text-ink-muted" />
                  <span className="truncate text-[11px] font-medium text-foreground">{status?.branch}</span>
                  <ChevronDown className="h-2.5 w-2.5 shrink-0 text-ink-muted" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" sideOffset={6} className="w-64 p-2">
                <div className="space-y-1">
                  <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">Branches</p>
                  <div className="max-h-40 space-y-0.5 overflow-y-auto scrollbar-thin">
                    {branches.map((b) => (
                      <button
                        key={b}
                        onClick={() => handleSwitchBranch(b)}
                        className={cn(
                          'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] transition-colors hover:bg-white/[0.05]',
                          b === status?.branch && 'bg-primary-subtle text-foreground',
                        )}
                      >
                        <GitBranch className="h-2.5 w-2.5 text-ink-muted" />
                        <span className="min-w-0 flex-1 truncate">{b}</span>
                        {b === status?.branch && <Check className="h-2.5 w-2.5 text-primary" />}
                      </button>
                    ))}
                  </div>
                  <div className="mt-1 flex items-center gap-1 border-t border-border pt-1.5">
                    <input
                      value={branchName}
                      onChange={(e) => setBranchName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleCreateBranch(); }}
                      placeholder="New branch name…"
                      className="glass-panel min-w-0 flex-1 rounded-md px-2 py-1 text-[11px] outline-none focus:ring-1 focus:ring-ring"
                    />
                    <button
                      onClick={handleCreateBranch}
                      disabled={busy === 'branch'}
                      className="glass-hover rounded-md px-1.5 py-1 text-primary transition-colors hover:text-primary"
                      title="Create + switch"
                    >
                      {busy === 'branch' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                    </button>
                  </div>
                </div>
              </PopoverContent>
            </Popover>

            {(status?.ahead ?? 0) > 0 && (
              <span className="shrink-0 rounded-full bg-surface-800 px-1.5 text-[9px] text-ink-secondary">↑{status!.ahead}</span>
            )}
            {(status?.behind ?? 0) > 0 && (
              <span className="shrink-0 rounded-full bg-surface-800 px-1.5 text-[9px] text-ink-secondary">↓{status!.behind}</span>
            )}
          </>
        ) : (
          <span className="truncate text-[11px] font-medium text-ink-muted">No repository</span>
        )}

        <div className="flex shrink-0 items-center gap-0.5">
          {isRepo && (
            <>
              <HeaderBtn title="Pull" busy={busy === 'pull'} disabled={busy !== null} onClick={() => runOp('pull', () => ideApi.gitPull(workspaceRoot), 'Pulled.')}>
                <Download className="h-3 w-3" />
              </HeaderBtn>
              <HeaderBtn title="Push" busy={busy === 'push'} disabled={busy !== null} onClick={() => runOp('push', () => ideApi.gitPush(workspaceRoot, false), 'Pushed.')}>
                <Upload className="h-3 w-3" />
              </HeaderBtn>
              <HeaderBtn title="Fetch" busy={busy === 'fetch'} disabled={busy !== null} onClick={() => runOp('fetch', () => ideApi.gitFetch(workspaceRoot), 'Fetched.')}>
                <CloudDownload className="h-3 w-3" />
              </HeaderBtn>
            </>
          )}
          <button
            onClick={onRefresh}
            title="Refresh"
            className="glass-hover rounded p-1 text-ink-muted transition-colors hover:text-foreground"
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          </button>
        </div>
      </div>

      <div className="scrollbar-thin flex-1 overflow-y-auto pb-2" ref={scrollRef} onScroll={onScroll}>
        {!workspaceRoot ? (
          <Empty title="No workspace" hint="Open a folder to see source control." />
        ) : status === null ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-ink-muted" />
          </div>
        ) : !status.isRepo ? (
          <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
            <p className="text-xs font-medium text-ink-secondary">Not a git repository</p>
            <p className="mt-1 text-[10px] leading-relaxed text-ink-muted">
              Initialize git in this workspace to track changes.
            </p>
            <button
              onClick={handleInit}
              disabled={busy === 'init'}
              className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
            >
              {busy === 'init' ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitBranch className="h-3 w-3" />}
              Initialize Repository
            </button>
          </div>
        ) : (
          <>
            {/* Commit area */}
            <CommitBox
              commitMsg={commitMsg}
              setCommitMsg={setCommitMsg}
              genMode={genMode}
              setGenMode={setGenMode}
              instruction={instruction}
              setInstruction={setInstruction}
              wordingOpen={wordingOpen}
              setWordingOpen={setWordingOpen}
              generating={generating}
              reviewing={reviewing}
              canGenerate={canGenerate}
              onGenerate={handleGenerate}
              onStop={stopStreaming}
              onReview={handleReview}
              onCommit={handleCommit}
              committing={busy === 'commit'}
              model={model}
            />

            {reviewOpen && (
              <div className="mx-2 mt-2 rounded-lg border border-border bg-surface-800/40">
                <div className="flex items-center justify-between px-2 py-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                    {reviewing ? 'Reviewing…' : 'Commit Review'}
                  </span>
                  <button onClick={() => setReviewOpen(false)} className="rounded p-0.5 text-ink-muted hover:text-foreground" title="Close review">
                    <X className="h-3 w-3" />
                  </button>
                </div>
                {reviewing && reviewMd === '' ? (
                  <div className="flex items-center gap-2 px-2 pb-2 text-[10px] text-ink-muted">
                    <Loader2 className="h-3 w-3 animate-spin" /> Inspecting git status and diffs…
                  </div>
                ) : (
                  <div className="prose-dark scrollbar-thin max-h-64 overflow-y-auto px-2 pb-2 text-[11px] leading-relaxed text-ink-primary">
                    <Markdown content={reviewMd} />
                  </div>
                )}
              </div>
            )}

            {/* Stashes */}
            <div className="mt-1 border-t border-border/60 pt-1">
              <div className="flex items-center gap-1 px-2 py-1">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">Stashes</span>
                <span className="ml-auto rounded-full bg-surface-800 px-1.5 text-[9px] font-semibold text-ink-secondary">
                  {stashes.length}
                </span>
                <button
                  onClick={() => setStashOpen(!stashOpen)}
                  className="glass-hover flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-ink-muted transition-colors hover:text-foreground"
                  disabled={busy === 'stash'}
                  title={stashOpen ? 'Close stash box' : 'Stash all changes'}
                >
                  <Archive className="h-3 w-3" />
                  {stashOpen ? 'Cancel' : 'Stash'}
                </button>
              </div>

              {stashOpen && (
                <div className="flex items-center gap-1 px-2 pb-1">
                  <input
                    value={stashMsg}
                    onChange={(e) => setStashMsg(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleStashPush(); }}
                    placeholder="Stash message (optional)"
                    className="glass-panel min-w-0 flex-1 rounded-md px-2 py-1 text-[10.5px] outline-none focus:ring-1 focus:ring-ring"
                  />
                  <button
                    onClick={handleStashPush}
                    disabled={busy === 'stash'}
                    className="glass-hover rounded-md px-1.5 py-1 text-primary"
                    title="Stash changes"
                  >
                    {busy === 'stash' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Archive className="h-3 w-3" />}
                  </button>
                </div>
              )}

              {stashes.length > 0 && (
                <div>
                  {stashes.map((line) => {
                    const name = stashName(line);
                    return (
                      <div key={line} className="group flex items-center gap-1.5 px-2 py-1">
                        <Archive className="h-2.5 w-2.5 shrink-0 text-ink-muted" />
                        <span className="min-w-0 flex-1 truncate text-[10.5px] text-ink-secondary" title={line}>
                          {line}
                        </span>
                        <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                          <ActBtn title="Apply Stash" onClick={() => handleStashApply(name)}>
                            <Download className="h-3 w-3" />
                          </ActBtn>
                          <ActBtn title="Pop Stash" onClick={() => handleStashPop(name)}>
                            <Check className="h-3 w-3" />
                          </ActBtn>
                          <ActBtn title="Drop Stash" danger onClick={() => name && handleStashDrop(name)}>
                            <X className="h-3 w-3" />
                          </ActBtn>
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Changes */}
            <Group
              label="Changes"
              count={changes.length}
              actions={
                changes.length > 0 && (
                  <ActBtn title="Stage all changes" onClick={() => void handleStageAll()}>
                    <Plus className="h-3 w-3" />
                  </ActBtn>
                )
              }
            >
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
              <Group
                label="Staged Changes"
                count={staged.length}
                actions={
                  <ActBtn title="Unstage all changes" onClick={() => void handleUnstageAll()}>
                    <Minus className="h-3 w-3" />
                  </ActBtn>
                }
              >
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

            {total === 0 && (
              <Empty title="No changes" hint="Your working tree is clean." />
            )}

            {total > 0 && (hasMore || loadingMore) && (
              <div className="flex items-center justify-center gap-1.5 px-3 py-2 text-[10px] text-ink-muted">
                {loadingMore ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" /> Loading more…
                  </>
                ) : hasMore ? (
                  <span>Scroll for more changes</span>
                ) : null}
              </div>
            )}
          </>
        )}
      </div>

      {/* Status flash */}
      {notice && (
        <div
          className={cn(
            'glass-border-top flex items-center gap-1.5 px-3 py-1.5 text-[10.5px]',
            notice.kind === 'error' ? 'text-red-400' : notice.kind === 'ok' ? 'text-green-400' : 'text-ink-secondary',
          )}
        >
          <span className="h-1 w-1 shrink-0 rounded-full bg-current" />
          <span className="min-w-0 flex-1 truncate">{notice.text}</span>
          <button onClick={() => setNotice(null)} className="shrink-0 rounded p-0.5 text-ink-muted hover:text-foreground" title="Dismiss">
            <X className="h-2.5 w-2.5" />
          </button>
        </div>
      )}
    </div>
  );
});

function HeaderBtn({
  children, title, busy, disabled, onClick,
}: {
  children: React.ReactNode;
  title: string;
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="glass-hover rounded p-1 text-ink-muted transition-colors hover:text-foreground disabled:opacity-40"
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : children}
    </button>
  );
}

function CommitBox({
  commitMsg, setCommitMsg,
  genMode, setGenMode,
  instruction, setInstruction,
  wordingOpen, setWordingOpen,
  generating, reviewing, canGenerate,
  onGenerate, onStop, onReview, onCommit,
  committing, model,
}: {
  commitMsg: string;
  setCommitMsg: (v: string) => void;
  genMode: 'auto' | 'wording';
  setGenMode: (v: 'auto' | 'wording') => void;
  instruction: string;
  setInstruction: (v: string) => void;
  wordingOpen: boolean;
  setWordingOpen: (v: boolean) => void;
  generating: boolean;
  reviewing: boolean;
  canGenerate: boolean;
  onGenerate: () => void;
  onStop: () => void;
  onReview: () => void;
  onCommit: () => void;
  committing: boolean;
  model?: string;
}) {
  return (
    <div className="mt-1 border-t border-border/60 pt-1">
      <div className="px-2 py-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">Commit</span>
      </div>
      <div className="px-2">
        <textarea
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          placeholder="Commit message…"
          rows={2}
          className="glass-panel scrollbar-thin w-full resize-none rounded-md px-2 py-1.5 text-[11.5px] leading-relaxed outline-none focus:ring-1 focus:ring-ring"
        />

        {/* Wording-mode toggle */}
        <button
          onClick={() => setWordingOpen(!wordingOpen)}
          className="mt-1 flex items-center gap-1 text-[10px] text-ink-muted transition-colors hover:text-foreground"
        >
          {wordingOpen ? <ChevronDown className="h-2.5 w-2.5" /> : <ChevronRight className="h-2.5 w-2.5" />}
          Tell the agent what the commit should say
        </button>
        {wordingOpen && (
          <div className="mt-1 rounded-md border border-border bg-surface-800/40 p-1.5">
            <input
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onFocus={() => setGenMode('wording')}
              placeholder='e.g. "Mention that JWT validation was fixed"'
              className="glass-panel w-full rounded-md px-2 py-1 text-[10.5px] outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        )}

        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {generating || reviewing ? (
            <Cta onClick={onStop} title="Stop" className="bg-surface-800 text-ink-secondary">
              <Square className="h-3 w-3" />
              Stop
            </Cta>
          ) : (
            <>
              <Cta onClick={onGenerate} disabled={!canGenerate} title="Generate commit message with the Git agent" className="bg-primary/15 text-primary hover:bg-primary/25">
                {generating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                Generate
              </Cta>
              <Cta onClick={onReview} disabled={!canGenerate} title="Review changes with the Git agent" className="bg-surface-800 text-ink-secondary">
                <Eye className="h-3 w-3" />
                Review
              </Cta>
            </>
          )}

          <span className="ml-auto flex min-w-0 items-center gap-1 text-[9px] text-ink-muted" title={`Using ${model || 'default model'}`}>
            <Star className="h-2.5 w-2.5 shrink-0 text-primary/70" />
            <span className="truncate">{model || 'agent model'}</span>
          </span>

          <button
            onClick={onCommit}
            disabled={committing || !commitMsg.trim()}
            className="ml-1 inline-flex shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[10.5px] font-semibold text-white transition-colors hover:bg-primary/90 disabled:opacity-40"
            title="Commit staged changes"
          >
            {committing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
            Commit
          </button>
        </div>
      </div>
    </div>
  );
}

function Cta({
  children, onClick, disabled, title, className,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        className,
      )}
    >
      {children}
    </button>
  );
}

function Group({
  label, count, actions, children,
}: {
  label: string;
  count: number;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-1">
      <div className="flex items-center gap-1 px-2 py-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">{label}</span>
        <span className="ml-auto shrink-0 rounded-full bg-surface-800 px-1.5 text-[9px] font-semibold text-ink-secondary">
          {count}
        </span>
        {actions && <span className="flex shrink-0 items-center gap-0.5">{actions}</span>}
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
      <span className="min-w-[8ch] flex-1 truncate text-[11.5px]" style={{ color: meta.color }} title={entry.path}>
        {name}
      </span>
      {dir && <span className="min-w-0 max-w-[42%] shrink truncate text-[9.5px] text-ink-muted">{dir}</span>}
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