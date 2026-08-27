"""LocalJobQueue (consumer) + local worker loop — desktop ingest transport."""
import asyncio
from pathlib import Path
from uuid import uuid4

import pytest
from src.config import settings
from src.domain import IngestJob
from src.storage.local_jobs import LocalJobQueue
from src.storage.local_storage import LocalFileStore, LocalVectorStore

D1 = "11111111-1111-1111-1111-111111111111"
D2 = "22222222-2222-2222-2222-222222222222"


@pytest.fixture
async def queue(tmp_path):
    q = LocalJobQueue(str(tmp_path / "jobs.db"))
    await q.connect()
    yield q
    await q.close()


def _payload(*, doc: str = D1) -> dict:
    return {
        "jobId": str(uuid4()),
        "documentId": doc,
        "userId": "11111111-1111-1111-1111-111111111111",
        "filename": "a.pdf",
        "s3Key": f"users/u1/{doc}.pdf",
    }


async def test_claim_returns_pending_jobs(queue):
    await queue.submit(_payload())
    jobs = await queue.next_batch(1)
    assert len(jobs) == 1
    assert isinstance(jobs[0], IngestJob)
    assert str(jobs[0].document_id) == D1
    assert await queue.status_of(D1) == "processing"
    assert await queue.next_batch(1) == []


async def test_claim_is_atomic_across_consumers(queue):
    await queue.submit(_payload())
    await queue.submit(_payload(doc=D2))
    first = await queue.next_batch(1)
    second = await queue.next_batch(1)
    assert {str(j.document_id) for j in first + second} == {D1, D2}
    assert await queue.next_batch(1) == []


async def test_complete_and_fail(queue):
    await queue.submit(_payload())
    job = (await queue.next_batch(1))[0]
    await queue.complete(job.job_id)
    assert await queue.status_of(D1) == "done"

    await queue.submit(_payload(doc=D2))
    job = (await queue.next_batch(1))[0]
    await queue.fail(job.job_id, error="boom")
    assert await queue.status_of(D2) == "failed"


async def test_recover_stale_requeues_crashed_jobs(queue, monkeypatch):
    await queue.submit(_payload())
    await queue.next_batch(1)  # claims it -> status processing, claimed_at now
    assert await queue.next_batch(1) == []
    assert await queue.recover_stale(claim_seconds=0) == 1
    assert await queue.status_of(D1) == "pending"
    assert await queue.next_batch(1) != []


async def test_process_job_local_end_to_end(tmp_path, monkeypatch):
    """The local worker core: claim → ingest → done, with real local stores."""
    monkeypatch.setattr(settings, "local_data_dir", str(tmp_path))
    import src.main as src_main

    class _Child:
        content = "quantum entanglement"

        def __init__(self) -> None:
            self.page_number = 1

    class _Group:
        parent_content = "Quantum physics"
        section = "intro"
        children = [_Child()]

    def _fake_embedder_factory(_key: str):
        class _FakeEmbedder:
            async def embed(self, texts):
                return [[0.1, 0.2, 0.3] for _ in texts]

            async def aclose(self) -> None:
                pass

        return _FakeEmbedder()

    async def _fake_parse(_path, _filename, **kw):
        from src.domain import ParsedDocument, ParsedPage

        return ParsedDocument(pages=[ParsedPage(1, "quantum entanglement")], toc=[], filename="a.pdf")

    monkeypatch.setattr(src_main, "parse_pdf", _fake_parse)
    monkeypatch.setattr(
        src_main, "build_chunk_hierarchy", lambda doc, **kw: [_Group()]
    )
    monkeypatch.setattr(src_main, "build_embedder", _fake_embedder_factory)

    queue = LocalJobQueue(str(tmp_path / "jobs.db"))
    await queue.connect()
    try:
        await queue.submit(_payload())
        # The uploaded PDF sits in the shared files store.
        files = LocalFileStore(tmp_path / "files")
        await files.ensure_bucket()
        src = Path(tmp_path) / "a.pdf"
        src.write_bytes(b"%PDF-1.4")
        await files.upload(f"users/u1/{D1}.pdf", src)

        store = LocalVectorStore(str(tmp_path / "memory.db"))
        await store.init()
        # rag-service pre-registered the document row (with user_id) at upload.
        await store._run(
            store._conn.execute,
            "INSERT INTO documents (id, user_id, filename, status, updated_at) "
            "VALUES (?, ?, ?, 'queued', ?)",
            (D1, "11111111-1111-1111-1111-111111111111", "a.pdf", "2026-01-01T00:00:00Z"),
        )

        job = (await queue.next_batch(1))[0]
        await src_main.process_job_local(queue, job, store, files)

        assert await queue.status_of(D1) == "done"
        row = await store.get_document(D1, "11111111-1111-1111-1111-111111111111")
        assert row["status"] == "ready"
        assert row["chunk_count"] == 1

        await store.close()
    finally:
        await queue.close()


async def test_process_job_local_failure_marks_failed(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "local_data_dir", str(tmp_path))
    import src.main as src_main

    async def _boom(_path, _filename, **kw):
        raise RuntimeError("parse failed")

    monkeypatch.setattr(src_main, "parse_pdf", _boom)
    monkeypatch.setattr(src_main, "build_embedder", lambda _key: _DummyEmbedder())

    queue = LocalJobQueue(str(tmp_path / "jobs.db"))
    await queue.connect()
    try:
        await queue.submit(_payload())
        files = LocalFileStore(tmp_path / "files")
        await files.ensure_bucket()
        src = Path(tmp_path) / "a.pdf"
        src.write_bytes(b"%PDF-1.4")
        await files.upload(f"users/u1/{D1}.pdf", src)

        store = LocalVectorStore(str(tmp_path / "memory.db"))
        await store.init()
        await store._run(
            store._conn.execute,
            "INSERT INTO documents (id, user_id, filename, status, updated_at) "
            "VALUES (?, ?, ?, 'queued', ?)",
            (D1, "11111111-1111-1111-1111-111111111111", "a.pdf", "2026-01-01T00:00:00Z"),
        )
        job = (await queue.next_batch(1))[0]
        await src_main.process_job_local(queue, job, store, files)

        assert await queue.status_of(D1) == "failed"
        row = await store.get_document(D1, "11111111-1111-1111-1111-111111111111")
        assert row["status"] == "failed"
        await store.close()
    finally:
        await queue.close()


class _DummyEmbedder:
    async def embed(self, texts):
        return [[0.1, 0.2, 0.3] for _ in texts]

    async def aclose(self) -> None:
        pass


async def test_concurrent_workers_do_not_double_claim(tmp_path):
    """Two queues on the same file (two worker processes) never share a job."""
    q1 = LocalJobQueue(str(tmp_path / "jobs.db"))
    q2 = LocalJobQueue(str(tmp_path / "jobs.db"))
    await q1.connect()
    await q2.connect()
    try:
        for _ in range(5):
            await q1.submit(_payload(doc=str(uuid4())))
        got1, got2 = await asyncio.gather(q1.next_batch(10), q2.next_batch(10))
        ids1 = {str(j.document_id) for j in got1}
        ids2 = {str(j.document_id) for j in got2}
        assert ids1.isdisjoint(ids2)
        assert len(ids1 | ids2) == 5
    finally:
        await q1.close()
        await q2.close()
