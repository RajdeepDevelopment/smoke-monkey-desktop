"""Reranking: local cross-encoder (opt-in, needs torch) or OpenRouter cloud.

The local `Reranker` is kept out of the default image (torch is ~2GB). The
`OpenRouterReranker` uses NVIDIA's free cross-encoder on OpenRouter and is the
default when `OPENROUTER_RERANK_ENABLED=true`.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from src.domain import RetrievedChunk

if TYPE_CHECKING:
    from src.generation.openrouter import OpenRouterClient

logger = logging.getLogger(__name__)


class Reranker:
    provider_id = "local"

    def __init__(self, model_name: str) -> None:
        self.model_name = model_name
        self._model = None

    @property
    def model(self):
        if self._model is None:
            try:
                from sentence_transformers import CrossEncoder

                self._model = CrossEncoder(self.model_name)
            except ImportError as exc:
                raise RuntimeError(
                    "RERANK_ENABLED=true requires the 'rerank' extra "
                    "(pip install -e '.[rerank]')"
                ) from exc
        return self._model

    async def rerank(
        self,
        query: str,
        chunks: list[RetrievedChunk],
        top_n: int,
        *,
        api_key: str | None = None,
    ) -> list[RetrievedChunk]:
        if not chunks:
            return chunks
        pairs = [(query, c.content) for c in chunks]

        import asyncio

        scores = await asyncio.to_thread(self.model.predict, pairs)

        ranked = sorted(
            zip(chunks, scores, strict=False),
            key=lambda pair: float(pair[1]),
            reverse=True,
        )
        top = ranked[:top_n]
        for chunk, score in top:
            chunk.rrf_score = round(float(score), 6)
            chunk.rank = ranked.index((chunk, score)) + 1
        return [chunk for chunk, _ in top]


class OpenRouterReranker:
    """Cloud reranking via the OpenAI-compatible client (OpenRouter or NVIDIA NIM)."""

    def __init__(self, client: OpenRouterClient) -> None:
        self._client = client

    @property
    def provider_id(self) -> str:
        return self._client.provider_id

    async def rerank(
        self,
        query: str,
        chunks: list[RetrievedChunk],
        top_n: int,
        *,
        api_key: str | None = None,
    ) -> list[RetrievedChunk]:
        if not chunks:
            return chunks
        index_by_text = {c.content: c for c in chunks}
        texts = list(index_by_text.keys())
        scored = await self._client.rerank(query, texts, top_n, api_key=api_key)

        reordered: list[RetrievedChunk] = []
        for position, (idx, score) in enumerate(scored):
            chunk = index_by_text.get(texts[idx]) if idx < len(texts) else None
            if chunk is None:
                continue
            chunk.rrf_score = round(float(score), 6)
            chunk.rank = position + 1
            reordered.append(chunk)
        return reordered
