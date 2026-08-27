"""Dense vector search over pgvector (cosine similarity)."""
from __future__ import annotations

import asyncpg

from src.domain import RetrievedChunk

QUERY = """
SELECT
    c.id, c.document_id, c.parent_chunk_id, c.content, c.section, c.page_number,
    d.filename AS document_name,
    1 - (c.embedding <=> $1::vector) AS score
FROM chunks c
JOIN documents d ON d.id = c.document_id
WHERE c.embedding IS NOT NULL
  AND d.status = 'ready'
  AND ($2::uuid IS NULL OR d.user_id = $2::uuid)
  AND ($4::uuid[] IS NULL OR d.id = ANY($4::uuid[]))
ORDER BY c.embedding <=> $1::vector
LIMIT $3
"""


def _vector_sql(value: list[float]) -> str:
    return "[" + ",".join(repr(float(x)) for x in value) + "]"


async def dense_search(
    pool: asyncpg.Pool,
    query_vector: list[float],
    top_k: int,
    user_id: str | None = None,
    document_ids: list[str] | None = None,
) -> list[RetrievedChunk]:
    rows = await pool.fetch(
        QUERY,
        _vector_sql(query_vector),
        user_id,
        top_k,
        document_ids if document_ids else None,
    )
    results: list[RetrievedChunk] = []
    for row in rows:
        score = max(float(row["score"] or 0), 0.0)
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
                dense_score=score,
                parent_chunk_id=str(row["parent_chunk_id"]) if row["parent_chunk_id"] else None,
            )
        )
    return results
