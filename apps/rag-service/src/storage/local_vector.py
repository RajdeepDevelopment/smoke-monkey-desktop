"""Local VectorStore adapter — SQLite-backed embeddings + row lifecycle.

Desktop edition: replaces pgvector with a stdlib SQLite implementation that
mirrors the exact ``PostgresVectorStore`` semantics (tenant isolation, expiry,
stage lifecycle, dedupe thresholds, consolidation, document chunks).

Embeddings are stored as JSON text and compared in Python with cosine
similarity (score = cosine, clamped >= 0), matching pgvector's ``<=>``
operator where the score is ``1 - distance``.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import sqlite3
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from src.config import settings
from src.domain import MemoryFact, MemoryHit
from src.storage.interfaces import ChunkHit

logger = logging.getLogger(__name__)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS conversation_memory (
    id               TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL,
    conversation_id  TEXT,
    role             TEXT NOT NULL,
    content          TEXT NOT NULL,
    content_hash     TEXT NOT NULL,
    embedding        TEXT,
    created_at       TEXT NOT NULL,
    access_count     INTEGER NOT NULL DEFAULT 0,
    last_accessed_at TEXT,
    expires_at       TEXT,
    UNIQUE (user_id, content_hash)
);
CREATE TABLE IF NOT EXISTS memories (
    id               TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL,
    type             TEXT NOT NULL DEFAULT 'fact',
    content          TEXT NOT NULL,
    embedding        TEXT,
    importance       REAL NOT NULL DEFAULT 0.5,
    source_message   TEXT,
    expires_at       TEXT,
    stage            TEXT NOT NULL DEFAULT 'candidate',
    confidence       REAL NOT NULL DEFAULT 0.5,
    evidence_count   INTEGER NOT NULL DEFAULT 1,
    created_at       TEXT NOT NULL,
    access_count     INTEGER NOT NULL DEFAULT 0,
    last_accessed_at TEXT
);
CREATE TABLE IF NOT EXISTS documents (
    id          TEXT PRIMARY KEY,
    user_id     TEXT,
    filename    TEXT,
    status      TEXT NOT NULL DEFAULT 'processing',
    error       TEXT,
    chunk_count INTEGER,
    updated_at  TEXT
);
CREATE TABLE IF NOT EXISTS chunks (
    id              TEXT PRIMARY KEY,
    document_id     TEXT NOT NULL,
    parent_chunk_id TEXT,
    content         TEXT NOT NULL,
    section         TEXT,
    page_number     INTEGER,
    token_count     INTEGER NOT NULL DEFAULT 1,
    embedding       TEXT,
    metadata        TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_cm_user ON conversation_memory (user_id);
CREATE INDEX IF NOT EXISTS idx_mem_user ON memories (user_id);
CREATE INDEX IF NOT EXISTS idx_chunk_doc ON chunks (document_id);
CREATE INDEX IF NOT EXISTS idx_docs_user ON documents (user_id, status);
"""

# Sparse retrieval mirror of Postgres ``tsvector``: an FTS5 index over chunk
# content, queried with ``bm25`` ranking. The chunk UUID lives in an indexed
# column (FTS5 rowids are integers), so the match can join back to ``chunks``.
# Created separately (and optionally) because FTS5 is a compile-time feature of
# the bundled SQLite.
_FTS_SCHEMA = (
    "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts "
    "USING fts5(chunk_id UNINDEXED, content)"
)


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _encode(vector: list[float] | None) -> str | None:
    return json.dumps(vector) if vector else None


def _decode(blob: str | None) -> list[float]:
    if not blob:
        return []
    try:
        return [float(x) for x in json.loads(blob)]
    except (ValueError, TypeError):
        return []


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _register_functions(conn: sqlite3.Connection) -> None:
    """Emulate PostgreSQL's LEAST/GREATEST (used by the ported SQL)."""

    def least(*values: Any) -> Any:
        return min(values)

    def greatest(*values: Any) -> Any:
        return max(values)

    conn.create_function("LEAST", -1, least)
    conn.create_function("GREATEST", -1, greatest)


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(x * x for x in b) ** 0.5
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def _token_count(text_value: str) -> int:
    return max(1, round(len(text_value or "") / 4))


def _ttl_days(importance: float) -> int:
    if importance >= 0.8:
        return 365
    if importance >= 0.6:
        return 180
    if importance >= 0.4:
        return 90
    return 30


class LocalVectorStore:
    """SQLite-backed ``VectorStore``. ``db_path`` may be ``:memory:``.

    Mirrors ``PostgresVectorStore`` row-for-row; the memory engine and dense
    retrieval code paths behave identically regardless of backend.
    """

    def __init__(self, db_path: str = ":memory:") -> None:
        self.db_path = db_path
        self._conn: sqlite3.Connection | None = None
        self._lock = asyncio.Lock()
        self._sparse_fts = True

    @property
    def enabled(self) -> bool:
        return self._conn is not None

    async def connect(self) -> None:
        if self._conn is not None:
            return
        self._conn = await asyncio.to_thread(
            sqlite3.connect,
            self.db_path,
            isolation_level=None,
            check_same_thread=False,
        )
        self._conn.row_factory = sqlite3.Row
        # WAL lets the separate document-worker process write chunks into the
        # same file while rag-service reads; busy_timeout waits out brief locks.
        await asyncio.to_thread(self._conn.execute, "PRAGMA journal_mode=WAL")
        await asyncio.to_thread(self._conn.execute, "PRAGMA busy_timeout=5000")
        _register_functions(self._conn)
        await self.ensure_schema()

    async def close(self) -> None:
        conn, self._conn = self._conn, None
        if conn is not None:
            await asyncio.to_thread(conn.close)

    async def ensure_schema(self) -> None:
        if self._conn is None:
            return
        async with self._lock:
            await asyncio.to_thread(self._conn.executescript, _SCHEMA)
            try:
                await asyncio.to_thread(self._conn.execute, _FTS_SCHEMA)
                self._sparse_fts = True
            except sqlite3.OperationalError:
                # FTS5 not compiled in this SQLite build: sparse search falls
                # back to a Python token-overlap scorer.
                self._sparse_fts = False

    def _run(self, fn: Callable[..., Any], *args: Any) -> Any:
        return asyncio.to_thread(fn, *args)

    async def _fetch(self, query: str, params: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
        """Fetch rows; caller must already hold ``self._lock``."""
        cursor = await asyncio.to_thread(self._conn.execute, query, params)
        return await asyncio.to_thread(cursor.fetchall)

    async def _rows(self, query: str, params: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
        async with self._lock:
            return await self._fetch(query, params)

    @staticmethod
    def _rank(
        rows: list[sqlite3.Row],
        query_vector: list[float],
        top_k: int,
    ) -> list[tuple[float, sqlite3.Row]]:
        scored: list[tuple[float, sqlite3.Row]] = []
        for row in rows:
            score = max(_cosine(query_vector, _decode(row["embedding"])), 0.0)
            if score > 0:
                scored.append((score, row))
        scored.sort(key=lambda pair: pair[0], reverse=True)
        return scored[:top_k]

    # ── episodic memory (conversation_memory) ────────────────────────────────

    async def search_conversation(
        self,
        query_vector: list[float],
        user_id: str,
        top_k: int,
    ) -> list[MemoryHit]:
        if self._conn is None or not query_vector:
            return []
        now = _now()
        rows = await self._rows(
            "SELECT * FROM conversation_memory "
            "WHERE user_id = ? AND embedding IS NOT NULL "
            "AND (expires_at IS NULL OR expires_at > ?)",
            (user_id, now),
        )
        hits: list[MemoryHit] = []
        for score, row in self._rank(rows, query_vector, top_k):
            hits.append(
                MemoryHit(
                    id=str(row["id"]),
                    conversation_id=row["conversation_id"],
                    role=row["role"],
                    content=row["content"],
                    score=score,
                    created_at=_parse(row["created_at"]),
                    access_count=int(row["access_count"] or 0),
                    last_accessed_at=_parse(row["last_accessed_at"]),
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
        if self._conn is None:
            return
        content = (content or "").strip()
        if not content:
            return
        async with self._lock:
            await self._run(
                self._conn.execute,
                "INSERT OR IGNORE INTO conversation_memory "
                "(id, user_id, conversation_id, role, content, content_hash, "
                "embedding, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    str(uuid.uuid4()),
                    user_id,
                    conversation_id,
                    role,
                    content,
                    _hash(content),
                    _encode(vector),
                    _now(),
                ),
            )

    async def recent_turns(
        self,
        user_id: str,
        limit: int = 6,
    ) -> list[dict[str, str]]:
        if self._conn is None or not user_id or limit <= 0:
            return []
        rows = await self._rows(
            "SELECT role, content FROM conversation_memory "
            "WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
            (user_id, limit),
        )
        return [
            {"role": str(row["role"]), "content": str(row["content"])} for row in rows
        ]

    async def touch(
        self,
        user_id: str,
        memory_ids: list[uuid.UUID],
        fact_ids: list[uuid.UUID],
    ) -> None:
        if self._conn is None or (not memory_ids and not fact_ids):
            return
        now = _now()
        async with self._lock:
            if memory_ids:
                marks = ",".join("?" * len(memory_ids))
                await self._run(
                    self._conn.execute,
                    "UPDATE conversation_memory SET access_count = access_count + 1, "
                    f"last_accessed_at = ? WHERE id IN ({marks}) AND user_id = ?",
                    (now, *(str(m) for m in memory_ids), user_id),
                )
            if fact_ids:
                marks = ",".join("?" * len(fact_ids))
                await self._run(
                    self._conn.execute,
                    "UPDATE memories SET access_count = access_count + 1, "
                    "last_accessed_at = ?, "
                    "importance = LEAST(1.0, importance + ?) "
                    f"WHERE id IN ({marks}) AND user_id = ?",
                    (now, settings.memory_reconsolidation_boost,
                     *(str(f) for f in fact_ids), user_id),
                )

    # ── durable facts (memories) ─────────────────────────────────────────────

    async def search_facts(
        self,
        query_vector: list[float],
        user_id: str,
        top_k: int,
    ) -> list[MemoryFact]:
        if self._conn is None or not query_vector:
            return []
        now = _now()
        rows = await self._rows(
            "SELECT * FROM memories "
            "WHERE user_id = ? AND embedding IS NOT NULL "
            "AND (expires_at IS NULL OR expires_at > ?) "
            "AND (stage IS NULL OR stage <> 'archived')",
            (user_id, now),
        )
        facts: list[MemoryFact] = []
        for score, row in self._rank(rows, query_vector, top_k):
            facts.append(
                MemoryFact(
                    id=str(row["id"]),
                    type=row["type"],
                    content=row["content"],
                    importance=float(row["importance"] or 0.5),
                    score=score,
                    created_at=_parse(row["created_at"]),
                    access_count=int(row["access_count"] or 0),
                    last_accessed_at=_parse(row["last_accessed_at"]),
                )
            )
        return facts

    async def search_critical_facts(
        self,
        user_id: str,
        min_importance: float,
        top_k: int,
    ) -> list[MemoryFact]:
        if self._conn is None or top_k <= 0:
            return []
        now = _now()
        rows = await self._rows(
            "SELECT * FROM memories "
            "WHERE user_id = ? AND importance >= ? "
            "AND (expires_at IS NULL OR expires_at > ?) "
            "AND (stage IS NULL OR stage <> 'archived') "
            "ORDER BY importance DESC, created_at DESC LIMIT ?",
            (user_id, min_importance, now, top_k),
        )
        return [
            MemoryFact(
                id=str(row["id"]),
                type=row["type"],
                content=row["content"],
                importance=float(row["importance"] or 0.5),
                score=1.0,
                created_at=_parse(row["created_at"]),
                access_count=int(row["access_count"] or 0),
                last_accessed_at=_parse(row["last_accessed_at"]),
            )
            for row in rows
        ]

    async def search_relationships(
        self,
        query_vector: list[float],
        user_id: str,
        top_k: int,
    ) -> list[MemoryFact]:
        if self._conn is None or not query_vector:
            return []
        now = _now()
        rows = await self._rows(
            "SELECT * FROM memories "
            "WHERE user_id = ? AND type = 'relationship' AND embedding IS NOT NULL "
            "AND (expires_at IS NULL OR expires_at > ?) "
            "AND (stage IS NULL OR stage <> 'archived')",
            (user_id, now),
        )
        facts: list[MemoryFact] = []
        for score, row in self._rank(rows, query_vector, top_k):
            facts.append(
                MemoryFact(
                    id=str(row["id"]),
                    type=row["type"],
                    content=row["content"],
                    importance=float(row["importance"] or 0.5),
                    score=score,
                    created_at=_parse(row["created_at"]),
                    access_count=int(row["access_count"] or 0),
                    last_accessed_at=_parse(row["last_accessed_at"]),
                )
            )
        return facts

    async def recall_preferences(
        self,
        user_id: str,
        top_k: int = 4,
    ) -> list[MemoryFact]:
        if self._conn is None or not user_id or top_k <= 0:
            return []
        now = _now()
        rows = await self._rows(
            "SELECT * FROM memories "
            "WHERE user_id = ? AND type IN ('preference', 'style') "
            "AND (expires_at IS NULL OR expires_at > ?) "
            "AND (stage IS NULL OR stage <> 'archived') "
            "ORDER BY importance DESC, created_at DESC LIMIT ?",
            (user_id, now, top_k),
        )
        return [
            MemoryFact(
                id=str(row["id"]),
                type=row["type"],
                content=row["content"],
                importance=float(row["importance"] or 0.5),
                score=1.0,
                created_at=_parse(row["created_at"]),
                access_count=int(row["access_count"] or 0),
                last_accessed_at=_parse(row["last_accessed_at"]),
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
        if self._conn is None or not vector:
            return []
        threshold = settings.memory_graph_match_threshold if min_score is None else min_score
        rows = await self._rows(
            "SELECT * FROM memories "
            "WHERE user_id = ? AND embedding IS NOT NULL "
            "AND (stage IS NULL OR stage <> 'archived')",
            (user_id,),
        )
        matches: list[dict[str, Any]] = []
        for score, row in self._rank(rows, vector, top_k):
            if score >= threshold:
                matches.append(
                    {
                        "id": str(row["id"]),
                        "content": row["content"],
                        "type": row["type"],
                        "sim": score,
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
        if self._conn is None:
            return str(uuid.uuid4())
        async with self._lock:
            rows = await self._fetch(
                "SELECT * FROM memories "
                "WHERE user_id = ? AND embedding IS NOT NULL "
                "AND (stage IS NULL OR stage <> 'archived')",
                (user_id,),
            )
            nearest = self._rank(rows, vector, 1)
            sim = nearest[0][0] if nearest else 0.0
            if nearest and sim >= settings.memory_dedupe_ignore:
                row = nearest[0][1]
                await self._run(
                    self._conn.execute,
                    "UPDATE memories SET last_accessed_at = ?, access_count = access_count + 1, "
                    "evidence_count = evidence_count + 1, "
                    "confidence = LEAST(0.99, COALESCE(confidence, 0.5) + ?), stage = ? "
                    "WHERE id = ?",
                    (_now(), settings.memory_evidence_boost, stage, str(row["id"])),
                )
                return str(row["id"])
            if nearest and sim >= settings.memory_dedupe_merge:
                merged = await self._merge_fact_locked(
                    target_id=str(nearest[0][1]["id"]),
                    user_id=user_id,
                    importance=importance,
                    content=content,
                    evidence_boost=settings.memory_evidence_boost,
                    confirm_accesses=settings.memory_confirm_accesses,
                    stable_accesses=settings.memory_stable_accesses,
                    stable_min_importance=settings.memory_stable_min_importance,
                )
                if merged:
                    return merged
            memory_id = str(uuid.uuid4())
            await self._run(
                self._conn.execute,
                "INSERT INTO memories "
                "(id, user_id, type, content, embedding, importance, source_message, "
                "expires_at, stage, confidence, evidence_count, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
                (
                    memory_id,
                    user_id,
                    type_,
                    content,
                    _encode(vector),
                    importance,
                    source_message or "",
                    (datetime.now(UTC) + timedelta(days=int(expires_in_days))).isoformat(),
                    stage,
                    confidence,
                    _now(),
                ),
            )
            return memory_id

    async def _merge_fact_locked(
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
        rows = await self._fetch(
            "SELECT * FROM memories WHERE id = ? AND user_id = ?",
            (target_id, user_id),
        )
        if not rows:
            return None
        old = rows[0]
        evidence = int(old["evidence_count"] or 0) + 1
        new_importance = max(float(old["importance"] or 0.5), float(importance))
        new_confidence = min(0.99, float(old["confidence"] or 0.5) + float(evidence_boost))
        stage = old["stage"] or "candidate"
        if stage == "candidate" and evidence >= int(confirm_accesses):
            stage = "confirmed"
        elif (
            stage in ("candidate", "confirmed")
            and new_importance >= float(stable_min_importance)
            and evidence >= int(stable_accesses)
        ):
            stage = "stable"
        elif stage == "stale":
            stage = "confirmed"
        await self._run(
            self._conn.execute,
            "UPDATE memories SET importance = ?, content = ?, last_accessed_at = ?, "
            "access_count = access_count + 1, evidence_count = evidence_count + 1, "
            "confidence = ?, stage = ? WHERE id = ? AND user_id = ?",
            (new_importance, content, _now(), new_confidence, stage, target_id, user_id),
        )
        return target_id

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
        if self._conn is None:
            return None
        async with self._lock:
            return await self._merge_fact_locked(
                target_id=target_id,
                user_id=user_id,
                importance=importance,
                content=content,
                evidence_boost=evidence_boost,
                confirm_accesses=confirm_accesses,
                stable_accesses=stable_accesses,
                stable_min_importance=stable_min_importance,
            )

    async def delete_fact(self, user_id: str, memory_id: str) -> None:
        if self._conn is None:
            return
        async with self._lock:
            await self._run(
                self._conn.execute,
                "DELETE FROM memories WHERE id = ? AND user_id = ?",
                (memory_id, user_id),
            )

    # ── consolidation ────────────────────────────────────────────────────────

    async def consolidate(self) -> list[dict[str, str]]:
        if self._conn is None:
            return []
        events: list[dict[str, str]] = []
        now = _now()
        now_dt = datetime.now(UTC)
        async with self._lock:
            expired = await self._fetch(
                "DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < ? "
                "RETURNING id, user_id",
                (now,),
            )
            events.extend({"id": str(r["id"]), "user_id": str(r["user_id"])} for r in expired)
            await self._run(
                self._conn.execute,
                "DELETE FROM conversation_memory WHERE created_at < ?",
                (
                    (now_dt - timedelta(days=settings.memory_episodic_retention_days)).isoformat(),
                ),
            )
            if settings.memory_lifecycle_enabled:
                await self._run(
                    self._conn.execute,
                    "UPDATE memories SET stage = 'stale' "
                    "WHERE stage IN ('confirmed', 'stable') "
                    "AND COALESCE(last_accessed_at, created_at) < ?",
                    ((now_dt - timedelta(days=settings.memory_stale_days)).isoformat(),),
                )
            all_rows = await self._fetch(
                "SELECT id, importance, created_at, last_accessed_at FROM memories "
                "WHERE importance < ? AND COALESCE(last_accessed_at, created_at) < ?",
                (
                    settings.memory_critical_importance,
                    (now_dt - timedelta(days=settings.memory_decay_grace_days)).isoformat(),
                ),
            )
            for row in all_rows:
                last = _parse(row["last_accessed_at"]) or _parse(row["created_at"])
                if last is None:
                    continue
                days = (now_dt - last).total_seconds() / 86400.0
                new_importance = max(
                    0.0, float(row["importance"] or 0.0) - settings.memory_decay_daily * days
                )
                await self._run(
                    self._conn.execute,
                    "UPDATE memories SET importance = ? WHERE id = ?",
                    (new_importance, str(row["id"])),
                )
            if settings.memory_lifecycle_enabled:
                forgotten = await self._fetch(
                    "UPDATE memories SET stage = 'archived' "
                    "WHERE stage <> 'archived' AND importance < ? RETURNING id, user_id",
                    (settings.memory_forget_floor,),
                )
            else:
                forgotten = await self._fetch(
                    "DELETE FROM memories WHERE importance < ? RETURNING id, user_id",
                    (settings.memory_forget_floor,),
                )
            events.extend({"id": str(r["id"]), "user_id": str(r["user_id"])} for r in forgotten)
        return events

    async def merge_duplicates(self) -> int:
        if self._conn is None:
            return 0
        merged = 0
        async with self._lock:
            user_rows = await self._fetch("SELECT DISTINCT user_id FROM memories")
            for user_row in user_rows:
                user_id = str(user_row["user_id"])
                facts = await self._fetch(
                    "SELECT * FROM memories WHERE user_id = ? AND embedding IS NOT NULL "
                    "ORDER BY importance DESC, created_at DESC",
                    (user_id,),
                )
                for fact in facts:
                    embedding = _decode(fact["embedding"])
                    if not embedding:
                        continue
                    neighbors = self._rank(
                        [r for r in facts if str(r["id"]) != str(fact["id"])],
                        embedding,
                        1,
                    )
                    if not neighbors:
                        continue
                    sim, neighbor = neighbors[0]
                    stronger = float(neighbor["importance"]) > float(fact["importance"]) or (
                        float(neighbor["importance"]) == float(fact["importance"])
                        and len(str(neighbor["content"] or "")) >= len(str(fact["content"] or ""))
                    )
                    if sim >= settings.memory_dedupe_merge and stronger:
                        await self._run(
                            self._conn.execute,
                            "DELETE FROM memories WHERE id = ?",
                            (str(fact["id"]),),
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
        if self._conn is None or not query_vector:
            return []
        query = (
            "SELECT c.id, c.document_id, c.parent_chunk_id, c.content, c.section, "
            "c.page_number, d.filename, c.embedding "
            "FROM chunks c JOIN documents d ON d.id = c.document_id "
            "WHERE c.embedding IS NOT NULL AND d.status = 'ready'"
        )
        params: list[Any] = []
        if user_id:
            query += " AND d.user_id = ?"
            params.append(user_id)
        if document_ids:
            marks = ",".join("?" * len(document_ids))
            query += f" AND d.id IN ({marks})"
            params.extend(document_ids)
        rows = await self._rows(query, tuple(params))
        results: list[ChunkHit] = []
        for score, row in self._rank(rows, query_vector, top_k):
            results.append(
                ChunkHit(
                    id=str(row["id"]),
                    document_id=str(row["document_id"]),
                    content=row["content"],
                    score=score,
                    section=row["section"],
                    page_number=row["page_number"],
                    document_name=row["filename"] or "unknown",
                    parent_chunk_id=row["parent_chunk_id"],
                )
            )
        return results

    async def replace_document_chunks(
        self,
        document_id: str,
        groups: list[Any],
        child_embeddings: dict[str, list[float]],
    ) -> int:
        if self._conn is None:
            return 0
        child_count = 0
        fts_rows: list[tuple[str, str]] = []
        async with self._lock:
            old_rows = await self._fetch(
                "SELECT id FROM chunks WHERE document_id = ?", (document_id,)
            )
            await self._run(
                self._conn.execute, "DELETE FROM chunks WHERE document_id = ?", (document_id,)
            )
            if old_rows:
                ids = [str(r["id"]) for r in old_rows]
                marks = ",".join("?" * len(ids))
                await self._run(
                    self._conn.execute,
                    f"DELETE FROM chunks_fts WHERE chunk_id IN ({marks})",
                    tuple(ids),
                )
            for group in groups:
                parent_id = str(uuid.uuid4())
                parent_content = str(getattr(group, "parent_content", "") or "")
                section = getattr(group, "section", None)
                await self._run(
                    self._conn.execute,
                    "INSERT INTO chunks "
                    "(id, document_id, parent_chunk_id, content, section, page_number, "
                    "token_count, embedding, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        parent_id,
                        document_id,
                        None,
                        parent_content,
                        section,
                        None,
                        _token_count(parent_content),
                        None,
                        '{"kind": "parent"}',
                    ),
                )
                if parent_content:
                    fts_rows.append((parent_id, parent_content))
                for child in getattr(group, "children", []):
                    content = str(getattr(child, "content", "") or "")
                    embedding = child_embeddings.get(content)
                    child_id = str(uuid.uuid4())
                    await self._run(
                        self._conn.execute,
                        "INSERT INTO chunks "
                        "(id, document_id, parent_chunk_id, content, section, page_number, "
                        "token_count, embedding, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (
                            child_id,
                            document_id,
                            parent_id,
                            content,
                            section,
                            getattr(child, "page_number", None),
                            _token_count(content),
                            _encode(embedding),
                            '{"kind": "child"}',
                        ),
                    )
                    if content:
                        fts_rows.append((child_id, content))
                    child_count += 1
            if self._sparse_fts:
                for chunk_id, content in fts_rows:
                    await self._run(
                        self._conn.execute,
                        "INSERT INTO chunks_fts (chunk_id, content) VALUES (?, ?)",
                        (chunk_id, content),
                    )
        return child_count

    async def set_document_status(
        self,
        document_id: str,
        status: str,
        error: str | None = None,
        chunk_count: int | None = None,
        user_id: str | None = None,
    ) -> None:
        if self._conn is None:
            return
        now = _now()
        async with self._lock:
            await self._run(
                self._conn.execute,
                "INSERT OR IGNORE INTO documents (id, user_id, updated_at) VALUES (?, ?, ?)",
                (document_id, user_id, now),
            )
            if chunk_count is None:
                await self._run(
                    self._conn.execute,
                    "UPDATE documents SET status = ?, error = ?, updated_at = ? WHERE id = ?",
                    (status, error, now, document_id),
                )
            else:
                await self._run(
                    self._conn.execute,
                    "UPDATE documents SET status = ?, error = ?, chunk_count = ?, "
                    "updated_at = ? WHERE id = ?",
                    (status, error, chunk_count, now, document_id),
                )

    # ── document metadata (desktop document API) ─────────────────────────────

    async def insert_document(
        self, document_id: str, user_id: str, filename: str, status: str = "queued"
    ) -> None:
        """Register an uploaded document row before the worker picks it up."""
        if self._conn is None:
            return
        now = _now()
        async with self._lock:
            await self._run(
                self._conn.execute,
                "INSERT OR IGNORE INTO documents (id, user_id, filename, status, updated_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (document_id, user_id, filename, status, now),
            )

    async def list_documents(self, user_id: str) -> list[dict[str, Any]]:
        if self._conn is None:
            return []
        rows = await self._rows(
            "SELECT * FROM documents WHERE user_id = ? ORDER BY updated_at DESC",
            (user_id,),
        )
        return [dict(r) for r in rows]

    async def get_document(self, document_id: str, user_id: str) -> dict[str, Any] | None:
        if self._conn is None:
            return None
        rows = await self._rows(
            "SELECT * FROM documents WHERE id = ? AND user_id = ?",
            (document_id, user_id),
        )
        return dict(rows[0]) if rows else None

    async def delete_document(self, document_id: str, user_id: str) -> bool:
        """Remove a document and its chunks (incl. FTS rows). Returns True if
        the document row existed."""
        if self._conn is None:
            return False
        async with self._lock:
            rows = await self._fetch(
                "SELECT id FROM documents WHERE id = ? AND user_id = ?",
                (document_id, user_id),
            )
            if not rows:
                return False
            old_chunks = await self._fetch(
                "SELECT id FROM chunks WHERE document_id = ?", (document_id,)
            )
            await self._run(
                self._conn.execute, "DELETE FROM chunks WHERE document_id = ?", (document_id,)
            )
            if old_chunks:
                ids = [str(r["id"]) for r in old_chunks]
                marks = ",".join("?" * len(ids))
                await self._run(
                    self._conn.execute,
                    f"DELETE FROM chunks_fts WHERE chunk_id IN ({marks})",
                    tuple(ids),
                )
            await self._run(
                self._conn.execute,
                "DELETE FROM documents WHERE id = ? AND user_id = ?",
                (document_id, user_id),
            )
            return True

    async def sparse_search_chunks(
        self,
        query: str,
        top_k: int,
        user_id: str | None = None,
        document_ids: list[str] | None = None,
    ) -> list[ChunkHit]:
        """Keyword (sparse) retrieval over chunk content.

        Mirrors ``src.retrieval.sparse.sparse_search`` (Postgres tsvector).
        Uses an FTS5 ``bm25`` match when available, else a deterministic
        Python token-overlap scorer.
        """
        if self._conn is None or not query or top_k <= 0:
            return []
        tokens = [t for t in re.findall(r"[a-z0-9]+", query.lower()) if len(t) > 1]
        if not tokens:
            return []
        if self._sparse_fts:
            match = " OR ".join(f'"{t}"' for t in tokens)
            sql = (
                "SELECT c.id, c.document_id, c.parent_chunk_id, c.content, c.section, "
                "c.page_number, d.filename, bm25(chunks_fts, 1.0) AS rank "
                "FROM chunks_fts f JOIN chunks c ON c.id = f.chunk_id "
                "JOIN documents d ON d.id = c.document_id "
                "WHERE chunks_fts MATCH ? AND d.status = 'ready'"
            )
            params: list[Any] = [match]
            if user_id:
                sql += " AND d.user_id = ?"
                params.append(user_id)
            if document_ids:
                marks = ",".join("?" * len(document_ids))
                sql += f" AND d.id IN ({marks})"
                params.extend(document_ids)
            sql += " ORDER BY rank LIMIT ?"
            params.append(top_k)
            rows = await self._rows(sql, tuple(params))
            return [
                self._chunk_hit(r, score=float(r["rank"])) for r in rows
            ]
        rows = await self._rows(
            "SELECT c.id, c.document_id, c.parent_chunk_id, c.content, c.section, "
            "c.page_number, d.filename "
            "FROM chunks c JOIN documents d ON d.id = c.document_id "
            "WHERE d.status = 'ready'"
            + (" AND d.user_id = ?" if user_id else "")
            + (f" AND d.id IN ({','.join('?' * len(document_ids))})" if document_ids else ""),
            tuple([*( [user_id] if user_id else []), *(document_ids or [])]),
        )
        scored: list[tuple[float, sqlite3.Row]] = []
        for row in rows:
            content = (str(row["content"]) or "").lower()
            overlap = sum(1 for t in tokens if t in content)
            if overlap:
                scored.append((float(overlap), row))
        scored.sort(key=lambda pair: pair[0], reverse=True)
        return [self._chunk_hit(row, score=score) for score, row in scored[:top_k]]

    @staticmethod
    def _chunk_hit(row: sqlite3.Row, *, score: float) -> ChunkHit:
        return ChunkHit(
            id=str(row["id"]),
            document_id=str(row["document_id"]),
            content=str(row["content"]),
            score=score,
            section=row["section"],
            page_number=row["page_number"],
            document_name=row["filename"] or "unknown",
            parent_chunk_id=str(row["parent_chunk_id"]) if row["parent_chunk_id"] else None,
        )

    async def get_parents(self, parent_ids: list[str]) -> list[dict[str, str]]:
        """Resolve parent chunk ids to their content (RRF parent expansion)."""
        if self._conn is None or not parent_ids:
            return []
        marks = ",".join("?" * len(parent_ids))
        rows = await self._rows(
            f"SELECT id, content FROM chunks WHERE id IN ({marks})",
            tuple(parent_ids),
        )
        return [{"id": str(r["id"]), "content": str(r["content"] or "")} for r in rows]
