'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import {
  MessageSquare,
  FileText,
  Layers,
  Gauge,
  Plus,
  Upload,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  FileSearch,
} from 'lucide-react';
import type { ConversationDto, DocumentDto } from '@rag/contracts';
import { api } from '../../lib/api';
import { useAuth } from '../../components/AuthProvider';
import { MetricCard } from '../../components/MetricCard';
import { EmptyState } from '../../components/EmptyState';
import { StatusBadge } from '../../components/StatusBadge';
import { PageScroll } from '../../components/PageScroll';
import { formatDate, formatRelative } from '../../lib/utils';

interface Health {
  status: string;
  postgres?: boolean;
  redis?: boolean;
  nats?: boolean;
}

interface SystemEntry {
  label: string;
  ok: boolean | null;
  note: string;
}

function MiniBarChart({ docs }: { docs: DocumentDto[] }) {
  interface Bucket {
    key: string;
    label: string;
    count: number;
  }

  const buckets = useMemo<Bucket[]>(() => {
    const days: Bucket[] = Array.from({ length: 7 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (6 - i));
      const key = d.toDateString();
      return { key, label: d.toLocaleDateString(undefined, { weekday: 'narrow' }), count: 0 };
    });
    const map = new Map(days.map((b) => [b.key, b]));
    for (const doc of docs) {
      const key = new Date(doc.createdAt).toDateString();
      const bucket = map.get(key);
      if (bucket) bucket.count += 1;
    }
    return days;
  }, [docs]);

  const max = Math.max(1, ...buckets.map((b) => b.count));

  return (
    <div className="flex h-28 items-end gap-1.5">
      {buckets.map((b, i) => (
        <div key={i} className="flex flex-1 flex-col items-center gap-1.5" title={`${b.label}: ${b.count}`}>
          <div className="relative flex w-full flex-1 items-end">
            <motion.div
              initial={{ height: 0 }}
              animate={{ height: `${Math.max(8, (b.count / max) * 100)}%` }}
              transition={{ duration: 0.5, delay: i * 0.05, ease: 'easeOut' }}
              className={`w-full rounded-t-md ${
                b.count > 0 ? 'bg-primary/70' : 'bg-surface-800'
              }`}
            />
          </div>
          <span className="text-[9px] font-medium uppercase text-ink-muted">{b.label}</span>
        </div>
      ))}
    </div>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  const [conversations, setConversations] = useState<ConversationDto[] | null>(null);
  const [documents, setDocuments] = useState<DocumentDto[] | null>(null);
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    if (!user) return;
    api
      .listConversations()
      .then(setConversations)
      .catch(() => setConversations([]));
    api
      .listDocuments()
      .then(setDocuments)
      .catch(() => setDocuments([]));
    api
      .health()
      .then(setHealth)
      .catch(() => setHealth(null));
  }, [user]);

  const docs = documents ?? [];
  const convos = conversations ?? [];
  const loading = conversations === null && documents === null;

  const readyDocs = docs.filter((d) => d.status === 'ready').length;
  const totalChunks = docs.reduce((sum, d) => sum + (d.chunkCount || 0), 0);
  const activeThisWeek = convos.filter((c) => {
    const age = Date.now() - new Date(c.createdAt).getTime();
    return age < 7 * 24 * 3600_000;
  }).length;

  const firstName = user?.name?.split(' ')[0] ?? user?.email?.split('@')[0] ?? 'there';
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  const systemEntries: SystemEntry[] = [
    { label: 'Postgres', ok: health?.postgres ?? null, note: 'Vector store · metadata' },
    { label: 'Redis', ok: health?.redis ?? null, note: 'Cache · telemetry' },
    { label: 'NATS', ok: health?.nats ?? null, note: 'Async pipeline' },
    { label: 'Vector Search', ok: health?.postgres ?? null, note: 'pgvector · HNSW' },
    { label: 'LLM Gateway', ok: health ? true : null, note: 'Hybrid retrieval' },
  ];
  const allOk = health && [health.postgres, health.redis, health.nats].every(Boolean);

  return (
    <PageScroll>
      <div className="mx-auto w-full max-w-[1400px] space-y-6">
        {/* ── Hero ─────────────────────────────────────────────────── */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: 'easeOut' }}
          className="relative overflow-hidden rounded-card border border-primary/15 bg-gradient-to-b from-primary/10 via-surface-900/60 to-surface-900/30 px-5 py-6 sm:px-7 sm:py-8"
        >
          <div className="pointer-events-none absolute -right-24 -top-32 h-72 w-72 rounded-full bg-primary/15 blur-3xl" />
          <div className="pointer-events-none absolute -left-16 -bottom-24 h-48 w-48 rounded-full bg-accent/10 blur-3xl" />
          <div className="relative flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-[26px] font-semibold tracking-tight text-white sm:text-3xl">
                {greeting}, <span className="text-gradient">{firstName}</span>
              </h2>
              <p className="mt-1.5 text-sm text-ink-secondary">
                Here&apos;s what&apos;s happening with your AI workspace.
              </p>
              <div className="mt-3 flex items-center gap-2">
                <StatusBadge
                  label={allOk ? 'All systems operational' : 'Checking systems…'}
                  tone={allOk ? 'success' : 'neutral'}
                  pulse={!allOk}
                />
                <span className="hidden items-center gap-1 text-xs text-ink-muted sm:flex">
                  <span className="h-1 w-1 rounded-full bg-accent" /> Retrieval: Hybrid
                </span>
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Link
                href="/chat"
                className="btn-primary h-10 px-5"
              >
                <Plus className="h-4 w-4" />
                New chat
              </Link>
              <Link href="/documents" className="btn-secondary h-10 px-5">
                <Upload className="h-4 w-4" />
                Upload documents
              </Link>
            </div>
          </div>
        </motion.div>

        {/* ── Metric cards ─────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <MetricCard
            label="Total chats"
            value={loading ? '0' : convos.length.toLocaleString()}
            hint={activeThisWeek > 0 ? `${activeThisWeek} this week` : 'across all conversations'}
            icon={<MessageSquare className="h-[18px] w-[18px]" />}
            accent="primary"
            loading={loading}
          />
          <MetricCard
            label="Documents"
            value={loading ? '0' : docs.length.toLocaleString()}
            hint={`${readyDocs} ready to query`}
            icon={<FileText className="h-[18px] w-[18px]" />}
            accent="accent"
            loading={loading}
          />
          <MetricCard
            label="Chunks indexed"
            value={loading ? '0' : totalChunks.toLocaleString()}
            hint="available for retrieval"
            icon={<Layers className="h-[18px] w-[18px]" />}
            accent="success"
            loading={loading}
          />
          <MetricCard
            label="Tokens used"
            value="—"
            hint="telemetry coming soon"
            icon={<Gauge className="h-[18px] w-[18px]" />}
            accent="warning"
            loading={loading}
          />
        </div>

        {/* ── Activity panels ──────────────────────────────────────── */}
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Recent conversations */}
          <motion.section
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.05, ease: 'easeOut' }}
            className="card flex flex-col p-5"
          >
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-ink-muted" />
                <h3 className="text-sm font-semibold text-white">Recent conversations</h3>
              </div>
              <Link href="/chat" className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
                Open chat <ArrowRight className="h-3 w-3" />
              </Link>
            </div>

            {loading ? (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex items-center justify-between rounded-lg px-2 py-2.5">
                    <div className="h-3.5 w-40 animate-pulse rounded bg-surface-700/60" />
                    <div className="h-3 w-12 animate-pulse rounded bg-surface-700/50" />
                  </div>
                ))}
              </div>
            ) : convos.length === 0 ? (
              <EmptyState
                compact
                icon={<MessageSquare className="h-6 w-6" />}
                title="Start your first conversation"
                description="Ask anything about your documents and Smoke Monkey will answer with sources."
                action={
                  <Link href="/chat" className="btn-primary">
                    <Plus className="h-4 w-4" /> New chat
                  </Link>
                }
              />
            ) : (
              <ul className="-mx-2 space-y-0.5">
                {convos.slice(0, 6).map((c, i) => (
                  <motion.li
                    key={c.id}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.25, delay: i * 0.04 }}
                  >
                    <Link
                      href={`/chat?c=${c.id}`}
                      className="group flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-surface-800/60"
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <MessageSquare className="h-3.5 w-3.5 shrink-0 text-ink-muted group-hover:text-primary" />
                        <span className="truncate text-sm text-ink-primary">{c.title}</span>
                      </div>
                      <span className="shrink-0 text-xs text-ink-muted">
                        {formatRelative(c.createdAt)}
                      </span>
                    </Link>
                  </motion.li>
                ))}
              </ul>
            )}
          </motion.section>

          {/* Knowledge activity */}
          <motion.section
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.1, ease: 'easeOut' }}
            className="card flex flex-col p-5"
          >
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <BookOpen className="h-4 w-4 text-ink-muted" />
                <h3 className="text-sm font-semibold text-white">Knowledge activity</h3>
              </div>
              <Link href="/documents" className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
                Manage <ArrowRight className="h-3 w-3" />
              </Link>
            </div>

            {loading ? (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex items-center justify-between rounded-lg px-2 py-2.5">
                    <div className="h-3.5 w-36 animate-pulse rounded bg-surface-700/60" />
                    <div className="h-3 w-14 animate-pulse rounded bg-surface-700/50" />
                  </div>
                ))}
              </div>
            ) : docs.length === 0 ? (
              <EmptyState
                compact
                icon={<FileSearch className="h-6 w-6" />}
                title="Your knowledge base is empty"
                description="Upload documents and Smoke Monkey will index them for intelligent retrieval."
                action={
                  <Link href="/documents" className="btn-secondary">
                    <Upload className="h-4 w-4" /> Upload documents
                  </Link>
                }
              />
            ) : (
              <>
                <div className="mb-3 rounded-lg border border-surface-800 bg-surface-900/50 p-3">
                  <div className="mb-2 flex items-center justify-between text-xs">
                    <span className="text-ink-muted">Uploads · last 7 days</span>
                    <span className="font-medium text-ink-secondary">{docs.length} total</span>
                  </div>
                  <MiniBarChart docs={docs} />
                </div>
                <ul className="space-y-1">
                  {docs.slice(0, 4).map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <FileText className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
                        <span className="truncate text-[13px] text-ink-primary">{d.filename}</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {d.status === 'ready' ? (
                          <StatusBadge label="Indexed" tone="success" />
                        ) : (
                          <StatusBadge label={d.status} tone="warning" pulse />
                        )}
                        <span className="text-xs text-ink-muted">{formatDate(d.createdAt)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </motion.section>
        </div>

        {/* ── System status ────────────────────────────────────────── */}
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.15, ease: 'easeOut' }}
          className="card p-5"
        >
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-ink-muted" />
              <h3 className="text-sm font-semibold text-white">System status</h3>
            </div>
            <StatusBadge
              label={allOk ? 'All systems operational' : health ? 'Degraded' : 'Checking…'}
              tone={allOk ? 'success' : health ? 'warning' : 'neutral'}
              pulse={!allOk}
            />
          </div>

          {health === null && !loading ? (
            <p className="text-sm text-ink-muted">Checking service health…</p>
          ) : (
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
              {systemEntries.map((entry) => (
                <div
                  key={entry.label}
                  className="flex items-center gap-3 rounded-lg border border-surface-800 bg-surface-900/50 px-3 py-2.5"
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${entry.ok ? 'bg-success' : entry.ok === null ? 'animate-pulse bg-warning' : 'bg-destructive'}`} />
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-ink-primary">{entry.label}</p>
                    <p className="truncate text-[11px] text-ink-muted">{entry.note}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </motion.section>
      </div>
    </PageScroll>
  );
}
