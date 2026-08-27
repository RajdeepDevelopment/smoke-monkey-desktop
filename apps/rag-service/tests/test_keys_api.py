"""Desktop BYOK keys API — local-only, mirrors the api-gateway /keys contract."""
from __future__ import annotations

import pytest
import src.api.keys as keys_api
from fastapi import HTTPException
from fastapi.testclient import TestClient
from src.config import settings


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "storage_mode", "local")
    monkeypatch.setattr(settings, "local_data_dir", str(tmp_path))
    monkeypatch.setattr(settings, "embed_provider", "ollama")
    monkeypatch.setattr(settings, "openrouter_rerank_enabled", False)
    monkeypatch.setattr(settings, "nvidia_rerank_enabled", False)
    monkeypatch.setattr(settings, "rerank_enabled", False)
    monkeypatch.setattr(settings, "monitor_enabled", False)
    monkeypatch.setattr(settings, "web_search_enabled", False)
    # Never hit a real provider in tests.
    monkeypatch.setattr(keys_api, "validate_provider_key", _noop_validate)

    from src.main import app

    with TestClient(app) as c:
        yield c


async def _noop_validate(_provider: str, _api_key: str):
    return None


def test_put_get_delete_flow(client, tmp_path):
    res = client.put("/api/v1/keys/openrouter", json={"apiKey": "sk-or-v1-abcdefghijklmnop"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["provider"] == "openrouter"
    assert body["status"] == "ok"
    assert body["keyPrefix"] == "sk-or-v1-…"
    assert body["last4"] == "mnop"

    listed = client.get("/api/v1/keys").json()
    assert [k["provider"] for k in listed["keys"]] == ["openrouter"]
    assert "sk-or-v1-abcdefghijklmnop" not in str(listed)

    # The durable store and the cache mirror both hold the key.
    import sqlite3

    def _read(db, query, params=()):
        conn = sqlite3.connect(str(db))
        try:
            return conn.execute(query, params).fetchone()
        finally:
            conn.close()

    row = _read(
        tmp_path / "keys.db",
        "SELECT api_key FROM provider_keys WHERE provider = 'openrouter' AND user_id = ?",
        (settings.local_user_id,),
    )
    assert row is not None and row[0] == "sk-or-v1-abcdefghijklmnop"
    mirrored = _read(
        tmp_path / "cache.db",
        "SELECT value FROM cache_entries WHERE key = 'rag:user_key:default:openrouter'",
    )
    assert mirrored is not None and mirrored[0] == "sk-or-v1-abcdefghijklmnop"

    res = client.delete("/api/v1/keys/openrouter")
    assert res.status_code == 200
    assert client.get("/api/v1/keys").json()["keys"] == []
    assert _read(
        tmp_path / "cache.db",
        "SELECT value FROM cache_entries WHERE key = 'rag:user_key:default:openrouter'",
    ) is None


def test_put_rejects_malformed_key(client):
    res = client.put("/api/v1/keys/openrouter", json={"apiKey": "abcdefghijklmnop"})
    assert res.status_code == 400
    assert "sk-or-v1-" in res.json()["detail"]


def test_put_rejects_unsupported_provider(client):
    res = client.put("/api/v1/keys/notreal", json={"apiKey": "x" * 20})
    assert res.status_code == 400


def test_put_still_saves_when_validation_network_fails(client, monkeypatch):
    async def _fail_validate(_provider, _api_key):
        raise httpx.ConnectError("no network")

    import httpx

    monkeypatch.setattr(keys_api, "validate_provider_key", _fail_validate)
    res = client.put("/api/v1/keys/nvidia", json={"apiKey": "nvapi-abcdefghijklmnop"})
    assert res.status_code == 200, res.text


def test_put_rejects_when_validation_says_invalid(client, monkeypatch):
    async def _invalid(_provider, _api_key):
        raise HTTPException(status_code=400, detail="invalid")

    monkeypatch.setattr(keys_api, "validate_provider_key", _invalid)
    res = client.put("/api/v1/keys/openai", json={"apiKey": "sk-proj-abcdefghijklmnop"})
    assert res.status_code == 400


def test_test_endpoint_404_without_key(client):
    assert client.post("/api/v1/keys/openrouter/test").status_code == 404


def test_cloud_mode_is_501(monkeypatch):
    from fastapi import FastAPI
    from src.api.keys import router as keys_router

    monkeypatch.setattr(settings, "storage_mode", "cloud")
    bare = FastAPI()
    bare.include_router(keys_router)
    with TestClient(bare) as c:
        res = c.put("/api/v1/keys/openrouter", json={"apiKey": "sk-or-v1-abcdefghijklmnop"})
    assert res.status_code == 501
