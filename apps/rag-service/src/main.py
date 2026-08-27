"""rag-service entrypoint."""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

import asyncpg
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from redis.asyncio import Redis

from src.api.desktop import router as desktop_router
from src.api.documents import router as documents_router
from src.api.keys import router as keys_router
from src.api.routes import router
from src.application.mem.agent import MemoryAgent
from src.application.mem.graph import GraphMemoryStore
from src.application.mem.monitoring import MemoryMetrics, MetricsSampler, _make_tracing
from src.application.mem.outbox import OutboxRelay, OutboxStore
from src.application.memory import MemoryStore
from src.application.pipeline import QueryPipeline
from src.application.router import QueryRouter
from src.application.websearch import WebSearchClient
from src.config import settings
from src.generation import (
    OllamaClient,
    OllamaEmbedder,
    OpenRouterClient,
    OpenRouterEmbedder,
    build_chat_llm,
)
from src.retrieval import OpenRouterReranker, Reranker

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s [rag-service] %(name)s: %(message)s"
)
logger = logging.getLogger(__name__)


def _cloud_client(provider: str, *, chat_model: str, key: str) -> OpenRouterClient | None:
    """Build an OpenAI-compatible client for the openrouter/nvidia providers."""
    if provider == "openrouter":
        return OpenRouterClient(
            api_key=key,
            model=chat_model,
            embed_model=settings.openrouter_embed_model,
            embed_dims=settings.openrouter_embed_dims,
            provider_id="openrouter",
            name="OpenRouter",
            base_url=settings.openrouter_base_url,
        )
    if provider == "nvidia":
        return OpenRouterClient(
            api_key=key,
            model=chat_model,
            embed_model=settings.nvidia_embed_model,
            embed_dims=settings.nvidia_embed_dims,
            provider_id="nvidia",
            name="NVIDIA NIM",
            base_url=settings.nvidia_base_url,
            rerank_url=settings.nvidia_rerank_base_url,
            rerank_style="nvidia",
        )
    return None


def build_embedder(api_key: str | None = None) -> OpenRouterEmbedder | OllamaEmbedder:
    """Build the embedding adapter for the configured EMBED_PROVIDER.

    ``api_key`` overrides the configured server default — the desktop resolves
    the user's saved BYOK key and passes it here; Ollama stays a keyless
    option for users who run it locally.
    """
    if settings.embed_provider == "openrouter":
        client = _cloud_client(
            "openrouter",
            chat_model=settings.openrouter_chat_model,
            key=api_key or settings.openrouter_api_key or "",
        )
        assert client is not None
        return OpenRouterEmbedder(client)
    if settings.embed_provider == "nvidia":
        client = _cloud_client(
            "nvidia",
            chat_model=settings.nvidia_chat_model,
            key=api_key or settings.nvidia_api_key or "",
        )
        assert client is not None
        return OpenRouterEmbedder(client)
    ollama = OllamaClient(
        base_url=settings.ollama_base_url,
        chat_model=settings.ollama_chat_model,
        embed_model=settings.ollama_embed_model,
        embed_dims=settings.ollama_embed_dims,
    )
    return OllamaEmbedder(ollama)


def build_reranker(api_key: str | None = None):
    """Prefer the cloud cross-encoder (OpenRouter/NVIDIA); fall back to local."""
    if settings.openrouter_rerank_enabled:
        client = _cloud_client(
            "openrouter",
            chat_model=settings.openrouter_chat_model,
            key=api_key or settings.openrouter_api_key or "",
        )
        if client is not None:
            return OpenRouterReranker(client)
    if settings.nvidia_rerank_enabled:
        client = _cloud_client(
            "nvidia",
            chat_model=settings.nvidia_chat_model,
            key=api_key or settings.nvidia_api_key or "",
        )
        if client is not None:
            return OpenRouterReranker(client)
    if settings.rerank_enabled:
        try:
            return Reranker(settings.rerank_model)
        except Exception as exc:  # noqa: BLE001
            logger.error("local reranker disabled: %s", exc)
    return None


@asynccontextmanager
async def lifespan(app: FastAPI):
    local = settings.storage_mode == "local"
    pool: asyncpg.Pool | None = None
    local_stores = None
    if local:
        from src.storage.factory import build_local_stores

        # Desktop edition: every storage dependency is an on-disk SQLite
        # adapter, and a Redis-compatible facade stands in for the cache.
        local_stores = build_local_stores(settings.local_data_dir)
        await local_stores.vector.connect()
        await local_stores.graph.connect()
        await local_stores.cache.connect()
        await local_stores.jobs.connect()
        await local_stores.keys.connect()
        await local_stores.feedback.connect()
        await local_stores.conversations.connect()
        redis = local_stores.redis
        logger.info("local storage mode enabled (data_dir=%s)", settings.local_data_dir)
    else:
        pool = await asyncpg.create_pool(settings.postgres_dsn, min_size=2, max_size=10)
        async with pool.acquire() as conn:
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS feedback (
                    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    message_id  TEXT NOT NULL,
                    helpful     BOOLEAN,
                    comment     TEXT,
                    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
                )
                """
            )
        redis = Redis(
            host=settings.redis_host,
            port=settings.redis_port,
            password=settings.redis_password or None,
            decode_responses=True,
        )

    # Inference on the desktop: use the same cloud APIs as the web edition
    # (BYOK) so no GPU is required. The user's saved key wins, then the server
    # default. Ollama stays an optional, keyless choice for local setups.
    user_key = None
    if local and local_stores is not None:
        user_key = await local_stores.keys.get(settings.embed_provider, settings.local_user_id)
    embedder = build_embedder(user_key)

    try:
        chat_key = None
        if local and local_stores is not None:
            chat_key = await local_stores.keys.get(settings.llm_provider, settings.local_user_id)
        chat_llm = build_chat_llm(
            settings.llm_provider,
            ollama_base_url=settings.ollama_base_url,
            ollama_chat_model=settings.ollama_chat_model,
            ollama_embed_model=settings.ollama_embed_model,
            ollama_embed_dims=settings.ollama_embed_dims,
            gemini_api_key=settings.gemini_api_key,
            gemini_model=settings.gemini_model,
            openrouter_api_key=settings.openrouter_api_key,
            openrouter_model=settings.openrouter_chat_model,
            nvidia_api_key=settings.nvidia_api_key,
            nvidia_model=settings.nvidia_chat_model,
            api_key=chat_key,
        )
    except ValueError as exc:
        if local and chat_key is None:
            logger.warning(
                "no %s API key configured — add one via PUT /api/v1/keys/%s (desktop uses "
                "cloud APIs by default; Ollama remains an optional local choice). Falling "
                "back to Ollama: %s",
                settings.llm_provider,
                settings.llm_provider,
                exc,
            )
        else:
            logger.warning("chat llm init failed: %s; falling back to Ollama", exc)
        chat_llm = OllamaClient(
            base_url=settings.ollama_base_url,
            chat_model=settings.ollama_chat_model,
            embed_model=settings.ollama_embed_model,
            embed_dims=settings.ollama_embed_dims,
        )

    rerank_key = None
    if local and local_stores is not None:
        rerank_provider = "openrouter" if settings.openrouter_rerank_enabled else (
            "nvidia" if settings.nvidia_rerank_enabled else None
        )
        if rerank_provider is not None:
            rerank_key = await local_stores.keys.get(rerank_provider, settings.local_user_id)
    reranker = build_reranker(rerank_key)

    # Observability (items 18/19): in-process metrics + tracing hooks + the
    # sampler loop that reports queue lag and memory growth. Metrics are always
    # recorded (cheap); the sampler loop runs only when monitor_enabled.
    metrics = MemoryMetrics()
    tracing = _make_tracing(metrics)
    metrics_sampler = MetricsSampler(
        metrics,
        pool=pool,
        redis=redis,
        poll_interval_s=settings.monitor_poll_interval_s,
    )

    # Super memory: pgvector tables for conversation + user-profile memory.
    # The transactional outbox keeps Postgres as the source of truth and lets
    # the graph mirror replay safely (retry → DLQ) instead of inline coupling.
    # In local mode the SQLite vector store owns the schema and the memory
    # agent links the graph inline (there is no outbox relay on the desktop).
    if local:
        memory_store = MemoryStore(
            None,
            embedder,
            outbox=None,
            vector_store=local_stores.vector,
            graph=local_stores.graph,
        )
    else:
        outbox_store = OutboxStore(pool)
        memory_store = MemoryStore(pool, embedder, outbox=outbox_store)
        await memory_store.ensure_schema()
    try:
        # Spec Consolidator: purge expired facts + aged episodic memory at boot.
        await memory_store.consolidate()
    except Exception as exc:  # noqa: BLE001 - consolidation is best-effort
        logger.warning("memory consolidation failed at startup: %s", exc)
    web_search = (
        WebSearchClient(
            settings.web_search_top_k,
            redis=redis,
            providers=[p.strip() for p in settings.web_search_providers.split(",") if p.strip()],
            cache_ttl=settings.web_search_cache_ttl,
            server_keys={
                "tavily": settings.tavily_api_key,
                "google": settings.google_search_api_key,
                "brave": settings.brave_api_key,
                "bing": settings.bing_api_key,
            },
            google_cx=settings.google_search_cx,
            tavily_search_depth=settings.tavily_search_depth,
        )
        if settings.web_search_enabled
        else None
    )

    # Relationship graph memory. Cloud: Neo4j-backed human-association layer
    # (skipped entirely when disabled; a missing driver/bad URI degrades to a
    # no-op). Local: the SQLite graph store that ships with the desktop.
    if local:
        graph_store = local_stores.graph
    else:
        graph_store = GraphMemoryStore(
            uri=settings.neo4j_uri,
            user=settings.neo4j_user,
            password=settings.neo4j_password,
        )
        if settings.neo4j_enabled and settings.memory_graph_enabled:
            try:
                await graph_store.connect()
                await graph_store.ensure_schema()
                logger.info(
                    "neo4j graph memory enabled (uri=%s, user=%s)",
                    settings.neo4j_uri,
                    settings.neo4j_user,
                )
            except Exception as exc:  # noqa: BLE001 - best-effort: graph degrades to no-op
                logger.warning("neo4j graph memory disabled: %s", exc)
                await graph_store.close()

    # Prospective Memory & Task Scheduler: Postgres-backed, cloud only. On the
    # desktop the agent uses an in-memory prospective store (no scheduler loop).
    prospective_store = None
    if not local:
        from src.application.mem.prospective import ProspectiveMemoryStore

        prospective_store = ProspectiveMemoryStore(
            pool=pool,
            redis=redis,
            poll_interval_s=settings.scheduler_poll_interval_s,
            claim_batch=settings.scheduler_claim_batch,
            claim_seconds=settings.scheduler_claim_seconds,
            max_per_user_per_cycle=settings.scheduler_max_per_user_per_cycle,
            background_max_per_user_per_minute=settings.scheduler_background_max_per_user_per_minute,
            missed_policy=settings.scheduler_missed_policy,
            missed_dispatch_max_hours=settings.scheduler_missed_dispatch_max_hours,
            max_attempts=settings.scheduler_max_attempts,
            backoff_base_s=settings.scheduler_backoff_base_s,
            backoff_max_s=settings.scheduler_backoff_max_s,
            metrics=metrics,
            tracing=tracing,
        )
        await prospective_store.ensure_schema()
        await prospective_store.recover_on_startup()

    memory_agent = MemoryAgent(
        store=memory_store,
        graph=graph_store,
        embedder=embedder,
        prospective=prospective_store,
    )

    # Background workers: outbox relay (graph consistency) + scheduler
    # (exactly-once intent dispatch). Both are cancelled on shutdown. The
    # relay and scheduler are Postgres-based, so they only run in cloud mode.
    relay_task: asyncio.Task[None] | None = None
    if not local and settings.memory_outbox_enabled:
        outbox_relay = OutboxRelay(
            outbox_store,
            handler=memory_agent.apply_outbox_event,
            batch_size=settings.memory_outbox_batch_size,
            poll_interval_s=settings.memory_outbox_poll_interval_s,
            claim_seconds=settings.memory_outbox_claim_seconds,
            max_attempts=settings.memory_outbox_max_attempts,
            backoff_base_s=settings.memory_outbox_backoff_base_s,
            backoff_max_s=settings.memory_outbox_backoff_max_s,
            metrics=metrics,
            tracing=tracing,
        )
        relay_task = asyncio.create_task(outbox_relay.run_loop())
    scheduler_task: asyncio.Task[None] | None = None
    if not local and settings.scheduler_enabled:
        scheduler_task = asyncio.create_task(prospective_store.run_scheduler())
    sampler_task: asyncio.Task[None] | None = None
    if settings.monitor_enabled:
        sampler_task = asyncio.create_task(metrics_sampler.run_loop())

    app.state.pool = pool
    app.state.redis = redis
    app.state.embedder = embedder
    app.state.llm = chat_llm
    app.state.web = web_search
    if local:
        app.state.vector = local_stores.vector
        app.state.documents = local_stores.documents
        app.state.jobs = local_stores.jobs
        app.state.keys = local_stores.keys
        app.state.feedback = local_stores.feedback
        app.state.conversations = local_stores.conversations
    else:
        app.state.vector = None
        app.state.documents = None
        app.state.jobs = None
        app.state.keys = None
        app.state.feedback = None
        app.state.conversations = None
    app.state.pipeline = QueryPipeline(
        pool=pool,
        redis=redis,
        embedder=embedder,
        chat_llm=chat_llm,
        reranker=reranker,
        router=QueryRouter(redis),
        memory=memory_store,
        memory_agent=memory_agent,
        web=web_search,
        vector_store=local_stores.vector if local else None,
    )
    app.state.telemetry = app.state.pipeline.telemetry
    app.state.metrics = metrics

    logger.info(
        "rag-service ready (provider=%s, embed=%s, rerank=%s, router=%s, memory=%s, graph=%s, monitor=%s, storage=%s)",
        chat_llm.provider_id,
        embedder.provider_id,
        type(reranker).__name__ if reranker else "off",
        "on" if settings.router_enabled else "off",
        "on" if settings.memory_enabled else "off",
        "on" if graph_store.enabled else "off",
        "on" if settings.monitor_enabled else "off",
        settings.storage_mode,
    )
    try:
        yield
    finally:
        # Stop the background workers first so they don't touch torn-down deps.
        for task in (scheduler_task, relay_task, sampler_task):
            if task is not None and not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        # Let in-flight memory index writes finish before tearing down the
        # embedder/pool, otherwise the last exchange is lost.
        try:
            await app.state.pipeline.flush_memory_index()
        except Exception as exc:  # noqa: BLE001
            logger.warning("memory index flush failed during shutdown: %s", exc)
        closeables: list[object] = [chat_llm]
        embed_client = getattr(embedder, "_client", None)
        if embed_client is not None:
            closeables.append(embed_client)
        if reranker is not None:
            rerank_client = getattr(reranker, "_client", None)
            if rerank_client is not None:
                closeables.append(rerank_client)
        web = getattr(app.state, "web", None)
        if web is not None:
            closeables.append(web)
        for obj in closeables:
            close = getattr(obj, "aclose", None)
            if close is not None:
                try:
                    await close()
                except Exception as exc:  # noqa: BLE001
                    logger.debug("close failed for %s: %s", type(obj).__name__, exc)
        await redis.aclose()
        if pool is not None:
            await pool.close()
        if local_stores is not None:
            for store in (
                local_stores.vector,
                local_stores.graph,
                local_stores.cache,
                local_stores.jobs,
                local_stores.keys,
                local_stores.feedback,
                local_stores.conversations,
            ):
                try:
                    await store.close()
                except Exception as exc:  # noqa: BLE001
                    logger.debug("local store close failed: %s", exc)


app = FastAPI(title="rag-service", version="0.1.0", lifespan=lifespan)
if settings.storage_mode == "local":
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[o.strip() for o in settings.local_cors_origins.split(",") if o.strip()],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
app.include_router(router)
app.include_router(documents_router)
app.include_router(keys_router)
app.include_router(desktop_router)
if settings.storage_mode == "local":
    from src.application.freegate import router as free_gateway_router

    app.include_router(free_gateway_router)
