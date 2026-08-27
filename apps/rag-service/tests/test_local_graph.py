"""Local SQLite graph adapter tests (no Neo4j server needed)."""
import asyncio
from datetime import UTC, datetime

import pytest
from src.application.mem.models import (
    Memory,
    MemoryCategory,
    MemoryStage,
    MemoryType,
)
from src.storage import GraphStore, LocalGraphStore


def _memory(memory_id: str, user_id: str, content: str, importance: float = 0.5) -> Memory:
    return Memory(
        id=memory_id,
        user_id=user_id,
        type=MemoryType.SEMANTIC,
        content=content,
        importance=importance,
        created_at=datetime.now(UTC),
        category=MemoryCategory.FACT,
        stage=MemoryStage.CONFIRMED,
    )


@pytest.fixture
async def store():
    s = LocalGraphStore(":memory:")
    await s.connect()
    yield s
    await s.close()


async def test_satisfies_graphstore(store):
    assert isinstance(store, GraphStore)
    assert store.enabled is True


async def test_upsert_and_link_roundtrip(store):
    user = "u1"
    await store.upsert_user(user)
    await store.upsert_memory(_memory("m1", user, "The user works at Acme", 0.8))
    await store.upsert_memory(_memory("m2", user, "Ram is the user's manager", 0.9))
    await store.link_related(user, "m1", "m2", "MANAGES", {"confidence": 0.95})

    related = await store.find_related_memories(user, ["m1"], top_k=10)
    assert len(related) == 1
    row = related[0]
    assert row["id"] == "m2"
    assert row["rel_type"] == "MANAGES"
    assert row["confidence"] == 0.95
    assert row["importance"] == 0.9
    assert row["type"] == "semantic"


async def test_related_is_bidirectional(store):
    user = "u1"
    await store.upsert_memory(_memory("a", user, "memory a", 0.5))
    await store.upsert_memory(_memory("b", user, "memory b", 0.5))
    await store.link_related(user, "a", "b", "RELATED_TO")
    # Seed b: a must show up even though the edge is stored a -> b.
    related = await store.find_related_memories(user, ["b"], top_k=10)
    assert [r["id"] for r in related] == ["a"]


async def test_seed_memory_not_itself(store):
    user = "u1"
    await store.upsert_memory(_memory("a", user, "memory a", 0.9))
    await store.upsert_memory(_memory("b", user, "memory b", 0.5))
    await store.link_related(user, "a", "b", "RELATED_TO")
    related = await store.find_related_memories(user, ["a"], top_k=10)
    assert [r["id"] for r in related] == ["b"]


async def test_tenant_isolation(store):
    await store.upsert_memory(_memory("a1", "u1", "u1 memory", 0.5))
    await store.upsert_memory(_memory("a2", "u2", "u2 memory", 0.5))
    await store.link_related("u1", "a1", "a1", "RELATED_TO")  # self-link noise
    # No cross-user leakage even with identical seeds.
    assert await store.find_related_memories("u2", ["a2"], top_k=10) == []


async def test_find_by_content(store):
    user = "u1"
    await store.upsert_memory(_memory("m1", user, "Manager is Ramakrishan", 0.9))
    await store.upsert_memory(_memory("m2", user, "Uses pgvector for RAG", 0.6))
    rows = await store.find_related_by_content(user, "ramakrishan")
    assert [r["id"] for r in rows] == ["m1"]
    assert rows[0]["importance"] == 0.9


async def test_delete_memory_removes_edges(store):
    user = "u1"
    await store.upsert_memory(_memory("a", user, "a", 0.5))
    await store.upsert_memory(_memory("b", user, "b", 0.5))
    await store.link_related(user, "a", "b", "RELATED_TO")
    await store.delete_memory(user, "a")
    assert await store.find_related_memories(user, ["b"], top_k=10) == []


async def test_prune_stale_edges(store):
    user = "u1"
    await store.upsert_memory(_memory("keep", user, "keep me", 0.9))
    await store.upsert_memory(_memory("drop", user, "drop me", 0.5))
    await store.link_related(user, "keep", "drop", "RELATED_TO")
    await store.prune_stale_edges(user, ["keep"])
    assert await store.find_related_memories(user, ["keep"], top_k=10) == []


async def test_format_relationships(store):
    lines = LocalGraphStore.format_relationships(
        [{"id": "x", "content": "Ram is manager", "rel_type": "MANAGES", "importance": 0.9}]
    )
    assert lines == ["[MANAGES, importance 0.9] Ram is manager"]


async def test_persists_across_reopen(tmp_path):
    db = str(tmp_path / "graph.db")
    s = LocalGraphStore(db)
    await s.connect()
    await s.upsert_memory(_memory("m1", "u1", "persisted fact", 0.8))
    await s.close()

    s2 = LocalGraphStore(db)
    await s2.connect()
    related = await s2.find_related_by_content("u1", "persisted")
    assert [r["id"] for r in related] == ["m1"]
    await s2.close()


async def test_returns_empty_when_disabled():
    s = LocalGraphStore(":memory:")  # never connected
    assert s.enabled is False
    assert await s.find_related_memories("u1", ["m1"]) == []
    assert await s.find_related_by_content("u1", "x") == []


async def test_concurrent_access_does_not_corrupt(tmp_path):
    db = str(tmp_path / "graph.db")
    s = LocalGraphStore(db)
    await s.connect()
    user = "u1"

    async def _write(i: int) -> None:
        await s.upsert_memory(_memory(f"m{i}", user, f"fact {i}", 0.5))

    await asyncio.gather(*[_write(i) for i in range(20)])
    rows = await s.find_related_by_content(user, "fact", top_k=100)
    assert len(rows) == 20
    await s.close()
