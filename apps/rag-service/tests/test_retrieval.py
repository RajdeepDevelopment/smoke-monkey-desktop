"""Unit tests for retrieval fusion + context building."""
from src.application.pipeline import _build_context
from src.domain import RetrievedChunk
from src.retrieval.fusion import rrf_merge


def _chunk(cid: str, **kwargs) -> RetrievedChunk:
    defaults = {
        "id": cid,
        "document_id": "doc-1",
        "document_name": "a.pdf",
        "content": f"content {cid}",
    }
    defaults.update(kwargs)
    return RetrievedChunk(**defaults)


def test_rrf_fuses_and_ranks():
    a = [_chunk("1", dense_score=0.9), _chunk("2", dense_score=0.8)]
    b = [_chunk("2", sparse_score=0.7), _chunk("3", sparse_score=0.6)]
    merged = rrf_merge(a, b)
    ids = [c.id for c in merged]
    assert ids[0] == "2"  # appears in both lists → highest RRF score
    assert set(ids) == {"1", "2", "3"}
    assert all(c.rank > 0 for c in merged)


def test_context_budget_truncates():
    chunks = [_chunk(str(i), content="x" * 1000) for i in range(5)]
    context = _build_context(chunks, token_budget=500)
    assert len(context) < 5
