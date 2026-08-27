"""Async Parallel Context Engine & ContextSnapshot Fusion.

Features:
1. Context Router — evaluates query intent to select required context providers.
2. Deadline-Controlled Parallel Provider Engine — calls Redis, Neo4j, pgvector,
   PostgreSQL, and Prospective Memory in parallel using per-provider timeouts
   and a strict 300ms global deadline.
3. Stale Context Metadata — attaches source, version, confidence, and stale tags.
4. Deterministic Precedence Rules — enforces override order during prompt fusion:
   CURRENT USER MESSAGE > LIVE L0 > EXPLICIT MEMORY > RECENT MEMORY > TASK > GRAPH > SEMANTIC > PERSONALITY.
5. ContextSnapshot — returns one coherent snapshot containing working memory,
   live observations, stable facts, graph relationships, prospective memories (max 2),
   assistant state, and uncertainty scores.
"""
from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import IntEnum
from typing import Any

from src.application.mem.live_extractor import LiveObservation
from src.application.mem.prospective import MAX_PROSPECTIVE_CONTEXT, ProspectiveMemoryStore
from src.config import settings

logger = logging.getLogger(__name__)

GLOBAL_CONTEXT_DEADLINE_MS = 300


class ProviderPriority(IntEnum):
    CRITICAL = 1
    HIGH = 2
    MEDIUM = 3
    LOW = 4


@dataclass
class ProviderResult:
    source: str
    data: list[Any]
    retrieved_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    version: int = 1
    confidence: float = 1.0
    stale: bool = False
    timing_ms: float = 0.0


@dataclass
class ContextRoute:
    """The router's decision: which providers to call, plus cost budgets.

    Subscripting by provider name returns the boolean flag, so ``route["neo4j"]``
    reads naturally while ``route.providers`` exposes the full mapping.
    """

    providers: dict[str, bool]
    budget_ms: int = 250
    max_context_tokens: int = 4500

    def __getitem__(self, key: str) -> bool | int:
        if key in self.providers:
            return self.providers[key]
        raise KeyError(key)


@dataclass
class AssistantState:
    previous_commitments: list[str] = field(default_factory=list)
    pending_questions: list[str] = field(default_factory=list)
    last_actions: list[str] = field(default_factory=list)


def estimate_tokens(text: str) -> int:
    """Rough token estimate (len/4) used to enforce prompt budgets."""
    if not text:
        return 0
    return max(1, round(len(text) / 4))


# Per-section token caps (see settings.context_budget_*). Order matters for the
# global budget: lower priority = first to be dropped when the snapshot overruns.
_SECTION_BUDGETS = (
    ("live_signals", "live", settings.context_budget_live),
    ("prospective", "prospective", settings.context_budget_prospective),
    ("graph", "graph", settings.context_budget_graph),
    ("facts", "facts", settings.context_budget_facts),
    ("recent", "recent", settings.context_budget_recent),
    ("tasks", "tasks", settings.context_budget_tasks),
    ("personality", "personality", settings.context_budget_personality),
)


class ContextCompressor:
    """Deduplicate + compress repeated context lines before prompt injection.

    The same fact restated across turns ("User said X" ×4) collapses into one
    canonical line so one user cannot blow the context window with echoes.
    """

    @staticmethod
    def compress_lines(lines: list[str]) -> list[str]:
        compressed: list[str] = []
        seen: set[str] = set()
        for line in lines:
            text = str(line or "").strip()
            if not text:
                continue
            normalized = re.sub(r"\s+", " ", text.lower())
            if normalized in seen:
                continue
            seen.add(normalized)
            compressed.append(text)
        return compressed

    @staticmethod
    def truncate_sections(
        sections: dict[str, str],
        *,
        token_budget: int,
        budgets: tuple[tuple[str, str, int], ...] = _SECTION_BUDGETS,
    ) -> dict[str, str]:
        """Enforce per-section caps, then drop low-priority sections when the
        whole snapshot exceeds ``token_budget`` (tokens estimated len/4)."""
        capped: dict[str, str] = {}
        for key, _, limit in budgets:
            body = sections.get(key)
            if not body:
                continue
            lines = body.splitlines(keepends=True)
            kept: list[str] = []
            used = 0
            for line in lines:
                cost = estimate_tokens(line)
                if used + cost > limit:
                    break
                kept.append(line)
                used += cost
            if kept:
                capped[key] = "".join(kept)

        total = sum(estimate_tokens(body) for body in capped.values())
        if total <= token_budget:
            return capped
        # Global budget exceeded: drop sections from the bottom of the
        # precedence order (personality → tasks → recent → facts → graph …)
        # until the snapshot fits.
        for key, _, _ in reversed(budgets):
            if key not in capped:
                continue
            total -= estimate_tokens(capped[key])
            del capped[key]
            if total <= token_budget:
                break
        return capped


@dataclass
class ContextSnapshot:
    """Coherent context snapshot fed to the LLM system prompt."""

    current_message: str
    live_observations: list[LiveObservation] = field(default_factory=list)
    recent_turns: list[dict[str, str]] = field(default_factory=list)
    stable_facts: list[str] = field(default_factory=list)
    graph_relationships: list[str] = field(default_factory=list)
    prospective_memories: list[dict[str, Any]] = field(default_factory=list)
    active_tasks: list[dict[str, Any]] = field(default_factory=list)
    personality_profile: dict[str, Any] = field(default_factory=dict)
    active_goals: list[str] = field(default_factory=list)
    assistant_state: AssistantState = field(default_factory=AssistantState)
    uncertainty: dict[str, float] = field(default_factory=dict)

    def to_prompt_sections(
        self,
        *,
        compress: bool | None = None,
        token_budget: int | None = None,
    ) -> dict[str, str]:
        """Format ContextSnapshot into prompt-ready system sections with precedence.

        Compression (``ContextCompressor``) dedupes repeated lines and the
        section budgets keep the injected context inside the configured token
        window — one memory-heavy user cannot blow the LLM prompt.
        """
        compress = settings.context_compression_enabled if compress is None else compress
        token_budget = token_budget or settings.context_max_tokens
        sections: dict[str, str] = {}

        # L0 Live Observations (highest precedence)
        if self.live_observations:
            obs_lines = [f"- {o.type}: {o.subject} = {o.value}" for o in self.live_observations]
            sections["live_signals"] = "IMMEDIATE INLINE CORRECTIONS:\n" + "\n".join(obs_lines)

        # Prospective Memories (Max 2 items)
        if self.prospective_memories:
            p_lines = [
                f"- {p['subject']}: {p['content']}"
                for p in self.prospective_memories[:MAX_PROSPECTIVE_CONTEXT]
            ]
            sections["prospective"] = "UPCOMING / PROSPECTIVE INTENTS:\n" + "\n".join(p_lines)

        # Graph Relationships
        if self.graph_relationships:
            sections["graph"] = "CONNECTED RELATIONSHIP MEMORY:\n" + "\n".join(
                f"- {r}" for r in self.graph_relationships
            )

        # Stable Facts (pgvector)
        if self.stable_facts:
            sections["facts"] = "STABLE USER MEMORY:\n" + "\n".join(
                f"- {f}" for f in self.stable_facts
            )

        # Recent working memory (Redis / recent turns)
        if self.recent_turns:
            recent_lines = [
                f"- {turn.get('role', 'user')}: {turn.get('content', '')}"
                for turn in self.recent_turns
            ]
            sections["recent"] = "RECENT CONVERSATION:\n" + "\n".join(recent_lines)

        # Active tasks (TodoStore / planner)
        if self.active_tasks:
            task_lines = [
                f"- {t.get('title') or t.get('subject') or t}: {t.get('status') or 'open'}"
                for t in self.active_tasks
            ]
            sections["tasks"] = "ACTIVE TASKS:\n" + "\n".join(task_lines)

        # Personality profile
        if self.personality_profile:
            personality_lines = [f"- {k}: {v}" for k, v in self.personality_profile.items()]
            sections["personality"] = "USER STYLE / PREFERENCES:\n" + "\n".join(personality_lines)

        if compress:
            sections = {
                key: _compress_section(value) for key, value in sections.items()
            }
        return ContextCompressor.truncate_sections(
            sections,
            token_budget=token_budget,
            budgets=_SECTION_BUDGETS,
        )


def _compress_section(body: str) -> str:
    """Dedupe repeated lines inside a section while keeping its header."""
    header, _, rest = body.partition("\n")
    lines = ContextCompressor.compress_lines(rest.split("\n") if rest else [])
    return header + ("\n" + "\n".join(lines) if lines else "")


class ContextRouter:
    """Evaluates query intent to route provider execution (economic optimizer).

    The router is deliberately *selective*: a plain general question
    ("What is React?") calls no memory provider at all, while a personal or
    relationship question calls exactly the providers it needs. Calling every
    provider for every query is what turns 10k requests/sec into 50k backend
    calls/sec — the router exists to prevent that. It also attaches latency and
    token budgets so the online plane stays fast and incomplete.
    """

    _MEMORY_TERMS = {
        "remember", "discussed", "mentioned", "discuss", "talked", "said",
        "earlier", "before", "yesterday", "last", "previous", "previously",
        "recently", "today", "my", "our", "we", "me", "was", "were",
    }
    _RELATIONSHIP_TERMS = {
        "who", "whom", "works", "manager", "report", "reports",
        "team", "teammate", "colleague", "colleagues", "boss", "connected",
        "connection", "relationship", "relationships", "know", "knows",
        "collaborate", "collaborates", "collaborated", "works_at",
    }
    _PROSPECTIVE_TERMS = {
        "tomorrow", "remind", "reminder", "reminders", "schedule",
        "scheduled", "deadline", "deadlines", "exam", "exams", "test",
        "tests", "interview", "interviews", "next", "later", "upcoming",
        "appointment", "appointments", "meeting", "meetings",
    }
    _TASK_TERMS = {
        "task", "tasks", "todo", "todos", "doing", "progress", "working",
        "project", "projects", "checklist", "checklists", "open", "blocked",
    }
    _PERSONALITY_TERMS = {
        "prefer", "prefers", "preference", "preferences", "style", "tone",
        "verbosity", "concise", "detailed",
    }

    def route(self, query: str) -> ContextRoute:
        q = (query or "").lower()
        words = {w for w in re.findall(r"[a-z0-9]{3,}", q)}

        # A general/informational question needs none of the memory providers.
        memory_signal = bool(words & self._MEMORY_TERMS)
        relationship_signal = bool(words & self._RELATIONSHIP_TERMS)
        prospective_signal = bool(words & self._PROSPECTIVE_TERMS)
        task_signal = bool(words & self._TASK_TERMS)
        personality_signal = bool(words & self._PERSONALITY_TERMS)
        # "Who", "what did I", "my X" and explicit relationship words always
        # touch the semantic + graph stores.
        needs_semantic = memory_signal or relationship_signal or bool(re.search(r"\b(my|did i|what did|how did)\b", q))

        providers = {
            # Recent working memory — only when the query anchors on the past.
            "redis": needs_semantic,
            # Durable facts — personal/continuity queries only.
            "pgvector": needs_semantic,
            # Graph walk — relationship/team/people queries only (expensive).
            "neo4j": relationship_signal,
            # Upcoming/reminder intents.
            "prospective": prospective_signal,
            # Task list / progress.
            "tasks": task_signal,
            # Style/preference inference (rarely needed per-turn).
            "personality": personality_signal,
        }
        # The pipeline always consults durable facts for continuity queries
        # ("did we decide X?"); keep the semantic floor on for personal anchors.
        return ContextRoute(
            providers=providers,
            budget_ms=250,
            max_context_tokens=settings.context_max_tokens,
        )


class AsyncParallelContextProvider:
    """Orchestrates deadline-controlled parallel context retrieval."""

    def __init__(
        self,
        redis_store: Any | None = None,
        vector_store: Any | None = None,
        graph_store: Any | None = None,
        prospective_store: ProspectiveMemoryStore | None = None,
        task_store: Any | None = None,
    ) -> None:
        self.redis_store = redis_store
        self.vector_store = vector_store
        self.graph_store = graph_store
        self.prospective_store = prospective_store
        self.task_store = task_store
        self.router = ContextRouter()

    async def _fetch_redis(self, user_id: str, timeout_ms: float = 30) -> ProviderResult:
        start = datetime.now(UTC)
        try:
            data: list[Any] = []
            recent = await asyncio.wait_for(
                self._recent_memory(user_id),
                timeout=timeout_ms / 1000.0,
            )
            data = recent or []
            elapsed = (datetime.now(UTC) - start).total_seconds() * 1000
            return ProviderResult(source="redis", data=data, timing_ms=elapsed)
        except Exception:
            return ProviderResult(source="redis", data=[], stale=True)

    async def _recent_memory(self, user_id: str) -> list[dict[str, str]]:
        """Pull the recent working memory the store exposes (or empty)."""
        if self.redis_store is not None and hasattr(self.redis_store, "recent_memory"):
            return await self.redis_store.recent_memory(user_id, limit=6)
        if self.vector_store is not None and hasattr(self.vector_store, "recent_turns"):
            return await self.vector_store.recent_turns(user_id, limit=6)
        return []

    async def _fetch_vector(self, user_id: str, query: str, timeout_ms: float = 120) -> ProviderResult:
        start = datetime.now(UTC)
        if self.vector_store is None:
            return ProviderResult(source="pgvector", data=[])
        try:
            facts = await asyncio.wait_for(
                self.vector_store.recall_facts(query, user_id, top_k=6),
                timeout=timeout_ms / 1000.0,
            )
            elapsed = (datetime.now(UTC) - start).total_seconds() * 1000
            return ProviderResult(
                source="pgvector",
                data=[f.content for f in facts if hasattr(f, "content")],
                timing_ms=elapsed,
            )
        except Exception:
            return ProviderResult(source="pgvector", data=[], stale=True)

    async def _fetch_graph(self, user_id: str, seed_ids: list[str], timeout_ms: float = 150) -> ProviderResult:
        start = datetime.now(UTC)
        if self.graph_store is None or not seed_ids:
            return ProviderResult(source="neo4j", data=[])
        try:
            rows = await asyncio.wait_for(
                self.graph_store.find_related_memories(user_id, seed_ids, depth=1, top_k=6),
                timeout=timeout_ms / 1000.0,
            )
            relationships = self.graph_store.format_relationships(rows)
            elapsed = (datetime.now(UTC) - start).total_seconds() * 1000
            return ProviderResult(source="neo4j", data=relationships, timing_ms=elapsed)
        except Exception:
            return ProviderResult(source="neo4j", data=[], stale=True)

    async def _fetch_prospective(self, user_id: str, query: str, timeout_ms: float = 50) -> ProviderResult:
        start = datetime.now(UTC)
        if self.prospective_store is None:
            return ProviderResult(source="prospective", data=[])
        try:
            memories = await asyncio.wait_for(
                self.prospective_store.get_top_prospective_context(user_id, query, top_k=MAX_PROSPECTIVE_CONTEXT),
                timeout=timeout_ms / 1000.0,
            )
            elapsed = (datetime.now(UTC) - start).total_seconds() * 1000
            return ProviderResult(source="prospective", data=memories, timing_ms=elapsed)
        except Exception:
            return ProviderResult(source="prospective", data=[], stale=True)

    async def _fetch_personality(self, user_id: str, timeout_ms: float = 50) -> ProviderResult:
        start = datetime.now(UTC)
        if self.vector_store is None or not hasattr(self.vector_store, "recall_preferences"):
            return ProviderResult(source="personality", data=[])
        try:
            prefs = await asyncio.wait_for(
                self.vector_store.recall_preferences(user_id, top_k=6),
                timeout=timeout_ms / 1000.0,
            )
            elapsed = (datetime.now(UTC) - start).total_seconds() * 1000
            return ProviderResult(
                source="personality",
                data=[getattr(f, "content", str(f)) for f in prefs],
                timing_ms=elapsed,
            )
        except Exception:
            return ProviderResult(source="personality", data=[], stale=True)

    async def retrieve_parallel(
        self,
        user_id: str,
        query: str,
        seed_ids: list[str] | None = None,
    ) -> dict[str, ProviderResult]:
        """Execute context providers in parallel within the routed budget.

        Only the providers the router flagged are spawned — a general question
        costs nothing, a relationship question costs exactly the graph + facts.
        """
        routes = self.router.route(query)
        providers = routes.providers
        tasks: dict[str, asyncio.Task[ProviderResult]] = {}

        if providers.get("redis"):
            tasks["redis"] = asyncio.create_task(self._fetch_redis(user_id))
        if providers.get("pgvector"):
            tasks["pgvector"] = asyncio.create_task(self._fetch_vector(user_id, query))
        if providers.get("neo4j") and seed_ids:
            tasks["neo4j"] = asyncio.create_task(self._fetch_graph(user_id, seed_ids))
        if providers.get("prospective"):
            tasks["prospective"] = asyncio.create_task(self._fetch_prospective(user_id, query))
        if providers.get("tasks"):
            tasks["tasks"] = asyncio.create_task(self._fetch_tasks(user_id))
        if providers.get("personality"):
            tasks["personality"] = asyncio.create_task(self._fetch_personality(user_id))

        if not tasks:
            return {}

        results: dict[str, ProviderResult] = {}
        deadline = min(GLOBAL_CONTEXT_DEADLINE_MS, routes.budget_ms or GLOBAL_CONTEXT_DEADLINE_MS)
        try:
            done, _ = await asyncio.wait(
                tasks.values(),
                timeout=deadline / 1000.0,
            )
            for name, task in tasks.items():
                if task in done and not task.cancelled() and task.exception() is None:
                    results[name] = task.result()
                else:
                    results[name] = ProviderResult(source=name, data=[], stale=True)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Parallel context retrieval exception: %s", exc)

        return results

    async def _fetch_tasks(self, user_id: str) -> ProviderResult:
        """Active-task provider. No task store wired → empty result."""
        start = datetime.now(UTC)
        store = self.task_store
        if store is None or not hasattr(store, "get_active_tasks"):
            return ProviderResult(source="tasks", data=[])
        try:
            tasks = await asyncio.wait_for(store.get_active_tasks(user_id), timeout=0.08)
            elapsed = (datetime.now(UTC) - start).total_seconds() * 1000
            return ProviderResult(source="tasks", data=tasks, timing_ms=elapsed)
        except Exception:
            return ProviderResult(source="tasks", data=[], stale=True)
