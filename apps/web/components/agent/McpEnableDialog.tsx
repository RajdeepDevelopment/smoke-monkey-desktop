'use client';

import { useMemo, useState } from 'react';
import { Lock, Plug, Send, Sparkles, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { resolveServerIcon } from '../BrandIconResolver';
import { api } from '../../lib/api';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';

interface McpStockEntry {
  id: string;
  name: string;
  description: string;
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
  /** true = already configured by the user; false = stock-catalog server not added yet. */
  added: boolean;
  recommended: boolean;
  recommendedToEnable: boolean;
  tags: string[];
}

interface McpEnableDialogProps {
  open: boolean;
  stock: {
    task: string | null;
    servers: McpStockEntry[];
    recommendedToEnableIds: string[];
  } | null;
  onClose: () => void;
  onContinue: (enabledNames: string[]) => void;
}

/** Selects only the servers the agent recommends the user enable: the required
 *  ids, restricted to disabled-and-not-yet-active ones. */
function pickEnableCandidates(servers: McpStockEntry[], recommendedIds: string[]): McpStockEntry[] {
  const recs = new Set(recommendedIds);
  return servers.filter((s) => s.added && !s.enabled && !s.activeInRun && recs.has(s.id));
}

/**
 * Dynamic MCP-enable form. Shows ONLY the MCP servers that are currently
 * disabled (so they are not on the system prompt yet), split into:
 *   a) Recommended for the current task (first, highlighted)
 *   b) Other available servers (collapsible)
 * Servers that need credentials (env keys) render inline password inputs with
 * validation; the Continue button only unlocks once required values are filled.
 */
export function McpEnableDialog({ open, stock, onClose, onContinue }: McpEnableDialogProps) {
  const servers = stock?.servers ?? [];
  const recommendedIds = stock?.recommendedToEnableIds ?? [];
  const task = stock?.task ?? null;

  const candidates = useMemo(() => pickEnableCandidates(servers, recommendedIds), [servers, recommendedIds]);
  const recommended = useMemo(
    () => candidates.filter((s) => recommendedIds.includes(s.id)),
    [candidates, recommendedIds],
  );
  const others = useMemo(
    () => candidates.filter((s) => !recommendedIds.includes(s.id)),
    [candidates, recommendedIds],
  );

  // Selection + live credential values keyed by server id → { key: value }.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creds, setCreds] = useState<Record<string, Record<string, string>>>({});
  const [saving, setSaving] = useState(false);
  const [showOthers, setShowOthers] = useState(false);

  // Reset selection whenever the dialog opens with new stock.
  const [lastStockKey, setLastStockKey] = useState<string>('');
  const stockKey = useMemo(() => candidates.map((s) => s.id).sort().join(','), [candidates]);
  if (open && stockKey !== lastStockKey) {
    setLastStockKey(stockKey);
    setSelected(new Set());
    setCreds({});
    setShowOthers(false);
  }

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const setCred = (id: string, key: string, value: string) => {
    setCreds((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), [key]: value } }));
  };

  /** A selected server that carries env keys must have every key filled. */
  const needsCreds = (s: McpStockEntry): boolean => s.envKeys.length > 0;
  const credsValid = (s: McpStockEntry): boolean =>
    !needsCreds(s) || s.envKeys.every((k) => (creds[s.id]?.[k] ?? '').trim().length > 0);

  const selectedServers = candidates.filter((s) => selected.has(s.id));
  const canContinue = selectedServers.length > 0 && selectedServers.every(credsValid);

  const handleContinue = async () => {
    if (!canContinue || saving) return;
    setSaving(true);
    try {
      for (const s of selectedServers) {
        const env: Record<string, string> = {};
        for (const k of s.envKeys) {
          const v = (creds[s.id]?.[k] ?? '').trim();
          if (v) env[k] = v;
        }
        await api.updateMcpServer(s.id, {
          enabled: true,
          ...(Object.keys(env).length > 0 ? { env } : {}),
        });
      }
      onContinue(selectedServers.map((s) => s.name));
    } catch {
      // leave dialog open; errors surface via the caller's toast
    } finally {
      setSaving(false);
    }
  };

  const totalPending = candidates.length;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg border-primary/20 bg-gradient-to-b from-surface-900 to-surface-950 p-0 overflow-hidden">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent" />

        <div className="flex items-start gap-3.5 p-6 pb-3">
          <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/15 ring-1 ring-primary/25 shadow-[0_0_24px_-6px_rgba(59,130,246,0.5)]">
            <Plug className="h-5 w-5 text-[#c4b5fd]" />
            <span className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-60" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-blue-500" />
            </span>
          </div>
          <DialogHeader className="space-y-1.5">
            <div className="flex items-center gap-2">
              <DialogTitle className="text-base text-white">Enable MCP servers</DialogTitle>
              {totalPending > 0 && (
                <Badge variant="accent" className="normal-case tracking-wide">
                  {totalPending} disabled
                </Badge>
              )}
            </div>
            <DialogDescription className="text-[12.5px] leading-relaxed text-ink-muted max-w-sm">
              {task
                ? <>Pick which external tools to enable for this task{totalPending > 0 && <> — only disabled servers are shown</>}.</>
                : <>Select external tool servers to enable{totalPending > 0 && <> — only disabled servers are shown</>}.</>}
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="max-h-[46vh] overflow-y-auto px-6 py-3 scrollbar-thin">
          {candidates.length === 0 ? (
            <p className="px-1 py-4 text-[12.5px] text-ink-muted/70">
              All MCP servers are already enabled. Nothing to configure here.
            </p>
          ) : (
            <div className="space-y-3">
              {recommended.length > 0 && (
                <div>
                  <p className="mb-1.5 flex items-center gap-1.5 px-1 text-[10.5px] font-semibold uppercase tracking-wider text-violet-300">
                    <Sparkles className="h-3 w-3" />
                    Recommended for this task
                  </p>
                  <div className="space-y-2">
                    {recommended.map((s) => (
                      <ServerRow
                        key={s.id}
                        entry={s}
                        selected={selected.has(s.id)}
                        onToggle={() => toggle(s.id)}
                        creds={creds[s.id] ?? {}}
                        onCred={setCred}
                        valid={credsValid(s)}
                        recommended
                      />
                    ))}
                  </div>
                </div>
              )}

              {others.length > 0 && (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowOthers((v) => !v)}
                    className="mb-1.5 flex items-center gap-1.5 rounded px-1 text-[10.5px] font-semibold uppercase tracking-wider text-ink-muted/60 hover:text-ink-secondary"
                  >
                    <span className={cn('transition-transform duration-150', showOthers && 'rotate-90')}>
                      ▸
                    </span>
                    Other available servers ({others.length})
                  </button>
                  {showOthers && (
                    <div className="space-y-2">
                      {others.map((s) => (
                        <ServerRow
                          key={s.id}
                          entry={s}
                          selected={selected.has(s.id)}
                          onToggle={() => toggle(s.id)}
                          creds={creds[s.id] ?? {}}
                          onCred={setCred}
                          valid={credsValid(s)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border/40 bg-black/10 px-6 py-3.5">
          <div className="flex items-center gap-2 text-[11px] text-ink-muted/60">
            {selectedServers.length > 0 && (
              <Badge variant="outline" className="gap-1">
                <Plug className="h-3 w-3 text-primary" />
                {selectedServers.length} selected
              </Badge>
            )}
            {selectedServers.some((s) => needsCreds(s) && !credsValid(s)) && (
              <span className="text-amber-400/90">
                <Lock className="mr-1 inline h-3 w-3" />
                Fill required credentials to continue
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
              <X className="h-3.5 w-3.5" />
              Skip
            </Button>
            <Button
              size="sm"
              onClick={handleContinue}
              disabled={!canContinue || saving}
              className="bg-primary text-white hover:bg-primary-hover"
            >
              <Send className="h-3.5 w-3.5" />
              {saving ? 'Enabling…' : selectedServers.length > 0 ? `Continue (${selectedServers.length})` : 'Continue'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface ServerRowProps {
  entry: McpStockEntry;
  selected: boolean;
  onToggle: () => void;
  creds: Record<string, string>;
  onCred: (id: string, key: string, value: string) => void;
  valid: boolean;
  recommended?: boolean;
}

function ServerRow({ entry, selected, onToggle, creds, onCred, valid, recommended }: ServerRowProps) {
  const { Icon: SrvIcon, color: srvColor, glyph } = resolveServerIcon(entry.name, entry.icon);
  return (
    <div
      className={cn(
        'rounded-xl border transition-all duration-150',
        selected
          ? 'border-blue-400/60 bg-blue-500/[0.10] shadow-[0_0_0_1px_rgba(59,130,246,0.25)]'
          : 'border-border/60 bg-surface-850/40 hover:border-primary/40 hover:bg-surface-800/60',
        recommended && !selected && 'border-violet-400/25',
      )}
    >
      <button type="button" onClick={onToggle} className="block w-full px-3 py-2.5 text-left">
        <div className="flex items-start gap-2.5">
          <span
            className={cn(
              'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors',
              selected ? 'border-blue-400 bg-blue-500 text-white' : 'border-border bg-surface-900 text-transparent',
            )}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M2 5 L4.2 7 L8 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs"
            style={{ backgroundColor: `${srvColor}26`, color: srvColor }}
            title={entry.name}
          >
            {glyph ?? <SrvIcon className="h-4 w-4" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-[13px] font-medium text-ink-primary">{entry.name}</span>
              {recommended && (
                <span className="rounded-full bg-violet-500/10 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-violet-300">
                  Best for task
                </span>
              )}
            </span>
            {entry.description && (
              <span className="mt-0.5 block truncate text-[11px] text-ink-muted">{entry.description}</span>
            )}
          </span>
        </div>
      </button>

      {selected && entry.envKeys.length > 0 && (
        <div className="space-y-2 border-t border-white/[0.06] px-3 py-2.5">
          {entry.envKeys.map((key) => {
            const invalid = !(creds[key] ?? '').trim();
            return (
              <div key={key}>
                <label className="mb-1 flex items-center gap-1 text-[10.5px] font-medium text-ink-muted">
                  <Lock className="h-2.5 w-2.5" />
                  {key}
                  <span className="text-red-400/80">*</span>
                </label>
                <input
                  type="password"
                  autoComplete="off"
                  value={creds[key] ?? ''}
                  onChange={(e) => onCred(entry.id, key, e.target.value)}
                  placeholder={`Enter ${key}…`}
                  className={cn(
                    'w-full rounded-lg border bg-surface-950/70 px-2.5 py-1.5 font-mono text-xs text-white placeholder:text-ink-muted/40 focus:outline-none focus:ring-1',
                    invalid
                      ? 'border-red-400/40 focus:border-red-400/70 focus:ring-red-400/25'
                      : 'border-border/60 focus:border-primary/50 focus:ring-primary/20',
                  )}
                />
                {invalid && (
                  <p className="mt-0.5 text-[10px] text-red-400/80">{key} is required to enable this server.</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}