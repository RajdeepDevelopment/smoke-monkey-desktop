'use client';

import { Check, PartyPopper } from 'lucide-react';
import { useAuth } from '../AuthProvider';
import { useOnboardingWizard } from './types';

export function CompleteStep() {
  const { finish, mode } = useOnboardingWizard();
  const { user } = useAuth();

  const name = user?.name?.split(' ')[0] || 'there';

  return (
    <div className="flex flex-col items-center space-y-6 py-4 text-center">
      <div className="relative">
        <div className="flex h-20 w-20 items-center justify-center rounded-3xl border border-primary/25 bg-primary-subtle shadow-glow">
          <PartyPopper className="h-9 w-9 text-primary" />
        </div>
        <span className="absolute -right-1 -top-1 flex h-6 w-6 items-center justify-center rounded-full bg-success text-white ring-2 ring-surface-900">
          <Check className="h-3.5 w-3.5" />
        </span>
      </div>

      <div className="space-y-1.5">
        <h3 className="text-2xl font-semibold tracking-tight text-ink-primary">
          You&apos;re all set, {name}!
        </h3>
        <p className="mx-auto max-w-sm text-sm text-ink-muted">
          {mode === 'free'
            ? 'Free mode is active — Big Pickle and 100+ free models are ready to answer you.'
            : mode === 'byok'
              ? 'Your providers are connected. Pick a model and start a conversation.'
              : 'No problem — configure anything anytime from Settings.'}
        </p>
      </div>

      <div className="w-full space-y-2 rounded-2xl border border-surface-700 bg-surface-900/60 p-4 text-left">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-success" />
          Next steps
        </div>
        <ul className="space-y-2 text-sm text-ink-secondary">
          <li>
            <Check className="mr-2 inline h-3.5 w-3.5 text-success" />
            Ask your first question in the chat
          </li>
          <li>
            <Check className="mr-2 inline h-3.5 w-3.5 text-success" />
            Upload documents to build your knowledge base
          </li>
          <li>
            <Check className="mr-2 inline h-3.5 w-3.5 text-success" />
            Tweak models &amp; keys in Settings anytime
          </li>
        </ul>
      </div>

      <button className="btn-primary h-11 w-full justify-center gap-2" onClick={finish}>
        Start chatting
        <Check className="h-4 w-4" />
      </button>
    </div>
  );
}
