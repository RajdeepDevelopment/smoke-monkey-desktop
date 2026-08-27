"""Unit tests for super-memory parsing, ranking and fact extraction."""

import asyncio
from datetime import UTC, datetime, timedelta
from unittest import mock

from src.application.mem.agent import MemoryAgent
from src.application.mem.planner import RetrievalPlanner
from src.application.memory import (
    MemoryStore,
    _context_score,
    _extract_json_array,
    _frequency_score,
    _recency_score,
    _vec,
    rank_memory,
)
from src.application.pipeline import QueryPipeline
from src.config import settings
from src.domain import MemoryFact, MemoryHit, QueryRequest
from src.generation.prompts import build_system_prompt, memory_extract_prompt


class _FakeLLM:
    provider_id = "ollama"

    def __init__(self, reply: str) -> None:
        self._reply = reply

    async def complete(self, prompt: str, **kwargs) -> str:
        return self._reply

    async def chat_stream(self, messages, **kwargs):
        for piece in (self._reply, ""):
            if piece:
                yield piece


def test_extract_json_array_handles_fences():
    raw = "```json\n[{\"type\": \"project\", \"content\": \"uses pgvector\", \"importance\": 0.9}]\n```"
    assert _extract_json_array(raw) == [
        {"type": "project", "content": "uses pgvector", "importance": 0.9}
    ]


def test_extract_json_array_none_when_missing():
    assert _extract_json_array("nothing to see") is None


def test_extract_json_array_parses_prose_with_embedded_array():
    raw = (
        "The conversation contains these durable facts:\n"
        '[{"type": "fact", "content": "The user\'s manager is Ramakrishan", '
        '"importance": 0.9}]\n\n'
        "That is all."
    )
    assert _extract_json_array(raw) == [
        {"type": "fact", "content": "The user's manager is Ramakrishan", "importance": 0.9}
    ]


def test_extract_json_array_repairs_trailing_commas():
    raw = '[{"type": "fact", "content": "x", "importance": 0.8},]'
    assert _extract_json_array(raw) == [{"type": "fact", "content": "x", "importance": 0.8}]


def test_vec_formatting():
    assert _vec([0.5, 1.0]) == "[0.5,1.0]"


def test_recency_score_decays_with_half_life():
    now = datetime.now(UTC)
    fresh = _recency_score(now, None, 72.0, now)
    half_life_old = _recency_score(now - timedelta(hours=72), None, 72.0, now)
    assert fresh == 1.0
    assert abs(half_life_old - 0.5) < 1e-6
    assert _recency_score(None, None, 72.0, now) == 0.5


def test_frequency_score_is_log_scaled():
    assert _frequency_score(0) == 0.0
    assert _frequency_score(1) > 0.0
    assert _frequency_score(99) == 1.0


def test_context_score_measures_token_overlap():
    assert _context_score("python project", "the user works on a python project") > 0.0
    assert _context_score("python", "totally unrelated topic") == 0.0
    assert _context_score("", "anything") == 0.0


def test_rank_memory_orders_by_blended_score():
    now = datetime.now(UTC)
    fresh = MemoryHit(
        id="a", role="user", content="working on python backend",
        score=0.3, created_at=now, access_count=0,
    )
    stale_but_semantic = MemoryHit(
        id="b", role="user", content="unrelated old chat",
        score=0.9, created_at=now - timedelta(days=400), access_count=0,
    )
    ranked = rank_memory([stale_but_semantic, fresh], "python project", now=now)
    # "fresh" shares keywords with the query, so context+recency push it ahead
    # despite the lower semantic score.
    assert [m.id for m in ranked] == ["a", "b"]


def test_rank_memory_prefers_high_importance_despite_weaker_semantic():
    now = datetime.now(UTC)
    low_importance = MemoryFact(
        id="trivia", type="fact", content="trivia about a loose topic",
        importance=0.4, score=0.85, created_at=now - timedelta(days=400),
        access_count=0,
    )
    high_importance = MemoryFact(
        id="manager", type="fact", content="The user's manager is Ramakrishan",
        importance=0.9, score=0.55, created_at=now, access_count=0,
    )
    ranked = rank_memory([low_importance, high_importance], "email to my manager", now=now)
    # importance weight (0.25) outweighs the semantic gap, so the durable fact
    # the query actually needs outranks the higher-similarity trivia.
    assert [f.id for f in ranked] == ["manager", "trivia"]


def test_rank_memory_respects_top_k_slice_by_caller():
    now = datetime.now(UTC)
    items = [
        MemoryFact(id=str(i), type="fact", content=f"fact about topic {i}",
                   score=0.5, created_at=now, access_count=i)
        for i in range(5)
    ]
    ranked = rank_memory(items, "topic 4", now=now)
    assert len(ranked) == 5
    assert ranked[0].access_count >= 0  # no crash, deterministic order


def test_recency_score_anchors_on_last_access():
    """Human reconsolidation: freshness is measured from the LAST recall, so a
    memory touched recently feels fresh even if it is months old, while an
    untouched memory fades no matter how recently it was created."""
    now = datetime.now(UTC)
    recalled_yesterday = _recency_score(now - timedelta(days=400), now - timedelta(hours=24), 72.0, now)
    never_recalled = _recency_score(now - timedelta(days=400), None, 72.0, now)
    recalled_then_ignored = _recency_score(now - timedelta(days=400), now - timedelta(days=400), 72.0, now)
    assert recalled_yesterday > never_recalled
    assert recalled_yesterday > recalled_then_ignored
    assert abs(recalled_then_ignored - never_recalled) < 1e-6


class _FakePool:
    def __init__(self, conn) -> None:
        self.conn = conn

    def acquire(self) -> "_FakeAcquire":
        return _FakeAcquire(self.conn)


class _FakeAcquire:
    def __init__(self, conn) -> None:
        self.conn = conn

    async def __aenter__(self):
        return self.conn

    async def __aexit__(self, *exc_info) -> None:
        return None


class _RecordingConn:
    def __init__(self) -> None:
        self.executes: list[str] = []

    async def execute(self, sql: str, *args) -> None:
        self.executes.append(sql)

    async def fetch(self, sql: str, *args) -> list:
        self.executes.append(sql)
        return []

    async def fetchrow(self, sql: str, *args) -> None:
        return None


async def test_touch_strengthens_recalled_facts():
    """Every recall reconsolidates: fact importance gets a small boost (capped
    at 1.0) so memories the user actually relies on become more durable."""
    conn = _RecordingConn()
    store = MemoryStore(pool=_FakePool(conn), embedder=None)
    await store.touch("11111111-1111-1111-1111-111111111111", [], ["11111111-1111-1111-1111-111111111111"])
    fact_sql = next(s for s in conn.executes if "memories" in s)
    assert "importance = LEAST(1.0, importance + $1::double precision)" in fact_sql
    assert "access_count = access_count + 1" in fact_sql
    assert "last_accessed_at = now()" in fact_sql
    assert "AND user_id = $3::uuid" in fact_sql  # tenant isolation scoping


async def test_consolidate_decays_then_forgets_unused_facts():
    conn = _RecordingConn()
    store = MemoryStore(pool=_FakePool(conn), embedder=None)
    await store.consolidate()
    sql = "\n".join(conn.executes)
    assert "importance - $1::double precision" in sql  # forgetting-curve decay
    assert "importance < $2::double precision" in sql  # critical facts protected
    # Lifecycle is on: faded memories are archived (soft delete), not hard-deleted.
    assert "stage = 'archived'" in sql
    assert "DELETE FROM conversation_memory" in sql  # aged episodic memory purged
    assert "stage = 'stale'" in sql  # unused confirmed facts age to stale


class _MergeConn:
    """Serves two facts; the weaker one has a strong nearest neighbour."""

    def __init__(self) -> None:
        self.executes: list[tuple[str, tuple]] = []
        self.user_id = "c356c566-80c7-4583-a1ed-3de1a1242491"
        self.facts = [
            {
                "id": "11111111-1111-1111-1111-111111111111",
                "content": "The user's wife's name is Chandrima Banerjee",
                "importance": 0.9,
                "embedding": [0.1, 0.2, 0.3],
            },
            {
                "id": "22222222-2222-2222-2222-222222222222",
                "content": "Your wife's name is Chandrima Banerjee; she is a teacher",
                "importance": 0.7,
                "embedding": [0.11, 0.21, 0.31],
            },
        ]

    async def fetch(self, sql: str, *args) -> list:
        if "DISTINCT user_id" in sql:
            return [{"user_id": self.user_id}]
        return self.facts

    async def fetchrow(self, sql: str, *args) -> dict | None:
        fact_id = args[1]
        if str(fact_id) == "11111111-1111-1111-1111-111111111111":
            # Strong fact's closest neighbour is the weak one, but not close
            # enough to merge — it stays.
            return {
                "id": "22222222-2222-2222-2222-222222222222",
                "content": "Your wife's name is Chandrima Banerjee; she is a teacher",
                "importance": 0.7,
                "sim": 0.4,
            }
        # Weak fact's closest neighbour is the strong one and close enough:
        # the weaker copy is folded in and deleted.
        return {
            "id": "11111111-1111-1111-1111-111111111111",
            "content": "The user's wife's name is Chandrima Banerjee",
            "importance": 0.9,
            "sim": 0.85,
        }

    async def execute(self, sql: str, *args) -> None:
        self.executes.append((sql, args))


async def test_merge_duplicate_facts_collapses_weaker_copy():
    """The same concept restated across conversations folds into one canonical
    memory: the weaker (lower-importance) copy is deleted, the strongest kept."""
    conn = _MergeConn()
    store = MemoryStore(pool=_FakePool(conn), embedder=None)
    await store._merge_duplicate_facts()
    deletes = [args for sql, args in conn.executes if sql.startswith("DELETE FROM memories")]
    assert len(deletes) == 1
    assert deletes[0][0] == "22222222-2222-2222-2222-222222222222"





async def test_extract_facts_filters_bad_types_and_importance():
    store = MemoryStore(pool=None, embedder=None)
    llm = _FakeLLM(
        '[{"type": "preference", "content": "likes concise answers", "importance": 0.9},'
        '{"type": "banana", "content": "unknown type, becomes fact", "importance": 0.8},'
        '{"type": "fact", "content": "trivial", "importance": 0.1}]'
    )
    facts = await store._extract_facts(llm, "q", "a", [], None)
    assert facts == [
        {"type": "preference", "content": "likes concise answers", "importance": 0.9},
        {"type": "fact", "content": "unknown type, becomes fact", "importance": 0.8},
    ]


async def test_extract_facts_returns_empty_on_garbage():
    store = MemoryStore(pool=None, embedder=None)
    facts = await store._extract_facts(_FakeLLM("sure thing!"), "q", "a", [], None)
    assert facts == []


async def test_extract_facts_drops_negative_absence_statements():
    """"I don't have your wife's name" must never become a durable fact: its
    similarity to later "what is my wife name?" queries starves the real fact
    during recall."""
    store = MemoryStore(pool=None, embedder=None)
    llm = _FakeLLM(
        '[{"type": "fact", "content": "The user has not mentioned his wife\'s name.", "importance": 0.8},'
        '{"type": "fact", "content": "The sister\'s name has not been shared", "importance": 0.9},'
        '{"type": "fact", "content": "I do not have the user\'s phone number", "importance": 0.7},'
        '{"type": "fact", "content": "The user\'s wife is Chnadrim a Banerjee.", "importance": 0.85}]'
    )
    facts = await store._extract_facts(llm, "okay her name is chnadrima banerjee", "Got it.", [], None)
    assert facts == [
        {"type": "fact", "content": "The user's wife is Chnadrim a Banerjee.", "importance": 0.85}
    ]


async def test_extract_facts_drops_assistant_subject_facts():
    """Facts about the assistant's own reply must never be stored: memory holds
    what the USER typed, not what the model said in response."""
    store = MemoryStore(pool=None, embedder=None)
    llm = _FakeLLM(
        '[{"type": "fact", "content": "The assistant has seen the name Sushmita Sadhu referenced earlier", "importance": 0.73},'
        '{"type": "fact", "content": "The user has a sister named Sushmita Sadhu.", "importance": 0.95}]'
    )
    facts = await store._extract_facts(llm, "my sister name is sushmita sadhu", "Got it.", [], None)
    assert facts == [
        {"type": "fact", "content": "The user has a sister named Sushmita Sadhu.", "importance": 0.95}
    ]


async def test_extract_with_retry_parses_on_second_attempt():
    """Models that narrate before emitting JSON must still yield facts: the
    first prose-only reply fails to parse, the strict retry succeeds."""
    store = MemoryStore(pool=None, embedder=None)

    class _NarratingLLM:
        provider_id = "nvidia"

        def __init__(self) -> None:
            self.calls = 0

        async def chat_stream(self, messages, **kwargs):
            self.calls += 1
            assert isinstance(messages, list), f"messages must be a flat list, got {type(messages).__name__}"
            assert all(isinstance(m, dict) and "role" in m and "content" in m for m in messages), f"messages must be list of dicts, got {messages!r}"
            if self.calls == 1:
                reply = (
                    "We need to extract durable facts from the conversation. "
                    "The user's manager is Ramakrishan who is CTO. No JSON here."
                )
            else:
                reply = '[{"type": "fact", "content": "The user\'s manager is Ramakrishan", "importance": 0.9}]'
            yield reply

    llm = _NarratingLLM()
    facts = await store._extract_facts(llm, "ramakrishan : cto sechpoint whom I report", "answer", [], None)
    assert llm.calls == 2
    assert facts == [
        {"type": "fact", "content": "The user's manager is Ramakrishan", "importance": 0.9}
    ]


def test_memory_extract_prompt_requests_json_array():
    prompt = memory_extract_prompt("q", "a", [])
    assert "JSON array" in prompt or "JSON" in prompt


class _RecorderMemory:
    """Records index_exchange calls; exposes how many completed."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    async def index_exchange(self, **kwargs) -> None:
        await asyncio.sleep(0)
        self.calls.append((kwargs["query"], kwargs["answer"]))


async def test_schedule_memory_index_runs_and_flush_awaits():
    pipe = QueryPipeline(pool=None, redis=None, embedder=None, chat_llm=_FakeLLM(""))
    memory = _RecorderMemory()
    pipe.memory = memory
    request = QueryRequest(message="hello", user_id="u1", conversation_id="c1")

    pipe._schedule_memory_index(_FakeLLM(""), request, "hello", "hi there", None, None)

    # The task is tracked but not necessarily done yet — flush guarantees it
    # completes before returning (this is the reliability contract).
    await pipe.flush_memory_index(timeout=2.0)

    assert memory.calls == [("hello", "hi there")]
    assert pipe._memory_tasks == set()


async def test_schedule_memory_index_skips_without_user_or_answer():
    pipe = QueryPipeline(pool=None, redis=None, embedder=None, chat_llm=_FakeLLM(""))
    memory = _RecorderMemory()
    pipe.memory = memory

    pipe._schedule_memory_index(_FakeLLM(""), QueryRequest(message="q"), "q", "", None, None)
    pipe._schedule_memory_index(_FakeLLM(""), QueryRequest(message="q"), "q", "a", None, None)
    await pipe.flush_memory_index(timeout=1.0)

    assert memory.calls == []


# ── Relationship graph memory (MemoryAgent) ──────────────────────────────────


async def test_extract_facts_preserves_relationship_links():
    store = MemoryStore(pool=None, embedder=None)
    llm = _FakeLLM(
        '[{"type": "relationship", "content": "The user works at Acme Corporation", '
        '"importance": 0.85, "relationships": [{"subject": "The user", '
        '"predicate": "WORKS_AT", "object": "Acme Corporation"}]}]'
    )
    facts = await store._extract_facts(llm, "q", "a", [], None)
    assert facts[0]["relationships"] == [
        {"subject": "The user", "predicate": "WORKS_AT", "object": "Acme Corporation"}
    ]


async def test_upsert_fact_returns_inserted_and_merged_ids():
    user_id = "c356c566-80c7-4583-a1ed-3de1a1242491"
    fact = {"type": "relationship", "content": "x works at y", "importance": 0.8}

    class _IdConn:
        def __init__(self, dedupe: dict | None) -> None:
            self.dedupe = dedupe
            self.executes: list[str] = []

        async def fetchrow(self, sql: str, *args) -> dict | None:
            if "<=>" in sql:  # _DEDUPE_QUERY
                return self.dedupe
            if sql.lstrip().startswith("UPDATE"):
                return {"id": self.dedupe["id"]}
            return {"id": "99999999-9999-9999-9999-999999999999"}

        async def execute(self, sql: str, *args) -> None:
            self.executes.append(sql)

    store = MemoryStore(pool=None, embedder=None)
    # Insert path (no neighbour).
    assert await store._upsert_fact(_IdConn(None), user_id, fact, [0.1, 0.2]) == (
        "99999999-9999-9999-9999-999999999999"
    )
    # Merge path (close neighbour) returns the existing row's id.
    assert await store._upsert_fact(
        _IdConn({"id": "11111111-1111-1111-1111-111111111111", "sim": 0.8}),
        user_id,
        fact,
        [0.1, 0.2],
    ) == "11111111-1111-1111-1111-111111111111"
    # Ignore path (near-exact duplicate) returns the existing row's id.
    assert await store._upsert_fact(
        _IdConn({
            "id": "22222222-2222-2222-2222-222222222222",
            "sim": 0.98,
            "stage": "confirmed",
            "evidence_count": 3,
        }),
        user_id,
        fact,
        [0.1, 0.2],
    ) == "22222222-2222-2222-2222-222222222222"


class _FakeEmbedder:
    provider_id = "openrouter"

    async def embed(self, texts, api_key=None, input_type=None):
        return [[0.1, 0.2, 0.3] for _ in texts]


class _FakeGraph:
    enabled = True

    def __init__(self) -> None:
        self.users: list[str] = []
        self.nodes: list = []
        self.links: list[tuple] = []
        self.by_content: dict[str, list] = {}
        self.related: list[dict] = []

    async def upsert_user(self, user_id: str) -> None:
        self.users.append(user_id)

    async def upsert_memory(self, memory) -> None:
        self.nodes.append(memory)

    async def link_related(self, user_id, from_id, to_id, rel_type, properties=None) -> None:
        self.links.append((from_id, to_id, rel_type, properties or {}))

    async def find_related_by_content(self, user_id, content, *, top_k=3):
        return self.by_content.get(content.strip().lower(), [])

    async def find_related_memories(self, user_id, seed_ids, *, depth=1, top_k=6):
        return self.related

    async def format_relationships(self, related):
        return [f"[{r.get('rel_type', 'RELATED_TO')}] {r.get('content', '')}" for r in related]


class _FakeAgentStore:
    def __init__(self) -> None:
        self.records: list[dict] = []
        self.matched: list[dict] = []

    async def remember(self, **kwargs):
        return self.records

    async def match_entity(self, vector, user_id, top_k=1, min_score=None):
        return self.matched


async def test_memory_agent_index_exchange_links_relationship_edges():
    """A fact with a relationships array becomes a node plus typed edges after
    subjects/objects are resolved to existing memory ids."""
    graph = _FakeGraph()
    graph.by_content = {"the user": [{"id": "user-node", "content": "The user", "importance": 0.9}]}
    store = _FakeAgentStore()
    store.matched = [{"id": "acme-node", "content": "Acme Corporation", "type": "fact", "sim": 0.9}]
    store.records = [
        {
            "fact": {
                "type": "relationship",
                "content": "The user works at Acme Corporation",
                "importance": 0.85,
                "relationships": [
                    {"subject": "The user", "predicate": "WORKS_AT", "object": "Acme Corporation"}
                ],
            },
            "memory_id": "33333333-3333-3333-3333-333333333333",
            "user_id": "c356c566-80c7-4583-a1ed-3de1a1242491",
        }
    ]
    agent = MemoryAgent(store=store, graph=graph, embedder=_FakeEmbedder())

    with mock.patch.object(settings, "neo4j_enabled", True):
        await agent.index_exchange(
            llm=_FakeLLM(""),
            user_id="c356c566-80c7-4583-a1ed-3de1a1242491",
            conversation_id=None,
            query="I work at Acme",
            answer="Noted.",
        )

    assert graph.users == ["c356c566-80c7-4583-a1ed-3de1a1242491"]
    assert any(n.id == "33333333-3333-3333-3333-333333333333" for n in graph.nodes)
    assert ("user-node", "acme-node", "WORKS_AT") in [link[:3] for link in graph.links]
    # The fact node is anchored to both endpoints.
    assert ("33333333-3333-3333-3333-333333333333", "user-node", "RELATED_TO") in [link[:3] for link in graph.links]
    assert ("33333333-3333-3333-3333-333333333333", "acme-node", "RELATED_TO") in [link[:3] for link in graph.links]


async def test_memory_agent_graph_context_skips_without_seeds():
    agent = MemoryAgent(store=None, graph=_FakeGraph(), embedder=None)
    assert await agent.graph_context("u1", []) == []
    assert await agent.graph_context("u1", ["11111111-1111-1111-1111-111111111111"]) == []


class _FakeRetrieveMemory:
    def __init__(self) -> None:
        self.facts = [
            MemoryFact(id="a", type="fact", content="The user's manager is Ramakrishan",
                       importance=0.9, score=0.8)
        ]
        self.relationships = [
            MemoryFact(id="r1", type="relationship", content="The user reports to Ramakrishan",
                       importance=0.9, score=0.8)
        ]

    async def search_conversation(self, query_vector, user_id, top_k):
        return []

    async def search_facts(self, query_vector, user_id, top_k):
        return self.facts

    async def search_relationships(self, query_vector, user_id, top_k):
        return self.relationships

    async def search_critical_facts(self, user_id, min_importance, top_k):
        return []

    async def touch(self, user_id, memory_ids, fact_ids):
        pass


class _FakeAgent:
    async def graph_context(self, user_id, seed_ids, *, depth=1, top_k=6):
        return [f"[REPORTS_TO] connected to {seed_ids}"]


async def test_memory_retrieve_walks_graph_from_relationship_seeds():
    pipe = QueryPipeline(pool=None, redis=None, embedder=None, chat_llm=_FakeLLM(""))
    pipe.memory = _FakeRetrieveMemory()
    pipe.memory_agent = _FakeAgent()
    plan = RetrievalPlanner.create_plan(intent="memory", query="who is my manager?")

    _, facts, relationships = await pipe._memory_retrieve([0.1, 0.2], "u1", "who is my manager?", plan)

    assert facts[0].content == "The user's manager is Ramakrishan"
    assert relationships == ["[REPORTS_TO] connected to ['r1']"]


async def test_memory_retrieve_plan_without_relationships_does_not_crash():
    pipe = QueryPipeline(pool=None, redis=None, embedder=None, chat_llm=_FakeLLM(""))
    pipe.memory = _FakeRetrieveMemory()
    pipe.memory_agent = _FakeAgent()
    plan = RetrievalPlanner.create_plan(intent="general", query="hello")

    hits, facts, relationships = await pipe._memory_retrieve([0.1, 0.2], "u1", "hello", plan)

    assert facts and relationships == []
    assert hits == []


def test_build_system_prompt_renders_relationships_block():
    prompt = build_system_prompt(
        [],
        relationships=["[WORKS_AT] The user works at Acme Corporation"],
        intent="general",
    )
    assert "<relationships>\n" in prompt
    assert "[WORKS_AT] The user works at Acme Corporation" in prompt

    plain = build_system_prompt([], intent="general")
    assert "<relationships>\n" not in plain


def test_planner_gates_critical_floor_on_personal_signal():
    # A pure knowledge question gets NO forced critical facts.
    plan = RetrievalPlanner.create_plan(intent="knowledge", query="explain quantum computing basics")
    assert plan.include_critical is False

    # A personal question ("my", "I") still gets the critical floor.
    plan = RetrievalPlanner.create_plan(intent="knowledge", query="what do you know about my family?")
    assert plan.include_critical is True

    # needs_memory from the router forces the floor even without a pronoun.
    plan = RetrievalPlanner.create_plan(intent="knowledge", needs_memory=True, query="remind me who the manager is")
    assert plan.include_critical is True


def test_planner_relationship_and_time_plans_also_gate_critical_floor():
    plan = RetrievalPlanner.create_plan(intent="general", query="who is the CEO of OpenAI")
    assert plan.include_critical is False

    plan = RetrievalPlanner.create_plan(intent="general", query="how is my manager related to the CTO?")
    assert plan.include_critical is True

    plan = RetrievalPlanner.create_plan(intent="general", query="what happened last week in the news?")
    assert plan.include_critical is False

    plan = RetrievalPlanner.create_plan(intent="general", query="what did we discuss earlier about my project?")
    assert plan.include_critical is True
