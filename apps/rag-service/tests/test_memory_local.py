"""Local-mode MemoryStore branches (pool=None backed by SQLite adapters)."""
import uuid

import pytest
from src.application.memory import MemoryStore
from src.config import settings
from src.storage import LocalVectorStore


class _FakeEmbedder:
    provider_id = "fake"

    async def embed(self, texts, api_key=None, input_type=None):
        return [[1.0, 0.0]] * len(texts)


class _FakeLLM:
    async def chat_stream(self, messages, **kwargs):
        yield '[{"type": "fact", "content": "Ram leads the team", "importance": 0.8}]'

    async def complete(self, prompt, **kwargs):
        return '[{"type": "fact", "content": "Ram leads the team", "importance": 0.8}]'


class _SpyGraph:
    def __init__(self) -> None:
        self.deleted: list[tuple[str, str]] = []

    async def delete_memory(self, user_id: str, memory_id: str) -> None:
        self.deleted.append((user_id, memory_id))


@pytest.fixture
async def vec_store():
    vec = LocalVectorStore(":memory:")
    await vec.connect()
    yield vec
    await vec.close()


async def test_local_mode_flag(vec_store):
    store = MemoryStore(pool=None, embedder=_FakeEmbedder(), vector_store=vec_store)
    assert store.local_mode is True


async def test_ensure_schema_noop_locally(vec_store):
    store = MemoryStore(pool=None, embedder=_FakeEmbedder(), vector_store=vec_store)
    await store.ensure_schema()  # must not raise


async def test_remember_local_stores_messages(vec_store, monkeypatch):
    monkeypatch.setattr(settings, "memory_extract_enabled", False)
    store = MemoryStore(pool=None, embedder=_FakeEmbedder(), vector_store=vec_store)
    await store.remember(
        user_id="u1", conversation_id="c1", query="my dog is Milo", answer="noted", llm=None
    )
    turns = await store.recent_turns("u1", limit=10)
    assert [t["content"] for t in turns] == ["noted", "my dog is Milo"]
    hits = await store.search_conversation([1.0, 0.0], "u1", top_k=5)
    assert hits and hits[0].role == "user"


async def test_remember_local_extracts_and_stores_fact(vec_store, monkeypatch):
    monkeypatch.setattr(settings, "memory_extract_enabled", True)
    monkeypatch.setattr(settings, "memory_reconcile_enabled", False)
    store = MemoryStore(pool=None, embedder=_FakeEmbedder(), vector_store=vec_store)
    stored = await store.remember(
        user_id="u1", conversation_id="c1", query="who leads the team?", answer="Ram", llm=_FakeLLM()
    )
    assert stored and stored[0]["fact"]["content"] == "Ram leads the team"
    hits = await store.search_facts([1.0, 0.0], "u1", top_k=5)
    assert [h.content for h in hits] == ["Ram leads the team"]


async def test_touch_local_bumps_fact_access(vec_store):
    store = MemoryStore(pool=None, embedder=_FakeEmbedder(), vector_store=vec_store)
    mid = await vec_store.upsert_fact(
        user_id="u1", type_="fact", content="used fact", vector=[1.0, 0.0], importance=0.3
    )
    await store.touch("u1", [], [uuid.UUID(mid)])
    rows = await vec_store._rows("SELECT access_count FROM memories WHERE id = ?", (mid,))
    assert rows[0]["access_count"] == 1


async def test_consolidate_local_mirrors_graph(vec_store, monkeypatch):
    monkeypatch.setattr(settings, "memory_consolidate_enabled", True)
    graph = _SpyGraph()
    store = MemoryStore(pool=None, embedder=_FakeEmbedder(), vector_store=vec_store, graph=graph)
    expired = await vec_store.upsert_fact(
        user_id="u1", type_="fact", content="expired local", vector=[1.0, 0.0], expires_in_days=0
    )
    await store.consolidate()
    assert await vec_store.search_facts([1.0, 0.0], "u1", top_k=5) == []
    assert ("u1", expired) in graph.deleted
