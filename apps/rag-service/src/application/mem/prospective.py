"""Prospective Memory & Durable Task Scheduler.

Differentiates Prospective Memory ("What do I need to remember?") from Scheduled Intents ("When should the system act?").

Timezone Rules:
- Uses IANA timezone IDs (e.g. 'Asia/Kolkata', 'America/New_York', 'Europe/London', 'Australia/Sydney')
  via Python's standard `zoneinfo.ZoneInfo` database.
- Never manually applies fixed UTC offsets.
- Converts one-time execution timestamps to UTC for durable PostgreSQL storage.
- Recurring "8 AM local time" schedules retain the IANA timezone and recalculate the next UTC trigger
  timestamp for each occurrence, taking Daylight Saving Time (DST) transitions into account.

Manages 3-tier queue semantics:
- URGENT_QUEUE: Immediate notification/reminder worker.
- RETURN_CONTEXT_QUEUE: Surfaced when the user starts a session / interacts next.
- BACKGROUND_MEMORY_QUEUE: Asynchronous observer background processing.

Reliability:
- Exactly-once dispatch via the ``intent_executions`` idempotency table.
- Configurable missed-intent policy (item 4): ``dispatch_late`` (bounded grace,
  then expire), ``expire``, ``reschedule``, or ``alert`` — replaces the old
  fixed 24h expiry.
- Scheduler-side retry + exponential backoff + DLQ (item 10): failed enqueues
  escalate with backoff into the ``intent_dlq`` table instead of hot-looping.
- Fairness/backpressure (item 11): per-user cap per cycle + per-user rate
  limit on the background observer queue.
- Timezone confidence + source (item 17): prospective memories record whether
  the timezone was explicit, inferred, or the default.
- Metrics + tracing (item 18): scheduler cycles/dispatches/expiries/DLQ moves
  flow into the ``MemoryMetrics`` registry.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import UTC, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from src.application.mem.models import (
    ProspectiveMemory,
    ProspectiveStatus,
    ScheduledIntent,
    ScheduleType,
)
from src.application.mem.outbox import next_attempt_delay

logger = logging.getLogger(__name__)

MAX_PROSPECTIVE_CONTEXT = 2

# Missed-intent policies (settings.scheduler_missed_policy).
MISSED_POLICY_DISPATCH_LATE = "dispatch_late"
MISSED_POLICY_EXPIRE = "expire"
MISSED_POLICY_RESCHEDULE = "reschedule"
MISSED_POLICY_ALERT = "alert"


def get_iana_timezone(iana_tz: str) -> ZoneInfo:
    """Safely load an IANA timezone ID, falling back to UTC if invalid."""
    if not iana_tz or not isinstance(iana_tz, str):
        return ZoneInfo("UTC")
    try:
        return ZoneInfo(iana_tz.strip())
    except Exception:
        logger.warning("Invalid IANA timezone '%s'; falling back to UTC", iana_tz)
        return ZoneInfo("UTC")


def parse_local_to_utc(
    dt_or_str: datetime | str,
    iana_tz: str = "Asia/Kolkata",
) -> tuple[datetime, datetime]:
    """Interpret human time in specified IANA timezone and convert to UTC for durable storage.

    Never applies fixed offsets manually; uses the zoneinfo database for DST awareness.
    Returns (local_datetime_in_tz, utc_datetime).
    """
    tz = get_iana_timezone(iana_tz)

    if isinstance(dt_or_str, str):
        dt = datetime.fromisoformat(dt_or_str)
    else:
        dt = dt_or_str

    if dt.tzinfo is None:
        local_dt = dt.replace(tzinfo=tz)
    else:
        local_dt = dt.astimezone(tz)

    utc_dt = local_dt.astimezone(UTC)
    return local_dt, utc_dt


def calculate_next_occurrence_utc(
    schedule_type: ScheduleType,
    from_utc: datetime,
    iana_tz: str = "Asia/Kolkata",
    target_hour: int = 8,
    target_minute: int = 0,
) -> datetime:
    """Recalculate the next occurrence timestamp in UTC for recurring schedules.

    Retains the IANA timezone and target local time (e.g. 8:00 AM local), evaluating
    DST transitions dynamically via the zoneinfo database.
    """
    tz = get_iana_timezone(iana_tz)
    local_now = from_utc.astimezone(tz)

    if schedule_type == ScheduleType.DAILY:
        candidate_date = local_now.date() + timedelta(days=1)
    elif schedule_type == ScheduleType.WEEKLY:
        candidate_date = local_now.date() + timedelta(days=7)
    else:
        candidate_date = local_now.date() + timedelta(days=1)

    next_local_dt = datetime.combine(candidate_date, time(hour=target_hour, minute=target_minute), tzinfo=tz)
    return next_local_dt.astimezone(UTC)


class ProspectiveMemoryStore:
    """Store and scheduler for prospective memories and scheduled intents."""

    def __init__(
        self,
        pool: Any | None = None,
        redis: Any | None = None,
        *,
        poll_interval_s: float = 2.0,
        claim_batch: int = 100,
        claim_seconds: int = 120,
        max_per_user_per_cycle: int = 10,
        background_max_per_user_per_minute: int = 60,
        missed_policy: str = MISSED_POLICY_DISPATCH_LATE,
        missed_dispatch_max_hours: int = 24,
        max_attempts: int = 5,
        backoff_base_s: float = 1.0,
        backoff_max_s: float = 300.0,
        metrics: Any | None = None,
        tracing: Any | None = None,
    ) -> None:
        self.pool = pool
        self.redis = redis
        self._memories: dict[str, ProspectiveMemory] = {}
        self._intents: dict[str, ScheduledIntent] = {}
        self._processed_idempotency_keys: set[str] = set()
        self.poll_interval_s = poll_interval_s
        self.claim_batch = max(1, claim_batch)
        self.claim_seconds = max(1, claim_seconds)
        self.max_per_user_per_cycle = max(1, max_per_user_per_cycle)
        self.background_max_per_user_per_minute = max(1, background_max_per_user_per_minute)
        self.missed_policy = missed_policy
        self.missed_dispatch_max_hours = max(1, missed_dispatch_max_hours)
        self.max_attempts = max(1, max_attempts)
        self.backoff_base_s = max(0.1, backoff_base_s)
        self.backoff_max_s = max(1.0, backoff_max_s)
        self.metrics = metrics
        self.tracing = tracing
        self.running = False
        self.last_cycle_dispatched = 0

    def _metric(self, name: str, delta: int = 1) -> None:
        if self.metrics is not None:
            self.metrics.increment(name, delta)

    async def ensure_schema(self) -> None:
        """Create PostgreSQL tables for prospective memories and scheduled intents."""
        if self.pool is None:
            return
        async with self.pool.acquire() as conn:
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS prospective_memories (
                    id UUID PRIMARY KEY,
                    user_id VARCHAR(255) NOT NULL,
                    subject TEXT NOT NULL,
                    content TEXT NOT NULL,
                    event_at TIMESTAMPTZ,
                    timezone VARCHAR(64) DEFAULT 'Asia/Kolkata',
                    timezone_source VARCHAR(16) DEFAULT 'default',
                    timezone_confidence DOUBLE PRECISION DEFAULT 0.3,
                    importance DOUBLE PRECISION DEFAULT 0.8,
                    status VARCHAR(32) DEFAULT 'pending',
                    snoozed_until TIMESTAMPTZ,
                    surface_policy JSONB,
                    created_at TIMESTAMPTZ DEFAULT NOW()
                );
                CREATE INDEX IF NOT EXISTS idx_prospective_user ON prospective_memories(user_id, status);

                CREATE TABLE IF NOT EXISTS scheduled_intents (
                    id UUID PRIMARY KEY,
                    prospective_memory_id UUID REFERENCES prospective_memories(id) ON DELETE CASCADE,
                    user_id VARCHAR(255) NOT NULL,
                    trigger_at TIMESTAMPTZ NOT NULL,
                    trigger_at_utc TIMESTAMPTZ NOT NULL,
                    timezone VARCHAR(64) DEFAULT 'Asia/Kolkata',
                    schedule_type VARCHAR(32) DEFAULT 'once',
                    trigger_policy VARCHAR(64) DEFAULT '1_day_before',
                    action VARCHAR(64) DEFAULT 'RETURN_CONTEXT',
                    payload JSONB,
                    idempotency_key VARCHAR(255) UNIQUE,
                    status VARCHAR(32) DEFAULT 'pending',
                    claimed_at TIMESTAMPTZ,
                    next_attempt_at TIMESTAMPTZ,
                    attempt_count INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT,
                    created_at TIMESTAMPTZ DEFAULT NOW()
                );
                CREATE INDEX IF NOT EXISTS idx_intents_trigger ON scheduled_intents(trigger_at_utc, status);

                CREATE TABLE IF NOT EXISTS intent_executions (
                    id UUID PRIMARY KEY,
                    intent_id UUID REFERENCES scheduled_intents(id) ON DELETE CASCADE,
                    idempotency_key VARCHAR(512) NOT NULL UNIQUE,
                    status VARCHAR(32) DEFAULT 'processing',
                    started_at TIMESTAMPTZ DEFAULT NOW(),
                    completed_at TIMESTAMPTZ,
                    result TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_intent_exec_intent ON intent_executions(intent_id);

                CREATE TABLE IF NOT EXISTS intent_dlq (
                    id UUID PRIMARY KEY,
                    intent_id UUID,
                    user_id VARCHAR(255) NOT NULL,
                    subject TEXT,
                    action VARCHAR(64),
                    reason TEXT,
                    attempts INTEGER DEFAULT 0,
                    payload JSONB,
                    moved_at TIMESTAMPTZ DEFAULT NOW()
                );
                CREATE INDEX IF NOT EXISTS idx_intent_dlq_moved ON intent_dlq(moved_at);

                ALTER TABLE prospective_memories ADD COLUMN IF NOT EXISTS timezone_source VARCHAR(16) DEFAULT 'default';
                ALTER TABLE prospective_memories ADD COLUMN IF NOT EXISTS timezone_confidence DOUBLE PRECISION DEFAULT 0.3;
                ALTER TABLE scheduled_intents ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
                ALTER TABLE scheduled_intents ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
                ALTER TABLE scheduled_intents ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;
                ALTER TABLE scheduled_intents ADD COLUMN IF NOT EXISTS last_error TEXT;
                """
            )

    async def _claim_due_intents(self) -> list[dict[str, Any]]:
        """Claim due intents with FOR UPDATE SKIP LOCKED (safe to scale out).

        Only one worker ever claims each row, so no two schedulers can dispatch
        the same intent. Returns the claimed rows as raw dicts.
        """
        if self.pool is None:
            return []
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """
                WITH due AS (
                    SELECT id
                    FROM scheduled_intents
                    WHERE status = 'pending'
                      AND trigger_at_utc <= $1
                      AND (next_attempt_at IS NULL OR next_attempt_at <= now())
                    ORDER BY trigger_at_utc
                    LIMIT $2
                    FOR UPDATE SKIP LOCKED
                )
                UPDATE scheduled_intents
                SET status = 'processing', claimed_at = now()
                WHERE id IN (SELECT id FROM due)
                RETURNING id, prospective_memory_id, user_id, trigger_at,
                          trigger_at_utc, timezone, schedule_type, trigger_policy,
                          action, payload, idempotency_key, status,
                          attempt_count, last_error
                """,
                datetime.now(UTC),
                self.claim_batch,
            )
            return [dict(r) for r in rows]

    async def _release_intents(
        self,
        intent_ids: list[str],
        *,
        next_attempt_at: datetime | None = None,
    ) -> None:
        """Put intents back to 'pending' (fairness overflow / rate limited)."""
        if self.pool is None or not intent_ids:
            return
        async with self.pool.acquire() as conn:
            await conn.execute(
                "UPDATE scheduled_intents SET status = 'pending', claimed_at = NULL, "
                "next_attempt_at = $2 "
                "WHERE id = ANY($1::uuid[])",
                [uuid.UUID(iid) for iid in intent_ids],
                next_attempt_at,
            )

    async def _begin_execution(self, intent: ScheduledIntent) -> str | None:
        """Reserve exactly-once execution for an intent.

        Inserts into ``intent_executions`` under the intent's idempotency key.
        Returns the execution id when THIS worker won the insert, or None when
        the intent was already executed (duplicate delivery must be skipped).
        """
        if self.pool is None:
            # No persistence (tests): in-memory dedupe handles it.
            if intent.idempotency_key in self._processed_idempotency_keys:
                return None
            return str(uuid.uuid4())
        execution_id = str(uuid.uuid4())
        idempotency_key = intent.idempotency_key or f"{intent.user_id}:{intent.id}:0"
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO intent_executions (id, intent_id, idempotency_key, status)
                VALUES ($1, $2, $3, 'processing')
                ON CONFLICT (idempotency_key) DO NOTHING
                RETURNING id
                """,
                uuid.UUID(execution_id),
                uuid.UUID(intent.id),
                idempotency_key,
            )
            if row is None:
                return None
            return execution_id

    async def _mark_intent_status(self, intent_id: str, status: ProspectiveStatus) -> None:
        if self.pool is None:
            return
        try:
            async with self.pool.acquire() as conn:
                await conn.execute(
                    "UPDATE scheduled_intents SET status = $2 WHERE id = $1::uuid",
                    uuid.UUID(intent_id),
                    status.value,
                )
        except Exception as exc:  # noqa: BLE001 - best-effort status write
            logger.debug("mark intent %s %s failed: %s", intent_id, status.value, exc)

    async def _enqueue_intent(self, intent: ScheduledIntent) -> bool:
        """Enqueue intent into the appropriate Redis queue, exactly-once.

        Returns True when the intent was dispatched; False when it was skipped
        (already executed, or rate-limited) — the caller re-queues as needed.
        """
        if intent.idempotency_key in self._processed_idempotency_keys:
            return False
        execution_id = await self._begin_execution(intent)
        if execution_id is None:
            # Already executed once — never deliver a second time.
            intent.status = ProspectiveStatus.COMPLETED
            await self._mark_intent_status(intent.id, ProspectiveStatus.COMPLETED)
            return False

        queue_name = (
            "URGENT_QUEUE"
            if intent.action in {"REMIND_USER", "URGENT"}
            else "BACKGROUND_MEMORY_QUEUE"
            if intent.action == "BACKGROUND_MEMORY"
            else "RETURN_CONTEXT_QUEUE"
        )
        if queue_name == "BACKGROUND_MEMORY_QUEUE" and await self._background_rate_limited(intent.user_id):
            # Backpressure: this user is over their observer budget — back off
            # this user (not the whole queue) and retry on the next cycle.
            intent.status = ProspectiveStatus.PENDING
            intent.next_attempt_at = datetime.now(UTC) + timedelta(
                seconds=next_attempt_delay(1, self.backoff_base_s, self.backoff_max_s)
            )
            await self._release_intents([intent.id], next_attempt_at=intent.next_attempt_at)
            self._metric("scheduler.rate_limited")
            return False

        enqueued = True
        if self.redis is not None:
            try:
                await self.redis.lpush(
                    f"queue:{queue_name}",
                    f"{intent.user_id}:{intent.prospective_memory_id}:{intent.id}:{execution_id}",
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("Redis enqueue failed: %s", exc)
                enqueued = False

        if enqueued:
            intent.status = ProspectiveStatus.DISPATCHED
            self._processed_idempotency_keys.add(intent.idempotency_key)
            await self._mark_intent_status(intent.id, ProspectiveStatus.DISPATCHED)
            self._metric("scheduler.dispatched")
            return True

        # Enqueue failure (Redis down / queue unavailable): retry with
        # exponential backoff; past `max_attempts` the intent is dead-lettered
        # instead of hot-looping forever.
        intent.attempt_count += 1
        intent.last_error = "redis enqueue failed"
        if intent.attempt_count >= self.max_attempts:
            await self._move_to_dlq(intent, reason=intent.last_error)
            return False
        intent.status = ProspectiveStatus.PENDING
        intent.next_attempt_at = datetime.now(UTC) + timedelta(
            seconds=next_attempt_delay(intent.attempt_count, self.backoff_base_s, self.backoff_max_s)
        )
        await self._release_intents([intent.id], next_attempt_at=intent.next_attempt_at)
        self._metric("scheduler.enqueue_failures")
        logger.warning(
            "intent %s enqueue attempt %d/%d failed; backing off %.0fs",
            intent.id,
            intent.attempt_count,
            self.max_attempts,
            next_attempt_delay(intent.attempt_count, self.backoff_base_s, self.backoff_max_s, jitter=0.0),
        )
        return False

    async def _move_to_dlq(self, intent: ScheduledIntent, reason: str) -> None:
        """Dead-letter an intent after exhausting its enqueue attempts."""
        self._metric("scheduler.dlq_moved")
        logger.error("intent %s moved to DLQ: %s", intent.id, reason)
        if self.pool is None:
            intent.status = ProspectiveStatus.FAILED
            return
        try:
            async with self.pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO intent_dlq
                        (id, intent_id, user_id, subject, action, reason, attempts, payload)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    """,
                    uuid.uuid4(),
                    uuid.UUID(intent.id),
                    intent.user_id,
                    str(intent.payload.get("subject") or ""),
                    intent.action,
                    reason,
                    intent.attempt_count,
                    intent.payload,
                )
                await conn.execute(
                    "DELETE FROM scheduled_intents WHERE id = $1::uuid", uuid.UUID(intent.id)
                )
        except Exception as exc:  # noqa: BLE001 - best-effort DLQ write
            logger.warning("intent DLQ move failed for %s: %s", intent.id, exc)
            intent.status = ProspectiveStatus.FAILED
            await self._mark_intent_status(intent.id, ProspectiveStatus.FAILED)

    async def _background_rate_limited(self, user_id: str, window_s: int = 60) -> bool:
        """Per-user token budget on the background observer queue.

        One very active user cannot consume all observer workers: each user gets
        at most ``background_max_per_user_per_minute`` dispatches per minute.
        """
        if self.redis is None:
            return False
        key = f"ratelimit:{user_id}:background_mem:v1"
        try:
            pipe = self.redis.pipeline(transaction=True)
            pipe.incr(key)
            pipe.expire(key, window_s)
            count, _ = await pipe.execute()
            return int(count) > self.background_max_per_user_per_minute
        except Exception as exc:  # noqa: BLE001 - fail open when Redis is down
            logger.debug("background rate limit check failed: %s", exc)
            return False

    async def dispatch_due(self) -> int:
        """One dispatch pass: claim → fairness cap → exactly-once enqueue.

        Returns the number of intents dispatched this pass.
        """
        claimed = await self._claim_due_intents()
        if not claimed:
            return 0
        intents = [
            ScheduledIntent(
                id=str(r["id"]),
                prospective_memory_id=str(r["prospective_memory_id"]),
                user_id=r["user_id"],
                trigger_at=r["trigger_at"],
                trigger_at_utc=r["trigger_at_utc"],
                timezone=r["timezone"],
                schedule_type=ScheduleType(r["schedule_type"]),
                trigger_policy=r["trigger_policy"],
                action=r["action"],
                payload=r["payload"] or {},
                idempotency_key=r["idempotency_key"] or "",
                status=ProspectiveStatus(r["status"]),
                attempt_count=int(r.get("attempt_count") or 0),
                last_error=r.get("last_error"),
            )
            for r in claimed
        ]
        # Fair scheduling: never let one hot user consume the whole batch.
        by_user: dict[str, list[ScheduledIntent]] = {}
        for intent in intents:
            by_user.setdefault(intent.user_id, []).append(intent)
        selected: list[ScheduledIntent] = []
        overflow: list[str] = []
        for user_rows in by_user.values():
            selected.extend(user_rows[: self.max_per_user_per_cycle])
            overflow.extend(i.id for i in user_rows[self.max_per_user_per_cycle :])
        if overflow:
            await self._release_intents(overflow)
            self._metric("scheduler.overflow_released", len(overflow))

        dispatched = 0
        for intent in selected:
            if await self._enqueue_intent(intent):
                dispatched += 1
        self.last_cycle_dispatched = dispatched
        self._metric("scheduler.cycles")
        return dispatched

    async def reconcile(self) -> None:
        """Reconciliation worker: reclaim crashed claims, then dispatch due work.

        Runs continuously (``run_scheduler``) so Postgres stays the source of
        truth: any intent that is due but not yet dispatched is picked up here,
        even one that a previous worker claimed and crashed on.
        """
        if self.pool is None:
            return
        try:
            async with self.pool.acquire() as conn:
                await conn.execute(
                    """
                    UPDATE scheduled_intents
                    SET status = 'pending', claimed_at = NULL
                    WHERE status = 'processing'
                      AND claimed_at < now() - $1::int * INTERVAL '1 second'
                    """,
                    self.claim_seconds,
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning("scheduler claim reclaim failed: %s", exc)
            self._metric("scheduler.reconcile_failures")
        await self.dispatch_due()

    async def run_scheduler(self) -> None:
        """Background loop (cancelled on shutdown). One per scheduler worker."""
        self.running = True
        logger.info(
            "scheduler started (interval=%.1fs, batch=%d, per-user-cap=%d, "
            "missed=%s)",
            self.poll_interval_s,
            self.claim_batch,
            self.max_per_user_per_cycle,
            self.missed_policy,
        )
        try:
            while self.running:
                cycle_start = datetime.now(UTC)
                try:
                    await self.reconcile()
                except Exception as exc:  # noqa: BLE001 - keep the loop alive
                    logger.warning("scheduler cycle failed: %s", exc)
                    self._metric("scheduler.cycle_failures")
                cycle_ms = (datetime.now(UTC) - cycle_start).total_seconds() * 1000
                if self.metrics is not None:
                    self.metrics.record_timing("scheduler.cycle", cycle_ms)
                await asyncio.sleep(self.poll_interval_s)
        except asyncio.CancelledError:
            pass
        finally:
            self.running = False
            logger.info("scheduler stopped")

    async def recover_on_startup(self) -> None:
        """Server restart recovery driven by the configured missed-intent policy.

        Replaces the old fixed 24h expiry: each missed intent is handled by
        ``scheduler_missed_policy`` — dispatch_late (dispatch within the grace
        window, expire ancient), expire, reschedule, or alert (DLQ/metrics).
        """
        for intent in list(self._intents.values()):
            if intent.status == ProspectiveStatus.PENDING and intent.trigger_at_utc <= datetime.now(UTC):
                await self._handle_missed_intent(intent)

        if self.pool is None:
            return

        try:
            async with self.pool.acquire() as conn:
                rows = await conn.fetch(
                    """
                    SELECT id, prospective_memory_id, user_id, trigger_at, trigger_at_utc,
                           timezone, schedule_type, trigger_policy, action, payload,
                           idempotency_key, status, attempt_count, last_error
                    FROM scheduled_intents
                    WHERE status = 'pending' AND trigger_at_utc <= $1
                    """,
                    datetime.now(UTC),
                )
                for r in rows:
                    intent = ScheduledIntent(
                        id=str(r["id"]),
                        prospective_memory_id=str(r["prospective_memory_id"]),
                        user_id=r["user_id"],
                        trigger_at=r["trigger_at"],
                        trigger_at_utc=r["trigger_at_utc"],
                        timezone=r["timezone"],
                        schedule_type=ScheduleType(r["schedule_type"]),
                        trigger_policy=r["trigger_policy"],
                        action=r["action"],
                        payload=r["payload"] or {},
                        idempotency_key=r["idempotency_key"] or "",
                        status=ProspectiveStatus(r["status"]),
                        attempt_count=int(r.get("attempt_count") or 0),
                        last_error=r.get("last_error"),
                    )
                    await self._handle_missed_intent(intent)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Startup scheduler recovery failed: %s", exc)

    async def _handle_missed_intent(self, intent: ScheduledIntent) -> None:
        """Apply the configured missed-intent policy to one overdue intent."""
        policy = self.missed_policy
        missed_for_hours = max(
            0.0, (datetime.now(UTC) - intent.trigger_at_utc).total_seconds() / 3600
        )

        if policy == MISSED_POLICY_EXPIRE:
            intent.status = ProspectiveStatus.EXPIRED
            await self._mark_intent_status(intent.id, ProspectiveStatus.EXPIRED)
            self._metric("scheduler.expired")
            logger.info("Missed intent %s expired (policy=expire)", intent.id)
            return

        if policy == MISSED_POLICY_RESCHEDULE:
            intent.status = ProspectiveStatus.PENDING
            intent.next_attempt_at = datetime.now(UTC) + timedelta(
                seconds=next_attempt_delay(1, self.backoff_base_s, self.backoff_max_s)
            )
            if self.pool is not None:
                try:
                    async with self.pool.acquire() as conn:
                        await conn.execute(
                            "UPDATE scheduled_intents SET status = 'pending', next_attempt_at = $2 "
                            "WHERE id = $1::uuid",
                            uuid.UUID(intent.id),
                            intent.next_attempt_at,
                        )
                except Exception as exc:  # noqa: BLE001
                    logger.debug("reschedule intent %s failed: %s", intent.id, exc)
            self._metric("scheduler.rescheduled")
            logger.info("Missed intent %s rescheduled (policy=reschedule)", intent.id)
            return

        if policy == MISSED_POLICY_ALERT:
            await self._move_to_dlq(intent, reason=f"missed beyond policy (alert); {missed_for_hours:.1f}h")
            self._metric("scheduler.missed_alerted")
            return

        # dispatch_late (default): dispatch when within the grace window,
        # otherwise expire the ancient intent.
        if missed_for_hours > self.missed_dispatch_max_hours:
            intent.status = ProspectiveStatus.EXPIRED
            await self._mark_intent_status(intent.id, ProspectiveStatus.EXPIRED)
            self._metric("scheduler.expired")
            logger.info(
                "Missed intent %s expired (%.1fh > %dh grace)",
                intent.id,
                missed_for_hours,
                self.missed_dispatch_max_hours,
            )
            return
        await self._enqueue_intent(intent)

    async def add_prospective_memory(
        self,
        *,
        user_id: str,
        subject: str,
        content: str,
        event_at: datetime | str | None = None,
        timezone: str = "Asia/Kolkata",
        timezone_source: str = "default",
        timezone_confidence: float = 0.3,
        importance: float = 0.8,
        triggers: list[dict[str, Any]] | None = None,
    ) -> ProspectiveMemory:
        """Create a ProspectiveMemory and ScheduledIntents using IANA timezones and UTC conversion."""
        mem_id = str(uuid.uuid4())

        local_event_dt, _ = parse_local_to_utc(event_at, timezone) if event_at else (None, None)

        memory = ProspectiveMemory(
            id=mem_id,
            user_id=user_id,
            subject=subject,
            content=content,
            event_at=local_event_dt,
            timezone=timezone,
            timezone_source=timezone_source,
            timezone_confidence=max(0.0, min(1.0, timezone_confidence)),
            importance=importance,
        )
        self._memories[mem_id] = memory

        if self.pool is not None:
            try:
                async with self.pool.acquire() as conn:
                    await conn.execute(
                        """
                        INSERT INTO prospective_memories (
                            id, user_id, subject, content, event_at, timezone,
                            timezone_source, timezone_confidence, importance, status
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                        """,
                        uuid.UUID(mem_id),
                        user_id,
                        subject,
                        content,
                        local_event_dt,
                        timezone,
                        memory.timezone_source,
                        memory.timezone_confidence,
                        importance,
                        memory.status.value,
                    )
            except Exception as exc:  # noqa: BLE001
                logger.warning("Failed to persist prospective memory: %s", exc)

        if not triggers:
            triggers = [
                {"policy": "next_session", "action": "RETURN_CONTEXT", "delay_minutes": 0},
            ]

        now_utc = datetime.now(UTC)
        for trg in triggers:
            intent_id = str(uuid.uuid4())
            delay = trg.get("delay_minutes", 0)
            trigger_utc = now_utc + timedelta(minutes=delay)

            # Interpret local trigger time in specified IANA timezone
            local_trigger_dt, trigger_utc = parse_local_to_utc(trigger_utc, timezone)
            idempotency_key = f"{user_id}:{intent_id}:{int(trigger_utc.timestamp())}"

            intent = ScheduledIntent(
                id=intent_id,
                prospective_memory_id=mem_id,
                user_id=user_id,
                trigger_at=local_trigger_dt,
                trigger_at_utc=trigger_utc,
                timezone=timezone,
                schedule_type=ScheduleType(trg.get("schedule_type", ScheduleType.ONCE)),
                trigger_policy=trg.get("policy", "1_day_before"),
                action=trg.get("action", "RETURN_CONTEXT"),
                payload={"subject": subject, "content": content},
                idempotency_key=idempotency_key,
            )
            self._intents[intent_id] = intent

            if self.pool is not None:
                try:
                    async with self.pool.acquire() as conn:
                        await conn.execute(
                            """
                            INSERT INTO scheduled_intents (
                                id, prospective_memory_id, user_id, trigger_at, trigger_at_utc,
                                timezone, schedule_type, trigger_policy, action, payload, idempotency_key, status
                            )
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                            """,
                            uuid.UUID(intent_id),
                            uuid.UUID(mem_id),
                            user_id,
                            local_trigger_dt,
                            trigger_utc,
                            timezone,
                            intent.schedule_type.value,
                            intent.trigger_policy,
                            intent.action,
                            intent.payload,
                            idempotency_key,
                            intent.status.value,
                        )
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Failed to persist scheduled intent: %s", exc)

        return memory

    async def get_top_prospective_context(
        self,
        user_id: str,
        query: str | None = None,
        top_k: int = MAX_PROSPECTIVE_CONTEXT,
    ) -> list[dict[str, Any]]:
        """Relevance Gate & Policy Engine: returns top candidate items (max 2)."""
        candidates: list[ProspectiveMemory] = [
            m
            for m in self._memories.values()
            if m.user_id == user_id
            and m.status in {ProspectiveStatus.PENDING, ProspectiveStatus.SURFACED}
        ]

        if self.pool is not None:
            try:
                async with self.pool.acquire() as conn:
                    rows = await conn.fetch(
                        """
                        SELECT id, user_id, subject, content, event_at, timezone,
                               timezone_source, timezone_confidence, importance, status
                        FROM prospective_memories
                        WHERE user_id = $1 AND status IN ('pending', 'surfaced')
                        ORDER BY importance DESC, created_at DESC
                        LIMIT 10
                        """,
                        user_id,
                    )
                    db_candidates = [
                        ProspectiveMemory(
                            id=str(r["id"]),
                            user_id=r["user_id"],
                            subject=r["subject"],
                            content=r["content"],
                            event_at=r["event_at"],
                            timezone=r["timezone"],
                            timezone_source=r["timezone_source"],
                            timezone_confidence=float(r["timezone_confidence"] or 0.3),
                            importance=float(r["importance"]),
                            status=ProspectiveStatus(r["status"]),
                        )
                        for r in rows
                    ]
                    if db_candidates:
                        candidates = db_candidates
            except Exception as exc:  # noqa: BLE001
                logger.debug("Fetch db candidates failed: %s", exc)

        if not candidates:
            return []

        q_lower = (query or "").lower()
        scored: list[tuple[float, ProspectiveMemory]] = []
        for m in candidates:
            score = m.importance
            if q_lower and (m.subject.lower() in q_lower or m.content.lower() in q_lower):
                score += 0.5
            scored.append((score, m))

        scored.sort(key=lambda x: x[0], reverse=True)
        top_memories = [m for _, m in scored[:top_k]]

        for m in top_memories:
            m.status = ProspectiveStatus.SURFACED

        return [
            {
                "id": m.id,
                "subject": m.subject,
                "content": m.content,
                "importance": m.importance,
                "event_at": m.event_at.isoformat() if m.event_at else None,
                "timezone": m.timezone,
                "timezone_source": m.timezone_source,
                "timezone_confidence": m.timezone_confidence,
                "surface_policy": m.surface_policy,
            }
            for m in top_memories
        ]
