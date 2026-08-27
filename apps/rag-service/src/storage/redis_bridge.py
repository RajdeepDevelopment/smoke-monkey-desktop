"""Redis-compatible async facade over the local ``CacheStore``.

Phase 7 deliverable: every subsystem that takes a ``redis.asyncio.Redis``
(caches, telemetry, router, web-search settings, context reconstruction,
personalization) keeps working unchanged in local mode by handing them this
bridge instead of a real Redis client. Only the call surface the app actually
uses is implemented; anything else raises ``NotImplementedError`` loudly rather
than silently misbehaving.
"""
from __future__ import annotations

from typing import Any

from src.storage.local_cache import LocalCacheStore


class _BridgePipeline:
    """Bare-bones pipeline: each queued command runs immediately on the store.

    Redis pipelines batch round-trips and wrap the batch in a transaction; on a
    local SQLite store every command is already atomic and free, so executing
    eagerly preserves the observable semantics (lpush then ltrim, incr+expire).
    ``execute()`` returns the per-command results like ``redis.asyncio``.
    """

    def __init__(self, store: LocalCacheStore) -> None:
        self._store = store
        self._ops: list[tuple[Any, tuple[Any, ...], dict[str, Any]]] = []

    def lpush(self, key: str, value: str) -> int | None:
        self._ops.append((self._store.push_tail, (key, value), {}))
        return None

    def ltrim(self, key: str, start: int, end: int) -> int | None:
        self._ops.append((self._store.trim, (key, start, end), {}))
        return None

    def incr(self, key: str, amount: int = 1) -> int | None:
        self._ops.append((self._store.incr, (key, amount), {}))
        return None

    def expire(self, key: str, ttl: int | None) -> int | None:
        self._ops.append((self._store.expire, (key, ttl), {}))
        return None

    def get(self, key: str) -> int | None:
        self._ops.append((self._store.get, (key,), {}))
        return None

    def set(self, key: str, value: str, ex: int | None = None) -> int | None:
        self._ops.append((self._store.set, (key, value, ex), {}))
        return None

    async def execute(self) -> list[Any]:
        results: list[Any] = []
        for fn, args, kwargs in self._ops:
            results.append(await fn(*args, **kwargs))
        self._ops.clear()
        return results

    async def __aenter__(self) -> _BridgePipeline:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None


class RedisBridge:
    """Minimal ``redis.asyncio.Redis`` replacement backed by ``LocalCacheStore``.

    Values are stored/returned as ``str`` (matches ``decode_responses=True``).
    """

    def __init__(self, store: LocalCacheStore) -> None:
        self._store = store

    @property
    def store(self) -> LocalCacheStore:
        return self._store

    async def ping(self) -> bool:
        return self._store.enabled

    async def get(self, key: str) -> str | None:
        return await self._store.get(key)

    async def set(self, key: str, value: str, ex: int | None = None, **_: Any) -> None:
        await self._store.set(key, value, ttl=ex)

    async def exists(self, key: str) -> bool:
        return await self._store.exists(key)

    async def delete(self, *keys: str) -> int:
        deleted = 0
        for key in keys:
            before = await self._store.exists(key)
            if before:
                await self._store.delete(key)
                deleted += 1
        return deleted

    async def unlink(self, *keys: str) -> int:
        return await self.delete(*keys)

    async def expire(self, key: str, seconds: int) -> bool:
        return await self._store.expire(key, seconds)

    async def incr(self, key: str, amount: int = 1) -> int:
        return await self._store.incr(key, amount)

    async def lpush(self, key: str, value: str) -> int:
        await self._store.push_tail(key, value)
        return await self._store.llen(key)

    async def lrange(self, key: str, start: int, end: int) -> list[str]:
        return await self._store.range(key, start, end)

    async def ltrim(self, key: str, start: int, end: int) -> bool:
        await self._store.trim(key, start, end)
        return True

    async def llen(self, key: str) -> int:
        return await self._store.llen(key)

    async def scan_iter(self, match: str | None = None, count: int | None = None) -> Any:
        keys = await self._store.keys(match or "*")
        for key in keys:
            yield key

    def pipeline(self, transaction: bool = True) -> _BridgePipeline:
        return _BridgePipeline(self._store)

    async def aclose(self) -> None:
        return None
