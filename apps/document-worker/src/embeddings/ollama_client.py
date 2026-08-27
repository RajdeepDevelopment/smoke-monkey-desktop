"""Ollama embedding client (nomic-embed-text, 768 dims)."""
from __future__ import annotations

import asyncio
import logging

import httpx

logger = logging.getLogger(__name__)


class OllamaEmbeddingClient:
    def __init__(
        self,
        base_url: str,
        model: str,
        dims: int,
        batch_size: int = 32,
        timeout: float = 60.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.dims = dims
        self.batch_size = batch_size
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(timeout))
        self._lock = asyncio.Lock()

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        results: list[list[float]] = []
        for i in range(0, len(texts), self.batch_size):
            batch = texts[i : i + self.batch_size]
            # Serialize concurrent calls to keep Ollama's scheduler stable.
            async with self._lock:
                resp = await self._client.post(
                    f"{self.base_url}/api/embed",
                    json={"model": self.model, "input": batch},
                )
                resp.raise_for_status()
            data = resp.json()
            embeddings = data["embeddings"]
            for emb in embeddings:
                if len(emb) != self.dims:
                    logger.warning(
                        "embedding dim mismatch: got %d, expected %d", len(emb), self.dims
                    )
                results.append(emb)
        return results

    async def embed_one(self, text: str) -> list[float]:
        return (await self.embed([text]))[0]

    async def aclose(self) -> None:
        await self._client.aclose()
