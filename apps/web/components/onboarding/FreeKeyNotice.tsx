'use client';

import { KeyRound, Info } from 'lucide-react';
import { KeySetupStep } from './KeySetupStep';

/** Free-mode free gate still needs one free provider key (NVIDIA / OpenRouter
 * / OpenCode) to reach a model — free mode picks which one via auto-routing.
 * Reuses the same save-via-API rows as BYOK so users can add it right here. */
export function FreeKeyNotice() {
  return (
    <div className="space-y-3 pt-3">
      <div className="flex items-start gap-2.5 rounded-xl border border-primary/20 bg-primary-subtle p-3 text-sm text-ink-secondary">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <p>
          <span className="font-medium text-ink-primary">Why a key?</span> Free mode proxies to
          free models through NVIDIA, OpenRouter or OpenCode — it needs one of their
          free keys to reach a model. Add one now (or later in Settings → API keys).
        </p>
      </div>
      <KeySetupStep />
      <p className="flex items-center gap-1.5 text-xs text-ink-muted">
        <KeyRound className="h-3.5 w-3.5" />
        Skipping is fine — you can add a free key anytime in Settings.
      </p>
    </div>
  );
}