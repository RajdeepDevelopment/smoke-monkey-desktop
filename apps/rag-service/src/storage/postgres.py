"""PostgreSQL + pgvector adapter implementing the core storage interfaces.

Single home for the pgvector SQL used by the memory engine and dense document
retrieval. ``MemoryStore`` and the pipeline depend on the ``VectorStore``
interface; this class is the concrete pgvector implementation behind it.

Notable conventions:
- Embeddings are stored as ``vector`` columns and compared with cosine
  distance (``<=>``); the score is ``1 - distance``.
- Every operation is scoped to ``user_id`` (tenant isolation).
- Rows keyed by the same UUID in ``conversation_memory`` / ``memories`` may
  also exist as Neo4j ``Memory`` nodes (see the GraphStore adapter).
"""
from __future__ import annotations

import hashlib
import uuid
from typing import Any

import asyncpg

from src.config import settings
from src.domain import MemoryFact, MemoryHit
from src.storage.interfaces import ChunkHit

# ─────────────────────────────────────────────────────────────────────────────
# Query templates
# ─────────────────────────────────────────────────────────────────────────────

_MEMORY_QUERY = """
SELECT id, conversation_id, role, content, created_at, access_count, last_accessed_at,
       1 - (embedding <=> $1::vector) AS score
FROM conversation_memory
WHERE user_id = $2::uuid AND embedding IS NOT NULL
  AND (expires_at IS NULL OR expires_at > now())
ORDER BY embedding <=> $1::vector
LIMIT $3
"""

_FACTS_QUERY = """
SELECT id, type, content, importance, created_at, access_count, last_accessed_at,
       stage, confidence, evidence_count,
       1 - (embedding <=> $1::vector) AS score
FROM memories
WHERE user_id = $2::uuid AND embedding IS NOT NULL
  AND (expires_at IS NULL OR expires_at > now())
  AND (stage IS NULL OR stage <> 'archived')
ORDER BY embedding <=> $1::vector
LIMIT $3
"""

_CRITICAL_FACTS_QUERY = """
SELECT id, type, content, importance, created_at, access_count,
       last_accessed_at, 1.0 AS score
FROM memories
WHERE user_id = $1::uuid
  AND importance >= $2
  AND (expires_at IS NULL OR expires_at > now())
  AND (stage IS NULL OR stage <> 'archived')
ORDER BY importance DESC, created_at DESC
LIMIT $3
"""

_DEDUPE_QUERY = """
SELECT id, content, importance, stage, evidence_count,
       1 - (embedding <=> $1::vector) AS sim
FROM memories
WHERE user_id = $2::uuid AND embedding IS NOT NULL
  AND (stage IS NULL OR stage <> 'archived')
ORDER BY embedding <=> $1::vector
LIMIT 1
"""

_FACT_UPDATE = """
UPDATE memories
SET importance = GREATEST(importance, $3),
    content = $4,
    last_accessed_at = now(),
    access_count = access_count + 1,
    evidence_count = evidence_count + 1,
    confidence = LEAST(0.99, COALESCE(confidence, 0.5) + $5::double precision),
    stage = CASE
        WHEN COALESCE(stage, 'candidate') = 'candidate' AND evidence_count + 1 >= $6 THEN 'confirmed'
        WHEN COALESCE(stage, 'candidate') IN ('candidate', 'confirmed')
             AND GREATEST(importance, $3) >= $8
             AND evidence_count + 1 >= $7 THEN 'stable'
        WHEN COALESCE(stage, 'candidate') = 'stale' THEN 'confirmed'
        ELSE COALESCE(stage, 'candidate')
    END
WHERE id = $1 AND user_id = $2::uuid
RETURNING id
"""

_FACT_INSERT = """
INSERT INTO memories
    (user_id, type, content, embedding, importance, source_message, expires_at,
     stage, confidence, evidence_count)
VALUES ($1::uuid, $2, $3, $4::vector, $5, $6, now() + $7 * INTERVAL '1 day',
        $8, $9, 1)
RETURNING id
"""

_RELATIONSHIP_QUERY = """
SELECT id, type, content, importance, created_at, access_count, last_accessed_at,
       1 - (embedding <=> $1::vector) AS score
FROM memories
WHERE user_id = $2::uuid AND type = 'relationship' AND embedding IS NOT NULL
  AND (expires_at IS NULL OR expires_at > now())
  AND (stage IS NULL OR stage <> 'archived')
ORDER BY embedding <=> $1::vector
LIMIT $3
"""

_PREFERENCE_QUERY = """
SELECT id, type, content, importance, created_at, access_count,
       last_accessed_at, 1.0 AS score
FROM memories
WHERE user_id = $1::uuid
  AND type IN ('preference', 'style')
  AND (expires_at IS NULL OR expires_at > now())
  AND (stage IS NULL OR stage <> 'archived')
ORDER BY importance DESC, created_at DESC
LIMIT $2
"""

_RECENT_QUERY = """
SELECT role, content
FROM conversation_memory
WHERE user_id = $1::uuid
ORDER BY created_at DESC
LIMIT $2
"""

_ENTITY_MATCH_QUERY = """
SELECT id, type, content, 1 - (embedding <=> $1::vector) AS sim
FROM memories
WHERE user_id = $2::uuid AND embedding IS NOT NULL
  AND (stage IS NULL OR stage <> 'archived')
ORDER BY embedding <=> $1::vector
LIMIT $3
"""

_MESSAGE_INSERT = """
INSERT INTO conversation_memory
    (user_id, conversation_id, role, content, content_hash, embedding)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::vector)
ON CONFLICT (user_id, content_hash) DO NOTHING
"""

_DUPLICATE_REFRESH = """
UPDATE memories SET last_accessed_at = now(), access_count = access_count + 1,
       evidence_count = evidence_count + 1,
       confidence = LEAST(0.99, COALESCE(confidence, 0.5) + $2::double precision),
       stage = $3
WHERE id = $1
"""

_FACT_DELETE = "DELETE FROM memories WHERE id = $1::uuid AND user_id = $2::uuid"

_TOUCH_MEMORIES = (
    "UPDATE conversation_memory SET access_count = access_count + 1, "
    "last_accessed_at = now() "
    "WHERE id = ANY($1::uuid[]) AND user_id = $2::uuid"
)

_TOUCH_FACTS = (
    "UPDATE memories SET access_count = access_count + 1, "
    "last_accessed_at = now(), "
    "importance = LEAST(1.0, importance + $1::double precision) "
    "WHERE id = ANY($2::uuid[]) AND user_id = $3::uuid"
)

_CHUNK_QUERY = """
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


def _vec(value: list[float]) -> str:
    return "[" + ",".join(repr(float(x)) for x in value) + "]"


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _ttl_days(importance: float) -> int:
    if importance >= 0.8:
        return 365
    if importance >= 0.6:
        return 180
    if importance >= 0.4:
        return 90
    return 30


class PostgresVectorStore:
    """pgvector-backed ``VectorStore`` over an asyncpg pool."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool

    # ── episodic memory ──────────────────────────────────────────────────────

    async def search_conversation(
        self,
        query_vector: list[float],
        user_id: str,
        top_k: int,
    ) -> list[MemoryHit]:
        rows = await self.pool.fetch(_MEMORY_QUERY, _vec(query_vector), user_id, top_k)
        hits: list[MemoryHit] = []
        for row in rows:
            score = max(float(row["score"] or 0), 0.0)
            if score <= 0:
                continue
            hits.append(
                MemoryHit(
                    id=str(row["id"]),
                    conversation_id=str(row["conversation_id"]) if row["conversation_id"] else None,
                    role=row["role"],
                    content=row["content"],
                    score=score,
                    created_at=row["created_at"],
                    access_count=int(row["access_count"] or 0),
                    last_accessed_at=row["last_accessed_at"],
                )
            )
        return hits

    async def insert_message(
        self,
        *,
        user_id: str,
        conversation_id: str | None,
        role: str,
        content: str,
        vector: list[float] | None = None,
    ) -> None:
        content = (content or "").strip()
        if not content:
            return
        await self.pool.execute(
            _MESSAGE_INSERT,
            user_id,
            conversation_id,
            role,
            content,
            _hash(content),
            _vec(vector) if vector else None,
        )

    async def recent_turns(
        self,
        user_id: str,
        limit: int = 6,
    ) -> list[dict[str, str]]:
        if not user_id or limit <= 0:
            return []
        rows = await self.pool.fetch(_RECENT_QUERY, user_id, limit)
        return [
            {"role": str(row["role"]), "content": str(row["content"])} for row in rows
        ]

    async def touch(
        self,
        user_id: str,
        memory_ids: list[uuid.UUID],
        fact_ids: list[uuid.UUID],
    ) -> None:
        if not memory_ids and not fact_ids:
            return
        if memory_ids:
            await self.pool.execute(_TOUCH_MEMORIES, memory_ids, user_id)
        if fact_ids:
            await self.pool.execute(
                _TOUCH_FACTS, settings.memory_reconsolidation_boost, fact_ids, user_id
            )

    # ── durable facts ────────────────────────────────────────────────────────

    async def search_facts(
        self,
        query_vector: list[float],
        user_id: str,
        top_k: int,
    ) -> list[MemoryFact]:
        rows = await self.pool.fetch(_FACTS_QUERY, _vec(query_vector), user_id, top_k)
        facts: list[MemoryFact] = []
        for row in rows:
            score = max(float(row["score"] or 0), 0.0)
            if score <= 0:
                continue
            facts.append(
                MemoryFact(
                    id=str(row["id"]),
                    type=row["type"],
                    content=row["content"],
                    importance=float(row["importance"] or 0.5),
                    score=score,
                    created_at=row["created_at"],
                    access_count=int(row["access_count"] or 0),
                    last_accessed_at=row["last_accessed_at"],
                )
            )
        return facts

    async def search_critical_facts(
        self,
        user_id: str,
        min_importance: float,
        top_k: int,
    ) -> list[MemoryFact]:
        if top_k <= 0:
            return []
        rows = await self.pool.fetch(_CRITICAL_FACTS_QUERY, user_id, min_importance, top_k)
        return [
            MemoryFact(
                id=str(row["id"]),
                type=row["type"],
                content=row["content"],
                importance=float(row["importance"] or 0.5),
                score=float(row["score"] or 1.0),
                created_at=row["created_at"],
                access_count=int(row["access_count"] or 0),
                last_accessed_at=row["last_accessed_at"],
            )
            for row in rows
        ]

    async def search_relationships(
        self,
        query_vector: list[float],
        user_id: str,
        top_k: int,
    ) -> list[MemoryFact]:
        rows = await self.pool.fetch(_RELATIONSHIP_QUERY, _vec(query_vector), user_id, top_k)
        facts: list[MemoryFact] = []
        for row in rows:
            score = max(float(row["score"] or 0), 0.0)
            if score <= 0:
                continue
            facts.append(
                MemoryFact(
                    id=str(row["id"]),
                    type=row["type"],
                    content=row["content"],
                    importance=float(row["importance"] or 0.5),
                    score=score,
                    created_at=row["created_at"],
                    access_count=int(row["access_count"] or 0),
                    last_accessed_at=row["last_accessed_at"],
                )
            )
        return facts

    async def recall_preferences(
        self,
        user_id: str,
        top_k: int = 4,
    ) -> list[MemoryFact]:
        if not user_id or top_k <= 0:
            return []
        rows = await self.pool.fetch(_PREFERENCE_QUERY, user_id, top_k)
        return [
            MemoryFact(
                id=str(row["id"]),
                type=row["type"],
                content=row["content"],
                importance=float(row["importance"] or 0.5),
                score=float(row["score"] or 1.0),
                created_at=row["created_at"],
                access_count=int(row["access_count"] or 0),
                last_accessed_at=row["last_accessed_at"],
            )
            for row in rows
        ]

    async def match_entity(
        self,
        vector: list[float],
        user_id: str,
        top_k: int = 1,
        min_score: float | None = None,
    ) -> list[dict[str, Any]]:
        threshold = settings.memory_graph_match_threshold if min_score is None else min_score
        rows = await self.pool.fetch(_ENTITY_MATCH_QUERY, _vec(vector), user_id, top_k)
        matches: list[dict[str, Any]] = []
        for row in rows:
            sim = max(float(row["sim"] or 0), 0.0)
            if sim >= threshold:
                matches.append(
                    {
                        "id": str(row["id"]),
                        "content": row["content"],
                        "type": row["type"],
                        "sim": sim,
                    }
                )
        return matches

    async def upsert_fact(
        self,
        *,
        user_id: str,
        type_: str,
        content: str,
        vector: list[float],
        importance: float = 0.5,
        source_message: str | None = None,
        stage: str = "candidate",
        confidence: float = 0.5,
        expires_in_days: int = 30,
    ) -> str:
        """Insert or merge a fact; returns the canonical memory id.

        Near-duplicate handling mirrors the memory engine: sim >=
        ``memory_dedupe_ignore`` refreshes the existing row, sim >=
        ``memory_dedupe_merge`` merges, otherwise a new row is inserted.
        """
        row = await self.pool.fetchrow(_DEDUPE_QUERY, _vec(vector), user_id)
        sim = max(float(row["sim"] or 0), 0.0) if row else 0.0
        if sim >= settings.memory_dedupe_ignore:
            await self.pool.execute(
                _DUPLICATE_REFRESH,
                row["id"],
                settings.memory_evidence_boost,
                stage,
            )
            return str(row["id"])
        if sim >= settings.memory_dedupe_merge:
            updated = await self.pool.fetchrow(
                _FACT_UPDATE,
                row["id"],
                user_id,
                importance,
                content,
                settings.memory_evidence_boost,
                settings.memory_confirm_accesses,
                settings.memory_stable_accesses,
                settings.memory_stable_min_importance,
            )
            if updated:
                return str(updated["id"])
        inserted = await self.pool.fetchrow(
            _FACT_INSERT,
            user_id,
            type_,
            content,
            _vec(vector),
            importance,
            source_message or "",
            expires_in_days,
            stage,
            confidence,
        )
        return str(inserted["id"])

    async def merge_fact(
        self,
        *,
        target_id: str,
        user_id: str,
        importance: float,
        content: str,
        evidence_boost: float,
        confirm_accesses: int,
        stable_accesses: int,
        stable_min_importance: float,
    ) -> str | None:
        updated = await self.pool.fetchrow(
            _FACT_UPDATE,
            target_id,
            user_id,
            importance,
            content,
            evidence_boost,
            confirm_accesses,
            stable_accesses,
            stable_min_importance,
        )
        return str(updated["id"]) if updated else None

    async def delete_fact(self, user_id: str, memory_id: str) -> None:
        await self.pool.execute(_FACT_DELETE, memory_id, user_id)

    # ── consolidation ────────────────────────────────────────────────────────

    async def consolidate(self) -> list[dict[str, str]]:
        """Purge expired/faded memories; returns ``{"id", "user_id"}`` events."""
        events: list[dict[str, str]] = []
        expired = await self.pool.fetch(
            "DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < now() RETURNING id, user_id"
        )
        events.extend({"id": str(r["id"]), "user_id": str(r["user_id"])} for r in expired)
        await self.pool.execute(
            "DELETE FROM conversation_memory "
            "WHERE created_at < now() - $1::int * INTERVAL '1 day'",
            settings.memory_episodic_retention_days,
        )
        if settings.memory_lifecycle_enabled:
            await self.pool.execute(
                """
                UPDATE memories
                SET stage = 'stale'
                WHERE stage IN ('confirmed', 'stable')
                  AND COALESCE(last_accessed_at, created_at)
                        < now() - $1::int * INTERVAL '1 day'
                """,
                settings.memory_stale_days,
            )
        await self.pool.execute(
            """
            UPDATE memories
            SET importance = GREATEST(0.0,
                importance - $1::double precision
                    * EXTRACT(epoch FROM (now() - COALESCE(last_accessed_at, created_at)))
                    / 86400.0)
            WHERE importance < $2::double precision
              AND COALESCE(last_accessed_at, created_at)
                    < now() - $3::double precision * INTERVAL '1 day'
            """,
            settings.memory_decay_daily,
            settings.memory_critical_importance,
            settings.memory_decay_grace_days,
        )
        if settings.memory_lifecycle_enabled:
            forgotten = await self.pool.fetch(
                """
                UPDATE memories
                SET stage = 'archived'
                WHERE stage <> 'archived'
                  AND importance < $1::double precision
                RETURNING id, user_id
                """,
                settings.memory_forget_floor,
            )
        else:
            forgotten = await self.pool.fetch(
                "DELETE FROM memories WHERE importance < $1::double precision RETURNING id, user_id",
                settings.memory_forget_floor,
            )
        events.extend({"id": str(r["id"]), "user_id": str(r["user_id"])} for r in forgotten)
        return events

    async def merge_duplicates(self) -> int:
        merged = 0
        user_rows = await self.pool.fetch("SELECT DISTINCT user_id FROM memories")
        for user_row in user_rows:
            user_id = user_row["user_id"]
            facts = await self.pool.fetch(
                "SELECT id, content, importance, embedding FROM memories "
                "WHERE user_id = $1::uuid AND embedding IS NOT NULL "
                "ORDER BY importance DESC, created_at DESC",
                user_id,
            )
            for fact in facts:
                embedding = fact["embedding"]
                if isinstance(embedding, str):
                    embedding = [
                        float(x) for x in embedding.strip("[]").split(",") if x.strip()
                    ]
                if not embedding:
                    continue
                neighbor = await self.pool.fetchrow(
                    """
                    SELECT id, content, importance,
                           1 - (embedding <=> $3::vector) AS sim
                    FROM memories
                    WHERE user_id = $1::uuid AND embedding IS NOT NULL
                      AND id <> $2::uuid
                    ORDER BY embedding <=> $3::vector
                    LIMIT 1
                    """,
                    user_id,
                    fact["id"],
                    _vec(embedding),
                )
                if not neighbor:
                    continue
                sim = max(float(neighbor["sim"] or 0), 0.0)
                stronger = neighbor["importance"] > fact["importance"] or (
                    neighbor["importance"] == fact["importance"]
                    and len(str(neighbor["content"] or "")) >= len(str(fact["content"] or ""))
                )
                if sim >= settings.memory_dedupe_merge and stronger:
                    await self.pool.execute(
                        "DELETE FROM memories WHERE id = $1::uuid", fact["id"]
                    )
                    merged += 1
        return merged

    # ── document chunks ──────────────────────────────────────────────────────

    async def search_chunks(
        self,
        query_vector: list[float],
        top_k: int,
        user_id: str | None = None,
        document_ids: list[str] | None = None,
    ) -> list[ChunkHit]:
        rows = await self.pool.fetch(
            _CHUNK_QUERY,
            _vec(query_vector),
            user_id,
            top_k,
            document_ids if document_ids else None,
        )
        results: list[ChunkHit] = []
        for row in rows:
            score = max(float(row["score"] or 0), 0.0)
            if score <= 0:
                continue
            results.append(
                ChunkHit(
                    id=str(row["id"]),
                    document_id=str(row["document_id"]),
                    content=row["content"],
                    score=score,
                    section=row["section"],
                    page_number=row["page_number"],
                    document_name=row["document_name"] or "unknown",
                    parent_chunk_id=str(row["parent_chunk_id"]) if row["parent_chunk_id"] else None,
                )
            )
        return results

    async def replace_document_chunks(
        self,
        document_id: str,
        groups: list[Any],
        child_embeddings: dict[str, list[float]],
    ) -> int:
        """Delete a document's old chunks and insert parents + embedded children.

        ``groups`` are document-worker ``ChunkGroup`` objects (parent_content,
        section, children with content/page_number). Returns the child count.
        """
        _INSERT_CHUNK = """
        INSERT INTO chunks
            (id, document_id, parent_chunk_id, content, content_tsv,
             section, page_number, token_count, embedding, metadata)
        VALUES
            ($1::uuid, $2::uuid, $3::uuid, $4,
             to_tsvector('english', $4),
             $5, $6, $7, $8::vector, $9::jsonb)
        """
        child_count = 0
        async with self.pool.acquire() as conn:
            await conn.execute(
                "DELETE FROM chunks WHERE document_id = $1::uuid", document_id
            )
            for group in groups:
                parent_id = uuid.uuid4()
                parent_content = str(getattr(group, "parent_content", "") or "")
                section = getattr(group, "section", None)
                await conn.execute(
                    _INSERT_CHUNK,
                    parent_id,
                    document_id,
                    None,
                    parent_content,
                    section,
                    None,
                    _token_count(parent_content),
                    None,
                    '{"kind": "parent"}',
                )
                for child in getattr(group, "children", []):
                    content = str(getattr(child, "content", "") or "")
                    embedding = child_embeddings.get(content)
                    await conn.execute(
                        _INSERT_CHUNK,
                        uuid.uuid4(),
                        document_id,
                        parent_id,
                        content,
                        section,
                        getattr(child, "page_number", None),
                        _token_count(content),
                        _vec(embedding) if embedding else None,
                        '{"kind": "child"}',
                    )
                    child_count += 1
        return child_count

    async def set_document_status(
        self,
        document_id: str,
        status: str,
        error: str | None = None,
        chunk_count: int | None = None,
    ) -> None:
        if chunk_count is None:
            await self.pool.execute(
                "UPDATE documents SET status = $1, error = $2, updated_at = now() WHERE id = $3::uuid",
                status,
                error,
                document_id,
            )
        else:
            await self.pool.execute(
                "UPDATE documents SET status = $1, error = $2, chunk_count = $3, "
                "updated_at = now() WHERE id = $4::uuid",
                status,
                error,
                chunk_count,
                document_id,
            )


def _token_count(text_value: str) -> int:
    return max(1, round(len(text_value or "") / 4))
