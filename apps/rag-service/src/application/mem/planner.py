"""Retrieval planner: decides what the memory layer should pull for a query.

The pipeline already knows the routing decision (intent, needs_memory, ...).
The planner turns that into a concrete memory plan — which memory types to
fetch, how many of each, whether to include the critical-facts floor, and how
deeply to walk the relationship graph. This keeps the retrieval strategy data-
driven and per-query instead of one-size-fits-all.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from src.application.mem.models import MemoryType
from src.config import settings

# A query is about the user's own world when it uses personal pronouns. The
# critical-facts floor (force-inject the user's top durable facts) only fires
# for these — a pure knowledge question ("explain quantum computing") must not
# get the user's private facts pushed into its context.
PERSONAL_RE = re.compile(r"\b(i|me|my|mine|we|our|ours|us)\b", re.IGNORECASE)


@dataclass
class MemoryPlan:
    """A resolved retrieval plan for one query."""

    types: list[MemoryType]  # memory types to fetch (semantic/episodic/...)
    semantic_top_k: int = 5
    episodic_top_k: int = 4
    include_critical: bool = True
    critical_importance: float = 0.8
    critical_top_k: int = 3
    graph_depth: int = field(default_factory=lambda: settings.memory_graph_context_depth)
    graph_context_top_k: int = field(default_factory=lambda: settings.memory_graph_context_top_k)
    # Personalization-driven fields the request depends on (e.g. "household
    # income"). Folded into retrieval so the answer personalises by default.
    required_context: list[str] = field(default_factory=list)
    # Reconstruction-layer context: the decontextualized query actually used for
    # retrieval and the active entities it resolved, so the plan (and the graph
    # walk) are anchored on what the message *means*, not its raw wording.
    resolved_query: str = ""
    entity_anchors: list[str] = field(default_factory=list)
    reasoning: str = ""


class RetrievalPlanner:
    """Create a memory plan from the routing decision + query signals."""

    @staticmethod
    def create_plan(
        *,
        intent: str = "general",
        needs_memory: bool = False,
        query: str = "",
        route: str = "complex",
        resolved_query: str | None = None,
        entity_anchors: list[str] | None = None,
    ) -> MemoryPlan:
        intent = (intent or "general").lower().strip()
        # Retrieval reasons over the *meaning* of the message: use the
        # reconstruction layer's decontextualized query when one exists, and
        # carry the resolved entities as anchors so "he" plans like the person
        # it refers to, not like a pronoun.
        query_lower = (resolved_query or query or "").lower()
        anchors = [e for e in (entity_anchors or []) if e]
        mentions_time = any(
            w in query_lower for w in ("today", "yesterday", "last week", "earlier", "recently", "before")
        )
        # Critical-facts floor is only for questions about the user themselves.
        # A knowledge/web question with no personal pronoun must not be polluted
        # with the user's identity facts (semantic scoring still surfaces them
        # when they are genuinely relevant).
        personal = needs_memory or bool(PERSONAL_RE.search(query_lower))

        # A memory-heavy query: the user asks about their own past/work.
        if intent in ("memory", "hybrid") or needs_memory:
            return MemoryPlan(
                types=[MemoryType.SEMANTIC, MemoryType.EPISODIC, MemoryType.PROCEDURAL, MemoryType.RELATIONSHIP],
                semantic_top_k=6,
                episodic_top_k=5,
                include_critical=personal,
                graph_depth=2,
                graph_context_top_k=8,
                resolved_query=resolved_query or "",
                entity_anchors=anchors,
                reasoning="personal/continuity query → full memory recall + graph",
            )

        # Explicit question about relationships between people/topics.
        if any(w in query_lower for w in ("who is", "how are", "related", "connection", "relationship")):
            return MemoryPlan(
                types=[MemoryType.SEMANTIC, MemoryType.RELATIONSHIP],
                semantic_top_k=5,
                include_critical=personal,
                graph_depth=2,
                graph_context_top_k=8,
                resolved_query=resolved_query or "",
                entity_anchors=anchors,
                reasoning="relationship-focused query → semantic + graph walk",
            )

        # A fresh/current event reference favours episodic (working memory).
        if mentions_time:
            return MemoryPlan(
                types=[MemoryType.SEMANTIC, MemoryType.EPISODIC],
                episodic_top_k=4,
                include_critical=personal,
                graph_depth=1,
                resolved_query=resolved_query or "",
                entity_anchors=anchors,
                reasoning="time-anchored query → episodic + durable facts",
            )

        # Default: durable profile facts + critical floor (cheap, every turn).
        # The critical floor is limited to personal queries, so a generic
        # knowledge question never drags the user's private facts into context.
        return MemoryPlan(
            types=[MemoryType.SEMANTIC],
            include_critical=personal,
            graph_depth=1,
            resolved_query=resolved_query or "",
            entity_anchors=anchors,
            reasoning="default → durable facts + critical floor",
        )
