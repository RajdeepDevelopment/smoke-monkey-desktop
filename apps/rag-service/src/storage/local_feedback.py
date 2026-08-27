"""Local feedback store for the desktop edition.

The cloud writes user feedback (thumbs up/down + comment) into Postgres
(``feedback`` table, ``gen_random_uuid()`` ids). The desktop has no Postgres, so
rag-service owns the same contract in SQLite: ``POST /api/v1/feedback`` stores
the row in ``feedback.db`` and the UI reads exactly the same response shape.
"""
from __future__ import annotations

import asyncio
import sqlite3
import uuid
from datetime import UTC, datetime
from typing import Any

_SCHEMA = """
CREATE TABLE IF NOT EXISTS feedback (
    id          TEXT PRIMARY KEY,
    message_id  TEXT NOT NULL,
    helpful     BOOLEAN,
    comment     TEXT,
    created_at  TEXT NOT NULL
);
"""


class LocalFeedbackStore:
    """SQLite-backed feedback rows, one per rating."""

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

    async def save(
        self,
        message_id: str,
        helpful: bool | None,
        comment: str | None,
    ) -> dict[str, Any]:
        """Persist one rating and return the stored row summary."""
        row_id = str(uuid.uuid4())
        now = datetime.now(UTC).isoformat()
        async with self._lock:
            await asyncio.to_thread(
                self._conn.execute,
                "INSERT INTO feedback (id, message_id, helpful, comment, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (row_id, message_id, helpful, comment, now),
            )
        return {"id": row_id, "message_id": message_id, "created_at": now}

    async def count(self) -> int:
        cursor = await asyncio.to_thread(self._conn.execute, "SELECT COUNT(*) FROM feedback")
        row = await asyncio.to_thread(cursor.fetchone)
        return int(row[0])
