"""OpenAI-compatible cloud client: chat streaming, completions, embeddings, rerank.

Backs the OpenRouter provider (default) and the NVIDIA NIM provider (chat and
embeddings via integrate.api.nvidia.com, rerank via the dedicated retrieval
endpoint). The two providers share this client because they speak the same
chat/embeddings dialect; only the rerank payload/response differ, selected by
``rerank_style``. Raw HTTP errors are mapped to human-friendly messages so
failures surface cleanly in the UI instead of as cryptic JSON blobs.
"""
from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator, Sequence

import httpx

from src.config import settings

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 240.0
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"


def _friendly_error(status: int, provider: str, detail: str = "") -> str:
    detail = (detail or "").strip()
    mapping = {
        400: f"{provider} rejected the request (400)",
        401: f"invalid {provider} API key — update it in Settings",
        402: f"your {provider} key has no remaining credits",
        404: "the selected model is not available on this provider",
        408: f"{provider} timed out — please retry",
        429: f"{provider} rate limit reached — wait a moment and retry",
        500: f"{provider} hit a server error (500) — retry shortly",
        502: f"the upstream {provider} provider failed (502) — retry shortly",
        503: f"{provider} service is unavailable (503) — retry shortly",
        504: f"the upstream {provider} provider timed out (504)",
        529: f"the {provider} provider is overloaded — retry shortly",
    }
    message = mapping.get(status, f"{provider} error {status}")
    return f"{message}: {detail}" if detail else message


def _extract_error(payload: dict) -> str:
    err = payload.get("error")
    if isinstance(err, dict):
        return err.get("message") or err.get("code") or ""
    return str(err or "")


class OpenRouterClient:
    """Implements the ChatLLM protocol plus embed/rerank used by the pipeline."""

    def __init__(
        self,
        api_key: str,
        model: str,
        embed_model: str | None = None,
        embed_dims: int | None = None,
        provider_id: str = "openrouter",
        name: str = "OpenRouter",
        base_url: str = OPENROUTER_BASE_URL,
        rerank_url: str | None = None,
        rerank_style: str = "openrouter",
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        self.provider_id = provider_id
        self.name = name
        self.api_key = api_key
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.rerank_url = (rerank_url or self.base_url).rstrip("/")
        self.rerank_style = rerank_style
        if provider_id == "nvidia":
            self.embed_model = embed_model or settings.nvidia_embed_model
            self.embed_dims = embed_dims or settings.nvidia_embed_dims
        else:
            self.embed_model = embed_model or settings.openrouter_embed_model
            self.embed_dims = embed_dims or settings.openrouter_embed_dims
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(timeout))

    def _headers(self, api_key: str | None = None) -> dict[str, str]:
        token = (api_key or self.api_key or "").strip()
        headers: dict[str, str] = {
            "content-type": "application/json",
            "x-title": "smoke-monkey",
        }
        # Only attach the bearer header when a key actually exists. Sending
        # `Authorization: Bearer ` crashes httpx with "Illegal header value"
        # and a keyless request is refused upstream anyway.
        if token:
            headers["authorization"] = f"Bearer {token}"
        return headers

    def _friendly(self, status: int, detail: str = "") -> str:
        return _friendly_error(status, self.name, detail)

    # ── chat / completions ─────────────────────────────────────────────────
    async def chat_stream(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float = 0.2,
        max_tokens: int = 1024,
        api_key: str | None = None,
    ) -> AsyncIterator[str]:
        payload = {
            "model": self.model,
            "messages": messages,
            "stream": True,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        try:
            async with self._client.stream(
                "POST",
                f"{self.base_url}/chat/completions",
                json=payload,
                headers=self._headers(api_key),
            ) as resp:
                if resp.status_code >= 400:
                    body = (await resp.aread()).decode(errors="replace")[:500]
                    raise RuntimeError(self._friendly(resp.status_code, body))
                async for line in resp.aiter_lines():
                    line = line.strip()
                    if not line.startswith("data:"):
                        continue
                    raw = line[5:].strip()
                    if not raw or raw == "[DONE]":
                        continue
                    try:
                        data = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    if data.get("error"):
                        raise RuntimeError(self._friendly(0, _extract_error(data)))
                    choices = data.get("choices") or []
                    if not choices:
                        continue
                    delta = (choices[0].get("delta") or {}).get("content")
                    if delta:
                        yield delta
                    if choices[0].get("finish_reason"):
                        return
        except httpx.HTTPError as exc:
            raise RuntimeError(f"{self.name} is unreachable: {exc}") from exc

    async def complete(
        self,
        prompt: str,
        *,
        temperature: float = 0.2,
        max_tokens: int = 512,
        api_key: str | None = None,
    ) -> str:
        parts: list[str] = []
        async for delta in self.chat_stream(
            [{"role": "user", "content": prompt}],
            temperature=temperature,
            max_tokens=max_tokens,
            api_key=api_key,
        ):
            parts.append(delta)
        return "".join(parts)

    # ── embeddings ─────────────────────────────────────────────────────────
    async def embed(
        self,
        texts: Sequence[str],
        *,
        api_key: str | None = None,
        input_type: str | None = None,
        batch_size: int = 32,
    ) -> list[list[float]]:
        if not texts:
            return []
        results: list[list[float]] = []
        for i in range(0, len(texts), batch_size):
            batch = list(texts[i : i + batch_size])
            payload: dict = {"model": self.embed_model, "input": batch, "encoding_format": "float"}
            if input_type:
                payload["input_type"] = input_type
            resp = await self._client.post(
                f"{self.base_url}/embeddings",
                json=payload,
                headers=self._headers(api_key),
            )
            if resp.status_code >= 400:
                body = resp.text[:500]
                if resp.status_code == 400 and input_type and "input_type" in body.lower():
                    payload.pop("input_type", None)
                    resp = await self._client.post(
                        f"{self.base_url}/embeddings",
                        json=payload,
                        headers=self._headers(api_key),
                    )
                    if resp.status_code < 400:
                        body = ""
                if resp.status_code >= 400:
                    raise RuntimeError(self._friendly(resp.status_code, _extract_error(resp.json())))
            data = resp.json()
            for item in data.get("data") or []:
                emb = item.get("embedding") or []
                if self.embed_dims and len(emb) != self.embed_dims:
                    logger.warning(
                        "embedding dim mismatch: got %d, expected %d", len(emb), self.embed_dims
                    )
                results.append(emb)
        return results

    async def embed_one(
        self,
        text: str,
        *,
        api_key: str | None = None,
        input_type: str | None = None,
    ) -> list[float]:
        return (await self.embed([text], api_key=api_key, input_type=input_type))[0]

    # ── rerank ─────────────────────────────────────────────────────────────
    async def rerank(
        self,
        query: str,
        texts: Sequence[str],
        top_n: int,
        *,
        api_key: str | None = None,
    ) -> list[tuple[int, float]]:
        """Rerank `texts` against `query`; returns (index, relevance_score)."""
        if not texts:
            return []
        if self.rerank_style == "nvidia":
            payload = {
                "model": settings.nvidia_rerank_model,
                "query": {"text": query},
                "passages": [{"text": t} for t in texts],
                "truncate": "END",
            }
            resp = await self._client.post(
                f"{self.rerank_url}/reranking",
                json=payload,
                headers=self._headers(api_key),
            )
            if resp.status_code >= 400:
                raise RuntimeError(self._friendly(resp.status_code, _extract_error(resp.json())))
            data = resp.json()
            out: list[tuple[int, float]] = []
            for item in data.get("rankings") or []:
                out.append((int(item.get("index", 0)), float(item.get("logit", 0.0))))
            return out

        payload = {
            "model": settings.openrouter_rerank_model,
            "query": query,
            "documents": list(texts),
            "top_n": top_n,
        }
        resp = await self._client.post(
            f"{self.base_url}/rerank",
            json=payload,
            headers=self._headers(api_key),
        )
        if resp.status_code >= 400:
            raise RuntimeError(self._friendly(resp.status_code, _extract_error(resp.json())))
        data = resp.json()
        out = []
        for item in data.get("results") or []:
            out.append((int(item.get("index", 0)), float(item.get("relevance_score", 0.0))))
        return out

    # ── health ─────────────────────────────────────────────────────────────
    async def ping(self) -> bool:
        try:
            resp = await self._client.get(f"{self.base_url}/models")
            return resp.status_code < 500
        except Exception:  # noqa: BLE001
            return False

    async def aclose(self) -> None:
        await self._client.aclose()
