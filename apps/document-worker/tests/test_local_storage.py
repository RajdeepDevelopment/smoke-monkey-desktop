"""Local storage adapters for the desktop document worker."""
import json
import uuid

import pytest
from src.storage.local_storage import LocalFileStore, LocalVectorStore


class Child:
    def __init__(self, content, page_number):
        self.content = content
        self.page_number = page_number


class Group:
    def __init__(self, parent_content, section, children):
        self.parent_content = parent_content
        self.section = section
        self.children = children


@pytest.fixture
async def store():
    s = LocalVectorStore(":memory:")
    await s.init()
    yield s
    await s.close()


async def test_chunk_roundtrip(store):
    doc_id = uuid.uuid4()
    await store.set_document_status(doc_id, "processing")
    count = await store.replace_document_chunks(
        doc_id,
        [Group("intro", "s1", [Child("alpha beta", 1), Child("gamma delta", 2)])],
        {"alpha beta": [1.0, 0.0], "gamma delta": [0.0, 1.0]},
    )
    assert count == 2
    rows = await store._fetch("SELECT id, parent_chunk_id, embedding FROM chunks WHERE content = ?", ("alpha beta",))
    assert len(rows) == 1
    assert json.loads(rows[0]["embedding"]) == [1.0, 0.0]
    assert rows[0]["parent_chunk_id"] is not None
    await store.set_document_status(doc_id, "ready", chunk_count=count)
    st = await store._fetch("SELECT status, chunk_count FROM documents WHERE id = ?", (str(doc_id),))
    assert st[0]["status"] == "ready"
    assert st[0]["chunk_count"] == 2


async def test_replace_clears_previous_chunks(store):
    doc_id = uuid.uuid4()
    await store.set_document_status(doc_id, "ready", chunk_count=1)
    await store.replace_document_chunks(doc_id, [Group("", None, [Child("v1", 1)])], {})
    await store.replace_document_chunks(doc_id, [Group("", None, [Child("v2", 1)])], {})
    rows = await store._fetch("SELECT content FROM chunks")
    assert [r["content"] for r in rows] == ["", "v2"]


async def test_set_document_status_inserts_then_updates(store):
    doc_id = uuid.uuid4()
    await store.set_document_status(doc_id, "failed", error="boom", chunk_count=0)
    st = await store._fetch("SELECT status, error, chunk_count FROM documents WHERE id = ?", (str(doc_id),))
    assert st[0]["status"] == "failed"
    assert st[0]["error"] == "boom"
    assert st[0]["chunk_count"] == 0


async def test_set_document_status_keeps_user_scope_on_from_scratch_row(store):
    user = "11111111-1111-1111-1111-111111111111"
    doc_id = uuid.uuid4()
    await store.set_document_status(doc_id, "failed", error="boom", user_id=user)
    row = await store.get_document(doc_id, user)
    assert row is not None
    assert row["status"] == "failed"
    assert await store.get_document(doc_id, "other") is None


async def test_file_store_roundtrip(tmp_path):
    fs = LocalFileStore(tmp_path / "files")
    await fs.ensure_bucket()
    src = tmp_path / "src.pdf"
    src.write_bytes(b"%PDF-1.4 test")
    await fs.upload("docs/abc.pdf", src)
    assert (tmp_path / "files" / "docs" / "abc.pdf").is_file()
    dest = tmp_path / "out" / "abc.pdf"
    await fs.download("docs/abc.pdf", dest)
    assert dest.read_bytes() == b"%PDF-1.4 test"
    await fs.delete("docs/abc.pdf")
    with pytest.raises(FileNotFoundError):
        await fs.download("docs/abc.pdf", tmp_path / "nope.pdf")


async def test_file_store_rejects_unsafe_keys(tmp_path):
    fs = LocalFileStore(tmp_path / "files")
    await fs.ensure_bucket()
    src = tmp_path / "src.pdf"
    src.write_bytes(b"%PDF-1.4")
    with pytest.raises(ValueError):
        await fs.download("../etc/passwd", tmp_path / "x.pdf")
    with pytest.raises(ValueError):
        await fs.upload("/abs/path.pdf", src)
