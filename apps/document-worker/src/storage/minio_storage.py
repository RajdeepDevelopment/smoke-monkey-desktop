"""MinIO (S3-compatible) object storage for original PDFs."""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from minio import Minio

from src.config import settings

logger = logging.getLogger(__name__)


class MinioStorage:
    def __init__(self) -> None:
        self.bucket = settings.minio_bucket
        self._client = Minio(
            f"{settings.minio_endpoint}:{settings.minio_port}",
            access_key=settings.minio_access_key,
            secret_key=settings.minio_secret_key,
            secure=settings.minio_secure,
        )

    async def ensure_bucket(self) -> None:
        await asyncio.to_thread(self._ensure_bucket_sync)

    def _ensure_bucket_sync(self) -> None:
        if not self._client.bucket_exists(self.bucket):
            self._client.make_bucket(self.bucket)

    async def download(self, key: str, dest: Path) -> Path:
        await asyncio.to_thread(self._client.fget_object, self.bucket, key, str(dest))
        return dest

    async def upload(self, key: str, path: Path, content_type: str = "application/pdf") -> None:
        await asyncio.to_thread(
            self._client.fput_object,
            self.bucket,
            key,
            str(path),
            content_type=content_type,
        )

    async def delete(self, key: str) -> None:
        await asyncio.to_thread(self._remove, key)

    def _remove(self, key: str) -> None:
        try:
            self._client.remove_object(self.bucket, key)
        except Exception as exc:  # noqa: BLE001 - deletion is best effort
            logger.warning("failed to remove %s from MinIO: %s", key, exc)
