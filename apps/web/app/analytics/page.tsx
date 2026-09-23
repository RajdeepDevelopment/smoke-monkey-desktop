'use client';

import { useCallback, useEffect, useState } from 'react';
import { BarChart3, Loader2, RefreshCw, ShieldAlert, Timer, TrendingUp } from 'lucide-react';
import type { MetricsSummaryDto } from '@rag/contracts';
import { api } from '../../lib/api';
import { PageScroll } from '../../components/PageScroll';
import { PageHeader } from '../../components/PageHeader';
import { MetricCard } from '../../components/MetricCard';
import { EmptyState } from '../../components/EmptyState';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { BarChart } from '../../components/ui/bar-chart';
import { PieChart } from '../../components/ui/pie-chart';
import type { ChartConfig } from '../../components/ui/chart';
import { cn } from '../../lib/utils';

function pct(v: number | undefined): string {
  if (v == null) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

const PRIMARY = '#8B5CF6';
const ACCENT = '#22D3EE';
const WARNING = '#F59E0B';
const SUCCESS = '#34D399';
const ERROR = '#F87171';

const MODE_COLORS: Record<string, string> = {
  chat: ACCENT,
  retrieve: PRIMARY,
  retrieve_only: PRIMARY,
  query: ACCENT,
  stream: ACCENT,
};

function friendly(k: string): string {
  const map: Record<string, string> = { chat: 'Chat', retrieve: 'Retrieval', retrieve_only: 'Retrieval', query: 'Query', stream: 'Stream' };
  return map[k] ?? k;
}

function truncate(v: string | number): string {
  const s = String(v);
  return s.length > 16 ? `${s.slice(0, 15)}…` : s;
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

  const hasTraffic = (metrics?.requests ?? 0) > 0;

  // ── Latency percentiles ─────────────────────────────────────────────────
  const latencyData = metrics
    ? [
        { name: 'p50', value: Math.round(metrics.totalMsPercentiles.p50) },
        { name: 'p90', value: Math.round(metrics.totalMsPercentiles.p90) },
        { name: 'p95', value: Math.round(metrics.totalMsPercentiles.p95) },
        { name: 'p99', value: Math.round(metrics.totalMsPercentiles.p99) },
      ]
    : [];
  const latencyConfig: ChartConfig = {
    value: { label: 'Latency', color: WARNING },
  };

  // ── Average stage latency ───────────────────────────────────────────────
  const stageData = metrics
    ? [
        { name: 'Embed', value: Math.round(metrics.byStage.embeddingMs) },
        { name: 'Retrieve', value: Math.round(metrics.byStage.retrievalMs) },
        { name: 'Rerank', value: Math.round(metrics.byStage.rerankerMs) },
        { name: 'TTFT', value: Math.round(metrics.byStage.llmTtftMs) },
        { name: 'Generate', value: Math.round(metrics.byStage.llmGenerationMs) },
      ]
    : [];
  const stageConfig: ChartConfig = {
    value: { label: 'Stage avg', color: ACCENT },
  };

  // ── Requests by type (donut) ────────────────────────────────────────────
  const byTypeData = metrics
    ? Object.entries(metrics.byType)
        .sort((a, b) => b[1] - a[1])
        .map(([name, value]) => ({ name: friendly(name), value }))
    : [];
  // Rebuild config from actual keys so each donut slice gets a color.
  const typeConfigFinal: ChartConfig = byTypeData.reduce<ChartConfig>((acc, d) => {
    acc[d.name] = { label: d.name, color: MODE_COLORS[d.name.toLowerCase()] ?? PRIMARY };
    return acc;
  }, {});

  // ── Requests by mode ────────────────────────────────────────────────────
  const byModeData = metrics
    ? Object.entries(metrics.byMode)
        .sort((a, b) => b[1] - a[1])
        .map(([name, value]) => ({ name: friendly(name), value }))
    : [];
  const modeConfig: ChartConfig = {
    value: { label: 'Requests', color: PRIMARY },
  };

  // ── Requests by provider ────────────────────────────────────────────────
  const byProviderData = metrics
    ? Object.entries(metrics.byProvider)
        .sort((a, b) => b[1] - a[1])
        .map(([name, value]) => ({ name, value }))
    : [];
  const providerConfig: ChartConfig = {
    value: { label: 'Requests', color: ACCENT },
  };

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
            {/* KPI row */}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <MetricCard
                label="Requests"
                value={metrics.requests.toLocaleString()}
                hint={
                  Object.keys(metrics.byType).length
                    ? Object.entries(metrics.byType)
                        .map(([k, v]) => `${friendly(k)} ${v}`)
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

            {/* Latency + stage timing */}
            <div className="grid gap-4 lg:grid-cols-2">
              <Card className="overflow-hidden">
                <CardHeader>
                  <CardTitle>Latency percentiles</CardTitle>
                  <CardDescription>Total request latency across the window</CardDescription>
                </CardHeader>
                <CardContent>
                  <BarChart
                    data={latencyData}
                    dataKey="value"
                    xKey="name"
                    config={latencyConfig}
                    barSize={46}
                    radius={[6, 6, 6, 6]}
                  />
                  <div className="mt-2 grid grid-cols-4 gap-2">
                    {(
                      [
                        ['p50', metrics.totalMsPercentiles.p50],
                        ['p90', metrics.totalMsPercentiles.p90],
                        ['p95', metrics.totalMsPercentiles.p95],
                        ['p99', metrics.totalMsPercentiles.p99],
                      ] as const
                    ).map(([label, ms]) => (
                      <div key={label} className="rounded-lg border border-surface-800 bg-surface-900/60 px-2.5 py-2 text-center">
                        <div className="text-[10px] uppercase tracking-wider text-ink-muted">{label}</div>
                        <div className={cn('text-sm font-semibold tabular-nums', Math.round(ms) > 4000 ? 'text-red-400' : Math.round(ms) > 1500 ? 'text-amber-400' : 'text-emerald-400')}>
                          {Math.round(ms)}<span className="ml-0.5 text-[10px] font-normal text-ink-muted">ms</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              <Card className="overflow-hidden">
                <CardHeader>
                  <CardTitle>Average stage latency</CardTitle>
                  <CardDescription>Mean time per pipeline stage</CardDescription>
                </CardHeader>
                <CardContent>
                  {metrics.byStage.embeddingMs + metrics.byStage.retrievalMs + metrics.byStage.llmGenerationMs > 0 ? (
                    <BarChart
                      data={stageData}
                      dataKey="value"
                      xKey="name"
                      config={stageConfig}
                      barSize={46}
                      radius={[6, 6, 6, 6]}
                    />
                  ) : (
                    <p className="flex h-[260px] items-center justify-center text-sm text-ink-muted">No timing data yet.</p>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Distribution */}
            <div className="grid gap-4 lg:grid-cols-2">
              <Card className="overflow-hidden">
                <CardHeader>
                  <CardTitle>Requests by type</CardTitle>
                  <CardDescription>Chat vs retrieval traffic split</CardDescription>
                </CardHeader>
                <CardContent>
                  {byTypeData.length > 0 ? (
                    <>
                      <PieChart
                        data={byTypeData}
                        config={typeConfigFinal}
                        innerRadius={72}
                        outerRadius={104}
                      />
                      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 pt-1">
                        {byTypeData.map((d) => (
                          <div key={d.name} className="flex items-center gap-1.5 text-[11px] text-ink-muted">
                            <span className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: MODE_COLORS[d.name.toLowerCase()] ?? PRIMARY }} />
                            {d.name}
                            <span className="font-mono tabular-nums text-ink-secondary">{d.value}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <p className="flex h-[260px] items-center justify-center text-sm text-ink-muted">No requests yet.</p>
                  )}
                </CardContent>
              </Card>

              <Card className="overflow-hidden">
                <CardHeader>
                  <CardTitle>Requests by mode</CardTitle>
                  <CardDescription>How requests arrived in this window</CardDescription>
                </CardHeader>
                <CardContent>
                  {byModeData.length > 0 ? (
                    <BarChart
                      data={byModeData}
                      dataKey="value"
                      xKey="name"
                      config={modeConfig}
                      barSize={46}
                      radius={[6, 6, 6, 6]}
                      tickFormatter={(v) => truncate(v)}
                    />
                  ) : (
                    <p className="flex h-[260px] items-center justify-center text-sm text-ink-muted">No requests yet.</p>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Providers */}
            <Card className="overflow-hidden">
              <CardHeader>
                <CardTitle>Requests by provider</CardTitle>
                <CardDescription>Which LLM providers handled this window's traffic</CardDescription>
              </CardHeader>
              <CardContent>
                {byProviderData.length > 0 ? (
                  <BarChart
                    data={byProviderData}
                    dataKey="value"
                    xKey="name"
                    config={providerConfig}
                    series={['value']}
                    tickFormatter={(v) => truncate(String(v).replace(/^provider/i, ''))}
                  />
                ) : (
                  <p className="flex h-[260px] items-center justify-center text-sm text-ink-muted">No requests yet.</p>
                )}
              </CardContent>
            </Card>

            {metrics.recentErrors.length > 0 && (
              <Card className="overflow-hidden">
                <CardHeader>
                  <CardTitle>Recent errors</CardTitle>
                  <CardDescription>Latest failures from the request pipeline</CardDescription>
                </CardHeader>
                <CardContent>
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
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>
    </PageScroll>
  );
}