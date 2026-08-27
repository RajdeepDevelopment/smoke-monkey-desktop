"""Post-processing: citations, confidence scoring, groundedness check."""
from __future__ import annotations

from src.domain import Citation, RetrievedChunk


def compute_confidence(top: list[RetrievedChunk]) -> float:
    if not top:
        return 0.0
    weights = [max(c.rrf_score, 0.0) for c in top]
    return round(min(sum(weights) / max(len(weights), 1) * 10, 1.0), 4)


def build_citations(context: list[RetrievedChunk]) -> list[Citation]:
    """One citation per chunk, in the exact order the <knowledge> block lists
    them, so the numbers the model cites map 1:1 to the frontend's merged
    source list (web first, then knowledge)."""
    citations: list[Citation] = [
        Citation(
            documentId=c.document_id,
            documentName=c.document_name,
            page=c.page_number,
            text=c.content[:500],
            score=round(c.rrf_score, 4),
        )
        for c in context
    ]
    # RRF scores are tiny reciprocal-rank values; normalize so the UI can show
    # them as a readable relevance percentage (top result = 100%).
    max_score = max((cit.score for cit in citations), default=0.0)
    if max_score > 0:
        for cit in citations:
            cit.score = round(cit.score / max_score, 4)
    return citations
