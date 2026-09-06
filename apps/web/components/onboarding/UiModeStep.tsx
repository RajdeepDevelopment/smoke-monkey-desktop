'use client';

import { useState } from 'react';
import { Check, Sparkles, Code2 } from 'lucide-react';
import { useOnboardingWizard } from './types';
import { cn } from '../../lib/utils';
import type { UiMode } from '../../hooks/useWorkspace';

const MODE_KEY = 'sm-ui-mode';
const COMFORT_KEY = 'sm-ui-comfort';

function readStandalone(): UiMode {
  if (typeof window === 'undefined') return 'dev';
  try {
    const raw = localStorage.getItem(MODE_KEY);
    if (raw === 'simple' || raw === 'dev') return raw;
  } catch { /* ignore */ }
  return 'dev';
}

const COMFORT_LEVELS = [
  { id: 'novice', label: 'Just starting out', hint: 'I am learning or rarely write code' },
  { id: 'some', label: 'Comfortable with code', hint: 'I can read / edit code when needed' },
  { id: 'pro', label: 'I code for work', hint: 'Developer — I live in files, diffs and terminals' },
] as const;

type ComfortId = (typeof COMFORT_LEVELS)[number]['id'];

function recommendation(comfort: ComfortId): UiMode {
  if (comfort === 'pro' || comfort === 'some') return 'dev';
  return 'simple';
}

/** Asks how the user wants to use Smoke Monkey and recommends a UI mode.
 *  The choice is persisted immediately; changing it later is one tap away in
 *  the top bar or Settings. */
export function UiModeStep() {
  const { uiMode, setUiMode } = useOnboardingWizard();
  const mode = uiMode ?? readStandalone();
  const [comfort, setComfort] = useState<ComfortId | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      const raw = localStorage.getItem(COMFORT_KEY);
      if (raw === 'novice' || raw === 'some' || raw === 'pro') return raw;
    } catch { /* ignore */ }
    return null;
  });

  const pickComfort = (id: ComfortId | null) => {
    setComfort(id);
    try {
      if (id) localStorage.setItem(COMFORT_KEY, id);
      else localStorage.removeItem(COMFORT_KEY);
    } catch { /* ignore */ }
  };

  const recommended = comfort ? recommendation(comfort) : null;

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold text-ink-primary">How do you want to use Smoke Monkey?</h3>
        <p className="mt-1 text-sm leading-relaxed text-ink-muted">
          Same agent, same workspace — the interface just adapts to how much of the inner
          machinery you want to see. You can switch anytime.
        </p>
      </div>

      {/* Quick comfort question → powers the recommendation */}
      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-ink-muted">I am…</p>
        <div className="flex flex-col gap-1.5">
          {COMFORT_LEVELS.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => pickComfort(c.id === comfort ? null : c.id)}
              className={cn(
                'flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors',
                comfort === c.id
                  ? 'border-primary/40 bg-primary-subtle'
                  : 'border-border/50 bg-surface-900/60 hover:border-primary/25 hover:bg-surface-800/60',
              )}
            >
              <span
                className={cn(
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                  comfort === c.id ? 'border-primary bg-primary' : 'border-surface-600',
                )}
              >
                {comfort === c.id && <Check className="h-3 w-3 text-white" />}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink-primary">{c.label}</span>
                <span className="block text-[11px] text-ink-muted">{c.hint}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* The two modes */}
      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-ink-muted">Pick your interface</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {(
            [
              {
                id: 'simple' as UiMode,
                icon: Sparkles,
                title: 'Simple',
                blurb: 'Chat-first. One box to ask, clear answers and files. The details hide away.',
              },
              {
                id: 'dev' as UiMode,
                icon: Code2,
                title: 'Developer',
                blurb: 'Full IDE — file explorer, editor, terminal and every step the agent takes.',
              },
            ] as const
          ).map(({ id, icon: Icon, title, blurb }) => {
            const active = mode === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setUiMode(id)}
                aria-pressed={active}
                className={cn(
                  'relative flex flex-col gap-2 rounded-2xl border p-4 text-left transition-all duration-150',
                  active
                    ? 'border-primary/45 bg-primary-subtle/70 shadow-glow'
                    : 'border-border/50 bg-surface-900/60 hover:border-primary/25 hover:bg-surface-800/60',
                )}
              >
                {recommended === id && (
                  <span className="absolute right-2.5 top-2.5 rounded-full bg-primary/15 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-primary-hover">
                    Recommended
                  </span>
                )}
                <span
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-lg',
                    active ? 'bg-primary/20 text-primary-hover' : 'bg-surface-800 text-ink-secondary',
                  )}
                >
                  <Icon className="h-4 w-4" />
                </span>
                <span>
                  <span className="block text-sm font-semibold text-ink-primary">{title}</span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-muted">{blurb}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}