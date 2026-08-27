"""Unit tests for the query router and its prompt."""

from src.application.router import (
    _extract_json_object,
    _fallback_plan,
    _normalize_plan,
    has_personal_signal,
)
from src.domain import RetrievedChunk
from src.generation.prompts import build_system_prompt, router_prompt


def test_extract_json_object_handles_fences_and_prose():
    raw = 'Here is the answer:\n```json\n{"intent": "memory", "needs_memory": true}\n```'
    assert _extract_json_object(raw) == {"intent": "memory", "needs_memory": True}


def test_extract_json_object_none_when_missing():
    assert _extract_json_object("no json here") is None


def test_normalize_general_disables_all_retrieval():
    plan = _normalize_plan({"intent": "general"}, "what is the capital of france?", [])
    assert plan.needs_knowledge is False
    assert plan.needs_memory is False
    assert plan.needs_web is False


def test_normalize_personal_question_upgrades_memory():
    plan = _normalize_plan({"intent": "knowledge"}, "how should I optimize my RAG?", [])
    assert plan.needs_knowledge is True
    assert plan.needs_memory is True


def test_normalize_memory_intent():
    plan = _normalize_plan({"intent": "memory"}, "what did we decide about OpenSearch?", [])
    assert plan.needs_memory is True
    assert plan.needs_knowledge is False


def test_normalize_web_intent():
    plan = _normalize_plan({"intent": "web"}, "what is the latest postgres release?", [])
    assert plan.needs_web is True
    assert plan.needs_knowledge is False


def test_normalize_unknown_intent_falls_back_to_knowledge():
    plan = _normalize_plan({"intent": "banana"}, "tell me about X", [])
    assert plan.intent == "knowledge"
    assert plan.needs_knowledge is True


def test_personal_signal_detects_self_reference():
    assert has_personal_signal("what is my embedding dim?", []) is True
    assert has_personal_signal("what is cosine similarity?", []) is False


def test_fallback_plan_upgrades_personal_questions():
    assert _fallback_plan("what is my setup?", []).needs_memory is True
    assert _fallback_plan("what is a vector index?", []).needs_memory is False


def test_router_prompt_requests_json():
    prompt = router_prompt("what did we decide?", [{"role": "user", "content": "hi"}])
    assert "needs_knowledge" in prompt
    assert "needs_memory" in prompt
    assert "JSON" in prompt


def test_system_prompt_has_blocks_only_when_present():
    chunk = RetrievedChunk(
        id="1",
        document_id="d1",
        document_name="guide.pdf",
        content="pgvector stores vectors.",
    )
    text = build_system_prompt(
        [chunk],
        conversation_memory=["user prefers postgres"],
        user_memory=["user is building a RAG app"],
        intent="hybrid",
    )
    assert "<knowledge>" in text
    assert "<conversation_memory>" in text
    assert "<user_memory>" in text
    # The assistant must never describe the mechanics of how it knows things.
    assert "Retrieval-Augmented" not in text
    assert "retrieved context" not in text.lower()
    assert "your documents" not in text.lower()


def test_system_prompt_general_has_no_blocks():
    text = build_system_prompt([], intent="general")
    # The static persona mentions the available sources, but no actual block
    # section is rendered when nothing was retrieved for a general question.
    assert "<knowledge>\n" not in text
    assert "<conversation_memory>\n" not in text
    assert "general question" in text


def test_system_prompt_general_prioritises_memory_when_present():
    text = build_system_prompt(
        [],
        user_memory=["Your wife's name is Chandrima Banerjee"],
        intent="general",
    )
    assert "<user_memory>" in text
    # The model must prefer the user's personal context over world knowledge
    # when the question names a person/topic it remembers.
    assert "takes priority over general world knowledge" in text
    assert "general question. Answer it from your own knowledge" not in text
