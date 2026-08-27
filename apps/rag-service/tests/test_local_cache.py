"""Local SQLite cache adapter tests (no Redis needed)."""
import asyncio

import pytest
from src.storage import CacheStore, LocalCacheStore


@pytest.fixture
async def store():
    s = LocalCacheStore(":memory:")
    await s.connect()
    yield s
    await s.close()


async def test_satisfies_cachestore(store):
    assert isinstance(store, CacheStore)
    assert store.enabled is True


async def test_set_get_roundtrip(store):
    await store.set("k", "v")
    assert await store.get("k") == "v"


async def test_get_missing_returns_none(store):
    assert await store.get("missing") is None


async def test_overwrite(store):
    await store.set("k", "one")
    await store.set("k", "two")
    assert await store.get("k") == "two"


async def test_ttl_expiry(store):
    await store.set("k", "v", ttl=1)
    assert await store.get("k") == "v"
    await asyncio.sleep(1.05)
    assert await store.get("k") is None


async def test_ttl_zero_immediately_expired(store):
    await store.set("k", "v", ttl=0)
    assert await store.get("k") is None


async def test_no_ttl_never_expires(store):
    await store.set("k", "v", ttl=None)
    assert await store.get("k") == "v"


async def test_exists(store):
    await store.set("k", "v")
    assert await store.exists("k") is True
    assert await store.exists("missing") is False


async def test_exists_expired_key_is_false(store):
    await store.set("k", "v", ttl=0)
    assert await store.exists("k") is False


async def test_delete(store):
    await store.set("k", "v")
    await store.delete("k")
    assert await store.get("k") is None
    assert await store.exists("k") is False


async def test_push_tail_range(store):
    await store.push_tail("list", "a")
    await store.push_tail("list", "b")
    await store.push_tail("list", "c")
    assert await store.range("list", 0, -1) == ["c", "b", "a"]
    assert await store.range("list", 0, 1) == ["c", "b"]
    assert await store.range("list", 2, 2) == ["a"]
    assert await store.range("list", 5, 10) == []


async def test_trim(store):
    await store.push_tail("list", "a")
    await store.push_tail("list", "b")
    await store.push_tail("list", "c")
    await store.push_tail("list", "d")
    await store.trim("list", 0, 1)
    assert await store.range("list", 0, -1) == ["d", "c"]


async def test_delete_removes_list_key(store):
    await store.push_tail("list", "a")
    assert await store.exists("list") is True
    await store.delete("list")
    assert await store.range("list", 0, -1) == []
    assert await store.exists("list") is False


async def test_list_ttl_not_required(store):
    await store.push_tail("k", "x")
    assert await store.get("k") is None  # get is key/value only, list untouched
    assert await store.range("k", 0, -1) == ["x"]


async def test_disabled_store_noops():
    s = LocalCacheStore(":memory:")
    assert s.enabled is False
    await s.set("k", "v")
    assert await s.get("k") is None
    assert await s.exists("k") is False
    await s.push_tail("list", "x")
    assert await s.range("list", 0, -1) == []


async def test_persists_across_reopen(tmp_path):
    db = str(tmp_path / "cache.db")
    s = LocalCacheStore(db)
    await s.connect()
    await s.set("k", "v")
    await s.push_tail("list", "a")
    await s.close()

    s2 = LocalCacheStore(db)
    await s2.connect()
    assert await s2.get("k") == "v"
    assert await s2.range("list", 0, -1) == ["a"]
    await s2.close()
