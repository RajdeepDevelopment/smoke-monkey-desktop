'use client';

import { useMemo, useState } from 'react';
import { Check, ChevronDown, Loader2, Lock, Plug, Plus, Sparkles, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { resolveServerIcon } from '../BrandIconResolver';

export interface McpStockEntryInline {
  id: string;
  name: string;
  label: string;
  description: string;
  category: string | null;
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  url: string | null;
  icon: string | null;
  enabled: boolean;
  configured: boolean;
  oauthRegistered: boolean;
  oauthConnected: boolean;
  oauthExpiresAt: number | null;
  oauthExpired: boolean;
  envKeys: string[];
  activeInRun: boolean;
  added: boolean;
  keyGetUrl: string | null;
  keyGetLabel: string | null;
  dependency: string;
  remote: boolean;
  manualOAuth: boolean;
  oauthScopes: string | null;
  recommended: boolean;
  recommendedToEnable: boolean;
  recommendedToAdd: boolean;
  tags: string[];
  matchPercent?: number | null;
}

export interface McpStockPayloadInline {
  query?: string | null;
  category?: string | null;
  task?: string | null;
  categories: string[];
  servers: McpStockEntryInline[];
  recommendedIds: string[];
  recommendedToEnableIds: string[];
  recommendedToAddIds: string[];
  counts: {
    total: number;
    configured: number;
    added: number;
    enabled: number;
    active: number;
    needAttention: number;
    stockNotAdded: number;
    stockAdded: number;
    stockCategories: number;
  };
}

interface McpStockInlineProps {
  stock: McpStockPayloadInline;
  stockAction?: { id: string; status: 'adding' | 'done' | 'error'; message?: string } | null;
  oauthConnecting?: string | null;
  onAdd: (entry: McpStockEntryInline) => void;
  onOAuth: (entry: McpStockEntryInline) => void;
  onEnable: (entry: McpStockEntryInline) => void;
  onAddMore: () => void;
  onDismiss: () => void;
}

/**
 * Compact inline MCP stock card rendered in the conversation transcript on
 * every `inspect_mcp_stock` (`mcp.stock`) event, so the inventory the agent
 * scanned is visible in the chat — with one-tap Add / Enable / Connect-OAuth
 * for the servers the agent recommends for the task. Dismissible, caps the
 * visible rows, and expands on demand.
 */
export function McpStockInline({
  stock,
  stockAction,
  oauthConnecting,
  onAdd,
  onOAuth,
  onEnable,
  onAddMore,
  onDismiss,
}: McpStockInlineProps) {
  const { servers, recommendedIds, recommendedToEnableIds, recommendedToAddIds, counts } = stock;
  const [showAll, setShowAll] = useState(false);

  const recIds = useMemo(() => new Set([...recommendedIds, ...recommendedToEnableIds, ...recommendedToAddIds]), [
    recommendedIds,
    recommendedToEnableIds,
    recommendedToAddIds,
  ]);
  const recommended = useMemo(() => servers.filter((s) => recIds.has(s.id)), [servers, recIds]);
  // Configured + enabled rows need no action from the user — collapse them
  // into one compact "Ready to use" line so the card never bloats with
  // servers that already work.
  const readyPending = useMemo(
    () => servers.filter((s) => !recIds.has(s.id) && s.added && s.enabled),
    [servers, recIds],
  );

  const visible = showAll ? servers : recommended;
  const hidden = servers.length - visible.length - readyPending.length;

  const status = (s: McpStockEntryInline) =>
    s.activeInRun ? { label: 'ACTIVE', cls: 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/30' }
    : s.added && s.enabled ? { label: 'Enabled', cls: 'bg-emerald-500/10 text-emerald-300/80 ring-emerald-400/20' }
    : s.added ? { label: 'Disabled', cls: 'bg-amber-500/10 text-amber-300/80 ring-amber-400/20' }
    : s.transport === 'http' || s.manualOAuth || s.envKeys.length > 0
      ? { label: 'Needs setup', cls: 'bg-amber-500/10 text-amber-300/80 ring-amber-400/20' }
      : { label: 'NOT ADDED', cls: 'bg-red-500/10 text-red-300/80 ring-red-400/25' };

  if (!servers.length) return null;

  return (
    <div className="relative animate-fade-in rounded-xl border border-violet-400/20 bg-gradient-to-b from-surface-900/90 to-surface-950/90 shadow-[0_0_30px_-12px_rgba(139,92,246,0.35)]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-violet-400/50 to-transparent" />

      <div className="flex items-center gap-2 px-3 pt-2.5">
        <div className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-primary/15 ring-1 ring-primary/25">
          <Plug className="h-3 w-3 text-violet-300" />
        </div>
        <p className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-ink-primary">
          MCP stock — {counts.configured} configured · {counts.enabled} enabled · {counts.active} active{counts.stockNotAdded > 0 && <> · {counts.stockNotAdded} in catalog</>}
        </p>
        <button
          type="button"
          onClick={onDismiss}
          className="-mr-1 rounded-md p-1 text-ink-muted/60 transition-colors hover:bg-surface-800 hover:text-ink-primary"
          title="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {(stock.task || stock.query || stock.category) && (
        <p className="mt-1 px-3 text-[10.5px] leading-relaxed text-ink-muted/60">
          {stock.task && <span>Task: <span className="text-ink-secondary">{stock.task}</span></span>}
          {stock.task && (stock.query || stock.category) && <span> · </span>}
          {stock.query && <span>query <code className="font-mono text-violet-300/90">{stock.query}</code></span>}
          {stock.query && stock.category && <span> · </span>}
          {stock.category && <span>category <code className="font-mono text-violet-300/90">{stock.category}</code></span>}
        </p>
      )}

      <div className="space-y-1.5 px-2.5 py-2">
        {recommended.length > 0 && (
          <p className="flex items-center gap-1 pl-1 text-[10px] font-semibold uppercase tracking-wider text-violet-300">
            <Sparkles className="h-2.5 w-2.5" />
            Recommended for this task
          </p>
        )}
        {visible.map((s) => {
          const st = status(s);
          const isRec = recIds.has(s.id);
          const adding = stockAction?.id === s.id && stockAction.status === 'adding';
          const oauthBusy = oauthConnecting === s.id;
          return (
            <div
              key={s.id}
              className={cn(
                'rounded-lg border px-2 py-1.5 transition-colors',
                isRec ? 'border-violet-400/30 bg-violet-500/[0.06]' : 'border-border/50 bg-surface-850/40',
              )}
            >
              <div className="flex items-center gap-2">
                <ServerIcon name={s.name} icon={s.icon} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-[12px] font-medium text-ink-primary">{s.name}</span>
                    <span className={cn('rounded-full px-1.5 py-px text-[8.5px] font-semibold uppercase tracking-wide ring-1', st.cls)}>
                      {st.label}
                    </span>
                    {isRec && s.recommended && (
                      <span className="rounded-full bg-violet-500/10 px-1.5 py-px text-[8.5px] font-semibold uppercase tracking-wide text-violet-300">
                        Best for task
                      </span>
                    )}
                  </div>
                  {s.description && (
                    <p className="mt-0.5 truncate text-[10.5px] text-ink-muted">{s.description}</p>
                  )}
                </div>
                {rowAction(s, adding, oauthBusy, onAdd, onOAuth, onEnable)}
              </div>
              {isRec && (s.recommendedToEnable || s.recommendedToAdd) && s.envKeys.length > 0 && (
                <div className="flex items-center gap-1 px-0.5 pt-1.5 text-[10px] text-amber-300/80">
                  <Lock className="h-2.5 w-2.5" />
                  Needs keys: <span className="font-mono">{s.envKeys.join(', ')}</span>
                </div>
              )}
              {adding && (
                <p className="px-0.5 pt-1.5 text-[10px] text-primary">Adding server…</p>
              )}
              {stockAction?.id === s.id && stockAction.status === 'error' && (
                <p className="px-0.5 pt-1.5 text-[10px] text-red-400">{stockAction.message ?? 'Add failed'}</p>
              )}
            </div>
          );
        })}

        {!showAll && readyPending.length > 0 && (
          <div className="flex items-center gap-1.5 rounded-lg border border-border/50 bg-surface-850/40 px-2.5 py-1.5">
            <Check className="h-3 w-3 shrink-0 text-emerald-400" />
            <p className="min-w-0 text-[10px] leading-relaxed text-ink-muted">
              Ready to use: <span className="text-emerald-300/90">{readyPending.map((s) => s.name).join(', ')}</span>
            </p>
          </div>
        )}

        {servers.length > 0 && (
          <div className="flex items-center gap-1.5 px-1 pt-1">
            <button
              type="button"
              onClick={onAddMore}
              className="flex items-center gap-1 rounded-md border border-violet-400/30 bg-violet-500/10 px-2 py-1 text-[10px] font-medium text-violet-200 transition-colors hover:bg-violet-500/20"
            >
              <Plus className="h-2.5 w-2.5" /> Add MCP server
            </button>
            <button
              type="button"
              onClick={onDismiss}
              className="flex items-center gap-1 rounded-md border border-border/40 px-2 py-1 text-[10px] font-medium text-ink-muted transition-colors hover:border-primary/30 hover:text-foreground"
            >
              <X className="h-2.5 w-2.5" /> Skip
            </button>
          </div>
        )}

{hidden > 0 && !showAll && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="flex w-full items-center justify-center gap-1 rounded-lg border border-border/40 px-2 py-1.5 text-[10.5px] text-ink-muted transition-colors hover:border-primary/30 hover:text-foreground"
          >
            <ChevronDown className="h-3 w-3" />
            Show all {servers.length} servers
          </button>
        )}
      </div>
    </div>
  );
}

/** What to render on a row's trailing edge depending on its setup state:
 *  Add (not added), Connect OAuth (added HTTP not connected), Enable (added
 *  disabled that needs no setup), or nothing for already-active/enabled rows. */
function rowAction(
  s: McpStockEntryInline,
  adding: boolean,
  oauthBusy: boolean,
  onAdd: (e: McpStockEntryInline) => void,
  onOAuth: (e: McpStockEntryInline) => void,
  onEnable: (e: McpStockEntryInline) => void,
) {
  if (s.activeInRun) return null;
  if (s.added && s.enabled) return null;
  if (adding) return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />;
  if (oauthBusy) return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />;
  if (s.added && s.transport === 'http' && s.oauthRegistered && !s.oauthConnected) {
    return (
      <button
        type="button"
        onClick={() => onOAuth(s)}
        className="flex shrink-0 items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary transition-colors hover:bg-primary/20"
      >
        <Plug className="h-2.5 w-2.5" /> {s.envKeys.length > 0 ? 'Connect' : 'Connect OAuth'}
      </button>
    );
  }
  if (!s.added) {
    return (
      <button
        type="button"
        onClick={() => onAdd(s)}
        className="flex shrink-0 items-center gap-1 rounded-md border border-violet-400/40 bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-medium text-violet-200 transition-colors hover:bg-violet-500/25"
      >
        <Plus className="h-2.5 w-2.5" /> Add
      </button>
    );
  }
  if (s.added && !s.enabled && s.envKeys.length === 0 && s.transport === 'stdio') {
    return (
      <button
        type="button"
        onClick={() => onEnable(s)}
        className="flex shrink-0 items-center gap-1 rounded-md border border-emerald-400/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20"
      >
        <Plug className="h-2.5 w-2.5" /> Enable
      </button>
    );
  }
  return null;
}

function ServerIcon({ name, icon }: { name: string; icon: string | null }) {
  const { Icon: SrvIcon, color: srvColor, glyph } = resolveServerIcon(name, icon);
  return (
    <span
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px]"
      style={{ backgroundColor: `${srvColor}26`, color: srvColor }}
      title={name}
    >
      {glyph ?? <SrvIcon className="h-3.5 w-3.5" />}
    </span>
  );
}