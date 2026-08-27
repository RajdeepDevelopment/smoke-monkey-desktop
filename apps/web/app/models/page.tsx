'use client';

import { useEffect, useMemo, useState } from 'react';
import { Cpu, Layers, Loader2, MessageSquare, Star, TriangleAlert } from 'lucide-react';
import type { CatalogModel, ModelsResponseDto, ModelPreset } from '@rag/contracts';
import { api } from '../../lib/api';
import { PageScroll } from '../../components/PageScroll';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState } from '../../components/EmptyState';
import { cn } from '../../lib/utils';

function Stars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" title={`${rating}/5`}>
      {Array.from({ length: 5 }, (_, i) => (
        <Star
          key={i}
          className={cn('h-3.5 w-3.5', i < rating ? 'fill-warning text-warning' : 'text-surface-600')}
        />
      ))}
    </span>
  );
}

function FreeBadge() {
  return (
    <span className="shrink-0 rounded-full bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success">
      free
    </span>
  );
}

function ConfigCard({
  icon,
  label,
  value,
  hint,
  tone = 'primary',
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint: string;
  tone?: 'primary' | 'accent' | 'success';
}) {
  const iconTone =
    tone === 'primary'
      ? 'text-primary bg-primary/12'
      : tone === 'accent'
        ? 'text-accent bg-accent/12'
        : 'text-success bg-success/12';
  return (
    <div className="card flex items-start gap-3.5 p-4 sm:p-5">
      <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/5', iconTone)}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{label}</p>
        <p className="mt-1 truncate font-mono text-sm text-ink-primary">{value}</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-muted">{hint}</p>
      </div>
    </div>
  );
}

export default function ModelsPage() {
  const [models, setModels] = useState<ModelsResponseDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .fetchModels()
      .then(setModels)
      .catch((err) => setError((err as Error).message));
  }, []);

  const { chatPresets, retrievalPresets } = useMemo(() => {
    const presets = models?.presets ?? [];
    return {
      chatPresets: presets.filter((p) =>
        ['main', 'reasoning', 'coding', 'flagship', 'efficient', 'fast', 'vision'].includes(p.role),
      ),
      retrievalPresets: presets.filter((p) =>
        ['embed', 'embed-multi', 'rerank'].includes(p.role),
      ),
    };
  }, [models]);

  const defaultChat = models?.providers.find((p) => p.id === models?.defaultProvider);

  return (
    <PageScroll>
      <div className="mx-auto w-full max-w-6xl space-y-6">
        <PageHeader
          title="Models"
          description="The model catalog is data-driven — edit the model_catalog.json to change recommendations without touching code."
          icon={<Cpu className="h-5 w-5" />}
        />

        {error && (
          <div className="rounded-card border border-error/30 bg-error-subtle px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {!models && !error && (
          <div className="flex items-center justify-center gap-2 rounded-card border border-surface-800 bg-surface-900/40 py-16 text-sm text-ink-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading model catalog…
          </div>
        )}

        {models && (
          <>
            <section className="grid gap-3 lg:grid-cols-3">
              <ConfigCard
                icon={<MessageSquare className="h-5 w-5" />}
                label="Default chat"
                value={defaultChat ? `${defaultChat.label} · ${defaultChat.models[0]}` : models.defaultProvider}
                hint="Used when no provider is selected in the chat composer."
              />
              <ConfigCard
                icon={<Layers className="h-5 w-5" />}
                label="Embedding layer"
                value={`${models.embedding.provider}: ${models.embedding.model}`}
                hint={`${models.embedding.dims} dims · fixed by the pgvector index.`}
                tone="accent"
              />
              <ConfigCard
                icon={<Cpu className="h-5 w-5" />}
                label="Rerank layer"
                value={
                  models.rerank.enabled
                    ? `${models.rerank.provider}: ${models.rerank.model}`
                    : 'Disabled'
                }
                hint="Re-scores retrieval results before the LLM."
                tone="success"
              />
            </section>

            {chatPresets.length > 0 && (
              <section className="space-y-3">
                <h2 className="text-sm font-semibold uppercase tracking-widest text-ink-muted">
                  Recommended chat models
                </h2>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {chatPresets.map((p) => (
                    <div
                      key={p.role}
                      className="card group flex flex-col gap-3 p-4 transition-all hover:-translate-y-0.5 hover:border-primary/20"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="rounded-full bg-primary-subtle px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-hover">
                          {p.label}
                        </span>
                        {p.isFree && <FreeBadge />}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate font-mono text-sm font-medium text-ink-primary">{p.model}</p>
                        <p className="mt-0.5 truncate text-xs text-ink-muted">{p.providerLabel}</p>
                      </div>
                      <div className="mt-auto flex items-center justify-between border-t border-surface-800 pt-3">
                        <Stars rating={p.rating} />
                        {p.notes && (
                          <span className="max-w-[55%] truncate text-[11px] text-ink-muted" title={p.notes}>
                            {p.notes}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-widest text-ink-muted">
                Providers
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {models.providers.map((p) => (
                  <div key={p.id} className="card p-4">
                    <div className="mb-2.5 flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-ink-primary">{p.label}</span>
                      {p.id === models.defaultProvider && (
                        <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success">
                          default
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {p.models.map((m) => (
                        <span
                          key={m}
                          className="max-w-full truncate rounded-md border border-surface-700 bg-surface-850 px-2 py-1 font-mono text-[11px] text-ink-secondary"
                          title={m}
                        >
                          {m}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {retrievalPresets.length > 0 && (
              <section className="space-y-3">
                <h2 className="text-sm font-semibold uppercase tracking-widest text-ink-muted">
                  Recommended retrieval models
                </h2>
                <div className="space-y-2.5">
                  {retrievalPresets.map((p) => (
                    <div key={p.role} className="card flex flex-wrap items-center gap-3 p-4">
                      <span className="rounded-full bg-accent-subtle px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-cyan-300">
                        {p.label}
                      </span>
                      <span className="min-w-0 truncate font-mono text-sm text-ink-primary">{p.model}</span>
                      {p.isFree && <FreeBadge />}
                      <span className="text-xs text-ink-muted">{p.providerLabel}</span>
                      {typeof p.dims === 'number' && (
                        <span className="ml-auto rounded-md bg-surface-850 px-2 py-0.5 text-[11px] tabular-nums text-ink-muted">
                          {p.dims} dims
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            <CatalogTable
              title="Embedding model catalog"
              models={models.catalog.embeddingModels}
              columns={['Model', 'ID', 'Provider', 'Dims', 'Notes']}
            />
            <CatalogTable
              title="Rerank model catalog"
              models={models.catalog.rerankModels}
              columns={['Model', 'ID', 'Provider', 'Notes']}
            />
          </>
        )}

        {models && models.catalog.chatModels.length === 0 && models.providers.length === 0 && (
          <EmptyState
            icon={<TriangleAlert className="h-6 w-6" />}
            title="Catalog unavailable"
            description="The model catalog could not be loaded from the RAG service."
          />
        )}
      </div>
    </PageScroll>
  );
}

function CatalogTable({
  title,
  models,
  columns,
}: {
  title: string;
  models: CatalogModel[];
  columns: string[];
}) {
  if (models.length === 0) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-widest text-ink-muted">{title}</h2>
      <div className="overflow-hidden rounded-card border border-surface-800 bg-surface-900/40">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-surface-800 text-left text-[11px] font-semibold uppercase tracking-widest text-ink-muted">
                {columns.map((c) => (
                  <th key={c} className="whitespace-nowrap px-4 py-3">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {models.map((m, i) => (
                <tr
                  key={m.id}
                  className="border-b border-surface-800/60 last:border-0 hover:bg-surface-850/50"
                >
                  <td className="px-4 py-2.5 text-sm font-medium text-ink-primary">
                    <span className="inline-flex items-center gap-2">
                      {m.name}
                      {m.isFree && <FreeBadge />}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-ink-secondary">{m.id}</td>
                  <td className="px-4 py-2.5 text-xs text-ink-secondary">{m.provider}</td>
                  <td className="px-4 py-2.5 text-xs tabular-nums text-ink-muted">
                    {m.dims ?? '—'}
                  </td>
                  {columns.includes('Notes') && (
                    <td className="px-4 py-2.5 text-xs text-ink-muted">{m.notes}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
