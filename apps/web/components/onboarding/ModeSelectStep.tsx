'use client';

import { Sparkles, KeyRound, ChevronRight, ArrowRight } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useOnboardingWizard } from './types';

const OPTIONS = [
  {
    id: 'free' as const,
    icon: Sparkles,
    title: 'Free mode',
    desc: 'Instant access to free AI models — no API key needed. Uses the bundled OmniRoute gateway with Big Pickle set as default.',
    accent: true,
  },
  {
    id: 'byok' as const,
    icon: KeyRound,
    title: 'Bring your own key',
    desc: 'Connect your OpenAI, OpenRouter, NVIDIA or other provider keys for the models you already have.',
    accent: false,
  },
];

export function ModeSelectStep() {
  const { mode, setMode, goNext, skip } = useOnboardingWizard();

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <h3 className="text-xl font-semibold tracking-tight text-ink-primary">
          How would you like to use AI?
        </h3>
        <p className="text-sm text-ink-muted">
          You can change this anytime from Settings. Pick what fits you best.
        </p>
      </div>

      <div className="space-y-3">
        {OPTIONS.map((opt) => {
          const Icon = opt.icon;
          const selected = mode === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => setMode(opt.id)}
              className={cn(
                'group relative w-full rounded-2xl border p-4 text-left transition-all duration-300',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                selected
                  ? opt.accent
                    ? 'border-primary/60 bg-primary-subtle shadow-lg shadow-primary/10'
                    : 'border-accent/60 bg-accent-subtle shadow-lg shadow-accent/10'
                  : 'border-surface-700 bg-surface-900 hover:border-surface-600 hover:bg-surface-850',
              )}
            >
              <div className="flex items-start gap-3.5">
                <span
                  className={cn(
                    'mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-colors duration-300',
                    selected
                      ? opt.accent
                        ? 'bg-primary/20 text-primary'
                        : 'bg-accent/20 text-accent'
                      : 'bg-surface-800 text-ink-muted group-hover:text-ink-secondary',
                  )}
                >
                  <Icon className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-ink-primary">{opt.title}</span>
                    {selected && opt.accent && (
                      <span className="rounded-full bg-primary/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                        Recommended
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-ink-muted">{opt.desc}</p>
                </div>
                <ChevronRight
                  className={cn(
                    'mt-2 h-4 w-4 shrink-0 transition-transform duration-300',
                    selected ? 'translate-x-0.5 text-ink-secondary' : 'text-ink-muted',
                  )}
                />
              </div>
            </button>
          );
        })}

        <button
          type="button"
          onClick={skip}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-surface-700 py-3 text-sm text-ink-muted transition-colors duration-200 hover:border-surface-600 hover:text-ink-secondary"
        >
          I&apos;ll configure later
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
