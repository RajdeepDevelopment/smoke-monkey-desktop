'use client';

import { createContext, useContext } from 'react';
import type { UiMode } from '../../hooks/useWorkspace';

export type OnboardingMode = 'free' | 'byok' | 'skip';

export interface OnboardingWizardContextValue {
  mode: OnboardingMode | null;
  setMode: (mode: OnboardingMode) => void;
  uiMode: UiMode | null;
  setUiMode: (mode: UiMode) => void;
  step: number;
  goNext: () => void;
  goBack: () => void;
  goTo: (step: number) => void;
  finish: () => void;
  skip: () => void;
}

export const OnboardingWizardContext = createContext<OnboardingWizardContextValue | null>(null);

export function useOnboardingWizard(): OnboardingWizardContextValue {
  const ctx = useContext(OnboardingWizardContext);
  if (!ctx) {
    throw new Error('useOnboardingWizard must be used within OnboardingWizard');
  }
  return ctx;
}
