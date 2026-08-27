"""Gateway-compatible desktop API surface in local mode.

Phase 14: the in-app UI talks to ``/api/*`` exactly like it does to the
api-gateway — auth, chat/stream (with persistence), conversations, settings,
documents/keys/models/health/metrics aliases. No Ollama is involved.
"""
import asyncio

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from src.config import settings
from src.storage.factory import build_local_stores

KEY = "sk-or-v1-desktopapikey0123456789"
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
        return '{"intent":"general","needs_knowledge":false,"needs_memory":false,"needs_web":false}'

    async def aclose(self) -> None:
        pass

    async def ping(self) -> bool:
        return True


class FakeEmbedder:
    provider_id = "openrouter"

    def __init__(self, api_key):
        self.api_key = api_key

    async def embed(self, texts, api_key=None, input_type=None):
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


async def _noop_validate(provider, api_key):
    """Offline stand-in: network hiccups never block saving (Phase 11)."""
    return None


@pytest.fixture()
def make_app(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "storage_mode", "local")
    monkeypatch.setattr(settings, "local_data_dir", str(tmp_path))
    monkeypatch.setattr(settings, "embed_provider", "openrouter")
    monkeypatch.setattr(settings, "llm_provider", "openrouter")
    monkeypatch.setattr(settings, "openrouter_api_key", "")
    # Point OpenRouter/OmniRoute probes at a dead port so the alias tests fail
    # fast offline instead of waiting out the httpx timeout.
    monkeypatch.setattr(settings, "openrouter_base_url", "http://127.0.0.1:9")
    monkeypatch.setattr(settings, "omniroute_base_url", "http://127.0.0.1:9")
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

    import src.api.keys as api_keys
    import src.application.pipeline as pipeline
    import src.main as src_main

    monkeypatch.setattr(api_keys, "validate_provider_key", _noop_validate)

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


def test_auth_single_user_noop(make_app):
    """Single-user desktop auth: profile name/email persist and the password
    set at register/login must match on every later login."""
    captured, start = make_app
    with start() as c:
        register = c.post(
            "/api/auth/register",
            json={"email": "raj@x.z", "name": "Raj", "password": "secret"},
        )
        assert register.status_code == 200
        assert register.json()["user"]["id"] == USER
        assert register.json()["user"]["email"] == "raj@x.z"
        assert register.json()["user"]["name"] == "Raj"

        bad = c.post("/api/auth/login", json={"email": "raj@x.z", "password": "wrong"})
        assert bad.status_code == 401

        login = c.post("/api/auth/login", json={"email": "raj@x.z", "password": "secret"})
        assert login.status_code == 200
        assert login.json()["accessToken"] == "desktop"
        assert login.json()["user"]["name"] == "Raj"

        me = c.post("/api/auth/me", json={})
        assert me.status_code == 200
        assert me.json()["user"]["id"] == USER
        assert me.json()["user"]["name"] == "Raj"

        logout = c.post("/api/auth/logout", json={})
        assert logout.status_code == 200
        assert logout.json()["status"] == "ok"


def test_conversations_crud(make_app):
    captured, start = make_app
    with start() as c:
        empty = c.get("/api/conversations")
        assert empty.status_code == 200 and empty.json() == []

        created = c.post("/api/conversations", json={"title": "first"})
        assert created.status_code == 200, created.text
        conv = created.json()
        assert conv["userId"] == USER and conv["title"] == "first"

        listed = c.get("/api/conversations").json()
        assert [x["id"] for x in listed] == [conv["id"]]

        msgs = c.get(f"/api/conversations/{conv['id']}/messages")
        assert msgs.status_code == 200 and msgs.json() == []

        deleted = c.delete(f"/api/conversations/{conv['id']}")
        assert deleted.status_code == 200
        assert c.get("/api/conversations").json() == []

        gone = c.get(f"/api/conversations/{conv['id']}/messages")
        assert gone.status_code == 404
        assert c.delete(f"/api/conversations/{conv['id']}").status_code == 404


def test_settings_roundtrip(make_app, tmp_path):
    captured, start = make_app
    with start() as c:
        initial = c.get("/api/settings")
        assert initial.status_code == 200
        assert initial.json() == {
            "webSearch": {"serverEnabled": False, "enabled": False},
            "omniroute": {"serverEnabled": False, "enabled": False},
        }

        on = c.put("/api/settings/web-search", json={"enabled": True})
        assert on.status_code == 200
        assert on.json()["webSearch"]["enabled"] is True

        omni = c.put("/api/settings/omniroute", json={"enabled": True})
        assert omni.status_code == 200
        assert omni.json()["omniroute"]["enabled"] is True

        after = c.get("/api/settings").json()
        assert after["webSearch"]["enabled"] is True
        assert after["omniroute"]["enabled"] is True

        off = c.put("/api/settings/web-search", json={"enabled": False})
        assert off.json()["webSearch"]["enabled"] is False
        assert c.get("/api/settings").json()["webSearch"]["enabled"] is False

    async def _check_flags():
        stores = build_local_stores(str(tmp_path))
        await stores.cache.connect()
        web = await stores.redis.get(f"rag:user_setting:{USER}:web_search")
        omni = await stores.redis.get(f"rag:user_setting:{USER}:omniroute")
        await stores.cache.close()
        return web, omni

    web, omni = asyncio.run(_check_flags())
    assert web == "0"
    assert omni == "1"


def test_chat_stream_persists_messages(make_app):
    captured, start = make_app
    with start(seed=KEY) as c:
        conv = c.post("/api/conversations", json={"title": "chat"}).json()

        res = c.post(
            "/api/chat/stream",
            json={
                "message": "hello there",
                "conversationId": conv["id"],
                "provider": "openrouter",
            },
        )
        assert res.status_code == 200, res.text
        assert "Hello from " in res.text
        assert KEY in captured["keys"]

        msgs = c.get(f"/api/conversations/{conv['id']}/messages")
        assert msgs.status_code == 200
        rows = msgs.json()
        assert [m["role"] for m in rows] == ["user", "assistant"]
        assert rows[0]["content"] == "hello there"
        assert rows[1]["content"] == "Hello from desktop"


def test_chat_stream_persists_even_without_key(make_app):
    captured, start = make_app
    with start() as c:
        conv = c.post("/api/conversations", json={"title": "no-key"}).json()
        res = c.post(
            "/api/chat/stream",
            json={"message": "hi", "conversationId": conv["id"]},
        )
        assert res.status_code == 200, res.text
        assert '"type": "error"' in res.text
        msgs = c.get(f"/api/conversations/{conv['id']}/messages").json()
        assert [m["role"] for m in msgs] == ["user", "assistant"]


def test_nvidia_only_key_streams_chat_and_embeds(make_app, monkeypatch):
    """Regression: a single NVIDIA BYOK key drives chat AND embeddings.

    Embeddings are configured to openrouter (no key), so the per-request embed
    layer must fall back to the request's NVIDIA chat key. Before the fix this
    produced ``Retrieval failed: Illegal header value b'Bearer '`` because the
    keyless openrouter embedder emitted an empty Authorization header.
    """
    import src.application.pipeline as pipeline

    # Keep the temp-embedder construction hermetic (no network).
    monkeypatch.setattr(
        pipeline.QueryPipeline,
        "_temp_embedder",
        lambda self, provider, api_key: FakeEmbedder(api_key),
    )
    # Force the retrieval path (needs_knowledge=true) so embeddings actually run.
    monkeypatch.setattr(
        FakeChatLLM,
        "complete",
        lambda self, prompt, **kw: (
            '{"intent":"hybrid","needs_knowledge":true,"needs_memory":false,"needs_web":false}'
        ),
    )

    captured, start = make_app
    with start() as c:
        saved = c.put("/api/keys/nvidia", json={"apiKey": "nvapi-testkey0000000000000000"})
        assert saved.status_code == 200, saved.text

        conv = c.post("/api/conversations", json={"title": "nvidia"}).json()
        res = c.post(
            "/api/chat/stream",
            json={
                "message": "what is hybrid retrieval",
                "conversationId": conv["id"],
                "provider": "nvidia",
                "model": "nvidia/nemotron-3-nano-30b-a3b",
            },
        )
        assert res.status_code == 200, res.text
        assert '"type": "error"' not in res.text
        assert "Hello from " in res.text
        assert any(k and str(k).startswith("nvapi-") for k in captured["keys"])


def test_health_and_models_aliases(make_app):
    captured, start = make_app
    with start() as c:
        assert c.get("/api/health").status_code == 200

        models = c.get("/api/models")
        assert models.status_code == 200
        assert "providers" in models.json()

        orm = c.get("/api/models/openrouter")
        assert orm.status_code == 200
        assert orm.json()["reachable"] is False

        om = c.get("/api/models/omniroute")
        assert om.status_code == 200

        metrics = c.get("/api/analytics/metrics")
        assert metrics.status_code == 200
        assert isinstance(metrics.json(), dict)


def test_documents_and_keys_aliases(make_app):
    captured, start = make_app
    with start() as c:
        docs = c.get("/api/documents")
        assert docs.status_code == 200 and docs.json() == []

        saved = c.put("/api/keys/openrouter", json={"apiKey": KEY})
        assert saved.status_code == 200, saved.text
        assert saved.json()["status"] == "ok"
        assert saved.json()["keyPrefix"].startswith("sk-or-v1-")
        assert saved.json()["last4"] == KEY[-4:]

        keys = c.get("/api/keys").json()["keys"]
        assert [k["provider"] for k in keys] == ["openrouter"]

        probe = c.post("/api/keys/openrouter/test")
        assert probe.status_code == 200
        assert probe.json()["info"] is None

        removed = c.delete("/api/keys/openrouter")
        assert removed.status_code == 200
        assert c.get("/api/keys").json()["keys"] == []


def test_cloud_mode_returns_501(monkeypatch):
    monkeypatch.setattr(settings, "storage_mode", "cloud")
    from src.api.desktop import router as desktop_router

    app = FastAPI()
    app.include_router(desktop_router)
    with TestClient(app) as c:
        assert c.post("/api/auth/login", json={}).status_code == 501
        assert c.get("/api/settings").status_code == 501
        assert c.get("/api/conversations").status_code == 501
