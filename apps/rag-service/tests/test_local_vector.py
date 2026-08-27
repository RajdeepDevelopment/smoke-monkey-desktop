"""Local SQLite vector adapter tests (no PostgreSQL/pgvector needed)."""
import asyncio
import uuid

import pytest
from src.config import settings
from src.storage import LocalVectorStore, VectorStore


def _vec(*xs: float) -> list[float]:
    return list(xs)


@pytest.fixture
async def store():
    s = LocalVectorStore(":memory:")
    await s.connect()
    yield s
    await s.close()


async def test_satisfies_vectorstore(store):
    assert isinstance(store, VectorStore)
    assert store.enabled is True


async def test_insert_and_search_conversation(store):
    await store.insert_message(user_id="u1", conversation_id="c1", role="user", content="My dog is named Milo", vector=_vec(1, 0, 0))
    await store.insert_message(user_id="u1", conversation_id="c1", role="assistant", content="Got it, Milo the dog", vector=_vec(0, 1, 0))
    hits = await store.search_conversation(_vec(1, 0, 0), "u1", top_k=5)
    assert len(hits) == 1  # only the semantically-close message scores above 0
    assert hits[0].role == "user"
    assert hits[0].score > 0


async def test_message_dedupe(store):
    await store.insert_message(user_id="u1", conversation_id="c1", role="user", content="hello world", vector=_vec(1, 0))
    await store.insert_message(user_id="u1", conversation_id="c1", role="user", content="hello world", vector=_vec(1, 0))
    assert len(await store.search_conversation(_vec(1, 0), "u1", top_k=10)) == 1
    assert len(await store.recent_turns("u1", limit=10)) == 1


async def test_recent_turns_ordering(store):
    await store.insert_message(user_id="u1", conversation_id=None, role="user", content="first")
    await store.insert_message(user_id="u1", conversation_id=None, role="assistant", content="second")
    turns = await store.recent_turns("u1", limit=2)
    assert [t["content"] for t in turns] == ["second", "first"]


async def test_fact_lifecycle_and_upsert(store):
    mid = await store.upsert_fact(
        user_id="u1", type_="fact", content="User prefers dark theme", vector=_vec(1, 0)
    )
    assert mid
    facts = await store.search_facts(_vec(1, 0), "u1", top_k=5)
    assert [f.id for f in facts] == [mid]
    assert facts[0].content == "User prefers dark theme"


async def test_upsert_merges_near_duplicates(store):
    first = await store.upsert_fact(
        user_id="u1", type_="fact", content="User likes coffee", vector=_vec(1, 0)
    )
    second = await store.upsert_fact(
        user_id="u1", type_="fact", content="User likes coffee a lot", vector=_vec(1, 0)
    )
    assert first == second  # merged, not duplicated
    facts = await store.search_facts(_vec(1, 0), "u1", top_k=5)
    assert len(facts) == 1


async def test_upsert_distinct_vectors_insert_separately(store):
    await store.upsert_fact(user_id="u1", type_="fact", content="likes coffee", vector=_vec(1, 0))
    await store.upsert_fact(user_id="u1", type_="fact", content="likes tea", vector=_vec(0, 1))
    assert len(await store.search_facts(_vec(0.5, 0.5), "u1", top_k=10)) == 2


async def test_stage_transitions_on_merge(store):
    from src.config import settings
    mid = await store.upsert_fact(
        user_id="u1", type_="fact", content="Ram leads the team", vector=_vec(1, 0),
        importance=0.7, stage="candidate",
    )
    for _ in range(2):
        await store.merge_fact(
            target_id=mid, user_id="u1", importance=0.8, content="Ram leads the team",
            evidence_boost=settings.memory_evidence_boost,
            confirm_accesses=1, stable_accesses=2, stable_min_importance=0.6,
        )
    rows = await store._rows("SELECT stage, evidence_count FROM memories WHERE id = ?", (mid,))
    assert rows[0]["stage"] == "stable"
    assert rows[0]["evidence_count"] >= 2


async def test_critical_and_preferences(store):
    await store.upsert_fact(user_id="u1", type_="fact", content="critical fact", vector=_vec(1, 0), importance=0.9)
    await store.upsert_fact(user_id="u1", type_="preference", content="prefers tea", vector=_vec(0, 1), importance=0.7)
    critical = await store.search_critical_facts("u1", min_importance=0.8, top_k=5)
    assert [c.content for c in critical] == ["critical fact"]
    prefs = await store.recall_preferences("u1", top_k=5)
    assert [p.content for p in prefs] == ["prefers tea"]


async def test_search_relationships(store):
    await store.upsert_fact(user_id="u1", type_="relationship", content="knows Ram", vector=_vec(1, 0))
    rels = await store.search_relationships(_vec(1, 0), "u1", top_k=5)
    assert [r.content for r in rels] == ["knows Ram"]


async def test_match_entity_threshold(store):
    await store.upsert_fact(user_id="u1", type_="fact", content="Ram works at Acme", vector=_vec(1, 0))
    matches = await store.match_entity(_vec(1, 0), "u1", top_k=1, min_score=0.0)
    assert matches and matches[0]["sim"] >= 0.0
    assert await store.match_entity(_vec(1, 0), "u1", top_k=1, min_score=1.5) == []


async def test_tenant_isolation(store):
    await store.insert_message(user_id="u1", conversation_id=None, role="user", content="u1 secret")
    await store.upsert_fact(user_id="u2", type_="fact", content="u2 fact", vector=_vec(1, 0))
    assert await store.search_conversation(_vec(1, 0), "u2", top_k=5) == []
    assert await store.search_facts(_vec(1, 0), "u1", top_k=5) == []


async def test_touch_bumps_access_and_importance(store):
    mid = await store.upsert_fact(user_id="u1", type_="fact", content="fading fact", vector=_vec(1, 0), importance=0.3)
    await store.touch("u1", [], [uuid.UUID(mid)])
    rows = await store._rows("SELECT access_count, importance FROM memories WHERE id = ?", (mid,))
    assert rows[0]["access_count"] == 1
    assert rows[0]["importance"] > 0.3


async def test_delete_fact(store):
    mid = await store.upsert_fact(user_id="u1", type_="fact", content="to delete", vector=_vec(1, 0))
    await store.delete_fact("u1", mid)
    assert await store.search_facts(_vec(1, 0), "u1", top_k=5) == []


async def test_consolidate_purges_expired_and_forgotten(store):
    expired = await store.upsert_fact(user_id="u1", type_="fact", content="expired", vector=_vec(1, 0), expires_in_days=0)
    assert await store.search_facts(_vec(1, 0), "u1", top_k=5) == []  # already expired
    events = await store.consolidate()
    assert any(e["id"] == expired for e in events)


async def test_merge_duplicates(store, monkeypatch):
    # Disable dedupe at insert time so two identical rows exist, then let
    # merge_duplicates fold them (dedupe threshold restored).
    monkeypatch.setattr(settings, "memory_dedupe_ignore", 1.5)
    monkeypatch.setattr(settings, "memory_dedupe_merge", 1.5)
    await store.upsert_fact(user_id="u1", type_="fact", content="dup one", vector=_vec(1, 0), importance=0.9)
    await store.upsert_fact(user_id="u1", type_="fact", content="dup two", vector=_vec(1, 0), importance=0.5)
    monkeypatch.setattr(settings, "memory_dedupe_merge", 0.72)
    merged = await store.merge_duplicates()
    assert merged >= 1
    assert len(await store.search_facts(_vec(1, 0), "u1", top_k=10)) == 1


async def test_chunk_roundtrip(store):
    class Child:
        def __init__(self, content, page_number):
            self.content = content
            self.page_number = page_number

    class Group:
        def __init__(self, parent_content, section, children):
            self.parent_content = parent_content
            self.section = section
            self.children = children

    doc_id = str(uuid.uuid4())
    await store.set_document_status(doc_id, "processing")
    group = Group("intro", "s1", [Child("alpha beta", 1), Child("gamma delta", 2)])
    count = await store.replace_document_chunks(
        doc_id, [group], {"alpha beta": _vec(1, 0, 0), "gamma delta": _vec(0, 1, 0)}
    )
    assert count == 2
    hits = await store.search_chunks(_vec(1, 0, 0), top_k=5)
    assert hits == []  # document not ready yet
    await store.set_document_status(doc_id, "ready", chunk_count=count)
    hits = await store.search_chunks(_vec(1, 0, 0), top_k=5)
    assert len(hits) == 1
    assert hits[0].content == "alpha beta"
    assert hits[0].document_id == doc_id
    await store.set_document_status(doc_id, "failed", error="boom")
    assert await store.search_chunks(_vec(1, 0, 0), top_k=5) == []


async def test_chunk_user_and_document_scope(store):
    class Group:
        parent_content = "p"
        section = None
        children = []

    d1, d2 = str(uuid.uuid4()), str(uuid.uuid4())
    await store.set_document_status(d1, "ready", chunk_count=0)
    await store.set_document_status(d2, "ready", chunk_count=0)
    assert await store.replace_document_chunks(d1, [Group()], {}) == 0
    assert await store.replace_document_chunks(d2, [Group()], {}) == 0
    assert await store.search_chunks(_vec(1, 0), 5, user_id="someone") == []


async def test_set_document_status_keeps_user_scope_on_from_scratch_row(store):
    """A status write that must create the row (e.g. upload error path) still
    records user_id so the document stays scoped to its owner."""
    doc_id = str(uuid.uuid4())
    await store.set_document_status(doc_id, "failed", error="boom", user_id="u1")
    row = await store.get_document(doc_id, "u1")
    assert row is not None
    assert row["status"] == "failed"
    assert await store.get_document(doc_id, "other") is None


async def test_returns_empty_when_disabled():
    s = LocalVectorStore(":memory:")
    assert s.enabled is False
    assert await s.search_facts(_vec(1, 0), "u1", 5) == []
    assert await s.search_chunks(_vec(1, 0), 5) == []
    assert await s.consolidate() == []
    assert await s.merge_duplicates() == 0


async def test_concurrent_writes(tmp_path):
    s = LocalVectorStore(str(tmp_path / "vec.db"))
    await s.connect()

    async def _write(i: int) -> None:
        basis = [1.0 if j == i else 0.0 for j in range(16)]
        await s.upsert_fact(user_id="u1", type_="fact", content=f"fact {i}", vector=basis)

    await asyncio.gather(*[_write(i) for i in range(15)])
    assert len(await s.search_facts(_vec(*([1.0] * 16)), "u1", top_k=100)) == 15
    await s.close()


async def test_persists_across_reopen(tmp_path):
    db = str(tmp_path / "vec.db")
    s = LocalVectorStore(db)
    await s.connect()
    await s.upsert_fact(user_id="u1", type_="fact", content="persisted", vector=_vec(1, 0))
    await s.close()

    s2 = LocalVectorStore(db)
    await s2.connect()
    assert len(await s2.search_facts(_vec(1, 0), "u1", top_k=5)) == 1
    await s2.close()
