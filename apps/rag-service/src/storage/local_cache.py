"""Local CacheStore adapter — SQLite-backed TTL cache.

Desktop edition of the Redis cache: plain TTL key/value entries plus bounded
ordered lists (the telemetry tail, work queues). Semantics mirror the
``redis.asyncio`` calls the app makes:

- ``get`` returns ``None`` once a key's ``expires_at`` has passed (lazy purge).
- ``set`` uses the Redis ``ex`` convention (``ttl`` in seconds, ``None`` = no
  expiry, ``0``/negative = immediately expired).
- ``exists``/``delete`` cover both key/value entries and list keys.
- ``push_tail`` prepends (like ``lpush``); ``range`` returns newest-first
  (like ``lrange``); ``trim`` keeps the ``[start, end]`` window (like ``ltrim``),
  including negative indices.
"""
from __future__ import annotations

import asyncio
import fnmatch
import sqlite3
import time
from collections.abc import Callable
from typing import Any

from src.storage.interfaces import CacheStore

_SCHEMA = """
CREATE TABLE IF NOT EXISTS cache_entries (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    expires_at REAL
);
CREATE TABLE IF NOT EXISTS cache_lists (
    key   TEXT NOT NULL,
    seq   INTEGER NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (key, seq)
);
CREATE TABLE IF NOT EXISTS cache_seq (
    id    INTEGER PRIMARY KEY CHECK (id = 1),
    value INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO cache_seq (id, value) VALUES (1, 0);
"""


def _slice_positions(n: int, start: int, end: int) -> list[int]:
    """Resolve Redis ``start``/``end`` indices for a list of length ``n``."""
    if n <= 0:
        return []
    if start < 0:
        start = n + start
    if end < 0:
        end = n + end
    start = max(start, 0)
    end = min(end, n - 1)
    if start > end:
        return []
    return list(range(start, end + 1))


class LocalCacheStore(CacheStore):
    """SQLite-backed ``CacheStore``. ``db_path`` may be ``:memory:``."""

    def __init__(self, db_path: str = ":memory:") -> None:
        self.db_path = db_path
        self._conn: sqlite3.Connection | None = None
        self._lock = asyncio.Lock()

    @property
    def enabled(self) -> bool:
        return self._conn is not None

    async def connect(self) -> None:
        if self._conn is not None:
            return
        self._conn = await asyncio.to_thread(
            sqlite3.connect,
            self.db_path,
            isolation_level=None,
            check_same_thread=False,
        )
        self._conn.row_factory = sqlite3.Row
        await asyncio.to_thread(self._conn.execute, "PRAGMA journal_mode=WAL")
        await asyncio.to_thread(self._conn.execute, "PRAGMA busy_timeout=5000")
        await self.ensure_schema()

    async def close(self) -> None:
        conn, self._conn = self._conn, None
        if conn is not None:
            await asyncio.to_thread(conn.close)

    async def ensure_schema(self) -> None:
        if self._conn is None:
            return
        async with self._lock:
            await asyncio.to_thread(self._conn.executescript, _SCHEMA)

    def _run(self, fn: Callable[..., Any], *args: Any) -> Any:
        return asyncio.to_thread(fn, *args)

    async def _fetch(self, query: str, params: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
        """Fetch rows; caller must already hold ``self._lock``."""
        cursor = await asyncio.to_thread(self._conn.execute, query, params)
        return await asyncio.to_thread(cursor.fetchall)

    # ── key/value ────────────────────────────────────────────────────────────

    async def get(self, key: str) -> str | None:
        if self._conn is None:
            return None
        now = time.time()
        async with self._lock:
            rows = await self._fetch(
                "SELECT value FROM cache_entries "
                "WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)",
                (key, now),
            )
            if not rows:
                await self._run(
                    self._conn.execute,
                    "DELETE FROM cache_entries WHERE key = ? AND expires_at IS NOT NULL "
                    "AND expires_at <= ?",
                    (key, now),
                )
                return None
            return str(rows[0]["value"])

    async def set(self, key: str, value: str, ttl: int | None = None) -> None:
        if self._conn is None:
            return
        expires_at = time.time() + ttl if ttl is not None else None
        async with self._lock:
            await self._run(
                self._conn.execute,
                "INSERT OR REPLACE INTO cache_entries (key, value, expires_at) VALUES (?, ?, ?)",
                (key, value, expires_at),
            )

    async def exists(self, key: str) -> bool:
        if self._conn is None:
            return False
        now = time.time()
        async with self._lock:
            entry = await self._fetch(
                "SELECT 1 FROM cache_entries "
                "WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)",
                (key, now),
            )
            if entry:
                return True
            listing = await self._fetch(
                "SELECT 1 FROM cache_lists WHERE key = ? LIMIT 1", (key,)
            )
            return bool(listing)

    async def delete(self, key: str) -> None:
        if self._conn is None:
            return
        async with self._lock:
            await self._run(
                self._conn.execute, "DELETE FROM cache_entries WHERE key = ?", (key,)
            )
            await self._run(
                self._conn.execute, "DELETE FROM cache_lists WHERE key = ?", (key,)
            )

    # ── counter / TTL helpers (Redis-compatible facade surface) ─────────────

    async def incr(self, key: str, amount: int = 1) -> int:
        """Atomically bump a numeric entry (Redis ``INCR``), creating it as 0."""
        if self._conn is None:
            return 0
        now = time.time()
        async with self._lock:
            rows = await self._fetch(
                "SELECT value, expires_at FROM cache_entries WHERE key = ?", (key,)
            )
            value = 0
            expires_at = None
            if rows:
                expires_at = rows[0]["expires_at"]
                if expires_at is None or expires_at > now:
                    try:
                        value = int(str(rows[0]["value"]))
                    except (TypeError, ValueError):
                        value = 0
            new_value = value + amount
            await self._run(
                self._conn.execute,
                "INSERT INTO cache_entries (key, value, expires_at) VALUES (?, ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, str(new_value), expires_at),
            )
            return new_value

    async def expire(self, key: str, ttl: int | None) -> bool:
        """Set a TTL on an entry (Redis ``EXPIRE``, seconds). ``ttl <= 0`` deletes."""
        if self._conn is None:
            return False
        if ttl is not None and ttl <= 0:
            await self.delete(key)
            return True
        expires_at = time.time() + ttl if ttl is not None else None
        async with self._lock:
            cursor = await self._run(
                self._conn.execute,
                "UPDATE cache_entries SET expires_at = ? WHERE key = ?",
                (expires_at, key),
            )
            return bool(getattr(cursor, "rowcount", 0) or 0)

    async def llen(self, key: str) -> int:
        """Length of an ordered list (Redis ``LLEN``)."""
        if self._conn is None:
            return 0
        async with self._lock:
            rows = await self._fetch(
                "SELECT COUNT(*) AS n FROM cache_lists WHERE key = ?", (key,)
            )
        return int(rows[0]["n"]) if rows else 0

    async def keys(self, pattern: str) -> list[str]:
        """List keys matching a Redis-style glob (``*``, ``?``, ``[...]``)."""
        if self._conn is None:
            return []
        now = time.time()
        async with self._lock:
            entry_rows = await self._fetch(
                "SELECT key FROM cache_entries WHERE expires_at IS NULL OR expires_at > ?",
                (now,),
            )
            list_rows = await self._fetch("SELECT DISTINCT key FROM cache_lists", ())
        found = {str(r["key"]) for r in entry_rows} | {str(r["key"]) for r in list_rows}
        return sorted(k for k in found if fnmatch.fnmatchcase(k, pattern))


    # ── ordered lists (telemetry tail, work queues) ─────────────────────────

    async def push_tail(self, key: str, value: str) -> None:
        if self._conn is None:
            return
        async with self._lock:
            seq_rows = await self._fetch(
                "UPDATE cache_seq SET value = value + 1 WHERE id = 1 RETURNING value"
            )
            seq = int(seq_rows[0]["value"]) if seq_rows else 1
            await self._run(
                self._conn.execute,
                "INSERT INTO cache_lists (key, seq, value) VALUES (?, ?, ?)",
                (key, seq, value),
            )

    async def range(self, key: str, start: int, end: int) -> list[str]:
        if self._conn is None:
            return []
        async with self._lock:
            rows = await self._fetch(
                "SELECT value FROM cache_lists WHERE key = ? ORDER BY seq DESC", (key,)
            )
        values = [str(r["value"]) for r in rows]
        return [values[i] for i in _slice_positions(len(values), start, end)]

    async def trim(self, key: str, start: int, end: int) -> None:
        if self._conn is None:
            return
        async with self._lock:
            rows = await self._fetch(
                "SELECT seq FROM cache_lists WHERE key = ? ORDER BY seq DESC", (key,)
            )
            seqs = [int(r["seq"]) for r in rows]
            keep = {seqs[i] for i in _slice_positions(len(seqs), start, end)}
            for seq in seqs:
                if seq not in keep:
                    await self._run(
                        self._conn.execute,
                        "DELETE FROM cache_lists WHERE key = ? AND seq = ?",
                        (key, seq),
                    )
