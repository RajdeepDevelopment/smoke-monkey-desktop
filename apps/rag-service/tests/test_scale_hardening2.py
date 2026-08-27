"""Tests for the second round of scale-hardening additions:

4.  Missed-intent policies (expire / reschedule / alert / dispatch_late).
10. Scheduler enqueue retry with backoff and dead-letter queue.
12. Neo4j traversal bounds (row cap + hard timeout).
13. Memory lifecycle promotion (candidate → confirmed → stable → stale → archived).
14. Selective embedding gate (only durable turns become vector-searchable).
17. Timezone source/confidence persistence for prospective memories.
18/19. In-process metrics registry, tracing spans, and the sampler loop.
"""
from __future__ import annotations

import asyncio
import unittest
from datetime import UTC, datetime, timedelta

from src.application.mem.graph import _consume_bounded
from src.application.mem.models import (
    MemoryStage,
    ProspectiveStatus,
    ScheduledIntent,
    ScheduleType,
)
from src.application.mem.monitoring import MemoryMetrics, MetricsSampler, _make_tracing
from src.application.mem.prospective import (
    MISSED_POLICY_ALERT,
    MISSED_POLICY_DISPATCH_LATE,
    MISSED_POLICY_EXPIRE,
    MISSED_POLICY_RESCHEDULE,
    ProspectiveMemoryStore,
)
from src.application.memory import MemoryStore


class _FakePool:
    def __init__(self, conn) -> None:
        self.conn = conn

    def acquire(self) -> _FakeAcquire:
        return _FakeAcquire(self.conn)


class _FakeAcquire:
    def __init__(self, conn) -> None:
        self.conn = conn

    async def __aenter__(self):
        return self.conn

    async def __aexit__(self, *exc_info) -> None:
        return None


class _FakeConn:
    """Records SQL; serves scripted fetchrow/fetch responses."""

    def __init__(self) -> None:
        self.executes: list[str] = []
        self.execute_args: list[tuple] = []
        self.fetchrow_rows: list[dict | None] = []
        self.fetch_rows: list[list[dict]] = []

    async def execute(self, sql: str, *args) -> str:
        self.executes.append(sql)
        self.execute_args.append(args)
        return "UPDATE 1"

    async def fetchrow(self, sql: str, *args) -> dict | None:
        self.executes.append(sql)
        return self.fetchrow_rows.pop(0) if self.fetchrow_rows else None

    async def fetch(self, sql: str, *args) -> list[dict]:
        self.executes.append(sql)
        return self.fetch_rows.pop(0) if self.fetch_rows else []


class _RaisingRedis:
    """Redis whose LPUSH always fails (simulates queue outage)."""

    async def lpush(self, key: str, value: str) -> None:
        raise ConnectionError("redis down")

    def pipeline(self, transaction: bool = True):
        raise ConnectionError("redis down")


def _overdue_intent(intent_id: str, user_id: str = "u1") -> ScheduledIntent:
    now = datetime.now(UTC)
    return ScheduledIntent(
        id=intent_id,
        prospective_memory_id="99999999-9999-9999-9999-999999999999",
        user_id=user_id,
        trigger_at=now - timedelta(hours=2),
        trigger_at_utc=now - timedelta(hours=2),
        timezone="Asia/Kolkata",
        schedule_type=ScheduleType.ONCE,
        trigger_policy="1_day_before",
        action="RETURN_CONTEXT",
        payload={"subject": "standup", "content": "morning standup"},
        idempotency_key=f"{user_id}:{intent_id}:1",
    )


class TestMissedIntentPolicies(unittest.TestCase):

    def test_expire_policy_marks_expired(self):
        async def run():
            conn = _FakeConn()
            store = ProspectiveMemoryStore(
                pool=_FakePool(conn),
                missed_policy=MISSED_POLICY_EXPIRE,
                metrics=MemoryMetrics(),
            )
            intent = _overdue_intent("11111111-1111-1111-1111-111111111111")
            await store._handle_missed_intent(intent)
            self.assertEqual(intent.status, ProspectiveStatus.EXPIRED)
            joined = "\n".join(conn.executes)
            self.assertIn("UPDATE scheduled_intents", joined)
            self.assertEqual(store.metrics.counters.get("scheduler.expired"), 1)

        asyncio.run(run())

    def test_reschedule_policy_keeps_pending_with_backoff(self):
        async def run():
            conn = _FakeConn()
            store = ProspectiveMemoryStore(
                pool=_FakePool(conn),
                missed_policy=MISSED_POLICY_RESCHEDULE,
                backoff_base_s=1.0,
                backoff_max_s=300.0,
            )
            intent = _overdue_intent("22222222-2222-2222-2222-222222222222")
            await store._handle_missed_intent(intent)
            self.assertEqual(intent.status, ProspectiveStatus.PENDING)
            self.assertIsNotNone(intent.next_attempt_at)
            self.assertGreater(intent.next_attempt_at, datetime.now(UTC))
            joined = "\n".join(conn.executes)
            self.assertIn("next_attempt_at", joined)

        asyncio.run(run())

    def test_alert_policy_moves_to_dlq(self):
        async def run():
            conn = _FakeConn()
            store = ProspectiveMemoryStore(
                pool=_FakePool(conn),
                missed_policy=MISSED_POLICY_ALERT,
                metrics=MemoryMetrics(),
            )
            intent = _overdue_intent("33333333-3333-3333-3333-333333333333")
            await store._handle_missed_intent(intent)
            joined = "\n".join(conn.executes)
            self.assertIn("intent_dlq", joined)
            self.assertEqual(store.metrics.counters.get("scheduler.missed_alerted"), 1)

        asyncio.run(run())

    def test_dispatch_late_expires_ancient_intents(self):
        async def run():
            conn = _FakeConn()
            store = ProspectiveMemoryStore(
                pool=_FakePool(conn),
                missed_policy=MISSED_POLICY_DISPATCH_LATE,
                missed_dispatch_max_hours=1,
            )
            intent = _overdue_intent("44444444-4444-4444-4444-444444444444")
            intent.trigger_at_utc = datetime.now(UTC) - timedelta(hours=50)
            await store._handle_missed_intent(intent)
            self.assertEqual(intent.status, ProspectiveStatus.EXPIRED)

        asyncio.run(run())


class TestSchedulerDlq(unittest.TestCase):

    def test_enqueue_failure_backs_off_then_dead_letters(self):
        async def run():
            conn = _FakeConn()
            store = ProspectiveMemoryStore(
                pool=_FakePool(conn),
                redis=_RaisingRedis(),
                max_attempts=2,
                backoff_base_s=1.0,
                backoff_max_s=60.0,
                metrics=MemoryMetrics(),
            )
            intent = _overdue_intent("55555555-5555-5555-5555-555555555555")
            # Each enqueue attempt claims a fresh execution row.
            conn.fetchrow_rows = [{"id": "e1"}, {"id": "e2"}]
            ok = await store._enqueue_intent(intent)
            self.assertFalse(ok)
            self.assertEqual(intent.attempt_count, 1)
            self.assertEqual(intent.status, ProspectiveStatus.PENDING)
            self.assertIn("next_attempt_at", "\n".join(conn.executes))

            ok = await store._enqueue_intent(intent)
            self.assertFalse(ok)
            self.assertEqual(intent.attempt_count, 2)
            joined = "\n".join(conn.executes)
            self.assertIn("intent_dlq", joined)
            self.assertEqual(store.metrics.counters.get("scheduler.dlq_moved"), 1)

        asyncio.run(run())

    def test_move_to_dlq_inserts_row(self):
        async def run():
            conn = _FakeConn()
            store = ProspectiveMemoryStore(pool=_FakePool(conn))
            intent = _overdue_intent("66666666-6666-6666-6666-666666666666")
            intent.attempt_count = 4
            await store._move_to_dlq(intent, reason="redis enqueue failed")
            joined = "\n".join(conn.executes)
            self.assertIn("INSERT INTO intent_dlq", joined)
            self.assertIn("DELETE FROM scheduled_intents", joined)

        asyncio.run(run())


class TestGraphBounds(unittest.TestCase):

    def test_consume_bounded_stops_at_row_cap(self):
        async def run():
            class _Result:
                def __init__(self, n: int) -> None:
                    self._records = iter([{"id": i} for i in range(n)])

                def __aiter__(self):
                    return self

                async def __anext__(self):
                    try:
                        return next(self._records)
                    except StopIteration as exc:
                        raise StopAsyncIteration from exc

            rows = await _consume_bounded(_Result(50), timeout_s=5.0, max_rows=3)
            self.assertEqual(len(rows), 3)

        asyncio.run(run())

    def test_consume_bounded_respects_hard_timeout(self):
        async def run():
            class _SlowResult:
                def __init__(self) -> None:
                    self._count = 0

                def __aiter__(self):
                    return self

                async def __anext__(self):
                    self._count += 1
                    await asyncio.sleep(5.0)
                    return {"id": self._count}

            rows = await _consume_bounded(_SlowResult(), timeout_s=0.05, max_rows=10)
            self.assertLessEqual(len(rows), 1)  # partial or empty, never hangs

        asyncio.run(run())


class TestMemoryLifecycle(unittest.TestCase):

    def test_promote_stage_progression(self):
        store = MemoryStore(pool=None, embedder=None)
        self.assertEqual(
            store._promote_stage(None, evidence_count=1, importance=0.5), "candidate"
        )
        self.assertEqual(
            store._promote_stage("candidate", evidence_count=5, importance=0.5), "confirmed"
        )
        self.assertEqual(
            store._promote_stage("confirmed", evidence_count=10, importance=0.9), "stable"
        )
        self.assertEqual(store._promote_stage("stale", evidence_count=1, importance=0.5), "confirmed")
        self.assertEqual(store._promote_stage("archived", evidence_count=99, importance=0.9), "archived")

    def test_promote_stage_disabled_short_circuits(self):
        from unittest import mock

        from src.config import settings

        store = MemoryStore(pool=None, embedder=None)
        with mock.patch.object(settings, "memory_lifecycle_enabled", False):
            # The gate returns the base stage untouched regardless of evidence:
            # promotion only happens when the lifecycle is enabled.
            self.assertEqual(
                store._promote_stage(None, evidence_count=99, importance=0.9),
                "candidate",
            )
            self.assertEqual(
                store._promote_stage("candidate", evidence_count=99, importance=0.9),
                "candidate",
            )

    def test_stage_enum_covers_full_pipeline(self):
        stages = [s.value for s in MemoryStage]
        self.assertEqual(stages, ["candidate", "confirmed", "stable", "stale", "archived"])


class TestUserTypedEpisodicEmbedding(unittest.TestCase):
    """Memory matches what the USER typed: the user's turn is embedded and
    vector-searchable; the assistant's reply is kept as plain text only (so
    recall never surfaces the model's own "I don't know" answers)."""

    def test_user_turn_embedded_assistant_reply_plain_text(self):
        async def run():
            conn = _FakeConn()
            pool = _FakePool(conn)

            class _FakeEmbedder:
                provider_id = "openrouter"

                async def embed(self, texts, **kwargs):
                    return [[0.1] * 8 for _ in texts]

            store = MemoryStore(pool=pool, embedder=_FakeEmbedder())
            await store._store_messages(
                "11111111-1111-1111-1111-111111111111",
                "22222222-2222-2222-2222-222222222222",
                "okay her name is chnadrima banerjee",
                "I'm sorry—I don't have your wife's name.",
                None,
            )

            inserts = [e for e in conn.executes if e.strip().startswith("INSERT INTO conversation_memory")]
            self.assertEqual(len(inserts), 2)
            # User turn first (embedded vector), assistant reply second (plain text).
            self.assertEqual(conn.execute_args[0][2], "user")
            self.assertEqual(conn.execute_args[1][2], "assistant")
            self.assertIsNotNone(conn.execute_args[0][5])
            self.assertIsNone(conn.execute_args[1][5])

        asyncio.run(run())


class TestTimezoneConfidence(unittest.TestCase):

    def test_source_and_confidence_persisted(self):
        async def run():
            store = ProspectiveMemoryStore(pool=None)
            memory = await store.add_prospective_memory(
                user_id="u1",
                subject="morning standup",
                content="daily standup at 10am",
                timezone="America/New_York",
                timezone_source="user_explicit",
                timezone_confidence=0.95,
            )
            self.assertEqual(memory.timezone_source, "user_explicit")
            self.assertEqual(memory.timezone_confidence, 0.95)
            self.assertEqual(memory.timezone, "America/New_York")

        asyncio.run(run())

    def test_confidence_is_clamped_to_unit_interval(self):
        async def run():
            store = ProspectiveMemoryStore(pool=None)
            memory = await store.add_prospective_memory(
                user_id="u1",
                subject="x",
                content="y",
                timezone_source="guess",
                timezone_confidence=2.5,
            )
            self.assertEqual(memory.timezone_confidence, 1.0)

        asyncio.run(run())

    def test_default_source_is_low_confidence(self):
        async def run():
            store = ProspectiveMemoryStore(pool=None)
            memory = await store.add_prospective_memory(user_id="u1", subject="x", content="y")
            self.assertEqual(memory.timezone_source, "default")
            self.assertEqual(memory.timezone_confidence, 0.3)

        asyncio.run(run())


class TestMonitoring(unittest.TestCase):

    def test_metrics_registry_increment_and_snapshot(self):
        metrics = MemoryMetrics()
        metrics.increment("scheduler.dispatched")
        metrics.increment("scheduler.dispatched")
        metrics.gauge("queue_lag.URGENT_QUEUE", 7)
        metrics.record_timing("span.scheduler.cycle", 12.5)
        snap = metrics.snapshot()
        self.assertEqual(snap["counters"]["scheduler.dispatched"], 2)
        self.assertEqual(snap["gauges"]["queue_lag.URGENT_QUEUE"], 7.0)
        self.assertEqual(snap["timings"]["span.scheduler.cycle"]["samples"], 1)
        self.assertEqual(snap["timings"]["span.scheduler.cycle"]["avg_ms"], 12.5)

    def test_tracing_span_records_timing(self):
        async def run():
            metrics = MemoryMetrics()
            tracing = _make_tracing(metrics)
            async with tracing.start_span("outbox.process_event", event_type="memory_stored"):
                await asyncio.sleep(0.01)
            self.assertEqual(len(metrics.timings["span.outbox.process_event"]), 1)

        asyncio.run(run())

    def test_sampler_records_queue_lag_and_row_counts(self):
        async def run():
            class _Conn:
                async def fetchrow(self, sql: str, *args):
                    return {"n": 42}

            class _Acquire:
                def __init__(self) -> None:
                    self.conn = _Conn()

                async def __aenter__(self):
                    return self.conn

                async def __aexit__(self, *exc_info) -> None:
                    return None

            class _Pool:
                def acquire(self) -> _Acquire:
                    return _Acquire()

            class _Redis:
                async def llen(self, key: str) -> int:
                    return 3

            metrics = MemoryMetrics()
            sampler = MetricsSampler(
                metrics,
                pool=_Pool(),
                redis=_Redis(),
                queue_names=("URGENT_QUEUE",),
            )
            await sampler.sample()
            self.assertEqual(metrics.gauges["queue_lag.URGENT_QUEUE"], 3.0)
            self.assertEqual(metrics.gauges["memory_rows.memories"], 42.0)
            self.assertEqual(metrics.gauges["memory_rows.intent_executions"], 42.0)

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
