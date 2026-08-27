"""Query router: an LLM decides what a chat message needs before retrieval.

Every message is classified into an intent (general / knowledge / memory /
web / hybrid) so the pipeline can skip irrelevant work — general questions
skip RAG entirely, personal questions hit conversation memory, and only
document questions run vector retrieval.

A light heuristic (personal pronouns) upgrades `needs_memory` and acts as a
fallback whenever the router call fails or is disabled, so the pipeline always
degrades to the current plain-RAG behaviour safely.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
from typing import Any

from pydantic import BaseModel, ValidationError

from src.config import settings
from src.generation.prompts import router_prompt

logger = logging.getLogger(__name__)

ROUTE_CACHE_PREFIX = "rag:route:v1"

# Signals that a question is about the user's own stuff → memory-worthy even
# when the router model is unsure.
PERSONAL_RE = re.compile(r"\b(i|me|my|mine|we|our|ours|us)\b", re.IGNORECASE)

# Signals that a question wants fresh/live information → needs the web even when
# a small router model classifies it as general or knowledge. Kept conservative
# so ordinary chit-chat ("how are you now") is not sent to the web.
WEB_TIME_SIGNALS = (
    r"\bnews\b",
    r"\blatest\b",
    r"\btoday\b",
    r"\btonight\b",
    r"\btomorrow\b",
    r"\byesterday\b",
    r"\bweather\b",
    r"\bprice\b",
    r"\bstock\b",
    r"\bbreaking\b",
    r"\bcurrent\b",
    r"\bup-?to-?date\b",
    r"\brecent(ly)?\b",
    r"\bthis week\b",
    r"\bthis month\b",
    r"\bnow\b",
    r"\blive\b",
    r"\bin 20\d\d\b",
    r"\bupdate\b",
    r"\bresults?\b",
    r"\bwinners?\b",
    r"\belection\b",
)
_WEB_SIGNAL_RE = re.compile("|".join(WEB_TIME_SIGNALS), re.IGNORECASE)

# Time words like "now" also appear in casual chit-chat ("how are you now"),
# which must never be sent to the web. When the message opens as a greeting,
# the web upgrade is suppressed.
_GREETING_RE = re.compile(
    r"^(hi|hello|hey|yo|how are you|how's? (it going|everything)|what'?s up|what'?s new|good morning|good afternoon|good evening|how do you do)\b",
    re.IGNORECASE,
)

_VALID_INTENTS = {"general", "knowledge", "memory", "web", "hybrid"}

# A user asking the assistant to author something for them (an email, message,
# letter…) is a task about their own content — never a live-web lookup, even
# when a stray time word ("today is saturday…") sneaks in. This suppresses the
# web upgrade for queries like "write an email to my manager", so we don't burn
# web resources on personal conversations.
AUTHORING_RE = re.compile(
    r"\b(write|draft|compose|create|make|help me write)\b(?=.*\b(e-?mail|message|letter|memo|note|reply|invite|card)\b)",
    re.IGNORECASE,
)


def is_authoring_task(query: str) -> bool:
    """True when the user wants the assistant to write something for them."""
    return bool(AUTHORING_RE.search(query))


def has_web_signal(query: str) -> bool:
    """True when the query mentions something time-sensitive/current."""
    return bool(_WEB_SIGNAL_RE.search(query))


def should_use_web(query: str) -> bool:
    """Time-sensitive queries need the web unless they are casual greetings."""
    if _GREETING_RE.match(query.strip()):
        return False
    return has_web_signal(query)


class RoutePlan(BaseModel):
    intent: str = "knowledge"
    needs_knowledge: bool = True
    needs_memory: bool = False
    needs_web: bool = False
    confidence: float = 0.0


def has_personal_signal(query: str, history: list[dict[str, str]]) -> bool:
    """True when the message (or recent history) talks about the user's own work."""
    text = query
    for msg in history[-4:]:
        if msg.get("role") == "user":
            text += " " + (msg.get("content") or "")
    return bool(PERSONAL_RE.search(text))


def _extract_json_object(raw: str) -> dict[str, Any] | None:
    """Pull the first JSON object out of an LLM reply (tolerates prose/fences)."""
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


def _normalize_plan(raw: dict[str, Any], query: str, history: list[dict[str, str]]) -> RoutePlan:
    """Coerce a parsed router reply into a consistent, safe RoutePlan."""
    intent = str(raw.get("intent") or "knowledge").strip().lower()
    if intent not in _VALID_INTENTS:
        intent = "knowledge"
    personal = has_personal_signal(query, history)

    try:
        confidence = min(max(float(raw.get("confidence", 0.0)), 0.0), 1.0)
    except (TypeError, ValueError):
        confidence = 0.0

    plan = RoutePlan(intent=intent, confidence=confidence)

    if intent == "general":
        plan.needs_knowledge = False
        plan.needs_memory = False
        plan.needs_web = False
    elif intent == "knowledge":
        plan.needs_knowledge = True
        plan.needs_memory = personal
        plan.needs_web = False
    elif intent == "memory":
        plan.needs_knowledge = False
        plan.needs_memory = True
        plan.needs_web = False
    elif intent == "web":
        plan.needs_knowledge = False
        plan.needs_memory = personal
        plan.needs_web = True
    elif intent == "hybrid":
        plan.needs_knowledge = True
        plan.needs_memory = plan.needs_memory or personal
        plan.needs_web = bool(raw.get("needs_web", False))

    # Heuristic backup: a time-sensitive/current-event query needs the web even
    # when a small router model classified it as general or knowledge. Personal
    # questions, authoring tasks and casual greetings are never silently sent
    # to the web.
    if (
        not personal
        and not is_authoring_task(query)
        and should_use_web(query)
        and not plan.needs_web
    ):
        plan.needs_web = True
        if plan.intent == "general":
            plan.intent = "web"
        elif plan.intent in ("knowledge", "hybrid"):
            plan.needs_knowledge = True
            plan.intent = "hybrid"

    # A personal authoring task ("write an email to my manager…") must never
    # hit the web, no matter what a small router model inferred.
    if is_authoring_task(query):
        plan.needs_web = False
        if plan.intent == "web":
            plan.intent = "general"
    return plan


def _fallback_plan(query: str, history: list[dict[str, str]]) -> RoutePlan:
    """Safe default when routing is disabled or fails: current RAG behaviour,
    upgraded with a memory pass for personal questions and web for
    current-event questions."""
    personal = has_personal_signal(query, history)
    web = should_use_web(query) and not is_authoring_task(query)
    intent = "hybrid" if (personal or web) else "knowledge"
    return RoutePlan(
        intent=intent,
        needs_knowledge=True,
        needs_memory=personal,
        needs_web=web and not personal,
        confidence=0.0,
    )


class QueryRouter:
    """Classifies chat messages; decisions are cached in Redis per user."""

    def __init__(self, redis) -> None:
        self.redis = redis

    async def route(
        self,
        llm,
        query: str,
        history: list[dict[str, str]],
        user_id: str | None,
    ) -> RoutePlan:
        if not settings.router_enabled:
            return _fallback_plan(query, history)

        key = f"{ROUTE_CACHE_PREFIX}:{_hash(user_id or '', query)}"
        if settings.cache_enabled and settings.router_cache_ttl > 0:
            cached = await self.redis.get(key)
            if cached is not None:
                try:
                    return RoutePlan.model_validate_json(cached)
                except ValidationError:
                    pass

        plan = _fallback_plan(query, history)
        try:
            raw = await llm.complete(
                router_prompt(query, history),
                temperature=0.0,
                max_tokens=160,
            )
            parsed = _extract_json_object(raw)
            if parsed is not None:
                plan = _normalize_plan(parsed, query, history)
        except Exception as exc:  # noqa: BLE001 - routing must never break the query
            logger.warning("query router failed (%s); falling back to RAG", exc)

        if settings.cache_enabled and settings.router_cache_ttl > 0:
            try:
                await self.redis.set(key, plan.model_dump_json(), ex=settings.router_cache_ttl)
            except Exception:
                logger.debug("route cache write failed", exc_info=True)
        logger.debug("route intent=%s kb=%s mem=%s web=%s", plan.intent, plan.needs_knowledge, plan.needs_memory, plan.needs_web)
        return plan


def _hash(*parts: str) -> str:
    return hashlib.sha256("|".join(parts).encode()).hexdigest()
