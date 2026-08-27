"""OpenAI-compatible cloud embedding client (OpenRouter or NVIDIA NIM).

Backs e.g. NVIDIA Nemotron 3 Embed 1B (2048 dims) on either provider. NVIDIA
Nemotron models additionally accept an `input_type` hint (`passage` for
indexing, `query` for retrieval) that boosts accuracy; it is sent when the
configured model is a Nemotron model and retried without it if the provider
rejects it.
"""
from __future__ import annotations

import logging

import httpx

logger = logging.getLogger(__name__)

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1"


class OpenRouterEmbeddingClient:
    def __init__(
        self,
        api_key: str,
        model: str,
        dims: int,
        batch_size: int = 32,
        timeout: float = 90.0,
        base_url: str = OPENROUTER_BASE_URL,
        name: str = "OpenRouter",
    ) -> None:
        self.api_key = api_key
        self.model = model
        self.dims = dims
        self.batch_size = batch_size
        self.name = name
        self.base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(timeout))

    def _headers(self) -> dict[str, str]:
        return {
            "authorization": f"Bearer {self.api_key}",
            "content-type": "application/json",
            "x-title": "rag-platform",
        }

    def _default_input_type(self) -> str | None:
        return "passage" if "nemotron" in self.model.lower() else None

    async def embed(
        self,
        texts: list[str],
        *,
        input_type: str | None = None,
    ) -> list[list[float]]:
        if not texts:
            return []
        if not self.api_key:
            raise RuntimeError(f"no {self.name} API key available for embedding")
        input_type = input_type or self._default_input_type()

        results: list[list[float]] = []
        for i in range(0, len(texts), self.batch_size):
            batch = texts[i : i + self.batch_size]
            embeddings = await self._embed_batch(batch, input_type)
            for emb in embeddings:
                if len(emb) != self.dims:
                    logger.warning("embedding dim mismatch: got %d, expected %d", len(emb), self.dims)
                results.append(emb)
        return results

    async def _embed_batch(self, batch: list[str], input_type: str | None) -> list[list[float]]:
        payload: dict = {"model": self.model, "input": batch, "encoding_format": "float"}
        if input_type:
            payload["input_type"] = input_type

        resp = await self._client.post(
            f"{self.base_url}/embeddings",
            json=payload,
            headers=self._headers(),
        )
        if resp.status_code >= 400:
            body = resp.text[:500]
            if resp.status_code == 400 and input_type and "input_type" in body.lower():
                payload.pop("input_type", None)
                resp = await self._client.post(
                    f"{self.base_url}/embeddings",
                    json=payload,
                    headers=self._headers(),
                )
                if resp.status_code < 400:
                    body = ""
            if resp.status_code >= 400:
                raise RuntimeError(self._friendly_error(resp.status_code, body))
        data = resp.json()
        return [item.get("embedding") or [] for item in data.get("data") or []]

    async def embed_one(self, text: str, *, input_type: str | None = None) -> list[float]:
        return (await self.embed([text], input_type=input_type))[0]

    def _friendly_error(self, status: int, detail: str) -> str:
        detail = (detail or "").strip()
        mapping = {
            401: f"invalid {self.name} API key — update it in Settings",
            402: f"your {self.name} key has no remaining credits",
            404: f"the embedding model is unavailable on {self.name}",
            429: f"{self.name} rate limit reached — retry the upload in a moment",
            529: f"the {self.name} provider is overloaded — retry shortly",
        }
        message = mapping.get(status, f"{self.name} error {status}")
        return f"{message}: {detail}" if detail else message

    async def aclose(self) -> None:
        await self._client.aclose()


class NvidiaEmbeddingClient(OpenRouterEmbeddingClient):
    """NVIDIA NIM embeddings (same OpenAI-compatible API, different base URL)."""

    def __init__(
        self,
        api_key: str,
        model: str,
        dims: int,
        batch_size: int = 32,
        timeout: float = 90.0,
    ) -> None:
        super().__init__(
            api_key=api_key,
            model=model,
            dims=dims,
            batch_size=batch_size,
            timeout=timeout,
            base_url=NVIDIA_BASE_URL,
            name="NVIDIA",
        )
