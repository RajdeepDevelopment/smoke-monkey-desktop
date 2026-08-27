"""Neo4j graph store for relationship memory (human-association layer).

Memories are nodes (``Memory``), keyed by the same id as the pgvector row, and
the user owns them via ``HAS_MEMORY`` edges. Typed edges between memories
(RELATED_TO, WORKS_AT, PREFERS, REPORTS_TO, ...) are created by the memory agent
when the extractor reports relationships, and retrieval walks the graph around
the semantic hits to surface *connected* memories the query never mentioned.

The driver is injectable so tests never need a live Neo4j instance. Every
method is defensive: a down/absent graph degrades to a no-op instead of
breaking the pipeline (memory must stay best-effort).

Traversal safety (item 12): depth is clamped to ``memory_graph_max_depth``,
every result is bounded by ``memory_graph_max_nodes``/``top_k``, and each
query is wrapped in ``asyncio.wait_for`` so a slow/cyclical graph cannot blow
the request deadline.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from src.application.mem.models import Memory
from src.config import settings
from src.storage.interfaces import (
    GraphStore,
    sanitize_rel_type,
)

logger = logging.getLogger(__name__)

# Neo4j relationship types cannot be parameterized. The sanitizer + type
# registry live in the storage layer (src.storage.interfaces) so every
# GraphStore adapter shares one definition.
_CREATE_INDEXES = (
    "CREATE INDEX memory_node_id IF NOT EXISTS FOR (m:Memory) ON (m.id)",
    "CREATE INDEX memory_node_user IF NOT EXISTS FOR (m:Memory) ON (m.user_id)",
    "CREATE INDEX user_node_id IF NOT EXISTS FOR (u:User) ON (u.id)",
)


async def _consume_bounded(result: Any, *, timeout_s: float, max_rows: int) -> list[dict[str, Any]]:
    """Collect a Neo4j Result's records under a hard timeout + row cap.

    A pathological graph (dense hub, long chain) is stopped at ``max_rows``
    records; a slow server is stopped by the ``asyncio.wait_for`` deadline.
    """
    rows: list[dict[str, Any]] = []

    async def _collect() -> list[dict[str, Any]]:
        collected: list[dict[str, Any]] = []
        async for record in result:
            collected.append(dict(record))
            if len(collected) >= max_rows:
                break
        return collected

    try:
        rows = await asyncio.wait_for(_collect(), timeout=timeout_s)
    except Exception as exc:  # noqa: BLE001 - best-effort
        logger.debug("graph query timed out or failed (%.1fs, %d rows): %s", timeout_s, len(rows), exc)
    return rows


class GraphMemoryStore(GraphStore):
    """Async Neo4j storage. ``driver`` may be injected for tests.

    Implements the ``GraphStore`` port (src.storage.interfaces), so callers
    depend on the interface and a local substitute can be swapped in later.
    """

    def __init__(
        self,
        uri: str = "bolt://localhost:7687",
        user: str = "neo4j",
        password: str = "",
        driver: Any | None = None,
    ) -> None:
        self.uri = uri
        self.user = user
        self.password = password
        self._driver = driver

    @property
    def enabled(self) -> bool:
        return self._driver is not None

    async def connect(self) -> None:
        """Create the driver (idempotent). Does not ping the server."""
        if self._driver is not None:
            return
        try:
            from neo4j import AsyncGraphDatabase
        except ImportError:
            logger.warning("neo4j package not installed; graph memory disabled")
            self._driver = None
            return
        self._driver = AsyncGraphDatabase.driver(self.uri, auth=(self.user, self.password))

    async def close(self) -> None:
        if self._driver is None:
            return
        try:
            await self._driver.close()
        except Exception as exc:  # noqa: BLE001 - best-effort shutdown
            logger.debug("graph driver close failed: %s", exc)
        self._driver = None

    async def ensure_schema(self) -> None:
        if not self.enabled:
            return
        try:
            async with self._driver.session() as session:
                for statement in _CREATE_INDEXES:
                    await session.run(statement)
        except Exception as exc:  # noqa: BLE001
            logger.warning("graph schema setup failed (continuing): %s", exc)

    async def upsert_user(self, user_id: str) -> None:
        if not self.enabled:
            return
        try:
            async with self._driver.session() as session:
                await session.run("MERGE (u:User {id: $id})", id=user_id)
        except Exception as exc:  # noqa: BLE001
            logger.debug("graph upsert_user failed: %s", exc)

    async def upsert_memory(self, memory: Memory) -> None:
        if not self.enabled:
            return
        props = memory.to_graph_properties()
        try:
            async with self._driver.session() as session:
                await session.run(
                    """
                    MERGE (m:Memory {id: $id})
                    SET m += $props
                    """,
                    id=memory.id,
                    props=props,
                )
                await session.run(
                    """
                    MATCH (u:User {id: $user_id}), (m:Memory {id: $id})
                    MERGE (u)-[:HAS_MEMORY]->(m)
                    """,
                    user_id=memory.user_id,
                    id=memory.id,
                )
        except Exception as exc:  # noqa: BLE001
            logger.debug("graph upsert_memory failed: %s", exc)

    async def delete_memory(self, user_id: str, memory_id: str) -> None:
        """Remove a memory node and all its edges (called from the outbox relay
        when a memory is forgotten/expired/merged away)."""
        if not self.enabled:
            return
        try:
            async with self._driver.session() as session:
                await session.run(
                    """
                    MATCH (u:User {id: $user_id})-[:HAS_MEMORY]->(m:Memory {id: $id})
                    DETACH DELETE m
                    """,
                    user_id=user_id,
                    id=memory_id,
                )
        except Exception as exc:  # noqa: BLE001
            logger.debug("graph delete_memory failed: %s", exc)

    async def link_related(
        self,
        user_id: str,
        from_id: str,
        to_id: str,
        rel_type: str = "RELATED_TO",
        properties: dict[str, Any] | None = None,
    ) -> None:
        """Create/refresh a typed edge between two memories (both must exist).

        Scoped to ``user_id`` (item 8): both endpoints must belong to the same
        user's subgraph, so one user's edges can never reference another user's
        nodes.
        """
        if not self.enabled:
            return
        rel = sanitize_rel_type(rel_type)
        try:
            async with self._driver.session() as session:
                await session.run(
                    f"""
                    MATCH (u:User {{id: $user_id}})-[:HAS_MEMORY]->(a:Memory {{id: $from_id}}),
                          (u)-[:HAS_MEMORY]->(b:Memory {{id: $to_id}})
                    MERGE (a)-[r:{rel}]->(b)
                    SET r += $props
                    """,
                    user_id=user_id,
                    from_id=from_id,
                    to_id=to_id,
                    props=properties or {},
                )
        except Exception as exc:  # noqa: BLE001
            logger.debug("graph link_related failed: %s", exc)

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
        """Walk the graph around the seed memories and return related memories.

        Returns rows with ``id, content, type, importance, rel_type`` (the edge
        type that connected them). The graph is scoped to the user.

        Traversal is bounded (item 12): ``depth`` is clamped to
        ``memory_graph_max_depth``, results to ``memory_graph_max_nodes``, and
        the query runs under ``memory_graph_query_timeout_s``.
        """
        if not self.enabled or not seed_ids:
            return []
        timeout_s = timeout_s or settings.memory_graph_query_timeout_s
        max_depth = max_depth or settings.memory_graph_max_depth
        depth = max(1, min(int(depth), max_depth))
        cap = min(int(top_k), settings.memory_graph_max_nodes)
        try:
            async with self._driver.session() as session:
                result = await session.run(
                    """
                    MATCH (u:User {id: $user_id})-[:HAS_MEMORY]->(seed:Memory)
                    WHERE seed.id IN $seed_ids
                    MATCH (seed)-[r]-(related:Memory)
                    WHERE related.id <> seed.id
                      AND related.user_id = $user_id
                    WITH related, type(r) AS rel_type, r.confidence AS conf
                    RETURN related.id AS id, related.content AS content,
                           related.type AS type, related.importance AS importance,
                           rel_type, coalesce(conf, 0.8) AS confidence
                    ORDER BY related.importance DESC
                    LIMIT $top_k
                    """,
                    user_id=user_id,
                    seed_ids=list(seed_ids),
                    top_k=cap,
                )
                return await _consume_bounded(
                    result, timeout_s=timeout_s, max_rows=cap
                )
        except Exception as exc:  # noqa: BLE001 - graph is best-effort
            logger.debug("graph find_related_memories failed: %s", exc)
            return []

    async def find_related_by_content(
        self,
        user_id: str,
        content: str,
        *,
        top_k: int = 3,
        timeout_s: float | None = None,
    ) -> list[dict[str, Any]]:
        """Find memories mentioning an entity (used to resolve relationship
        subjects/objects to existing memories)."""
        if not self.enabled or not content:
            return []
        timeout_s = timeout_s or settings.memory_graph_query_timeout_s
        cap = min(int(top_k), settings.memory_graph_max_nodes)
        try:
            async with self._driver.session() as session:
                result = await session.run(
                    """
                    MATCH (m:Memory {user_id: $user_id})
                    WHERE toLower(m.content) CONTAINS toLower($content)
                    RETURN m.id AS id, m.content AS content, m.importance AS importance
                    ORDER BY m.importance DESC
                    LIMIT $top_k
                    """,
                    user_id=user_id,
                    content=content,
                    top_k=cap,
                )
                return await _consume_bounded(
                    result, timeout_s=timeout_s, max_rows=cap
                )
        except Exception as exc:  # noqa: BLE001
            logger.debug("graph find_related_by_content failed: %s", exc)
            return []

    async def prune_stale_edges(self, user_id: str, active_ids: list[str]) -> None:
        """Remove edges from deleted/expired memories (called on consolidation)."""
        if not self.enabled:
            return
        try:
            async with self._driver.session() as session:
                await session.run(
                    """
                    MATCH (u:User {id: $user_id})-[r:HAS_MEMORY]->(m:Memory)
                    WHERE NOT m.id IN $active_ids
                    DETACH DELETE m
                    """,
                    user_id=user_id,
                    active_ids=list(active_ids),
                )
        except Exception as exc:  # noqa: BLE001
            logger.debug("graph prune_stale_edges failed: %s", exc)

    def format_relationships(self, related: list[dict[str, Any]]) -> list[str]:
        """Render graph rows into prompt-friendly relationship lines."""
        lines: list[str] = []
        for row in related:
            content = str(row.get("content") or "").strip()
            rel_type = str(row.get("rel_type") or "RELATED_TO")
            importance = float(row.get("importance") or 0.5)
            if not content:
                continue
            lines.append(f"[{rel_type}, importance {importance:.1f}] {content}")
        return lines


# RELATIONSHIP_TYPES and sanitize_rel_type are imported above and therefore
# re-exported from this module for existing callers.
