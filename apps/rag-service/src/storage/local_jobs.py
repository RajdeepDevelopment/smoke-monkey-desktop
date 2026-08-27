"""Local job queue for the desktop edition (producer side).

rag-service enqueues PDF ingestion jobs for the document-worker into the same
SQLite ``jobs.db`` the worker polls (see document-worker's ``local_jobs.py`` for
the consumer half). The table schema must match exactly; both processes use WAL
+ busy_timeout so the file is safe to share.
"""
from __future__ import annotations

import asyncio
import logging
import sqlite3
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS ingest_jobs (
    job_id      TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    filename    TEXT NOT NULL,
    s3_key      TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    attempts    INTEGER NOT NULL DEFAULT 0,
    error       TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    claimed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_ingest_jobs_status ON ingest_jobs (status, created_at);
"""


def _now() -> str:
    return datetime.now(UTC).isoformat()


class LocalJobQueue:
    """SQLite-backed ingest queue. Producer view: enqueue jobs for the worker."""

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

    async def submit(
        self,
        *,
        job_id: str,
        document_id: str,
        user_id: str,
        filename: str,
        s3_key: str,
    ) -> None:
        """Enqueue an ingest job (idempotent on ``job_id``)."""
        now = _now()
        async with self._lock:
            await self._run(
                self._conn.execute,
                "INSERT OR IGNORE INTO ingest_jobs "
                "(job_id, document_id, user_id, filename, s3_key, status, "
                "created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
                (job_id, document_id, user_id, filename, s3_key, now, now),
            )

    async def pending_count(self) -> int:
        rows = await self._fetch(
            "SELECT COUNT(*) AS n FROM ingest_jobs WHERE status = 'pending'"
        )
        return int(rows[0]["n"]) if rows else 0

    async def status_of(self, document_id: str) -> str | None:
        rows = await self._fetch(
            "SELECT status FROM ingest_jobs WHERE document_id = ? ORDER BY created_at DESC LIMIT 1",
            (str(document_id),),
        )
        return str(rows[0]["status"]) if rows else None

    async def job_exists(self, job_id: str) -> bool:
        rows = await self._fetch(
            "SELECT 1 FROM ingest_jobs WHERE job_id = ?", (str(job_id),)
        )
        return bool(rows)
