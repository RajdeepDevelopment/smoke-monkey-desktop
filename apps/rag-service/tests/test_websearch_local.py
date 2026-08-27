"""Local-mode web search: BYOK key resolution + cache, no network or Ollama."""
import pytest
from src.application.websearch import WebSearchClient, WebSearchResult
from src.storage.factory import build_local_stores

TAVILY_KEY = "tvly-user-key-0123456789"


@pytest.fixture
async def stores(tmp_path):
    s = build_local_stores(str(tmp_path))
    await s.keys.connect()
    await s.cache.connect()
    yield s
    await s.keys.close()
    await s.cache.close()


class _FakeTavily:
    id = "tavily"
    label = "Tavily"
    requires_key = True

    def __init__(self, server_key: str = "") -> None:
        self.server_key = server_key
        self.calls: list[str | None] = []

    async def search(self, client, query, top_k, api_key):
        self.calls.append(api_key)
        return [WebSearchResult("Result Title", "https://example.com/1", "some content", "tavily")]


def _client(stores, provider: _FakeTavily, *, cache_ttl: int = 21600) -> WebSearchClient:
    c = WebSearchClient(5, redis=stores.redis, providers=["tavily"], cache_ttl=cache_ttl)
    c._registry["tavily"] = provider
    return c


async def test_user_key_is_used(stores):
    provider = _FakeTavily()
    client = _client(stores, provider)
    await stores.redis.set("rag:user_key:default:tavily", TAVILY_KEY)
    results = await client.search_results("hello world", user_id="default")
    assert provider.calls == [TAVILY_KEY]
    assert results[0].title == "Result Title"
    await client.aclose()


async def test_user_key_wins_over_server_default(stores):
    provider = _FakeTavily(server_key="tvly-server-key")
    client = _client(stores, provider)
    await stores.redis.set("rag:user_key:default:tavily", TAVILY_KEY)
    results = await client.search_results("hello world", user_id="default")
    assert provider.calls == [TAVILY_KEY]
    assert results
    await client.aclose()


async def test_no_key_skips_provider(stores):
    provider = _FakeTavily()
    client = _client(stores, provider)
    results = await client.search_results("hello world", user_id="default")
    assert provider.calls == []
    assert results == []
    await client.aclose()


async def test_key_from_keys_store_reaches_search(stores):
    """The keys API path: saved in LocalKeyStore + mirrored, then used."""
    provider = _FakeTavily()
    client = _client(stores, provider)
    await stores.keys.set("tavily", "default", TAVILY_KEY)
    await stores.redis.set("rag:user_key:default:tavily", TAVILY_KEY)
    results = await client.search_results("hello world", user_id="default")
    assert provider.calls == [TAVILY_KEY]
    assert results
    await client.aclose()


async def test_results_are_cached(stores):
    provider = _FakeTavily()
    client = _client(stores, provider)
    await stores.redis.set("rag:user_key:default:tavily", TAVILY_KEY)
    first = await client.search_results("cache me", user_id="default")
    second = await client.search_results("cache me", user_id="default")
    assert first and second
    assert provider.calls == [TAVILY_KEY]  # second call served from cache
    assert first[0].content == second[0].content
    await client.aclose()
