'use client';

import type { UiMode } from './WorkspaceProvider';

export type ModeSwitcherSize = 'sm' | 'md';

const OPTIONS: { value: UiMode; label: string; hint: string }[] = [
  { value: 'simple', label: 'Simple', hint: 'Chat & create' },
  { value: 'dev', label: 'Developer', hint: 'Code & inspect' },
];

/**
 * Segmented control to flip the workspace between the two UI modes:
 *  - Simple  — chat-first, files/team hidden behind one tap
 *  - Developer — full IDE workspace (explorer, editor, terminal)
 */
export function ModeSwitcher({
  mode,
  onChange,
  size = 'md',
  className = '',
}: {
  mode: UiMode;
  onChange: (mode: UiMode) => void;
  size?: ModeSwitcherSize;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label="Interface mode"
      className={`inline-flex items-center gap-0.5 rounded-lg border border-surface-700/60 bg-surface-900/60 p-0.5 ${size === 'sm' ? 'px-0.5' : ''} ${className}`}
    >
      {OPTIONS.map((opt) => {
        const active = mode === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={opt.hint}
            onClick={() => onChange(opt.value)}
            className={`inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-all duration-150 ease-out ${
              size === 'sm' ? 'px-2 py-1 text-[11px]' : 'px-3 py-1.5 text-xs'
            } ${
              active
                ? 'bg-surface-800 text-ink-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_1px_3px_rgba(0,0,0,0.4)]'
                : 'text-ink-muted hover:text-ink-secondary'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full transition-colors duration-150 ${
                active ? 'bg-primary shadow-[0_0_8px_rgba(139,92,246,0.8)]' : 'bg-surface-600'
              }`}
            />
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}