"""Core storage interfaces (ports) for Smoke Monkey.

Phase 1 deliverable: the Memory Engine, document pipeline, and caching layers
depend on these interfaces — never on a concrete store (pgvector, Neo4j, MinIO,
Redis, SQLite, …). Every backend must be swappable without touching callers.

Backing stores today:
    VectorStore  -> PostgreSQL + pgvector (conversation_memory, memories, chunks)
    GraphStore   -> Neo4j (Memory/User nodes, typed edges)
    DocumentStore-> MinIO (object files) + pgvector chunks table
    CacheStore   -> Redis

No behavior changes were introduced with this module; it only captures the
contract the existing stores already satisfy.
"""
from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol, runtime_checkable

from src.domain import MemoryFact, MemoryHit

if TYPE_CHECKING:
    from src.application.mem.models import Memory

# Relationship types the memory agent may create between memories. Sanitized
# before use (Neo4j relationship types cannot be parameterized; SQLite adapters
# also must not interpolate arbitrary strings).
_REL_TYPES = {
    "RELATED_TO",
    "WORKS_AT",
    "WORKS_WITH",
    "WORKS_FOR",
    "REPORTS_TO",
    "MANAGES",
    "MENTORS",
    "COLLABORATES_WITH",
    "PREFERS",
    "OWNS",
    "USES",
    "PART_OF",
    "SIMILAR_TO",
    "DEPENDS_ON",
    "CAUSES",
    "CONTRIBUTES_TO",
    "KNOWS",
    "TEACHES",
    "LEADS",
    "FAMILY_OF",
    "FRIEND_OF",
    "COLLEAGUE_OF",
    "HAS_MEMORY",
}

_SAFE_REL = re.compile(r"^[A-Z][A-Z0-9_]*$")


def sanitize_rel_type(rel_type: str) -> str:
    """Return a safe, known relationship type (or RELATED_TO)."""
    cleaned = re.sub(r"[^A-Z0-9_]", "_", (rel_type or "").strip().upper())
    if cleaned in _REL_TYPES or _SAFE_REL.match(cleaned):
        return cleaned
    return "RELATED_TO"


RELATIONSHIP_TYPES = sorted(_REL_TYPES)

# ─────────────────────────────────────────────────────────────────────────────
# Result value objects
# ─────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class ChunkHit:
    """A document chunk hit from dense retrieval."""

    id: str
    document_id: str
    content: str
    score: float
    section: str | None = None
    page_number: int | None = None
    document_name: str | None = None
    parent_chunk_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


# Graph traversal rows are ``dict``s keyed by ``id``, ``content``, ``type``,
# ``importance``, ``rel_type``, ``confidence`` (see GraphStore).


# ─────────────────────────────────────────────────────────────────────────────
# VectorStore — embedding search + memory/document row maintenance
# ─────────────────────────────────────────────────────────────────────────────

@runtime_checkable
class VectorStore(Protocol):
    """Dense vector search + row lifecycle for memories and document chunks.

    All search/update operations are scoped to ``user_id`` (tenant isolation).
    """

    # ── episodic memory (conversation_memory) ────────────────────────────────
    async def search_conversation(
        self,
        query_vector: list[float],
        user_id: str,
        top_k: int,
    ) -> list[MemoryHit]: ...

    async def insert_message(
        self,
        *,
        user_id: str,
        conversation_id: str | None,
        role: str,
        content: str,
        vector: list[float] | None = None,
    ) -> None:
        """Store one message (episodic). Dedupes on (user_id, content hash)."""

    async def recent_turns(
        self,
        user_id: str,
        limit: int = 6,
    ) -> list[dict[str, str]]: ...

    async def touch(
        self,
        user_id: str,
        memory_ids: list[uuid.UUID],
        fact_ids: list[uuid.UUID],
    ) -> None:
        """Bump access stats for recalled memories (reconsolidation signal)."""

    # ── durable facts (memories) ─────────────────────────────────────────────
    async def search_facts(
        self,
        query_vector: list[float],
        user_id: str,
        top_k: int,
    ) -> list[MemoryFact]: ...

    async def search_critical_facts(
        self,
        user_id: str,
        min_importance: float,
        top_k: int,
    ) -> list[MemoryFact]:
        """The identity/relationship floor: high-importance facts, no query."""

    async def search_relationships(
        self,
        query_vector: list[float],
        user_id: str,
        top_k: int,
    ) -> list[MemoryFact]: ...

    async def recall_preferences(
        self,
        user_id: str,
        top_k: int = 4,
    ) -> list[MemoryFact]: ...

    async def match_entity(
        self,
        vector: list[float],
        user_id: str,
        top_k: int = 1,
        min_score: float | None = None,
    ) -> list[dict[str, Any]]:
        """Resolve a bare entity string to an existing memory id.

        Returns ``{"id", "content", "type", "sim"}`` rows filtered by threshold.
        """

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
        """Insert or merge a fact, returning the canonical memory id.

        Near-duplicates (sim >= ``memory_dedupe_merge``) merge into the best
        match instead of inserting a new row.
        """

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
        """Fold a reconciled candidate into an existing fact (update/correct/supersede)."""

    async def delete_fact(self, user_id: str, memory_id: str) -> None:
        """Remove one memory row (e.g. outbox delete event)."""

    # ── consolidation ────────────────────────────────────────────────────────
    async def consolidate(self) -> list[dict[str, str]]:
        """Purge expired/faded memories; returns ``{"id", "user_id"}`` events
        that downstream stores (graph) must mirror."""

    async def merge_duplicates(self) -> int:
        """Fold near-duplicate facts; returns the number of rows merged."""

    # ── document chunks ──────────────────────────────────────────────────────
    async def search_chunks(
        self,
        query_vector: list[float],
        top_k: int,
        user_id: str | None = None,
        document_ids: list[str] | None = None,
    ) -> list[ChunkHit]:
        """Dense retrieval over ready document chunks (d.status = 'ready')."""

    async def replace_document_chunks(
        self,
        document_id: str,
        groups: list[Any],
        child_embeddings: dict[str, list[float]],
    ) -> int:
        """Replace a document's chunks in one transaction; returns chunk count."""

    async def set_document_status(
        self,
        document_id: str,
        status: str,
        error: str | None = None,
        chunk_count: int | None = None,
    ) -> None: ...


# ─────────────────────────────────────────────────────────────────────────────
# GraphStore — relationship knowledge graph (memory only)
# ─────────────────────────────────────────────────────────────────────────────

@runtime_checkable
class GraphStore(Protocol):
    """Typed-relationship graph over memories.

    Must degrade to best-effort no-ops when unavailable (the pipeline keeps
    working without a graph), and every operation is scoped to ``user_id``.
    """

    enabled: bool

    async def connect(self) -> None: ...
    async def close(self) -> None: ...
    async def ensure_schema(self) -> None: ...

    async def upsert_user(self, user_id: str) -> None: ...
    async def upsert_memory(self, memory: Memory) -> None:
        """MERGE the memory node keyed by ``memory.id`` and (u)-[:HAS_MEMORY]->(m)."""

    async def delete_memory(self, user_id: str, memory_id: str) -> None:
        """Remove a memory node and all its edges."""

    async def link_related(
        self,
        user_id: str,
        from_id: str,
        to_id: str,
        rel_type: str = "RELATED_TO",
        properties: dict[str, Any] | None = None,
    ) -> None:
        """Create/refresh a typed edge; both endpoints must belong to ``user_id``."""

    async def find_related_memories(
        self,
        user_id: str,
        seed_ids: list[str],
        *,
        depth: int = 1,
        top_k: int = 6,
        timeout_s: float | None = None,
        max_depth: int | None = None,
    ) -> list[dict[str, Any]]:
        """Walk the graph around seed memories, bounded by depth/top_k/timeout.

        Rows are dicts with ``id, content, type, importance, rel_type,
        confidence``.
        """

    async def find_related_by_content(
        self,
        user_id: str,
        content: str,
        *,
        top_k: int = 3,
        timeout_s: float | None = None,
    ) -> list[dict[str, Any]]:
        """Resolve an entity string to memory rows (``id/content/importance``)."""

    async def prune_stale_edges(self, user_id: str, active_ids: list[str]) -> None:
        """Drop memories that no longer exist in the vector store."""

    @staticmethod
    def format_relationships(related: list[dict[str, Any]]) -> list[str]:
        """Render rows into prompt-friendly ``[REL, importance] content`` lines."""


# ─────────────────────────────────────────────────────────────────────────────
# DocumentStore — file object storage for uploaded documents
# ─────────────────────────────────────────────────────────────────────────────

@runtime_checkable
class DocumentStore(Protocol):
    """Object storage for raw uploaded files (S3/MinIO-compatible API)."""

    async def ensure_bucket(self) -> None: ...
    async def download(self, key: str, dest: Path) -> Path: ...
    async def upload(self, key: str, path: Path, content_type: str = "application/pdf") -> None: ...
    async def delete(self, key: str) -> None: ...


# ─────────────────────────────────────────────────────────────────────────────
# CacheStore — TTL key/value cache
# ─────────────────────────────────────────────────────────────────────────────

@runtime_checkable
class CacheStore(Protocol):
    """Async TTL cache (Redis-backed today; SQLite/local tomorrow)."""

    async def get(self, key: str) -> str | None: ...
    async def set(self, key: str, value: str, ttl: int | None = None) -> None: ...
    async def delete(self, key: str) -> None: ...
    async def exists(self, key: str) -> bool: ...

    # Ordered lists (telemetry tail, work queues).
    async def push_tail(self, key: str, value: str) -> None: ...
    async def range(self, key: str, start: int, end: int) -> list[str]: ...
    async def trim(self, key: str, start: int, end: int) -> None: ...
