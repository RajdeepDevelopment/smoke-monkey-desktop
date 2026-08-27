"""Tests for Super Memory 2-Plane Architecture, Prospective Memory, IANA Timezones, and Parallel Context Engine."""
import asyncio
import unittest
from datetime import UTC, datetime

from src.application.mem.context import ContextRouter, ContextSnapshot
from src.application.mem.live_extractor import LiveSignalExtractor
from src.application.mem.models import ScheduleType
from src.application.mem.observation_store import MemoryConsolidator, ObservationStore
from src.application.mem.prospective import (
    ProspectiveMemoryStore,
    calculate_next_occurrence_utc,
    get_iana_timezone,
    parse_local_to_utc,
)


class TestSuperMemory(unittest.TestCase):

    def test_iana_timezone_parsing(self):
        tz_kolkata = get_iana_timezone("Asia/Kolkata")
        self.assertEqual(tz_kolkata.key, "Asia/Kolkata")

        tz_ny = get_iana_timezone("America/New_York")
        self.assertEqual(tz_ny.key, "America/New_York")

        tz_fallback = get_iana_timezone("Invalid/Timezone")
        self.assertEqual(tz_fallback.key, "UTC")

    def test_parse_local_to_utc_no_fixed_offsets(self):
        local_str = "2026-08-16T10:00:00"
        local_dt, utc_dt = parse_local_to_utc(local_str, "Asia/Kolkata")

        self.assertEqual(local_dt.tzinfo.key, "Asia/Kolkata")
        self.assertEqual(utc_dt.tzinfo, UTC)
        # IST is UTC+5:30 -> 10:00 AM IST = 04:30 AM UTC
        self.assertEqual(utc_dt.hour, 4)
        self.assertEqual(utc_dt.minute, 30)

    def test_calculate_next_occurrence_utc_dst_aware(self):
        now_utc = datetime(2026, 8, 16, 12, 0, tzinfo=UTC)
        next_utc = calculate_next_occurrence_utc(
            ScheduleType.DAILY,
            now_utc,
            iana_tz="America/New_York",
            target_hour=8,
            target_minute=0,
        )
        self.assertEqual(next_utc.tzinfo, UTC)
        self.assertGreater(next_utc, now_utc)

    def test_prospective_memory_context_cap_max_two(self):
        async def run():
            store = ProspectiveMemoryStore()
            await store.add_prospective_memory(
                user_id="u1",
                subject="React Test",
                content="I have a React test tomorrow",
                timezone="Asia/Kolkata",
            )
            await store.add_prospective_memory(
                user_id="u1",
                subject="Python Exam",
                content="Python exam next week",
                timezone="America/New_York",
            )
            await store.add_prospective_memory(
                user_id="u1",
                subject="Buy Keyboard",
                content="Buy mechanical keyboard",
                timezone="Europe/London",
            )

            context = await store.get_top_prospective_context("u1", query="test")
            self.assertLessEqual(len(context), 2)
            self.assertTrue(any(c["subject"] == "React Test" for c in context))

        asyncio.run(run())

    def test_l0_live_signal_extractor(self):
        extractor = LiveSignalExtractor()
        obs = extractor.extract("I switched to OpenSearch instead of Elasticsearch")
        self.assertGreater(len(obs), 0)
        self.assertEqual(obs[0].type, "explicit_fact_change")
        self.assertIn("OpenSearch", obs[0].value)

    def test_context_router(self):
        router = ContextRouter()
        r = router.route("What did I say about my React test tomorrow?")
        self.assertTrue(r["prospective"])
        self.assertTrue(r["pgvector"])

    def test_context_snapshot_precedence_fusion(self):
        snapshot = ContextSnapshot(
            current_message="I switched to OpenSearch",
            stable_facts=["User uses Elasticsearch"],
            graph_relationships=["User WORKS_WITH SearchTeam"],
            prospective_memories=[{"subject": "React Test", "content": "Test tomorrow"}],
        )
        sections = snapshot.to_prompt_sections()
        self.assertIn("prospective", sections)
        self.assertIn("facts", sections)
        self.assertIn("graph", sections)

    def test_observation_store_and_consolidation(self):
        async def run():
            store = ObservationStore()
            await store.record_observation(
                user_id="u1",
                observer_name="task_observer",
                content="User prefers Python over Java",
                subject="preference",
            )
            consolidator = MemoryConsolidator(store)
            count = await consolidator.consolidate("u1")
            self.assertEqual(count, 1)

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()

