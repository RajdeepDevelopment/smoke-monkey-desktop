'use client';

import { BrainCircuit } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '../ui/sheet';

const MEMORY_TYPES = [
  {
    key: 'Semantic',
    description:
      'Facts and knowledge recalled from your past conversations and uploaded documents.',
  },
  {
    key: 'Episodic',
    description:
      'Memory of what you have done before — previous requests, preferences and interactions.',
  },
  {
    key: 'Procedural',
    description:
      'Reusable patterns and workflows, letting Smoke Monkey act consistently across sessions.',
  },
];

/**
 * Super Memory indicator. Opens a compact sheet explaining how persistent
 * memory personalizes every conversation. All content is informational — no
 * fabricated metrics.
 */
export function MemoryIndicator() {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-full border border-surface-600/70 bg-surface-800/60 px-2.5 py-1 text-[11px] font-medium text-ink-secondary transition-colors hover:border-primary/40 hover:text-white"
          title="Super Memory"
        >
          <BrainCircuit className="h-3.5 w-3.5 text-primary" />
          <span className="hidden sm:inline">Memory</span>
        </button>
      </SheetTrigger>
      <SheetContent side="bottom" className="mx-auto max-h-[70vh] w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 text-sm">
            <BrainCircuit className="h-4 w-4 text-primary" />
            Super Memory
          </SheetTitle>
          <SheetDescription>
            Persistent memory that carries context across every conversation you have with Smoke
            Monkey. Nothing is shared between users.
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-2 pt-4">
          {MEMORY_TYPES.map((m) => (
            <div
              key={m.key}
              className="flex items-start gap-3 rounded-xl border border-surface-800 bg-surface-900 p-3"
            >
              <span className="mt-0.5 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-hover">
                {m.key}
              </span>
              <p className="text-xs leading-relaxed text-ink-secondary">{m.description}</p>
            </div>
          ))}
        </div>
        <p className="pt-4 text-center text-[11px] text-ink-muted">
          Memory is applied automatically on every generation.
        </p>
      </SheetContent>
    </Sheet>
  );
}
