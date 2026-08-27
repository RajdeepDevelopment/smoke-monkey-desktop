"""Lightweight observability for the memory/scheduler plane.

Covers review items 18 (scheduler metrics + distributed tracing) and 19
(queue lag / provider latency / memory growth monitoring) with zero external
dependencies:

- ``MemoryMetrics`` — an in-process counter/gauge/timing registry sampled by
  the ``MetricsSampler`` loop. Scheduler cycles, dispatches, expiries, DLQ
  moves, provider latencies, queue lag (Redis ``LLEN``) and memory growth
  (Postgres row counts) all land here.
- ``Tracing`` — pluggable spans. Without a tracer installed it records span
  durations into ``MemoryMetrics`` (cheap in-process tracing); when an
  OpenTelemetry-style ``tracer`` object is injected its
  ``start_as_current_span`` is used instead.
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class MemoryMetrics:
    """Counter/gauge/timing registry (dict-backed, async-safe enough for a
    single event loop; increments are atomic under asyncio)."""

    counters: dict[str, int] = field(default_factory=dict)
    gauges: dict[str, float] = field(default_factory=dict)
    timings: dict[str, list[float]] = field(default_factory=dict)
    max_timing_samples: int = 200

    def increment(self, name: str, delta: int = 1) -> None:
        self.counters[name] = self.counters.get(name, 0) + delta

    def gauge(self, name: str, value: float | int) -> None:
        self.gauges[name] = float(value)

    def record_timing(self, name: str, ms: float) -> None:
        bucket = self.timings.setdefault(name, [])
        bucket.append(ms)
        if len(bucket) > self.max_timing_samples:
            del bucket[: len(bucket) - self.max_timing_samples]

    def snapshot(self) -> dict[str, Any]:
        def _avg(values: list[float]) -> float:
            return round(sum(values) / len(values), 3) if values else 0.0

        return {
            "counters": dict(self.counters),
            "gauges": dict(self.gauges),
            "timings": {
                name: {
                    "avg_ms": _avg(values),
                    "max_ms": round(max(values), 3),
                    "samples": len(values),
                }
                for name, values in self.timings.items()
            },
        }


class Tracing:
    """Distributed-tracing hook: no-op in-process spans by default, real
    OpenTelemetry spans when a tracer is injected."""

    def __init__(self, tracer: Any | None = None, enabled: bool = True) -> None:
        self.tracer = tracer
        self.enabled = enabled

    def start_span(self, name: str, **attributes: Any) -> TraceSpan:
        return TraceSpan(self, name, attributes)


class TraceSpan:
    """Async context manager that times a span and records it into metrics
    (or delegates to an injected OpenTelemetry-style tracer)."""

    def __init__(self, tracing: Tracing, name: str, attributes: dict[str, Any]) -> None:
        self.tracing = tracing
        self.name = name
        self.attributes = attributes
        self._started: float = 0.0
        self._span: Any = None

    async def __aenter__(self) -> TraceSpan:
        if self.tracing.tracer is not None:
            try:
                self._span = self.tracing.tracer.start_as_current_span(self.name, attributes=self.attributes)
                await self._span.__aenter__()
            except Exception as exc:  # noqa: BLE001 - tracing must never break work
                logger.debug("tracer span start failed: %s", exc)
                self._span = None
        self._started = time.perf_counter()
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if self._started:
            ms = (time.perf_counter() - self._started) * 1000
            self.tracing._metrics.record_timing(f"span.{self.name}", ms)
            if exc is not None:
                self.tracing._metrics.increment(f"span.{self.name}.errors")
        if self._span is not None:
            try:
                await self._span.__aexit__(exc_type, exc, tb)
            except Exception as span_exc:  # noqa: BLE001
                logger.debug("tracer span end failed: %s", span_exc)


def _make_tracing(metrics: MemoryMetrics) -> Tracing:
    """Build a Tracing wired to record into ``metrics`` (used by the no-op
    path; real tracers are injected by main.py when monitor_tracing_enabled)."""
    tracing = Tracing(enabled=True)
    tracing._metrics = metrics
    return tracing


class MetricsSampler:
    """Periodically samples external surfaces into ``MemoryMetrics``:

    - queue lag: Redis ``LLEN queue:*`` for each queue this process writes.
    - memory growth: Postgres row counts for memories / conversation_memory /
      scheduled_intents / intent_executions.
    """

    def __init__(
        self,
        metrics: MemoryMetrics,
        pool: Any | None = None,
        redis: Any | None = None,
        *,
        poll_interval_s: float = 30.0,
        queue_names: tuple[str, ...] = (
            "URGENT_QUEUE",
            "RETURN_CONTEXT_QUEUE",
            "BACKGROUND_MEMORY_QUEUE",
        ),
    ) -> None:
        self.metrics = metrics
        self.pool = pool
        self.redis = redis
        self.poll_interval_s = max(1.0, poll_interval_s)
        self.queue_names = queue_names
        self.running = False
        self.last_sample_at = 0.0

    async def sample(self) -> None:
        self.last_sample_at = time.time()
        if self.redis is not None and hasattr(self.redis, "llen"):
            for name in self.queue_names:
                try:
                    lag = await self.redis.llen(f"queue:{name}")
                    self.metrics.gauge(f"queue_lag.{name}", int(lag))
                except Exception as exc:  # noqa: BLE001
                    logger.debug("queue lag sample failed for %s: %s", name, exc)
        if self.pool is not None:
            for table in (
                "memories",
                "conversation_memory",
                "scheduled_intents",
                "intent_executions",
            ):
                try:
                    async with self.pool.acquire() as conn:
                        row = await conn.fetchrow(
                            f"SELECT count(*)::int AS n FROM {table}"
                        )
                    self.metrics.gauge(f"memory_rows.{table}", int(row["n"] if row else 0))
                except Exception as exc:  # noqa: BLE001
                    logger.debug("memory growth sample failed for %s: %s", table, exc)
        self.metrics.gauge("sampler.last_ms_since_epoch", self.last_sample_at)

    async def run_loop(self) -> None:
        self.running = True
        try:
            while self.running:
                try:
                    await self.sample()
                except Exception as exc:  # noqa: BLE001 - keep sampling alive
                    logger.warning("metrics sample failed: %s", exc)
                await asyncio.sleep(self.poll_interval_s)
        except asyncio.CancelledError:
            pass
        finally:
            self.running = False
