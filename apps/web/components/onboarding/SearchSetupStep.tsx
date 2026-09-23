'use client';

import { useEffect, useState } from 'react';
import { Globe, Check, Loader2, Search } from 'lucide-react';
import { api } from '../../lib/api';
import { Switch } from '../ui/switch';

const SEARCH_PROVIDERS = [
  { id: 'tavily', label: 'Tavily', placeholder: 'tvly-…' },
  { id: 'brave', label: 'Brave Search', placeholder: 'BSA…' },
  { id: 'bing', label: 'Bing', placeholder: 'Key…' },
];

export function SearchSetupStep() {
  const [enabled, setEnabled] = useState(false);
  const [serverEnabled, setServerEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    api
      .fetchSettings()
      .then((s) => {
        setEnabled(s.webSearch.enabled);
        setServerEnabled(s.webSearch.serverEnabled);
      })
      .catch(() => setServerEnabled(false));
  }, []);

  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      const res = await api.setWebSearchEnabled(next);
      setEnabled(res.webSearch.enabled);
    } finally {
      setBusy(false);
    }
  };

  const saveKey = async (provider: string) => {
    const v = values[provider];
    if (!v) return;
    setBusy(true);
    try {
      await api.saveKey(provider, v);
      setValues((prev) => ({ ...prev, [provider]: '' }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <h3 className="text-xl font-semibold tracking-tight text-ink-primary">Web search</h3>
        <p className="text-sm text-ink-muted">
          Let the AI search the web for fresh, current information when your question needs it.
        </p>
      </div>

      <div className="rounded-2xl border border-surface-700 bg-surface-900 p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-subtle text-accent">
              <Globe className="h-5 w-5" />
            </span>
            <div>
              <p className="text-sm font-semibold text-ink-primary">Live web search</p>
              <p className="mt-0.5 text-xs text-ink-muted">
                Adds current info from the web to relevant answers.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {busy && <Loader2 className="h-4 w-4 animate-spin text-ink-muted" />}
            <Switch
              checked={enabled}
              disabled={!serverEnabled || busy}
              onCheckedChange={(v) => void toggle(v)}
              aria-label="Toggle live web search"
            />
          </div>
        </div>
      </div>

      {serverEnabled && enabled && (
        <div className="space-y-2.5">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink-muted">
            <Search className="h-3.5 w-3.5" />
            Optional — search provider keys
          </div>
          {SEARCH_PROVIDERS.map((p) => (
            <form
              key={p.id}
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void saveKey(p.id);
              }}
            >
              <span className="w-28 shrink-0 text-sm text-ink-secondary">{p.label}</span>
              <input
                className="input h-9 flex-1 font-mono text-xs"
                type="password"
                placeholder={p.placeholder}
                value={values[p.id] ?? ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [p.id]: e.target.value }))}
                autoComplete="off"
              />
              <button
                className="btn-primary h-9 shrink-0 px-3"
                type="submit"
                disabled={busy || !values[p.id]}
              >
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                <span className="sr-only">Save</span>
              </button>
            </form>
          ))}
        </div>
      )}

      {!serverEnabled && (
        <p className="rounded-lg border border-warning/20 bg-warning-subtle px-3 py-2.5 text-xs text-amber-200">
          Web search is disabled by the server administrator.
        </p>
      )}
    </div>
  );
}
