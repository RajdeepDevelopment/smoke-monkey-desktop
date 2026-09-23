'use client';

import { memo, useMemo } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  Activity, AlertTriangle, ArrowDownRight, ArrowLeftRight, ArrowUpRight, BarChart3,
  CheckCircle2, Clock, Gauge, Info, Layers, Lightbulb, ListChecks, ListOrdered,
  Minus, Quote, Sparkles, Target, XCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';
import { ErrorBoundary } from '../ErrorBoundary';

/**
 * Structured data-card blocks.
 *
 * The model is told (system prompt) to wrap JSON objects in the card marker:
 *
 *   <card-st>
 *   {
 *     "type": "kpi",
 *     "title": "Monthly Revenue",
 *     "value": "₹8.4L",
 *     "change": "+12.4%",
 *     "trend": "up"
 *   }
 *   <card-ed>
 *
 * Each block becomes a rich shadcn-style card (KPI, metrics grid, progress,
 * checklist, steps, quote, alert, chips, timeline, table…). The renderer is
 * safe: it only ever JSON.parses the block body and ignores unknown types.
 */
/**
 * <card-st>…<card-ed> blocks. The close tag may be written canonically
 * (<card-ed>) or XML-style (<card-st>, </card-ed>); all are accepted.
 */
export const CARD_MARKER_RE =
  /<card-st>[ \t]*\r?\n?([\s\S]*?)[ \t]*\r?\n?<\s*\/?\s*(?:card-ed|card-st)\s*>/g;
/** Any close-tag spelling for a card block (matches the open tag too). */
const CARD_CLOSE_RE = /<\s*\/?\s*(?:card-ed|card-st)\s*>/i;

/** Extract every complete <card-st>…<card-ed> block from a message. */
export function extractCards(text: string): Array<{ json: string; raw: string }> {
  const out: Array<{ json: string; raw: string }> = [];
  CARD_MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CARD_MARKER_RE.exec(text)) !== null) {
    const json = (m[1] ?? '').trim();
    if (json) out.push({ json, raw: m[0] });
  }
  CARD_MARKER_RE.lastIndex = 0;
  return out;
}

/** True when a message has an unclosed (still-streaming) <card-st> block. */
export function hasOpenCard(text: string): boolean {
  const open = /<card-st>/gi;
  let last = -1;
  let mm: RegExpExecArray | null;
  while ((mm = open.exec(text)) !== null) last = mm.index + mm[0].length;
  if (last === -1) return false;
  return !CARD_CLOSE_RE.test(text.slice(last));
}

/** Remove complete card blocks plus any still-streaming open tag. */
export function stripCards(text: string): string {
  const cleaned = text.replace(CARD_MARKER_RE, '');
  return cleaned
    .replace(/<card-st>[ \t]*\r?\n?[^<\n]*$/gi, '')
    .replace(/^[ \t]*<card-ed>[ \t]*$/gim, '');
}

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'primary' | 'neutral';

const TONE_TEXT: Record<Tone, string> = {
  success: 'text-emerald-400',
  warning: 'text-amber-400',
  danger: 'text-red-400',
  info: 'text-sky-400',
  primary: 'text-violet-400',
  neutral: 'text-ink-muted',
};

const TONE_BG: Record<Tone, string> = {
  success: 'bg-emerald-500/10',
  warning: 'bg-amber-500/10',
  danger: 'bg-red-500/10',
  info: 'bg-sky-500/10',
  primary: 'bg-violet-500/10',
  neutral: 'bg-surface-800',
};

const TONE_BORDER: Record<Tone, string> = {
  success: 'border-emerald-500/30',
  warning: 'border-amber-500/30',
  danger: 'border-red-500/30',
  info: 'border-sky-500/30',
  primary: 'border-violet-500/30',
  neutral: 'border-surface-700',
};

function toneOf(raw: unknown): Tone {
  const t = String(raw ?? 'neutral').toLowerCase();
  if (t === 'success' || t === 'ok' || t === 'good' || t === 'green') return 'success';
  if (t === 'warning' || t === 'warn' || t === 'amber') return 'warning';
  if (t === 'danger' || t === 'error' || t === 'fail' || t === 'red') return 'danger';
  if (t === 'info' || t === 'blue' || t === 'sky') return 'info';
  if (t === 'primary' || t === 'violet' || t === 'accent') return 'primary';
  return 'neutral';
}

function str(v: unknown): string {
  if (v == null) return '';
  return String(v);
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number.parseFloat(str(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

interface CardShellProps {
  title?: string;
  tone: Tone;
  icon: LucideIcon;
  badge?: string;
  children: ReactNode;
  className?: string;
}

function CardShell({ title, tone, icon: Icon, badge, children, className }: CardShellProps) {
  return (
    <section
      className={cn(
        'premium-card relative my-1.5 overflow-hidden rounded-lg border bg-gradient-to-b from-surface-850 to-surface-900 shadow-[0_1px_0_rgba(255,255,255,0.04)_inset,0_8px_24px_-12px_rgba(0,0,0,0.5)]',
        TONE_BORDER[tone],
        className,
      )}
    >
      <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />
      {(title || badge) && (
        <header className="flex items-center gap-2 border-b border-surface-700/60 bg-gradient-to-b from-white/[0.02] to-transparent px-2.5 py-1.5">
          <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded', TONE_BG[tone])}>
            <Icon className={cn('h-3 w-3', TONE_TEXT[tone])} />
          </span>
          {title && (
            <h4 className="truncate text-[11px] font-semibold tracking-tight text-foreground">{title}</h4>
          )}
          {badge && (
            <span
              className={cn(
                'ml-auto shrink-0 rounded-full px-1.5 py-px text-[8.5px] font-semibold uppercase tracking-widest',
                TONE_BG[tone],
                TONE_TEXT[tone],
              )}
            >
              {badge}
            </span>
          )}
        </header>
      )}
      <div className="px-2.5 py-2">{children}</div>
    </section>
  );
}

/* ── individual card types ──────────────────────────────────────────────── */

function Sparkline({ data, tone }: { data: number[]; tone: Tone }) {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const w = 96;
  const h = 28;
  const pts = data
    .map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / span) * (h - 4) - 2}`)
    .join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-7 w-24" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" className={TONE_TEXT[tone]} />
    </svg>
  );
}

function KpiCard({ data, tone }: { data: Record<string, unknown>; tone: Tone }) {
  const trend = str(data.trend).toLowerCase();
  const up = trend === 'up' || Number(str(data.change).replace(/[^\d.-]/g, '')) > 0;
  const flat = trend === 'flat' || trend === 'steady';
  const TrendIcon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  const spark = Array.isArray(data.spark) ? data.spark.map(num) : [];
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        {Boolean(data.subtitle) && <p className="text-[10px] uppercase tracking-wider text-ink-muted">{str(data.subtitle)}</p>}
        <p className="mt-0.5 text-xl font-semibold leading-none tracking-tight text-foreground">
          {str(data.value ?? data.valueNumber ?? '—')}
        </p>
        <p className="mt-1 text-[10.5px] text-ink-muted">{str(data.label || data.title)}</p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        {spark.length > 0 && <Sparkline data={spark} tone={tone} />}
        {data.change !== undefined && (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[10px] font-semibold',
              flat ? 'bg-surface-800 text-ink-muted' : up ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400',
            )}
          >
            <TrendIcon className="h-3 w-3" />
            {str(data.change)}
          </span>
        )}
      </div>
    </div>
  );
}

function MetricsCard({ data, tone }: { data: Record<string, unknown>; tone: Tone }) {
  const items = (Array.isArray(data.items) ? data.items : []).map(
    (it) => (typeof it === 'object' && it !== null ? (it as Record<string, unknown>) : { label: str(it) }),
  );
  if (items.length === 0) return <KpiCard data={data} tone={tone} />;
  return (
    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((it, i) => (
        <div key={i} className="rounded-md border border-surface-700/70 bg-surface-850/60 px-2.5 py-2">
          <p className="text-[10px] uppercase tracking-wider text-ink-muted">{str(it.label || it.title)}</p>
          <p className="mt-0.5 text-base font-semibold tracking-tight text-foreground">{str(it.value)}</p>
          {it.change !== undefined && (
            <p
              className={cn(
                'mt-0.5 text-[10px] font-medium',
                String(it.change).includes('-') ? 'text-red-400' : 'text-emerald-400',
              )}
            >
              {str(it.change)}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function ProgressCard({ data, tone }: { data: Record<string, unknown>; tone: Tone }) {
  const max = Math.max(1, num(data.max) || 100);
  const clamp = Math.max(0, Math.min(100, (num(data.value) / max) * 100));
  const pct = Math.round(clamp);
  const showValue = str(data.percent ?? data.value).slice(0, 40);
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <p className="truncate text-[11px] text-ink-muted">{str(data.label || data.title)}</p>
        <p className={cn('text-[13px] font-semibold tabular-nums', TONE_TEXT[tone])}>
          {showValue || `${pct}%`}
        </p>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-800" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div
          className={cn('h-full rounded-full transition-all', TONE_BG[tone])}
          style={{ width: `${clamp}%` } as CSSProperties}
        />
      </div>
      {Boolean(data.note) && <p className="mt-1.5 text-[11px] text-ink-muted">{str(data.note)}</p>}
    </div>
  );
}

/** type: metric — single live value with subtitle + state dot. */
function MetricCard({ data, tone }: { data: Record<string, unknown>; tone: Tone }) {
  const status = str(data.status).toLowerCase();
  const dot =
    ['healthy', 'ok', 'up', 'operational', 'success', 'good'].includes(status)
      ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]'
      : ['warning', 'warn', 'degraded', 'slow', 'busy'].includes(status)
        ? 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.6)]'
        : ['down', 'error', 'failed', 'critical'].includes(status)
          ? 'bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.6)]'
          : 'bg-ink-muted/60';
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-wider text-ink-muted">{str(data.subtitle)}</p>
        <p className="mt-0.5 text-xl font-semibold leading-none tracking-tight text-foreground">
          {str(data.value)}
        </p>
        <p className="mt-1 text-[10.5px] text-ink-muted">{str(data.label || data.title)}</p>
      </div>
      {status && (
        <span className={cn('mt-1 inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-px text-[10px] font-medium capitalize', TONE_BORDER[tone], TONE_BG[tone])}>
          <span className={cn('h-1.5 w-1.5 rounded-full', dot)} />
          {status}
        </span>
      )}
    </div>
  );
}

/** type: comparison — current vs previous with delta pill. */
function ComparisonCard({ data, tone }: { data: Record<string, unknown>; tone: Tone }) {
  const change = str(data.change);
  const numeric = Number(change.replace(/[^\d.-]/g, ''));
  const up = numeric > 0 || String(data.trend).toLowerCase() === 'up';
  const flat = String(data.trend).toLowerCase() === 'flat' || numeric === 0;
  const TrendIcon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  const Row = ({ label, value, muted }: { label: string; value: string; muted?: boolean }) => (
    <div className="flex items-center justify-between gap-3 rounded-md border border-surface-700/70 bg-surface-850/60 px-2.5 py-1.5">
      <span className="text-[11px] text-ink-muted">{label}</span>
      <span className={cn('text-[12.5px] font-semibold tabular-nums', muted ? 'text-ink-secondary' : 'text-foreground')}>
        {value}
      </span>
    </div>
  );
  return (
    <div className="space-y-1.5">
      <Row label="Current" value={str(data.current)} />
      <Row label="Previous" value={str(data.previous)} muted />
      <div className="flex items-center justify-between px-0.5">
        <span className="text-[11px] text-ink-muted">Change</span>
        <span
          className={cn(
            'inline-flex items-center gap-0.5 rounded-full px-2 py-px text-[10.5px] font-semibold',
            flat ? 'bg-surface-800 text-ink-muted' : up ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400',
          )}
        >
          <TrendIcon className="h-3 w-3" />
          {change || 'flat'}
        </span>
      </div>
    </div>
  );
}

/** type: status — operational / healthy live status with updated timestamp. */
function StatusCard({ data, tone }: { data: Record<string, unknown>; tone: Tone }) {
  const status = str(data.status).toLowerCase();
  const label = str(data.status || data.state || data.tone || 'unknown');
  const isUp = ['operational', 'healthy', 'ok', 'up', 'success', 'connected', 'passed', 'good'].includes(status);
  const isWarn = ['warning', 'degraded', 'slow', 'warning', 'maintenance'].includes(status);
  const Icon = isUp ? CheckCircle2 : isWarn ? AlertTriangle : XCircle;
  const textCls = isUp ? 'text-emerald-400' : isWarn ? 'text-amber-400' : 'text-red-400';
  return (
    <div>
      <div className="flex items-center gap-3">
        <span className={cn('relative flex h-2.5 w-2.5 shrink-0')}>
          <span
            className={cn(
              'absolute inline-flex h-full w-full animate-ping rounded-full opacity-60',
              isUp ? 'bg-emerald-400' : isWarn ? 'bg-amber-400' : 'bg-red-400',
            )}
          />
          <span
            className={cn(
              'relative inline-flex h-2.5 w-2.5 rounded-full',
              isUp ? 'bg-emerald-400' : isWarn ? 'bg-amber-400' : 'bg-red-400',
            )}
          />
        </span>
        <div className="flex min-w-0 items-center gap-2">
          <p className={cn('truncate text-[14px] font-semibold capitalize leading-tight', textCls)}>{label}</p>
          <Icon className={cn('h-3.5 w-3.5 shrink-0', textCls)} />
        </div>
      </div>
      {Boolean(data.message) && <p className="mt-2 text-[12px] leading-snug text-foreground/90">{str(data.message)}</p>}
      {Boolean(data.details) && <p className="mt-1 text-[11px] text-ink-muted">{str(data.details)}</p>}
      {Boolean(data.updatedAt) && (
        <p className="mt-2 inline-flex items-center gap-1 text-[10.5px] text-ink-muted">
          <Clock className="h-2.5 w-2.5" /> Updated {str(data.updatedAt)}
        </p>
      )}
    </div>
  );
}

/** type: callout — inline note (info / tip / warn / error). */
function CalloutCard({ data, tone, icon: Icon }: { data: Record<string, unknown>; tone: Tone; icon: LucideIcon }) {
  return (
    <div className={cn('flex items-start gap-3 rounded-md border px-2.5 py-2', TONE_BORDER[tone], TONE_BG[tone])}>
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', TONE_TEXT[tone])} />
      <div className="min-w-0">
        {Boolean(data.title) && <p className={cn('text-[12px] font-semibold', TONE_TEXT[tone])}>{str(data.title)}</p>}
        {Boolean(data.message || data.text || data.body) && (
          <p className="mt-0.5 text-[11.5px] leading-snug text-foreground/90">{str(data.message || data.text || data.body)}</p>
        )}
      </div>
    </div>
  );
}

function ChecklistCard({ data }: { data: Record<string, unknown> }) {
  const items = Array.isArray(data.items) ? data.items : [];
  return (
    <ul className="space-y-1.5">
      {items.map((it, i) => {
        const label = typeof it === 'object' && it !== null ? str((it as Record<string, unknown>).label ?? (it as Record<string, unknown>).text) : str(it);
        const done = typeof it === 'object' && it !== null ? Boolean((it as Record<string, unknown>).done ?? (it as Record<string, unknown>).checked) : false;
        return (
          <li key={i} className="flex items-start gap-2.5 text-[12.5px] leading-snug text-foreground">
            {done ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
            ) : (
              <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full border border-ink-muted/50" />
            )}
            <span className={cn(done && 'text-ink-muted line-through opacity-70')}>{label}</span>
          </li>
        );
      })}
    </ul>
  );
}

function StepsCard({ data }: { data: Record<string, unknown> }) {
  const steps = Array.isArray(data.steps) ? data.steps : [];
  return (
    <ol className="space-y-0">
      {steps.map((s, i) => {
        const label = typeof s === 'object' && s !== null ? str((s as Record<string, unknown>).label ?? (s as Record<string, unknown>).title) : str(s);
        const detail = typeof s === 'object' && s !== null ? str((s as Record<string, unknown>).detail) : '';
        return (
          <li key={i} className="relative flex gap-3 pb-3 last:pb-0">
            {i < steps.length - 1 && <span className="absolute left-[9px] top-5 h-full w-px bg-surface-700" />}
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-800 text-[10px] font-bold text-primary-hover">
              {i + 1}
            </span>
            <div className="min-w-0">
              <p className="text-[12.5px] font-medium text-foreground">{label}</p>
              {detail && <p className="mt-0.5 text-[11.5px] text-ink-muted">{detail}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function QuoteCard({ data, tone }: { data: Record<string, unknown>; tone: Tone }) {
  return (
    <blockquote className="relative">
      <Quote className={cn('absolute -top-1 left-0 h-5 w-5', TONE_TEXT[tone])} fill="currentColor" strokeWidth={0} opacity={0.35} />
      <p className="pl-7 text-[13px] italic leading-relaxed text-foreground">{str(data.text || data.message)}</p>
      {Boolean(data.author) && <footer className="mt-2 pl-7 text-[11.5px] font-medium text-ink-muted">— {str(data.author)}</footer>}
    </blockquote>
  );
}

function AlertCard({ data, tone, icon: Icon }: { data: Record<string, unknown>; tone: Tone; icon: LucideIcon }) {
  return (
    <div className={cn('flex items-start gap-3 rounded-md border px-2.5 py-2', TONE_BORDER[tone], TONE_BG[tone])}>
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', TONE_TEXT[tone])} />
      <div className="min-w-0">
        <p className={cn('text-[12px] font-semibold', TONE_TEXT[tone])}>{str(data.title)}</p>
        {Boolean(data.message || data.text) && <p className="mt-1 text-[11.5px] leading-snug text-foreground/90">{str(data.message || data.text)}</p>}
      </div>
    </div>
  );
}

function TagsCard({ data }: { data: Record<string, unknown> }) {
  const tags = Array.isArray(data.tags) ? data.tags : [];
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((t, i) => {
        if (typeof t === 'object' && t !== null) {
          const tt = t as Record<string, unknown>;
          const tone = toneOf(tt.tone);
          return (
            <span key={i} className={cn('rounded-full border px-2 py-0.5 text-[10.5px] font-medium', TONE_BORDER[tone], TONE_BG[tone], TONE_TEXT[tone])}>
              {str(tt.label ?? tt.text)}
            </span>
          );
        }
        return (
          <span key={i} className="rounded-full border border-surface-700 bg-surface-800 px-2 py-0.5 text-[10.5px] font-medium text-ink-secondary">
            {str(t)}
          </span>
        );
      })}
    </div>
  );
}

function TimelineCard({ data }: { data: Record<string, unknown> }) {
  const items = (Array.isArray(data.items) ? data.items : Array.isArray(data.events) ? data.events : []).map(
    (it) => (typeof it === 'object' && it !== null ? (it as Record<string, unknown>) : { title: str(it) }),
  );
  return (
    <ol className="space-y-0">
      {items.map((row, i) => {
        const tone = toneOf(row.tone ?? row.status);
        const autoTone =
          String(row.status ?? '').toLowerCase() === 'completed' || String(row.status ?? '').toLowerCase() === 'passed'
            ? 'success'
            : ['running', 'pending', 'queued', 'deploying'].includes(String(row.status ?? '').toLowerCase())
              ? 'info'
              : ['failed', 'error', 'cancelled'].includes(String(row.status ?? '').toLowerCase())
                ? 'danger'
                : tone;
        const dot = autoTone === 'neutral' && !row.tone ? 'bg-primary/40' : TONE_BG[autoTone];
        const time = str(row.time ?? row.at ?? row.date);
        return (
          <li key={i} className="relative flex gap-3 pb-3 last:pb-0">
            {i < items.length - 1 && <span className="absolute left-[5px] top-4 h-full w-px bg-surface-700" />}
            <span className={cn('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', dot)} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="text-[12.5px] font-medium text-foreground">{str(row.title ?? row.message)}</p>
                {Boolean(row.status) && (
                  <span className={cn('shrink-0 rounded-full px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide', TONE_BG[autoTone], TONE_TEXT[autoTone])}>
                    {str(row.status)}
                  </span>
                )}
                {time && (
                  <span className="ml-auto inline-flex items-center gap-1 shrink-0 text-[10px] text-ink-muted">
                    <Clock className="h-2.5 w-2.5" />
                    {time}
                  </span>
                )}
              </div>
              {Boolean(row.detail) && <p className="mt-0.5 text-[11.5px] text-ink-muted">{str(row.detail)}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function TableCard({ data }: { data: Record<string, unknown> }) {
  const columns = (Array.isArray(data.columns) ? data.columns : []).map(str);
  const rows = Array.isArray(data.rows) ? data.rows : [];
  if (columns.length === 0 || rows.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-lg border border-surface-700/70">
      <table className="w-full min-w-[360px] border-collapse text-left">
        <thead>
          <tr className="border-b border-surface-700/70 bg-surface-800/50">
            {columns.map((c, i) => (
              <th key={i} className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className={cn('border-b border-surface-800 last:border-0', i % 2 === 1 && 'bg-surface-850/40')}>
              {(Array.isArray(row) ? row : [row]).map((cell, j) => (
                <td key={j} className="px-2.5 py-1.5 text-[11.5px] text-foreground">
                  {str(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KeyValueCard({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(([k]) => !['type', 'title'].includes(k));
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
      {entries.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-[10px] uppercase tracking-wider text-ink-muted">{k}</dt>
          <dd className="truncate text-[12.5px] font-medium text-foreground">{str(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ── top-level dispatch ─────────────────────────────────────────────────── */

export function parseCard(json: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function typeIcon(type: string): LucideIcon {
  switch (type) {
    case 'kpi': case 'stat': return Target;
    case 'metric': case 'metric-card': return Activity;
    case 'metrics': case 'group': case 'grid': return BarChart3;
    case 'progress': return Gauge;
    case 'list': case 'checklist': return ListChecks;
    case 'steps': case 'howto': case 'plan': return ListOrdered;
    case 'quote': case 'insight': return Quote;
    case 'alert': case 'error': return AlertTriangle;
    case 'status': case 'service-status': return Activity;
    case 'callout': case 'note': case 'thought': case 'info': return Lightbulb;
    case 'comparison': return ArrowLeftRight;
    case 'tags': case 'chips': return Layers;
    case 'timeline': return Clock;
    case 'table': return BarChart3;
    default: return Sparkles;
  }
}

function AlertIconFor(type: string): LucideIcon {
  return type === 'error' ? XCircle : type === 'success' ? CheckCircle2 : AlertTriangle;
}

function cardBody(
  type: string,
  data: Record<string, unknown>,
  tone: Tone,
): ReactNode {
  switch (type) {
    case 'kpi': case 'stat':
      return <KpiCard data={data} tone={tone} />;
    case 'metric': case 'metric-card':
      return <MetricCard data={data} tone={tone} />;
    case 'metrics': case 'group': case 'grid':
      return <MetricsCard data={data} tone={tone} />;
    case 'progress':
      return <ProgressCard data={data} tone={tone} />;
    case 'list': case 'checklist':
      return <ChecklistCard data={data} />;
    case 'steps': case 'howto': case 'plan':
      return <StepsCard data={data} />;
    case 'quote': case 'insight':
      return <QuoteCard data={data} tone={tone} />;
    case 'alert': case 'error': case 'success':
      return <AlertCard data={data} tone={tone} icon={AlertIconFor(type)} />;
    case 'status': case 'service-status':
      return <StatusCard data={data} tone={tone} />;
    case 'callout': case 'note': case 'thought': case 'info':
      return <CalloutCard data={data} tone={tone} icon={Lightbulb} />;
    case 'comparison':
      return <ComparisonCard data={data} tone={tone} />;
    case 'tags': case 'chips':
      return <TagsCard data={data} />;
    case 'timeline':
      return <TimelineCard data={data} />;
    case 'table':
      return <TableCard data={data} />;
    default:
      return <KeyValueCard data={data} />;
  }
}

/** Renders one parsed card JSON object as a premium responsive block. */
export const CardBlock = memo(function CardBlock({ json }: { json: string }) {
  const parsed = useMemo(() => parseCard(json), [json]);
  if (!parsed) {
    return (
      <div className="my-1.5 rounded-md border border-surface-700 bg-surface-900 px-2.5 py-1.5 text-[11px] text-ink-muted">
        <Info className="mr-1.5 inline h-3 w-3" />
        Couldn’t render card block.
      </div>
    );
  }
  const type = str(parsed.type || 'note').toLowerCase();
  const tone = toneOf(parsed.tone ?? parsed.type ?? parsed.severity);
  const Icon = typeIcon(type);
  const title = str(parsed.title);
  const badge = str(parsed.badge);
  return (
    <ErrorBoundary>
      <CardShell title={title} tone={tone} icon={Icon} badge={badge}>
        {cardBody(type, parsed, tone)}
      </CardShell>
    </ErrorBoundary>
  );
});

/** Slim skeleton shown while a <card-st> block is still streaming. */
export const CardSkeleton = memo(function CardSkeleton() {
  return (
    <div className="premium-card my-1.5 overflow-hidden rounded-lg border border-surface-700 bg-surface-900/70">
      <div className="flex items-center gap-2 border-b border-surface-700/60 px-2.5 py-1.5">
        <div className="flex h-4 w-4 animate-pulse items-center justify-center rounded bg-surface-800" />
        <div className="h-2.5 w-1/3 animate-pulse rounded-full bg-surface-800" />
      </div>
      <div className="space-y-1.5 px-2.5 py-2">
        <div className="h-2.5 w-2/5 animate-pulse rounded-full bg-surface-800" />
        <div className="h-2.5 w-3/5 animate-pulse rounded-full bg-surface-800" />
        <div className="h-2 w-full animate-pulse rounded-full bg-surface-800/70" />
      </div>
      <p className="sr-only">Rendering insight card…</p>
    </div>
  );
});

export type WidgetHint = 'timeline' | 'progress' | 'status' | 'alert' | 'callout';

/**
 * Renders a dedicated-widget marker body (<alert-st>, <status-st>,
 * <progress-st>, <timeline-st>, <callout-st>…). These JSON blobs don’t carry a
 * `type` field, so the marker name is passed down as the hint.
 */
export const WidgetCard = memo(function WidgetCard({ json, hint }: { json: string; hint?: WidgetHint }) {
  const parsed = useMemo(() => parseCard(json), [json]);
  if (!parsed) {
    return (
      <div className="my-1.5 rounded-md border border-surface-700 bg-surface-900 px-2.5 py-1.5 text-[11px] text-ink-muted">
        <Info className="mr-1.5 inline h-3 w-3" />
        Couldn’t render block.
      </div>
    );
  }
  const type = str(parsed.type || hint || 'detail').toLowerCase();
  const tone = toneOf(parsed.tone ?? parsed.type ?? parsed.severity);
  const Icon = typeIcon(type);
  const title = str(parsed.title);
  const badge = str(parsed.badge);
  return (
    <ErrorBoundary>
      <CardShell title={title} tone={tone} icon={Icon} badge={badge}>
        {cardBody(type, parsed, tone)}
      </CardShell>
    </ErrorBoundary>
  );
});