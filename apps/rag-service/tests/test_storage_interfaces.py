"""Interface conformance: concrete stores must satisfy their ports.

The memory engine and document pipeline depend on the storage interfaces in
``src.storage``; a store that stops honoring the contract breaks the port. These
tests assert structural conformance (``typing.Protocol`` + ``runtime_checkable``)
without requiring a live database.
"""
import inspect

from src.application.mem.graph import GraphMemoryStore
from src.storage import (
    CacheStore,
    DocumentStore,
    GraphStore,
    VectorStore,
)
from src.storage.postgres import PostgresVectorStore


def test_graph_memory_store_satisfies_graphstore():
    store = GraphMemoryStore()
    assert isinstance(store, GraphStore)
    # Default: no driver attached -> disabled (defensive no-op).
    assert store.enabled is False


def test_postgres_vector_store_satisfies_vectorstore():
    store = PostgresVectorStore(pool=object())  # structural check only
    assert isinstance(store, VectorStore)


class _FakeCache:
    async def get(self, key: str) -> str | None:
        return None

    async def set(self, key: str, value: str, ttl: int | None = None) -> None:
        return None

    async def delete(self, key: str) -> None:
        return None

    async def exists(self, key: str) -> bool:
        return False

    async def push_tail(self, key: str, value: str) -> None:
        return None

    async def range(self, key: str, start: int, end: int) -> list[str]:
        return []

    async def trim(self, key: str, start: int, end: int) -> None:
        return None


class _FakeDocs:
    async def ensure_bucket(self) -> None:
        return None

    async def download(self, key: str, dest):
        return dest

    async def upload(self, key: str, path, content_type: str = "application/pdf") -> None:
        return None

    async def delete(self, key: str) -> None:
        return None


def test_cache_and_document_ports_accept_implementations():
    assert isinstance(_FakeCache(), CacheStore)
    assert isinstance(_FakeDocs(), DocumentStore)


async def test_vector_store_methods_are_awaitable():
    """The adapter's public API is async end to end."""
    store = PostgresVectorStore(pool=object())  # type: ignore[arg-type]
    assert inspect.iscoroutinefunction(store.search_conversation)
    assert inspect.iscoroutinefunction(store.search_facts)
    assert inspect.iscoroutinefunction(store.search_critical_facts)
    assert inspect.iscoroutinefunction(store.search_chunks)
    assert inspect.iscoroutinefunction(store.upsert_fact)
    assert inspect.iscoroutinefunction(store.consolidate)
    assert inspect.iscoroutinefunction(store.replace_document_chunks)
    assert inspect.iscoroutinefunction(store.set_document_status)
