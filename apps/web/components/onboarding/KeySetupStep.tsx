'use client';

import { useCallback, useEffect, useState } from 'react';
import { Key, Loader2, Check, ExternalLink } from 'lucide-react';
import { api } from '../../lib/api';

interface ProviderMeta {
  id: string;
  label: string;
  hint: string;
  placeholder: string;
  getKeyUrl: string;
  accent?: boolean;
}

const PROVIDERS: ProviderMeta[] = [
  {
    id: 'omniroute',
    label: 'OmniRoute (Free)',
    hint: 'Local keyless gateway — nothing to enter.',
    placeholder: 'Optional, keyless works without one',
    getKeyUrl: '',
    accent: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    hint: 'DeepSeek, GLM, NVIDIA & 100s more.',
    placeholder: 'sk-or-v1-…',
    getKeyUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    hint: 'GPT-5.6, GPT-4.1 & more.',
    placeholder: 'sk-…',
    getKeyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    hint: 'Free Nemotron & LLaMA models.',
    placeholder: 'nvapi-…',
    getKeyUrl: 'https://build.nvidia.com',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    hint: 'Gemini flash & pro series.',
    placeholder: 'AIza…',
    getKeyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'xai',
    label: 'xAI',
    hint: 'Grok models.',
    placeholder: 'xai-…',
    getKeyUrl: 'https://console.x.ai',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    hint: 'OpenCode free tier.',
    placeholder: 'oc_…',
    getKeyUrl: 'https://opencode.ai',
  },
];

function ProviderRow({ meta }: { meta: ProviderMeta }) {
  const [saved, setSaved] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { keys } = await api.listKeys();
      setSaved(keys.some((k) => k.provider === meta.id));
    } catch {
      setSaved(false);
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
      await api.saveKey(meta.id, value.trim());
      setValue('');
      setSaved(true);
      setMsg({ kind: 'ok', text: 'Key saved.' });
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-surface-700 bg-surface-900 p-3.5 transition-colors duration-200 hover:border-surface-600">
      <div className="flex items-start gap-3">
        <span
          className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
            meta.accent ? 'bg-warning/15 text-warning' : 'bg-surface-800 text-ink-muted'
          }`}
        >
          <Key className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold text-ink-primary">{meta.label}</span>
            {saved && (
              <span className="flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">
                <Check className="h-3 w-3" />
                Saved
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-ink-muted">{meta.hint}</p>

          {!meta.accent && (
            <form
              className="mt-2.5 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <input
                className="input h-9 flex-1 font-mono text-xs"
                type="password"
                placeholder={saved ? 'Replace existing key…' : meta.placeholder}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoComplete="off"
              />
              <button className="btn-primary h-9 shrink-0 px-3" disabled={busy || !value.trim()}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save'}
              </button>
            </form>
          )}

          {msg && (
            <p className={`mt-1.5 text-xs ${msg.kind === 'ok' ? 'text-success' : 'text-red-400'}`}>
              {msg.text}
            </p>
          )}
        </div>
        {meta.getKeyUrl && (
          <a
            href={meta.getKeyUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-1 text-ink-muted transition-colors hover:text-accent"
            title="Get a key"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </div>
    </div>
  );
}

export function KeySetupStep() {
  const chatProviders = PROVIDERS;

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <h3 className="text-xl font-semibold tracking-tight text-ink-primary">
          Add your API keys
        </h3>
        <p className="text-sm text-ink-muted">
          Add at least one key to start chatting with your own providers. You can add more
          anytime in Settings.
        </p>
      </div>

      <div className="max-h-72 space-y-2.5 overflow-y-auto pr-1">
        {chatProviders.map((p) => (
          <ProviderRow key={p.id} meta={p} />
        ))}
      </div>
    </div>
  );
}
