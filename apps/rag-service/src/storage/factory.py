"""Local storage factory (Phase 7): build the on-disk SQLite adapter bundle.

``build_local_stores`` wires every storage port the rag-service touches to its
local adapter in one place:

- ``vector``  → ``LocalVectorStore``   (memories, conversation, document chunks)
- ``graph``   → ``LocalGraphStore``     (relationship graph — same ``memory.db``)
- ``cache``   → ``LocalCacheStore``     (TTL cache + ordered lists)
- ``documents``→ ``LocalDocumentStore`` (raw uploaded files on disk)
- ``jobs``    → ``LocalJobQueue``       (ingest queue — same file the worker polls)
- ``keys``    → ``LocalKeyStore``       (per-provider BYOK keys, mirrored to cache)
- ``feedback``→ ``LocalFeedbackStore``  (user ratings — Postgres ``feedback`` on desktop)
- ``conversations`` → ``LocalConversationStore`` (chat history — TypeORM tables on desktop)
- ``redis``   → ``RedisBridge``         (Redis-compatible facade over the cache)

The vector and graph adapters intentionally share one SQLite file (both are
guarded by WAL so the separate document-worker process can write chunks into
the same store concurrently).
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from src.storage.local_cache import LocalCacheStore
from src.storage.local_conversation import LocalConversationStore
from src.storage.local_document import LocalDocumentStore
from src.storage.local_feedback import LocalFeedbackStore
from src.storage.local_graph import LocalGraphStore
from src.storage.local_jobs import LocalJobQueue
from src.storage.local_keys import LocalKeyStore
from src.storage.local_vector import LocalVectorStore
from src.storage.redis_bridge import RedisBridge


@dataclass
class LocalStores:
    vector: LocalVectorStore
    graph: LocalGraphStore
    cache: LocalCacheStore
    documents: LocalDocumentStore
    jobs: LocalJobQueue
    keys: LocalKeyStore
    feedback: LocalFeedbackStore
    conversations: LocalConversationStore
    redis: RedisBridge


def build_local_stores(data_dir: str = "./data") -> LocalStores:
    root = Path(data_dir).expanduser()
    root.mkdir(parents=True, exist_ok=True)
    vector = LocalVectorStore(str(root / "memory.db"))
    graph = LocalGraphStore(str(root / "memory.db"))
    cache = LocalCacheStore(str(root / "cache.db"))
    documents = LocalDocumentStore(root / "files")
    jobs = LocalJobQueue(str(root / "jobs.db"))
    keys = LocalKeyStore(str(root / "keys.db"))
    feedback = LocalFeedbackStore(str(root / "feedback.db"))
    conversations = LocalConversationStore(str(root / "conversations.db"))
    return LocalStores(
        vector=vector,
        graph=graph,
        cache=cache,
        documents=documents,
        jobs=jobs,
        keys=keys,
        feedback=feedback,
        conversations=conversations,
        redis=RedisBridge(cache),
    )
