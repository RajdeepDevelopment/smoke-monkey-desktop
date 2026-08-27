'use client';

import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { FileText, Loader2, Trash2 } from 'lucide-react';
import type { DocumentDto, DocumentStatus } from '@rag/contracts';
import { api } from '../lib/api';
import { StatusBadge } from './StatusBadge';
import { useToast } from './Toast';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from './ui/alert-dialog';
import { cn, formatBytes, formatRelative } from '../lib/utils';

const STATUS_TONE: Record<DocumentStatus, 'success' | 'warning' | 'error' | 'info' | 'primary'> = {
  uploading: 'warning',
  processing: 'primary',
  ready: 'success',
  failed: 'error',
};

function DeleteButton({ doc, onDeleted }: { doc: DocumentDto; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteDocument(doc.id);
      toast.info('Document deleted', doc.filename);
      onDeleted();
    } catch (err) {
      toast.error('Delete failed', (err as Error).message);
      setBusy(false);
    }
  };

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <button
          type="button"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-error-subtle hover:text-red-300"
          aria-label={`Delete ${doc.filename}`}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete document?</AlertDialogTitle>
          <AlertDialogDescription>
            “{doc.filename}” will be removed from your knowledge base. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-white hover:bg-destructive/90"
            onClick={(e) => {
              e.preventDefault();
              void remove();
            }}
          >
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DocMeta({ doc, className }: { doc: DocumentDto; className?: string }) {
  const size = typeof doc.metadata?.size === 'number' ? formatBytes(doc.metadata.size) : null;
  const chunks = doc.chunkCount > 0 ? `${doc.chunkCount} chunks` : null;
  return (
    <span className={cn('text-xs text-ink-muted', className)}>
      {[size, chunks, formatRelative(doc.createdAt)].filter(Boolean).join(' · ')}
    </span>
  );
}

/**
 * Knowledge Base list. Desktop: table. Mobile: stacked cards. Polls while any
 * document is still indexing. Deletion is guarded by a confirmation dialog.
 */
export function DocumentList({ version = 0, onChanged }: { version?: number; onChanged?: () => void }) {
  const [documents, setDocuments] = useState<DocumentDto[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    let list: DocumentDto[] = [];
    try {
      list = await api.listDocuments();
      setDocuments(list);
    } finally {
      setLoading(false);
    }
    const inFlight = list.some((d) => d.status === 'uploading' || d.status === 'processing');
    if (inFlight) setTimeout(refresh, 2500);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, version]);

  const handleDeleted = useCallback(() => {
    void refresh();
    onChanged?.();
  }, [refresh, onChanged]);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-card border border-surface-800 bg-surface-900/40 py-12 text-sm text-ink-muted">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading documents…
      </div>
    );
  }

  if (documents.length === 0) {
    return (
      <p className="rounded-card border border-dashed border-surface-700 bg-surface-900/30 px-4 py-8 text-center text-sm text-ink-muted">
        No documents yet — upload your first PDF above.
      </p>
    );
  }

  const sorted = [...documents].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <div>
      {/* Desktop table */}
      <div className="hidden overflow-hidden rounded-card border border-surface-800 bg-surface-900/40 md:block">
        <table className="w-full">
          <thead>
            <tr className="border-b border-surface-800 text-left text-[11px] font-semibold uppercase tracking-widest text-ink-muted">
              <th className="px-4 py-3">Document</th>
              <th className="px-4 py-3">Chunks</th>
              <th className="px-4 py-3">Uploaded</th>
              <th className="px-4 py-3">Status</th>
              <th className="w-12 px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((doc, i) => (
              <motion.tr
                key={doc.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, delay: i * 0.03 }}
                className="border-b border-surface-800/60 last:border-0 hover:bg-surface-850/50"
              >
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-800 text-ink-secondary">
                      <FileText className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="max-w-[320px] truncate text-sm font-medium text-ink-primary">
                        {doc.filename}
                      </p>
                      {doc.error && <p className="mt-0.5 text-xs text-red-400">{doc.error}</p>}
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-sm tabular-nums text-ink-secondary">
                  {doc.chunkCount > 0 ? doc.chunkCount : '—'}
                </td>
                <td className="px-4 py-3 text-sm text-ink-secondary">
                  {formatRelative(doc.createdAt)}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge
                    label={doc.status === 'processing' ? 'Indexing' : doc.status}
                    tone={STATUS_TONE[doc.status]}
                    pulse={doc.status === 'processing' || doc.status === 'uploading'}
                  />
                </td>
                <td className="px-4 py-3 text-right">
                  <DeleteButton doc={doc} onDeleted={handleDeleted} />
                </td>
              </motion.tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="space-y-2.5 md:hidden">
        {sorted.map((doc) => (
          <div key={doc.id} className="rounded-card border border-surface-800 bg-surface-900/60 p-4">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-800 text-ink-secondary">
                <FileText className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink-primary">{doc.filename}</p>
                <DocMeta doc={doc} className="mt-0.5" />
                {doc.error && <p className="mt-1 text-xs text-red-400">{doc.error}</p>}
              </div>
              <DeleteButton doc={doc} onDeleted={handleDeleted} />
            </div>
            <div className="mt-3">
              <StatusBadge
                label={doc.status === 'processing' ? 'Indexing' : doc.status}
                tone={STATUS_TONE[doc.status]}
                pulse={doc.status === 'processing' || doc.status === 'uploading'}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
