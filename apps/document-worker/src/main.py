"""document-worker entrypoint: NATS JetStream / local-queue consumer for PDFs.

Two transports drive the same ingestion pipeline:

- **Cloud**: NATS JetStream pull consumer for ``documents.ingest``. On success
  a ``documents.ingested`` event is published (the api-gateway mirrors it into
  Postgres); failures are published and the message is nacked/termed.
- **Local (desktop)**: a SQLite job queue shared with rag-service
  (``local_data_dir/jobs.db``). PDFs and chunks go to the same local stores
  rag-service reads; job/status updates are written in place, so no events are
  needed.
"""
from __future__ import annotations

import asyncio
import json
import logging
import tempfile
import traceback
import uuid
from pathlib import Path

import nats
from nats.aio.msg import Msg
from nats.js.api import ConsumerConfig, StorageType, StreamConfig, StreamInfo
from nats.js.client import JetStreamContext
from nats.js.errors import NotFoundError
from redis.asyncio import Redis

from src.chunking import build_chunk_hierarchy
from src.config import settings
from src.domain import IngestJob
from src.embeddings import NvidiaEmbeddingClient, OllamaEmbeddingClient, OpenRouterEmbeddingClient
from src.keys import resolve_provider_key
from src.parsers import parse_pdf
from src.storage import MinioStorage, VectorStore
from src.storage.local_jobs import LocalJobQueue, build_local_job_queue
from src.storage.local_keys import LocalKeyStore
from src.storage.local_storage import build_local_storage

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s [worker] %(name)s: %(message)s"
)
logger = logging.getLogger(__name__)


async def ensure_stream(js: JetStreamContext) -> StreamInfo:
    try:
        info = await js.stream_info(settings.document_stream)
        return info
    except NotFoundError:
        return await js.add_stream(
            StreamConfig(
                name=settings.document_stream,
                subjects=["documents.>"],
                storage=StorageType.FILE,
                max_age=7 * 24 * 3600,
            )
        )


async def _set_status(
    store: VectorStore,
    document_id: uuid.UUID,
    status: str,
    error: str | None = None,
    chunk_count: int | None = None,
    user_id: str | None = None,
) -> None:
    try:
        await store.set_document_status(document_id, status, error, chunk_count, user_id)
    except Exception as exc:  # noqa: BLE001 - status updates must not break the job
        logger.warning("status update to %s failed for %s: %s", status, document_id, exc)


def build_embedder(api_key: str, provider: str | None = None):
    """Pick the embedding client for the configured EMBED_PROVIDER."""
    provider = provider or settings.embed_provider
    if provider == "openrouter":
        return OpenRouterEmbeddingClient(
            api_key=api_key,
            model=settings.openrouter_embed_model,
            dims=settings.openrouter_embed_dims,
            batch_size=settings.embed_batch_size,
        )
    if provider == "nvidia":
        return NvidiaEmbeddingClient(
            api_key=api_key,
            model=settings.nvidia_embed_model,
            dims=settings.nvidia_embed_dims,
            batch_size=settings.embed_batch_size,
        )
    return OllamaEmbeddingClient(
        base_url=settings.ollama_base_url,
        model=settings.ollama_embed_model,
        dims=settings.ollama_embed_dims,
        batch_size=settings.embed_batch_size,
    )


async def _ingest(
    job: IngestJob,
    redis: Redis | None,
    store,
    storage,
    keys: LocalKeyStore | None = None,
) -> tuple[int, object]:
    """Transport-agnostic ingestion core shared by both workers.

    Owns key resolution, PDF download/parse/chunk/embed, chunk writes and the
    document status lifecycle in the store. Returns ``(chunk_count, doc)``.
    Raises on failure (after marking the document failed).

    ``keys`` (desktop) reads the user's saved provider key from ``keys.db``;
    without it the cloud Redis-based ``resolve_provider_key`` is used.
    """
    embed_provider = settings.embed_provider
    server_default = (
        settings.openrouter_api_key
        if embed_provider == "openrouter"
        else settings.nvidia_api_key
        if embed_provider == "nvidia"
        else ""
    )
    if keys is not None:
        # Desktop: the user often saves a single BYOK key (e.g. NVIDIA) while
        # EMBED_PROVIDER is still the cloud default. Fall back across the
        # OpenAI-compatible providers so chunk embedding works with one key.
        api_key = await keys.get(embed_provider, str(job.user_id))
        if not api_key:
            for alt in (p for p in ("nvidia", "openrouter") if p != embed_provider):
                api_key = await keys.get(alt, str(job.user_id))
                if api_key:
                    embed_provider = alt
                    break
        api_key = api_key or server_default or None
    else:
        api_key = await resolve_provider_key(
            redis,
            job.user_id,
            embed_provider,
            server_default=server_default,
        )
    if embed_provider != settings.embed_provider:
        embedder = build_embedder(api_key or "", provider=embed_provider)
    else:
        embedder = build_embedder(api_key or "")
    try:
        await _set_status(store, job.document_id, "processing", user_id=str(job.user_id))

        with tempfile.TemporaryDirectory() as tmp:
            local_path = await storage.download(job.s3_key, Path(tmp) / job.filename)
            doc = await parse_pdf(local_path, job.filename, ocr_enabled=settings.ocr_enabled)
            groups = build_chunk_hierarchy(
                doc, chunk_size=settings.chunk_size, chunk_overlap=settings.chunk_overlap
            )

            child_texts = [c.content for g in groups for c in g.children]
            embeddings = await embedder.embed(child_texts)
            child_embeddings = dict(zip(child_texts, embeddings, strict=False))

            chunk_count = await store.replace_document_chunks(job.document_id, groups, child_embeddings)
            await _set_status(
                store, job.document_id, "ready", chunk_count=chunk_count, user_id=str(job.user_id)
            )

        logger.info("document %s indexed with %d chunks", job.document_id, chunk_count)
        return chunk_count, doc
    except Exception as exc:
        logger.error("job failed for document %s: %s", job.document_id, exc)
        logger.debug(traceback.format_exc())
        await _set_status(
            store, job.document_id, "failed", error=str(exc)[:500], user_id=str(job.user_id)
        )
        raise
    finally:
        await embedder.aclose()


async def process_job(js: JetStreamContext, msg: Msg, job: IngestJob, redis: Redis) -> None:
    """Cloud path: ingest one NATS message, publish the ingested event, ack."""
    store = VectorStore()
    storage = MinioStorage()
    try:
        chunk_count, doc = await _ingest(job, redis, store, storage)
        await js.publish(
            settings.ingested_subject,
            json.dumps(
                {
                    "jobId": str(job.job_id),
                    "documentId": str(job.document_id),
                    "status": "ready",
                    "chunkCount": chunk_count,
                    "pageCount": len(doc.pages),
                }
            ).encode(),
        )
    except Exception as exc:
        try:
            await js.publish(
                settings.ingested_subject,
                json.dumps(
                    {
                        "jobId": str(job.job_id),
                        "documentId": str(job.document_id),
                        "status": "failed",
                        "error": str(exc)[:500],
                    }
                ).encode(),
            )
        except Exception as publish_exc:  # noqa: BLE001 - best effort failure notification
            logger.warning(
                "failed to publish failure status for document %s: %s", job.document_id, publish_exc
            )
        metadata = getattr(msg, "metadata", None)
        if metadata is not None and metadata.num_delivered >= 4:
            await msg.term()
        else:
            await msg.nak()
        raise
    finally:
        await store.close()


async def process_job_local(
    queue: LocalJobQueue,
    job: IngestJob,
    store,
    storage,
    keys: LocalKeyStore | None = None,
) -> None:
    """Local path: ingest one queued job; status lives in the shared store."""
    try:
        await _ingest(job, None, store, storage, keys=keys)
        await queue.complete(job.job_id)
    except Exception as exc:
        await queue.fail(job.job_id, error=str(exc)[:500])


async def run_nats() -> None:
    """Cloud worker: NATS JetStream pull consumer (unchanged behavior)."""
    logger.info("connecting to NATS at %s", settings.nats_url)
    nc = await nats.connect(settings.nats_url, max_reconnect_attempts=-1)
    js = nc.jetstream()
    await ensure_stream(js)

    redis = Redis(
        host=settings.redis_host,
        port=settings.redis_port,
        password=settings.redis_password or None,
        decode_responses=True,
    )

    storage = MinioStorage()
    store = VectorStore()
    await storage.ensure_bucket()
    await store.init()
    await store.close()

    sub = await js.pull_subscribe(
        settings.ingest_subject,
        durable="document-worker",
        config=ConsumerConfig(
            ack_wait=180,
            max_deliver=5,
            max_ack_pending=200,
        ),
    )
    logger.info("subscribed to %s (durable=document-worker)", settings.ingest_subject)

    try:
        while True:
            try:
                batch = await sub.fetch(10, timeout=15)
            except nats.js.errors.FetchTimeoutError:
                continue
            except Exception as exc:  # noqa: BLE001
                logger.warning("fetch error: %s", exc)
                await asyncio.sleep(2)
                continue

            for msg in batch:
                try:
                    payload = json.loads(msg.data.decode())
                    job = IngestJob.from_payload(payload)
                    logger.info("received ingest job %s (document %s)", job.job_id, job.document_id)
                    await process_job(js, msg, job, redis)
                    await msg.ack()
                except Exception as exc:  # noqa: BLE001
                    logger.error("unhandled error for message: %s", exc)
    finally:
        await redis.aclose()


async def run_local() -> None:
    """Local worker: poll the shared SQLite job queue, no NATS/Postgres/MinIO."""
    local = build_local_storage()
    await local.files.ensure_bucket()
    await local.vector.init()
    keys = LocalKeyStore(str(Path(settings.local_data_dir).expanduser() / "keys.db"))
    await keys.connect()
    queue = build_local_job_queue()
    await queue.connect()
    requeued = await queue.recover_stale(claim_seconds=300)
    if requeued:
        logger.info("requeued %d stale ingest jobs", requeued)
    logger.info("local worker started (jobs=%s)", queue.db_path)
    try:
        while True:
            jobs = await queue.next_batch(batch_size=10)
            for job in jobs:
                logger.info("processing ingest job %s (document %s)", job.job_id, job.document_id)
                try:
                    await process_job_local(queue, job, local.vector, local.files, keys=keys)
                except Exception as exc:  # noqa: BLE001 - the loop must keep running
                    logger.error("unhandled error for job %s: %s", job.job_id, exc)
            if not jobs:
                await asyncio.sleep(settings.local_poll_interval_s)
    finally:
        await queue.close()
        await keys.close()
        await local.vector.close()


async def run() -> None:
    if settings.storage_mode == "local":
        await run_local()
    else:
        await run_nats()


async def main() -> None:
    while True:
        try:
            await run()
        except Exception as exc:  # noqa: BLE001
            logger.error("worker crashed, restarting in 5s: %s", exc)
            await asyncio.sleep(5)


if __name__ == "__main__":
    asyncio.run(main())
