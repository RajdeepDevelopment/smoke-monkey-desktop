"""Local provider-key reader for the desktop document worker (BYOK).

Same ``keys.db`` rag-service owns: the desktop web UI saves provider API keys
through rag-service's keys API, which mirrors them into the local cache under
``rag:user_key:{user_id}:{provider}``. The worker reads the durable SQLite
store directly (``_ingest`` passes it in local mode) so embedding uses the
user's own cloud key — no GPU, no forced local Ollama.
"""
from __future__ import annotations

import asyncio
import logging
import sqlite3
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS provider_keys (
    provider   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    api_key    TEXT NOT NULL,
    key_prefix TEXT,
    last4      TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (provider, user_id)
);
"""


def _now() -> str:
    return datetime.now(UTC).isoformat()


class LocalKeyStore:
    """SQLite-backed provider keys (must match rag-service's schema)."""

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
        await asyncio.to_thread(self._conn.executescript, _SCHEMA)

    async def close(self) -> None:
        conn, self._conn = self._conn, None
        if conn is not None:
            await asyncio.to_thread(conn.close)

    def _run(self, fn: Any, *args: Any) -> Any:
        return asyncio.to_thread(fn, *args)

    async def _fetch(self, query: str, params: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
        cursor = await asyncio.to_thread(self._conn.execute, query, params)
        return await asyncio.to_thread(cursor.fetchall)

    async def get(self, provider: str, user_id: str) -> str | None:
        rows = await self._fetch(
            "SELECT api_key FROM provider_keys WHERE provider = ? AND user_id = ?",
            (provider, user_id),
        )
        return str(rows[0]["api_key"]) if rows else None

    async def has(self, provider: str, user_id: str) -> bool:
        return await self.get(provider, user_id) is not None

    async def set(self, provider: str, user_id: str, api_key: str) -> None:
        now = _now()
        async with self._lock:
            await self._run(
                self._conn.execute,
                "INSERT INTO provider_keys "
                "(provider, user_id, api_key, key_prefix, last4, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(provider, user_id) DO UPDATE SET "
                "api_key = excluded.api_key, updated_at = excluded.updated_at",
                (provider, user_id, api_key.strip(), api_key[:9] + "…", api_key[-4:], now),
            )

    async def delete(self, provider: str, user_id: str) -> bool:
        async with self._lock:
            cursor = await self._run(
                self._conn.execute,
                "DELETE FROM provider_keys WHERE provider = ? AND user_id = ?",
                (provider, user_id),
            )
            return bool(cursor.rowcount)

    async def list(self, user_id: str) -> list[dict[str, Any]]:
        rows = await self._fetch(
            "SELECT provider, key_prefix, last4, updated_at FROM provider_keys "
            "WHERE user_id = ? ORDER BY updated_at DESC",
            (user_id,),
        )
        return [dict(r) for r in rows]
