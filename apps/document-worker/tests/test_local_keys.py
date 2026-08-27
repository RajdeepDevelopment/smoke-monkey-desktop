"""LocalKeyStore (document-worker side) + local-mode key resolution in _ingest."""
from pathlib import Path
from uuid import uuid4

import pytest
from src.config import settings
from src.storage.local_jobs import LocalJobQueue
from src.storage.local_keys import LocalKeyStore
from src.storage.local_storage import LocalFileStore, LocalVectorStore

D1 = "11111111-1111-1111-1111-111111111111"
USER = "11111111-1111-1111-1111-111111111111"


@pytest.fixture
async def keys(tmp_path):
    k = LocalKeyStore(str(tmp_path / "keys.db"))
    await k.connect()
    yield k
    await k.close()


async def test_set_get_delete_roundtrip(keys):
    assert await keys.get("openrouter", USER) is None
    await keys.set("openrouter", USER, "sk-or-v1-abcdefghijklmnop")
    assert await keys.get("openrouter", USER) == "sk-or-v1-abcdefghijklmnop"
    assert await keys.has("openrouter", USER) is True
    assert await keys.delete("openrouter", USER) is True
    assert await keys.get("openrouter", USER) is None


async def test_keys_are_scoped_to_user(keys):
    await keys.set("openrouter", USER, "sk-or-v1-aaaaaaaaaaaaaaaa")
    assert await keys.get("openrouter", "someone-else") is None


async def test_ingest_resolves_key_from_local_store(tmp_path, monkeypatch):
    """The desktop worker uses the user's saved cloud key for embeddings."""
    monkeypatch.setattr(settings, "local_data_dir", str(tmp_path))
    monkeypatch.setattr(settings, "embed_provider", "openrouter")
    monkeypatch.setattr(settings, "openrouter_api_key", "")  # no server default

    import src.main as src_main

    captured: dict[str, str] = {}

    def _fake_build_embedder(key: str):
        captured["key"] = key

        class _FakeEmbedder:
            async def embed(self, texts):
                return [[0.1, 0.2, 0.3] for _ in texts]

            async def aclose(self) -> None:
                pass

        return _FakeEmbedder()

    async def _fake_parse(_path, _filename, **kw):
        from src.domain import ParsedDocument, ParsedPage

        return ParsedDocument(pages=[ParsedPage(1, "x")], toc=[], filename="a.pdf")

    monkeypatch.setattr(src_main, "build_embedder", _fake_build_embedder)
    monkeypatch.setattr(src_main, "parse_pdf", _fake_parse)
    monkeypatch.setattr(src_main, "build_chunk_hierarchy", lambda doc, **kw: [])

    keys = LocalKeyStore(str(tmp_path / "keys.db"))
    await keys.connect()
    await keys.set("openrouter", USER, "sk-or-v1-userkey")

    queue = LocalJobQueue(str(tmp_path / "jobs.db"))
    await queue.connect()
    try:
        await queue.submit(
            {
                "jobId": str(uuid4()),
                "documentId": D1,
                "userId": USER,
                "filename": "a.pdf",
                "s3Key": f"users/u1/{D1}.pdf",
            }
        )
        files = LocalFileStore(tmp_path / "files")
        await files.ensure_bucket()
        src = Path(tmp_path) / "a.pdf"
        src.write_bytes(b"%PDF-1.4")
        await files.upload(f"users/u1/{D1}.pdf", src)

        store = LocalVectorStore(str(tmp_path / "memory.db"))
        await store.init()
        job = (await queue.next_batch(1))[0]
        await src_main.process_job_local(queue, job, store, files, keys=keys)

        assert captured["key"] == "sk-or-v1-userkey"
        assert await queue.status_of(D1) == "done"
        await store.close()
    finally:
        await queue.close()
        await keys.close()


async def test_ingest_without_key_uses_server_default(tmp_path, monkeypatch):
    """No saved key → the embedder gets the server default (or none)."""
    monkeypatch.setattr(settings, "local_data_dir", str(tmp_path))
    monkeypatch.setattr(settings, "embed_provider", "openrouter")
    monkeypatch.setattr(settings, "openrouter_api_key", "sk-or-v1-serverdefault")

    import src.main as src_main

    captured: dict[str, str] = {}

    def _fake_build_embedder(key: str):
        captured["key"] = key

        class _FakeEmbedder:
            async def embed(self, texts):
                return [[0.1, 0.2, 0.3] for _ in texts]

            async def aclose(self) -> None:
                pass

        return _FakeEmbedder()

    async def _fake_parse(_path, _filename, **kw):
        from src.domain import ParsedDocument, ParsedPage

        return ParsedDocument(pages=[ParsedPage(1, "x")], toc=[], filename="a.pdf")

    monkeypatch.setattr(src_main, "build_embedder", _fake_build_embedder)
    monkeypatch.setattr(src_main, "parse_pdf", _fake_parse)
    monkeypatch.setattr(src_main, "build_chunk_hierarchy", lambda doc, **kw: [])

    keys = LocalKeyStore(str(tmp_path / "keys.db"))
    await keys.connect()
    queue = LocalJobQueue(str(tmp_path / "jobs.db"))
    await queue.connect()
    try:
        await queue.submit(
            {
                "jobId": str(uuid4()),
                "documentId": D1,
                "userId": USER,
                "filename": "a.pdf",
                "s3Key": f"users/u1/{D1}.pdf",
            }
        )
        files = LocalFileStore(tmp_path / "files")
        await files.ensure_bucket()
        src = Path(tmp_path) / "a.pdf"
        src.write_bytes(b"%PDF-1.4")
        await files.upload(f"users/u1/{D1}.pdf", src)

        store = LocalVectorStore(str(tmp_path / "memory.db"))
        await store.init()
        job = (await queue.next_batch(1))[0]
        await src_main.process_job_local(queue, job, store, files, keys=keys)

        assert captured["key"] == "sk-or-v1-serverdefault"
        await store.close()
    finally:
        await queue.close()
        await keys.close()
