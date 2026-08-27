'use client';

import { useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { FileUp, Loader2, UploadCloud } from 'lucide-react';
import type { DocumentDto } from '@rag/contracts';
import { api } from '../lib/api';
import { useToast } from './Toast';
import { cn, formatBytes } from '../lib/utils';

interface DocumentUploadProps {
  onUploaded: (doc: DocumentDto) => void;
  variant?: 'dropzone' | 'button';
  className?: string;
}

/**
 * Premium PDF uploader. The dropzone variant is a large drag-and-drop card;
 * the button variant is a compact control used in headers. Uploads are
 * fire-and-forget — the backend parses/chunks/embeds async, so we only
 * surface success + the indexing notice here.
 */
export function DocumentUpload({ onUploaded, variant = 'dropzone', className }: DocumentUploadProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const toast = useToast();

  const upload = async (file: File | undefined | null) => {
    if (!file) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      toast.error('Unsupported file', 'Only PDF files are supported.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error('File too large', 'PDFs up to 10MB are supported.');
      return;
    }
    setBusy(true);
    try {
      const doc = await api.uploadDocument(file);
      toast.success('Upload started', `${doc.filename} — indexing in progress.`);
      onUploaded(doc);
      if (inputRef.current) inputRef.current.value = '';
    } catch (err) {
      toast.error('Upload failed', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const trigger = (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={(e) => {
          void upload(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {variant === 'dropzone' ? (
        <motion.button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void upload(e.dataTransfer.files?.[0]);
          }}
          whileTap={{ scale: busy ? 1 : 0.99 }}
          className={cn(
            'group flex w-full flex-col items-center justify-center rounded-card border-2 border-dashed px-6 py-10 text-center transition-all',
            dragging
              ? 'border-primary bg-primary-subtle/60'
              : 'border-surface-700 bg-surface-900/40 hover:border-primary/50 hover:bg-surface-900/70',
            className,
          )}
        >
          <div
            className={cn(
              'mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border transition-all',
              dragging
                ? 'border-primary/40 bg-primary/15 text-primary'
                : 'border-surface-700 bg-surface-850 text-ink-secondary group-hover:text-primary',
            )}
          >
            {busy ? (
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            ) : (
              <UploadCloud className="h-6 w-6" />
            )}
          </div>
          <p className="text-sm font-semibold text-ink-primary">
            {busy ? 'Uploading…' : dragging ? 'Drop to upload' : 'Drag & drop your PDF here'}
          </p>
          <p className="mt-1 text-xs text-ink-muted">
            or <span className="font-medium text-primary">browse files</span> · PDF only, up to 10MB
          </p>
          <p className="mt-3 text-[11px] text-ink-muted">
            Parsed → chunked → embedded → indexed automatically
          </p>
        </motion.button>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="btn-primary inline-flex gap-2"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />}
          {busy ? 'Uploading…' : 'Upload PDF'}
        </button>
      )}
    </>
  );

  return <div>{trigger}</div>;
}
