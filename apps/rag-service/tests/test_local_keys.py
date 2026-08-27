"""LocalKeyStore — durable per-provider BYOK keys for the desktop."""
import pytest
from src.storage.local_keys import LocalKeyStore


@pytest.fixture
async def store(tmp_path):
    s = LocalKeyStore(str(tmp_path / "keys.db"))
    await s.connect()
    yield s
    await s.close()


async def test_set_get_roundtrip(store):
    await store.set("openrouter", "u1", "sk-or-v1-abcdefghij")
    assert await store.get("openrouter", "u1") == "sk-or-v1-abcdefghij"
    assert await store.has("openrouter", "u1") is True
    assert await store.get("openrouter", "other") is None


async def test_set_upserts_in_place(store):
    await store.set("openrouter", "u1", "sk-or-v1-aaaaaaaaaa")
    await store.set("openrouter", "u1", "sk-or-v1-bbbbbbbbbb")
    assert await store.get("openrouter", "u1") == "sk-or-v1-bbbbbbbbbb"
    assert await store.has("openrouter", "u1") is True


async def test_get_missing_is_none(store):
    assert await store.get("gemini", "u1") is None
    assert await store.has("gemini", "u1") is False


async def test_delete(store):
    await store.set("openai", "u1", "sk-proj-abcdefghijklmnop")
    assert await store.delete("openai", "u1") is True
    assert await store.get("openai", "u1") is None
    assert await store.delete("openai", "u1") is False


async def test_list_is_masked_and_user_scoped(store):
    await store.set("openrouter", "u1", "sk-or-v1-abcdefghij")
    await store.set("openai", "u1", "sk-proj-abcdefghijklmnop")
    await store.set("openrouter", "u2", "sk-or-v1-zzzzzzzzzz")

    rows = await store.list("u1")
    providers = {r["provider"] for r in rows}
    assert providers == {"openrouter", "openai"}
    summary = next(r for r in rows if r["provider"] == "openrouter")
    assert "sk-or-v1-abcdefghij" not in str(rows)
    assert summary["keyPrefix"] == "sk-or-v1-…"
    assert summary["last4"] == "ghij"
    assert summary["status"] == "ok"

    assert await store.list("u2") and {r["provider"] for r in await store.list("u2")} == {"openrouter"}


async def test_cache_key_format():
    assert LocalKeyStore.cache_key("u1", "openrouter") == "rag:user_key:u1:openrouter"
