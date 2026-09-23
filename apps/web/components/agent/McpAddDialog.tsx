'use client';

import { useMemo, useState } from 'react';
import { ExternalLink, Lock, Plug, Send, Sparkles, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { resolveServerIcon } from '../BrandIconResolver';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';

interface McpStockEntry {
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
}

interface McpAddDialogProps {
  open: boolean;
  stock: {
    task: string | null;
    servers: McpStockEntry[];
    recommendedToAddIds: string[];
  } | null;
  onClose: () => void;
  /** Receives the selected stock entries together with the env keys and OAuth client creds the user filled. */
  onSubmit: (added: Array<{ entry: McpStockEntry; env: Record<string, string>; oauth: { clientId: string; clientSecret: string } }>) => Promise<void>;
}

const MAX_ADD = 8;
const MAX_ACTIVE = 5;

/**
 * "Add MCP from stock" popup. When the agent finds the task needs servers that
 * are only in the stock catalog (not yet added), this dialog lets the user add
 * them with their required keys/OAuth in one go (up to 8 candidates). Only the
 * servers the agent recommended (recommendedToAddIds) are shown. Validation:
 * a server that needs env keys can't be submitted until every key is filled;
 * a manual-OAuth server needs its client id + secret too. Once added, at most
 * MAX_ACTIVE servers are active at once — the agent cycles the rest across
 * loops.
 */
export function McpAddDialog({ open, stock, onClose, onSubmit }: McpAddDialogProps) {
  const candidates = useMemo(() => {
    const pool = stock?.servers ?? [];
    const ids = stock?.recommendedToAddIds ?? [];
    const rec = pool.filter((s) => ids.includes(s.id));
    // Recommended candidates take priority; when none were recommended (e.g. the
    // user clicked "Add MCP server" on the suggestion card itself), fall back to
    // every not-yet-added catalog server so the dialog is always actionable.
    return rec.length > 0 ? rec : pool.filter((s) => !s.added);
  }, [stock]);
  const task = stock?.task ?? null;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creds, setCreds] = useState<Record<string, Record<string, string>>>({});
  const [oauth, setOauth] = useState<Record<string, { clientId: string; clientSecret: string }>>({});
  const [saving, setSaving] = useState(false);

  const [lastKey, setLastKey] = useState('');
  const listKey = useMemo(() => candidates.map((s) => s.id).sort().join(','), [candidates]);
  if (open && listKey !== lastKey) {
    setLastKey(listKey);
    setSelected(new Set());
    setCreds({});
    setOauth({});
  }

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size >= MAX_ADD) return prev;
      else next.add(id);
      return next;
    });
  };

  const setCred = (id: string, key: string, value: string) => {
    setCreds((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), [key]: value } }));
  };

  const setOauthCred = (id: string, field: 'clientId' | 'clientSecret', value: string) => {
    setOauth((prev) => {
      const cur = prev[id] ?? { clientId: '', clientSecret: '' };
      return { ...prev, [id]: { ...cur, [field]: value } };
    });
  };

  const needsKeys = (s: McpStockEntry): boolean => s.envKeys.length > 0;
  const credsValid = (s: McpStockEntry): boolean =>
    !needsKeys(s) || s.envKeys.every((k) => (creds[s.id]?.[k] ?? '').trim().length > 0);
  const oauthValid = (s: McpStockEntry): boolean =>
    !s.manualOAuth ||
    ((oauth[s.id]?.clientId ?? '').trim().length > 0 && (oauth[s.id]?.clientSecret ?? '').trim().length > 0);
  const needsOAuth = (s: McpStockEntry): boolean => s.transport === 'http' || s.manualOAuth;

  const selectedServers = candidates.filter((s) => selected.has(s.id));
  // Submitting is always possible: servers whose keys/OAuth aren't filled here
  // are simply created DISABLED (needsSetup) and finished later on the MCP
  // page — an inline "fill now" option, never a hard blocker.
  const canSubmit = selectedServers.length > 0;
  const hasIncomplete = selectedServers.some((s) => !(credsValid(s) && oauthValid(s)));

  const handleSubmit = async () => {
    if (!canSubmit || saving) return;
    setSaving(true);
    try {
      const added = selectedServers.map((s) => {
        const env: Record<string, string> = {};
        for (const k of s.envKeys) {
          const v = (creds[s.id]?.[k] ?? '').trim();
          if (v) env[k] = v;
        }
        return { entry: s, env, oauth: { ...oauth[s.id] } };
      });
      await onSubmit(added);
    } catch {
      // errors surface via the caller; keep the dialog open on failure
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !saving) onClose(); }}>
      <DialogContent className="sm:max-w-lg border-primary/20 bg-gradient-to-b from-surface-900 to-surface-950 p-0 overflow-hidden">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-400/60 to-transparent" />

        <div className="flex items-start gap-3.5 p-6 pb-3">
          <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-400/10 ring-1 ring-emerald-400/25 shadow-[0_0_24px_-6px_rgba(16,185,129,0.45)]">
            <Plug className="h-5 w-5 text-emerald-300" />
            <span className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
            </span>
          </div>
          <DialogHeader className="space-y-1.5">
            <div className="flex items-center gap-2">
              <DialogTitle className="text-base text-white">Add MCP servers</DialogTitle>
              {candidates.length > 0 && (
                <Badge variant="accent" className="normal-case tracking-wide">
                  {candidates.length} recommended
                </Badge>
              )}
            </div>
            <DialogDescription className="text-[12.5px] leading-relaxed text-ink-muted max-w-sm">
              {task
                ? <>The agent needs these stock MCP servers for the current task — add the ones you want (up to {MAX_ADD} recommended, at most {MAX_ACTIVE} active at once).</>
                : <>Add recommended MCP stock servers (up to {MAX_ADD}; at most {MAX_ACTIVE} active at once).</>}
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="max-h-[46vh] overflow-y-auto px-6 py-3 scrollbar-thin">
          {candidates.length === 0 ? (
            <p className="px-1 py-4 text-[12.5px] text-ink-muted/70">
              No stock servers recommended. Close and continue.
            </p>
          ) : (
            <div className="space-y-3">
              <p className="mb-1.5 flex items-center gap-1.5 px-1 text-[10.5px] font-semibold uppercase tracking-wider text-emerald-300">
                <Sparkles className="h-3 w-3" />
                Recommended for this task
              </p>
              <div className="space-y-2">
                {candidates.map((s) => (
                  <ServerRow
                    key={s.id}
                    entry={s}
                    selected={selected.has(s.id)}
                    maxed={selected.size >= MAX_ADD && !selected.has(s.id)}
                    onToggle={() => toggle(s.id)}
                    creds={creds[s.id] ?? {}}
                    onCred={setCred}
                    oauth={oauth[s.id]}
                    onOauth={(f, v) => setOauthCred(s.id, f, v)}
                    valid={credsValid(s) && oauthValid(s)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border/40 bg-black/10 px-6 py-3.5">
          <div className="flex items-center gap-2 text-[11px] text-ink-muted/60">
            {selectedServers.length > 0 && (
              <Badge variant="outline" className="gap-1">
                <Plug className="h-3 w-3 text-emerald-400" />
                {selectedServers.length}/{MAX_ADD} selected
              </Badge>
            )}
            {selectedServers.some((s) => needsKeys(s) && !credsValid(s)) && (
              <span className="text-amber-400/90">
                <Lock className="mr-1 inline h-3 w-3" />
                {hasIncomplete ? 'Missing keys/OAuth — added disabled, finish on MCP page' : 'Fill required keys to add'}
              </span>
            )}
            {hasIncomplete && !selectedServers.some((s) => needsKeys(s) && !credsValid(s)) && (
              <span className="text-amber-400/90">
                <Lock className="mr-1 inline h-3 w-3" />
                Missing keys/OAuth — added disabled, finish on MCP page
              </span>
            )}
            {selectedServers.some((s) => s.manualOAuth && !oauthValid(s)) && (
              <span className="text-amber-400/90">
                <Lock className="mr-1 inline h-3 w-3" />
                OAuth client id/secret required
              </span>
            )}
            {selectedServers.some((s) => s.transport === 'http' && !s.manualOAuth) && (
              <span className="hidden sm:inline text-ink-muted/70">
                Auto-OAuth servers connect after adding
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
              onClick={handleSubmit}
              disabled={!canSubmit || saving}
              className="bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
            >
              {saving ? (
                <span className="mr-1 inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-emerald-300/30 border-t-emerald-300" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              {saving ? 'Adding…' : selectedServers.length > 0 ? `Add & activate (${selectedServers.length})` : 'Add'}
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
  maxed: boolean;
  onToggle: () => void;
  creds: Record<string, string>;
  onCred: (id: string, key: string, value: string) => void;
  oauth: { clientId: string; clientSecret: string } | undefined;
  onOauth: (field: 'clientId' | 'clientSecret', value: string) => void;
  valid: boolean;
}

function ServerRow({ entry, selected, maxed, onToggle, creds, onCred, oauth, onOauth, valid }: ServerRowProps) {
  const { Icon: SrvIcon, color: srvColor, glyph } = resolveServerIcon(entry.name, entry.icon);
  const isHttp = entry.transport === 'http' || entry.manualOAuth;
  const oauthCreds = oauth ?? { clientId: '', clientSecret: '' };
  const clientIdInvalid = entry.manualOAuth && !oauthCreds.clientId.trim();
  const clientSecretInvalid = entry.manualOAuth && !oauthCreds.clientSecret.trim();
  return (
    <div
      className={cn(
        'rounded-xl border transition-all duration-150',
        selected
          ? 'border-emerald-400/60 bg-emerald-500/[0.08] shadow-[0_0_0_1px_rgba(16,185,129,0.25)]'
          : 'border-border/60 bg-surface-850/40 hover:border-primary/40 hover:bg-surface-800/60',
        maxed && 'opacity-40',
      )}
    >
      <button type="button" onClick={onToggle} disabled={maxed} className="block w-full px-3 py-2.5 text-left disabled:cursor-not-allowed">
        <div className="flex items-start gap-2.5">
          <span
            className={cn(
              'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors',
              selected ? 'border-emerald-400 bg-emerald-500 text-white' : 'border-border bg-surface-900 text-transparent',
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
              <span className="truncate text-[13px] font-medium text-ink-primary">{entry.label || entry.name}</span>
              {entry.category && (
                <span className="rounded-full bg-surface-800 px-1.5 py-px text-[9px] font-medium text-ink-muted">{entry.category}</span>
              )}
              {isHttp && (
                <span className="rounded-full bg-yellow-500/10 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-yellow-300">OAuth</span>
              )}
            </span>
            {entry.description && (
              <span className="mt-0.5 block truncate text-[11px] text-ink-muted">{entry.description}</span>
            )}
            {isHttp && entry.manualOAuth && (
              <span className="mt-0.5 flex items-center gap-1 text-[10.5px] text-sky-300/80">
                <ExternalLink className="h-2.5 w-2.5" />
                Needs OAuth client id + secret to activate
              </span>
            )}
            {isHttp && !entry.manualOAuth && (
              <span className="mt-0.5 flex items-center gap-1 text-[10.5px] text-sky-300/80">
                <ExternalLink className="h-2.5 w-2.5" />
                Added disabled — authorize it after adding
              </span>
            )}
            {!isHttp && entry.envKeys.length > 0 && (
              <span className="mt-0.5 block text-[10.5px] text-sky-300/80">
                needs {entry.envKeys.join(', ')}
                {entry.keyGetLabel ? ` · ${entry.keyGetLabel}` : ''}
              </span>
            )}
          </span>
        </div>
      </button>

      {selected && !isHttp && entry.envKeys.length > 0 && (
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
                  <p className="mt-0.5 text-[10px] text-red-400/80">{key} is required to add this server.</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {selected && entry.manualOAuth && (
        <div className="space-y-2 border-t border-white/[0.06] px-3 py-2.5">
          <div>
            <label className="mb-1 flex items-center gap-1 text-[10.5px] font-medium text-ink-muted">
              <Lock className="h-2.5 w-2.5" />
              OAuth Client ID
              <span className="text-red-400/80">*</span>
            </label>
            <input
              type="text"
              autoComplete="off"
              value={oauthCreds.clientId}
              onChange={(e) => onOauth('clientId', e.target.value)}
              placeholder="OAuth client id…"
              className={cn(
                'w-full rounded-lg border bg-surface-950/70 px-2.5 py-1.5 font-mono text-xs text-white placeholder:text-ink-muted/40 focus:outline-none focus:ring-1',
                clientIdInvalid
                  ? 'border-red-400/40 focus:border-red-400/70 focus:ring-red-400/25'
                  : 'border-border/60 focus:border-primary/50 focus:ring-primary/20',
              )}
            />
            {clientIdInvalid && (
              <p className="mt-0.5 text-[10px] text-red-400/80">OAuth client id is required to add this server.</p>
            )}
          </div>
          <div>
            <label className="mb-1 flex items-center gap-1 text-[10.5px] font-medium text-ink-muted">
              <Lock className="h-2.5 w-2.5" />
              OAuth Client Secret
              <span className="text-red-400/80">*</span>
            </label>
            <input
              type="password"
              autoComplete="off"
              value={oauthCreds.clientSecret}
              onChange={(e) => onOauth('clientSecret', e.target.value)}
              placeholder="OAuth client secret…"
              className={cn(
                'w-full rounded-lg border bg-surface-950/70 px-2.5 py-1.5 font-mono text-xs text-white placeholder:text-ink-muted/40 focus:outline-none focus:ring-1',
                clientSecretInvalid
                  ? 'border-red-400/40 focus:border-red-400/70 focus:ring-red-400/25'
                  : 'border-border/60 focus:border-primary/50 focus:ring-primary/20',
              )}
            />
            {clientSecretInvalid && (
              <p className="mt-0.5 text-[10px] text-red-400/80">OAuth client secret is required to add this server.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}