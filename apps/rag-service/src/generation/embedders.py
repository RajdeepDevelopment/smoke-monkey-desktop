"""Uniform embedding adapters so the query pipeline can swap providers.

The adapters expose ``embed(texts, *, api_key=None, input_type=None)``. The
``input_type`` hint (query/passage) is only meaningful for models that need it
(e.g. NVIDIA Nemotron embeddings); other providers ignore it.
"""
from __future__ import annotations

import logging
from collections.abc import Sequence
from typing import Protocol

from src.generation.llm import OllamaClient
from src.generation.openrouter import OpenRouterClient

logger = logging.getLogger(__name__)


class Embedder(Protocol):
    provider_id: str

    @property
    def dims(self) -> int: ...

    async def embed(
        self,
        texts: Sequence[str],
        *,
        api_key: str | None = None,
        input_type: str | None = None,
    ) -> list[list[float]]: ...

    async def ping(self) -> bool: ...


class OllamaEmbedder:
    """Local Ollama embeddings (nomic-embed-text by default)."""

    provider_id = "ollama"

    def __init__(self, client: OllamaClient) -> None:
        self._client = client

    @property
    def dims(self) -> int:
        return self._client.embed_dims

    async def embed(
        self,
        texts: Sequence[str],
        *,
        api_key: str | None = None,
        input_type: str | None = None,
    ) -> list[list[float]]:
        return await self._client.embed(list(texts))

    async def ping(self) -> bool:
        return await self._client.ping()


class OpenRouterEmbedder:
    """Cloud embeddings (OpenRouter or NVIDIA NIM), e.g. Nemotron 3 Embed 1B."""

    def __init__(self, client: OpenRouterClient) -> None:
        self._client = client

    @property
    def provider_id(self) -> str:
        return self._client.provider_id

    @property
    def model(self) -> str:
        return self._client.embed_model

    @property
    def dims(self) -> int:
        return self._client.embed_dims

    async def embed(
        self,
        texts: Sequence[str],
        *,
        api_key: str | None = None,
        input_type: str | None = None,
    ) -> list[list[float]]:
        return await self._client.embed(texts, api_key=api_key, input_type=input_type)

    async def ping(self) -> bool:
        return await self._client.ping()


# NVIDIA NIM embeddings share the same OpenAI-compatible client.
NvidiaEmbedder = OpenRouterEmbedder
