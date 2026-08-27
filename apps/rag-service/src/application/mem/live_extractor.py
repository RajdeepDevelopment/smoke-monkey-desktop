"""L0 Fast Live Signal Extractor (<10–30ms).

Extracts immediate, deterministic inline signals (explicit fact/preference changes,
live task declarations, explicit corrections) directly from the current user message.

These live observations feed into the turn's ContextSnapshot with highest precedence
so the current LLM turn never responds using stale memory.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import UTC, datetime


@dataclass
class LiveObservation:
    """L0 immediate observation overriding stale background context."""

    type: str  # explicit_fact_change | preference_change | prospective_intent | task_change
    subject: str
    value: str
    confidence: float = 1.0
    stale: bool = False
    timestamp: datetime = field(default_factory=lambda: datetime.now(UTC))


class LiveSignalExtractor:
    """Fast, deterministic regex/heuristic extractor (<10ms runtime)."""

    _PATTERNS = [
        # Explicit tool / search engine / framework change
        (
            re.compile(r"(?:i (?:switched|changed|moved) (?:my|to)|now using)\s+([A-Za-z0-9_\-\s]{2,30})", re.I),
            "explicit_fact_change",
            "technology",
        ),
        # Explicit test / exam / deadline
        (
            re.compile(r"i (?:have|got) a\s+([A-Za-z0-9_\-\s]{2,30})\s+(?:test|exam|deadline|interview|meeting)\s*(tomorrow|next week|today)?", re.I),
            "prospective_intent",
            "upcoming_event",
        ),
        # Explicit preference change
        (
            re.compile(r"i (?:prefer|like|use)\s+([A-Za-z0-9_\-\s]{2,30})\s+instead of\s+([A-Za-z0-9_\-\s]{2,30})", re.I),
            "preference_change",
            "preference",
        ),
    ]

    def extract(self, query: str) -> list[LiveObservation]:
        """Run fast regex patterns to detect critical inline changes."""
        text = (query or "").strip()
        if not text or len(text) < 4:
            return []

        observations: list[LiveObservation] = []
        for pattern, obs_type, subject in self._PATTERNS:
            match = pattern.search(text)
            if match:
                val = match.group(1).strip()
                observations.append(
                    LiveObservation(
                        type=obs_type,
                        subject=subject,
                        value=val,
                        confidence=1.0,
                    )
                )

        return observations
