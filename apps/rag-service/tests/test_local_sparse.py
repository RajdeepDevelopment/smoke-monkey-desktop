"""Sparse (FTS5) retrieval + parent expansion on the local adapter."""
import uuid

import pytest
from src.storage import LocalVectorStore


def _vec(*xs: float) -> list[float]:
    return list(xs)


class Child:
    def __init__(self, content, page_number):
        self.content = content
        self.page_number = page_number


class Group:
    def __init__(self, parent_content, section, children):
        self.parent_content = parent_content
        self.section = section
        self.children = children


@pytest.fixture
async def store():
    s = LocalVectorStore(":memory:")
    await s.connect()
    yield s
    await s.close()


async def _seed(store, doc_id, groups, child_embeddings=None):
    await store.set_document_status(doc_id, "ready", chunk_count=1)
    return await store.replace_document_chunks(doc_id, groups, child_embeddings or {})


async def test_sparse_fts_retrieval(store):
    doc = str(uuid.uuid4())
    await _seed(store, doc, [Group("", "s1", [Child("quantum entanglement explained", 1)])])
    hits = await store.sparse_search_chunks("quantum", top_k=5)
    assert len(hits) == 1
    assert hits[0].content == "quantum entanglement explained"
    assert hits[0].document_id == doc
    assert hits[0].score < 0  # bm25 ranks are negative; lower is better


async def test_sparse_scopes_to_ready_documents(store):
    d1 = str(uuid.uuid4())
    d2 = str(uuid.uuid4())
    await _seed(store, d1, [Group("alpha beta", None, [])])
    await _seed(store, d2, [Group("", None, [Child("gamma delta", 1)])])
    assert len(await store.sparse_search_chunks("alpha", top_k=5)) == 1
    assert await store.sparse_search_chunks("gamma", top_k=5, document_ids=[d1]) == []
    await store.set_document_status(d1, "failed", error="x")
    assert await store.sparse_search_chunks("alpha", top_k=5) == []


async def test_sparse_reindexes_on_replace(store):
    doc = str(uuid.uuid4())
    await _seed(store, doc, [Group("", None, [Child("quantum entanglement", 1)])])
    assert len(await store.sparse_search_chunks("quantum", top_k=5)) == 1
    await _seed(store, doc, [Group("", None, [Child("classical mechanics", 1)])])
    assert await store.sparse_search_chunks("quantum", top_k=5) == []
    assert len(await store.sparse_search_chunks("classical", top_k=5)) == 1


async def test_sparse_fallback_token_scorer(store, monkeypatch):
    monkeypatch.setattr(store, "_sparse_fts", False)  # exercise the fallback path
    doc = str(uuid.uuid4())
    await _seed(store, doc, [Group("", None, [Child("the quick brown fox", 1)])])
    hits = await store.sparse_search_chunks("quick fox", top_k=5)
    assert len(hits) == 1
    assert hits[0].score == 2


async def test_sparse_returns_empty_for_no_tokens(store):
    assert await store.sparse_search_chunks("!!", top_k=5) == []


async def test_sparse_returns_empty_when_disabled():
    s = LocalVectorStore(":memory:")
    assert await s.sparse_search_chunks("anything", top_k=5) == []


async def test_get_parents_resolves_content(store):
    doc = str(uuid.uuid4())
    await _seed(store, doc, [Group("parent section intro", "s1", [Child("child one", 1)])], {})
    rows = await store._rows("SELECT id, parent_chunk_id FROM chunks WHERE content = ?", ("child one",))
    assert rows
    parents = await store.get_parents([rows[0]["parent_chunk_id"]])
    assert parents == [{"id": rows[0]["parent_chunk_id"], "content": "parent section intro"}]


async def test_get_parents_handles_missing(store):
    assert await store.get_parents([]) == []
    assert await store.get_parents([str(uuid.uuid4())]) == []


async def test_dense_and_sparse_agree_on_ready_status(store):
    doc = str(uuid.uuid4())
    await _seed(store, doc, [Group("", None, [Child("shared subject words", 1)])], {"shared subject words": _vec(1, 0, 0)})
    dense = await store.search_chunks(_vec(1, 0, 0), top_k=5)
    sparse = await store.sparse_search_chunks("shared", top_k=5)
    assert [h.id for h in dense] == [h.id for h in sparse]
