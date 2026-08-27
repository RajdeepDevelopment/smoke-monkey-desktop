"""Local storage for the desktop edition: SQLite chunks + filesystem PDFs.

When ``storage_mode == "local"`` the document worker replaces its pgvector
``VectorStore`` and MinIO ``MinioStorage`` with these adapters so the desktop
needs no Postgres/MinIO. The chunks are written into the **same SQLite file**
rag-service's ``LocalVectorStore`` reads (``local_data_dir/memory.db``), with
WAL + busy_timeout so both processes can touch the store concurrently.
"""
from __future__ import annotations

import asyncio
import json
import logging
import shutil
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from src.config import settings

logger = logging.getLogger(__name__)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
    id          TEXT PRIMARY KEY,
    user_id     TEXT,
    filename    TEXT,
    status      TEXT NOT NULL DEFAULT 'processing',
    error       TEXT,
    chunk_count INTEGER,
    updated_at  TEXT
);
CREATE TABLE IF NOT EXISTS chunks (
    id              TEXT PRIMARY KEY,
    document_id     TEXT NOT NULL,
    parent_chunk_id TEXT,
    content         TEXT NOT NULL,
    section         TEXT,
    page_number     INTEGER,
    token_count     INTEGER NOT NULL DEFAULT 1,
    embedding       TEXT,
    metadata        TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_chunk_doc ON chunks (document_id);
CREATE INDEX IF NOT EXISTS idx_docs_user ON documents (user_id, status);
"""

_FTS_SCHEMA = (
    "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts "
    "USING fts5(chunk_id UNINDEXED, content)"
)


def _encode(vector: list[float] | None) -> str | None:
    return json.dumps(vector) if vector else None


def _token_count(text_value: str) -> int:
    return max(1, round(len(text_value or "") / 4))


def _now() -> str:
    return datetime.now(UTC).isoformat()


class LocalVectorStore:
    """SQLite-backed chunks writer mirroring rag-service's chunk tables."""

    def __init__(self, db_path: str = ":memory:") -> None:
        self.db_path = db_path
        self._conn: sqlite3.Connection | None = None
        self._lock = asyncio.Lock()
        self._fts = True

    @property
    def enabled(self) -> bool:
        return self._conn is not None

    async def init(self) -> None:
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
        try:
            await asyncio.to_thread(self._conn.execute, _FTS_SCHEMA)
        except sqlite3.OperationalError:  # FTS5 optional
            self._fts = False
            logger.warning("FTS5 unavailable; sparse search degraded in rag-service")

    async def close(self) -> None:
        conn, self._conn = self._conn, None
        if conn is not None:
            await asyncio.to_thread(conn.close)

    async def replace_document_chunks(
        self,
        document_id: uuid.UUID,
        groups: list[Any],
        child_embeddings: dict[str, list[float]],
    ) -> int:
        if self._conn is None:
            return 0
        child_count = 0
        fts_rows: list[tuple[str, str]] = []
        async with self._lock:
            old_rows = await self._fetch(
                "SELECT id FROM chunks WHERE document_id = ?", (str(document_id),)
            )
            await self._run(
                self._conn.execute,
                "DELETE FROM chunks WHERE document_id = ?",
                (str(document_id),),
            )
            if old_rows and self._fts:
                ids = [str(r["id"]) for r in old_rows]
                marks = ",".join("?" * len(ids))
                await self._run(
                    self._conn.execute,
                    f"DELETE FROM chunks_fts WHERE chunk_id IN ({marks})",
                    tuple(ids),
                )
            for group in groups:
                parent_id = str(uuid.uuid4())
                parent_content = str(getattr(group, "parent_content", "") or "")
                section = getattr(group, "section", None)
                await self._run(
                    self._conn.execute,
                    "INSERT INTO chunks "
                    "(id, document_id, parent_chunk_id, content, section, page_number, "
                    "token_count, embedding, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        parent_id,
                        str(document_id),
                        None,
                        parent_content,
                        section,
                        None,
                        _token_count(parent_content),
                        None,
                        '{"kind": "parent"}',
                    ),
                )
                if parent_content:
                    fts_rows.append((parent_id, parent_content))
                for child in getattr(group, "children", []):
                    content = str(getattr(child, "content", "") or "")
                    embedding = child_embeddings.get(content)
                    child_id = str(uuid.uuid4())
                    await self._run(
                        self._conn.execute,
                        "INSERT INTO chunks "
                        "(id, document_id, parent_chunk_id, content, section, page_number, "
                        "token_count, embedding, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (
                            child_id,
                            str(document_id),
                            parent_id,
                            content,
                            section,
                            getattr(child, "page_number", None),
                            _token_count(content),
                            _encode(embedding),
                            '{"kind": "child"}',
                        ),
                    )
                    if content:
                        fts_rows.append((child_id, content))
                    child_count += 1
            for chunk_id, content in fts_rows:
                if not self._fts:
                    break
                await self._run(
                    self._conn.execute,
                    "INSERT INTO chunks_fts (chunk_id, content) VALUES (?, ?)",
                    (chunk_id, content),
                )
        return child_count

    async def set_document_status(
        self,
        document_id: uuid.UUID,
        status: str,
        error: str | None = None,
        chunk_count: int | None = None,
        user_id: str | None = None,
    ) -> None:
        if self._conn is None:
            return
        now = _now()
        async with self._lock:
            await self._run(
                self._conn.execute,
                "INSERT OR IGNORE INTO documents (id, user_id, updated_at) VALUES (?, ?, ?)",
                (str(document_id), user_id, now),
            )
            if chunk_count is None:
                await self._run(
                    self._conn.execute,
                    "UPDATE documents SET status = ?, error = ?, updated_at = ? WHERE id = ?",
                    (status, error, now, str(document_id)),
                )
            else:
                await self._run(
                    self._conn.execute,
                    "UPDATE documents SET status = ?, error = ?, chunk_count = ?, "
                    "updated_at = ? WHERE id = ?",
                    (status, error, chunk_count, now, str(document_id)),
                )

    async def get_document(self, document_id, user_id) -> dict | None:
        """Read a document row back from the shared store (parity with the
        rag-service adapter over the same ``memory.db``)."""
        if self._conn is None:
            return None
        rows = await self._fetch(
            "SELECT * FROM documents WHERE id = ? AND user_id = ?",
            (str(document_id), str(user_id)),
        )
        return dict(rows[0]) if rows else None

    def _run(self, fn: Any, *args: Any) -> Any:
        return asyncio.to_thread(fn, *args)

    async def _fetch(self, query: str, params: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
        cursor = await asyncio.to_thread(self._conn.execute, query, params)
        return await asyncio.to_thread(cursor.fetchall)


def _safe_key(key: str) -> str:
    """Normalize an object key and reject path traversal / absolute paths."""
    key = (key or "").replace("\\", "/")
    parts = Path(key).parts
    if not key or key.startswith("/") or key.startswith("//") or ".." in parts:
        raise ValueError(f"unsafe object key: {key!r}")
    return key


class LocalFileStore:
    """Filesystem-backed replacement for ``MinioStorage`` (PDF objects)."""

    def __init__(self, root: str | Path = "./data/files") -> None:
        self.root = Path(root)

    def _resolve(self, key: str) -> Path:
        return self.root / _safe_key(key)

    async def ensure_bucket(self) -> None:
        await asyncio.to_thread(self.root.mkdir, parents=True, exist_ok=True)

    async def download(self, key: str, dest: Path) -> Path:
        src = self._resolve(key)
        if not src.is_file():
            raise FileNotFoundError(f"object not found: {key}")
        dest = Path(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(shutil.copyfile, src, dest)
        return dest

    async def upload(self, key: str, path: Path, content_type: str = "application/pdf") -> None:
        src = Path(path)
        if not src.is_file():
            raise FileNotFoundError(f"source file not found: {src}")
        dest = self._resolve(key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(shutil.copyfile, src, dest)

    async def delete(self, key: str) -> None:
        src = self._resolve(key)
        try:
            await asyncio.to_thread(src.unlink)
        except FileNotFoundError:
            pass  # deletion is best effort, like the MinIO adapter
        except OSError as exc:
            logger.warning("failed to remove %s: %s", key, exc)


@dataclass
class LocalStorage:
    vector: LocalVectorStore
    files: LocalFileStore


def build_local_storage() -> LocalStorage:
    root = Path(settings.local_data_dir).expanduser()
    root.mkdir(parents=True, exist_ok=True)
    return LocalStorage(
        vector=LocalVectorStore(str(root / "memory.db")),
        files=LocalFileStore(root / "files"),
    )
