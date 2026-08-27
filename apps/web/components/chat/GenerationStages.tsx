'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { Check } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface StageItem {
  label: string;
  done: boolean;
}

const STAGE_ICONS: Record<string, string> = {
  search: '🔎',
  memory: '🧠',
  web: '🌐',
  knowledge: '📚',
  retrieve: '📄',
  rank: '📊',
  generate: '✨',
  understand: '💡',
};

function iconFor(label: string): string {
  const lower = label.toLowerCase();
  for (const [key, icon] of Object.entries(STAGE_ICONS)) {
    if (lower.includes(key)) return icon;
  }
  return '●';
}

/**
 * Animated generation status pills. Renders the "Understanding question →
 * Searching memory → Retrieving knowledge → Generating response" sequence as
 * compact, subtle chips that collapse once the stream starts.
 */
export function GenerationStages({ stages, streaming }: { stages: StageItem[]; streaming: boolean }) {
  if (stages.length === 0) return null;

  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5" aria-live="polite">
      <AnimatePresence mode="popLayout">
        {stages.map((stage, i) => (
          <motion.span
            key={stage.label}
            layout
            initial={{ opacity: 0, y: 6, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium',
              stage.done
                ? 'border-success/20 bg-success-subtle text-emerald-300'
                : streaming && i === stages.length - 1
                  ? 'border-primary/25 bg-primary-subtle text-primary-hover'
                  : 'border-surface-700 bg-surface-850 text-ink-muted',
            )}
          >
            {stage.done ? (
              <Check className="h-3 w-3" />
            ) : streaming && i === stages.length - 1 ? (
              <span className="h-2 w-2 animate-ping rounded-full bg-primary" />
            ) : (
              <span className="h-1.5 w-1.5 rounded-full bg-ink-muted" />
            )}
            {stage.label}
          </motion.span>
        ))}
      </AnimatePresence>
    </div>
  );
}
