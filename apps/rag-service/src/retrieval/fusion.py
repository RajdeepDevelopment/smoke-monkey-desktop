"""Reciprocal Rank Fusion: merge ranked lists from multiple retrievers."""
from __future__ import annotations

from src.domain import RetrievedChunk


def rrf_merge(
    *ranked_lists: list[RetrievedChunk],
    k: int = 60,
    top_n: int | None = None,
) -> list[RetrievedChunk]:
    scores: dict[str, float] = {}
    by_id: dict[str, RetrievedChunk] = {}

    for ranked in ranked_lists:
        for rank, chunk in enumerate(ranked, start=1):
            scores[chunk.id] = scores.get(chunk.id, 0.0) + 1.0 / (k + rank)
            if chunk.id not in by_id:
                by_id[chunk.id] = chunk

    merged: list[RetrievedChunk] = []
    for chunk_id, score in sorted(scores.items(), key=lambda kv: kv[1], reverse=True):
        chunk = by_id[chunk_id].model_copy(deep=True)
        chunk.rrf_score = round(score, 6)
        merged.append(chunk)

    if top_n is not None:
        merged = merged[:top_n]
    for i, chunk in enumerate(merged, start=1):
        chunk.rank = i
    return merged
