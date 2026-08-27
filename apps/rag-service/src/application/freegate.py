"""Built-in free-model gateway for the desktop app.

The cloud stack expects a separately-installed OmniRoute proxy on
``OMNIROUTE_BASE_URL`` (localhost:20128). Desktop users will not install that,
so in local mode the rag-service itself serves the OmniRoute-compatible
surface (``/v1/chat/completions``, ``/v1/models``) and routes free models to
whichever provider the user already holds a BYOK key for:

- ``auto`` / ``auto/best-free``  → first available key: NVIDIA, then OpenRouter,
  then OpenCode Zen;
- any catalog id (``big-pickle``, ``deepseek-v4-flash-free``,
  ``nvidia/nemotron-3-nano-30b-a3b``, …) → its owning provider;
- unknown ids / ``:free``-suffixed ids → OpenRouter (pass-through), so the
  whole OpenRouter ``:free`` tier works without a hand-maintained list.

The model list served by ``/v1/models`` is the full free catalog: the curated
NVIDIA + OpenCode free tier, plus OpenRouter's live ``:free`` list (cached
briefly). A request is answered only if the chosen provider has a key;
otherwise a friendly 401 explains that free mode needs one free API key
(added in Keys). The upstream response is proxied verbatim (OpenAI-compatible,
streaming SSE).
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from src.config import settings
from src.keys import resolve_user_api_key

logger = logging.getLogger(__name__)

# model id accepted by the gateway  →  (provider, upstream model id)
FREE_MODEL_CATALOG: dict[str, tuple[str, str]] = {
    # OpenCode Zen free tier (no usage cost, rate-limited)
    "big-pickle": ("opencode", "big-pickle"),
    "deepseek-v4-flash-free": ("opencode", "deepseek-v4-flash-free"),
    "mimo-v2.5-free": ("opencode", "mimo-v2.5-free"),
    "nemotron-3-ultra-free": ("opencode", "nemotron-3-ultra-free"),
    "laguna-s-2.1-free": ("opencode", "laguna-s-2.1-free"),
    # NVIDIA NIM free tier
    "nvidia/nemotron-3-nano-30b-a3b": ("nvidia", "nvidia/nemotron-3-nano-30b-a3b"),
    "nvidia/nemotron-3-super-120b-a12b": ("nvidia", "nvidia/nemotron-3-super-120b-a12b"),
    "nvidia/nemotron-3-ultra-550b-a55b": ("nvidia", "nvidia/nemotron-3-ultra-550b-a55b"),
    "nvidia/llama-nemotron-ultra-8b": ("nvidia", "nvidia/llama-nemotron-ultra-8b"),
    "nvidia/llama-nemotron-super-27b": ("nvidia", "nvidia/llama-nemotron-super-27b"),
    # popular OpenRouter :free models (full live list is appended dynamically)
    "deepseek/deepseek-v4-flash:free": ("openrouter", "deepseek/deepseek-v4-flash:free"),
    "nvidia/nemotron-3-ultra-550b-a55b:free": ("openrouter", "nvidia/nemotron-3-ultra-550b-a55b:free"),
    "google/gemini-2.0-flash-lite:free": ("openrouter", "google/gemini-2.0-flash-lite:free"),
    "meta-llama/llama-4-scout-17b-16e:free": ("openrouter", "meta-llama/llama-4-scout-17b-16e:free"),
    "mistralai/mistral-small-3.2:free": ("openrouter", "mistralai/mistral-small-3.2:free"),
}

FREE_MODEL_IDS: list[str] = list(FREE_MODEL_CATALOG)

# model used for `auto` when a provider has a key
_PROVIDER_DEFAULT: dict[str, str] = {
    "nvidia": "nvidia/nemotron-3-nano-30b-a3b",
    "openrouter": "nvidia/nemotron-3-ultra-550b-a55b:free",
    "opencode": "deepseek-v4-flash-free",
}

# key-probe order for `auto`
_AUTO_PRIORITY = ["nvidia", "openrouter", "opencode"]

_PROVIDER_BASE_URL: dict[str, str] = {
    "nvidia": settings.nvidia_base_url,
    "openrouter": settings.openrouter_base_url,
    "opencode": settings.opencode_base_url,
}

# live OpenRouter :free list cache (id → (provider, model)); refreshed ≤10 min
_LIVE_FREE_MODELS: dict[str, tuple[str, str]] = {}
_LIVE_FREE_MODELS_AT = 0.0
_LIVE_FREE_MODELS_LOCK: Any = None


def provider_models(provider: str) -> list[str]:
    """Curated free model ids for `provider` (used by the picker)."""
    if provider == "nvidia":
        return [
            "nvidia/nemotron-3-nano-30b-a3b",
            "nvidia/nemotron-3-super-120b-a12b",
            "nvidia/nemotron-3-ultra-550b-a55b",
        ]
    if provider == "opencode":
        return [
            "big-pickle",
            "deepseek-v4-flash-free",
            "mimo-v2.5-free",
            "nemotron-3-ultra-free",
            "laguna-s-2.1-free",
        ]
    return ["nvidia/nemotron-3-ultra-550b-a55b:free", "auto"]


def _route_for(model: str) -> tuple[str, str] | None:
    """Map a requested model id to ``(provider, upstream_model)``."""
    model = (model or "auto").strip().strip('"')
    if model in ("auto", "auto/best-free", ""):
        return None  # resolved lazily once keys are known
    catalog = FREE_MODEL_CATALOG.get(model)
    if catalog:
        return catalog
    if model.startswith("nvidia/"):
        return ("nvidia", model)
    if model.endswith(":free"):
        return ("openrouter", model)
    # Unknown / vendor-prefixed ids pass through OpenRouter.
    return ("openrouter", model)


def _first_provider_with_key(keys: dict[str, str]) -> tuple[str, str]:
    for provider in _AUTO_PRIORITY:
        if keys.get(provider):
            return provider, _PROVIDER_DEFAULT[provider]
    return "", ""


async def _keys(redis, user_id: str) -> dict[str, str]:
    keys: dict[str, str] = {}
    for provider in ("nvidia", "openrouter", "opencode", "omniroute"):
        key = await resolve_user_api_key(
            redis,
            user_id,
            provider,
            server_default={
                "nvidia": settings.nvidia_api_key,
                "openrouter": settings.openrouter_api_key,
                "opencode": settings.opencode_api_key,
            }.get(provider, ""),
        )
        if key:
            keys[provider] = key
    return keys


def _base_url(provider: str) -> str:
    return (_PROVIDER_BASE_URL.get(provider) or settings.openrouter_base_url).rstrip("/")


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={
            "error": {
                "message": message,
                "type": "free_gateway",
                "code": "free_gateway",
            }
        },
    )


router = APIRouter(tags=["free-gateway"])


async def _live_openrouter_free() -> dict[str, tuple[str, str]]:
    """Best-effort live OpenRouter ``:free`` model list, cached for 10 minutes.

    ``:free`` ids aren't in the static catalog, so without this the picker
    would show only the hand-curated subset. Routing already accepts any
    ``:free`` id (``_route_for``), so this only feeds the model list.
    """
    global _LIVE_FREE_MODELS, _LIVE_FREE_MODELS_AT, _LIVE_FREE_MODELS_LOCK
    if _LIVE_FREE_MODELS_LOCK is None:
        import asyncio

        _LIVE_FREE_MODELS_LOCK = asyncio.Lock()
    if time.monotonic() - _LIVE_FREE_MODELS_AT < 600 and _LIVE_FREE_MODELS:
        return _LIVE_FREE_MODELS
    async with _LIVE_FREE_MODELS_LOCK:
        if time.monotonic() - _LIVE_FREE_MODELS_AT < 600 and _LIVE_FREE_MODELS:
            return _LIVE_FREE_MODELS
        fresh: dict[str, tuple[str, str]] = {}
        try:
            headers = {"content-type": "application/json"}
            if settings.openrouter_api_key:
                headers["authorization"] = f"Bearer {settings.openrouter_api_key}"
            async with httpx.AsyncClient(timeout=httpx.Timeout(8.0)) as client:
                resp = await client.get(
                    f"{settings.openrouter_base_url.rstrip('/')}/models",
                    headers=headers,
                )
                resp.raise_for_status()
            for item in (resp.json().get("data") or []):
                model_id = str(item.get("id") or "").strip()
                if not model_id or model_id in FREE_MODEL_CATALOG:
                    continue
                pricing = item.get("pricing") or {}
                is_free = model_id.endswith(":free") or (
                    str(pricing.get("prompt", "")) == "0"
                    and str(pricing.get("completion", "")) == "0"
                )
                if is_free:
                    fresh[model_id] = ("openrouter", model_id)
        except Exception as exc:  # noqa: BLE001 - live list is best-effort
            logger.debug("live OpenRouter free list unavailable: %s", exc)
        if fresh:
            _LIVE_FREE_MODELS = fresh
            _LIVE_FREE_MODELS_AT = time.monotonic()
        return fresh or _LIVE_FREE_MODELS


@router.get("/v1/models")
async def free_models() -> dict[str, Any]:
    """OpenAI-compatible free-model list (the OmniRoute-compatible surface)."""
    merged: dict[str, tuple[str, str]] = {**FREE_MODEL_CATALOG}
    merged.update(await _live_openrouter_free())
    data = [
        {
            "id": model_id,
            "object": "model",
            "created": 0,
            "owned_by": provider,
            "isFree": True,
        }
        for model_id, (provider, _) in merged.items()
    ]
    return {"object": "list", "data": data}


@router.post("/v1/chat/completions")
async def free_chat_completions(request: Request) -> Any:
    """Proxy a chat request to the best free model the user has a key for."""
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return _error(400, "Invalid JSON body")
    if not isinstance(body, dict):
        return _error(400, "Expected a JSON object")

    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        return _error(400, "`messages` must be a non-empty list")
    stream = bool(body.get("stream", False))
    requested = str(body.get("model") or "auto")

    redis = getattr(request.app.state, "redis", None)
    user_id = settings.local_user_id
    keys = await _keys(redis, user_id)

    route = _route_for(requested)
    if route is None:  # auto → first provider with a key
        provider, model = _first_provider_with_key(keys)
        if not provider:
            hint = (
                "add a free NVIDIA, OpenRouter or OpenCode key in the Keys menu "
                "(or an OmniRoute key) — all of them enable free mode"
            )
            if keys.get("omniroute"):
                hint = (
                    "an OmniRoute key is saved, but free mode still needs one "
                    "free provider key (NVIDIA/OpenRouter/OpenCode) to reach a model"
                )
            return _error(401, f"Free mode needs a free API key — {hint}.")
    else:
        provider, model = route

    api_key = keys.get(provider)
    if not api_key:
        if provider == "opencode":
            hint = "an OpenCode Zen key (free signup at opencode.ai)"
        elif provider == "nvidia":
            hint = "a free NVIDIA NIM key (build.nvidia.com)"
        else:
            hint = "a free OpenRouter key (openrouter.ai)"
        return _error(
            401,
            f"Free model '{requested}' needs {hint} — add it in the Keys menu.",
        )

    url = f"{_base_url(provider)}/chat/completions"
    payload: dict[str, Any] = {k: v for k, v in body.items() if k != "model"}
    payload["model"] = model
    headers = {"content-type": "application/json", "authorization": f"Bearer {api_key}"}

    async def proxy_stream():
        async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=10.0)) as client:
            try:
                async with client.stream("POST", url, json=payload, headers=headers) as resp:
                    if resp.status_code >= 400:
                        detail = (await resp.aread()).decode("utf-8", "replace")
                        yield f"data: {json.dumps({'error': {'message': detail[:400], 'type': 'upstream'}})}\n\n"
                        yield "data: [DONE]\n\n"
                        return
                    async for line in resp.aiter_lines():
                        if not line:
                            yield "\n\n"
                            continue
                        yield line + "\n"
            except Exception as exc:  # noqa: BLE001
                logger.warning("free gateway upstream error: %s", exc)
                yield f"data: {json.dumps({'error': {'message': f'upstream error: {exc}', 'type': 'free_gateway'}})}\n\n"
                yield "data: [DONE]\n\n"

    async def proxy_json():
        async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=10.0)) as client:
            try:
                resp = await client.post(url, json=payload, headers=headers)
            except Exception as exc:  # noqa: BLE001
                logger.warning("free gateway upstream error: %s", exc)
                return _error(502, f"Free model '{requested}' unreachable: {exc}")
            if resp.status_code >= 400:
                return _error(resp.status_code, resp.text[:400])
            return JSONResponse(status_code=200, content=resp.json())

    if stream:
        return StreamingResponse(
            proxy_stream(),
            media_type="text/event-stream",
            headers={"cache-control": "no-cache", "x-accel-buffering": "no"},
        )
    return await proxy_json()
