"""RedisBridge: Redis-compatible facade over the local TTL cache."""
import pytest
from src.storage import LocalCacheStore, RedisBridge


@pytest.fixture
async def bridge():
    store = LocalCacheStore(":memory:")
    await store.connect()
    r = RedisBridge(store)
    yield r
    await r.aclose()


async def test_ping(bridge):
    assert await bridge.ping() is True


async def test_get_set_exists_delete(bridge):
    assert await bridge.get("a") is None
    await bridge.set("a", "1")
    assert await bridge.get("a") == "1"
    assert await bridge.exists("a") == 1
    await bridge.delete("a")
    assert await bridge.exists("a") == 0


async def test_set_ex_and_expire(bridge):
    await bridge.set("k", "v", ex=60)
    assert await bridge.expire("k", 60) is True
    assert await bridge.expire("k", 0) is True
    assert await bridge.exists("k") == 0


async def test_unlink(bridge):
    await bridge.set("a", "1")
    assert await bridge.unlink("a") == 1
    assert await bridge.exists("a") == 0


async def test_incr(bridge):
    assert await bridge.incr("c") == 1
    assert await bridge.incr("c") == 2
    assert await bridge.incr("c", 3) == 5


async def test_list_ops(bridge):
    await bridge.lpush("q", "b")
    await bridge.lpush("q", "a")
    assert await bridge.llen("q") == 2
    assert await bridge.lrange("q", 0, -1) == ["a", "b"]
    await bridge.ltrim("q", 0, 0)
    assert await bridge.lrange("q", 0, -1) == ["a"]


async def test_scan_iter(bridge):
    for i in range(5):
        await bridge.set(f"key:{i}", str(i))
    keys = [k async for k in bridge.scan_iter("key:*")]
    assert sorted(keys) == [f"key:{i}" for i in range(5)]


async def test_pipeline_buffers_and_commits(bridge):
    async with bridge.pipeline(transaction=True) as pipe:
        pipe.lpush("telemetry", '{"ts":1}')
        pipe.ltrim("telemetry", 0, 99)
        results = await pipe.execute()
    assert await bridge.llen("telemetry") == 1
    assert results == [None, None]


async def test_pipeline_rate_limit_style(bridge):
    # Mirrors _background_rate_limited in prospective.py (un-awaited commands).
    pipe = bridge.pipeline(transaction=True)
    pipe.incr("ratelimit:u1:v1")
    pipe.expire("ratelimit:u1:v1", 60)
    count, _ = await pipe.execute()
    assert count == 1
    assert await bridge.llen("ratelimit:u1:v1") == 0  # scalar key, not a list
