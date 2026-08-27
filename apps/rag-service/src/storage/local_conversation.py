"""Local conversation + message store for the desktop edition.

The api-gateway persists conversations and messages in Postgres (TypeORM
``conversations`` / ``messages``). The desktop has no gateway, so rag-service
owns the same contract in SQLite: the gateway-compatible ``/api/conversations``
surface reads and writes ``conversations.db`` so the in-app chat history
survives restarts.
"""
from __future__ import annotations

import asyncio
import json
import sqlite3
import uuid
from datetime import UTC, datetime
from typing import Any

_SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    title      TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    citations       TEXT,
    web_sources     TEXT,
    confidence      REAL,
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id, created_at);
"""

_ROLES = {"user", "assistant", "system"}


class LocalConversationStore:
    """SQLite-backed conversations and messages, scoped to a single user."""

    def __init__(self, db_path: str = ":memory:") -> None:
        self.db_path = db_path
        self._conn: sqlite3.Connection | None = None
        self._lock = asyncio.Lock()

    @property
    def enabled(self) -> bool:
        return self._conn is not None

    async def connect(self) -> None:
        if self._conn is not None:
            return
        self._conn = await asyncio.to_thread(
            sqlite3.connect,
            self.db_path,
            isolation_level=None,
            check_same_thread=False,
        )
        self._conn.row_factory = sqlite3.Row
        await asyncio.to_thread(self._conn.execute, "PRAGMA journal_mode=WAL")
        await asyncio.to_thread(self._conn.execute, "PRAGMA busy_timeout=5000")
        await asyncio.to_thread(self._conn.executescript, _SCHEMA)

    async def close(self) -> None:
        conn, self._conn = self._conn, None
        if conn is not None:
            await asyncio.to_thread(conn.close)

    async def _fetch(self, query: str, params: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
        cursor = await asyncio.to_thread(self._conn.execute, query, params)
        return await asyncio.to_thread(cursor.fetchall)

    @staticmethod
    def _conversation_dto(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "userId": row["user_id"],
            "title": row["title"],
            "createdAt": row["created_at"],
        }

    @staticmethod
    def _message_dto(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "conversationId": row["conversation_id"],
            "role": row["role"],
            "content": row["content"],
            "citations": json.loads(row["citations"]) if row["citations"] else None,
            "webSources": json.loads(row["web_sources"]) if row["web_sources"] else None,
            "confidence": row["confidence"],
            "createdAt": row["created_at"],
        }

    async def list(self, user_id: str) -> list[dict[str, Any]]:
        rows = await self._fetch(
            "SELECT * FROM conversations WHERE user_id = ? ORDER BY created_at DESC",
            (user_id,),
        )
        return [self._conversation_dto(r) for r in rows]

    async def create(self, user_id: str, title: str | None = None) -> dict[str, Any]:
        conversation_id = str(uuid.uuid4())
        now = datetime.now(UTC).isoformat()
        async with self._lock:
            await asyncio.to_thread(
                self._conn.execute,
                "INSERT INTO conversations (id, user_id, title, created_at) VALUES (?, ?, ?, ?)",
                (conversation_id, user_id, title or "New conversation", now),
            )
        return {
            "id": conversation_id,
            "userId": user_id,
            "title": title or "New conversation",
            "createdAt": now,
        }

    async def _owned(self, user_id: str, conversation_id: str) -> bool:
        rows = await self._fetch(
            "SELECT 1 FROM conversations WHERE id = ? AND user_id = ?",
            (conversation_id, user_id),
        )
        return bool(rows)

    async def get_messages(
        self,
        user_id: str,
        conversation_id: str,
    ) -> list[dict[str, Any]] | None:
        """Return messages oldest-first; ``None`` when missing or not owned."""
        if not await self._owned(user_id, conversation_id):
            return None
        rows = await self._fetch(
            "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC",
            (conversation_id,),
        )
        return [self._message_dto(r) for r in rows]

    async def delete(self, user_id: str, conversation_id: str) -> bool:
        if not await self._owned(user_id, conversation_id):
            return False
        async with self._lock:
            await asyncio.to_thread(
                self._conn.execute,
                "DELETE FROM messages WHERE conversation_id = ?",
                (conversation_id,),
            )
            cursor = await asyncio.to_thread(
                self._conn.execute,
                "DELETE FROM conversations WHERE id = ? AND user_id = ?",
                (conversation_id, user_id),
            )
            return bool(cursor.rowcount)

    async def add_message(
        self,
        user_id: str,
        conversation_id: str,
        role: str,
        content: str,
        *,
        citations: Any = None,
        web_sources: Any = None,
        confidence: float | None = None,
    ) -> dict[str, Any] | None:
        """Append a message to an owned conversation; ``None`` when missing."""
        if role not in _ROLES:
            raise ValueError(f"invalid role '{role}'")
        if not await self._owned(user_id, conversation_id):
            return None
        message_id = str(uuid.uuid4())
        now = datetime.now(UTC).isoformat()
        async with self._lock:
            await asyncio.to_thread(
                self._conn.execute,
                "INSERT INTO messages "
                "(id, conversation_id, role, content, citations, web_sources, confidence, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    message_id,
                    conversation_id,
                    role,
                    content,
                    json.dumps(citations) if citations is not None else None,
                    json.dumps(web_sources) if web_sources is not None else None,
                    confidence,
                    now,
                ),
            )
        return {
            "id": message_id,
            "conversationId": conversation_id,
            "role": role,
            "content": content,
            "citations": citations,
            "webSources": web_sources,
            "confidence": confidence,
            "createdAt": now,
        }

    async def count(self) -> int:
        cursor = await asyncio.to_thread(self._conn.execute, "SELECT COUNT(*) FROM conversations")
        row = await asyncio.to_thread(cursor.fetchone)
        return int(row[0])
