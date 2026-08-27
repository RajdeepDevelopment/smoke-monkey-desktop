"""Local GraphStore adapter — SQLite-backed memory graph (desktop edition).

Implements the same contract as the Neo4j ``GraphMemoryStore`` (same node/edge
semantics, same traversal bounds, same best-effort degradation) using only the
Python standard library, so the desktop build needs no Neo4j server.

Equivalence notes (vs the Neo4j adapter):
- ``find_related_memories`` mirrors the one-hop Cypher: seeds → directly
  connected Memory nodes (not the seed itself), scoped to ``user_id``, ordered
  by importance desc, bounded by ``memory_graph_max_nodes``/``top_k``.
- Rows are dicts with the same keys as the Cypher projection
  (``id, content, type, importance, rel_type, confidence``).

Concurrency: one SQLite connection guarded by ``asyncio.Lock``. Every public
operation holds the lock for its whole body so multi-statement writes stay
atomic and the connection is never shared between threads mid-call.
"""
from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
from collections.abc import Callable
from typing import Any

from src.application.mem.models import Memory
from src.config import settings
from src.storage.interfaces import GraphStore, sanitize_rel_type

logger = logging.getLogger(__name__)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS graph_nodes (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    type            TEXT,
    content         TEXT,
    importance      REAL NOT NULL DEFAULT 0.5,
    source          TEXT,
    created_at      TEXT,
    access_count    INTEGER NOT NULL DEFAULT 0,
    category        TEXT,
    stage           TEXT,
    confidence      REAL NOT NULL DEFAULT 0.7,
    evidence_count  INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS graph_edges (
    from_id     TEXT NOT NULL,
    to_id       TEXT NOT NULL,
    rel_type    TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    confidence  REAL,
    properties  TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (from_id, to_id, rel_type)
);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_user ON graph_nodes (user_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges (from_id, rel_type);
CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges (to_id, rel_type);
"""

_NODE_UPSERT = """
INSERT INTO graph_nodes
    (id, user_id, type, content, importance, source, created_at, access_count,
     category, stage, confidence, evidence_count)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (id) DO UPDATE SET
    type = excluded.type,
    content = excluded.content,
    importance = excluded.importance,
    source = excluded.source,
    created_at = excluded.created_at,
    access_count = excluded.access_count,
    category = excluded.category,
    stage = excluded.stage,
    confidence = excluded.confidence,
    evidence_count = excluded.evidence_count
"""

_RELATED_QUERY = """
SELECT n.id, n.content, n.type, n.importance,
       e.rel_type, COALESCE(e.confidence, 0.8) AS confidence
FROM graph_edges e
JOIN graph_nodes seed
  ON seed.id = e.from_id OR seed.id = e.to_id
JOIN graph_nodes n
  ON n.id = CASE WHEN e.from_id = seed.id THEN e.to_id ELSE e.from_id END
WHERE seed.user_id = ? AND n.user_id = ?
  AND seed.id IN (SELECT value FROM json_each(?))
  AND n.id <> seed.id
  AND n.type <> 'user'
  AND e.rel_type <> 'HAS_MEMORY'
ORDER BY n.importance DESC, n.id
LIMIT ?
"""

_BY_CONTENT_QUERY = """
SELECT id, content, importance
FROM graph_nodes
WHERE user_id = ? AND type <> 'user'
  AND lower(content) LIKE lower(?)
ORDER BY importance DESC, id
LIMIT ?
"""


class LocalGraphStore(GraphStore):
    """Async SQLite graph store. ``db_path`` may be ``:memory:`` (tests)."""

    def __init__(self, db_path: str = ":memory:") -> None:
        self.db_path = db_path
        self._conn: sqlite3.Connection | None = None
        self._lock = asyncio.Lock()

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
        await asyncio.to_thread(self._conn.execute, "PRAGMA journal_mode=WAL")
        await asyncio.to_thread(self._conn.execute, "PRAGMA busy_timeout=5000")
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

    def _run(self, fn: Callable[..., Any], *args: Any) -> Any:
        return asyncio.to_thread(fn, *args)

    # ── writes ───────────────────────────────────────────────────────────────

    async def upsert_user(self, user_id: str) -> None:
        if self._conn is None:
            return
        async with self._lock:
            await self._run(
                self._conn.execute,
                "INSERT OR IGNORE INTO graph_nodes (id, user_id, type) VALUES (?, ?, 'user')",
                (user_id, user_id),
            )

    async def upsert_memory(self, memory: Memory) -> None:
        if self._conn is None:
            return
        props = memory.to_graph_properties()
        async with self._lock:
            await self._run(
                self._conn.execute,
                _NODE_UPSERT,
                (
                    props["id"],
                    props["user_id"],
                    props["type"],
                    props["content"],
                    props["importance"],
                    props["source"],
                    props["created_at"],
                    props["access_count"],
                    props["category"],
                    props["stage"],
                    props["confidence"],
                    props["evidence_count"],
                ),
            )
            await self._run(
                self._conn.execute,
                "INSERT OR IGNORE INTO graph_edges (from_id, to_id, rel_type, user_id) "
                "VALUES (?, ?, 'HAS_MEMORY', ?)",
                (memory.user_id, memory.id, memory.user_id),
            )

    async def delete_memory(self, user_id: str, memory_id: str) -> None:
        if self._conn is None:
            return
        async with self._lock:
            await self._run(
                self._conn.execute,
                "DELETE FROM graph_edges WHERE (from_id = ? OR to_id = ?) AND user_id = ?",
                (memory_id, memory_id, user_id),
            )
            await self._run(
                self._conn.execute,
                "DELETE FROM graph_nodes WHERE id = ? AND user_id = ?",
                (memory_id, user_id),
            )

    async def link_related(
        self,
        user_id: str,
        from_id: str,
        to_id: str,
        rel_type: str = "RELATED_TO",
        properties: dict[str, Any] | None = None,
    ) -> None:
        if self._conn is None:
            return
        rel = sanitize_rel_type(rel_type)
        props = properties or {}
        async with self._lock:
            await self._run(
                self._conn.execute,
                "INSERT INTO graph_edges (from_id, to_id, rel_type, user_id, confidence, properties) "
                "VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT (from_id, to_id, rel_type) DO UPDATE SET "
                "confidence = excluded.confidence, properties = excluded.properties",
                (
                    from_id,
                    to_id,
                    rel,
                    user_id,
                    float(props.get("confidence")) if props.get("confidence") is not None else None,
                    json.dumps(props),
                ),
            )

    # ── reads ────────────────────────────────────────────────────────────────

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
        if self._conn is None or not seed_ids:
            return []
        max_depth = max_depth or settings.memory_graph_max_depth
        depth = max(1, min(int(depth), max_depth))
        cap = min(int(top_k), settings.memory_graph_max_nodes)
        timeout_s = timeout_s or settings.memory_graph_query_timeout_s
        seeds = json.dumps([str(s) for s in seed_ids])

        async def _run() -> list[dict[str, Any]]:
            async with self._lock:
                cursor = await asyncio.to_thread(
                    self._conn.execute, _RELATED_QUERY, (user_id, user_id, seeds, cap)
                )
                rows = await asyncio.to_thread(cursor.fetchall)
            return [
                {
                    "id": str(row["id"]),
                    "content": row["content"],
                    "type": row["type"],
                    "importance": float(row["importance"] or 0.5),
                    "rel_type": str(row["rel_type"]),
                    "confidence": float(row["confidence"] or 0.8),
                }
                for row in rows
            ]

        try:
            return await asyncio.wait_for(_run(), timeout=timeout_s)
        except Exception as exc:  # noqa: BLE001 - best-effort like the Neo4j store
            logger.debug("local graph traversal failed: %s", exc)
            return []

    async def find_related_by_content(
        self,
        user_id: str,
        content: str,
        *,
        top_k: int = 3,
        timeout_s: float | None = None,
    ) -> list[dict[str, Any]]:
        if self._conn is None or not content:
            return []
        timeout_s = timeout_s or settings.memory_graph_query_timeout_s
        cap = min(int(top_k), settings.memory_graph_max_nodes)
        # Escape LIKE wildcards so containment stays exact (mirrors Cypher CONTAINS).
        needle = "%" + content.replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_") + "%"

        async def _run() -> list[dict[str, Any]]:
            async with self._lock:
                cursor = await asyncio.to_thread(
                    self._conn.execute, _BY_CONTENT_QUERY, (user_id, needle, cap)
                )
                rows = await asyncio.to_thread(cursor.fetchall)
            return [
                {
                    "id": str(row["id"]),
                    "content": row["content"],
                    "importance": float(row["importance"] or 0.5),
                }
                for row in rows
            ]

        try:
            return await asyncio.wait_for(_run(), timeout=timeout_s)
        except Exception as exc:  # noqa: BLE001
            logger.debug("local graph content match failed: %s", exc)
            return []

    async def prune_stale_edges(self, user_id: str, active_ids: list[str]) -> None:
        if self._conn is None:
            return
        active = [str(s) for s in active_ids]

        async def _run() -> None:
            async with self._lock:
                if active:
                    placeholders = ",".join("?" * len(active))
                    cursor = await asyncio.to_thread(
                        self._conn.execute,
                        f"SELECT id FROM graph_nodes WHERE user_id = ? AND id NOT IN ({placeholders})",
                        (user_id, *active),
                    )
                else:
                    cursor = await asyncio.to_thread(
                        self._conn.execute,
                        "SELECT id FROM graph_nodes WHERE user_id = ?",
                        (user_id,),
                    )
                stale = [row["id"] for row in await asyncio.to_thread(cursor.fetchall)]
                for memory_id in stale:
                    await asyncio.to_thread(
                        self._conn.execute,
                        "DELETE FROM graph_edges WHERE (from_id = ? OR to_id = ?) AND user_id = ?",
                        (memory_id, memory_id, user_id),
                    )
                for memory_id in stale:
                    await asyncio.to_thread(
                        self._conn.execute,
                        "DELETE FROM graph_nodes WHERE id = ? AND user_id = ?",
                        (memory_id, user_id),
                    )

        await _run()

    @staticmethod
    def format_relationships(related: list[dict[str, Any]]) -> list[str]:
        """Render rows into prompt-friendly ``[REL, importance] content`` lines."""
        lines: list[str] = []
        for row in related:
            content = str(row.get("content") or "").strip()
            rel_type = str(row.get("rel_type") or "RELATED_TO")
            importance = float(row.get("importance") or 0.5)
            if not content:
                continue
            lines.append(f"[{rel_type}, importance {importance:.1f}] {content}")
        return lines
