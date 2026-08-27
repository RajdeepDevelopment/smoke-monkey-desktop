"""Personalization planner: decides BEFORE generation whether a request should
be answered from the user's known context, what that context is, and what is
still missing.

The core invariant: never answer generically first and personalize later.
Instead the pipeline runs this planner ahead of memory retrieval, expands the
retrieval into the required context fields, and hands the final LLM a compact
snapshot of what is KNOWN / UNKNOWN / LOW_CONFIDENCE so it can personalise by
default and only ask for the minimum genuinely missing information.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from src.config import settings

logger = logging.getLogger(__name__)

PERSONAL_RE = re.compile(r"\b(i|me|my|mine|we|our|ours|us)\b", re.IGNORECASE)

CACHE_PREFIX = "rag:personalization:v1"

_LEVEL_ALIASES = {
    "none": "none",
    "n/a": "none",
    "no": "none",
    "generic": "none",
    "low": "low",
    "slight": "low",
    "optional": "low",
    "medium": "medium",
    "moderate": "medium",
    "some": "medium",
    "high": "high",
    "strong": "high",
    "important": "high",
    "critical": "critical",
    "essential": "critical",
    "must": "critical",
}

_VALID_LEVELS = {"none", "low", "medium", "high", "critical"}


class PersonalizationLevel(StrEnum):
    NONE = "none"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class ContextStatus(StrEnum):
    KNOWN = "known"
    UNKNOWN = "unknown"
    STALE = "stale"
    CONFLICTING = "conflicting"
    LOW_CONFIDENCE = "low_confidence"


@dataclass
class PersonalizationPlan:
    """What the LLM analysis decided the request needs."""

    level: PersonalizationLevel = PersonalizationLevel.NONE
    required_context: list[str] = field(default_factory=list)
    should_ask_user: bool = False
    reasoning: str = ""

    @property
    def is_active(self) -> bool:
        return self.level is not PersonalizationLevel.NONE


@dataclass
class ContextField:
    """One required-context slot and what the memory layer found for it."""

    field: str
    status: ContextStatus
    value: str = ""
    confidence: float = 0.0
    source: str = ""


@dataclass
class ContextSnapshot:
    """Compact snapshot handed to the final LLM (section 5)."""

    level: PersonalizationLevel
    fields: list[ContextField] = field(default_factory=list)

    @property
    def known(self) -> list[ContextField]:
        return [f for f in self.fields if f.status is ContextStatus.KNOWN]

    @property
    def missing(self) -> list[ContextField]:
        return [f for f in self.fields if f.status is not ContextStatus.KNOWN]

    @property
    def personalization_score(self) -> float:
        if not self.fields:
            return 0.0
        return len(self.known) / len(self.fields)

    def as_prompt_block(self) -> str:
        """Render the snapshot for the generation system prompt (section 14)."""
        if not self.fields:
            return ""
        known_lines = []
        missing_lines = []
        for f in self.fields:
            if f.status is ContextStatus.KNOWN:
                known_lines.append(f"- {f.field}: {f.value}")
            else:
                label = {
                    ContextStatus.UNKNOWN: "unknown",
                    ContextStatus.STALE: "stale",
                    ContextStatus.CONFLICTING: "conflicting",
                    ContextStatus.LOW_CONFIDENCE: "low confidence",
                }[f.status]
                missing_lines.append(f"- {f.field}: {label}")
        parts = [f"<personalization level=\"{self.level.value}\">"]
        parts.append(f"This request depends on the user's own circumstances (level {self.level.value}).")
        parts.append("Known context (use it, do not ask the user to repeat it):")
        parts.append("\n".join(known_lines) if known_lines else "- (none)")
        parts.append("Context that is not reliably known (do not invent it):")
        parts.append("\n".join(missing_lines) if missing_lines else "- (none)")
        parts.append(
            "Personalise by default: build the answer on the known context. "
            "For anything not known, either make a clearly-labelled assumption "
            "or ask for the smallest set of missing details that would "
            "materially change the answer. Never ask for information already "
            "listed as known."
        )
        parts.append("</personalization>")
        return "\n".join(parts)


def _extract_json_object(raw: str) -> dict[str, Any] | None:
    raw = raw.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.IGNORECASE | re.DOTALL)
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        return json.loads(raw[start : end + 1])
    except json.JSONDecodeError:
        return None


def normalize_level(raw: Any) -> PersonalizationLevel:
    key = str(raw or "").strip().lower()
    key = _LEVEL_ALIASES.get(key, key)
    if key not in _VALID_LEVELS:
        return PersonalizationLevel.NONE
    return PersonalizationLevel(key)


class PersonalizationPlanner:
    """Analyse a request, decide personalization need, and build the snapshot.

    The analysis is a lightweight LLM call (section 1). A cheap heuristic
    (personal pronoun) runs first so a generic knowledge question skips the
    LLM entirely; when the LLM is unavailable the heuristic result stands.
    """

    def __init__(self, redis=None) -> None:
        self.redis = redis

    async def analyze(
        self,
        llm,
        query: str,
        history: list[dict[str, str]],
        *,
        resolved_query: str | None = None,
        needs_memory: bool = False,
        user_id: str | None = None,
    ) -> PersonalizationPlan:
        if not settings.personalization_enabled:
            return PersonalizationPlan(level=PersonalizationLevel.NONE)
        text = (resolved_query or query or "")
        personal = needs_memory or bool(PERSONAL_RE.search(text))
        if not personal:
            return PersonalizationPlan(level=PersonalizationLevel.NONE)

        cache_key: str | None = None
        if self.redis is not None and settings.cache_enabled and settings.personalization_cache_ttl > 0:
            import hashlib

            cache_key = (
                f"{CACHE_PREFIX}:{hashlib.sha256(((user_id or '') + '|' + text).encode()).hexdigest()}"
            )
            try:
                cached = await self.redis.get(cache_key)
                if cached is not None:
                    data = json.loads(cached)
                    return PersonalizationPlan(
                        level=PersonalizationLevel(data["level"]),
                        required_context=data.get("required_context", []),
                        should_ask_user=bool(data.get("should_ask_user", False)),
                        reasoning=data.get("reasoning", "cached"),
                    )
            except Exception as exc:  # noqa: BLE001
                logger.debug("personalization cache read failed: %s", exc)

        if llm is None:
            plan = PersonalizationPlan(
                level=PersonalizationLevel.HIGH,
                required_context=[query],
                reasoning="personal query (no LLM available)",
            )
        else:
            try:
                raw = await llm.complete(
                    personalization_prompt(query, history, resolved_query=resolved_query),
                    temperature=0.0,
                    max_tokens=220,
                )
                parsed = _extract_json_object(raw)
                plan = self._normalize(parsed, query) if parsed is not None else None
            except Exception as exc:  # noqa: BLE001 - personalization is best-effort
                logger.debug("personalization analysis failed: %s", exc)
                plan = None
            if plan is None:
                plan = PersonalizationPlan(
                    level=PersonalizationLevel.HIGH,
                    required_context=[query],
                    reasoning="personal query (LLM analysis unavailable)",
                )

        if cache_key is not None:
            try:
                await self.redis.set(
                    cache_key,
                    json.dumps(
                        {
                            "level": plan.level.value,
                            "required_context": plan.required_context,
                            "should_ask_user": plan.should_ask_user,
                            "reasoning": plan.reasoning,
                        }
                    ),
                    ex=settings.personalization_cache_ttl,
                )
            except Exception as exc:  # noqa: BLE001
                logger.debug("personalization cache write failed: %s", exc)
        return plan

    @staticmethod
    def _normalize(parsed: dict[str, Any], query: str) -> PersonalizationPlan:
        level = normalize_level(parsed.get("personalization_level") or parsed.get("level"))
        raw_context = parsed.get("required_context") or parsed.get("context_needed") or []
        required = [
            str(x).strip()
            for x in (raw_context if isinstance(raw_context, list) else [str(raw_context)])
            if str(x).strip()
        ]
        if not required:
            required = [query]
        required = required[: settings.personalization_max_context]
        should_ask = bool(parsed.get("should_ask_user", False))
        return PersonalizationPlan(
            level=level,
            required_context=required,
            should_ask_user=should_ask,
            reasoning=str(parsed.get("reasoning") or "")[:300],
        )

    @staticmethod
    def build_snapshot(
        plan: PersonalizationPlan,
        *,
        known: dict[str, tuple[str, float, str]] | None = None,
        conflicting: list[str] | None = None,
    ) -> ContextSnapshot:
        """Turn a plan + retrieved memory into a ContextSnapshot.

        ``known`` maps each required-context field to (value, confidence,
        source). Fields the plan asked for but that have no reliable memory
        are marked UNKNOWN (section 6). ``conflicting`` lists fields where the
        memory layer surfaced contradictory facts — flagged so the LLM resolves
        them instead of trusting whichever was retrieved first (section 13).
        """
        fields: list[ContextField] = []
        known = known or {}
        conflicting = set(conflicting or [])
        for req in plan.required_context:
            if req in conflicting:
                fields.append(ContextField(req, ContextStatus.CONFLICTING))
                continue
            hit = known.get(req)
            if hit is None:
                fields.append(ContextField(req, ContextStatus.UNKNOWN))
                continue
            value, confidence, source = hit
            if confidence < settings.personalization_known_min_score:
                fields.append(
                    ContextField(req, ContextStatus.LOW_CONFIDENCE, value, confidence, source)
                )
            else:
                fields.append(ContextField(req, ContextStatus.KNOWN, value, confidence, source))
        return ContextSnapshot(level=plan.level, fields=fields)


def personalization_prompt(
    query: str,
    history: list[dict[str, str]],
    *,
    resolved_query: str | None = None,
) -> str:
    """Section 1/2/10: semantic personalization analysis (domain-independent)."""
    history_lines = []
    for msg in history[-6:]:
        role = "User" if msg.get("role") == "user" else "Assistant"
        content = (msg.get("content") or "").strip().replace("\n", " ")
        if content:
            history_lines.append(f"{role}: {content[:300]}")
    history_txt = "\n".join(history_lines) if history_lines else "(none)"
    effective = resolved_query or query
    return f"""Decide whether answering this request should use the user's personal
circumstances, and which pieces of user context are needed. This is semantic
analysis — do NOT look for keywords. A request like "make a budget for us"
needs income, spouse income, monthly expenses, rent, loans and savings goals
even though none of those words appear.

Message: {query}
Resolved meaning: {effective}

Recent history:
{history_txt}

Respond with ONLY a JSON object, no markdown:
{{
  "personalization_level": "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
  "required_context": ["short field names of the user-specific facts needed"],
  "should_ask_user": false,
  "reasoning": "one short sentence"
}}

Rules:
- NONE: purely informational question (e.g. "what is Redis?").
- LOW/MEDIUM: personalization could improve the answer but is not essential.
- HIGH: the answer should be strongly based on the user's known circumstances.
- CRITICAL: missing information could materially change the answer.
- required_context: the minimal set of user-specific fields the answer depends
  on, phrased as reusable field names (e.g. "household income", "monthly
  expenses", "dependents", "career goals", "location"). No more than 6.
- should_ask_user: true only when the request clearly needs personal data that
  might be missing and guessing would materially change the answer.
"""
