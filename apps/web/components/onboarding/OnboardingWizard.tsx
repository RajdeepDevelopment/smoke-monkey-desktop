'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, X } from 'lucide-react';
import { Dialog, DialogContent } from '../ui/dialog';
import { Stepper } from '../ui/stepper';
import { BrandIcon } from '../BrandIcon';
import { OnboardingWizardContext, type OnboardingMode } from './types';
import { ModeSelectStep } from './ModeSelectStep';
import { FreeModeStep } from './FreeModeStep';
import { FreeKeyNotice } from './FreeKeyNotice';
import { KeySetupStep } from './KeySetupStep';
import { SearchSetupStep } from './SearchSetupStep';
import { UiModeStep } from './UiModeStep';
import { CompleteStep } from './CompleteStep';
import type { UiMode } from '../../hooks/useWorkspace';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';

interface OnboardingWizardProps {
  open: boolean;
  onClose: () => void;
}

export function OnboardingWizard({ open, onClose }: OnboardingWizardProps) {
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<OnboardingMode | null>(null);
  const [uiMode, setUiModeState] = useState<UiMode | null>(null);

  // Reset wizard state whenever it is (re)opened.
  useEffect(() => {
    if (open) {
      setStep(0);
      setMode(null);
      setUiModeState(null);
    }
  }, [open]);

  const totalSteps = 5;

  const goNext = useCallback(() => {
    setStep((s) => Math.min(totalSteps - 1, s + 1));
  }, []);
  const goBack = useCallback(() => {
    setStep((s) => Math.max(0, s - 1));
  }, []);
  const goTo = useCallback((s: number) => setStep(Math.max(0, Math.min(totalSteps - 1, s))), []);

  const setUiMode = useCallback((m: UiMode) => {
    setUiModeState(m);
    try {
      localStorage.setItem('sm-ui-mode', m);
    } catch { /* ignore */ }
  }, []);

  const finish = useCallback(async () => {
    try {
      await api.setOnboardingCompleted();
    } catch {
      // ignore
    }
    onClose();
  }, [onClose]);

  const skip = useCallback(() => {
    setMode('skip');
    try {
      if (!localStorage.getItem('sm-ui-mode')) localStorage.setItem('sm-ui-mode', 'dev');
    } catch { /* ignore */ }
    setStep(totalSteps - 1);
  }, []);

  const contextValue = useMemo(
    () => ({ mode, setMode, uiMode, setUiMode, step, goNext, goBack, goTo, finish, skip }),
    [mode, uiMode, setUiMode, step, goNext, goBack, goTo, finish, skip],
  );

  // Step titles for the stepper labels
  const stepLabels = ['Choose', 'AI mode', 'Web search', 'Interface', 'Done'];

  const handleClose = () => {
    onClose();
  };

  return (
    <OnboardingWizardContext.Provider value={contextValue}>
      <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
        <DialogContent
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="max-w-lg overflow-hidden p-0 max-h-[calc(100vh-4rem)] overflow-y-auto"
        >
          {/* Mobile close button (desktop close is styled in Dialog) */}
          <button
            type="button"
            onClick={handleClose}
            className="absolute right-3.5 top-3.5 z-10 flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-800 hover:text-ink-primary md:hidden"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>

          {/* Animated content area */}
          <div className="flex max-h-[calc(100vh-4rem)] flex-col">
            {/* Header with logo + step label */}
            <div className="shrink-0 border-b border-surface-800/70 bg-surface-900/40 px-6 pb-4 pt-6">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-primary/20 bg-primary-subtle shadow-glow">
                  <BrandIcon size={28} />
                </div>
                <div>
                  <p className="text-sm font-semibold text-ink-primary">Smoke Monkey</p>
                  <p className="text-xs text-ink-muted">Set up your AI workspace</p>
                </div>
              </div>
              <div className="mt-4">
                <Stepper current={step} total={totalSteps} labels={stepLabels} />
              </div>
            </div>

            {/* Step body — smooth slide/fade transitions */}
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
              <div key={step} className="animate-in fade-in-0 slide-in-from-bottom-2 duration-300 ease-out">
                {step === 0 && <ModeSelectStep />}
                {step === 1 && mode === 'free' && <FreeModeStep />}
                {step === 1 && mode === 'free' && <FreeKeyNotice />}
                {step === 1 && mode === 'byok' && <KeySetupStep />}
                {step === 2 && <SearchSetupStep />}
                {step === 3 && <UiModeStep />}
                {step === 4 && <CompleteStep />}
              </div>
            </div>

            {/* Footer nav */}
            {step < totalSteps - 1 && (
              <div className="flex shrink-0 items-center justify-between border-t border-surface-800/70 px-6 py-4">
                <button
                  type="button"
                  onClick={goBack}
                  disabled={step === 0}
                  className={cn(
                    'flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                    step === 0
                      ? 'cursor-not-allowed text-ink-muted/40'
                      : 'text-ink-secondary hover:bg-surface-800 hover:text-ink-primary',
                  )}
                >
                  <ArrowLeft className="h-4 w-4" />
                  Back
                </button>

                <div className="flex items-center gap-1">
                  {Array.from({ length: totalSteps - 1 }, (_, i) => (
                    <span
                      key={i}
                      className={cn(
                        'h-1.5 rounded-full transition-all duration-300',
                        i === step ? 'w-5 bg-primary' : i < step ? 'w-1.5 bg-success' : 'w-1.5 bg-surface-700',
                      )}
                    />
                  ))}
                </div>

                <button
                  type="button"
                  onClick={goNext}
                  disabled={step === 0 && !mode}
                  className="btn-primary flex items-center gap-1.5 px-4 py-2 disabled:opacity-40"
                >
                  Continue
                  <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </OnboardingWizardContext.Provider>
  );
}
