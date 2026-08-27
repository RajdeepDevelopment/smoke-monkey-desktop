"""Local-mode feedback: POST /api/v1/feedback persists to SQLite (no Postgres)."""
import sqlite3

import pytest
from fastapi import FastAPI
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


def test_feedback_stores_row_locally(client, tmp_path):
    res = client.post(
        "/api/v1/feedback",
        json={"message_id": "msg-123", "helpful": True, "comment": "great answer"},
    )
    assert res.status_code == 200, res.text
    assert res.json() == {"status": "ok"}

    conn = sqlite3.connect(str(tmp_path / "feedback.db"))
    try:
        rows = conn.execute(
            "SELECT message_id, helpful, comment FROM feedback"
        ).fetchall()
    finally:
        conn.close()
    assert rows == [("msg-123", 1, "great answer")]


def test_feedback_without_comment(client):
    res = client.post("/api/v1/feedback", json={"message_id": "msg-456", "helpful": False})
    assert res.status_code == 200, res.text
    assert res.json() == {"status": "ok"}


def test_cloud_path_still_uses_pool(monkeypatch, tmp_path):
    """Cloud mode keeps the Postgres insert (verified with a fake pool)."""
    monkeypatch.setattr(settings, "storage_mode", "cloud")

    from src.api.routes import router

    class _FakeConn:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def execute(self, query, *args):
            inserted.append(query)
            return None

    inserted: list[str] = []
    conn = _FakeConn()

    class _AcquireCM:
        async def __aenter__(self):
            return conn

        async def __aexit__(self, *exc):
            return False

    class _FakePool:
        def acquire(self):
            return _AcquireCM()

    pool = _FakePool()

    bare = FastAPI()
    bare.include_router(router)
    bare.state.pool = pool
    bare.state.feedback = None
    bare.state.embedder = None
    bare.state.llm = None
    bare.state.redis = None

    with TestClient(bare) as c:
        res = c.post("/api/v1/feedback", json={"message_id": "m", "helpful": True})
    assert res.status_code == 200, res.text
    assert inserted and "INSERT INTO feedback" in inserted[0]
