"""Transactional Outbox for cross-store memory consistency.

Postgres is the source of truth. Every durable memory write (insert / merge /
refresh / delete) is appended to ``memory_outbox`` in the *same transaction* as
the write itself; a relay worker then replays those events into the Neo4j graph
(and any future downstream store) with retry + exponential backoff. Events that
exhaust their attempts are parked in ``memory_outbox_dlq`` instead of being
dropped or retried forever.

Invariants this enforces:

1. **Atomic emit** — ``emit`` runs on the caller's connection, so the memory
   row and its outbox row commit or roll back together. A pgvector write can no
   longer succeed while its graph mirror silently vanishes.
2. **At-least-once replay with idempotent handlers** — a crashed relay leaves
   rows in ``processing``; ``requeue_stale`` reclaims them after the lease
   expires. Handlers must be idempotent (Neo4j MERGE/DETACH are).
3. **Bounded retries** — attempts escalate with exponential backoff + jitter;
   past ``memory_outbox_max_attempts`` the event is moved to the DLQ table.
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import re
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)

# Event types written by the memory store and replayed by the relay.
EVENT_MEMORY_STORED = "memory_stored"
EVENT_MEMORY_MERGED = "memory_merged"
EVENT_MEMORY_REFRESHED = "memory_refreshed"
EVENT_MEMORY_DELETED = "memory_deleted"

_CLAIM_SQL = """
WITH due AS (
    SELECT id
    FROM memory_outbox
    WHERE status = 'pending'
      AND (next_attempt_at IS NULL OR next_attempt_at <= now())
    ORDER BY created_at
    LIMIT $1
    FOR UPDATE SKIP LOCKED
)
UPDATE memory_outbox
SET status = 'processing', claimed_at = now()
WHERE id IN (SELECT id FROM due)
RETURNING id, event_type, user_id, aggregate_id, payload, idempotency_key, attempt_count, created_at
"""


def _as_payload(raw: Any) -> dict[str, Any]:
    """asyncpg returns JSONB as a JSON string unless a codec is registered.

    Defensively decode: a raw str is loaded, anything dict-like is kept, and a
    broken/missing payload degrades to {} so the relay never crashes on it.
    """
    if raw is None:
        return {}
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except (ValueError, TypeError):
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def next_attempt_delay(
    attempt_count: int,
    base_s: float = 1.0,
    max_s: float = 300.0,
    jitter: float = 0.25,
) -> float:
    """Exponential backoff with full jitter: base * 2**attempt, capped.

    Full jitter avoids the retry-storm thundering herd when thousands of
    events fail at once (each retries at a random point in the window).
    """
    exponent = 2.0 ** max(0, attempt_count - 1)
    window = min(max_s, base_s * exponent)
    return window * (1.0 - jitter * random.random())


@dataclass
class OutboxEvent:
    """One outbox row as consumed by the relay."""

    id: str
    event_type: str
    user_id: str
    aggregate_id: str
    payload: dict[str, Any]
    idempotency_key: str = ""
    attempt_count: int = 0
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))


class OutboxStore:
    """Postgres-backed outbox. ``pool`` may be None (disables persistence)."""

    def __init__(self, pool: Any | None = None) -> None:
        self.pool = pool

    async def ensure_schema(self) -> None:
        if self.pool is None:
            return
        async with self.pool.acquire() as conn:
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS memory_outbox (
                    id UUID PRIMARY KEY,
                    event_type VARCHAR(64) NOT NULL,
                    user_id VARCHAR(255) NOT NULL,
                    aggregate_id VARCHAR(255) NOT NULL,
                    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                    idempotency_key VARCHAR(512) NOT NULL UNIQUE,
                    status VARCHAR(32) NOT NULL DEFAULT 'pending',
                    attempt_count INTEGER NOT NULL DEFAULT 0,
                    claimed_at TIMESTAMPTZ,
                    next_attempt_at TIMESTAMPTZ,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                CREATE INDEX IF NOT EXISTS idx_outbox_claim ON memory_outbox(status, created_at);

                CREATE TABLE IF NOT EXISTS memory_outbox_dlq (
                    id UUID PRIMARY KEY,
                    event_type VARCHAR(64) NOT NULL,
                    user_id VARCHAR(255) NOT NULL,
                    aggregate_id VARCHAR(255) NOT NULL,
                    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                    idempotency_key VARCHAR(512) NOT NULL,
                    attempt_count INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT,
                    moved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                CREATE INDEX IF NOT EXISTS idx_outbox_dlq_moved ON memory_outbox_dlq(moved_at);
                """
            )

    async def emit(
        self,
        conn: Any,
        *,
        event_type: str,
        user_id: str,
        aggregate_id: str,
        payload: dict[str, Any],
        idempotency_key: str,
    ) -> None:
        """Insert an outbox event on the caller's connection (same tx as the
        memory write). Idempotent: a repeated key is ignored."""
        if self.pool is None or conn is None:
            return
        await conn.execute(
            """
            INSERT INTO memory_outbox
                (id, event_type, user_id, aggregate_id, payload, idempotency_key)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (idempotency_key) DO NOTHING
            """,
            uuid.UUID(str(uuid.uuid4())),
            event_type,
            user_id,
            aggregate_id,
            json.dumps(payload or {}, default=str),
            idempotency_key,
        )
        logger.debug("outbox emitted %s -> %s (%s)", event_type, aggregate_id, user_id)

    async def claim_batch(self, batch_size: int = 50) -> list[OutboxEvent]:
        """Claim up to ``batch_size`` pending events (FOR UPDATE SKIP LOCKED).

        Multiple relay workers racing here each get a disjoint slice, so
        scaling out is safe.
        """
        if self.pool is None:
            return []
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(_CLAIM_SQL, max(1, batch_size))
            return [
                OutboxEvent(
                    id=str(r["id"]),
                    event_type=r["event_type"],
                    user_id=r["user_id"],
                    aggregate_id=str(r["aggregate_id"]),
                    payload=_as_payload(r["payload"]),
                    idempotency_key=r["idempotency_key"] or "",
                    attempt_count=int(r["attempt_count"] or 0),
                    created_at=r["created_at"],
                )
                for r in rows
            ]

    async def mark_done(self, event_ids: list[str]) -> None:
        if self.pool is None or not event_ids:
            return
        async with self.pool.acquire() as conn:
            await conn.execute(
                "UPDATE memory_outbox SET status = 'done', claimed_at = NULL "
                "WHERE id = ANY($1::uuid[])",
                [uuid.UUID(eid) for eid in event_ids],
            )

    async def mark_failed(
        self,
        event_ids: list[str],
        error: str,
        *,
        max_attempts: int = 5,
        base_s: float = 1.0,
        max_s: float = 300.0,
    ) -> list[str]:
        """Bump attempts; either schedule a backoff retry or park in the DLQ.

        Returns the ids moved to the DLQ.
        """
        if self.pool is None or not event_ids:
            return []
        dlq_moved: list[str] = []
        async with self.pool.acquire() as conn:
            for eid in event_ids:
                row = await conn.fetchrow(
                    "UPDATE memory_outbox "
                    "SET attempt_count = attempt_count + 1, "
                    "    status = 'pending', claimed_at = NULL, "
                    "    next_attempt_at = now() + $2::double precision * INTERVAL '1 second' "
                    "WHERE id = $1::uuid "
                    "RETURNING attempt_count, event_type, user_id, aggregate_id, "
                    "          payload, idempotency_key",
                    uuid.UUID(eid),
                    next_attempt_delay(1, base_s=base_s, max_s=max_s),
                )
                if row is None:
                    continue
                if int(row["attempt_count"]) >= max_attempts:
                    await conn.execute(
                        """
                        INSERT INTO memory_outbox_dlq
                            (id, event_type, user_id, aggregate_id, payload,
                             idempotency_key, attempt_count, last_error)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                        """,
                        uuid.UUID(eid),
                        row["event_type"],
                        row["user_id"],
                        row["aggregate_id"],
                        row["payload"] or {},
                        row["idempotency_key"] or "",
                        int(row["attempt_count"]),
                        error[:2000],
                    )
                    await conn.execute(
                        "DELETE FROM memory_outbox WHERE id = $1::uuid",
                        uuid.UUID(eid),
                    )
                    dlq_moved.append(eid)
        return dlq_moved

    async def requeue_stale(self, claim_seconds: int = 60) -> int:
        """Reclaim events stuck in 'processing' past the lease (crashed relay)."""
        if self.pool is None:
            return 0
        async with self.pool.acquire() as conn:
            result = await conn.execute(
                """
                UPDATE memory_outbox
                SET status = 'pending', claimed_at = NULL,
                    next_attempt_at = now()
                WHERE status = 'processing'
                  AND claimed_at < now() - $1::int * INTERVAL '1 second'
                """,
                max(1, claim_seconds),
            )
            # asyncpg execute returns a status string like "UPDATE 3".
            match = re.search(r"(\d+)\s*$", str(result or ""))
            return int(match.group(1)) if match else 0


class OutboxRelay:
    """Background worker: claims outbox events and applies them downstream.

    ``handler`` receives each ``OutboxEvent`` and must be idempotent. A raised
    exception counts as a failure → backoff retry, then DLQ. The loop is
    crash-safe: stale ``processing`` rows are reclaimed on each cycle.
    """

    def __init__(
        self,
        store: OutboxStore,
        handler: Callable[[OutboxEvent], Awaitable[None]] | None = None,
        *,
        batch_size: int = 50,
        poll_interval_s: float = 1.0,
        claim_seconds: int = 60,
        max_attempts: int = 5,
        backoff_base_s: float = 1.0,
        backoff_max_s: float = 300.0,
        metrics: Any | None = None,
        tracing: Any | None = None,
    ) -> None:
        self.store = store
        self.handler = handler
        self.batch_size = max(1, batch_size)
        self.poll_interval_s = poll_interval_s
        self.claim_seconds = max(1, claim_seconds)
        self.max_attempts = max(1, max_attempts)
        self.backoff_base_s = backoff_base_s
        self.backoff_max_s = backoff_max_s
        self.metrics = metrics
        self.tracing = tracing
        self.running = False
        self.total_processed = 0
        self.total_failed = 0
        self.total_dlq = 0
        self.observed_queue_depth = 0

    def _metric(self, name: str, delta: int = 1) -> None:
        if self.metrics is not None:
            self.metrics.increment(name, delta)

    async def process_one(self, event: OutboxEvent) -> None:
        if self.handler is None:
            logger.debug("no handler for outbox event %s", event.id)
            return
        span = None
        if self.tracing is not None:
            span = self.tracing.start_span(
                "outbox.process_event",
                event_type=event.event_type,
                user_id=event.user_id,
            )
        try:
            if span is not None:
                async with span:
                    await self.handler(event)
            else:
                await self.handler(event)
        finally:
            self._metric(f"outbox.processed.{event.event_type}")

    async def run_once(self) -> None:
        """Single relay pass: requeue stale → claim → process → ack/fail."""
        started = time.monotonic()
        try:
            self.observed_queue_depth = await self.store.requeue_stale(self.claim_seconds)
        except Exception as exc:  # noqa: BLE001 - best-effort housekeeping
            logger.debug("outbox requeue_stale failed: %s", exc)
        if self.metrics is not None:
            self.metrics.gauge("outbox.queue_depth", self.observed_queue_depth)
        try:
            events = await self.store.claim_batch(self.batch_size)
        except Exception as exc:  # noqa: BLE001
            logger.warning("outbox claim failed: %s", exc)
            return
        if not events:
            return

        self._metric("outbox.claimed", len(events))
        done: list[str] = []
        failed: list[str] = []
        for event in events:
            try:
                await self.process_one(event)
                done.append(event.id)
                self.total_processed += 1
            except Exception as exc:  # noqa: BLE001 - per-event isolation
                failed.append(event.id)
                self.total_failed += 1
                logger.warning(
                    "outbox event %s (%s) failed: %s",
                    event.id,
                    event.event_type,
                    exc,
                )
        if done:
            try:
                await self.store.mark_done(done)
            except Exception as exc:  # noqa: BLE001
                logger.warning("outbox mark_done failed: %s", exc)
        if failed:
            try:
                moved = await self.store.mark_failed(
                    failed,
                    "relay handler error",
                    max_attempts=self.max_attempts,
                    base_s=self.backoff_base_s,
                    max_s=self.backoff_max_s,
                )
                self.total_dlq += len(moved)
                self._metric("outbox.dlq_moved", len(moved))
            except Exception as exc:  # noqa: BLE001
                logger.warning("outbox mark_failed failed: %s", exc)
        self._metric("outbox.processed", len(done))
        self._metric("outbox.failed", len(failed))
        if self.metrics is not None:
            self.metrics.record_timing("outbox.cycle", (time.monotonic() - started) * 1000)
        if failed:
            logger.warning(
                "outbox relay: %d/%d events failed (dlq=%d)",
                len(failed),
                len(events),
                self.total_dlq,
            )

    async def run_loop(self) -> None:
        """Run until cancelled. Safe to run as a background task per worker."""
        self.running = True
        logger.info("outbox relay started (batch=%d, interval=%.1fs)", self.batch_size, self.poll_interval_s)
        try:
            while self.running:
                await self.run_once()
                await asyncio.sleep(self.poll_interval_s)
        except asyncio.CancelledError:
            pass
        finally:
            self.running = False
            logger.info("outbox relay stopped")
