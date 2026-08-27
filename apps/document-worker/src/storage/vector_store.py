"""pgvector storage: chunk upserts, HNSW index, full-text search column."""
from __future__ import annotations

import json
import logging
import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from src.chunking.hierarchy import ChunkGroup
from src.config import settings

logger = logging.getLogger(__name__)

DDL = f"""
CREATE TABLE IF NOT EXISTS chunks (
    id              UUID PRIMARY KEY,
    document_id     UUID NOT NULL,
    parent_chunk_id UUID,
    content         TEXT NOT NULL,
    content_tsv     tsvector,
    section         TEXT,
    page_number     INTEGER,
    token_count     INTEGER NOT NULL DEFAULT 0,
    embedding       vector({settings.embed_dims}),
    metadata        JSONB NOT NULL DEFAULT '{{}}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
)
"""

def _embedding_index_sql() -> str | None:
    """Pick an index that supports the configured embed dimensions.

    pgvector limits both HNSW and IVFFlat to 2000 dimensions, so higher-dim
    embeddings (e.g. Nemotron-3 Embed 1B at 2048) run as an indexed-less
    sequential scan, which is perfectly adequate at this app's scale.
    """
    dims = settings.embed_dims
    if dims > 2000:
        return None
    if dims <= 2000:
        return (
            "CREATE INDEX IF NOT EXISTS idx_chunks_hnsw "
            "ON chunks USING hnsw (embedding vector_cosine_ops)"
        )
    return None


DDL_INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks (document_id)",
    "CREATE INDEX IF NOT EXISTS idx_chunks_parent ON chunks (parent_chunk_id)",
    *(s for s in [_embedding_index_sql()] if s),
    "CREATE INDEX IF NOT EXISTS idx_chunks_tsv ON chunks USING gin (content_tsv)",
]


def _vec(embedding: list[float]) -> str:
    return "[" + ",".join(repr(float(x)) for x in embedding) + "]"


def _token_count(text_value: str) -> int:
    return max(1, round(len(text_value) / 4))


class VectorStore:
    def __init__(self, engine: AsyncEngine | None = None) -> None:
        self._engine = engine or create_async_engine(settings.postgres_dsn, pool_size=10)

    @property
    def engine(self) -> AsyncEngine:
        return self._engine

    async def init(self) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(text(DDL))
            await self._ensure_embedding_dimension(conn)
            for statement in DDL_INDEXES:
                await conn.execute(text(statement))

    async def _ensure_embedding_dimension(self, conn) -> None:
        """Match the `embedding` column dimension to the configured embed model.

        Embedding dimension is fixed per model (e.g. nomic 768, Nemotron-3
        Embed 1B 2048). If the column was created by an older deployment with a
        different model, re-create it: drop the dimension-bound HNSW index,
        clear stale vectors (unusable under the new model anyway), and alter the
        column type so future inserts and similarity queries work.
        """
        row = (await conn.execute(text(
            "SELECT a.atttypmod FROM pg_attribute a "
            "JOIN pg_class c ON c.oid = a.attrelid "
            "WHERE c.relname = 'chunks' AND a.attname = 'embedding'"
        ))).fetchone()
        if row is None:
            return
        configured = settings.embed_dims
        # vector(n) encodes the dimension either directly in atttypmod or as
        # (n << 16 | VARHDRSZ) depending on the pgvector version in use.
        raw = row[0]
        current = (raw >> 16) if raw and raw > 65535 else raw
        if current == configured:
            return
        logger.warning(
            "chunks.embedding is vector(%s) but configured embed dims are %s — "
            "recreating column and clearing stale vectors",
            current,
            configured,
        )
        await conn.execute(text("DROP INDEX IF EXISTS idx_chunks_hnsw"))
        await conn.execute(text("DROP INDEX IF EXISTS idx_chunks_ivfflat"))
        await conn.execute(text("DELETE FROM chunks WHERE embedding IS NOT NULL"))
        await conn.execute(text(
            f"ALTER TABLE chunks ALTER COLUMN embedding TYPE vector({configured}) "
            f"USING embedding::vector({configured})"
        ))

    async def replace_document_chunks(
        self,
        document_id: uuid.UUID,
        groups: list[ChunkGroup],
        child_embeddings: dict[str, list[float]],
    ) -> int:
        """Delete a document's old chunks and insert parents + embedded children."""
        async with self._engine.begin() as conn:
            await conn.execute(text("DELETE FROM chunks WHERE document_id = :doc_id"), {"doc_id": document_id})

            parent_rows: list[dict] = []
            child_rows: list[dict] = []
            for group in groups:
                parent_id = uuid.uuid4()
                parent_rows.append(
                    {
                        "id": parent_id,
                        "document_id": document_id,
                        "parent_chunk_id": None,
                        "content": group.parent_content,
                        "section": group.section,
                        "page_number": None,
                        "token_count": _token_count(group.parent_content),
                        "embedding": None,
                        "metadata": json.dumps({"kind": "parent", "section": group.section}),
                    }
                )
                for child in group.children:
                    embedding = child_embeddings.get(child.content)
                    child_rows.append(
                        {
                            "id": uuid.uuid4(),
                            "document_id": document_id,
                            "parent_chunk_id": parent_id,
                            "content": child.content,
                            "section": group.section,
                            "page_number": child.page_number,
                            "token_count": _token_count(child.content),
                            "embedding": _vec(embedding) if embedding else None,
                            "metadata": json.dumps(
                                {"kind": "child", "section": group.section, "page": child.page_number}
                            ),
                        }
                    )

            insert_sql = text(
                """
                INSERT INTO chunks
                    (id, document_id, parent_chunk_id, content, content_tsv,
                     section, page_number, token_count, embedding, metadata)
                VALUES
                    (:id, :document_id, :parent_chunk_id, :content,
                     to_tsvector('english', :content),
                     :section, :page_number, :token_count,
                     CAST(:embedding AS vector), CAST(:metadata AS jsonb))
                """
            )

            if parent_rows:
                await conn.execute(insert_sql, parent_rows)
            if child_rows:
                await conn.execute(insert_sql, child_rows)
        return len(child_rows)

    async def set_document_status(
        self,
        document_id: uuid.UUID,
        status: str,
        error: str | None = None,
        chunk_count: int | None = None,
        user_id: str | None = None,
    ) -> None:
        # user_id is accepted for signature parity with the local adapter; the
        # cloud documents table is scoped by the api-gateway, not the worker.
        async with self._engine.begin() as conn:
            if chunk_count is None:
                await conn.execute(
                    text("UPDATE documents SET status = :status, error = :error, updated_at = now() WHERE id = :id"),
                    {"status": status, "error": error, "id": document_id},
                )
            else:
                await conn.execute(
                    text(
                        "UPDATE documents SET status = :status, error = :error, chunk_count = :chunk_count, "
                        "updated_at = now() WHERE id = :id"
                    ),
                    {"status": status, "error": error, "chunk_count": chunk_count, "id": document_id},
                )

    async def close(self) -> None:
        await self._engine.dispose()
