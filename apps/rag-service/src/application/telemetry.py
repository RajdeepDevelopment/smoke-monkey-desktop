"""Redis-backed request telemetry for the query engine.

Every chat/retrieve request appends a small JSON record to a bounded list
(`rag:telemetry:v1`). The metrics summary endpoint reads the tail of that
list and computes percentiles, cache-hit rate, error rate and per-stage
averages so the Analytics UI has a single cheap source of truth.
"""
from __future__ import annotations

import json
import logging
import math
import time

from redis.asyncio import Redis

logger = logging.getLogger(__name__)

LIST_KEY = "rag:telemetry:v1"
MAX_ENTRIES = 10_000
DEFAULT_WINDOW_S = 24 * 60 * 60

_STAGE_KEYS = (
    ("embedding_ms", "embeddingMs"),
    ("retrieval_ms", "retrievalMs"),
    ("reranker_ms", "rerankerMs"),
    ("llm_ttft_ms", "llmTtftMs"),
    ("llm_generation_ms", "llmGenerationMs"),
)


def _percentile(sorted_vals: list[float], p: float) -> float:
    if not sorted_vals:
        return 0.0
    k = (len(sorted_vals) - 1) * p / 100
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return sorted_vals[f]
    return sorted_vals[f] + (sorted_vals[c] - sorted_vals[f]) * (k - f)


def _avg(vals: list[float]) -> float:
    return round(sum(vals) / len(vals), 1) if vals else 0.0


class Telemetry:
    def __init__(self, redis: Redis) -> None:
        self._redis = redis

    async def record(self, entry: dict) -> None:
        """Append one request record, trimming the list to a bounded size."""
        try:
            payload = json.dumps({"ts": int(time.time() * 1000), **entry}, default=str)
            async with self._redis.pipeline(transaction=True) as pipe:
                pipe.lpush(LIST_KEY, payload)
                pipe.ltrim(LIST_KEY, 0, MAX_ENTRIES - 1)
                await pipe.execute()
        except Exception:
            logger.debug("telemetry record failed", exc_info=True)

    async def summary(self, window_s: int = DEFAULT_WINDOW_S) -> dict:
        """Aggregate the recent records into an analytics summary."""
        window_ms = window_s * 1000
        now_ms = int(time.time() * 1000)
        raw = await self._redis.lrange(LIST_KEY, 0, -1)

        entries: list[dict] = []
        for blob in raw:
            try:
                entry = json.loads(blob)
            except (TypeError, json.JSONDecodeError):
                continue
            if now_ms - int(entry.get("ts", 0)) > window_ms:
                continue
            entries.append(entry)

        errors = [e for e in entries if e.get("error")]
        cache_hits = [e for e in entries if e.get("cache_hit")]

        total_ms = sorted(float(e.get("total_ms", 0) or 0) for e in entries)
        by_type: dict[str, int] = {}
        by_mode: dict[str, int] = {}
        by_provider: dict[str, int] = {}
        stage_vals: dict[str, list[float]] = {name: [] for _, name in _STAGE_KEYS}

        for entry in entries:
            by_type[entry.get("type", "query")] = by_type.get(entry.get("type", "query"), 0) + 1
            by_mode[entry.get("mode", "balanced")] = by_mode.get(entry.get("mode", "balanced"), 0) + 1
            provider = entry.get("provider") or "unknown"
            by_provider[provider] = by_provider.get(provider, 0) + 1
            timings = entry.get("timings") or {}
            if timings:
                for src, dest in _STAGE_KEYS:
                    value = timings.get(src)
                    if value is not None:
                        stage_vals[dest].append(float(value))

        request_count = len(entries)
        error_messages = [str(e.get("error_message", "unknown"))[:200] for e in errors[:10]]

        return {
            "windowSeconds": window_s,
            "requests": request_count,
            "errors": len(errors),
            "errorRate": round(len(errors) / request_count, 4) if request_count else 0.0,
            "totalMsPercentiles": {
                "p50": round(_percentile(total_ms, 50), 1),
                "p90": round(_percentile(total_ms, 90), 1),
                "p95": round(_percentile(total_ms, 95), 1),
                "p99": round(_percentile(total_ms, 99), 1),
            },
            "averageMs": _avg(total_ms),
            "cacheHits": len(cache_hits),
            "cacheMisses": max(request_count - len(cache_hits), 0),
            "cacheHitRate": round(len(cache_hits) / request_count, 4) if request_count else 0.0,
            "byStage": {name: _avg(vals) for name, vals in stage_vals.items()},
            "byType": by_type,
            "byMode": by_mode,
            "byProvider": by_provider,
            "recentErrors": error_messages,
        }
