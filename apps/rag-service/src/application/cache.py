"""Redis query-answer cache."""
from __future__ import annotations

import hashlib

from redis.asyncio import Redis


class QueryCache:
    PREFIX = "rag:query:v1"

    def __init__(self, client: Redis, enabled: bool = True, ttl: int = 300) -> None:
        self._client = client
        self.enabled = enabled
        self.ttl = ttl

    @staticmethod
    def key_for(user_id: str | None, message: str, model_key: str = "") -> str:
        digest = hashlib.sha256(f"{user_id or ''}|{model_key}|{message}".encode()).hexdigest()
        return f"{QueryCache.PREFIX}:{digest}"

    async def get(self, user_id: str | None, message: str, model_key: str = "") -> str | None:
        if not self.enabled:
            return None
        value = await self._client.get(self.key_for(user_id, message, model_key))
        if value is None:
            return None
        return value.decode() if isinstance(value, bytes) else value

    async def set(self, user_id: str | None, message: str, answer: str, model_key: str = "") -> None:
        if not self.enabled or not answer:
            return
        await self._client.set(self.key_for(user_id, message, model_key), answer, ex=self.ttl)

    async def invalidate_user(self, user_id: str) -> None:
        """Best-effort bulk invalidation (scan + delete keys for a user)."""
        async for key in self._client.scan_iter(match=f"{self.PREFIX}:*", count=200):
            value = await self._client.get(key)
            if value and user_id in value:
                await self._client.delete(key)
