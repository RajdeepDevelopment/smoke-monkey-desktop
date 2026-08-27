"""Backend model-aware context validation.

The composer estimates tokens for UX; this is the authoritative check right
before generation. If the assembled request (system prompt + history + RAG
context + user message + reserved output) exceeds the model's context window,
the pipeline surfaces a structured, friendly error instead of letting the
provider reject the request or the turn crash. User text is never truncated.
"""
from __future__ import annotations

import math
import re

# Best-known context windows (tokens). Estimates; the provider is final.
_MODEL_CONTEXT_WINDOWS: dict[str, int] = {
    "nvidia/nemotron-3-nano-30b-a3b": 131072,
    "nvidia/nemotron-3-super-120b-a12b": 131072,
    "nvidia/nemotron-3-ultra-550b-a55b": 131072,
    "nvidia/llama-nemotron-ultra-8b": 131072,
    "nvidia/llama-nemotron-super-27b": 131072,
    "nvidia/nemotron-3-ultra-550b-a55b:free": 131072,
    "big-pickle": 131072,
    "deepseek-v4-flash-free": 131072,
    "mimo-v2.5-free": 131072,
    "nemotron-3-ultra-free": 131072,
    "laguna-s-2.1-free": 131072,
    "deepseek/deepseek-v4-flash:free": 131072,
    "google/gemini-2.0-flash-lite:free": 1048576,
    "meta-llama/llama-4-scout-17b-16e:free": 131072,
    "mistralai/mistral-small-3.2:free": 131072,
    "qwen3:8b": 32768,
}

_PROVIDER_CONTEXT_WINDOWS: dict[str, int] = {
    "nvidia": 131072,
    "opencode": 131072,
    "openrouter": 131072,
    "omniroute": 131072,
    "gemini": 1048576,
    "openai": 131072,
    "xai": 131072,
    "ollama": 32768,
}

_FALLBACK_CONTEXT_WINDOW = 32768

_SYSTEM_OVERHEAD_TOKENS = 2000
_RAG_RESERVE_TOKENS = 12000

_CJK_RE = re.compile(
    r"[\u3000-\u303f\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af\ud800-\udfff\U0001f300-\U0001faff]"
)


def estimate_tokens(text: str) -> int:
    """Approximate token count (4 chars/token, CJK/emoji weighted heavier)."""
    if not text:
        return 0
    cjk = len(_CJK_RE.findall(text))
    other = max(0, len(text) - cjk)
    return math.ceil(other / 4) + math.ceil(cjk * 2 / 3)


def estimate_messages_tokens(messages: list[dict[str, str]]) -> int:
    total = 0
    for msg in messages:
        total += estimate_tokens(msg.get("content") or "") + 4
    return total


def context_window_for(provider: str, model: str) -> int:
    if model in _MODEL_CONTEXT_WINDOWS:
        return _MODEL_CONTEXT_WINDOWS[model]
    for key, size in _MODEL_CONTEXT_WINDOWS.items():
        if key.split("/")[-1] == model.split("/")[-1]:
            return size
    return _PROVIDER_CONTEXT_WINDOWS.get(provider, _FALLBACK_CONTEXT_WINDOW)


def validate_context(
    provider: str,
    model: str,
    messages: list[dict[str, str]],
    max_tokens: int,
    rag_active: bool,
) -> str | None:
    """Return a friendly error when the request exceeds the context window.

    ``None`` means the request fits (within estimate). ``max_tokens`` is the
    reserved output budget. ``rag_active`` reserves headroom for the retrieved
    context that is not part of ``messages`` yet at this point.
    """
    context = context_window_for(provider, model)
    output_reserve = max(1, max_tokens)
    context_reserve = _RAG_RESERVE_TOKENS if rag_active else 0
    available = context - output_reserve - _SYSTEM_OVERHEAD_TOKENS - context_reserve
    if available < 1:
        available = 1
    used = estimate_messages_tokens(messages) + _SYSTEM_OVERHEAD_TOKENS + context_reserve
    if used <= available:
        return None
    return (
        f"The request is over the {model or provider} context budget: "
        f"~{used:,} tokens needed vs {available:,} available (context "
        f"{context:,}, output {output_reserve:,} reserved). Shorten the "
        "prompt/conversation or switch to a larger-context model. Nothing was "
        "truncated."
    )
