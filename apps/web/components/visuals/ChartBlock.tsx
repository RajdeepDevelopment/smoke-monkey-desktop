'use client';

import { memo, useMemo } from 'react';
import type { ReactNode } from 'react';
import { BarChart3, LineChart, PieChart, ScatterChart } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * Rich CHART blocks. The model wraps JSON between dedicated chart markers
 * (e.g. <bar-chart-st>…<bar-chart-ed>) and the app renders a responsive
 * hand-rolled SVG chart — bar, line, pie/donut or scatter — in a premium
 * dark card. No charting dependency required; everything below is pure SVG.
 */

export type ChartKind = 'bar' | 'line' | 'pie' | 'scatter';

export const CHART_MARKER_TAGS: Record<ChartKind, { start: string; end: string }> = {
  bar: { start: 'bar-chart-st', end: 'bar-chart-ed' },
  line: { start: 'line-chart-st', end: 'line-chart-ed' },
  pie: { start: 'pie-chart-st', end: 'pie-chart-ed' },
  scatter: { start: 'scatter-chart-st', end: 'scatter-chart-ed' },
};

const PALETTE = ['#8b5cf6', '#22d3ee', '#34d399', '#fbbf24', '#f472b6', '#60a5fa', '#fb923c', '#a3e635'];

function chartIcon(kind: ChartKind): LucideIcon {
  return kind === 'bar' ? BarChart3 : kind === 'line' ? LineChart : kind === 'scatter' ? ScatterChart : PieChart;
}

function str(v: unknown): string {
  return v == null ? '' : String(v);
}
function num(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  const n = Number.parseFloat(str(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function asRow(item: unknown): Record<string, unknown> {
  return typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : { label: str(item) };
}

function ChartShell({ title, kind, children }: { title: string; kind: ChartKind; children: ReactNode }) {
  const Icon = chartIcon(kind);
  return (
    <section className="premium-card relative my-1.5 overflow-hidden rounded-lg border border-surface-700 bg-gradient-to-b from-surface-850 to-surface-900 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.5)]">
      <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />
      <header className="flex items-center gap-2 border-b border-surface-700/60 bg-gradient-to-b from-white/[0.02] to-transparent px-2.5 py-1.5">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-violet-500/10">
          <Icon className="h-3 w-3 text-violet-400" />
        </span>
        {title && <h4 className="truncate text-[11px] font-semibold tracking-tight text-foreground">{title}</h4>}
      </header>
      <div className="px-2.5 py-2">{children}</div>
    </section>
  );
}

function TooltipLabel({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return (
    <g transform={`translate(${x},${y})`} className="pointer-events-none">
      <rect x="-28" y="-22" width="56" height="18" rx="4" fill="#000" opacity="0.7" className="pointer-events-none" />
      <text textAnchor="middle" y="-10" className="pointer-events-none" fontSize="9.5" fill="#e4e4e7">{children}</text>
    </g>
  );
}

/* ── bar ────────────────────────────────────────────────────────────────── */

function BarChartSvg({ rows }: { rows: Array<{ label: string; value: number; color?: string }> }) {
  const W = 340;
  const H = 170;
  const PAD_L = 34;
  const PAD_B = 26;
  const PAD_T = 12;
  const plotW = W - PAD_L - 10;
  const plotH = H - PAD_T - PAD_B;
  const max = Math.max(1, ...rows.map((r) => r.value));
  const n = rows.length;
  const slot = plotW / n;
  const barW = Math.min(34, slot * 0.55);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-44 w-full" role="img" aria-label="Bar chart">
      {[0, 0.5, 1].map((f) => (
        <line
          key={f}
          x1={PAD_L}
          y1={PAD_T + plotH * (1 - f)}
          x2={W - 8}
          y2={PAD_T + plotH * (1 - f)}
          stroke="#27272a"
          strokeWidth="1"
        />
      ))}
      <text x={PAD_L - 6} y={PAD_T + plotH + 4} textAnchor="end" fontSize="9" fill="#71717a">{Math.round(max)}</text>
      <text x={PAD_L - 6} y={PAD_T + plotH * 0.5 + 4} textAnchor="end" fontSize="9" fill="#71717a">{Math.round(max / 2)}</text>
      <text x={PAD_L - 6} y={PAD_T + 4} textAnchor="end" fontSize="9" fill="#71717a">0</text>
      {rows.map((r, i) => {
        const h = (r.value / max) * plotH;
        const cx = PAD_L + slot * i + slot / 2;
        const color = r.color ?? PALETTE[i % PALETTE.length];
        return (
          <g key={i}>
            <TooltipLabel x={cx} y={PAD_T + plotH - h}><tspan>{r.value}</tspan></TooltipLabel>
            <rect
              x={cx - barW / 2}
              y={PAD_T + plotH - h}
              width={barW}
              height={Math.max(2, h)}
              rx="4"
              fill={color}
              opacity="0.95"
            />
            <text x={cx} y={H - 8} textAnchor="middle" fontSize="9" fill="#71717a">{r.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

/* ── line ───────────────────────────────────────────────────────────────── */

function LineChartSvg({ rows }: { rows: Array<{ label: string; value: number }> }) {
  const W = 340;
  const H = 170;
  const PAD_L = 8;
  const PAD_B = 26;
  const PAD_T = 14;
  const PAD_R = 8;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const max = Math.max(1, ...rows.map((r) => r.value));
  const n = rows.length;
  const px = (i: number) => (n === 1 ? PAD_L + plotW / 2 : PAD_L + (i / (n - 1)) * plotW);
  const pts = rows.map((r, i) => ({ x: px(i), y: PAD_T + plotH - (r.value / max) * plotH }));
  const line = pts.map((p) => `${p.x},${p.y}`).join(' ');
  const area = `${PAD_L},${PAD_T + plotH} ${line} ${pts.length ? `${pts[pts.length - 1].x},${PAD_T + plotH}` : ''}`;
  const every = Math.max(1, Math.ceil(n / 6));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-44 w-full" role="img" aria-label="Line chart">
      {[0, 0.5, 1].map((f) => (
        <line key={f} x1={PAD_L} y1={PAD_T + plotH * (1 - f)} x2={W - PAD_R} y2={PAD_T + plotH * (1 - f)} stroke="#27272a" strokeWidth="1" />
      ))}
      <polygon points={area} fill="url(#smLineArea)" />
      <polyline points={line} fill="none" stroke="#8b5cf6" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {pts.map((p, i) => (
        <g key={i}>
          <TooltipLabel x={p.x} y={p.y - 8}><tspan>{rows[i].value}</tspan></TooltipLabel>
          <circle cx={p.x} cy={p.y} r="3" fill="#0b0b0f" stroke="#8b5cf6" strokeWidth="1.8" />
        </g>
      ))}
      {rows.map((r, i) =>
        i % every === 0 ? (
          <text key={i} x={pts[i].x} y={H - 8} textAnchor="middle" fontSize="9" fill="#71717a">
            {r.label}
          </text>
        ) : null,
      )}
      <defs>
        <linearGradient id="smLineArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#8b5cf6" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/* ── pie / donut ────────────────────────────────────────────────────────── */

function PieChartSvg({ rows }: { rows: Array<{ label: string; value: number }> }) {
  const total = rows.reduce((s, r) => s + r.value, 0);
  if (total <= 0) return null;
  const R = 52;
  const C = 2 * Math.PI * R;
  let acc = 0;
  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
      <svg viewBox="0 0 140 140" className="h-40 w-40 shrink-0" role="img" aria-label="Donut chart">
        <circle cx="70" cy="70" r={R} fill="none" stroke="#18181b" strokeWidth="18" />
        {rows.map((r, i) => {
          const frac = r.value / total;
          const dash = frac * C;
          const color = PALETTE[i % PALETTE.length];
          const seg = (
            <circle
              key={i}
              cx="70" cy="70" r={R} fill="none" stroke={color} strokeWidth="18"
              strokeDasharray={`${Math.max(dash - 1.5, 0.01)} ${C - Math.max(dash - 1.5, 0.01)}`}
              strokeDashoffset={-acc * C}
              transform="rotate(-90 70 70)"
              strokeLinecap="round"
            />
          );
          acc += frac;
          return seg;
        })}
        <text x="70" y="66" textAnchor="middle" fontSize="20" fontWeight="700" fill="#fafafa">
          {total}
        </text>
        <text x="70" y="82" textAnchor="middle" fontSize="9" fill="#71717a">total</text>
      </svg>
      <ul className="w-full max-w-[220px] space-y-1.5">
        {rows.map((r, i) => (
          <li key={i} className="flex items-center gap-2 text-[11.5px] text-foreground">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: PALETTE[i % PALETTE.length] }} />
            <span className="truncate">{r.label}</span>
            <span className="ml-auto font-medium tabular-nums text-ink-muted">
              {Math.round((r.value / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── scatter ────────────────────────────────────────────────────────────── */

function ScatterChartSvg({ rows, xLabel, yLabel }: { rows: Array<{ x: number; y: number }>; xLabel: string; yLabel: string }) {
  const W = 340;
  const H = 170;
  const PAD_L = 30;
  const PAD_B = 26;
  const PAD_T = 12;
  const PAD_R = 8;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const maxX = Math.max(1, ...rows.map((r) => r.x));
  const maxY = Math.max(1, ...rows.map((r) => r.y));
  const px = (x: number) => PAD_L + (x / maxX) * plotW;
  const py = (y: number) => PAD_T + plotH - (y / maxY) * plotH;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-44 w-full" role="img" aria-label="Scatter chart">
      {[0, 0.33, 0.66, 1].map((f) => (
        <line key={f} x1={PAD_L} y1={PAD_T + plotH * (1 - f)} x2={W - PAD_R} y2={PAD_T + plotH * (1 - f)} stroke="#27272a" strokeWidth="1" />
      ))}
      <text x={PAD_L - 6} y={PAD_T + plotH + 4} textAnchor="end" fontSize="9" fill="#71717a">0</text>
      <text x={PAD_L - 6} y={PAD_T + 4} textAnchor="end" fontSize="9" fill="#71717a">{yLabel ? `${maxY} ${yLabel}` : maxY}</text>
      {rows.map((r, i) => (
        <g key={i}>
          <TooltipLabel x={px(r.x)} y={py(r.y) - 9}><tspan>{r.y}</tspan></TooltipLabel>
          <circle cx={px(r.x)} cy={py(r.y)} r="4" fill="#8b5cf6" fillOpacity="0.85" stroke="#0b0b0f" strokeWidth="1" />
        </g>
      ))}
      <text x={PAD_L + plotW / 2} y={H - 6} textAnchor="middle" fontSize="9" fill="#71717a">
        {xLabel || 'x'}
      </text>
    </svg>
  );
}

/* ── dispatch ───────────────────────────────────────────────────────────── */

export function parseChart(json: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeRows(data: unknown, kind: ChartKind): Array<Record<string, unknown>> {
  if (!Array.isArray(data)) return [];
  return data.map(asRow);
}

/** Renders one chart marker body as a responsive SVG chart card. */
export const ChartBlock = memo(function ChartBlock({ kind, json }: { kind: ChartKind; json: string }) {
  const data = useMemo(() => parseChart(json), [json]);
  if (!data) {
    return (
      <div className="my-2.5 rounded-lg border border-surface-700 bg-surface-900 px-3 py-2 text-[11px] text-ink-muted">
        Couldn’t render chart block.
      </div>
    );
  }
  const title = str(data.title);
  const rows = normalizeRows(data.data ?? data.items, kind);

  let body: ReactNode = null;
  if (kind === 'bar') {
    body = <BarChartSvg rows={rows.map((r) => ({ label: str(r.label ?? r.month ?? r.name ?? r.x), value: num(r.value ?? r.y), color: r.color ? str(r.color) : undefined }))} />;
  } else if (kind === 'line') {
    body = <LineChartSvg rows={rows.map((r) => ({ label: str(r.time ?? r.label ?? r.month ?? r.x ?? r.name), value: num(r.value ?? r.y) }))} />;
  } else if (kind === 'pie') {
    body = <PieChartSvg rows={rows.map((r) => ({ label: str(r.name ?? r.label), value: num(r.value) }))} />;
  } else {
    body = (
      <ScatterChartSvg
        rows={rows.map((r) => ({ x: num(r.x ?? 0), y: num(r.y ?? 0) }))}
        xLabel={str(data.x)}
        yLabel={str(data.y)}
      />
    );
  }

  return <ChartShell title={title} kind={kind}>{body}</ChartShell>;
});

/** Slim skeleton while a chart marker is still streaming. */
export const ChartSkeleton = memo(function ChartSkeleton() {
  return (
    <div className="premium-card my-1.5 overflow-hidden rounded-lg border border-surface-700 bg-surface-900/70">
      <div className="flex items-center gap-2 border-b border-surface-700/60 px-2.5 py-1.5">
        <div className="h-4 w-4 animate-pulse rounded bg-surface-800" />
        <div className="h-2.5 w-1/3 animate-pulse rounded-full bg-surface-800" />
      </div>
      <div className="flex h-40 items-end gap-2 px-2.5 py-2">
        {[70, 90, 60, 100, 45, 80, 55].map((h, i) => (
          <div key={i} className="flex-1 animate-pulse rounded-t-md bg-surface-800" style={{ height: `${h}%` }} />
        ))}
      </div>
      <p className="sr-only">Rendering chart…</p>
    </div>
  );
});