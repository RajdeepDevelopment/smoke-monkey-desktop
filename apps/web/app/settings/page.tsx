'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  BrainCircuit,
  Globe,
  Key,
  Layers,
  Loader2,
  Lock,
  Settings,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import type {
  ModelPreset,
  ModelsResponseDto,
  SaveKeyResultDto,
  UserKeyDto,
} from '@rag/contracts';
import { api } from '../../lib/api';
import { useAuth } from '../../components/AuthProvider';
import { PageScroll } from '../../components/PageScroll';
import { PageHeader } from '../../components/PageHeader';
import { StatusBadge } from '../../components/StatusBadge';
import { useToast } from '../../components/Toast';
import { Switch } from '../../components/ui/switch';
import { cn } from '../../lib/utils';

interface ProviderMeta {
  id: string;
  label: string;
  hint: string;
  placeholder: string;
  keyStart: string;
  getKeyUrl: string;
}

const PROVIDERS: ProviderMeta[] = [
  {
    id: 'omniroute',
    label: 'OmniRoute (Free)',
    hint: 'Free mode is built into the app — no OmniRoute install needed. Add any free provider key here (NVIDIA/OpenRouter/OpenCode) or an OmniRoute key and free mode uses it.',
    placeholder: 'any free key',
    keyStart: '',
    getKeyUrl: 'https://build.nvidia.com',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    hint: 'Cloud gateway with DeepSeek, GLM and NVIDIA models. Get a key at openrouter.ai/keys',
    placeholder: 'sk-or-v1-…',
    keyStart: 'sk-or-v1-',
    getKeyUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'openai',
    label: 'OpenAI — ChatGPT',
    hint: 'Official GPT models (GPT-5.6, GPT-4.1…). Get a key at platform.openai.com/api-keys',
    placeholder: 'sk-…',
    keyStart: 'sk-',
    getKeyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'xai',
    label: 'xAI — Grok',
    hint: 'Grok models on the official xAI endpoint. Get a key at console.x.ai',
    placeholder: 'xai-…',
    keyStart: 'xai-',
    getKeyUrl: 'https://console.x.ai',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    hint: 'Free AI Studio tier (gemini-3.x). Get a free key at aistudio.google.com/apikey',
    placeholder: '39-char key (AIza…)',
    keyStart: '',
    getKeyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'opencode',
    label: 'OpenCode Zen',
    hint: 'Free OpenCode Zen models (DeepSeek V4 Flash, Nemotron 3 Ultra, MiMo V2.5, Big Pickle, Laguna S 2.1). Sign in at opencode.ai/zen',
    placeholder: 'opencode zen key',
    keyStart: '',
    getKeyUrl: 'https://opencode.ai/zen',
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    hint: 'NVIDIA Nemotron models (chat, embedding, rerank). Get a key at build.nvidia.com',
    placeholder: 'nvapi-…',
    keyStart: 'nvapi-',
    getKeyUrl: 'https://build.nvidia.com',
  },
];

/** Web-search providers. Not live-validated on save (each probe costs a paid
 *  credit). Google needs a server-configured Search Engine ID; DuckDuckGo is
 *  free and needs no key. */
const SEARCH_PROVIDERS: ProviderMeta[] = [
  {
    id: 'tavily',
    label: 'Tavily',
    hint: 'Purpose-built search API for AI apps. Get a key at app.tavily.com',
    placeholder: 'tvly-…',
    keyStart: 'tvly-',
    getKeyUrl: 'https://app.tavily.com',
  },
  {
    id: 'brave',
    label: 'Brave Search',
    hint: 'Independent index with a free tier. Get a key at brave.com/search/api/',
    placeholder: 'BSA…',
    keyStart: 'BSA',
    getKeyUrl: 'https://brave.com/search/api/',
  },
  {
    id: 'bing',
    label: 'Bing Web Search',
    hint: 'Microsoft Azure search. Get a key at portal.azure.com',
    placeholder: '32-character key',
    keyStart: '',
    getKeyUrl: 'https://portal.azure.com',
  },
];

function SectionTitle({
  icon,
  children,
  description,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  description?: string;
}) {
  return (
    <div className="mb-3 flex items-start gap-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary-subtle text-primary">
        {icon}
      </span>
      <div>
        <h2 className="text-base font-semibold text-ink-primary">{children}</h2>
        {description && <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{description}</p>}
      </div>
    </div>
  );
}

function WebSearchToggle() {
  const [webSearch, setWebSearch] = useState<{ serverEnabled: boolean; enabled: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api
      .fetchSettings()
      .then((s) => setWebSearch(s.webSearch))
      .catch(() => setWebSearch({ serverEnabled: false, enabled: false }));
  }, []);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      const res = await api.setWebSearchEnabled(enabled);
      setWebSearch(res.webSearch);
      toast.success(enabled ? 'Web search is on' : 'Web search is off');
    } catch (err) {
      toast.error('Could not update web search', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const serverEnabled = webSearch?.serverEnabled ?? false;
  const enabled = webSearch?.enabled ?? false;

  return (
    <div className="card p-4 sm:p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-subtle text-accent">
            <Globe className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-ink-primary">Live web search</h3>
            <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
              Adds fresh, current information from the web when a question needs it.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {busy && <Loader2 className="h-4 w-4 animate-spin text-ink-muted" />}
          <Switch
            checked={enabled}
            disabled={!serverEnabled || busy}
            onCheckedChange={(v) => void toggle(v)}
            aria-label="Toggle live web search"
          />
        </div>
      </div>

      {!serverEnabled ? (
        <p className="mt-4 rounded-lg border border-warning/20 bg-warning-subtle px-3 py-2.5 text-xs leading-relaxed text-amber-200">
          Web search is disabled by the server administrator. Ask them to set{' '}
          <code className="rounded bg-surface-800 px-1 py-0.5 font-mono text-[11px]">
            WEB_SEARCH_ENABLED=true
          </code>{' '}
          in the environment.
        </p>
      ) : (
        <div className="mt-4">
          <StatusBadge
            label={enabled ? 'On — questions that need current info also check the web' : 'Off — documents and model knowledge only'}
            tone={enabled ? 'success' : 'neutral'}
          />
        </div>
      )}
    </div>
  );
}

function OmniRouteToggle() {
  const [omniroute, setOmniroute] = useState<{ serverEnabled: boolean; enabled: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [gateway, setGateway] = useState<{ reachable: boolean; models: number } | null>(null);
  const toast = useToast();

  useEffect(() => {
    api
      .fetchSettings()
      .then((s) => setOmniroute(s.omniroute))
      .catch(() => setOmniroute({ serverEnabled: false, enabled: false }));
  }, []);

  useEffect(() => {
    if (!omniroute?.enabled) return;
    api
      .fetchOmniRouteModels()
      .then((res) => setGateway({ reachable: res.reachable, models: res.models.length }))
      .catch(() => setGateway({ reachable: false, models: 0 }));
  }, [omniroute?.enabled]);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      const res = await api.setOmniRouteEnabled(enabled);
      setOmniroute(res.omniroute);
      setGateway(enabled ? { reachable: false, models: 0 } : null);
      toast.success(enabled ? 'OmniRoute free mode is on' : 'OmniRoute free mode is off');
    } catch (err) {
      toast.error('Could not update OmniRoute', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const serverEnabled = omniroute?.serverEnabled ?? false;
  const enabled = omniroute?.enabled ?? false;

  return (
    <div className="card p-4 sm:p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-warning/15 text-warning">
            <Zap className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-ink-primary">Free OmniRoute gateway</h3>
            <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
              100+ free, keyless models (Kimi, Claude, GPT, Gemini, DeepSeek…) through a local
              OpenAI-compatible proxy — no API key needed. Also used automatically whenever your
              provider key runs out of credits.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {busy && <Loader2 className="h-4 w-4 animate-spin text-ink-muted" />}
          <Switch
            checked={enabled}
            disabled={!serverEnabled || busy}
            onCheckedChange={(v) => void toggle(v)}
            aria-label="Toggle free OmniRoute gateway"
          />
        </div>
      </div>

      {!serverEnabled ? (
        <p className="mt-4 rounded-lg border border-warning/20 bg-warning-subtle px-3 py-2.5 text-xs leading-relaxed text-amber-200">
          OmniRoute is disabled by the server administrator. Ask them to set{' '}
          <code className="rounded bg-surface-800 px-1 py-0.5 font-mono text-[11px]">
            OMNIROUTE_ENABLED=true
          </code>{' '}
          in the environment.
        </p>
      ) : (
        <div className="mt-4 space-y-2">
          {gateway ? (
            <StatusBadge
              label={
                gateway.reachable
                  ? `On — gateway reachable, ${gateway.models} free models available`
                  : 'On — gateway not reachable yet (is OmniRoute running on localhost:20128?)'
              }
              tone={gateway.reachable ? 'success' : 'warning'}
            />
          ) : (
            <StatusBadge
              label={enabled ? 'On — questions may also fall back to free models' : 'Off — your own provider keys only'}
              tone={enabled ? 'success' : 'neutral'}
            />
          )}
        </div>
      )}
    </div>
  );
}

function KeyCard({ meta, verifies = true }: { meta: ProviderMeta; verifies?: boolean }) {
  const [saved, setSaved] = useState<UserKeyDto | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [testInfo, setTestInfo] = useState<SaveKeyResultDto['info'] | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { keys } = await api.listKeys();
      setSaved(keys.find((k) => k.provider === meta.id) ?? null);
    } catch {
      setSaved(null);
    }
  }, [meta.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async () => {
    if (!value.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.saveKey(meta.id, value.trim());
      setValue('');
      setTestInfo(res.info);
      setMsg({ kind: 'ok', text: verifies ? 'Key saved and verified.' : 'Key saved.' });
      await refresh();
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.testKey(meta.id);
      setTestInfo(res.info);
      setMsg({
        kind: 'ok',
        text: verifies ? 'Key is valid.' : 'Format looks valid (live check skipped to save quota).',
      });
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api.deleteKey(meta.id);
      setSaved(null);
      setTestInfo(null);
      setMsg({ kind: 'ok', text: 'Key removed.' });
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card space-y-3 p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-ink-primary">{meta.label}</h3>
            {saved && (
              <span className="rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">
                {saved.keyPrefix}…{saved.last4}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">
            {meta.hint}{' '}
            <a className="font-medium text-accent hover:underline" href={meta.getKeyUrl} target="_blank" rel="noreferrer">
              Get one →
            </a>
          </p>
        </div>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface-850 text-ink-muted">
          <Key className="h-4 w-4" />
        </span>
      </div>

      {testInfo && (
        <div className="rounded-lg border border-surface-700 bg-surface-850 px-3 py-2 text-xs text-ink-secondary">
          <span className="font-medium text-ink-primary">{testInfo.label || meta.label}</span>
          {testInfo.isFreeTier && <span> · free tier</span>}
          {testInfo.remaining != null && <span> · ${testInfo.remaining.toFixed(2)} remaining</span>}
          {testInfo.rateLimited && <span className="text-warning"> · rate limited</span>}
        </div>
      )}

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <input
          className="input h-10 flex-1 font-mono text-sm"
          type="password"
          placeholder={saved ? 'Replace existing key…' : meta.placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
        />
        <button className="btn-primary h-10 shrink-0" disabled={busy || !value.trim()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
        </button>
      </form>

      {saved && (
        <div className="flex gap-2">
          <button className="btn-ghost flex-1" onClick={test} disabled={busy}>
            Test key
          </button>
          <button
            className="btn-ghost flex-1 border-error/30 text-red-300 hover:bg-error-subtle"
            onClick={remove}
            disabled={busy}
          >
            Remove
          </button>
        </div>
      )}

      {msg && (
        <p className={cn('text-xs', msg.kind === 'ok' ? 'text-success' : 'text-red-400')}>{msg.text}</p>
      )}
    </div>
  );
}

function Stars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className={i < rating ? 'text-warning' : 'text-surface-600'}>
          ★
        </span>
      ))}
    </span>
  );
}

export default function SettingsPage() {
  const { user } = useAuth();
  const [models, setModels] = useState<ModelsResponseDto | null>(null);

  useEffect(() => {
    api.fetchModels().then(setModels).catch(() => setModels(null));
  }, []);

  const presets: ModelPreset[] = models?.presets ?? [];
  const chatPresets = presets.filter((p) =>
    ['main', 'reasoning', 'coding', 'flagship', 'efficient', 'fast', 'vision'].includes(p.role),
  );
  const retrievalPresets = presets.filter((p) =>
    ['embed', 'embed-multi', 'rerank'].includes(p.role),
  );

  return (
    <PageScroll>
      <div className="mx-auto w-full max-w-3xl space-y-8">
        <PageHeader
          title="Settings"
          description={
            user
              ? `Signed in as ${user.email}. Provider keys are encrypted on the server and only used by you.`
              : 'Manage your account, keys and preferences.'
          }
          icon={<Settings className="h-5 w-5" />}
          actions={
            user && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-surface-700 bg-surface-900/60 px-3 py-1.5 text-xs text-ink-secondary">
                <ShieldCheck className="h-3.5 w-3.5 text-success" />
                {user.email}
              </span>
            )
          }
        />

        {/* ── Provider API keys ─────────────────────────────────────────── */}
        <section className="space-y-3">
          <SectionTitle
            icon={<Key className="h-5 w-5" />}
            description="When you save your own key it is always used for your requests (chat, embeddings and reranking) — server defaults are only a fallback."
          >
            Provider API keys
          </SectionTitle>
          {PROVIDERS.map((meta) => (
            <KeyCard key={meta.id} meta={meta} />
          ))}
        </section>

        {/* ── Free OmniRoute gateway ────────────────────────────────────── */}
        <section className="space-y-3">
          <SectionTitle
            icon={<Zap className="h-5 w-5" />}
            description="Chat with free, keyless models through the local OmniRoute proxy. When this is on, it is also used as the automatic fallback if your OpenRouter or NVIDIA key runs out of credits."
          >
            Free OmniRoute gateway
          </SectionTitle>
          <OmniRouteToggle />
        </section>

        {/* ── Web search ─────────────────────────────────────────────────── */}
        <section className="space-y-3">
          <SectionTitle
            icon={<Globe className="h-5 w-5" />}
            description="Search providers are queried together when web search is on — every provider with a key contributes results. DuckDuckGo is free (no key needed) as the automatic fallback."
          >
            Web search
          </SectionTitle>
          <WebSearchToggle />
          {SEARCH_PROVIDERS.map((meta) => (
            <KeyCard key={meta.id} meta={meta} verifies={false} />
          ))}
        </section>

        {/* ── Super Memory ──────────────────────────────────────────────── */}
        <section className="space-y-3">
          <SectionTitle
            icon={<BrainCircuit className="h-5 w-5" />}
            description="Persistent context that carries across every conversation. Memory is applied automatically — nothing to configure."
          >
            Super Memory
          </SectionTitle>
          <div className="grid gap-2.5 sm:grid-cols-3">
            {[
              { label: 'Semantic', note: 'Facts & knowledge recalled across chats' },
              { label: 'Episodic', note: 'History of past interactions' },
              { label: 'Procedural', note: 'Reusable patterns & workflows' },
            ].map((m) => (
              <div key={m.label} className="card p-3.5">
                <StatusBadge label={m.label} tone="primary" />
                <p className="mt-2 text-[11px] leading-relaxed text-ink-muted">{m.note}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── Active RAG layers ──────────────────────────────────────────── */}
        {models && (
          <section className="space-y-3">
            <SectionTitle
              icon={<Layers className="h-5 w-5" />}
              description="The pipeline stages configured for retrieval in the RAG service."
            >
              Active RAG layers
            </SectionTitle>
            <div className="grid gap-2.5 sm:grid-cols-2">
              <div className="card p-4">
                <p className="text-[11px] font-semibold uppercase tracking-widest text-ink-muted">Embedding</p>
                <p className="mt-1.5 truncate font-mono text-sm text-ink-primary">
                  {models.embedding.provider}: {models.embedding.model}
                </p>
                <p className="mt-1 text-xs text-ink-muted">
                  {models.embedding.dims} dims · fixed by the pgvector index
                </p>
              </div>
              <div className="card p-4">
                <p className="text-[11px] font-semibold uppercase tracking-widest text-ink-muted">Rerank</p>
                <p className="mt-1.5 truncate font-mono text-sm text-ink-primary">
                  {models.rerank.enabled ? `${models.rerank.provider}: ${models.rerank.model}` : 'Disabled'}
                </p>
                <p className="mt-1 text-xs text-ink-muted">Re-scores retrieval results before the LLM</p>
              </div>
            </div>
          </section>
        )}

        {/* ── Recommended models ────────────────────────────────────────── */}
        {chatPresets.length > 0 && (
          <section className="space-y-3">
            <SectionTitle icon={<Lock className="h-5 w-5" />}>
              Recommended chat models
            </SectionTitle>
            <div className="overflow-hidden rounded-card border border-surface-800 bg-surface-900/40">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-surface-800 text-left text-[11px] font-semibold uppercase tracking-widest text-ink-muted">
                      <th className="px-4 py-3">Role</th>
                      <th className="px-4 py-3">Model</th>
                      <th className="px-4 py-3">Provider</th>
                      <th className="px-4 py-3">Rating</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chatPresets.map((p) => (
                      <tr key={p.role} className="border-b border-surface-800/60 last:border-0 hover:bg-surface-850/40">
                        <td className="px-4 py-3">
                          <p className="text-sm font-medium text-ink-primary">{p.label}</p>
                          {p.notes && <p className="text-xs text-ink-muted">{p.notes}</p>}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-ink-secondary">{p.model}</td>
                        <td className="px-4 py-3 text-xs text-ink-secondary">{p.providerLabel}</td>
                        <td className="px-4 py-3">
                          <Stars rating={p.rating} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}

        {retrievalPresets.length > 0 && (
          <section className="space-y-3">
            <SectionTitle icon={<Layers className="h-5 w-5" />}>
              Recommended retrieval models
            </SectionTitle>
            <div className="overflow-hidden rounded-card border border-surface-800 bg-surface-900/40">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-surface-800 text-left text-[11px] font-semibold uppercase tracking-widest text-ink-muted">
                      <th className="px-4 py-3">Purpose</th>
                      <th className="px-4 py-3">Model</th>
                      <th className="px-4 py-3">Provider</th>
                      <th className="px-4 py-3">Dims</th>
                    </tr>
                  </thead>
                  <tbody>
                    {retrievalPresets.map((p) => (
                      <tr key={p.role} className="border-b border-surface-800/60 last:border-0 hover:bg-surface-850/40">
                        <td className="px-4 py-3">
                          <p className="text-sm font-medium text-ink-primary">{p.label}</p>
                          {p.notes && <p className="text-xs text-ink-muted">{p.notes}</p>}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-ink-secondary">{p.model}</td>
                        <td className="px-4 py-3 text-xs text-ink-secondary">{p.providerLabel}</td>
                        <td className="px-4 py-3 text-xs text-ink-muted">{p.dims ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}
      </div>
    </PageScroll>
  );
}
