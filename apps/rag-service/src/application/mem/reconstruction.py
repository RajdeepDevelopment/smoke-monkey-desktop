"""Generic conversational-context reconstruction / reference resolution.

This layer implements the "Context Reconstruction Before Memory Operations"
design: the memory system never interprets a message in isolation for reads or
writes. Before any memory retrieval or extraction the message is examined in
its conversation context, and every short reference (pronouns, nicknames,
demonstratives, confirmations, elliptical continuations) is expanded into the
concrete entity it points at.

Pipeline::

    message
      → ContextClassifier        fast heuristic gate (self-contained?)
      → Prompt A                 context understanding (active topic/entities)
      → Prompt B                 reference resolution (mention → entity)
      → retrieval                uses the decontextualized (rewritten) query
      → Prompt C                 entity resolution (mention → canonical entity)
      → ContextPacket            feeds the system prompt + the write path

Every stage is generic: no phrase-to-meaning rules, no hardcoded names. The
classifier is a pure cost gate — self-contained messages pay ~nothing; only
context-dependent ones run the LLM prompts. All failures degrade to the raw
query so the pipeline never breaks.

The write path uses the same packet so extraction is also context-aware, and a
final reconciliation prompt (Prompt E) compares each candidate fact against the
user's existing memories before anything is stored.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import asdict, dataclass, field
from typing import Any

from src.config import settings
from src.generation.prompts import (
    context_understanding_payload,
    context_understanding_system,
    entity_resolution_payload,
    entity_resolution_system,
    memory_reconcile_payload,
    memory_reconcile_system,
    reference_resolution_payload,
    reference_resolution_system,
)

logger = logging.getLogger(__name__)


# ── JSON parsing helpers (tolerate prose / code fences around the payload) ──


def _extract_json_object(raw: str) -> dict[str, Any] | None:
    raw = (raw or "").strip()
    if not raw:
        return None
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


def _extract_json_array(raw: str) -> list[Any] | None:
    raw = (raw or "").strip()
    if not raw:
        return None
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.IGNORECASE | re.DOTALL)
    start = raw.find("[")
    end = raw.rfind("]")
    if start == -1 or end <= start:
        return None
    try:
        return json.loads(raw[start : end + 1])
    except json.JSONDecodeError:
        return None


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return min(max(float(value), 0.0), 1.0)
    except (TypeError, ValueError):
        return default


# ── Conversation state (spec: short-lived per-conversation context) ─────────


@dataclass
class ConversationState:
    """What is currently active in the conversation, carried between turns."""

    active_entities: list[str] = field(default_factory=list)
    active_topic: str | None = None
    active_event: str | None = None
    recent_references: list[str] = field(default_factory=list)
    unresolved_references: list[str] = field(default_factory=list)
    pending_questions: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> ConversationState:
        data = data or {}
        return cls(
            active_entities=list(data.get("active_entities") or []),
            active_topic=data.get("active_topic"),
            active_event=data.get("active_event"),
            recent_references=list(data.get("recent_references") or []),
            unresolved_references=list(data.get("unresolved_references") or []),
            pending_questions=list(data.get("pending_questions") or []),
        )


class ConversationStateStore:
    """Redis-backed short-lived conversation state (per user + conversation)."""

    _PREFIX = "rag:ctxstate:v1"

    def __init__(self, redis, ttl_s: int | None = None) -> None:
        self.redis = redis
        self.ttl_s = ttl_s if ttl_s is not None else settings.memory_context_state_ttl_s

    def _key(self, user_id: str, conversation_id: str | None) -> str:
        return f"{self._PREFIX}:{user_id}:{conversation_id or '_'}"

    async def get(self, user_id: str, conversation_id: str | None) -> ConversationState | None:
        if self.redis is None or not user_id:
            return None
        try:
            raw = await self.redis.get(self._key(user_id, conversation_id))
            if not raw:
                return None
            data = json.loads(raw)
            return ConversationState.from_dict(data)
        except Exception as exc:  # noqa: BLE001 - state is best-effort
            logger.debug("conversation state load failed: %s", exc)
            return None

    async def set(self, user_id: str, conversation_id: str | None, state: ConversationState) -> None:
        if self.redis is None or not user_id:
            return
        try:
            await self.redis.set(
                self._key(user_id, conversation_id),
                json.dumps(state.to_dict()),
                ex=self.ttl_s,
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("conversation state save failed: %s", exc)


# ── Context classifier (the fast, LLM-free gate) ────────────────────────────

# Generic linguistic signals that a message leans on earlier context. Kept
# deliberately pattern-based and entity-agnostic: this only decides *whether*
# to spend an LLM call on reconstruction, never *what* anything means.
_PRONOUN_RE = re.compile(
    r"\b(he|she|him|her|his|hers|they|them|their|theirs|it|its|this|that|these|those)\b",
    re.IGNORECASE,
)
_CONFIRMATION_RE = re.compile(
    r"^(yes|yeah|yep|yup|exactly|correct|right|sure|of course|that'?s right|"
    r"no,? i (mean|meant)|i agree|agreed)\b",
    re.IGNORECASE,
)
_ELLIPTICAL_RE = re.compile(
    r"^(and|but|so|also|then|what about|how about|about|tell me more|go on|"
    r"what else|and the (first|second|next) one)\b",
    re.IGNORECASE,
)
_DEFINITE_REFERENCE_RE = re.compile(
    r"\bthe (manager|project|plan|idea|person|guy|one|thing|issue|problem|"
    r"decision|meeting|call|email|message|document|feature|bug|client|customer|"
    r"team|company|part|version|report|conversation)\b",
    re.IGNORECASE,
)
_PRIOR_CONTEXT_RE = re.compile(
    r"\b(as i said|as discussed|like i said|you (said|mentioned|told me)|"
    r"we (discussed|talked about|covered|went over)|earlier (you|we)|"
    r"previously|before that|we agreed|you said)\b",
    re.IGNORECASE,
)


class ContextClassifier:
    """Cheap heuristic gate: is this message context-dependent?

    Returns ``(context_dependent, signals)``. ``context_dependent`` messages
    are routed through the LLM reconstruction prompts; self-contained ones skip
    the whole layer (~zero cost). This is the spec's dynamic-routing gate: the
    classifier is deliberately generic and rule-based, resolution is the LLM's
    job.
    """

    def __init__(self) -> None:
        self._signals: tuple[tuple[str, re.Pattern[str]], ...] = (
            ("pronoun", _PRONOUN_RE),
            ("confirmation", _CONFIRMATION_RE),
            ("elliptical", _ELLIPTICAL_RE),
            ("definite_reference", _DEFINITE_REFERENCE_RE),
            ("prior_context", _PRIOR_CONTEXT_RE),
        )

    def classify(self, query: str, history: list[dict[str, str]] | None = None) -> tuple[bool, list[str]]:
        query = (query or "").strip()
        if not query:
            return False, []
        matched: list[str] = []
        for name, pattern in self._signals:
            if pattern.search(query):
                matched.append(name)
        # A message cannot lean on prior turns that do not exist.
        if not history:
            return False, []
        return bool(matched), matched


# ── The context packet (spec: what retrieval + generation receive) ──────────


@dataclass
class ResolvedReference:
    """One short reference expanded to a concrete entity."""

    mention: str
    resolved: str
    confidence: float
    reason: str = ""


@dataclass
class ContextPacket:
    """Reconstructed context for one message, ready for retrieval + the prompt.

    Holds everything the reconstruction layer produced: whether the message was
    context-dependent, the decontextualized query used for retrieval, the
    entities/topic currently in play, and the resolved short references (with
    confidence and supporting evidence). This is the spec's ContextPacket.
    """

    current_message: str
    context_dependent: bool = False
    resolved_query: str = ""
    active_entities: list[str] = field(default_factory=list)
    active_topic: str | None = None
    resolved_references: list[ResolvedReference] = field(default_factory=list)
    relevant_existing_memories: list[str] = field(default_factory=list)
    known_relationships: list[str] = field(default_factory=list)
    recent_events: list[str] = field(default_factory=list)
    conversation_state: dict[str, Any] = field(default_factory=dict)
    user_context: dict[str, Any] = field(default_factory=dict)
    ambiguities: list[str] = field(default_factory=list)
    canonical_entities: dict[str, str] = field(default_factory=dict)

    def to_prompt_lines(self) -> list[str]:
        """Prompt-ready lines for the <resolved_context> block.

        The generation prompt receives what the user's short references mean,
        so the model never has to guess. Only high-confidence, actually-resolved
        references are rendered; unresolved ones are reported as ambiguity
        instead of being silently dropped.
        """
        lines: list[str] = []
        min_conf = settings.memory_context_min_confidence
        for ref in self.resolved_references:
            canonical = self.canonical_entities.get(ref.mention, ref.resolved)
            if ref.confidence >= min_conf and canonical:
                lines.append(f"{ref.mention} → {canonical}")
        for entity in self.active_entities:
            if entity and not any(entity in line for line in lines):
                lines.append(f"active entity: {entity}")
        if self.active_topic:
            lines.append(f"active topic: {self.active_topic}")
        if self.ambiguities:
            lines.append("ambiguous references: " + "; ".join(self.ambiguities))
        return lines

    def to_state(self) -> ConversationState:
        resolved = [r.resolved for r in self.resolved_references if r.resolved]
        unresolved = [
            r.mention
            for r in self.resolved_references
            if r.confidence < settings.memory_context_min_confidence or not r.resolved
        ]
        return ConversationState(
            active_entities=self.active_entities,
            active_topic=self.active_topic,
            active_event=None,
            recent_references=resolved,
            unresolved_references=unresolved + self.ambiguities,
            pending_questions=[],
        )


# ── The reconstructor (Prompts A, B, C) ─────────────────────────────────────


class ContextReconstructor:
    """Resolves a message against its conversation context (Prompts A/B/C).

    The three prompts are run only when the classifier gate says the message is
    context-dependent. Every LLM call is wrapped so any failure degrades to the
    raw query and leaves retrieval exactly as it was before this layer existed.
    """

    def __init__(self, classifier: ContextClassifier | None = None) -> None:
        self.classifier = classifier or ContextClassifier()

    async def _complete(self, llm, system: str, payload: str, *, chat_key: str | None, max_tokens: int) -> str:
        return await llm.complete(
            system + "\n\n" + payload,
            temperature=0.0,
            max_tokens=max_tokens,
            api_key=chat_key,
        )

    async def reconstruct(
        self,
        *,
        llm,
        query: str,
        history: list[dict[str, str]] | None = None,
        state: ConversationState | None = None,
        chat_key: str | None = None,
    ) -> ContextPacket:
        """Run Prompt A (context understanding) + Prompt B (reference resolution).

        Returns a ``ContextPacket`` whose ``resolved_query`` is the
        decontextualized rewrite of the message (or the raw message when the
        message was self-contained or reconstruction failed).
        """
        history = history or []
        packet = ContextPacket(
            current_message=query,
            context_dependent=False,
            resolved_query=query,
        )
        try:
            understanding = await self._complete(
                llm,
                context_understanding_system(),
                context_understanding_payload(query, history, state.to_dict() if state else None),
                chat_key=chat_key,
                max_tokens=500,
            )
            parsed = _extract_json_object(understanding)
        except Exception as exc:  # noqa: BLE001
            logger.debug("context understanding (Prompt A) failed: %s", exc)
            return packet
        if not parsed:
            return packet

        self_contained = bool(parsed.get("self_contained", True))
        packet.context_dependent = not self_contained
        packet.active_topic = parsed.get("active_topic") or None
        packet.active_entities = [e for e in (parsed.get("active_entities") or []) if isinstance(e, str)]
        packet.ambiguities = [a for a in (parsed.get("ambiguities") or []) if isinstance(a, str)]
        references = [
            str(r.get("mention")).strip()
            for r in (parsed.get("references") or [])
            if isinstance(r, dict) and r.get("mention")
        ]
        references = [r for r in references if r]

        rewritten = (parsed.get("rewritten_query") or "").strip()
        if packet.context_dependent and rewritten:
            packet.resolved_query = rewritten
        else:
            packet.resolved_query = query

        if references:
            packet = await self._resolve_references(
                llm, packet, query, history, references, chat_key
            )
        return packet

    async def _resolve_references(
        self,
        llm,
        packet: ContextPacket,
        query: str,
        history: list[dict[str, str]],
        references: list[str],
        chat_key: str | None,
    ) -> ContextPacket:
        """Prompt B: expand each short reference to a concrete entity."""
        try:
            raw = await self._complete(
                llm,
                reference_resolution_system(),
                reference_resolution_payload(query, history, references),
                chat_key=chat_key,
                max_tokens=500,
            )
            parsed = _extract_json_array(raw)
        except Exception as exc:  # noqa: BLE001
            logger.debug("reference resolution (Prompt B) failed: %s", exc)
            return packet
        if not parsed:
            return packet
        resolved: list[ResolvedReference] = []
        for item in parsed:
            if not isinstance(item, dict) or not item.get("mention"):
                continue
            target = str(item.get("resolved") or "").strip()
            if not target:
                packet.ambiguities.append(f"{item.get('mention')} (unresolved)")
                continue
            resolved.append(
                ResolvedReference(
                    mention=str(item["mention"]).strip(),
                    resolved=target,
                    confidence=_safe_float(item.get("confidence"), 0.5),
                    reason=str(item.get("reason") or "").strip(),
                )
            )
        packet.resolved_references = resolved
        return packet

    async def resolve_entities(
        self,
        *,
        llm,
        packet: ContextPacket,
        existing_memories: list[str] | None = None,
        chat_key: str | None = None,
    ) -> ContextPacket:
        """Prompt C: fold resolved references into canonical entities.

        ``existing_memories`` are the user's previously stored facts, so a
        mention is mapped onto the canonical entity already known instead of
        being treated as a brand-new one. Failure leaves the packet untouched.
        """
        if not packet.resolved_references:
            return packet
        try:
            raw = await self._complete(
                llm,
                entity_resolution_system(),
                entity_resolution_payload(
                    [asdict(r) for r in packet.resolved_references],
                    existing_memories or [],
                ),
                chat_key=chat_key,
                max_tokens=300,
            )
            parsed = _extract_json_object(raw)
        except Exception as exc:  # noqa: BLE001
            logger.debug("entity resolution (Prompt C) failed: %s", exc)
            return packet
        if parsed:
            for mention, canonical in parsed.items():
                if isinstance(canonical, str) and canonical.strip():
                    packet.canonical_entities[str(mention)] = canonical.strip()
        return packet


# ── Reconciliation (Prompt E: how a candidate relates to existing memories) ──

_RECONCILE_ACTIONS = {
    "new", "duplicate", "update", "supersede",
    "contradiction", "correction", "temporary", "irrelevant",
}


class MemoryReconciler:
    """Compares a candidate memory against existing memories (Prompt E).

    The write path asks this before storing: the decision determines whether the
    candidate is stored fresh, merged into an existing memory, skips as a
    duplicate/transient, supersedes an outdated fact, or is kept alongside a
    contradictory one. Failure defaults to "new" so memory is never lost.
    """

    async def reconcile(
        self,
        *,
        llm,
        candidate: dict[str, Any],
        existing: list[dict[str, Any]],
        chat_key: str | None = None,
    ) -> dict[str, Any]:
        try:
            raw = await self._complete(
                llm,
                memory_reconcile_system(),
                memory_reconcile_payload(candidate, existing),
                chat_key=chat_key,
            )
            parsed = _extract_json_object(raw)
        except Exception as exc:  # noqa: BLE001
            logger.debug("memory reconcile (Prompt E) failed: %s", exc)
            return {"action": "new", "target_id": None, "reason": "reconcile failed", "confidence": 0.0}
        if not parsed:
            return {"action": "new", "target_id": None, "reason": "reconcile unparseable", "confidence": 0.0}
        action = str(parsed.get("action") or "new").strip().lower()
        if action not in _RECONCILE_ACTIONS:
            action = "new"
        target_id = parsed.get("target_id")
        return {
            "action": action,
            "target_id": str(target_id) if target_id else None,
            "reason": str(parsed.get("reason") or "").strip(),
            "confidence": _safe_float(parsed.get("confidence"), 0.5),
        }

    async def _complete(self, llm, system: str, payload: str, *, chat_key: str | None) -> str:
        return await llm.complete(
            system + "\n\n" + payload,
            temperature=0.0,
            max_tokens=300,
            api_key=chat_key,
        )
