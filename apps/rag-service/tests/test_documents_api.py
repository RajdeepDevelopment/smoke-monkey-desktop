"""Desktop document API — upload/list/get/delete against the local bundle.

The full FastAPI app runs in local mode (monkeypatched settings) so the
lifespan builds the SQLite bundle and the document endpoints behave exactly as
they will on the desktop. No cloud services are touched.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from src.config import settings


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "storage_mode", "local")
    monkeypatch.setattr(settings, "local_data_dir", str(tmp_path))
    monkeypatch.setattr(settings, "embed_provider", "ollama")
    monkeypatch.setattr(settings, "openrouter_rerank_enabled", False)
    monkeypatch.setattr(settings, "nvidia_rerank_enabled", False)
    monkeypatch.setattr(settings, "rerank_enabled", False)
    monkeypatch.setattr(settings, "monitor_enabled", False)
    monkeypatch.setattr(settings, "web_search_enabled", False)

    from src.main import app

    with TestClient(app) as c:
        yield c


def _pdf_bytes() -> bytes:
    return b"%PDF-1.4 fake document for upload tests"


def _simulate_worker(tmp_path, doc_id: str) -> None:
    """Mimic the document-worker against the shared SQLite files: claim the
    job, write the ready status into ``memory.db``, complete the job."""
    import sqlite3
    from datetime import UTC, datetime

    now = datetime.now(UTC).isoformat()
    conn = sqlite3.connect(str(tmp_path / "jobs.db"))
    conn.execute(
        "UPDATE ingest_jobs SET status = 'processing', attempts = attempts + 1, "
        "claimed_at = ?, updated_at = ? WHERE document_id = ? AND status = 'pending'",
        (now, now, doc_id),
    )
    job_id = conn.execute(
        "SELECT job_id FROM ingest_jobs WHERE document_id = ?", (doc_id,)
    ).fetchone()[0]
    conn.execute(
        "UPDATE ingest_jobs SET status = 'done', updated_at = ? WHERE job_id = ?",
        (now, job_id),
    )
    conn.commit()
    conn.close()

    mem = sqlite3.connect(str(tmp_path / "memory.db"))
    mem.execute(
        "UPDATE documents SET status = 'ready', chunk_count = 3, updated_at = ? "
        "WHERE id = ?",
        (now, doc_id),
    )
    mem.commit()
    mem.close()


def test_upload_queues_and_simulated_worker_flow(client, tmp_path):
    res = client.post(
        "/api/v1/documents/upload",
        files={"file": ("test.pdf", _pdf_bytes(), "application/pdf")},
        data={"user_id": "u1"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["filename"] == "test.pdf"
    assert body["status"] == "queued"
    assert body["userId"] == "u1"
    doc_id = body["id"]

    # The uploaded PDF landed on disk and the job was queued.
    assert (tmp_path / "files" / "users" / "u1" / f"{doc_id}.pdf").is_file()

    _simulate_worker(tmp_path, doc_id)

    listed = client.get("/api/v1/documents", params={"user_id": "u1"}).json()
    assert [d["id"] for d in listed] == [doc_id]
    assert listed[0]["status"] == "ready"
    assert listed[0]["chunkCount"] == 3

    got = client.get(f"/api/v1/documents/{doc_id}", params={"user_id": "u1"})
    assert got.status_code == 200
    assert got.json()["status"] == "ready"


def test_upload_rejects_non_pdf(client):
    res = client.post(
        "/api/v1/documents/upload",
        files={"file": ("evil.txt", b"nope", "text/plain")},
        data={"user_id": "u1"},
    )
    assert res.status_code == 400


def test_get_unknown_document_404(client):
    assert client.get("/api/v1/documents/zzz", params={"user_id": "u1"}).status_code == 404


def test_delete_removes_row_chunks_and_file(client, tmp_path):
    res = client.post(
        "/api/v1/documents/upload",
        files={"file": ("del.pdf", _pdf_bytes(), "application/pdf")},
        data={"user_id": "u1"},
    )
    doc_id = res.json()["id"]
    assert (tmp_path / "files" / "users" / "u1" / f"{doc_id}.pdf").is_file()

    res = client.delete(f"/api/v1/documents/{doc_id}", params={"user_id": "u1"})
    assert res.status_code == 200
    assert client.get(f"/api/v1/documents/{doc_id}", params={"user_id": "u1"}).status_code == 404
    assert not (tmp_path / "files" / "users" / "u1" / f"{doc_id}.pdf").exists()


def test_cloud_mode_is_501(monkeypatch):
    """In cloud mode upload is the api-gateway's job — a bare router app is
    enough (the guard fires before any store is touched)."""
    from fastapi import FastAPI
    from src.api.documents import router as documents_router

    monkeypatch.setattr(settings, "storage_mode", "cloud")
    bare = FastAPI()
    bare.include_router(documents_router)
    with TestClient(bare) as c:
        res = c.post(
            "/api/v1/documents/upload",
            files={"file": ("x.pdf", _pdf_bytes(), "application/pdf")},
            data={"user_id": "u1"},
        )
    assert res.status_code == 501
