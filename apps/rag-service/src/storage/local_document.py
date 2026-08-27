"""Local DocumentStore adapter — filesystem-backed object storage.

Desktop edition of the MinIO (S3-compatible) object storage used by the
document worker: original uploaded files (PDFs, …) live under a local
directory instead of an object store. Mirrors ``MinioStorage``'s contract:
``ensure_bucket`` / ``download`` / ``upload`` / ``delete``, all async and
tenant-agnostic (objects are keyed by the caller).
"""
from __future__ import annotations

import asyncio
import logging
import shutil
from pathlib import Path

from src.storage.interfaces import DocumentStore

logger = logging.getLogger(__name__)


def _safe_key(key: str) -> str:
    """Normalize an object key and reject path traversal / absolute paths."""
    key = (key or "").replace("\\", "/")
    parts = Path(key).parts
    if not key or key.startswith("/") or key.startswith("//") or ".." in parts:
        raise ValueError(f"unsafe object key: {key!r}")
    return key


class LocalDocumentStore(DocumentStore):
    """Filesystem-backed ``DocumentStore``. Objects stored under ``root``."""

    def __init__(self, root: str | Path = "./data/documents") -> None:
        self.root = Path(root)

    @property
    def enabled(self) -> bool:
        return True

    async def ensure_bucket(self) -> None:
        await asyncio.to_thread(self.root.mkdir, parents=True, exist_ok=True)

    def _resolve(self, key: str) -> Path:
        return self.root / _safe_key(key)

    async def upload(self, key: str, path: Path, content_type: str = "application/pdf") -> None:
        src = Path(path)
        if not src.is_file():
            raise FileNotFoundError(f"source file not found: {src}")
        dest = self._resolve(key)
        dest.parent.mkdir(parents=True, exist_ok=True)

        def _copy() -> None:
            shutil.copyfile(src, dest)

        await asyncio.to_thread(_copy)

    async def download(self, key: str, dest: Path) -> Path:
        src = self._resolve(key)
        if not src.is_file():
            raise FileNotFoundError(f"object not found: {key}")
        dest = Path(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)

        def _copy() -> None:
            shutil.copyfile(src, dest)

        await asyncio.to_thread(_copy)
        return dest

    async def delete(self, key: str) -> None:
        src = self._resolve(key)

        def _remove() -> None:
            try:
                src.unlink()
            except FileNotFoundError:
                pass  # deletion is best effort, like the MinIO adapter
            except OSError as exc:
                logger.warning("failed to remove %s: %s", key, exc)

        await asyncio.to_thread(_remove)
