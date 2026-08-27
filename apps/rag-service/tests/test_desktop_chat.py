"""Desktop chat end-to-end in local mode.

Covers the BYOK chain without any Ollama involvement: keys API → keys.db +
cache mirror → lifespan resolution → per-request key resolution → chat LLM.
"""
import asyncio

import pytest
from fastapi.testclient import TestClient
from src.config import settings
from src.storage.factory import build_local_stores

KEY = "sk-or-v1-desktopchatkey0123456789"
USER = "default"


class FakeChatLLM:
    provider_id = "openrouter"
    model = "fake-model"

    def __init__(self, api_key):
        self.api_key = api_key

    async def chat_stream(self, messages, *, temperature=0.2, max_tokens=1024, api_key=None):
        yield "Hello from "
        yield "desktop"

    async def complete(self, prompt, *, temperature=0.2, max_tokens=512, api_key=None):
        # The query router expects a JSON RoutePlan back.
        return '{"intent":"general","needs_knowledge":false,"needs_memory":false,"needs_web":false}'

    async def aclose(self) -> None:
        pass

    async def ping(self) -> bool:
        return True


class FakeEmbedder:
    provider_id = "openrouter"

    def __init__(self, api_key):
        self.api_key = api_key

    async def embed(self, texts):
        return [[0.1, 0.2, 0.3] for _ in texts]

    async def aclose(self) -> None:
        pass


class _DummyOllama:
    """Startup fallback stand-in so no real OllamaClient is ever constructed."""

    provider_id = "ollama"

    def __init__(self, **_: object) -> None:
        self.api_key = None

    async def chat_stream(self, messages, **kw):
        if False:  # pragma: no cover - never invoked by these tests
            yield ""

    async def complete(self, prompt, **kw) -> str:
        return "{}"

    async def aclose(self) -> None:
        pass

    async def ping(self) -> bool:
        return False


def _fake_build_embedder(api_key):
    return FakeEmbedder(api_key)


@pytest.fixture()
def make_app(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "storage_mode", "local")
    monkeypatch.setattr(settings, "local_data_dir", str(tmp_path))
    monkeypatch.setattr(settings, "embed_provider", "openrouter")
    monkeypatch.setattr(settings, "llm_provider", "openrouter")
    monkeypatch.setattr(settings, "openrouter_api_key", "")
    monkeypatch.setattr(settings, "openrouter_rerank_enabled", False)
    monkeypatch.setattr(settings, "nvidia_rerank_enabled", False)
    monkeypatch.setattr(settings, "rerank_enabled", False)
    monkeypatch.setattr(settings, "web_search_enabled", False)
    monkeypatch.setattr(settings, "monitor_enabled", False)
    monkeypatch.setattr(settings, "cache_enabled", False)
    monkeypatch.setattr(settings, "memory_enabled", False)
    monkeypatch.setattr(settings, "memory_context_enabled", False)
    monkeypatch.setattr(settings, "memory_context_state_enabled", False)
    monkeypatch.setattr(settings, "router_enabled", True)
    monkeypatch.setattr(settings, "memory_direct_path_enabled", True)

    import src.application.pipeline as pipeline
    import src.main as src_main

    captured = {"keys": []}

    def fake_build_chat(provider, *args, **kw):
        api_key = kw.get("api_key")
        if provider in ("openrouter", "openai", "nvidia", "gemini", "xai") and not api_key:
            raise ValueError(f"no api key configured for {provider}")
        captured["keys"].append(api_key)
        return FakeChatLLM(api_key)

    monkeypatch.setattr(src_main, "build_chat_llm", fake_build_chat)
    monkeypatch.setattr(pipeline, "build_chat_llm", fake_build_chat)
    monkeypatch.setattr(src_main, "build_embedder", _fake_build_embedder)
    monkeypatch.setattr(src_main, "OllamaClient", _DummyOllama)

    def _seed(key: str) -> None:
        async def _go():
            stores = build_local_stores(str(tmp_path))
            await stores.keys.connect()
            await stores.cache.connect()
            await stores.keys.set("openrouter", USER, key)
            await stores.redis.set(f"rag:user_key:{USER}:openrouter", key)
            await stores.keys.close()
            await stores.cache.close()

        asyncio.run(_go())

    from src.main import app

    def _start(seed: str | None = None):
        if seed:
            _seed(seed)
        return TestClient(app)

    return captured, _start


def _chat(c: TestClient, **overrides):
    payload = {"message": "hello there", "user_id": USER, "provider": "openrouter", **overrides}
    return c.post("/api/v1/query", json=payload)


def test_seeded_key_streams_chat(make_app):
    captured, start = make_app
    with start(seed=KEY) as c:
        res = _chat(c)
    assert res.status_code == 200, res.text
    assert "Hello from " in res.text
    assert "desktop" in res.text
    # The saved key must have reached the chat builder (startup resolution,
    # request-time resolution, or both).
    assert KEY in captured["keys"]


def test_no_key_returns_error_event(make_app):
    captured, start = make_app
    with start(seed=None) as c:
        res = _chat(c)
    assert res.status_code == 200, res.text
    assert '"type": "error"' in res.text
    assert "API key" in res.text
    assert "Hello from " not in res.text
    assert captured["keys"] == []


def test_single_desktop_key_serves_any_user_id(make_app):
    """Desktop is single-user: the local_user_id key is the installation-wide
    default, so a request without its own key still gets chat service."""
    captured, start = make_app
    with start(seed=KEY) as c:
        res = _chat(c, user_id="someone-else")
    assert res.status_code == 200, res.text
    assert "Hello from " in res.text
    assert KEY in captured["keys"]
