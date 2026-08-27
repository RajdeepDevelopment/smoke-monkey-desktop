"""Sparse keyword search using Postgres full-text search (tsvector/ts_rank)."""
from __future__ import annotations

import asyncpg

from src.domain import RetrievedChunk

QUERY = """
SELECT
    c.id, c.document_id, c.parent_chunk_id, c.content, c.section, c.page_number,
    d.filename AS document_name,
    ts_rank(c.content_tsv, plainto_tsquery('english', $1)) AS score
FROM chunks c
JOIN documents d ON d.id = c.document_id
WHERE c.embedding IS NOT NULL
  AND d.status = 'ready'
  AND ($3::uuid IS NULL OR d.user_id = $3::uuid)
  AND ($4::uuid[] IS NULL OR d.id = ANY($4::uuid[]))
  AND c.content_tsv @@ plainto_tsquery('english', $1)
ORDER BY score DESC
LIMIT $2
"""


async def sparse_search(
    pool: asyncpg.Pool,
    query: str,
    top_k: int,
    user_id: str | None = None,
    document_ids: list[str] | None = None,
) -> list[RetrievedChunk]:
    rows = await pool.fetch(QUERY, query, top_k, user_id, document_ids if document_ids else None)
    results: list[RetrievedChunk] = []
    for row in rows:
        score = float(row["score"] or 0)
        if score <= 0:
            continue
        results.append(
            RetrievedChunk(
                id=str(row["id"]),
                document_id=str(row["document_id"]),
                document_name=row["document_name"] or "unknown",
                content=row["content"],
                section=row["section"],
                page_number=row["page_number"],
                sparse_score=score,
                parent_chunk_id=str(row["parent_chunk_id"]) if row["parent_chunk_id"] else None,
            )
        )
    return results
