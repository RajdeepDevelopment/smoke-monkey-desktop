'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, FlaskConical, Loader2, Search, Zap } from 'lucide-react';
import type { DocumentDto, RetrieveResponseDto } from '@rag/contracts';
import { api } from '../../lib/api';
import { useAuth } from '../../components/AuthProvider';
import { PageScroll } from '../../components/PageScroll';
import { PageHeader } from '../../components/PageHeader';
import { MetricCard } from '../../components/MetricCard';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState } from '../../components/EmptyState';
import { cn } from '../../lib/utils';

const MODES = [
  { id: 'fast', label: 'Fast', desc: '1 embedding call, no rewriting, no rerank, small topK' },
  { id: 'balanced', label: 'Balanced', desc: 'rerank on, medium topK (default)' },
  { id: 'deep', label: 'Deep', desc: 'multi-query + HyDE + rerank, largest topK' },
] as const;

type Mode = (typeof MODES)[number]['id'];

function TimingBar({ label, ms, accent, delay = 0 }: { label: string; ms: number; accent: string; delay?: number }) {
  const width = Math.min(100, ms);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-ink-muted">{label}</span>
        <span className="font-mono tabular-nums text-ink-secondary">{Math.round(ms)} ms</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-700/70">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${width}%` }}
          transition={{ duration: 0.6, delay, ease: 'easeOut' }}
          className={cn('h-full rounded-full', accent)}
        />
      </div>
    </div>
  );
}

function ScorePill({ score, maxScore }: { score: number; maxScore: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, score)) * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="h-1 w-20 overflow-hidden rounded-full bg-surface-700/70">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${maxScore > 0 ? (score / maxScore) * 100 : 0}%` }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
          className={cn(
            'h-full rounded-full',
            pct >= 80 ? 'bg-success' : pct >= 50 ? 'bg-warning' : 'bg-ink-muted',
          )}
        />
      </div>
      <span
        className={cn(
          'w-10 text-right text-xs font-semibold tabular-nums',
          pct >= 80 ? 'text-success' : pct >= 50 ? 'text-warning' : 'text-ink-muted',
        )}
      >
        {pct}%
      </span>
    </div>
  );
}

export default function PlaygroundPage() {
  const { user } = useAuth();
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<Mode>('balanced');
  const [documents, setDocuments] = useState<DocumentDto[]>([]);
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<RetrieveResponseDto | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (user) {
      api
        .listDocuments()
        .then((docs) => setDocuments(docs.filter((d) => d.status === 'ready')))
        .catch(() => setDocuments([]));
    }
  }, [user]);

  const run = useCallback(async () => {
    const text = query.trim();
    if (!text || running) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.playgroundRetrieve({
        message: text,
        mode,
        documentIds: selectedDocIds.size > 0 ? [...selectedDocIds] : undefined,
      });
      setResult(res);
      setExpanded(new Set());
    } catch (err) {
      setError((err as Error).message || 'Retrieval failed');
    } finally {
      setRunning(false);
    }
  }, [query, running, mode, selectedDocIds]);

  const totalMs = result?.timings.total_ms ?? 0;
  const maxScore = useMemo(
    () => Math.max(...(result?.chunks.map((c) => c.score) ?? [0]), 0),
    [result],
  );
  const otherMs = result
    ? Math.max(
        0,
        result.timings.total_ms -
          result.timings.embedding_ms -
          result.timings.retrieval_ms -
          result.timings.reranker_ms,
      )
    : 0;

  return (
    <PageScroll>
      <div className="mx-auto w-full max-w-6xl space-y-6">
        <PageHeader
          title="Retrieval playground"
          description="Run the hybrid retrieval pipeline directly — no generation. Inspect scores, sources and per-stage latency."
          icon={<FlaskConical className="h-5 w-5" />}
        />

        <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
          {/* ── Config column ────────────────────────────────────────────── */}
          <div className="space-y-3">
            <div className="card space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-ink-secondary">Query</label>
                <textarea
                  className="input min-h-[110px] resize-y"
                  placeholder="e.g. What does the lease say about early termination?"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void run();
                    }
                  }}
                />
              </div>

              <div>
                <p className="mb-1.5 text-xs font-medium text-ink-secondary">Mode</p>
                <div className="grid grid-cols-3 gap-1 rounded-xl bg-surface-850 p-1">
                  {MODES.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      title={m.desc}
                      onClick={() => setMode(m.id)}
                      className={cn(
                        'rounded-lg py-1.5 text-xs font-medium transition-colors',
                        mode === m.id
                          ? 'bg-surface-700 text-white shadow-sm'
                          : 'text-ink-muted hover:text-ink-secondary',
                      )}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-[11px] leading-relaxed text-ink-muted">
                  {MODES.find((m) => m.id === mode)?.desc}
                </p>
              </div>

              {documents.length > 0 && (
                <div>
                  <p className="mb-1.5 text-xs font-medium text-ink-secondary">Scope</p>
                  <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto scrollbar-thin">
                    <button
                      type="button"
                      onClick={() => setSelectedDocIds(new Set())}
                      className={cn(
                        'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                        selectedDocIds.size === 0
                          ? 'border-primary/50 bg-primary-subtle text-white'
                          : 'border-surface-600 text-ink-secondary hover:text-white',
                      )}
                    >
                      All documents
                    </button>
                    {documents.map((doc) => {
                      const active = selectedDocIds.has(doc.id);
                      return (
                        <button
                          key={doc.id}
                          type="button"
                          onClick={() =>
                            setSelectedDocIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(doc.id)) next.delete(doc.id);
                              else next.add(doc.id);
                              return next;
                            })
                          }
                          className={cn(
                            'max-w-[180px] truncate rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                            active
                              ? 'border-accent/50 bg-accent-subtle text-cyan-200'
                              : 'border-surface-600 text-ink-secondary hover:text-white',
                          )}
                        >
                          {doc.filename}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="flex items-center gap-3">
                <button
                  className="btn-primary flex-1 justify-center gap-2"
                  onClick={() => void run()}
                  disabled={running || !query.trim()}
                >
                  {running ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Retrieving…
                    </>
                  ) : (
                    <>
                      <Zap className="h-4 w-4" />
                      Run retrieval
                    </>
                  )}
                </button>
                <span className="hidden text-[11px] text-ink-muted md:block">⌘/Ctrl + Enter</span>
              </div>
            </div>
          </div>

          {/* ── Results column ───────────────────────────────────────────── */}
          <div className="min-w-0 space-y-4">
            {error && (
              <div className="rounded-card border border-error/30 bg-error-subtle px-4 py-3 text-sm text-red-300">
                {error}
              </div>
            )}

            {!result && !running && !error && (
              <EmptyState
                icon={<Search className="h-6 w-6" />}
                title="Run a retrieval"
                description="Enter a query and pick a mode to inspect how Smoke Monkey searches your documents."
              />
            )}

            <AnimatePresence>
              {result && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="space-y-4"
                >
                  <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    <MetricCard
                      label="Total latency"
                      value={`${Math.round(totalMs)} ms`}
                      hint={`${result.chunks.length} chunks · mode ${result.mode}`}
                      icon={<Zap className="h-4 w-4" />}
                    />
                    <MetricCard
                      label="Embedding"
                      value={`${Math.round(result.timings.embedding_ms)} ms`}
                      hint="query vectors"
                      accent="accent"
                      icon={<Search className="h-4 w-4" />}
                    />
                    <MetricCard
                      label="Retrieval"
                      value={`${Math.round(result.timings.retrieval_ms)} ms`}
                      hint={`rerank ${Math.round(result.timings.reranker_ms)} ms`}
                      accent="accent"
                      icon={<Zap className="h-4 w-4" />}
                    />
                    <MetricCard
                      label="Cache"
                      value={result.retrievalCacheHit ? 'HIT' : 'miss'}
                      hint="retrieval result cache"
                      accent={result.retrievalCacheHit ? 'success' : 'warning'}
                      icon={<Search className="h-4 w-4" />}
                    />
                  </div>

                  <div className="card space-y-3 p-4 sm:p-5">
                    <h3 className="text-sm font-semibold text-ink-primary">Timing breakdown</h3>
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
                      <TimingBar label="Embedding" ms={result.timings.embedding_ms} accent="bg-accent" delay={0.05} />
                      <TimingBar label="Retrieval" ms={result.timings.retrieval_ms} accent="bg-accent" delay={0.1} />
                      <TimingBar label="Rerank" ms={result.timings.reranker_ms} accent="bg-warning" delay={0.15} />
                      <TimingBar label="Other" ms={otherMs} accent="bg-surface-600" delay={0.2} />
                      <TimingBar label="Total" ms={totalMs} accent="bg-primary" delay={0.25} />
                    </div>
                  </div>

                  <section className="space-y-2.5">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-ink-primary">Retrieved chunks</h3>
                      <span className="text-xs text-ink-muted">
                        {result.chunks.length} results · score relative to top hit
                      </span>
                    </div>
                    {result.chunks.length === 0 && (
                      <p className="rounded-card border border-dashed border-surface-700 bg-surface-900/30 px-4 py-8 text-center text-sm text-ink-muted">
                        No chunks matched — try a different query.
                      </p>
                    )}
                    {result.chunks.map((c, i) => {
                      const isOpen = expanded.has(c.id);
                      return (
                        <motion.div
                          key={c.id}
                          initial={{ opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.2, delay: i * 0.03 }}
                          className="card p-4"
                        >
                          <div className="flex items-center gap-2.5">
                            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-surface-800 font-mono text-[11px] text-ink-secondary">
                              {c.rank}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-primary" title={c.documentName}>
                              {c.documentName}
                            </span>
                            <ScorePill score={c.score} maxScore={maxScore} />
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-ink-muted">
                            {c.page && <span className="text-accent">p.{c.page}</span>}
                            {c.section && <span className="truncate">{c.section}</span>}
                            {c.denseScore != null && (
                              <span className="rounded bg-surface-850 px-1.5 py-0.5 font-mono">dense {c.denseScore.toFixed(3)}</span>
                            )}
                            {c.sparseScore != null && (
                              <span className="rounded bg-surface-850 px-1.5 py-0.5 font-mono">sparse {c.sparseScore.toFixed(3)}</span>
                            )}
                            <button
                              type="button"
                              className="ml-auto inline-flex items-center gap-1 text-accent hover:underline"
                              onClick={() =>
                                setExpanded((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(c.id)) next.delete(c.id);
                                  else next.add(c.id);
                                  return next;
                                })
                              }
                            >
                              {isOpen ? 'Collapse' : 'Expand'}
                              <ChevronDown className={cn('h-3 w-3 transition-transform', isOpen && 'rotate-180')} />
                            </button>
                          </div>
                          <p
                            className={cn(
                              'mt-2 whitespace-pre-wrap text-xs leading-relaxed text-ink-secondary',
                              !isOpen && 'line-clamp-3',
                            )}
                          >
                            {c.content}
                          </p>
                        </motion.div>
                      );
                    })}
                  </section>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </PageScroll>
  );
}
