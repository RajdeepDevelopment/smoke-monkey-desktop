"""Local filesystem DocumentStore tests (no MinIO needed)."""
import pytest
from src.storage import DocumentStore, LocalDocumentStore


@pytest.fixture
def store(tmp_path):
    return LocalDocumentStore(tmp_path / "docs")


async def test_satisfies_documentstore(store):
    assert isinstance(store, DocumentStore)
    assert store.enabled is True


async def test_upload_download_roundtrip(store, tmp_path):
    src = tmp_path / "in.pdf"
    src.write_bytes(b"pdf-bytes-123")
    await store.ensure_bucket()
    await store.upload("folder/a.pdf", src)

    dest = tmp_path / "out.pdf"
    await store.download("folder/a.pdf", dest)
    assert dest.read_bytes() == b"pdf-bytes-123"


async def test_upload_overwrites(store, tmp_path):
    a, b = tmp_path / "a.pdf", tmp_path / "b.pdf"
    a.write_bytes(b"one")
    b.write_bytes(b"two")
    await store.upload("doc.pdf", a)
    await store.upload("doc.pdf", b)
    dest = tmp_path / "out.pdf"
    await store.download("doc.pdf", dest)
    assert dest.read_bytes() == b"two"


async def test_download_missing_raises(store, tmp_path):
    with pytest.raises(FileNotFoundError):
        await store.download("nope.pdf", tmp_path / "out.pdf")


async def test_upload_missing_source_raises(store, tmp_path):
    with pytest.raises(FileNotFoundError):
        await store.upload("doc.pdf", tmp_path / "missing.pdf")


async def test_delete_removes_object(store, tmp_path):
    src = tmp_path / "a.pdf"
    src.write_bytes(b"x")
    await store.upload("doc.pdf", src)
    await store.delete("doc.pdf")
    with pytest.raises(FileNotFoundError):
        await store.download("doc.pdf", tmp_path / "out.pdf")


async def test_delete_missing_is_noop(store):
    await store.delete("ghost.pdf")  # must not raise


async def test_unsafe_keys_rejected(store, tmp_path):
    src = tmp_path / "a.pdf"
    src.write_bytes(b"x")
    with pytest.raises(ValueError):
        await store.upload("../escape.pdf", src)
    with pytest.raises(ValueError):
        await store.upload("/abs/path.pdf", src)
    with pytest.raises(ValueError):
        await store.download("../../etc/passwd", tmp_path / "out.pdf")


async def test_persists_across_instances(tmp_path):
    root = tmp_path / "docs"
    s1 = LocalDocumentStore(root)
    src = tmp_path / "a.pdf"
    src.write_bytes(b"persisted")
    await s1.upload("k.pdf", src)

    s2 = LocalDocumentStore(root)
    dest = tmp_path / "out.pdf"
    await s2.download("k.pdf", dest)
    assert dest.read_bytes() == b"persisted"
