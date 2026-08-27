"""Core storage interfaces (ports) for Smoke Monkey.

See ``interfaces.py`` for the contracts. Every concrete store (pgvector, Neo4j,
MinIO, Redis, SQLite, …) is behind one of these ports.
"""
from src.storage.interfaces import (
    CacheStore,
    ChunkHit,
    DocumentStore,
    GraphStore,
    MemoryFact,
    MemoryHit,
    VectorStore,
)
from src.storage.local_cache import LocalCacheStore
from src.storage.local_document import LocalDocumentStore
from src.storage.local_graph import LocalGraphStore
from src.storage.local_vector import LocalVectorStore
from src.storage.postgres import PostgresVectorStore
from src.storage.redis_bridge import RedisBridge

__all__ = [
    "CacheStore",
    "ChunkHit",
    "DocumentStore",
    "GraphStore",
    "LocalCacheStore",
    "LocalDocumentStore",
    "LocalGraphStore",
    "LocalVectorStore",
    "MemoryFact",
    "MemoryHit",
    "PostgresVectorStore",
    "RedisBridge",
    "VectorStore",
]
