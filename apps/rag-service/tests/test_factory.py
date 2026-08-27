"""build_local_stores factory — one bundle, every port wired locally."""
import asyncio

from src.storage.factory import build_local_stores


def test_build_local_stores(tmp_path):
    build_local_stores(str(tmp_path))
    assert tmp_path.is_dir()


async def test_build_local_stores_connects(tmp_path):
    stores = build_local_stores(str(tmp_path))
    await stores.vector.connect()
    await stores.graph.connect()
    await stores.cache.connect()
    await stores.jobs.connect()
    await stores.keys.connect()
    await stores.feedback.connect()
    await stores.conversations.connect()
    assert (tmp_path / "memory.db").exists()
    assert (tmp_path / "cache.db").exists()
    assert (tmp_path / "jobs.db").exists()
    assert (tmp_path / "keys.db").exists()
    assert (tmp_path / "feedback.db").exists()
    assert (tmp_path / "conversations.db").exists()
    assert stores.vector.enabled is True
    assert stores.graph.enabled is True
    assert stores.cache.enabled is True
    assert await stores.redis.ping() is True
    for s in (
        stores.vector,
        stores.graph,
        stores.cache,
        stores.jobs,
        stores.keys,
        stores.feedback,
        stores.conversations,
    ):
        await s.close()


async def test_build_shared_memory_db(tmp_path):
    stores = build_local_stores(str(tmp_path))
    assert stores.vector.db_path == stores.graph.db_path
    await stores.vector.connect()
    await stores.graph.connect()
    await stores.vector.set_document_status("doc-1", "ready", chunk_count=0)
    cursor = await stores.graph._run(
        stores.graph._conn.execute, "SELECT id FROM documents WHERE id = ?", ("doc-1",)
    )
    rows = await asyncio.to_thread(cursor.fetchall)
    assert len(rows) == 1
    await stores.vector.close()
    await stores.graph.close()


async def test_build_redis_wired_to_cache(tmp_path):
    stores = build_local_stores(str(tmp_path))
    await stores.cache.connect()
    await stores.redis.set("k", "v", ex=60)
    assert await stores.cache.get("k") == "v"
    await stores.cache.close()
