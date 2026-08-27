"""LocalJobQueue (producer) — desktop ingest queue, rag-service side."""
import pytest
from src.storage.local_jobs import LocalJobQueue


@pytest.fixture
async def queue(tmp_path):
    q = LocalJobQueue(str(tmp_path / "jobs.db"))
    await q.connect()
    yield q
    await q.close()


async def test_submit_and_status(queue):
    await queue.submit(
        job_id="j1", document_id="d1", user_id="u1",
        filename="a.pdf", s3_key="users/u1/d1.pdf",
    )
    assert await queue.pending_count() == 1
    assert await queue.status_of("d1") == "pending"
    assert await queue.job_exists("j1") is True


async def test_submit_idempotent_on_job_id(queue):
    for _ in range(2):
        await queue.submit(
            job_id="j1", document_id="d1", user_id="u1",
            filename="a.pdf", s3_key="users/u1/d1.pdf",
        )
    assert await queue.pending_count() == 1


async def test_status_of_missing_document_is_none(queue):
    assert await queue.status_of("missing") is None


async def test_jobs_db_uses_shared_schema(tmp_path):
    """The producer writes the same columns the worker's consumer expects."""
    await LocalJobQueue(str(tmp_path / "jobs.db")).connect()
    import sqlite3

    conn = sqlite3.connect(str(tmp_path / "jobs.db"))
    cols = {r[1] for r in conn.execute("PRAGMA table_info(ingest_jobs)")}
    conn.close()
    assert {
        "job_id", "document_id", "user_id", "filename", "s3_key",
        "status", "attempts", "error", "created_at", "updated_at", "claimed_at",
    } <= cols
