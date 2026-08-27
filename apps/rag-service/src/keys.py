"""Per-user provider key resolution.

The api-gateway persists user keys encrypted in Postgres and mirrors them in
Redis under `rag:user_key:{user_id}:{provider}` (plaintext, short TTL) so hot
paths here can find the right key for a request without hitting the database.
This module is intentionally read-only — keys are never written or logged here.
"""
from __future__ import annotations

import logging

from redis.asyncio import Redis

logger = logging.getLogger(__name__)


def user_key_cache_key(user_id: str | None, provider: str) -> str:
    return f"rag:user_key:{user_id}:{provider}"


async def resolve_user_api_key(
    redis: Redis,
    user_id: str | None,
    provider: str,
    *,
    server_default: str = "",
) -> str | None:
    """Return the user's saved key for `provider`, else the server default.

    The user's own key always wins when present ("bring your own key"), for
    every provider (openrouter, nvidia, ...). Returns ``None`` only when
    neither exists (callers should degrade gracefully, e.g. fall back to a
    local model or surface a friendly error).
    """
    if provider and user_id:
        try:
            value = await redis.get(user_key_cache_key(user_id, provider))
            if value:
                return value
        except Exception as exc:  # noqa: BLE001 - key lookup must never break the request
            logger.warning("user key cache lookup failed: %s", exc)
    return server_default or None
