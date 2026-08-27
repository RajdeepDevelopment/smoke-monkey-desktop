'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowUp,
  Book,
  Check,
  ExternalLink,
  Globe,
  Key,
  Loader2,
  Paperclip,
  Search,
  Square,
  Zap,
} from 'lucide-react';
import type { DocumentDto, ModelPreset, ModelProvider, UserKeyDto } from '@rag/contracts';
import { api } from '../../lib/api';
import { useIsMobile } from '../../lib/hooks';
import { computeTokenBudget, estimateTokens, formatTokens } from '../../lib/tokens';
import { cn } from '../../lib/utils';
import { ResponsivePopover } from '../ui/responsive-popover';
import { ModelPicker } from './ModelPicker';

interface ChatComposerProps {
  input: string;
  onInputChange: (value: string) => void;
  streaming: boolean;
  onSend: () => void;
  onStop: () => void;
  disabled?: boolean;
  documents: DocumentDto[];
  selectedDocIds: Set<string>;
  onToggleDoc: (id: string) => void;
  onClearScope: () => void;
  savedKeys: UserKeyDto[];
  onKeysChanged: () => void;
  providers: ModelProvider[];
  provider: string;
  model: string;
  defaultProvider?: string;
  presets?: ModelPreset[];
  onModelChange: (provider: string, model: string) => void;
  onAttach: (file: File) => void;
  placeholder?: string;
  /** OmniRoute server gate is enabled (users may opt in from here). */
  omnirouteServerEnabled?: boolean;
  /** Whether the composer is currently in free OmniRoute mode. */
  omnirouteMode?: boolean;
  /** Toggle the free OmniRoute mode (persists the per-user setting). */
  onToggleOmniRoute?: () => void;
  /** Web search server gate is enabled (users may opt in from here). */
  webSearchServerEnabled?: boolean;
  /** Whether the user has enabled web search. */
  webSearchEnabled?: boolean;
  /** Toggle web search (persists the per-user setting). */
  onToggleWebSearch?: () => void;
  /** Estimated tokens already consumed by the conversation history. */
  historyTokens?: number;
  /** Retrieved-document / RAG context is expected in the request. */
  ragActive?: boolean;
}

const KEY_PROVIDERS = [
  { id: 'omniroute', label: 'OmniRoute (Free)', group: 'Chat models', placeholder: 'any free key', getKeyUrl: 'https://build.nvidia.com', hint: 'Free mode is built into the app — no OmniRoute install needed. Add any free provider key here (NVIDIA/OpenRouter/OpenCode) or an OmniRoute key and free mode uses it.' },
  { id: 'openrouter', label: 'OpenRouter', group: 'Chat models', placeholder: 'sk-or-v1-…', getKeyUrl: 'https://openrouter.ai/keys' },
  { id: 'openai', label: 'OpenAI — ChatGPT', group: 'Chat models', placeholder: 'sk-…', getKeyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'xai', label: 'xAI — Grok', group: 'Chat models', placeholder: 'xai-…', getKeyUrl: 'https://console.x.ai' },
  { id: 'gemini', label: 'Google Gemini', group: 'Chat models', placeholder: 'AIza… or key', getKeyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'opencode', label: 'OpenCode Zen', group: 'Chat models', placeholder: 'opencode key', getKeyUrl: 'https://opencode.ai/zen' },
  { id: 'nvidia', label: 'NVIDIA NIM', group: 'Chat models', placeholder: 'nvapi-…', getKeyUrl: 'https://build.nvidia.com' },
  { id: 'tavily', label: 'Tavily', group: 'Web search', placeholder: 'tvly-…', getKeyUrl: 'https://app.tavily.com' },
  { id: 'brave', label: 'Brave Search', group: 'Web search', placeholder: 'BSA…', getKeyUrl: 'https://brave.com/search/api/' },
  { id: 'bing', label: 'Bing Web Search', group: 'Web search', placeholder: '32-character key', getKeyUrl: 'https://portal.azure.com' },
];

/** Provider whose chat requests need a saved user key. */
const CHAT_KEY_PROVIDERS = new Set(['openrouter', 'nvidia', 'openai', 'xai', 'gemini', 'opencode']);

function ScopePicker({
  documents,
  selectedDocIds,
  onToggleDoc,
  onClearScope,
}: {
  documents: DocumentDto[];
  selectedDocIds: Set<string>;
  onToggleDoc: (id: string) => void;
  onClearScope: () => void;
}) {
  const all = selectedDocIds.size === 0;
  return (
    <div className="w-full">
      <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
        Knowledge Base
      </p>
      <p className="px-1 pb-2 text-[11px] text-ink-muted">
        Search the selected documents. Nothing selected = all documents.
      </p>
      <button
        type="button"
        onClick={onClearScope}
        className={cn(
          'mb-1 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
          all ? 'bg-primary-subtle text-white' : 'text-ink-secondary hover:bg-surface-800',
        )}
      >
        <span
          className={cn(
            'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
            all ? 'border-primary bg-primary' : 'border-surface-600',
          )}
        >
          {all && <Check className="h-3 w-3 text-white" />}
        </span>
        All documents
      </button>
      <div className="max-h-56 space-y-0.5 overflow-y-auto scrollbar-thin">
        {documents.length === 0 && (
          <p className="px-2.5 py-2 text-xs text-ink-muted">
            No documents ready yet.{' '}
            <Link href="/documents" className="text-primary hover:underline">
              Upload one
            </Link>
          </p>
        )}
        {documents.map((doc) => {
          const active = selectedDocIds.has(doc.id);
          return (
            <button
              key={doc.id}
              type="button"
              onClick={() => onToggleDoc(doc.id)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
                active ? 'bg-primary-subtle text-white' : 'text-ink-secondary hover:bg-surface-800',
              )}
            >
              <span
                className={cn(
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                  active ? 'border-primary bg-primary' : 'border-surface-600',
                )}
              >
                {active && <Check className="h-3 w-3 text-white" />}
              </span>
              <span className="min-w-0 flex-1 truncate">{doc.filename}</span>
            </button>
          );
        })}
      </div>
      {selectedDocIds.size > 0 && (
        <p className="pt-2 text-[11px] text-ink-muted">
          {selectedDocIds.size} document{selectedDocIds.size > 1 ? 's' : ''} selected
        </p>
      )}
    </div>
  );
}

function KeyManager({
  savedKeys,
  onChanged,
}: {
  savedKeys: UserKeyDto[];
  onChanged: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const savedFor = (id: string) => savedKeys.find((k) => k.provider === id);

  const save = async (id: string, label: string) => {
    const value = (values[id] ?? '').trim();
    if (!value) return;
    setBusyId(id);
    setMsg(null);
    try {
      await api.saveKey(id, value);
      setValues((v) => ({ ...v, [id]: '' }));
      setMsg({ kind: 'ok', text: `${label} key saved.` });
      onChanged();
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="w-full">
      <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
        API keys
      </p>
      <p className="px-1 pb-2 text-[11px] text-ink-muted">
        Add your own keys here — they are used for your chat and web search requests.
      </p>
      <div className="max-h-64 space-y-3 overflow-y-auto pr-0.5 scrollbar-thin">
        {(['Chat models', 'Web search'] as const).map((group) => (
          <div key={group}>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">{group}</p>
            <div className="space-y-2">
              {KEY_PROVIDERS.filter((p) => p.group === group).map((p) => {
                const saved = savedFor(p.id);
                return (
                  <div key={p.id} className="rounded-lg border border-surface-700 bg-surface-800/60 p-2">
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-ink-primary">{p.label}</span>
                      {saved ? (
                        <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] text-success">
                          {saved.keyPrefix}…{saved.last4}
                        </span>
                      ) : (
                        <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[10px] text-warning">no key</span>
                      )}
                    </div>
                    <form
                      className="flex gap-1.5"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void save(p.id, p.label);
                      }}
                    >
                      <input
                        className="input h-8 min-w-0 flex-1 px-2 py-1 font-mono text-xs"
                        type="password"
                        placeholder={saved ? 'Replace…' : p.placeholder}
                        value={values[p.id] ?? ''}
                        onChange={(e) => setValues((v) => ({ ...v, [p.id]: e.target.value }))}
                        autoComplete="off"
                      />
                      <button
                        type="submit"
                        className="btn-primary h-8 shrink-0 px-2.5 text-xs"
                        disabled={busyId === p.id || !(values[p.id] ?? '').trim()}
                      >
                        {busyId === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save'}
                      </button>
                      <a
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-surface-600 text-ink-muted transition-colors hover:bg-surface-800 hover:text-white"
                        href={p.getKeyUrl}
                        target="_blank"
                        rel="noreferrer"
                        title={`Get ${p.label} key`}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </form>
                    {p.hint && <p className="mt-1.5 text-[11px] leading-snug text-ink-muted">{p.hint}</p>}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between border-t border-surface-700 pt-2">
        <span className="text-[11px] text-ink-muted">Key status</span>
        <Link href="/settings" className="text-[11px] text-accent hover:underline">
          More options in Settings →
        </Link>
      </div>
      {msg && (
        <p className={cn('mt-1.5 text-xs', msg.kind === 'ok' ? 'text-success' : 'text-red-400')}>{msg.text}</p>
      )}
    </div>
  );
}

/**
 * The chat composer: auto-growing textarea, attach / knowledge scope / keys
 * actions, model picker, and send/stop. Everything is touch-friendly and
 * keyboard-first (Enter sends, Shift+Enter is a newline).
 */
export function ChatComposer({
  input,
  onInputChange,
  streaming,
  onSend,
  onStop,
  disabled,
  documents,
  selectedDocIds,
  onToggleDoc,
  onClearScope,
  savedKeys,
  onKeysChanged,
  providers,
  provider,
  model,
  defaultProvider,
  presets,
  onModelChange,
  onAttach,
  placeholder,
  omnirouteServerEnabled,
  omnirouteMode,
  onToggleOmniRoute,
  webSearchServerEnabled,
  webSearchEnabled,
  onToggleWebSearch,
  historyTokens,
  ragActive,
}: ChatComposerProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const needsKey = CHAT_KEY_PROVIDERS.has(provider) && !savedKeys.some((k) => k.provider === provider);
  const isMobile = useIsMobile();

  // Bounded auto-grow: measure content, clamp at the responsive max, scroll
  // inside the textarea once the cap is hit (never grows the whole composer).
  const inputTokens = useMemo(() => estimateTokens(input), [input]);
  const budget = useMemo(
    () =>
      computeTokenBudget({
        provider,
        model,
        historyTokens: historyTokens ?? 0,
        ragActive: ragActive ?? false,
        inputTokens,
      }),
    [provider, model, historyTokens, ragActive, inputTokens],
  );
  const overLimit = budget.state === 3;

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = isMobile ? Math.round((window.innerHeight || 640) * 0.35) : 220;
    const next = Math.min(el.scrollHeight, Math.max(max, 44));
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > next ? 'auto' : 'hidden';
  }, [input, isMobile]);

  const tokenStateClass =
    budget.state === 3
      ? 'text-red-400'
      : budget.state === 2
        ? 'text-orange-400'
        : budget.state === 1
          ? 'text-warning'
          : 'text-ink-muted';
  const tokenLabel = budget.known ? 'tokens' : 'tokens (est.)';

  return (
    <div className="w-full rounded-2xl border border-surface-700 bg-surface-900/80 shadow-lg shadow-black/20 backdrop-blur transition-all focus-within:border-primary/50">
      <textarea
        ref={taRef}
        rows={1}
        value={input}
        placeholder={placeholder ?? 'Ask anything…'}
        onChange={(e) => onInputChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (!streaming && input.trim() && !disabled && !overLimit) onSend();
          }
        }}
        className="box-border min-h-[44px] w-full max-h-[35vh] resize-none bg-transparent px-3.5 pb-1 pt-3 text-base leading-relaxed text-ink-primary placeholder:text-ink-muted focus:outline-none sm:max-h-[220px] sm:px-4 sm:pt-3.5 sm:text-sm"
      />
      {overLimit && (
        <p className="px-3.5 pb-1.5 text-[11px] leading-snug text-red-400 sm:px-4">
          Input + conversation is over this model&apos;s context budget ({formatTokens(budget.limit)}{' '}
          available). Shorten it or switch to a larger-context model. Your text is never truncated.
        </p>
      )}
      <div className="flex items-center gap-1 overflow-x-auto px-2 pb-2 pt-0.5 scrollbar-none sm:flex-wrap sm:overflow-visible">
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onAttach(file);
            e.target.value = '';
          }}
        />
        <ComposerAction
          icon={<Paperclip className="h-4 w-4 shrink-0" />}
          label="Attach"
          onClick={() => fileInputRef.current?.click()}
          title="Attach a PDF"
        />

        <ResponsivePopover
          sheetTitle="Knowledge Base"
          className="p-3"
          trigger={
            <button
              type="button"
              className={cn(
                'inline-flex min-h-[40px] min-w-[40px] items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium transition-colors sm:px-2.5 sm:py-1.5',
                selectedDocIds.size > 0
                  ? 'bg-primary-subtle text-white'
                  : 'text-ink-secondary hover:bg-surface-800 hover:text-white',
              )}
              title="Choose which documents to search"
            >
              <Book className="h-4 w-4 shrink-0" />
              <span className="hidden sm:inline">Knowledge Base</span>
              {selectedDocIds.size > 0 && (
                <span className="rounded-full bg-primary/25 px-1.5 text-[10px] text-primary">{selectedDocIds.size}</span>
              )}
            </button>
          }
        >
          <ScopePicker
            documents={documents}
            selectedDocIds={selectedDocIds}
            onToggleDoc={onToggleDoc}
            onClearScope={onClearScope}
          />
        </ResponsivePopover>

        <ResponsivePopover
          sheetTitle="API keys"
          className="p-3"
          trigger={
            <button
              type="button"
              className={cn(
                'inline-flex min-h-[40px] min-w-[40px] items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium transition-colors sm:px-2.5 sm:py-1.5',
                needsKey
                  ? 'bg-warning/10 text-warning hover:bg-warning/20'
                  : 'text-ink-secondary hover:bg-surface-800 hover:text-white',
              )}
              title="Manage API keys"
            >
              <Key className="h-4 w-4 shrink-0" />
              <span className="hidden sm:inline">Keys</span>
              {needsKey && <span className="rounded-full bg-warning px-1.5 text-[10px] font-semibold text-black">!</span>}
            </button>
          }
        >
          <KeyManager savedKeys={savedKeys} onChanged={onKeysChanged} />
        </ResponsivePopover>

        {omnirouteServerEnabled && (
          <button
            type="button"
            onClick={onToggleOmniRoute}
            className={cn(
              'inline-flex min-h-[40px] min-w-[40px] items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium transition-colors sm:px-2.5 sm:py-1.5',
              omnirouteMode
                ? 'bg-warning/15 text-warning hover:bg-warning/25'
                : 'text-ink-secondary hover:bg-surface-800 hover:text-white',
            )}
            title={
              omnirouteMode
                ? 'Free OmniRoute mode is on — keyless models, no API key needed'
                : 'Turn on free OmniRoute mode (keyless models, no API key)'
            }
          >
            <Zap className="h-4 w-4 shrink-0" />
            <span className="hidden sm:inline">{omnirouteMode ? 'Free mode' : 'Enable free mode'}</span>
            {omnirouteMode && (
              <span className="rounded-full bg-warning px-1.5 text-[10px] font-semibold text-black">ON</span>
            )}
          </button>
        )}

        {webSearchServerEnabled && (
          <button
            type="button"
            onClick={onToggleWebSearch}
            className={cn(
              'inline-flex min-h-[40px] min-w-[40px] items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium transition-colors sm:px-2.5 sm:py-1.5',
              webSearchEnabled
                ? 'bg-primary-subtle text-white hover:bg-primary-subtle/80'
                : 'text-ink-secondary hover:bg-surface-800 hover:text-white',
            )}
            title={
              webSearchEnabled
                ? 'Web search is on — click to turn off'
                : 'Turn on web search for fresh/live answers'
            }
          >
            <Globe className="h-4 w-4 shrink-0" />
            <span className="hidden sm:inline">Web Search</span>
            {webSearchEnabled && (
              <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold text-black">ON</span>
            )}
          </button>
        )}

        <span className="hidden flex-1 sm:block" />

        {streaming ? (
          <button
            type="button"
            onClick={onStop}
            className="inline-flex min-h-[40px] min-w-[40px] items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-surface-800 hover:text-red-200 shrink-0"
          >
            <Square className="h-4 w-4 shrink-0" />
            <span className="hidden sm:inline">Stop</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={onSend}
            disabled={disabled || !input.trim() || overLimit}
            className="flex h-10 w-10 min-h-[40px] min-w-[40px] shrink-0 items-center justify-center rounded-xl bg-primary text-white shadow-lg shadow-primary/25 transition-all hover:bg-primary-hover active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
            title={overLimit ? 'Input exceeds the model context budget' : 'Send'}
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        )}
      </div>

      {providers.length > 0 && (
        <div className="flex min-w-0 items-center justify-between gap-2 border-t border-surface-700/50 px-3 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-[11px] font-medium text-ink-muted">Model</span>
            <ModelPicker
              providers={providers}
              provider={provider}
              model={model}
              defaultProvider={defaultProvider}
              presets={presets}
              onChange={onModelChange}
              compact
            />
          </div>
          {omnirouteMode ? (
            <span className="hidden shrink-0 items-center gap-1.5 text-[11px] text-success sm:inline-flex">
              <Zap className="h-3 w-3" />
              100+ free models
            </span>
          ) : (
            needsKey && (
              <span className="hidden shrink-0 items-center gap-1.5 text-[11px] text-warning sm:inline-flex">
                <Search className="h-3 w-3" />
                Add key
              </span>
            )
          )}
          <span
            className={cn(
              'hidden shrink-0 items-center gap-1.5 text-[11px] font-medium tabular-nums sm:inline-flex',
              tokenStateClass,
            )}
            title={`Input estimate: ${budget.used.toLocaleString()} of ${budget.limit.toLocaleString()} available input tokens`}
          >
            {formatTokens(budget.used)} / {formatTokens(budget.limit)} {tokenLabel}
          </span>
        </div>
      )}
      <span
        className={cn(
          'flex items-center justify-end gap-1.5 px-3 pb-1.5 text-[10px] font-medium tabular-nums sm:hidden',
          tokenStateClass,
        )}
      >
        {formatTokens(budget.used)} / {formatTokens(budget.limit)} {tokenLabel}
      </span>
    </div>
  );
}

function ComposerAction({
  icon,
  label,
  onClick,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-[40px] min-w-[40px] items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium text-ink-secondary transition-colors hover:bg-surface-800 hover:text-white sm:px-2.5 sm:py-1.5"
      title={title}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
