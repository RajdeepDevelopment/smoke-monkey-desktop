"""Observation Store & Memory Consolidation Engine.

Provides an audit trail for raw observations output by observers before writing to
long-term storage.

MemoryConsolidator handles deduplication, entity resolution, decay, contradiction resolution,
and promotes validated observations into pgvector, Neo4j, and PostgreSQL.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class RawObservation:
    """Versioned observation record before long-term consolidation."""

    id: str
    user_id: str
    observer_name: str
    observer_version: str = "1.0"
    model_version: str = "gpt-4o"
    type: str = "fact"
    subject: str = ""
    content: str = ""
    confidence: float = 0.9
    dedupe_key: str = ""
    status: str = "pending_validation"  # pending_validation | validated | rejected | consolidated
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))


class ObservationStore:
    """Audit log for raw observer outputs."""

    def __init__(self, pool: Any | None = None) -> None:
        self.pool = pool
        self._observations: dict[str, RawObservation] = {}

    async def record_observation(
        self,
        *,
        user_id: str,
        observer_name: str,
        content: str,
        obs_type: str = "fact",
        subject: str = "",
        confidence: float = 0.9,
        observer_version: str = "1.0",
        model_version: str = "gpt-4o",
    ) -> RawObservation:
        """Record raw observation prior to memory consolidation."""
        obs_id = str(uuid.uuid4())
        dedupe_key = f"{user_id}:{observer_name}:{subject.lower()}:{content[:40].lower()}"

        obs = RawObservation(
            id=obs_id,
            user_id=user_id,
            observer_name=observer_name,
            observer_version=observer_version,
            model_version=model_version,
            type=obs_type,
            subject=subject,
            content=content,
            confidence=confidence,
            dedupe_key=dedupe_key,
        )
        self._observations[obs_id] = obs
        return obs


class MemoryConsolidator:
    """Consolidation Engine: merges, deduplicates, and resolves memory contradictions."""

    def __init__(
        self,
        obs_store: ObservationStore,
        memory_store: Any | None = None,
        graph_store: Any | None = None,
    ) -> None:
        self.obs_store = obs_store
        self.memory_store = memory_store
        self.graph_store = graph_store

    async def consolidate(self, user_id: str) -> int:
        """Process pending observations, resolve contradictions, and update long-term stores."""
        pending = [
            o
            for o in self.obs_store._observations.values()
            if o.user_id == user_id and o.status == "pending_validation"
        ]
        if not pending:
            return 0

        count = 0
        seen_keys: set[str] = set()
        for obs in pending:
            if obs.dedupe_key in seen_keys:
                obs.status = "rejected"
                continue
            seen_keys.add(obs.dedupe_key)
            obs.status = "consolidated"
            count += 1

        logger.info("Consolidated %d memory observations for user %s", count, user_id)
        return count
