"""Tests for the generic conversational-context reconstruction layer.

Covers the four specialised prompts (A context understanding, B reference
resolution, C entity resolution, E memory reconciliation), the heuristic
classifier gate (dynamic routing), the conversation state store, and the
planner's use of the decontextualized query / entity anchors.
"""
import json

from src.application.mem.planner import RetrievalPlanner
from src.application.mem.reconstruction import (
    ContextClassifier,
    ContextPacket,
    ContextReconstructor,
    ConversationState,
    ConversationStateStore,
    MemoryReconciler,
    ResolvedReference,
)
from src.generation.prompts import (
    build_system_prompt,
    context_understanding_system,
    memory_extract_payload,
    memory_reconcile_system,
    reference_resolution_system,
)


class _FakeLLM:
    provider_id = "ollama"

    def __init__(self, reply: str) -> None:
        self._reply = reply
        self.prompts: list[str] = []

    async def complete(self, prompt: str, **kwargs) -> str:
        self.prompts.append(prompt)
        return self._reply


# ── ContextClassifier (the heuristic gate) ──────────────────────────────────


def test_classifier_flags_pronoun_and_confirmations():
    c = ContextClassifier()
    hist = [{"role": "user", "content": "my manager is Ramakrishan"}]
    dependent, signals = c.classify("and him?", hist)
    assert dependent is True
    assert "pronoun" in signals

    dependent, signals = c.classify("yes", hist)
    assert dependent is True
    assert "confirmation" in signals


def test_classifier_flags_definite_and_prior_references():
    c = ContextClassifier()
    hist = [{"role": "assistant", "content": "we discussed the rollout"}]
    dependent, signals = c.classify("what about the project?", hist)
    assert dependent is True
    assert "definite_reference" in signals

    dependent, _ = c.classify("as we discussed, let's move on", hist)
    assert dependent is True


def test_classifier_self_contained_messages_are_cheap():
    c = ContextClassifier()
    hist = [{"role": "user", "content": "my manager is Ramakrishan"}]
    dependent, signals = c.classify("What is the capital of France?", hist)
    assert dependent is False
    assert signals == []


def test_classifier_requires_history_to_flag():
    c = ContextClassifier()
    # With no prior turns there is nothing to reference — self-contained even
    # though it contains a pronoun.
    dependent, _ = c.classify("tell me about him", [])
    assert dependent is False


# ── ContextReconstructor (Prompt A + B) ─────────────────────────────────────


async def test_reconstruct_decontextualizes_context_dependent_message():
    llm = _FakeLLM(
        json.dumps(
            {
                "self_contained": False,
                "active_topic": "Project Atlas rollout",
                "active_entities": ["Project Atlas", "Ramakrishan"],
                "references": [{"mention": "him"}],
                "rewritten_query": "When is the Project Atlas rollout due?",
                "ambiguities": [],
            }
        )
    )
    recon = ContextReconstructor()
    packet = await recon.reconstruct(
        llm=llm,
        query="when is it due?",
        history=[{"role": "user", "content": "we are rolling out Project Atlas"}],
    )
    assert packet.context_dependent is True
    assert packet.resolved_query == "When is the Project Atlas rollout due?"
    assert packet.active_entities == ["Project Atlas", "Ramakrishan"]
    assert packet.active_topic == "Project Atlas rollout"


async def test_reconstruct_keeps_self_contained_query():
    llm = _FakeLLM(
        json.dumps(
            {
                "self_contained": True,
                "active_topic": None,
                "active_entities": [],
                "references": [],
                "rewritten_query": None,
                "ambiguities": [],
            }
        )
    )
    recon = ContextReconstructor()
    packet = await recon.reconstruct(llm=llm, query="What is the capital of France?")
    assert packet.context_dependent is False
    assert packet.resolved_query == "What is the capital of France?"


async def test_reconstruct_runs_prompt_b_and_keeps_low_confidence():
    replies = [
        # Prompt A
        json.dumps(
            {
                "self_contained": False,
                "active_topic": "manager",
                "active_entities": [],
                "references": [{"mention": "him"}],
                "rewritten_query": "tell me about Ramakrishan",
                "ambiguities": [],
            }
        ),
        # Prompt B
        json.dumps(
            [
                {
                    "mention": "him",
                    "resolved": "Ramakrishan",
                    "confidence": 0.95,
                    "reason": "the user's manager named in history",
                }
            ]
        ),
    ]

    class _MultiReplyLLM:
        provider_id = "ollama"

        def __init__(self, replies: list[str]) -> None:
            self._replies = list(replies)

        async def complete(self, prompt: str, **kwargs) -> str:
            return self._replies.pop(0)

    packet = await ContextReconstructor().reconstruct(
        llm=_MultiReplyLLM(replies),
        query="tell me more about him",
        history=[{"role": "user", "content": "my manager is Ramakrishan"}],
    )
    assert packet.resolved_references
    ref = packet.resolved_references[0]
    assert ref.mention == "him"
    assert ref.resolved == "Ramakrishan"
    assert ref.confidence == 0.95
    lines = packet.to_prompt_lines()
    assert "him → Ramakrishan" in lines
    assert "active topic: manager" in lines


async def test_reconstruct_degrades_to_raw_query_on_failure():
    class _BoomLLM:
        provider_id = "ollama"

        async def complete(self, prompt: str, **kwargs) -> str:
            raise RuntimeError("boom")

    packet = await ContextReconstructor().reconstruct(
        llm=_BoomLLM(), query="about him?", history=[{"role": "user", "content": "x"}]
    )
    assert packet.context_dependent is False
    assert packet.resolved_query == "about him?"


# ── Entity resolution (Prompt C) ────────────────────────────────────────────


async def test_resolve_entities_maps_mentions_to_canonical():
    llm = _FakeLLM(json.dumps({"him": "Raj Deep Sadhu"}))
    recon = ContextReconstructor()
    packet = ContextPacket(
        current_message="x",
        context_dependent=True,
        resolved_references=[
            ResolvedReference(
                mention="him", resolved="Raj", confidence=0.9
            )
        ],
    )
    packet = await recon.resolve_entities(
        llm=llm,
        packet=packet,
        existing_memories=["Raj Deep Sadhu is the CTO"],
    )
    assert packet.canonical_entities == {"him": "Raj Deep Sadhu"}
    assert "him → Raj Deep Sadhu" in packet.to_prompt_lines()


# ── Conversation state ──────────────────────────────────────────────────────


def test_conversation_state_round_trips():
    state = ConversationState(
        active_entities=["Raj"],
        active_topic="rollout",
        recent_references=["Raj"],
        unresolved_references=["him"],
    )
    assert ConversationState.from_dict(state.to_dict()) == state


async def test_conversation_state_store_noops_without_redis():
    store = ConversationStateStore(None)
    assert await store.get("u1", "c1") is None
    await store.set("u1", "c1", ConversationState(active_entities=["Raj"]))
    assert await store.get("u1", "c1") is None


async def test_conversation_state_store_with_fake_redis():
    class _FakeRedis:
        def __init__(self) -> None:
            self.data: dict[str, str] = {}
            self.ttls: dict[str, int] = {}

        async def get(self, key: str):
            return self.data.get(key)

        async def set(self, key: str, value: str, ex: int | None = None):
            self.data[key] = value
            self.ttls[key] = ex or -1

    redis = _FakeRedis()
    store = ConversationStateStore(redis, ttl_s=120)
    await store.set("u1", "c1", ConversationState(active_entities=["Raj"], active_topic="rollout"))
    state = await store.get("u1", "c1")
    assert state.active_entities == ["Raj"]
    assert state.active_topic == "rollout"
    assert list(redis.ttls.values()) == [120]


# ── Memory reconciliation (Prompt E) ────────────────────────────────────────


async def test_reconcile_duplicate_skips():
    llm = _FakeLLM(
        json.dumps(
            {
                "action": "duplicate",
                "target_id": "11111111-1111-1111-1111-111111111111",
                "reason": "already stored",
                "confidence": 0.9,
            }
        )
    )
    decision = await MemoryReconciler().reconcile(
        llm=llm,
        candidate={"type": "fact", "content": "x works at y", "importance": 0.8},
        existing=[{"id": "11111111-1111-1111-1111-111111111111", "type": "fact", "content": "x works at y", "importance": 0.8}],
    )
    assert decision["action"] == "duplicate"
    assert decision["target_id"] == "11111111-1111-1111-1111-111111111111"


async def test_reconcile_defaults_to_new_on_failure():
    class _BoomLLM:
        provider_id = "ollama"

        async def complete(self, prompt: str, **kwargs) -> str:
            raise RuntimeError("boom")

    decision = await MemoryReconciler().reconcile(
        llm=_BoomLLM(),
        candidate={"type": "fact", "content": "x", "importance": 0.8},
        existing=[{"id": "id1", "content": "y"}],
    )
    assert decision["action"] == "new"


async def test_reconcile_invalid_action_falls_back_to_new():
    llm = _FakeLLM(json.dumps({"action": "nonsense", "confidence": 0.5}))
    decision = await MemoryReconciler().reconcile(
        llm=llm, candidate={}, existing=[]
    )
    assert decision["action"] == "new"


# ── Prompt contracts ────────────────────────────────────────────────────────


def test_system_prompts_are_generic():
    assert "JSON" in context_understanding_system()
    assert "JSON" in reference_resolution_system()
    assert "JSON" in memory_reconcile_system()


def test_memory_extract_payload_embeds_resolved_context():
    payload = memory_extract_payload(
        "tell me about him",
        "Ramakrishan is the manager.",
        [{"role": "user", "content": "my manager is Ramakrishan"}],
        resolved_context=["him → Ramakrishan"],
    )
    assert "him → Ramakrishan" in payload
    assert "Resolved context" in payload


def test_build_system_prompt_renders_resolved_context_block():
    prompt = build_system_prompt(
        [],
        intent="memory",
        resolved_context=["him → Ramakrishan", "active entity: Project Atlas"],
    )
    assert "<resolved_context>" in prompt
    assert "him → Ramakrishan" in prompt

    plain = build_system_prompt([], intent="memory")
    assert "<resolved_context>" not in plain


# ── Planner uses the reconstruction output ──────────────────────────────────


def test_planner_uses_resolved_query_for_time_signal():
    # Raw query has no time word; the resolved one does.
    plan = RetrievalPlanner.create_plan(
        intent="general",
        query="what happened then?",
        resolved_query="what happened yesterday in the meeting?",
    )
    assert plan.resolved_query == "what happened yesterday in the meeting?"
    assert any(t in plan.types for t in ("episodic",))


def test_planner_carries_entity_anchors():
    plan = RetrievalPlanner.create_plan(
        intent="memory",
        query="about him",
        resolved_query="about Ramakrishan",
        entity_anchors=["Ramakrishan"],
    )
    assert plan.entity_anchors == ["Ramakrishan"]
    assert plan.resolved_query == "about Ramakrishan"
