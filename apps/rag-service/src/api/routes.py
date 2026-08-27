"""HTTP routes: health, streaming query (SSE), feedback."""
from __future__ import annotations

import json
import logging
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from sse_starlette.sse import EventSourceResponse

from src.config import settings
from src.domain import FeedbackRequest, QueryRequest, RetrieveRequest

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1")

# Keyless/free namespaces exposed by the OmniRoute gateway (smart routing via
# "auto"). Used to filter the live /v1/models list to the free tier.
OMNIROUTE_FREE_NAMESPACES = {"oc", "felo", "lc", "groq"}

# Model ids OpenRouter serves that are NOT usable as a chat model in this app
# (embeddings, rerankers, moderation, image/audio/video generation, batch-only
# variants and OpenRouter's "~latest" meta aliases). Used to filter the live
# /v1/models feed into a clean chat-model list.
NON_CHAT_MODEL_MARKERS = (
    "embed",
    "rerank",
    "moderation",
    "whisper",
    "tts",
    "sdxl",
    "stable-diff",
    "dall-e",
    "flux",
    "qwen-image",
    "text-image",
    "suno",
    "music",
    "video",
    ":batch",
)


def _json_default(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump()
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


async def _json_sse(event: dict) -> dict[str, str]:
    return {"event": event["type"], "data": json.dumps(event, default=_json_default)}


@router.get("/health")
async def health(request: Request) -> dict:
    state = request.app.state
    checks = {"embeddings": False, "chat": False, "postgres": False, "redis": False}
    try:
        checks["embeddings"] = await state.embedder.ping()
    except Exception:
        logger.debug("embeddings health probe failed", exc_info=True)
    try:
        checks["chat"] = await state.llm.ping()
    except Exception:
        logger.debug("chat health probe failed", exc_info=True)
    try:
        if state.pool is None:
            # Local mode: no Postgres — the on-disk stores booted with the app.
            checks["postgres"] = True
        else:
            async with state.pool.acquire() as conn:
                await conn.fetchval("SELECT 1")
            checks["postgres"] = True
    except Exception:
        logger.debug("postgres health probe failed", exc_info=True)
    try:
        await state.redis.ping()
        checks["redis"] = True
    except Exception:
        logger.debug("redis health probe failed", exc_info=True)
    healthy = all(checks.values())
    return {"status": "ok" if healthy else "degraded", **checks}


@router.get("/models")
async def models() -> dict:
    """Advertise chat providers, the active embedding/rerank layers and a
    dynamic model catalog so the UI can show what's available per RAG stage.
    The catalog (providers + recommended presets) is data-driven — edit
    `src/config/model_catalog.json` to change it without touching code."""
    catalog = settings.model_catalog
    provider_labels = catalog.get("providers") or {}

    def label(provider_id: str) -> str:
        return (provider_labels.get(provider_id) or {}).get("label") or provider_id.title()

    providers: list[dict] = [
        {
            "id": "ollama",
            "label": "Local (Ollama)",
            "models": [settings.ollama_chat_model],
        }
    ]
    providers.append(
        {
            "id": "openai",
            "label": "OpenAI — ChatGPT",
            "models": [m.strip() for m in settings.openai_chat_models.split(",") if m.strip()]
            or [settings.openai_chat_model],
        }
    )
    providers.append(
        {
            "id": "xai",
            "label": "xAI — Grok",
            "models": [m.strip() for m in settings.xai_chat_models.split(",") if m.strip()]
            or [settings.xai_chat_model],
        }
    )
    providers.append(
        {
            "id": "gemini",
            "label": "Google Gemini",
            "models": [m.strip() for m in settings.gemini_models.split(",") if m.strip()]
            or [settings.gemini_model],
        }
    )
    or_models = [m.strip() for m in settings.openrouter_chat_models.split(",") if m.strip()] or [
        settings.openrouter_chat_model
    ]
    providers.append({"id": "openrouter", "label": "OpenRouter (cloud)", "models": or_models})
    nv_models = [m.strip() for m in settings.nvidia_chat_models.split(",") if m.strip()] or [
        settings.nvidia_chat_model
    ]
    providers.append({"id": "nvidia", "label": "NVIDIA NIM (cloud)", "models": nv_models})
    or_models_free = [
        m.strip() for m in settings.omniroute_chat_models.split(",") if m.strip()
    ] or [settings.omniroute_chat_model]
    providers.append(
        {"id": "omniroute", "label": "OmniRoute (free, keyless)", "models": or_models_free}
    )
    oc_models = [m.strip() for m in settings.opencode_chat_models.split(",") if m.strip()] or [
        settings.opencode_chat_model
    ]
    providers.append(
        {
            "id": "opencode",
            "label": "OpenCode Zen (free)",
            "models": oc_models,
        }
    )

    if settings.embed_provider == "openrouter":
        embedding = {
            "provider": "openrouter",
            "model": settings.openrouter_embed_model,
            "dims": settings.openrouter_embed_dims,
        }
    elif settings.embed_provider == "nvidia":
        embedding = {
            "provider": "nvidia",
            "model": settings.nvidia_embed_model,
            "dims": settings.nvidia_embed_dims,
        }
    else:
        embedding = {
            "provider": "ollama",
            "model": settings.ollama_embed_model,
            "dims": settings.ollama_embed_dims,
        }

    if settings.openrouter_rerank_enabled:
        rerank = {
            "enabled": True,
            "provider": "openrouter",
            "model": settings.openrouter_rerank_model,
        }
    elif settings.nvidia_rerank_enabled:
        rerank = {
            "enabled": True,
            "provider": "nvidia",
            "model": settings.nvidia_rerank_model,
        }
    elif settings.rerank_enabled:
        rerank = {"enabled": True, "provider": "local", "model": settings.rerank_model}
    else:
        rerank = {"enabled": False, "provider": "none", "model": ""}

    def chat_model_entry(model_id: str, provider: str) -> dict:
        return {
            "id": model_id,
            "name": model_id,
            "provider": provider,
            "isFree": model_id.endswith(":free"),
        }

    chat_models = (
        [chat_model_entry(m, "openrouter") for m in or_models]
        + [chat_model_entry(m, "nvidia") for m in nv_models]
        + [chat_model_entry(settings.ollama_chat_model, "ollama")]
        + [{"id": m, "name": m, "provider": "omniroute", "isFree": True} for m in or_models_free]
        + [{"id": m, "name": m, "provider": "opencode", "isFree": True} for m in oc_models]
    )

    # Recommended presets from the dynamic catalog (the "model picker" table).
    presets: list[dict] = []
    for preset in catalog.get("presets") or []:
        entry = dict(preset)
        entry["providerLabel"] = label(entry.get("provider", ""))
        presets.append(entry)

    catalog_models = {
        "chatModels": chat_models,
        "embeddingModels": [
            {"id": "nvidia/nemotron-3-embed-1b", "name": "NVIDIA Nemotron 3 Embed 1B", "provider": "NVIDIA", "dims": 2048, "notes": "fast/cheap RAG, 32768 context"},
            {"id": "nvidia/llama-nemotron-embed-1b-v2", "name": "NVIDIA Llama Nemotron Embed 1B V2", "provider": "NVIDIA", "dims": 1024, "notes": "multilingual retrieval"},
            {"id": "nvidia/llama-nemotron-embed-vl-1b-v2", "name": "NVIDIA Nemotron Embed VL 1B V2", "provider": "NVIDIA", "notes": "multimodal documents"},
            {"id": "qwen/qwen3-embedding-8b", "name": "Qwen3 Embedding 8B", "provider": "Qwen", "dims": 4096, "notes": "best overall retrieval, multilingual, code"},
            {"id": "baai/bge-m3", "name": "BGE-M3", "provider": "BAAI", "dims": 1024, "notes": "general RAG, multilingual"},
        ],
        "rerankModels": [
            {"id": "nvidia/llama-nemotron-rerank-vl-1b-v2", "name": "NVIDIA Llama Nemotron Rerank VL 1B V2", "provider": "NVIDIA"},
            {"id": "nvidia/llama-nemotron-rerank-1b-v2", "name": "NVIDIA Llama Nemotron Rerank 1B V2", "provider": "NVIDIA"},
            {"id": "cohere/rerank-v3.5", "name": "Cohere Rerank 3.5", "provider": "Cohere"},
        ],
    }

    return {
        "providers": providers,
        "defaultProvider": settings.llm_provider,
        "embedding": embedding,
        "rerank": rerank,
        "catalog": catalog_models,
        "presets": presets,
    }


@router.get("/openrouter/models")
async def openrouter_models() -> dict:
    """Live chat-model list straight from the OpenRouter /v1/models feed.

    Every provider behind OpenRouter (Google Gemini, Anthropic Claude, OpenAI
    GPT, x-ai Grok, DeepSeek, Qwen, …) already speaks the same OpenAI-compatible
    protocol, so all models stream through one standard in/out — this endpoint
    just surfaces the full catalogue so the UI never needs a hand-maintained
    list. Non-chat models (embeddings, rerankers, image/audio/video, batch-only
    and ``~latest`` aliases) are filtered out. ``isFree`` is derived from the
    advertised prompt price (0) or the ``:free`` suffix. When the API is
    unreachable the UI falls back to the curated list from GET /models.
    """
    base = settings.openrouter_base_url.rstrip("/")
    headers = {"content-type": "application/json"}
    if settings.openrouter_api_key:
        headers["authorization"] = f"Bearer {settings.openrouter_api_key}"
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(8.0)) as client:
            resp = await client.get(f"{base}/models", headers=headers)
            resp.raise_for_status()
            data = resp.json()
    except Exception as exc:  # noqa: BLE001 - OpenRouter may simply be offline
        logger.warning("OpenRouter /models unreachable: %s", exc)
        return {"reachable": False, "models": []}
    models: list[dict] = []
    seen: set[str] = set()
    for item in (data.get("data") or []):
        model_id = str(item.get("id") or "").strip()
        if not model_id or model_id.startswith("~") or model_id in seen:
            continue
        lowered = model_id.lower()
        if any(marker in lowered for marker in NON_CHAT_MODEL_MARKERS):
            continue
        seen.add(model_id)
        pricing = item.get("pricing") or {}
        prompt_price = str(pricing.get("prompt") or "").strip()
        is_free = model_id.endswith(":free") or prompt_price in ("0", "0.0", "0.00")
        namespace = model_id.split("/", 1)[0].lower()
        models.append(
            {
                "id": model_id,
                "name": model_id,
                "provider": namespace,
                "isFree": is_free,
            }
        )
        if len(models) >= 400:
            break
    return {"reachable": True, "models": models}


@router.get("/omniroute/models")
async def omniroute_models() -> dict:
    """Live free/keyless model list from the local OmniRoute gateway.

    OmniRoute is a local OpenAI-compatible proxy (``OMNIROUTE_BASE_URL``), so
    this is a passthrough to its ``/v1/models`` endpoint filtered down to the
    free tier: the smart-routing ``auto`` variants plus the keyless namespaces
    (``oc/…``, ``felo/…``, ``lc/…``, ``groq/…``). When the gateway is
    unreachable the UI falls back to the curated static list from GET /models.
    """
    base = settings.omniroute_base_url.rstrip("/")
    headers = {"authorization": f"Bearer {settings.omniroute_api_key}"}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(8.0)) as client:
            resp = await client.get(f"{base}/models", headers=headers)
            resp.raise_for_status()
            data = resp.json()
    except Exception as exc:  # noqa: BLE001 - gateway may simply be offline
        logger.warning("OmniRoute /models unreachable: %s", exc)
        return {"reachable": False, "models": []}
    models: list[dict] = []
    seen: set[str] = set()
    for item in (data.get("data") or []):
        model_id = str(item.get("id") or "").strip()
        if not model_id or model_id in seen:
            continue
        namespace = model_id.split("/", 1)[0].lower()
        is_free = (
            "auto" in model_id
            or "/free" in model_id
            or model_id.endswith(":free")
            or "free" in model_id
            or namespace in OMNIROUTE_FREE_NAMESPACES
        )
        if not is_free:
            continue
        seen.add(model_id)
        models.append(
            {
                "id": model_id,
                "name": model_id,
                "provider": namespace or "omniroute",
                "isFree": True,
            }
        )
        if len(models) >= 150:
            break
    return {"reachable": True, "models": models}


@router.post("/query")
async def query(request: Request, body: QueryRequest) -> EventSourceResponse:
    state = request.app.state

    async def generator():
        try:
            async for event in state.pipeline.stream_query(body):
                yield await _json_sse(event)
        except Exception as exc:
            logger.exception("query stream failed")
            yield await _json_sse({"type": "error", "message": str(exc)})

    return EventSourceResponse(generator(), media_type="text/event-stream")


@router.post("/retrieve")
async def retrieve(request: Request, body: RetrieveRequest) -> dict:
    """Retrieval-only endpoint for the Playground (no generation, no chat)."""
    state = request.app.state
    return await state.pipeline.retrieve_only(body)


@router.get("/metrics")
async def metrics(request: Request) -> dict:
    """Aggregated analytics summary from the Redis telemetry tail, plus the
    in-process scheduler/outbox/memory metrics registry (items 18/19)."""
    state = request.app.state
    summary = await state.telemetry.summary()
    monitor = getattr(state, "metrics", None)
    if monitor is not None:
        summary["monitoring"] = monitor.snapshot()
    return summary


@router.post("/feedback")
async def feedback(request: Request, body: FeedbackRequest) -> dict:
    state = request.app.state
    if state.pool is None:
        # Local mode: no Postgres — the on-disk feedback store owns the row.
        store = getattr(state, "feedback", None)
        if store is None or not store.enabled:
            raise HTTPException(status_code=501, detail="feedback store unavailable")
        await store.save(body.message_id, body.helpful, body.comment)
        return {"status": "ok"}
    async with state.pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO feedback (id, message_id, helpful, comment, created_at)
            VALUES (gen_random_uuid(), $1, $2, $3, now())
            """,
            body.message_id,
            body.helpful,
            body.comment,
        )
    return {"status": "ok"}
