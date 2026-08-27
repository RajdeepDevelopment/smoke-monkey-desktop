"""Phase 8: object-storage equivalence (MinIO vs local filesystem).

The desktop document worker swaps MinIO for ``LocalFileStore``. These tests run
the same object-store scenario against both and assert identical observable
behavior. The MinIO variant needs the root ``docker-compose.yml`` stack; it
skips cleanly when MinIO is not reachable.
"""
from __future__ import annotations

import asyncio
import os

import pytest
from src.config import settings
from src.storage.local_storage import LocalFileStore
from src.storage.minio_storage import MinioStorage


def _probe_sync(host: str, port: int) -> bool:
    """TCP reachability probe. Sync on purpose: never touches an asyncio loop
    and finishes in ~2s instead of waiting on the minio client's internal
    retry/backoff budget."""
    import socket

    try:
        with socket.create_connection((host, port), timeout=2):
            return True
    except OSError:
        return False


@pytest.fixture(params=["minio", "local"], ids=["minio", "local"])
async def file_store(request, tmp_path, monkeypatch):
    if request.param == "minio":
        endpoint = os.environ.get("SMOKE_EQUIV_MINIO_HOST", "localhost")
        port = int(os.environ.get("SMOKE_EQUIV_MINIO_PORT", "9000"))
        if not _probe_sync(endpoint, port):
            pytest.skip("minio not reachable")
        monkeypatch.setattr(settings, "minio_endpoint", endpoint)
        monkeypatch.setattr(settings, "minio_port", port)
        monkeypatch.setattr(settings, "minio_access_key", "ragminio")
        monkeypatch.setattr(settings, "minio_secret_key", "ragminio_secret")
        monkeypatch.setattr(settings, "minio_secure", False)
        monkeypatch.setattr(settings, "minio_bucket", "equivalence-docs")
        fs = MinioStorage()
    else:
        fs = LocalFileStore(tmp_path / "files")
    await asyncio.wait_for(fs.ensure_bucket(), timeout=15)
    yield fs


async def test_document_upload_download_roundtrip(file_store, tmp_path):
    src = tmp_path / "src.pdf"
    src.write_bytes(b"%PDF-1.4 equivalence")
    await file_store.upload("docs/abc.pdf", src)
    dest = tmp_path / "out" / "abc.pdf"
    await file_store.download("docs/abc.pdf", dest)
    assert dest.read_bytes() == b"%PDF-1.4 equivalence"


async def test_document_missing_key_raises(file_store, tmp_path):
    with pytest.raises(Exception):  # noqa: B017 - S3Error vs FileNotFoundError
        await file_store.download("does-not-exist.pdf", tmp_path / "x.pdf")


async def test_document_delete_is_best_effort(file_store, tmp_path):
    await file_store.delete("never-created.pdf")  # must not raise
    src = tmp_path / "src.pdf"
    src.write_bytes(b"%PDF-1.4")
    await file_store.upload("docs/keep.pdf", src)
    await file_store.delete("docs/keep.pdf")
    with pytest.raises(Exception):  # noqa: B017 - S3Error vs FileNotFoundError
        await file_store.download("docs/keep.pdf", tmp_path / "gone.pdf")
