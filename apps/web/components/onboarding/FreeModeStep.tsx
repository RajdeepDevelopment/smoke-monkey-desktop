'use client';

import { useEffect, useState } from 'react';
import { Check, Sparkles, PackageCheck, Zap, Layers, Boxes } from 'lucide-react';
import { api } from '../../lib/api';
import { BrandIconFor } from '../BrandIconResolver';

const PERKS = [
  '100+ free models — Kimi, Claude, GPT, Gemini, DeepSeek & more',
  'No API key, no signup, no credit card required',
  'Big Pickle auto-selected as your free model',
  'Auto-routing & fallback so you never hit a dead model',
];

const MCP_SHOWCASE: Array<{ name: string; how: string }> = [
  {
    name: 'Memory (Knowledge Graph)',
    how: 'Persistent agent memory — stores entities, relations & observations automatically. Enabled by default.',
  },
  {
    name: 'Apify',
    how: '3,000+ web scraping & automation actors — scrape, browse, monitor websites.',
  },
  {
    name: 'GitHub',
    how: 'Open issues, review PRs and manage repos straight from chat.',
  },
  {
    name: 'Notion',
    how: 'Search, read and edit your Notion pages with the agent.',
  },
  {
    name: 'Slack',
    how: 'Post messages and read channels without leaving the app.',
  },
  {
    name: 'PostgreSQL',
    how: 'Ask questions and run queries against your database.',
  },
];

export function FreeModeStep() {
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setBusy(true);
      try {
        await api.setOmniRouteEnabled(true);
        if (!cancelled) setApplied(true);
      } catch {
        // If the server can't enable it, still let the user continue.
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <h3 className="text-xl font-semibold tracking-tight text-ink-primary">
          Free mode enabled
        </h3>
        <p className="text-sm text-ink-muted">
          Your bundled OmniRoute gateway is ready. Start chatting free, keyless — the{' '}
          <span className="font-medium text-ink-primary">Big Pickle</span> model is first in the
          free list and auto-selected.
        </p>
      </div>

      <div
        className={`rounded-2xl border p-4 transition-all duration-500 ${
          applied ? 'border-success/30 bg-success-subtle' : 'border-surface-700 bg-surface-900'
        }`}
      >
        <div className="flex items-center gap-3">
          <span
            className={`flex h-10 w-10 items-center justify-center rounded-full transition-colors duration-500 ${
              applied ? 'bg-success/20 text-success' : 'bg-surface-800 text-ink-muted'
            }`}
          >
            {busy ? (
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
            ) : applied ? (
              <Check className="h-5 w-5" />
            ) : (
              <Sparkles className="h-5 w-5" />
            )}
          </span>
          <div>
            <p className="text-sm font-semibold text-ink-primary">
              {busy ? 'Enabling OmniRoute…' : applied ? 'OmniRoute gateway is on' : 'Ready'}
            </p>
            <p className="text-xs text-ink-muted">
              {applied
                ? 'You can switch models anytime from the chat bar.'
                : 'Finishing setup…'}
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink-muted">
          <Zap className="h-3.5 w-3.5" />
          What&apos;s included
        </div>
        <ul className="space-y-2">
          {PERKS.map((perk) => (
            <li key={perk} className="flex items-start gap-2.5 text-sm text-ink-secondary">
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                <Check className="h-3 w-3" />
              </span>
              {perk}
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink-muted">
          <Boxes className="h-3.5 w-3.5" />
          MCP servers (manage from the MCP page)
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {MCP_SHOWCASE.map((m) => (
            <div key={m.name} className="flex items-start gap-2.5 rounded-xl border border-surface-700 bg-surface-900 p-2.5">
              <BrandIconFor name={m.name} size="sm" className={undefined} />
              <div className="min-w-0">
                <p className="text-xs font-medium text-ink-primary">{m.name}</p>
                <p className="mt-0.5 text-[11px] leading-snug text-ink-muted">{m.how}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 rounded-xl border border-surface-700 bg-surface-900 p-3 text-xs text-ink-muted">
        <Layers className="h-4 w-4 shrink-0 text-accent" />
        <span>
          Tip: the <PackageCheck className="inline h-3.5 w-3.5 align-[-2px]" /> model registry
          auto-updates with new free models.
        </span>
      </div>
    </div>
  );
}
