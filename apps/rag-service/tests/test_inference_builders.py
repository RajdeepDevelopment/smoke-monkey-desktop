"""Inference builders resolve the user's saved BYOK key over server defaults."""

from src.config import settings
from src.generation.embedders import OllamaEmbedder, OpenRouterEmbedder
from src.main import build_embedder


def test_embedder_uses_supplied_key(monkeypatch):
    monkeypatch.setattr(settings, "embed_provider", "openrouter")
    emb = build_embedder("sk-or-v1-user")
    assert isinstance(emb, OpenRouterEmbedder)
    assert emb._client.api_key == "sk-or-v1-user"


def test_embedder_falls_back_to_server_default(monkeypatch):
    monkeypatch.setattr(settings, "embed_provider", "openrouter")
    monkeypatch.setattr(settings, "openrouter_api_key", "sk-or-v1-server")
    emb = build_embedder()
    assert emb._client.api_key == "sk-or-v1-server"


def test_embedder_ollama_needs_no_key(monkeypatch):
    monkeypatch.setattr(settings, "embed_provider", "ollama")
    emb = build_embedder("sk-or-v1-user")  # ignored for the local provider
    assert isinstance(emb, OllamaEmbedder)
