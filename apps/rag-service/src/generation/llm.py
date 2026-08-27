"""Pluggable chat LLM providers: Ollama (self-hosted) and Google Gemini (cloud).

Providers implement a common async interface (`chat_stream`, `complete`,
`aclose`) so the query pipeline can swap them per request. Embeddings are
always produced locally by the Ollama embedder.
"""
from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from typing import Protocol

import httpx

from src.config import settings

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 180.0
GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"


class ChatLLM(Protocol):
    """Interface implemented by every chat provider."""

    provider_id: str

    async def chat_stream(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float = 0.2,
        max_tokens: int = 1024,
        api_key: str | None = None,
    ) -> AsyncIterator[str]: ...

    async def complete(
        self,
        prompt: str,
        *,
        temperature: float = 0.2,
        max_tokens: int = 512,
        api_key: str | None = None,
    ) -> str: ...

    async def aclose(self) -> None: ...

    async def ping(self) -> bool: ...


class OllamaClient:
    """Self-hosted Ollama: chat streaming + completions + embeddings."""

    provider_id = "ollama"

    def __init__(
        self,
        base_url: str,
        chat_model: str,
        embed_model: str,
        embed_dims: int,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.chat_model = chat_model
        self.embed_model = embed_model
        self.embed_dims = embed_dims
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(timeout))

    async def chat_stream(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float = 0.2,
        max_tokens: int = 1024,
        api_key: str | None = None,
    ) -> AsyncIterator[str]:
        async with self._client.stream(
            "POST",
            f"{self.base_url}/api/chat",
            json={
                "model": self.chat_model,
                "messages": messages,
                "stream": True,
                "options": {
                    "temperature": temperature,
                    "num_predict": max_tokens,
                },
            },
        ) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line:
                    continue
                try:
                    data = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if data.get("error"):
                    raise RuntimeError(data["error"])
                delta = data.get("message", {}).get("content", "")
                if delta:
                    yield delta
                if data.get("done"):
                    return

    async def complete(self, prompt: str, *, temperature: float = 0.2, max_tokens: int = 512, api_key: str | None = None) -> str:
        chunks: list[str] = []
        async for delta in self.chat_stream(
            [{"role": "user", "content": prompt}],
            temperature=temperature,
            max_tokens=max_tokens,
            api_key=api_key,
        ):
            chunks.append(delta)
        return "".join(chunks)

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        resp = await self._client.post(
            f"{self.base_url}/api/embed",
            json={"model": self.embed_model, "input": texts},
        )
        resp.raise_for_status()
        return resp.json()["embeddings"]

    async def embed_one(self, text: str) -> list[float]:
        return (await self.embed([text]))[0]

    async def ping(self) -> bool:
        try:
            resp = await self._client.get(f"{self.base_url}/api/tags")
            return resp.status_code == 200
        except Exception:  # noqa: BLE001
            return False

    async def aclose(self) -> None:
        await self._client.aclose()


class GeminiClient:
    """Google Gemini via the Generative Language API (AI Studio free key)."""

    provider_id = "gemini"

    def __init__(
        self,
        api_key: str,
        model: str,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        self.api_key = api_key
        self.model = model
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(timeout))

    def _url(self, action: str) -> str:
        return f"{GEMINI_BASE_URL}/models/{self.model}:{action}?alt=sse&key={self.api_key}"

    @staticmethod
    def _build_request(
        messages: list[dict[str, str]],
        temperature: float,
        max_tokens: int,
    ) -> dict:
        """Transform pipeline messages into the Gemini contents format.

        A leading `system` message becomes `systemInstruction`; `user`/`assistant`
        roles map to Gemini's `user`/`model`.
        """
        system = ""
        contents: list[dict] = []
        for msg in messages:
            role = msg.get("role", "user")
            text = msg.get("content") or ""
            if role == "system":
                system = (system + "\n\n" + text).strip()
                continue
            contents.append(
                {
                    "role": "model" if role == "assistant" else "user",
                    "parts": [{"text": text}],
                }
            )
        body: dict = {"contents": contents, "generationConfig": {"temperature": temperature, "maxOutputTokens": max_tokens}}
        if system:
            body["systemInstruction"] = {"parts": [{"text": system}]}
        return body

    def _extract(self, payload: dict) -> str:
        text = ""
        candidates = payload.get("candidates") or []
        if candidates:
            content = candidates[0].get("content") or {}
            for part in content.get("parts") or []:
                text += part.get("text") or ""
        return text

    async def chat_stream(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float = 0.2,
        max_tokens: int = 1024,
        api_key: str | None = None,
    ) -> AsyncIterator[str]:
        async with self._client.stream(
            "POST",
            self._url("streamGenerateContent"),
            json=self._build_request(messages, temperature, max_tokens),
        ) as resp:
            if resp.status_code >= 400:
                body = (await resp.aread()).decode()[:500]
                raise RuntimeError(f"Gemini API {resp.status_code}: {body}")
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                raw = line[5:].strip()
                if not raw or raw == "[DONE]":
                    continue
                try:
                    payload = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                delta = self._extract(payload)
                if delta:
                    yield delta

    async def complete(self, prompt: str, *, temperature: float = 0.2, max_tokens: int = 512, api_key: str | None = None) -> str:
        chunks: list[str] = []
        async for delta in self.chat_stream(
            [{"role": "user", "content": prompt}],
            temperature=temperature,
            max_tokens=max_tokens,
            api_key=api_key,
        ):
            chunks.append(delta)
        return "".join(chunks)

    async def ping(self) -> bool:
        try:
            resp = await self._client.get(f"{GEMINI_BASE_URL}/models?key={self.api_key}")
            return resp.status_code == 200
        except Exception:  # noqa: BLE001
            return False

    async def aclose(self) -> None:
        await self._client.aclose()


def build_chat_llm(
    provider: str,
    *,
    ollama_base_url: str,
    ollama_chat_model: str,
    ollama_embed_model: str,
    ollama_embed_dims: int,
    gemini_api_key: str,
    gemini_model: str,
    openai_api_key: str = "",
    openai_model: str | None = None,
    openai_base_url: str = "",
    xai_api_key: str = "",
    xai_model: str | None = None,
    xai_base_url: str = "",
    openrouter_api_key: str = "",
    openrouter_model: str | None = None,
    openrouter_base_url: str = "",
    openrouter_rerank_base_url: str = "",
    openrouter_rerank_model: str = "",
    nvidia_api_key: str = "",
    nvidia_model: str | None = None,
    nvidia_base_url: str = "",
    nvidia_rerank_base_url: str = "",
    nvidia_rerank_model: str = "",
    omniroute_api_key: str = "",
    omniroute_model: str | None = None,
    opencode_api_key: str = "",
    opencode_model: str | None = None,
    opencode_base_url: str = "",
    model: str | None = None,
    api_key: str | None = None,
) -> ChatLLM:
    """Build a chat LLM client for the requested provider (defaults from config)."""
    provider = (provider or "ollama").lower().strip()
    if provider == "opencode":
        from src.generation.openrouter import OpenRouterClient

        key = api_key or opencode_api_key
        if not key:
            raise ValueError("no OpenCode API key available for the request")
        return OpenRouterClient(
            api_key=key,
            model=model or opencode_model or "",
            provider_id="opencode",
            name="OpenCode Zen",
            base_url=opencode_base_url or settings.opencode_base_url,
        )
    if provider == "omniroute":
        from src.generation.openrouter import OpenRouterClient

        return OpenRouterClient(
            api_key=api_key or omniroute_api_key or "omniroute",
            model=model or omniroute_model or "auto",
            provider_id="omniroute",
            name="OmniRoute",
            base_url=settings.omniroute_base_url,
        )
    if provider == "openrouter":
        from src.generation.openrouter import OpenRouterClient

        key = api_key or openrouter_api_key
        if not key:
            raise ValueError("no OpenRouter API key available for the request")
        return OpenRouterClient(
            api_key=key,
            model=model or openrouter_model or "",
            provider_id="openrouter",
            name="OpenRouter",
            base_url=openrouter_base_url or settings.openrouter_base_url,
            rerank_url=openrouter_rerank_base_url or settings.openrouter_base_url,
        )
    if provider == "nvidia":
        from src.generation.openrouter import OpenRouterClient

        key = api_key or nvidia_api_key
        if not key:
            raise ValueError("no NVIDIA API key available for the request")
        return OpenRouterClient(
            api_key=key,
            model=model or nvidia_model or "",
            provider_id="nvidia",
            name="NVIDIA NIM",
            base_url=nvidia_base_url or settings.nvidia_base_url,
            rerank_url=nvidia_rerank_base_url or settings.nvidia_rerank_base_url,
            rerank_style="nvidia",
        )
    if provider == "gemini":
        key = api_key or gemini_api_key
        if not key:
            raise ValueError("no Gemini API key available for the request (GEMINI_API_KEY or a saved user key)")
        return GeminiClient(api_key=key, model=model or gemini_model)
    if provider == "openai":
        from src.generation.openrouter import OpenRouterClient

        key = api_key or openai_api_key
        if not key:
            raise ValueError("no OpenAI API key available for the request")
        return OpenRouterClient(
            api_key=key,
            model=model or openai_model or "",
            provider_id="openai",
            name="OpenAI",
            base_url=openai_base_url or settings.openai_base_url,
        )
    if provider == "xai":
        from src.generation.openrouter import OpenRouterClient

        key = api_key or xai_api_key
        if not key:
            raise ValueError("no xAI API key available for the request")
        return OpenRouterClient(
            api_key=key,
            model=model or xai_model or "",
            provider_id="xai",
            name="xAI Grok",
            base_url=xai_base_url or settings.xai_base_url,
        )
    if provider == "ollama":
        return OllamaClient(
            base_url=ollama_base_url,
            chat_model=model or ollama_chat_model,
            embed_model=ollama_embed_model,
            embed_dims=ollama_embed_dims,
        )
    raise ValueError(f"unknown LLM provider: {provider} (expected 'ollama', 'openrouter', 'nvidia', 'openai', 'xai', 'gemini', 'opencode' or 'omniroute')")
