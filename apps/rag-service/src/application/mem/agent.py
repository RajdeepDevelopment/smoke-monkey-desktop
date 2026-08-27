"""MemoryAgent — orchestrates the write and read paths across both stores.

Write path (``index_exchange``): delegates the durable storage to the pgvector
``MemoryStore``, then — when the graph layer is enabled — mirrors each stored
fact as a graph node and links relationship edges reported by the extractor
(the relationship links become typed ``(subject)-[PREDICATE]->(object)`` edges
after each entity is resolved to an existing memory id).

Read path (``graph_context``): given the semantic/relationship hits the vector
store already found, walk the graph around those seeds and surface *connected*
memories the query never mentioned, formatted as relationship lines for the
system prompt.

The agent is defensive throughout: graph failures degrade to no-ops so memory
writes and reads stay best-effort (they must never break the pipeline).
"""
from __future__ import annotations

import logging
from typing import Any

from src.application.mem.classifier import MemoryClassifier
from src.application.mem.context import AsyncParallelContextProvider
from src.application.mem.graph import GraphMemoryStore
from src.application.mem.live_extractor import LiveSignalExtractor
from src.application.mem.models import Memory, MemorySource, MemoryType
from src.application.mem.observation_store import MemoryConsolidator, ObservationStore
from src.application.mem.prospective import ProspectiveMemoryStore
from src.application.memory import MemoryStore, _embed_input_type
from src.config import settings
from src.generation.embedders import Embedder

logger = logging.getLogger(__name__)


class MemoryAgent:
    """Ties pgvector store, graph store, prospective store, live extractor, and parallel context together."""

    def __init__(
        self,
        store: MemoryStore,
        graph: GraphMemoryStore | None = None,
        embedder: Embedder | None = None,
        prospective: ProspectiveMemoryStore | None = None,
    ) -> None:
        self.store = store
        self.graph = graph
        self.embedder = embedder
        self.prospective = prospective or ProspectiveMemoryStore()
        self.classifier = MemoryClassifier()
        self.live_extractor = LiveSignalExtractor()
        self.obs_store = ObservationStore()
        self.consolidator = MemoryConsolidator(self.obs_store, memory_store=store, graph_store=graph)
        self.context_provider = AsyncParallelContextProvider(
            vector_store=store,
            graph_store=graph,
            prospective_store=self.prospective,
        )

    @property
    def graph_enabled(self) -> bool:
        return bool(
            self.graph is not None
            and self.graph.enabled
            and settings.neo4j_enabled
            and settings.memory_graph_enabled
        )

    # ── write path ──────────────────────────────────────────────────────────

    async def index_exchange(
        self,
        *,
        llm,
        user_id: str,
        conversation_id: str | None,
        query: str,
        answer: str,
        history: list[dict[str, str]] | None = None,
        embed_key: str | None = None,
        chat_key: str | None = None,
        resolved: Any = None,
        embedder: Any = None,
    ) -> None:
        """Persist one exchange: episodic + facts in pgvector, then graph links.

        With the outbox enabled the pgvector write emits outbox events in the
        same transaction and graph linking is deferred to the relay worker (so
        a graph failure can never corrupt the source of truth). Without an
        outbox (tests, no pool) the graph is linked inline as a best-effort
        fallback. ``resolved`` is the reconstruction layer's ContextPacket and
        is threaded into extraction so facts are written in self-contained form.
        """
        if self.store is None or not user_id:
            return
        records = await self.store.remember(
            llm=llm,
            user_id=user_id,
            conversation_id=conversation_id,
            query=query,
            answer=answer,
            history=history,
            embed_key=embed_key,
            chat_key=chat_key,
            resolved=resolved,
            embedder=embedder,
        )
        if not self.graph_enabled or not records:
            return
        if getattr(self.store, "outbox", None) is not None:
            # Graph mirroring is applied asynchronously by the outbox relay.
            return
        try:
            await self._link_graph(user_id, records, embed_key)
        except Exception:
            logger.warning("graph memory linking failed", exc_info=True)

    async def apply_outbox_event(self, event: Any) -> None:
        """Idempotent downstream handler for outbox events (drives the graph).

        ``memory_stored`` / ``memory_merged`` / ``memory_refreshed`` upsert the
        node (MERGE is idempotent); ``memory_stored`` additionally links the
        relationship edges the extractor reported; ``memory_deleted`` detaches
        the node. Runs on a retried event exactly like the first time.
        """
        graph = self.graph
        if graph is None or not graph.enabled or not settings.neo4j_enabled or not settings.memory_graph_enabled:
            return
        payload = event.payload or {}
        if event.event_type == "memory_deleted":
            await graph.delete_memory(event.user_id, event.aggregate_id)
            return

        content = str(payload.get("content") or "").strip()
        if not content:
            return
        await graph.upsert_user(event.user_id)
        memory = Memory(
            id=event.aggregate_id,
            user_id=event.user_id,
            type=MemoryType.from_extractor(payload.get("type") or "fact"),
            content=content,
            importance=float(payload.get("importance") or 0.5),
            source=MemorySource.CONVERSATION,
        )
        await graph.upsert_memory(memory)
        if event.event_type == "memory_stored":
            await self._link_relationships(
                event.user_id,
                event.aggregate_id,
                content,
                payload.get("relationships") or [],
                embed_key=None,
            )

    async def _link_relationships(
        self,
        user_id: str,
        memory_id: str,
        content: str,
        raw_links: list[Any],
        embed_key: str | None,
    ) -> None:
        """Resolve relationship subjects/objects to memory ids and link edges."""
        graph = self.graph
        if graph is None:
            return
        fact = {"content": content, "relationships": raw_links}
        for link in self.classifier.relationship_links(fact, fallback_subject=content):
            subject_id = await self._resolve_entity(user_id, link["subject"], embed_key)
            object_id = await self._resolve_entity(user_id, link["object"], embed_key)
            if subject_id and object_id and subject_id != object_id:
                await graph.link_related(
                    user_id,
                    subject_id,
                    object_id,
                    link["predicate"],
                    {"confidence": 0.8, "source": "extractor"},
                )
            # Anchor the fact itself to both endpoints so it is reachable.
            if subject_id and subject_id != memory_id:
                await graph.link_related(user_id, memory_id, subject_id, "RELATED_TO", {"confidence": 0.7})
            if object_id and object_id != memory_id:
                await graph.link_related(user_id, memory_id, object_id, "RELATED_TO", {"confidence": 0.7})

    async def _link_graph(
        self,
        user_id: str,
        records: list[dict[str, Any]],
        embed_key: str | None,
    ) -> None:
        graph = self.graph
        if not records or graph is None or not graph.enabled or not settings.neo4j_enabled or not settings.memory_graph_enabled:
            return
        await graph.upsert_user(user_id)
        seen: set[str] = set()
        for record in records:
            fact = record.get("fact") or {}
            memory_id = str(record.get("memory_id") or "")
            if not memory_id or memory_id in seen:
                continue
            seen.add(memory_id)
            content = str(fact.get("content") or "").strip()
            if not content:
                continue
            mem_type = MemoryType.from_extractor(fact.get("type") or "fact")
            memory = Memory(
                id=memory_id,
                user_id=user_id,
                type=mem_type,
                content=content,
                importance=float(fact.get("importance") or 0.5),
                source=MemorySource.CONVERSATION,
            )
            await graph.upsert_memory(memory)
            await self._link_relationships(
                user_id,
                memory_id,
                content,
                fact.get("relationships") or [],
                embed_key,
            )

    async def _resolve_entity(
        self,
        user_id: str,
        entity: str,
        embed_key: str | None,
    ) -> str | None:
        """Resolve a bare entity name to an existing memory id (or None).

        Tries a keyword match in the graph first (cheap, precise), then falls
        back to an embedding nearest-neighbor search in the vector store when
        the graph does not already hold the entity.
        """
        entity = (entity or "").strip().strip('"').strip()
        if not entity or len(entity) < 2:
            return None
        graph = self.graph
        if graph is not None and graph.enabled and settings.neo4j_enabled and settings.memory_graph_enabled:
            try:
                rows = await graph.find_related_by_content(user_id, entity, top_k=1)
                if rows and rows[0].get("id"):
                    return str(rows[0]["id"])
            except Exception:
                logger.debug("graph entity resolve failed", exc_info=True)
        if self.store is None or self.embedder is None:
            return None
        try:
            vectors = await self.embedder.embed(
                [entity],
                api_key=embed_key,
                input_type=_embed_input_type(self.embedder.provider_id),
            )
            if not vectors or not vectors[0]:
                return None
            matches = await self.store.match_entity(vectors[0], user_id, top_k=1)
        except Exception:
            logger.debug("embedding entity resolve failed", exc_info=True)
            return None
        if not matches:
            return None
        # Mirror the matched memory as a node so the edge can actually be created.
        if graph is not None:
            try:
                await graph.upsert_memory(
                    Memory(
                        id=matches[0]["id"],
                        user_id=user_id,
                        type=MemoryType.from_extractor(matches[0].get("type") or "fact"),
                        content=matches[0].get("content") or entity,
                        importance=float(matches[0].get("sim") or 0.5),
                        source=MemorySource.CONVERSATION,
                    )
                )
            except Exception:
                logger.debug("graph entity node upsert failed", exc_info=True)
        return matches[0]["id"]

    # ── read path ───────────────────────────────────────────────────────────

    async def graph_context(
        self,
        user_id: str,
        seed_ids: list[str],
        *,
        depth: int = 1,
        top_k: int = 6,
    ) -> list[str]:
        """Return prompt-ready relationship lines for memories connected to seeds."""
        graph = self.graph
        if not self.graph_enabled or not seed_ids or graph is None:
            return []
        try:
            rows = await graph.find_related_memories(user_id, seed_ids, depth=depth, top_k=top_k)
            return graph.format_relationships(rows)
        except Exception:
            logger.debug("graph context failed", exc_info=True)
            return []
