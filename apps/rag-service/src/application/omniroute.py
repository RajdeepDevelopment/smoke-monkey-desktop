"""Per-user opt-in for the free OmniRoute gateway.

Mirrors the web-search setting pattern: the api-gateway stores a Redis flag
(``rag:user_setting:{user_id}:omniroute``) from Settings, and the pipeline
checks it here before using OmniRoute — either as the explicit chat mode or as
the automatic fallback when the primary provider fails. The server-level gate
(``OMNIROUTE_ENABLED`` env) is enforced by the caller/`settings`.
"""
from __future__ import annotations

import logging

from redis.asyncio import Redis

logger = logging.getLogger(__name__)


def omniroute_user_setting_key(user_id: str | None) -> str:
    return f"rag:user_setting:{user_id}:omniroute"


async def omniroute_enabled_for(redis: Redis, user_id: str | None) -> bool:
    """Whether this user may use OmniRoute (their Settings opt-in toggle).

    Returns ``False`` for anonymous users or when the lookup fails so the flag
    can never break a chat turn. The server-level ``OMNIROUTE_ENABLED`` gate is
    checked separately by the caller.
    """
    if redis is None or not user_id:
        return False
    try:
        value = await redis.get(omniroute_user_setting_key(user_id))
        return value == "1"
    except Exception:  # noqa: BLE001 - a setting lookup must never break a request
        logger.debug("omniroute user setting lookup failed", exc_info=True)
        return False
