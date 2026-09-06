'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Check, ChevronDown, ChevronRight, Cpu, Search, Zap } from 'lucide-react';
import type { ModelPreset, ModelProvider } from '@rag/contracts';
import { useIsMobile } from '../../lib/hooks';
import { cn } from '../../lib/utils';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '../ui/popover';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '../ui/sheet';
import { BrandIcon } from '../BrandIcon';

interface ModelPickerProps {
  providers: ModelProvider[];
  provider: string;
  model: string;
  defaultProvider?: string;
  presets?: ModelPreset[];
  onChange: (provider: string, model: string) => void;
  compact?: boolean;
}

/**
 * Brand-aware glyph per model provider: OpenRouter's arrow-through-circle,
 * NVIDIA's green monogram, OmniRoute's free-mode zap, etc. Kept as lightweight
 * inline SVG so it reads crisply at small sizes inside the composer.
 */
function ProviderIcon({ provider, className }: { provider: string; className?: string }) {
  const id = provider.toLowerCase();

  if (id === 'openrouter') {
    return (
      <svg viewBox="0 0 24 24" fill="none" className={cn('shrink-0', className)} aria-hidden="true">
        <circle
          cx="12" cy="12" r="8.5"
          stroke="currentColor" strokeWidth="1.5"
          strokeDasharray="38 16" strokeLinecap="round"
          transform="rotate(135 12 12)" opacity="0.85"
        />
        <path d="M8.5 15.5 14.8 9.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        <path d="M11 9.2h3.8v3.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  if (id === 'nvidia') {
    return (
      <span
        className={cn(
          'flex shrink-0 items-center justify-center rounded-md text-[10px] font-extrabold leading-none',
          className,
        )}
        style={{ background: '#76B900', color: '#0b0b0b' }}
      >
        n
      </span>
    );
  }

  if (id === 'omniroute') {
    return <Zap className={cn('shrink-0 text-violet-400', className)} fill="currentColor" strokeWidth={1.4} />;
  }

  if (id === 'smokemonkey' || provider === 'big-pickle') {
    return <BrandIcon size={16} className={cn('shrink-0 rounded', className)} />;
  }

  if (id === 'ollama') {
    return <Bot className={cn('shrink-0 text-ink-secondary', className)} />;
  }

  return <Cpu className={cn('shrink-0 text-ink-muted', className)} />;
}

function presetFor(presets: ModelPreset[] | undefined, provider: string, model: string): ModelPreset | undefined {
  return presets?.find((p) => p.provider === provider && p.model === model);
}

function ModelOption({
  provider,
  model,
  defaultProvider,
  presets,
  active,
  onSelect,
}: {
  provider: ModelProvider;
  model: string;
  defaultProvider?: string;
  presets?: ModelPreset[];
  active: boolean;
  onSelect: () => void;
}) {
  const preset = presetFor(presets, provider.id, model);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
        active ? 'bg-primary-subtle' : 'hover:bg-surface-800',
      )}
    >
      <ProviderIcon provider={provider.id} className="h-4 w-4 text-ink-secondary" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cn('truncate text-sm font-medium', active ? 'text-white' : 'text-ink-primary')}>
            {model}
          </span>
          {preset?.isFree && (
            <span className="shrink-0 rounded-full bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success">
              free
            </span>
          )}
          {provider.id === defaultProvider && preset && (
            <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary-hover">
              Recommended
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-ink-muted">
          {provider.label}
          {preset?.role && ` · ${preset.label}`}
        </p>
      </div>
      {active && <Check className="h-4 w-4 shrink-0 text-primary" />}
    </button>
  );
}

function ModelPickerPanel({
  providers,
  provider,
  model,
  defaultProvider,
  presets,
  onSelect,
}: {
  providers: ModelProvider[];
  provider: string;
  model: string;
  defaultProvider?: string;
  presets?: ModelPreset[];
  onSelect: (provider: string, model: string) => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const searching = q.length > 0;

  // Provider groups start folded except the one that's currently selected, so
  // the list is scannable — unfold a provider to browse its models. Searching
  // auto-expands every matching group so results are always visible.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(providers.map((p) => [p.id, p.id !== provider])),
  );

  const isExpanded = (pid: string) => searching || pid === provider || !collapsed[pid];
  const toggle = (pid: string) =>
    setCollapsed((c) => ({ ...c, [pid]: c[pid] ? false : true }));

  const groups = useMemo(() => {
    return providers
      .map((p) => {
        const models = p.models.filter(
          (m) => !q || m.toLowerCase().includes(q) || p.label.toLowerCase().includes(q),
        );
        return { provider: p, models };
      })
      .filter((g) => g.models.length > 0);
  }, [providers, q]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="relative border-b border-surface-800 p-3">
        <Search className="pointer-events-none absolute left-6 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search models…"
          autoFocus
          className="h-9 w-full rounded-lg border border-surface-700 bg-surface-850 pl-9 pr-3 text-sm text-ink-primary placeholder:text-ink-muted focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-ring/25"
        />
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {groups.length === 0 && (
          <p className="px-3 py-6 text-center text-xs text-ink-muted">No models match “{query}”.</p>
        )}
        {groups.map(({ provider: p, models }) => {
          const expanded = isExpanded(p.id);
          return (
            <div key={p.id} className="mb-1">
              <button
                type="button"
                onClick={() => toggle(p.id)}
                className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-ink-muted transition-colors hover:bg-surface-800 hover:text-ink-primary"
                aria-expanded={expanded}
              >
                <ChevronRight
                  className={cn('h-3 w-3 shrink-0 text-ink-muted transition-transform duration-200', expanded && 'rotate-90')}
                />
                <ProviderIcon provider={p.id} className="h-3.5 w-3.5" />
                <span className="truncate">{p.label}</span>
                <span className="ml-auto shrink-0 rounded-full bg-surface-800 px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-ink-secondary">
                  {models.length}
                </span>
              </button>
              {expanded && (
                <div className="animate-fade-in space-y-0.5">
                  {models.map((m) => (
                    <ModelOption
                      key={m}
                      provider={p}
                      model={m}
                      defaultProvider={defaultProvider}
                      presets={presets}
                      active={provider === p.id && model === m}
                      onSelect={() => onSelect(p.id, m)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Model + provider selector. Desktop: anchored Popover. Mobile: full-height
 * Sheet so the model list never overflows the small viewport.
 */
export function ModelPicker({
  providers,
  provider,
  model,
  defaultProvider,
  presets,
  onChange,
  compact,
}: ModelPickerProps) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [selectionNonce, setSelectionNonce] = useState(0);
  const currentProvider = providers.find((p) => p.id === provider);
  const currentLabel = compact ? model : `${currentProvider?.label ?? provider} · ${model}`;

  // A selection may trigger a parent re-render that bounces a stray
  // open/close signal through Radix — guard `onOpenChange` and remount the
  // picker (via `key={selectionNonce}`) so it is guaranteed to start fresh
  // and closed after choosing a model, no matter what parent re-renders do.
  const justSelected = useRef(false);

  const select = (p: string, m: string) => {
    justSelected.current = true;
    onChange(p, m);
    setOpen(false);
    setSelectionNonce((n) => n + 1);
    requestAnimationFrame(() => {
      justSelected.current = false;
    });
  };

  const handleOpenChange = (next: boolean) => {
    if (next && justSelected.current) return;
    setOpen(next);
  };

  // Belt-and-suspenders: any provider/model change implies a selection took
  // place — make sure the picker collapses even if an outside signal reopened it.
  const prevSelection = useRef<{ provider: string; model: string } | null>(null);
  useEffect(() => {
    const key = `${provider}:${model}`;
    const prev = prevSelection.current;
    prevSelection.current = { provider, model };
    if (prev && `${prev.provider}:${prev.model}` !== key) {
      justSelected.current = true;
      setOpen(false);
      requestAnimationFrame(() => { justSelected.current = false; });
    }
  }, [provider, model]);

  const trigger = (
    <button
      type="button"
      className="inline-flex h-9 min-h-9 min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-surface-700 bg-surface-850 px-2.5 text-xs font-medium text-ink-secondary transition-colors hover:border-primary/40 hover:text-white"
      aria-label="Select model"
      aria-expanded={open}
      title={currentLabel}
    >
      <ProviderIcon provider={currentProvider?.id ?? provider} className="h-4 w-4 text-ink-secondary" />
      <span className="min-w-0 flex-1 truncate max-w-[130px] xs:max-w-[190px] sm:max-w-[260px]">{currentLabel}</span>
      <ChevronDown
        className={cn(
          'h-3.5 w-3.5 shrink-0 text-ink-muted transition-transform duration-300 ease-out',
          open && 'rotate-180',
        )}
      />
    </button>
  );

  if (isMobile) {
    return (
      <Sheet key={selectionNonce} open={open} onOpenChange={handleOpenChange}>
        <SheetTrigger asChild>{trigger}</SheetTrigger>
        <SheetContent side="bottom" className="max-h-[70vh] p-0">
          <SheetHeader className="border-b border-surface-800 px-4 py-3">
            <SheetTitle className="text-sm">Select model</SheetTitle>
          </SheetHeader>
          <ModelPickerPanel
            providers={providers}
            provider={provider}
            model={model}
            defaultProvider={defaultProvider}
            presets={presets}
            onSelect={select}
          />
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Popover key={selectionNonce} open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="flex max-h-[min(560px,75vh)] w-[320px] max-w-[calc(100vw-24px)] flex-col overflow-hidden p-0 animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
      >
        <ModelPickerPanel
          providers={providers}
          provider={provider}
          model={model}
          defaultProvider={defaultProvider}
          presets={presets}
          onSelect={select}
        />
      </PopoverContent>
    </Popover>
  );
}
