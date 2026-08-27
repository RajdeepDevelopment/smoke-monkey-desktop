"""Local job queue for the desktop edition (consumer side).

The desktop swaps the NATS JetStream ingest transport for a SQLite queue shared
between rag-service (producer) and this worker (consumer), stored at
``local_data_dir/jobs.db`` next to ``memory.db``. WAL + busy_timeout let both
processes touch the file concurrently.

Jobs are claimed atomically (single ``BEGIN IMMEDIATE`` transaction) so two
worker processes can never process the same job, and a crashed worker's
in-flight jobs are requeued by ``recover_stale`` at startup.
"""
from __future__ import annotations

import asyncio
import logging
import sqlite3
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from src.config import settings
from src.domain import IngestJob

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

PENDING = "pending"
PROCESSING = "processing"
DONE = "done"
FAILED = "failed"


def _now() -> str:
    return datetime.now(UTC).isoformat()


class LocalJobQueue:
    """SQLite-backed ingest queue. Same schema on the producer and consumer.

    The queue is a *transport*, not a store: it only remembers which PDFs are
    waiting for / done with ingestion. Document content and status live in the
    shared ``memory.db`` (rag-service reads them from there).
    """

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

    async def submit(self, payload: dict[str, Any]) -> None:
        """Insert a job (idempotent on ``jobId``). Mirrors the NATS publish."""
        job = IngestJob.from_payload(payload)
        now = _now()
        async with self._lock:
            await self._run(
                self._conn.execute,
                "INSERT OR IGNORE INTO ingest_jobs "
                "(job_id, document_id, user_id, filename, s3_key, status, "
                "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    str(job.job_id),
                    str(job.document_id),
                    str(job.user_id),
                    job.filename,
                    job.s3_key,
                    PENDING,
                    now,
                    now,
                ),
            )

    async def next_batch(self, batch_size: int = 10) -> list[IngestJob]:
        """Claim up to ``batch_size`` pending jobs (oldest first), atomically."""
        if self._conn is None or batch_size <= 0:
            return []
        now = _now()
        async with self._lock:
            await self._run(self._conn.execute, "BEGIN IMMEDIATE")
            try:
                rows = await self._fetch(
                    "SELECT job_id FROM ingest_jobs WHERE status = ? "
                    "ORDER BY created_at LIMIT ?",
                    (PENDING, batch_size),
                )
                ids = [str(r["job_id"]) for r in rows]
                if not ids:
                    await self._run(self._conn.execute, "COMMIT")
                    return []
                marks = ",".join("?" * len(ids))
                await self._run(
                    self._conn.execute,
                    "UPDATE ingest_jobs SET status = ?, attempts = attempts + 1, "
                    "claimed_at = ?, updated_at = ? "
                    f"WHERE job_id IN ({marks})",
                    (PROCESSING, now, now, *ids),
                )
                claimed = await self._fetch(
                    "SELECT * FROM ingest_jobs WHERE status = ? ORDER BY created_at",
                    (PROCESSING,),
                )
                await self._run(self._conn.execute, "COMMIT")
            except BaseException:
                await self._run(self._conn.execute, "ROLLBACK")
                raise
        return [_to_job(row) for row in claimed if str(row["job_id"]) in ids]

    async def complete(self, job_id: uuid.UUID | str) -> None:
        await self._mark(job_id, DONE, error=None)

    async def fail(self, job_id: uuid.UUID | str, error: str | None = None) -> None:
        await self._mark(job_id, FAILED, error=error)

    async def _mark(self, job_id: uuid.UUID | str, status: str, error: str | None) -> None:
        async with self._lock:
            await self._run(
                self._conn.execute,
                "UPDATE ingest_jobs SET status = ?, error = ?, updated_at = ? WHERE job_id = ?",
                (status, error, _now(), str(job_id)),
            )

    async def recover_stale(self, claim_seconds: int = 300) -> int:
        """Requeue in-flight jobs whose claim has gone stale (crashed worker)."""
        cutoff = (datetime.now(UTC) - timedelta(seconds=claim_seconds)).isoformat()
        async with self._lock:
            cursor = await self._run(
                self._conn.execute,
                "UPDATE ingest_jobs SET status = ?, claimed_at = NULL, updated_at = ? "
                "WHERE status = ? AND claimed_at < ?",
                (PENDING, _now(), PROCESSING, cutoff),
            )
            return int(cursor.rowcount or 0)

    async def status_of(self, document_id: str) -> str | None:
        rows = await self._fetch(
            "SELECT status FROM ingest_jobs WHERE document_id = ? ORDER BY created_at DESC LIMIT 1",
            (str(document_id),),
        )
        return str(rows[0]["status"]) if rows else None


def _to_job(row: sqlite3.Row) -> IngestJob:
    return IngestJob(
        job_id=uuid.UUID(str(row["job_id"])),
        document_id=uuid.UUID(str(row["document_id"])),
        user_id=str(row["user_id"]),
        filename=str(row["filename"]),
        s3_key=str(row["s3_key"]),
    )


def build_local_job_queue() -> LocalJobQueue:
    from pathlib import Path

    root = Path(settings.local_data_dir).expanduser()
    root.mkdir(parents=True, exist_ok=True)
    return LocalJobQueue(str(root / "jobs.db"))
