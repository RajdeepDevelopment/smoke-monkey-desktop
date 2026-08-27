'use client';

import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { BarChart3, Loader2, RefreshCw, ShieldAlert, Timer, TrendingUp } from 'lucide-react';
import type { MetricsSummaryDto } from '@rag/contracts';
import { api } from '../../lib/api';
import { PageScroll } from '../../components/PageScroll';
import { PageHeader } from '../../components/PageHeader';
import { MetricCard } from '../../components/MetricCard';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState } from '../../components/EmptyState';
import { cn } from '../../lib/utils';

function pct(v: number | undefined): string {
  if (v == null) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

function AnimatedBar({
  label,
  value,
  max,
  accent,
  delay = 0,
  suffix = '',
}: {
  label: string;
  value: number;
  max: number;
  accent: string;
  delay?: number;
  suffix?: string;
}) {
  const width = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 truncate text-xs text-ink-secondary" title={label}>
        {label}
      </span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-700/70">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${width}%` }}
          transition={{ duration: 0.6, delay, ease: 'easeOut' }}
          className={cn('h-full rounded-full', accent)}
        />
      </div>
      <span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums text-ink-secondary">
        {Math.round(value)}
        {suffix}
      </span>
    </div>
  );
}

function Panel({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('card p-4 sm:p-5', className)}>
      <h3 className="mb-3 text-sm font-semibold text-ink-primary">{title}</h3>
      {children}
    </div>
  );
}

export default function AnalyticsPage() {
  const [metrics, setMetrics] = useState<MetricsSummaryDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setMetrics(await api.analyticsMetrics());
    } catch (err) {
      setError((err as Error).message || 'Analytics unavailable');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const byMode = metrics?.byMode ?? {};
  const byProvider = metrics?.byProvider ?? {};
  const maxMode = Math.max(1, ...Object.values(byMode));
  const maxProvider = Math.max(1, ...Object.values(byProvider));
  const stage = metrics?.byStage;
  const hasTraffic = (metrics?.requests ?? 0) > 0;

  return (
    <PageScroll>
      <div className="mx-auto w-full max-w-6xl space-y-6">
        <PageHeader
          title="Analytics"
          description={
            metrics
              ? `Request telemetry aggregated from Redis over the last ${(metrics.windowSeconds / 3600).toFixed(0)}h.`
              : 'Request telemetry aggregated from Redis over the last 24h.'
          }
          icon={<BarChart3 className="h-5 w-5" />}
          actions={
            <button className="btn-ghost inline-flex items-center gap-2" onClick={() => void load()} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          }
        />

        {error && (
          <div className="rounded-card border border-error/30 bg-error-subtle px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {!metrics && !error && (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="card h-28 animate-pulse" />
            ))}
          </div>
        )}

        {metrics && !hasTraffic && (
          <EmptyState
            icon={<TrendingUp className="h-6 w-6" />}
            title="No traffic yet"
            description="Run a few chat queries or a playground retrieval and the telemetry will start showing up here."
            action={
              <button className="btn-ghost" onClick={() => void load()}>
                Refresh
              </button>
            }
          />
        )}

        {metrics && hasTraffic && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <MetricCard
                label="Requests"
                value={metrics.requests.toLocaleString()}
                hint={
                  Object.keys(metrics.byType).length
                    ? Object.entries(metrics.byType)
                        .map(([k, v]) => `${k} ${v}`)
                        .join(' · ')
                    : 'no traffic yet'
                }
                icon={<TrendingUp className="h-4 w-4" />}
              />
              <MetricCard
                label="Error rate"
                value={pct(metrics.errorRate)}
                hint={`${metrics.errors.toLocaleString()} failed requests`}
                accent={metrics.errorRate > 0.05 ? 'warning' : 'success'}
                icon={<ShieldAlert className="h-4 w-4" />}
              />
              <MetricCard
                label="Cache hit rate"
                value={pct(metrics.cacheHitRate)}
                hint={`${metrics.cacheHits.toLocaleString()} of ${metrics.requests.toLocaleString()} served from cache`}
                accent="accent"
                icon={<RefreshCw className="h-4 w-4" />}
              />
              <MetricCard
                label="p95 latency"
                value={`${Math.round(metrics.totalMsPercentiles.p95)} ms`}
                hint={`avg ${Math.round(metrics.averageMs)} ms`}
                accent="warning"
                icon={<Timer className="h-4 w-4" />}
              />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Panel title="Latency percentiles">
                <div className="grid grid-cols-2 gap-2.5">
                  {(
                    [
                      ['p50', metrics.totalMsPercentiles.p50],
                      ['p90', metrics.totalMsPercentiles.p90],
                      ['p95', metrics.totalMsPercentiles.p95],
                      ['p99', metrics.totalMsPercentiles.p99],
                    ] as const
                  ).map(([label, ms]) => (
                    <div
                      key={label}
                      className="rounded-xl border border-surface-800 bg-surface-900/60 p-3.5 transition-colors hover:border-primary/20"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-ink-muted">{label}</span>
                        <StatusBadge
                          label={Math.round(ms) <= 1500 ? 'OK' : Math.round(ms) <= 4000 ? 'Slow' : 'Critical'}
                          tone={Math.round(ms) <= 1500 ? 'success' : Math.round(ms) <= 4000 ? 'warning' : 'error'}
                        />
                      </div>
                      <div className="mt-1 text-xl font-semibold tabular-nums text-ink-primary">
                        {Math.round(ms)} <span className="text-xs font-normal text-ink-muted">ms</span>
                      </div>
                    </div>
                  ))}
                </div>
              </Panel>

              <Panel title="Average stage latency">
                {stage ? (
                  <div className="space-y-3">
                    <AnimatedBar label="Embedding" value={Math.round(stage.embeddingMs)} max={Math.max(1, Math.round(stage.llmGenerationMs))} accent="bg-accent" delay={0.05} suffix="ms" />
                    <AnimatedBar label="Retrieval" value={Math.round(stage.retrievalMs)} max={Math.max(1, Math.round(stage.llmGenerationMs))} accent="bg-accent" delay={0.1} suffix="ms" />
                    <AnimatedBar label="Rerank" value={Math.round(stage.rerankerMs)} max={Math.max(1, Math.round(stage.llmGenerationMs))} accent="bg-warning" delay={0.15} suffix="ms" />
                    <AnimatedBar label="TTFT" value={Math.round(stage.llmTtftMs)} max={Math.max(1, Math.round(stage.llmGenerationMs))} accent="bg-primary" delay={0.2} suffix="ms" />
                    <AnimatedBar label="Generation" value={Math.round(stage.llmGenerationMs)} max={Math.max(1, Math.round(stage.llmGenerationMs))} accent="bg-primary" delay={0.25} suffix="ms" />
                  </div>
                ) : (
                  <p className="text-sm text-ink-muted">No timing data yet.</p>
                )}
              </Panel>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Panel title="Requests by mode">
                {Object.keys(byMode).length === 0 ? (
                  <p className="text-sm text-ink-muted">No requests yet.</p>
                ) : (
                  <div className="space-y-3">
                    {Object.entries(byMode)
                      .sort((a, b) => b[1] - a[1])
                      .map(([mode, count], i) => (
                        <AnimatedBar key={mode} label={mode} value={count} max={maxMode} accent="bg-accent" delay={i * 0.05} />
                      ))}
                  </div>
                )}
              </Panel>

              <Panel title="Requests by provider">
                {Object.keys(byProvider).length === 0 ? (
                  <p className="text-sm text-ink-muted">No requests yet.</p>
                ) : (
                  <div className="space-y-3">
                    {Object.entries(byProvider)
                      .sort((a, b) => b[1] - a[1])
                      .map(([provider, count], i) => (
                        <AnimatedBar key={provider} label={provider} value={count} max={maxProvider} accent="bg-primary" delay={i * 0.05} />
                      ))}
                  </div>
                )}
              </Panel>
            </div>

            {metrics.recentErrors.length > 0 && (
              <Panel title="Recent errors">
                <ul className="space-y-1.5">
                  {metrics.recentErrors.map((msg, i) => (
                    <li
                      key={i}
                      className="truncate rounded-lg border border-error/15 bg-error-subtle px-3 py-1.5 text-xs text-red-300"
                      title={msg}
                    >
                      {msg}
                    </li>
                  ))}
                </ul>
              </Panel>
            )}
          </div>
        )}
      </div>
    </PageScroll>
  );
}
