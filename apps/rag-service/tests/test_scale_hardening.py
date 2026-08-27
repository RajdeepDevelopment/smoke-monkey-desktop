"""Tests for the scale-hardening additions:

1. Transactional outbox — emit → claim (SKIP LOCKED) → replay → DLQ, with
   backoff and crash-safe requeue.
2. Scheduler claiming — exactly-once intent dispatch, per-user fairness caps,
   per-user background queue rate limiting, and lease reclaim.
3. Context cost control — selective provider routing + token budgets +
   compression in ContextSnapshot.
"""
from __future__ import annotations

import asyncio
import unittest
from datetime import UTC, datetime

from src.application.mem.context import (
    ContextCompressor,
    ContextRouter,
    ContextSnapshot,
)
from src.application.mem.models import ProspectiveStatus, ScheduledIntent
from src.application.mem.outbox import (
    OutboxRelay,
    OutboxStore,
    next_attempt_delay,
)
from src.application.mem.prospective import ProspectiveMemoryStore


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
    """Configurable asyncpg-like connection: records SQL, serves scripted rows."""

    def __init__(self) -> None:
        self.executes: list[str] = []
        self.fetch_rows: list[list[dict]] = []
        self.fetchrow_rows: list[dict | None] = []

    async def execute(self, sql: str, *args) -> str:
        self.executes.append(sql)
        return "UPDATE 1"

    async def fetch(self, sql: str, *args) -> list[dict]:
        self.executes.append(sql)
        return self.fetch_rows.pop(0) if self.fetch_rows else []

    async def fetchrow(self, sql: str, *args) -> dict | None:
        self.executes.append(sql)
        return self.fetchrow_rows.pop(0) if self.fetchrow_rows else None


class _FakeRedis:
    def __init__(self) -> None:
        self.lists: dict[str, list[str]] = {}
        self.counters: dict[str, int] = {}
        self.pipeline_used = False

    async def lpush(self, key: str, value: str) -> None:
        self.lists.setdefault(key, []).append(value)

    def pipeline(self, transaction: bool = True) -> _FakePipeline:
        self.pipeline_used = True
        return _FakePipeline(self)


class _FakePipeline:
    def __init__(self, redis: _FakeRedis) -> None:
        self.redis = redis
        self._ops: list[tuple] = []

    def incr(self, key: str) -> _FakePipeline:
        self._ops.append(("incr", key))
        return self

    def expire(self, key: str, ttl: int) -> _FakePipeline:
        self._ops.append(("expire", key, ttl))
        return self

    async def execute(self) -> list:
        out = []
        for op in self._ops:
            if op[0] == "incr":
                self.redis.counters[op[1]] = self.redis.counters.get(op[1], 0) + 1
                out.append(self.redis.counters[op[1]])
            else:
                out.append(True)
        return out


def _intent(user_id: str, intent_id: str, *, action: str = "RETURN_CONTEXT") -> ScheduledIntent:
    now = datetime.now(UTC)
    return ScheduledIntent(
        id=intent_id,
        prospective_memory_id="99999999-9999-9999-9999-999999999999",
        user_id=user_id,
        trigger_at=now,
        trigger_at_utc=now,
        action=action,
        payload={},
        idempotency_key=f"{user_id}:{intent_id}:1",
    )


def _outbox_row(event_id: str = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa") -> dict:
    return {
        "id": event_id,
        "event_type": "memory_stored",
        "user_id": "u1",
        "aggregate_id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        "payload": {"type": "fact", "content": "User prefers Python", "importance": 0.9},
        "idempotency_key": "u1:memory_stored:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb:abc",
        "attempt_count": 0,
        "created_at": datetime.now(UTC),
    }


class TestOutbox(unittest.TestCase):

    def test_next_attempt_delay_backoff_capped(self):
        small = next_attempt_delay(1, base_s=1.0, max_s=300.0, jitter=0.0)
        bigger = next_attempt_delay(4, base_s=1.0, max_s=300.0, jitter=0.0)
        self.assertLess(small, bigger)
        self.assertLessEqual(bigger, 300.0)

    def test_outbox_emit_claim_replay_done(self):
        async def run():
            conn = _FakeConn()
            pool = _FakePool(conn)
            store = OutboxStore(pool)
            await store.emit(
                conn,
                event_type="memory_stored",
                user_id="u1",
                aggregate_id="mem-1",
                payload={"content": "x"},
                idempotency_key="u1:memory_stored:mem-1:x",
            )
            self.assertTrue(any("memory_outbox" in s for s in conn.executes))

            conn.fetch_rows = [[_outbox_row()]]
            events = await store.claim_batch(batch_size=10)
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0].event_type, "memory_stored")
            self.assertTrue(any("FOR UPDATE SKIP LOCKED" in s for s in conn.executes))

            await store.mark_done([events[0].id])
            self.assertTrue(any("status = 'done'" in s for s in conn.executes))

        asyncio.run(run())

    def test_outbox_failure_moves_to_dlq_after_max_attempts(self):
        async def run():
            conn = _FakeConn()
            store = OutboxStore(_FakePool(conn))
            conn.fetchrow_rows = [
                {
                    "attempt_count": 5,
                    "event_type": "memory_stored",
                    "user_id": "u1",
                    "aggregate_id": "mem-1",
                    "payload": {},
                    "idempotency_key": "k1",
                }
            ]
            moved = await store.mark_failed(
                ["cccccccc-cccc-cccc-cccc-cccccccccccc"], "boom", max_attempts=5
            )
            self.assertEqual(moved, ["cccccccc-cccc-cccc-cccc-cccccccccccc"])
            joined = "\n".join(conn.executes)
            self.assertIn("memory_outbox_dlq", joined)
            self.assertIn("DELETE FROM memory_outbox", joined)

        asyncio.run(run())

    def test_relay_requeues_stale_processing(self):
        async def run():
            conn = _FakeConn()
            store = OutboxStore(_FakePool(conn))
            relay = OutboxRelay(store, claim_seconds=10)
            await relay.run_once()
            self.assertTrue(any("requeue" not in s and "status = 'processing'" in s for s in conn.executes))

        asyncio.run(run())

    def test_relay_handler_success_and_failure_paths(self):
        async def run():
            conn = _FakeConn()
            store = OutboxStore(_FakePool(conn))
            handled: list[str] = []

            async def ok_handler(event):
                handled.append(event.id)
                if event.aggregate_id == "fail-mem":
                    raise RuntimeError("downstream down")

            relay = OutboxRelay(store, handler=ok_handler, max_attempts=3)
            conn.fetch_rows = [
                [
                    {**_outbox_row("11111111-1111-1111-1111-111111111111"),
                     "aggregate_id": "ok-mem"},
                    {**_outbox_row("22222222-2222-2222-2222-222222222222"),
                     "aggregate_id": "fail-mem"},
                ]
            ]
            await relay.run_once()
            self.assertEqual(len(handled), 2)
            self.assertEqual(relay.total_failed, 1)
            # failed event was put back on pending with a backoff window
            joined = "\n".join(conn.executes)
            self.assertIn("next_attempt_at = now()", joined)

        asyncio.run(run())


class TestSchedulerClaiming(unittest.TestCase):

    def test_begin_execution_is_exactly_once(self):
        async def run():
            conn = _FakeConn()
            store = ProspectiveMemoryStore(pool=_FakePool(conn))
            intent = _intent("u1", "11111111-1111-1111-1111-111111111111")
            conn.fetchrow_rows = [{"id": "exec-1"}, None]
            first = await store._begin_execution(intent)
            second = await store._begin_execution(intent)
            self.assertIsNotNone(first)
            self.assertIsNone(second)

        asyncio.run(run())

    def test_dispatch_due_applies_fairness_cap_per_user(self):
        async def run():
            conn = _FakeConn()
            redis = _FakeRedis()
            store = ProspectiveMemoryStore(
                pool=_FakePool(conn),
                redis=redis,
                max_per_user_per_cycle=2,
            )
            now = datetime.now(UTC)
            rows = []
            for i in range(3):
                rows.append({
                    "id": f"10000000-0000-0000-0000-{i:012d}",
                    "prospective_memory_id": "99999999-9999-9999-9999-999999999999",
                    "user_id": "u1",
                    "trigger_at": now,
                    "trigger_at_utc": now,
                    "timezone": "Asia/Kolkata",
                    "schedule_type": "once",
                    "trigger_policy": "1_day_before",
                    "action": "RETURN_CONTEXT",
                    "payload": {},
                    "idempotency_key": f"u1:10000000-0000-0000-0000-{i:012d}:1",
                    "status": "pending",
                })
            for i in range(3):
                rows.append({
                    "id": f"20000000-0000-0000-0000-{i:012d}",
                    "prospective_memory_id": "99999999-9999-9999-9999-999999999999",
                    "user_id": "u2",
                    "trigger_at": now,
                    "trigger_at_utc": now,
                    "timezone": "Asia/Kolkata",
                    "schedule_type": "once",
                    "trigger_policy": "1_day_before",
                    "action": "RETURN_CONTEXT",
                    "payload": {},
                    "idempotency_key": f"u2:20000000-0000-0000-0000-{i:012d}:1",
                    "status": "pending",
                })
            # One execution record per dispatched intent (win the insert).
            conn.fetchrow_rows = [{"id": f"e{i}"} for i in range(6)]
            conn.fetch_rows = [rows]
            dispatched = await store.dispatch_due()
            # 2 per user (cap), the 3rd of each user is released back to pending.
            self.assertEqual(dispatched, 4)
            released = "\n".join(conn.executes)
            self.assertIn("status = 'pending', claimed_at = NULL", released)
            # 4 pushed to the RETURN_CONTEXT queue (2 per user).
            self.assertEqual(len(redis.lists.get("queue:RETURN_CONTEXT_QUEUE", [])), 4)

        asyncio.run(run())

    def test_background_queue_respects_per_user_rate_limit(self):
        async def run():
            conn = _FakeConn()
            redis = _FakeRedis()
            redis.counters["ratelimit:u1:background_mem:v1"] = 100  # already over budget
            store = ProspectiveMemoryStore(
                pool=_FakePool(conn),
                redis=redis,
                background_max_per_user_per_minute=60,
            )
            intent = _intent("u1", "11111111-1111-1111-1111-111111111111", action="BACKGROUND_MEMORY")
            conn.fetchrow_rows = [{"id": "exec-1"}]
            ok = await store._enqueue_intent(intent)
            self.assertFalse(ok)
            # back to pending for the next cycle (fair scheduling)
            self.assertEqual(intent.status, ProspectiveStatus.PENDING)
            joined = "\n".join(conn.executes)
            self.assertIn("status = 'pending'", joined)

        asyncio.run(run())

    def test_reconcile_reclaims_stale_claims(self):
        async def run():
            conn = _FakeConn()
            store = ProspectiveMemoryStore(pool=_FakePool(conn), claim_seconds=120)
            await store.reconcile()
            self.assertTrue(any("status = 'processing'" in s for s in conn.executes))

        asyncio.run(run())


class TestContextCostControl(unittest.TestCase):

    def test_router_is_selective(self):
        router = ContextRouter()

        general = router.route("What is React and how does it work?")
        self.assertFalse(general.providers["pgvector"])
        self.assertFalse(general.providers["neo4j"])
        self.assertFalse(general.providers["prospective"])
        self.assertFalse(general.providers["redis"])

        memory_q = router.route("What did I say about my React test tomorrow?")
        self.assertTrue(memory_q.providers["pgvector"])
        self.assertTrue(memory_q.providers["prospective"])

        rel_q = router.route("Who is my manager? Does he know my team?")
        self.assertTrue(rel_q.providers["neo4j"])
        self.assertTrue(rel_q.providers["pgvector"])

        task_q = router.route("What tasks are pending for my project?")
        self.assertTrue(task_q.providers["tasks"])
        self.assertFalse(task_q.providers["neo4j"])

        # Subscript access stays backwards-compatible.
        self.assertTrue(memory_q["pgvector"])
        self.assertTrue(memory_q["prospective"])

    def test_router_attaches_budgets(self):
        route = ContextRouter().route("remember my earlier discussion")
        self.assertGreaterEqual(route.budget_ms, 1)
        self.assertGreater(route.max_context_tokens, 0)

    def test_snapshot_compression_dedupes_repeated_lines(self):
        snapshot = ContextSnapshot(
            current_message="hi",
            stable_facts=[
                "User prefers TypeScript",
                "User prefers TypeScript",
                "User prefers TypeScript",
            ],
        )
        sections = snapshot.to_prompt_sections(compress=True, token_budget=100000)
        facts_body = sections["facts"]
        self.assertEqual(facts_body.count("User prefers TypeScript"), 1)

    def test_snapshot_token_budget_drops_low_priority_sections(self):
        long_facts = ["The user prefers TypeScript over Python" for _ in range(200)]
        snapshot = ContextSnapshot(
            current_message="hi",
            stable_facts=long_facts,
            personality_profile={"style": "concise", "tone": "friendly", "verbosity": "short"},
        )
        sections = snapshot.to_prompt_sections(compress=False, token_budget=400)
        # Global budget enforced: injected context stays bounded.
        total = sum(max(1, round(len(body) / 4)) for body in sections.values())
        self.assertLessEqual(total, 400)
        # Personality (lowest precedence) is dropped before facts.
        self.assertNotIn("personality", sections)

    def test_compressor_dedupes_reordered_lines(self):
        lines = ContextCompressor.compress_lines(
            ["- User prefers Python", "- User prefers Python", "- different fact"]
        )
        self.assertEqual(len(lines), 2)

    def test_estimate_tokens(self):
        from src.application.mem.context import estimate_tokens

        self.assertGreaterEqual(estimate_tokens("a" * 100), 1)
        self.assertEqual(estimate_tokens(""), 0)


if __name__ == "__main__":
    unittest.main()
