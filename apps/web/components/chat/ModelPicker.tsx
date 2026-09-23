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
import { modelBrandIcon } from '../BrandIconResolver';
import {
  SiAnthropic,
  SiGooglegemini,
  SiHuggingface,
  SiMeta,
  SiMistralai,
  SiOpencode,
  SiX,
} from 'react-icons/si';
import { FaMicrosoft } from 'react-icons/fa';

interface ModelPickerProps {
  providers: ModelProvider[];
  provider: string;
  model: string;
  defaultProvider?: string;
  presets?: ModelPreset[];
  onChange: (provider: string, model: string) => void;
  compact?: boolean;
  /** Per-model health flags (from the OmniRoute 30-min inspection) keyed by model id. */
  modelInfo?: Record<
    string,
    { available?: boolean; latencyMs?: number | null; keyRequired?: boolean; isFree?: boolean }
  >;
}

/**
 * Brand-aware glyph per model provider: OpenRouter's arrow-through-circle,
 * NVIDIA's green monogram, OmniRoute's free-mode zap, etc. Kept as lightweight
 * inline SVG so it reads crisply at small sizes inside the composer.
 */
function ProviderIcon({ provider, model, className }: { provider: string; model?: string; className?: string }) {
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

  if (id === 'omniroute' || id === 'omni') {
    // OmniRoute keys embed their brand in the model id (e.g. `chatgpt-4.0`,
    // `gemini-3.7-flash`, `claude-opus-4`). Regex-match that brand for its
    // icon; fall back to the free-mode zap when nothing matches.
    if (model) {
      const m = model.toLowerCase();
      if (m === 'big-pickle' || (m.includes('smoke') && m.includes('monkey'))) {
        return <BrandIcon size={16} className={cn('shrink-0 rounded', className)} />;
      }
      const mb = modelBrandIcon(model);
      if (mb) return <mb.Icon className={cn('shrink-0', mb.color, className)} />;
    }
    return <Zap className={cn('shrink-0 text-violet-400', className)} fill="currentColor" strokeWidth={1.4} />;
  }

  if (id === 'smokemonkey' || provider === 'big-pickle') {
    return <BrandIcon size={16} className={cn('shrink-0 rounded', className)} />;
  }

  if (id === 'ollama') {
    return <Bot className={cn('shrink-0 text-ink-secondary', className)} />;
  }

  if (id === 'openai') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={cn('shrink-0', className)} aria-hidden="true">
        <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
      </svg>
    );
  }

  if (id === 'gemini' || id === 'google') {
    return <SiGooglegemini className={cn('shrink-0 text-[#4285F4]', className)} />;
  }

  if (id === 'xai' || id === 'grok') {
    return <SiX className={cn('shrink-0 text-white', className)} />;
  }

  if (id === 'opencode' || id === 'zen') {
    return <SiOpencode className={cn('shrink-0 text-white', className)} />;
  }

  if (id === 'anthropic' || id === 'claude') {
    return <SiAnthropic className={cn('shrink-0 text-[#D97757]', className)} />;
  }

  if (id === 'mistral') {
    return <SiMistralai className={cn('shrink-0 text-[#FF7000]', className)} />;
  }

  if (id === 'meta' || id === 'llama') {
    return <SiMeta className={cn('shrink-0 text-[#0668E1]', className)} />;
  }

  if (id === 'huggingface') {
    return <SiHuggingface className={cn('shrink-0 text-[#FFD21E]', className)} />;
  }

  if (id === 'azure' || id === 'microsoft') {
    return <FaMicrosoft className={cn('shrink-0 text-[#0078D4]', className)} />;
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
  info,
  onSelect,
}: {
  provider: ModelProvider;
  model: string;
  defaultProvider?: string;
  presets?: ModelPreset[];
  active: boolean;
  info?: { available?: boolean; latencyMs?: number | null; keyRequired?: boolean; isFree?: boolean };
  onSelect: () => void;
}) {
  const preset = presetFor(presets, provider.id, model);
  const hasHealth = info !== undefined;
  const offline = hasHealth && info.available === false;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
        active ? 'bg-primary-subtle' : 'hover:bg-surface-800',
        offline && !active && 'opacity-55',
      )}
    >
      <ProviderIcon provider={provider.id} model={model} className="h-4 w-4 text-ink-secondary" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cn('truncate text-sm font-medium', active ? 'text-white' : 'text-ink-primary')}>
            {model}
          </span>
          {hasHealth && (
            <span
              className={cn(
                'shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium',
                offline
                  ? 'bg-surface-800 text-ink-muted'
                  : 'bg-success/10 text-success',
              )}
            >
              {offline ? 'offline' : 'available'}
            </span>
          )}
          {(info?.isFree || preset?.isFree || provider?.freeModels?.includes(model)) && !offline && (
            <span className="shrink-0 rounded-full bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success">
              free
            </span>
          )}
          {info?.keyRequired && (
            <span className="shrink-0 rounded-full bg-warning/10 px-1.5 py-0.5 text-[9px] font-medium text-warning">
              key
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
          {info?.latencyMs != null && !offline && ` · ${info.latencyMs}ms`}
          {preset?.role && ` · ${preset.label}`}
        </p>
      </div>
      {active && <Check className="h-4 w-4 shrink-0 text-primary" />}
    </button>
  );
}

/** Cosy grouping of providers in the picker: paid (BYOK), free-with-key,
 *  and free-keyless (no key cap). The backend sends `tier` per provider when
 *  it can (agent models); the hardcoded sets are only a fallback. */
type ModelSection = 'paid' | 'free-key' | 'free-keyless';

const KEYLESS_PROVIDERS = new Set(['omniroute', 'ollama', 'local', 'smokemonkey']);
const PAID_PROVIDERS = new Set(['openai', 'xai', 'gemini', 'anthropic', 'nvidia', 'mistral', 'azure', 'cohere']);

function providerSection(id: string): ModelSection {
  if (KEYLESS_PROVIDERS.has(id)) return 'free-keyless';
  if (PAID_PROVIDERS.has(id)) return 'paid';
  return 'free-key';
}

function providerTier(p: ModelProvider | undefined): ModelSection {
  if (p?.tier === 'paid') return 'paid';
  if (p?.tier === 'keyless') return 'free-keyless';
  if (p?.tier === 'key') return 'free-key';
  return providerSection(p?.id ?? '');
}

function ModelPickerPanel({
  providers,
  provider,
  model,
  defaultProvider,
  presets,
  modelInfo,
  onSelect,
}: {
  providers: ModelProvider[];
  provider: string;
  model: string;
  defaultProvider?: string;
  presets?: ModelPreset[];
  modelInfo?: ModelPickerProps['modelInfo'];
  onSelect: (provider: string, model: string) => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const searching = q.length > 0;

  // Fold/unfold tree — three collapsible levels:
  //   section (Paid | Free) → sub-group (Free: with key / without key) → provider → models.
  // Captured once per mount; the picker remounts after each selection (selectionNonce)
  // so a freshly selected provider's section/sub-group auto-expands on every open.
  const [sectionsCollapsed, setSectionsCollapsed] = useState<Record<'paid' | 'free', boolean>>(() => {
    const current = providerTier(providers.find((p) => p.id === provider));
    return { paid: current !== 'paid', free: current === 'paid' };
  });
  const [subsCollapsed, setSubsCollapsed] = useState<Record<'free-key' | 'free-keyless', boolean>>(
    () => {
      const current = providerTier(providers.find((p) => p.id === provider));
      return {
        'free-key': current !== 'free-key',
        'free-keyless': current !== 'free-keyless',
      };
    },
  );
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(providers.map((p) => [p.id, p.id !== provider])),
  );

  const isExpanded = (pid: string) => searching || pid === provider || !collapsed[pid];
  const toggle = (pid: string) => setCollapsed((c) => ({ ...c, [pid]: c[pid] ? false : true }));
  const toggleSection = (key: 'paid' | 'free') =>
    setSectionsCollapsed((c) => ({ ...c, [key]: c[key] ? false : true }));
  const toggleSub = (key: 'free-key' | 'free-keyless') =>
    setSubsCollapsed((c) => ({ ...c, [key]: c[key] ? false : true }));

  const totalOf = (gs: Array<{ provider: ModelProvider; models: string[] }>) =>
    gs.reduce((n, g) => n + g.models.length, 0);

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

  const sectionGroups = useMemo(() => {
    const paid = groups.filter((g) => providerTier(g.provider) === 'paid');
    const free = groups.filter((g) => providerTier(g.provider) !== 'paid');
    return [
      { key: 'paid' as const, label: 'Paid', groups: paid },
      { key: 'free' as const, label: 'Free', groups: free },
    ].filter((s) => s.groups.length > 0);
  }, [groups]);

  const renderGroup = (p: ModelProvider, models: string[]) => {
    const expanded = isExpanded(p.id);
    return (
      <div key={p.id} className="mb-0.5">
        <button
          type="button"
          onClick={() => toggle(p.id)}
          className={cn(
            'flex w-full items-center gap-1.5 rounded-md px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest transition-colors hover:bg-surface-800 hover:text-ink-primary',
            searching
              ? 'text-ink-primary'
              : p.id === provider
                ? 'text-ink-primary'
                : 'text-ink-muted',
          )}
          aria-expanded={expanded}
          style={{ marginLeft: 10 }}
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
          <div className="animate-fade-in space-y-0.5" style={{ marginLeft: 10 }}>
            {models.map((m) => (
              <ModelOption
                key={m}
                provider={p}
                model={m}
                defaultProvider={defaultProvider}
                presets={presets}
                info={modelInfo?.[m]}
                active={provider === p.id && model === m}
                onSelect={() => onSelect(p.id, m)}
              />
            ))}
          </div>
        )}
      </div>
    );
  };

  const renderSubGroup = (
    key: 'free-key' | 'free-keyless',
    label: string,
    icon: 'key' | 'zap',
    subGroups: Array<{ provider: ModelProvider; models: string[] }>,
  ) => {
    if (subGroups.length === 0) return null;
    const open = searching || !subsCollapsed[key];
    return (
      <div className="mb-0.5">
        <button
          type="button"
          onClick={() => toggleSub(key)}
          className="flex w-full items-center gap-1.5 rounded-md px-4 py-1 text-[9px] font-semibold uppercase tracking-[0.18em] text-ink-muted/80 transition-colors hover:bg-surface-800 hover:text-ink-primary"
          aria-expanded={open}
        >
          <ChevronRight
            className={cn('h-2.5 w-2.5 shrink-0 text-ink-muted transition-transform duration-200', open && 'rotate-90')}
          />
          {icon === 'zap' ? <Zap className="h-3 w-3 text-success/80" /> : <Cpu className="h-3 w-3 text-warning/80" />}
          <span className="truncate">{label}</span>
          <span className="ml-auto shrink-0 rounded-full bg-surface-800 px-1.5 py-0.5 text-[9px] font-medium normal-case tracking-normal text-ink-secondary">
            {totalOf(subGroups)}
          </span>
        </button>
        {open && <div className="mt-0.5">{subGroups.map((g) => renderGroup(g.provider, g.models))}</div>}
      </div>
    );
  };

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
        {sectionGroups.map(({ key, label, groups: secGroups }) => {
          const open = searching || !sectionsCollapsed[key];
          return (
            <div key={key} className="mb-1">
              <button
                type="button"
                onClick={() => toggleSection(key)}
                className={cn(
                  'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] transition-colors hover:bg-surface-800',
                  key === 'paid' ? 'text-ink-primary' : 'text-success',
                )}
                aria-expanded={open}
              >
                <ChevronRight
                  className={cn(
                    'h-3 w-3 shrink-0 text-ink-muted transition-transform duration-200',
                    open && 'rotate-90',
                    key === 'free' && 'text-success/70',
                  )}
                />
                {key === 'free' && <Zap className="h-3.5 w-3.5 text-success" fill="currentColor" strokeWidth={1.4} />}
                {label}
                <span className="ml-auto shrink-0 rounded-full bg-surface-800 px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-ink-secondary">
                  {totalOf(secGroups)}
                </span>
              </button>
              {open && (
                key === 'paid' ? (
                  <div className="mt-0.5">{secGroups.map((g) => renderGroup(g.provider, g.models))}</div>
                ) : (
                  <div className="mt-0.5">
                    {renderSubGroup(
                      'free-key',
                      'With key',
                      'key',
                      secGroups.filter((g) => providerTier(g.provider) === 'free-key'),
                    )}
                    {renderSubGroup(
                      'free-keyless',
                      'Without key',
                      'zap',
                      secGroups.filter((g) => providerTier(g.provider) === 'free-keyless'),
                    )}
                  </div>
                )
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
  modelInfo,
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
      <ProviderIcon provider={currentProvider?.id ?? provider} model={model} className="h-4 w-4 text-ink-secondary" />
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
            modelInfo={modelInfo}
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
          modelInfo={modelInfo}
          onSelect={select}
        />
      </PopoverContent>
    </Popover>
  );
}
