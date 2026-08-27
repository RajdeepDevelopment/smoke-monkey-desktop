"""Resolve a user's provider key from Redis (mirrored by api-gateway).

The gateway persists user keys encrypted in Postgres and mirrors them in Redis
under `rag:user_key:{user_id}:{provider}` for fast lookups. The user's own key
always wins when present ("bring your own key"); otherwise the server default
for that provider is used. This module only reads — it never writes or logs keys.
"""
from __future__ import annotations

import logging
import uuid

from redis.asyncio import Redis

logger = logging.getLogger(__name__)


async def resolve_provider_key(
    redis: Redis,
    user_id: uuid.UUID | str | None,
    provider: str,
    *,
    server_default: str = "",
) -> str | None:
    """Return the user's key for `provider` if cached, else the server default."""
    if user_id is not None and provider:
        try:
            value = await redis.get(f"rag:user_key:{user_id}:{provider}")
            if value:
                return value
        except Exception as exc:  # noqa: BLE001 - never break ingestion on a cache miss
            logger.warning("user key cache lookup failed: %s", exc)
    return server_default or None


async def resolve_openrouter_key(
    redis: Redis,
    user_id: uuid.UUID | str | None,
    *,
    server_default: str = "",
) -> str | None:
    """Backwards-compatible alias for the openrouter provider."""
    return await resolve_provider_key(redis, user_id, "openrouter", server_default=server_default)
