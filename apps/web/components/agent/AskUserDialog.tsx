'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  Check, CheckSquare, MessageSquare, PenLine, Send, X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../../lib/utils';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';

export interface AskUserOption {
  label: string;
  description: string;
}

interface AskUserDialogProps {
  open: boolean;
  question: string;
  options: AskUserOption[];
  multiple: boolean;
  onResolve: (response: string) => void;
  onDismiss: () => void;
}

/**
 * Premium Shadcn-driven "agent needs your input" dialog.
 * Renders clickable option cards (single or multi-select) or a free-form
 * answer field, then resolves back to the running agent.
 */
export function AskUserDialog({ open, question, options, multiple, onResolve, onDismiss }: AskUserDialogProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [custom, setCustom] = useState('');
  // Track whether the USER explicitly chose the custom-instruction view.
  // The fallback (options.length === 0) is derived live so a dialog that
  // mounts before options arrive (options=[]) does NOT get stuck in custom
  // mode — once real options stream in, the cards render automatically.
  const [userCustom, setUserCustom] = useState(false);
  const customMode = userCustom || options.length === 0;

  const labelToDesc = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of options) m.set(o.label, o.description || '');
    return m;
  }, [options]);

  const formatChoice = useCallback((label: string) => {
    const desc = labelToDesc.get(label);
    return desc ? `${label} — ${desc}` : label;
  }, [labelToDesc]);

  const choice = useMemo(() => {
    if (customMode) return custom.trim();
    if (options.length > 0) {
      if (multiple) {
        return selected.length > 0 ? selected.map(formatChoice).join(', ') : '';
      }
      return selected[0] ? formatChoice(selected[0]) : '';
    }
    return custom.trim();
  }, [options, multiple, selected, custom, customMode, formatChoice]);

  const canSubmit = choice.length > 0;

  const toggle = (label: string) => {
    if (customMode) setUserCustom(false);
    setSelected((prev) =>
      multiple
        ? prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label]
        : [label],
    );
  };

  const submit = () => {
    if (canSubmit) onResolve(choice);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !choice) onDismiss(); }}>
      <DialogContent className="sm:max-w-md border-primary/20 bg-gradient-to-b from-surface-900 to-surface-950 p-0 overflow-hidden">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent" />

        <div className="flex items-start gap-3.5 p-6 pb-3">
          <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/15 ring-1 ring-primary/25 shadow-[0_0_24px_-6px_rgba(59,130,246,0.5)]">
            <MessageSquare className="h-5 w-5 text-[#c4b5fd]" />
            <span className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-60" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-blue-500" />
            </span>
          </div>
          <DialogHeader className="space-y-1.5">
            <div className="flex items-center gap-2">
              <DialogTitle className="text-base text-white">Agent needs your input</DialogTitle>
              {multiple && <Badge variant="accent" className="normal-case tracking-wide">multi-select</Badge>}
            </div>
            <DialogDescription className="text-[12.5px] leading-relaxed text-ink-muted max-w-sm">
              The run is paused until you answer. Choose an option below or type your own.
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="px-6">
          <div className="rounded-lg border border-border/60 bg-black/20 px-3.5 py-2.5 text-[13px] leading-relaxed text-ink-primary">
            <div className="md-body min-w-0 text-[13px]">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{question}</ReactMarkdown>
            </div>
          </div>
        </div>

        <div className="max-h-[40vh] overflow-y-auto px-6 py-4 scrollbar-thin">
          {options.length > 0 && !customMode && (
            <div className="space-y-2">
              {options.map((opt, idx) => {
                const active = selected.includes(opt.label);
                return (
                  <button
                    key={`${opt.label}-${idx}`}
                    onClick={() => toggle(opt.label)}
                    className={cn(
                      'group relative w-full rounded-xl border px-3.5 py-3 text-left transition-all duration-150',
                      active
                        ? 'border-blue-400/60 bg-blue-500/[0.12] shadow-[0_0_0_1px_rgba(59,130,246,0.25),0_8px_30px_-12px_rgba(59,130,246,0.45)]'
                        : 'border-border/60 bg-surface-850/40 hover:border-primary/40 hover:bg-surface-800/60 hover:translate-y-[-1px]',
                    )}
                  >
                    <div className="flex items-start gap-2.5">
                      <span
                        className={cn(
                          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors',
                          active
                            ? 'border-blue-400 bg-blue-500 text-white'
                            : 'border-border bg-surface-900 text-transparent',
                        )}
                      >
                        {multiple ? <CheckSquare className="h-3 w-3" /> : <Check className="h-3 w-3" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={cn('block text-[13px] font-medium', active ? 'text-white' : 'text-ink-primary')}>
                          {opt.label}
                        </span>
                        {opt.description && (
                          <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-muted">
                            {opt.description}
                          </span>
                        )}
                      </span>
                      <span className="ml-2 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-900/70 text-[10px] font-mono text-ink-muted/50">
                        {String.fromCharCode(97 + idx)}
                      </span>
                    </div>
                  </button>
                );
              })}

              <button
                onClick={() => setUserCustom(true)}
                className="flex w-full items-center gap-2.5 rounded-xl border border-dashed border-border/70 px-3.5 py-2.5 text-left transition-all duration-150 hover:border-primary/50 hover:bg-surface-800/40"
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border border-border bg-surface-900 text-ink-muted">
                  <PenLine className="h-3 w-3" />
                </span>
                <span className="text-[13px] font-medium text-ink-secondary">Give custom instruction…</span>
              </button>
            </div>
          )}

          {customMode && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted/70">Custom instruction</span>
                {options.length > 0 && (
                  <button
                    onClick={() => { setUserCustom(false); setCustom(''); }}
                    className="text-[11px] text-ink-muted hover:text-foreground transition-colors"
                  >
                    Back to options
                  </button>
                )}
              </div>
              <textarea
                autoFocus
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(); }}
                rows={3}
                placeholder="Type your answer… (⌘/Ctrl + Enter to send)"
                className="w-full resize-none rounded-xl border border-border/60 bg-surface-950/70 px-3.5 py-3 text-[13px] leading-relaxed placeholder:text-ink-muted/40 focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border/40 bg-black/10 px-6 py-3.5">
          <div className="flex items-center gap-2 text-[11px] text-ink-muted/60">
            {options.length > 0 && canSubmit && (
              <Badge variant="outline" className="gap-1">
                <Check className="h-3 w-3 text-emerald-400" />
                {multiple ? `${selected.length} selected` : 'Ready to continue'}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onDismiss}>
              <X className="h-3.5 w-3.5" />
              Skip
            </Button>
            <Button size="sm" onClick={submit} disabled={!canSubmit}>
              <Send className="h-3.5 w-3.5" />
              Continue
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
