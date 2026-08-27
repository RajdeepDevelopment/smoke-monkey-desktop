"""Desktop BYOK keys API (local mode only).

Mirrors the api-gateway's ``/keys`` contract so the desktop web UI works
unchanged: users paste their own provider API keys (OpenRouter, OpenAI, xAI,
Gemini, NVIDIA, ...) — exactly how the cloud edition works — instead of being
forced to run a GPU. Keys are stored in the local ``keys.db`` and mirrored into
the local cache under the same ``rag:user_key:{user_id}:{provider}`` keys the
document-worker already resolves.

Ollama remains a first-class, optional model choice (users with a local Ollama
can keep using it keyless); it is never required.

In cloud mode these endpoints return HTTP 501 — the api-gateway owns keys
there.
"""
from __future__ import annotations

import logging
import re
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from src.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/keys", tags=["keys"])

SUPPORTED_PROVIDERS = {
    "openrouter",
    "nvidia",
    "openai",
    "xai",
    "gemini",
    "opencode",
    "omniroute",
    "tavily",
    "google",
    "brave",
    "bing",
}

_KEY_PATTERNS: dict[str, re.Pattern[str] | str] = {
    "openrouter": "sk-or-v1-",
    "nvidia": "nvapi-",
    "openai": re.compile(r"^sk-(proj-)?[A-Za-z0-9_-]{20,}$"),
    "xai": re.compile(r"^xai-[A-Za-z0-9_-]{16,}$"),
    "gemini": re.compile(r"^[A-Za-z0-9._-]{16,128}$"),
    "google": re.compile(r"^[A-Za-z0-9._-]{16,128}$"),
    "bing": re.compile(r"^[A-Za-z0-9]{24,40}$"),
    "tavily": "tvly-",
    "brave": "BSA",
}

_KEY_HINTS: dict[str, str] = {
    "openrouter": 'it should start with "sk-or-v1-". Get one at openrouter.ai/keys',
    "nvidia": 'it should start with "nvapi-". Get one at build.nvidia.com',
    "openai": 'it should start with "sk-". Get one at platform.openai.com/api-keys',
    "xai": 'it should start with "xai-". Get one at console.x.ai',
    "gemini": "it is an alphanumeric string (may include dots, dashes, underscores). Get one free at aistudio.google.com/apikey",
    "opencode": "it is too short. Get one by signing in at opencode.ai/zen",
    "tavily": 'it should start with "tvly-". Get one at app.tavily.com',
    "brave": 'it should start with "BSA". Get one at brave.com/search/api/',
    "google": "it is an alphanumeric string. Get one at console.cloud.google.com",
    "bing": "it is a 32-character string. Get one at azure.microsoft.com",
}

_OPENROUTER_AUTH_URL = "https://openrouter.ai/api/v1/auth/key"
_NVIDIA_CHAT_URL = "https://integrate.api.nvidia.com/v1/chat/completions"
_OPENAI_MODELS_URL = "https://api.openai.com/v1/models"
_XAI_MODELS_URL = "https://api.x.ai/v1/models"
_GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models"
_OPENCODE_MODELS_URL = "https://opencode.ai/zen/v1/models"


class SaveKeyRequest(BaseModel):
    apiKey: str


class _State:
    """Minimal holder so handlers read the same app.state fields as documents."""

    def __init__(self, request: Request) -> None:
        self.keys = request.app.state.keys
        self.redis = request.app.state.redis
        if self.keys is None or self.redis is None:
            raise HTTPException(status_code=503, detail="local storage not initialized")


def _require_local() -> None:
    if settings.storage_mode != "local":
        raise HTTPException(
            status_code=501,
            detail="API keys are managed by the gateway in cloud mode",
        )


def assert_key_format(provider: str, api_key: str) -> str:
    """Reject obviously-invalid keys before storing (gateway parity)."""
    key = api_key.strip()
    if not key:
        raise HTTPException(status_code=400, detail="API key is required")
    if len(key) < 16 and provider != "opencode":
        raise HTTPException(status_code=400, detail="that does not look like a valid API key (too short)")
    if provider == "omniroute":
        return key  # keyless
    pattern = _KEY_PATTERNS.get(provider)
    hint = _KEY_HINTS.get(provider, "")
    if isinstance(pattern, str):
        if not key.startswith(pattern):
            raise HTTPException(status_code=400, detail=f"invalid {provider} key — {hint}")
    elif pattern is not None and not pattern.match(key):
        raise HTTPException(status_code=400, detail=f"invalid {provider} key — {hint}")
    elif provider == "opencode" and len(key) < 8:
        raise HTTPException(status_code=400, detail=f"invalid {provider} key — {hint}")
    return key


async def validate_provider_key(provider: str, api_key: str) -> dict[str, Any] | None:
    """Live-check the key with its provider (network hiccups don't block saving)."""
    headers = {"authorization": f"Bearer {api_key}"}
    urls: dict[str, tuple[str, str | None, dict[str, Any]]] = {
        "openrouter": ("GET", _OPENROUTER_AUTH_URL, headers),
        "openai": ("GET", _OPENAI_MODELS_URL, headers),
        "xai": ("GET", _XAI_MODELS_URL, headers),
        "opencode": ("GET", _OPENCODE_MODELS_URL, headers),
        "nvidia": (
            "POST",
            _NVIDIA_CHAT_URL,
            {
                "authorization": f"Bearer {api_key}",
                "content-type": "application/json",
            },
        ),
        "gemini": (
            "GET",
            f"{_GEMINI_MODELS_URL}?key={api_key}",
            {},
        ),
    }
    spec = urls.get(provider)
    if spec is None:
        return None  # web-search providers: validated lazily at use-time
    method, url, hdrs = spec
    try:
        if method == "POST":
            res = await httpx.AsyncClient().post(
                url,
                headers=hdrs,
                json={
                    "model": "nvidia/nemotron-3-nano-30b-a3b",
                    "messages": [{"role": "user", "content": "ping"}],
                    "max_tokens": 1,
                },
                timeout=10,
            )
        else:
            res = await httpx.AsyncClient().get(url, headers=hdrs, timeout=10)
    except httpx.HTTPError:
        logger.warning("key validation request failed for %s (network)", provider)
        return None
    if res.status_code == 200:
        return {"label": provider, "isFreeTier": provider == "gemini"}
    if res.status_code in (401, 403):
        raise HTTPException(status_code=400, detail=f"invalid {provider} key — check it with the provider")
    if res.status_code == 402:
        raise HTTPException(status_code=400, detail=f"this {provider} key has no remaining credits")
    if res.status_code == 429:
        raise HTTPException(status_code=400, detail=f"{provider} is rate limiting this key — try again shortly")
    logger.warning("key validation got unexpected status %s for %s", res.status_code, provider)
    return None


@router.get("")
async def list_keys(request: Request, user_id: str = settings.local_user_id) -> dict[str, Any]:
    _require_local()
    state = _State(request)
    return {"keys": await state.keys.list(user_id)}


@router.put("/{provider}")
async def save_key(
    request: Request,
    provider: str,
    body: SaveKeyRequest,
    user_id: str = settings.local_user_id,
) -> dict[str, Any]:
    _require_local()
    if provider not in SUPPORTED_PROVIDERS:
        raise HTTPException(status_code=400, detail=f"unsupported provider '{provider}'")
    key = assert_key_format(provider, body.apiKey)

    state = _State(request)
    try:
        info = await validate_provider_key(provider, key)
    except httpx.HTTPError:
        logger.warning("key validation failed for %s; saving anyway", provider)
        info = None
    summary = await state.keys.set(provider, user_id, key)
    await state.redis.set(state.keys.cache_key(user_id, provider), key)
    return {**summary, "status": "ok", "info": info}


@router.delete("/{provider}")
async def remove_key(
    request: Request,
    provider: str,
    user_id: str = settings.local_user_id,
) -> dict[str, str]:
    _require_local()
    state = _State(request)
    await state.keys.delete(provider, user_id)
    await state.redis.unlink(state.keys.cache_key(user_id, provider))
    return {"status": "ok"}


@router.post("/{provider}/test")
async def test_key(
    request: Request,
    provider: str,
    user_id: str = settings.local_user_id,
) -> dict[str, Any]:
    _require_local()
    state = _State(request)
    key = await state.keys.get(provider, user_id)
    if key is None:
        raise HTTPException(status_code=404, detail="no saved key to test")
    info = await validate_provider_key(provider, key)
    return {"status": "ok", "info": info}
