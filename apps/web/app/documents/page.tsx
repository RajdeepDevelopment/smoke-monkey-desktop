'use client';

import { useCallback, useEffect, useState } from 'react';
import { BookOpen, FileText, Layers, TriangleAlert } from 'lucide-react';
import type { DocumentDto } from '@rag/contracts';
import { api } from '../../lib/api';
import { PageScroll } from '../../components/PageScroll';
import { PageHeader } from '../../components/PageHeader';
import { MetricCard } from '../../components/MetricCard';
import { DocumentUpload } from '../../components/DocumentUpload';
import { DocumentList } from '../../components/DocumentList';
import { EmptyState } from '../../components/EmptyState';

export default function DocumentsPage() {
  const [version, setVersion] = useState(0);
  const [documents, setDocuments] = useState<DocumentDto[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refreshStats = useCallback(async () => {
    try {
      setDocuments(await api.listDocuments());
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refreshStats();
  }, [refreshStats, version]);

  const total = documents.length;
  const chunks = documents.reduce((sum, d) => sum + d.chunkCount, 0);
  const failed = documents.filter((d) => d.status === 'failed').length;
  const inFlight = documents.filter((d) => d.status === 'uploading' || d.status === 'processing').length;

  return (
    <PageScroll>
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <PageHeader
          title="Knowledge Base"
          description="Your personal document store — upload PDFs to make them searchable and askable."
          icon={<BookOpen className="h-5 w-5" />}
          actions={
            <DocumentUpload
              variant="button"
              onUploaded={() => {
                setVersion((v) => v + 1);
              }}
            />
          }
        />

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricCard label="Documents" value={`${total}`} loading={!loaded} icon={<FileText className="h-4 w-4" />} />
          <MetricCard label="Chunks indexed" value={`${chunks}`} loading={!loaded} icon={<Layers className="h-4 w-4" />} />
          <MetricCard
            label="Indexing now"
            value={`${inFlight}`}
            loading={!loaded}
            icon={<BookOpen className="h-4 w-4" />}
          />
          <MetricCard
            label="Failed"
            value={`${failed}`}
            loading={!loaded}
            icon={<TriangleAlert className="h-4 w-4" />}
          />
        </div>

        <DocumentUpload
          onUploaded={() => {
            setVersion((v) => v + 1);
          }}
        />

        {loaded && total === 0 ? (
          <EmptyState
            icon={<FileText className="h-6 w-6" />}
            title="Your knowledge base is empty"
            description="Upload a PDF above to start building a searchable, askable library of documents."
          />
        ) : (
          <DocumentList
            version={version}
            onChanged={() => void refreshStats()}
          />
        )}
      </div>
    </PageScroll>
  );
}
