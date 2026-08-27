"""Rule-based memory classifier with a keyword fallback.

Labels a raw extracted fact with the memory type the rest of the system needs
(semantic / procedural / relationship). Pure heuristics — no model call — so it
costs nothing and always runs; the LLM extractor's own type tag wins when it is
one of the known tags, otherwise this classifier decides.
"""
from __future__ import annotations

import re
from typing import Any

from src.application.mem.models import MemoryType

# The extractor may already return a concrete tag; if so we trust it.
_KNOWN_TAGS = {
    "preference": MemoryType.SEMANTIC,
    "project": MemoryType.SEMANTIC,
    "fact": MemoryType.SEMANTIC,
    "contact": MemoryType.SEMANTIC,
    "constraint": MemoryType.SEMANTIC,
    "procedure": MemoryType.PROCEDURAL,
    "relationship": MemoryType.RELATIONSHIP,
}

_PROCEDURE_PATTERNS = (
    r"\b(I|the user) (usually |always |typically )?(do|solve|handle|approach|workflow)",
    r"\b(process|workflow|method|habit|routine) (is|starts|involves|uses)",
    r"\bwhen (.{2,40}?) ,? (I|the user) (do|use|check|review)",
    r"\bstep[s]? \d",
)

_RELATIONSHIP_PATTERNS = (
    r"\b(works with|works at|works for|reports to|managed by|manager of)\b",
    r"\b(is married to|is the (?:father|mother|sister|brother|son|daughter|wife|husband|friend|colleague) of)\b",
    r"\b(is the (?:CEO|CTO|CFO|founder|owner|employee|member) of)\b",
    r"\b(related to|connected to|similar to|depends on|part of)\b",
    r"\b(teaches|leads|oversees|mentors|collaborates with)\b",
)

_PREFERENCE_PATTERNS = (
    r"\b(I|the user) (prefer|like|love|enjoy|favor|prefer|would rather)\b",
    r"\b(favorite|preferred|prefers)\b",
    r"\b(style|tone|format|verbosity) of (?:the )?(answers|replies|output)\b",
    r"\b(writes? in|codes? in|uses? mostly)\b",
)


class MemoryClassifier:
    """Classify a fact's memory type using rules, then keyword fallback."""

    @classmethod
    def classify(cls, fact: dict[str, Any]) -> MemoryType:
        """Return the best-guess MemoryType for a raw extracted fact."""
        tag = str(fact.get("type") or "").strip().lower()
        if tag in _KNOWN_TAGS:
            return _KNOWN_TAGS[tag]
        content = str(fact.get("content") or "").lower()

        if any(re.search(p, content, re.IGNORECASE) for p in _PROCEDURE_PATTERNS):
            return MemoryType.PROCEDURAL
        if any(re.search(p, content, re.IGNORECASE) for p in _RELATIONSHIP_PATTERNS):
            return MemoryType.RELATIONSHIP
        if any(re.search(p, content, re.IGNORECASE) for p in _PREFERENCE_PATTERNS):
            return MemoryType.SEMANTIC
        return MemoryType.SEMANTIC

    @classmethod
    def relationship_links(
        cls,
        fact: dict[str, Any],
        fallback_subject: str,
    ) -> list[dict[str, str]]:
        """Normalize the model's relationship output into link dicts.

        Accepts either ``{"subject", "predicate", "object"}`` objects or the
        store-side ``{"target", "rel_type"}`` shape. Never raises: malformed
        links are skipped so one bad row cannot break the write path.
        """
        raw = fact.get("relationships") or fact.get("links") or []
        links: list[dict[str, str]] = []
        if not isinstance(raw, list):
            return links
        for item in raw:
            if not isinstance(item, dict):
                continue
            subject = str(item.get("subject") or fallback_subject or "").strip()
            obj = str(item.get("object") or item.get("target") or "").strip()
            predicate = str(item.get("predicate") or item.get("rel_type") or "RELATED_TO").strip().upper()
            if subject and obj:
                links.append(
                    {
                        "subject": subject,
                        "predicate": predicate or "RELATED_TO",
                        "object": obj,
                    }
                )
        return links
