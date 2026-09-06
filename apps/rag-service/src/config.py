import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

MODEL_CATALOG_DEFAULT = Path(__file__).parent / "config" / "model_catalog.json"


@lru_cache
def load_model_catalog(path: str = "") -> dict[str, Any]:
    """Load the dynamic model catalog (provider labels + recommended presets).

    The catalog is plain data — edit it (or point MODEL_CATALOG_PATH at a
    different file) to change what the UI recommends without touching code.
    """
    catalog_path = Path(path or str(MODEL_CATALOG_DEFAULT))
    if not catalog_path.exists():
        return {"providers": {}, "presets": []}
    try:
        return json.loads(catalog_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"providers": {}, "presets": []}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    postgres_host: str = "localhost"
    postgres_port: int = 5432
    postgres_user: str = "rag"
    postgres_password: str = "rag_secret"
    postgres_db: str = "ragdb"

    redis_host: str = "localhost"
    redis_port: int = 6379
    redis_password: str = ""

    # Deployment mode: "cloud" (default) uses Postgres + Redis + Neo4j exactly
    # as before; "local" runs the whole memory/retrieval/cache stack on the
    # on-disk SQLite adapters under `local_data_dir`, so the desktop edition
    # needs zero cloud database services.
    storage_mode: str = "cloud"
    local_data_dir: str = "./data"
    # Single-user identity for the desktop edition: documents and BYOK keys
    # are scoped to this id (the web/cloud flow uses the gateway's user id).
    local_user_id: str = "default"
    # Origins allowed to call the desktop API from the Tauri webview. macOS
    # uses the `tauri://localhost` scheme; Windows/Linux use http(s)://tauri.
    # localhost — plus localhost dev origins for the bundled UI.
    local_cors_origins: str = (
        "tauri://localhost,http://tauri.localhost,https://tauri.localhost,"
        "http://localhost:1420,http://localhost:3001,http://localhost:8000"
    )

    ollama_base_url: str = "http://localhost:11434"
    ollama_chat_model: str = "qwen3:8b"
    ollama_embed_model: str = "nomic-embed-text"
    ollama_embed_dims: int = 768

    # Chat LLM provider: "ollama" (self-hosted), "openrouter" (cloud) or
    # "gemini" (Google AI Studio free tier)
    llm_provider: str = "ollama"
    gemini_api_key: str = ""
    gemini_base_url: str = "https://generativelanguage.googleapis.com/v1beta"
    gemini_model: str = "gemini-3.5-flash"
    gemini_models: str = (
        "gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite"
    )

    # OpenAI (ChatGPT) — users can bring their own key; OPENAI_API_KEY is the
    # server-level default.
    openai_api_key: str = ""
    openai_base_url: str = "https://api.openai.com/v1"
    openai_chat_model: str = "gpt-chat-latest"
    openai_chat_models: str = (
        "gpt-5.6-luna-pro,gpt-5.6-luna,gpt-5.6-terra,gpt-5.6-sol,gpt-chat-latest,"
        "gpt-4.1,gpt-4o-mini"
    )

    # xAI (Grok) — users can bring their own key; XAI_API_KEY is the
    # server-level default.
    xai_api_key: str = ""
    xai_base_url: str = "https://api.x.ai/v1"
    xai_chat_model: str = "grok-4.6"
    xai_chat_models: str = "grok-4.6,grok-4.5,grok-4.3"

    # OpenRouter (cloud) — chat models (change freely; `:free` variants need no
    # credits). ~150 curated models across families (all Google Gemini/Gemma,
    # Anthropic Claude, OpenAI GPT, x-ai Grok, DeepSeek, Qwen, Llama, Mistral,
    # Kimi, GLM, Nemotron, …). The full dynamic list (400+) is served live from
    # `GET /api/v1/openrouter/models`; this list is the curated default set.
    openrouter_api_key: str = ""
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    openrouter_chat_model: str = "nvidia/nemotron-3-nano-30b-a3b:free"
    openrouter_chat_models: str = (
        "google/gemini-3.7-flash,google/gemini-3.6-flash,google/gemini-3.5-flash,"
        "google/gemini-3.5-flash-lite,anthropic/claude-opus-5,"
        "anthropic/claude-opus-5-fast,anthropic/claude-sonnet-5,"
        "anthropic/claude-fable-5,anthropic/claude-opus-4.8,openai/gpt-5.6-luna-pro,"
        "openai/gpt-5.6-luna,openai/gpt-5.6-terra,openai/gpt-5.6-sol,"
        "openai/gpt-chat-latest,x-ai/grok-4.6,x-ai/grok-4.5,x-ai/grok-4.3,"
        "deepseek/deepseek-v4-pro,deepseek/deepseek-v4-flash,deepseek/deepseek-v3.2,"
        "deepseek/deepseek-r1,qwen/qwen3.8-max,qwen/qwen3.7-flash,"
        "qwen/qwen3.6-35b-a3b,qwen/qwen3.5-9b,meta-llama/llama-4-maverick,"
        "meta-llama/llama-4-scout,meta-llama/llama-3.3-70b-instruct,"
        "mistralai/mistral-large-2512,mistralai/mistral-small-3.2-24b-instruct,"
        "mistralai/codestral-2508,moonshotai/kimi-k3,moonshotai/kimi-k2.6,"
        "moonshotai/kimi-k2.5,z-ai/glm-5.2,z-ai/glm-4.7-flash,"
        "nvidia/nemotron-3-ultra-550b-a55b,nvidia/nemotron-3-super-120b-a12b:free,"
        "nvidia/nemotron-3-nano-30b-a3b:free,nvidia/nemotron-3.5-lightning:free,"
        "cohere/command-a,amazon/nova-pro-v1,amazon/nova-2-lite-v1,minimax/minimax-m3,"
        "perplexity/sonar-pro,bytedance-seed/seed-2-1-turbo,openrouter/auto,"
        "openrouter/fusion,qwen/qwen3.8-2.4t-a95b,z-ai/glm-5v-turbo,"
        "google/gemini-2.5-pro-preview,google/gemma-4-31b-it,"
        "google/gemma-4-26b-a4b-it:free,google/gemma-3-4b-it,"
        "google/gemini-3.1-flash-lite,google/gemma-4-31b-it:free,"
        "google/gemma-4-26b-a4b-it,google/gemini-3-flash-preview,"
        "google/gemini-2.5-flash-lite,google/gemini-3.1-flash-lite-preview,"
        "google/gemma-3-27b-it,google/gemini-2.5-pro,google/gemma-3-12b-it,"
        "google/gemini-2.5-flash,google/gemini-3.1-pro-preview,"
        "google/gemini-2.5-pro-preview-05-06,"
        "google/gemini-3.1-pro-preview-customtools,google/gemma-2-27b-it,"
        "google/gemma-3n-e4b-it,anthropic/claude-opus-4.8-fast,"
        "anthropic/claude-opus-4.7,anthropic/claude-opus-4.6,"
        "anthropic/claude-opus-4.5,anthropic/claude-opus-4.1,anthropic/claude-opus-4,"
        "anthropic/claude-sonnet-4.6,anthropic/claude-sonnet-4.5,"
        "anthropic/claude-sonnet-4,anthropic/claude-haiku-4.5,"
        "anthropic/claude-3-haiku,openai/gpt-5.5-pro,openai/gpt-5.4-pro,"
        "openai/gpt-5.2-pro,openai/gpt-5-pro,openai/gpt-5.5,openai/gpt-5.4-mini,"
        "openai/gpt-5.4,openai/gpt-5.2-codex,openai/gpt-5.2-chat,openai/gpt-5.2,"
        "openai/gpt-5.1-codex,openai/gpt-5.1-codex-mini,openai/gpt-5.1,openai/gpt-5,"
        "openai/gpt-5-mini,openai/gpt-oss-120b,openai/gpt-oss-20b:free,openai/gpt-4.1,"
        "openai/gpt-4o-mini,x-ai/grok-4.20,x-ai/grok-build-0.1,"
        "deepseek/deepseek-v4-pro-0813,deepseek/deepseek-v4-flash-0731,"
        "deepseek/deepseek-v3.2-exp,deepseek/deepseek-chat-v3.1,"
        "deepseek/deepseek-r1-0528,deepseek/deepseek-chat-v3-0324,"
        "deepseek/deepseek-chat,deepseek/deepseek-r1-distill-llama-70b,"
        "qwen/qwen3.7-max,qwen/qwen3.6-flash,qwen/qwen3-max-thinking,qwen/qwen3-max,"
        "qwen/qwen3-coder-flash,qwen/qwen3.8-27b,qwen/qwen3.5-122b-a10b,"
        "qwen/qwen3-coder,qwen/qwen3-235b-a22b,qwen/qwen3-32b,qwen/qwen3-14b,"
        "qwen/qwen2.5-vl-72b-instruct,qwen/qwen-plus,"
        "meta-llama/llama-3.1-70b-instruct,meta-llama/llama-3.1-8b-instruct,"
        "meta-llama/llama-3.2-3b-instruct,mistralai/mistral-large,"
        "mistralai/mistral-medium-3,mistralai/mistral-small-3.1-24b-instruct,"
        "mistralai/mistral-small-24b-instruct-2501,mistralai/mistral-nemo,"
        "mistralai/mixtral-8x22b-instruct,mistralai/ministral-8b-2512,"
        "moonshotai/kimi-k2.7-code,moonshotai/kimi-k2-thinking,"
        "moonshotai/kimi-k2-0905,moonshotai/kimi-k2,z-ai/glm-5.1,z-ai/glm-5,"
        "z-ai/glm-4.7,z-ai/glm-4.6,z-ai/glm-4.5,z-ai/glm-4.5-air,"
        "nvidia/nemotron-3-ultra-550b-a55b:free,nvidia/nemotron-3-super-120b-a12b,"
        "nvidia/nemotron-3-nano-30b-a3b,"
        "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free,"
        "nvidia/nemotron-nano-9b-v2:free,cohere/command-r-08-2024,"
        "cohere/command-r-plus-08-2024,cohere/command-r7b-12-2024"
    )

    # OmniRoute (free, keyless) — local OpenAI-compatible gateway
    # (github.com/diegosouzapw/OmniRoute). Zero-config free models, smart
    # routing via the "auto" model. The API key is a dummy accepted by the
    # gateway; free/keyless models need no real credentials. Used both as an
    # explicit chat mode and as an automatic fallback when the primary
    # provider's key/token is exhausted.
    omniroute_enabled: bool = False
    omniroute_base_url: str = "http://localhost:20128/v1"
    omniroute_api_key: str = "omniroute"
    omniroute_chat_model: str = "auto"
    # Free models served by the local free gateway (/v1/chat/completions) and
    # shown in the free-mode picker. Accepts both a comma-separated string and
    # a JSON-array string, so the desktop launcher scripts can pass a tidy list
    # like `["auto", "big-pickle", ...]`.
    omniroute_chat_models: str = (
        "auto,auto/best-free,big-pickle,deepseek-v4-flash-free,mimo-v2.5-free,"
        "nemotron-3-ultra-free,laguna-s-2.1-free,"
        "nvidia/nemotron-3-nano-30b-a3b,nvidia/nemotron-3-super-120b-a12b,"
        "nvidia/nemotron-3-ultra-550b-a55b,"
        "deepseek/deepseek-v4-flash:free,nvidia/nemotron-3-ultra-550b-a55b:free,"
        "google/gemini-2.0-flash-lite:free,meta-llama/llama-4-scout-17b-16e:free,"
        "mistralai/mistral-small-3.2:free"
    )

    @field_validator("omniroute_chat_models", mode="before")
    @classmethod
    def _coerce_chat_models_list(cls, value: object) -> object:
        """Accept a JSON-array string (`["auto", ...]`) as well as CSV."""
        if isinstance(value, str):
            stripped = value.strip()
            if stripped.startswith("["):
                try:
                    parsed = json.loads(stripped)
                except json.JSONDecodeError:
                    parsed = None
                if isinstance(parsed, list):
                    return ",".join(str(item).strip() for item in parsed if str(item).strip())
        return value

    # OpenCode Zen (opencode.ai) — OpenAI-compatible endpoint serving the
    # recommended coding-agent models plus a set of free models.
    # OPENCODE_API_KEY is the server-level default; users can also bring their
    # own key.
    opencode_api_key: str = ""
    opencode_base_url: str = "https://opencode.ai/zen/v1"
    opencode_chat_model: str = "gemini-3.5-flash-lite"
    opencode_chat_models: str = (
        "gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna,gpt-5.5,gpt-5.5-pro,"
        "gpt-5.4,gpt-5.4-pro,gpt-5.4-mini,gpt-5.4-nano,"
        "gpt-5.3-codex,gpt-5.3-codex-spark,gpt-5.2,gpt-5.2-codex,"
        "gpt-5.1,gpt-5.1-codex,gpt-5.1-codex-max,gpt-5.1-codex-mini,"
        "gpt-5,gpt-5-codex,gpt-5-nano,"
        "claude-fable-5,claude-opus-5,claude-opus-4-8,claude-opus-4-7,"
        "claude-opus-4-6,claude-opus-4-5,claude-sonnet-5,claude-sonnet-4-6,"
        "claude-sonnet-4-5,claude-sonnet-4,claude-haiku-4-5,"
        "gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,"
        "gemini-3.5-flash-lite,gemini-3.1-pro,gemini-3-flash,"
        "grok-4.6,grok-4.5,grok-build-0.1,muse-spark-1.2,"
        "qwen3.7-max,qwen3.7-plus,qwen3.6-plus,qwen3.5-plus,"
        "deepseek-v4-pro,deepseek-v4-flash,"
        "minimax-m3,minimax-m2.7,minimax-m2.5,glm-5.2,glm-5.1,glm-5,"
        "kimi-k2.7-code,kimi-k3,kimi-k2.6,kimi-k2.5,"
        "big-pickle,mimo-v2.5-free,hy3-free,ling-3.0-flash-fin-free,"
        "nemotron-3-ultra-free,nemotron-3.5-lightning-free,"
        "laguna-s-2.1-free,deepseek-v4-flash-free,"
        "muse-spark-1.2-contributor-free"
    )

    # Hugging Face (cloud) — OpenAI-compatible router for HF LLMs at
    # router.huggingface.co ("serverless Inference" for chat tasks). The token
    # is the user's HUGGING_FACE_TOKEN (Secret Manager / env). The same token
    # also authorizes the per-model Inference API for video/voice/image
    # generation (see the hugging_face agent sub-context).
    huggingface_api_key: str = ""
    huggingface_base_url: str = "https://router.huggingface.co/v1"
    huggingface_chat_model: str = "Qwen/Qwen2.5-72B-Instruct"
    huggingface_chat_models: str = (
        "Qwen/Qwen2.5-72B-Instruct,Qwen/Qwen3-30B-A3B-Instruct-2507,Qwen/Qwen3-4B,"
        "Qwen/Qwen2.5-Coder-32B-Instruct,meta-llama/Llama-3.3-70B-Instruct,"
        "meta-llama/Llama-3.1-8B-Instruct,"
        "mistralai/Mistral-Small-3.2-24B-Instruct-2509,"
        "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B,deepseek-ai/DeepSeek-V3,"
        "HuggingFaceTB/SmolLM2-1.7B-Instruct,google/gemma-3-27b-it"
    )

    # NVIDIA NIM (cloud) — OpenAI-compatible chat/embeddings at
    # integrate.api.nvidia.com and a dedicated retrieval rerank endpoint.
    nvidia_api_key: str = ""
    nvidia_base_url: str = "https://integrate.api.nvidia.com/v1"
    nvidia_rerank_base_url: str = (
        "https://ai.api.nvidia.com/v1/retrieval/nvidia/llama-nemotron-rerank-1b-v2"
    )
    nvidia_chat_model: str = "nvidia/nemotron-3-nano-30b-a3b"
    nvidia_chat_models: str = (
        "nvidia/nemotron-3-nano-30b-a3b,nvidia/nemotron-3-super-120b-a12b,"
        "nvidia/nemotron-3-ultra-550b-a55b,nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"
    )

    # Embedding provider: "openrouter" (cloud, default), "nvidia" (cloud) or
    # "ollama" (local). The embedding model is server-global — the pgvector
    # column is fixed-dim, so changing model/dims requires reindexing chunks.
    embed_provider: str = "openrouter"
    openrouter_embed_model: str = "nvidia/nemotron-3-embed-1b:free"
    openrouter_embed_dims: int = 2048
    nvidia_embed_model: str = "nvidia/nemotron-3-embed-1b"
    nvidia_embed_dims: int = 2048

    # Rerank layer: cloud provider is "openrouter" or "nvidia"; local fallback
    # is the torch-based cross-encoder (needs the 'rerank' extra).
    openrouter_rerank_enabled: bool = True
    openrouter_rerank_model: str = "nvidia/llama-nemotron-rerank-vl-1b-v2:free"
    nvidia_rerank_enabled: bool = False
    nvidia_rerank_model: str = "nvidia/llama-nemotron-rerank-1b-v2"

    # Optional override for the model catalog file (see config/model_catalog.json)
    model_catalog_path: str = ""

    hyde_enabled: bool = True
    multi_query_enabled: bool = True
    rerank_enabled: bool = False
    rerank_model: str = "cross-encoder/ms-marco-MiniLM-L-6-v2"
    cache_enabled: bool = True
    query_cache_ttl: int = 300
    embedding_cache_ttl: int = 86400
    retrieval_cache_ttl: int = 300
    hallucination_check_enabled: bool = False

    # RAG retrieval depth. Each mode is a named preset of the knobs below;
    # "fast" skips query rewriting, HyDE and the reranker for lowest latency.
    rag_mode: str = "balanced"
    top_k: int = 20
    rerank_top_n: int = 5
    context_token_budget: int = 6000
    llm_temperature: float = 0.2
    llm_max_tokens: int = 1024
    rrf_k: int = 60
    # Simple queries (≤ this many words, no question/domain markers) skip
    # multi-query + HyDE rewriting to cut embedding/LLM calls and latency.
    simple_query_max_words: int = 4

    # ── Agentic query routing ───────────────────────────────────────────────
    # Every chat message is classified by the LLM before retrieval so general
    # questions skip RAG, personal questions hit conversation memory, and only
    # document questions run vector retrieval. When disabled, the pipeline
    # behaves like a plain RAG chatbot (knowledge retrieval for everything).
    router_enabled: bool = True
    router_cache_ttl: int = 300

    # ── Super memory ────────────────────────────────────────────────────────
    # Embeds each user/assistant message into pgvector (conversation memory)
    # and extracts durable facts (preferences/projects) into a user profile.
    memory_enabled: bool = True
    memory_top_k: int = 5
    memory_min_score: float = 0.12
    memory_extract_enabled: bool = True
    memory_extract_min_importance: float = 0.5

    # Direct-response fast path (spec: LLM #1). General/simple questions skip
    # document + memory retrieval entirely and are answered from working memory
    # (the recent turns) — ~zero DB work, much lower latency and tokens.
    memory_direct_path_enabled: bool = True

    # Weighted memory ranker (spec: Memory Ranker). After the cheap semantic
    # filter, hits are re-ranked with
    #   score = semantic*w_s + recency*w_r + frequency*w_f + context*w_c
    #         + importance*w_i
    # importance is part of the blend so high-value durable facts (manager,
    # contacts, identity) are never outranked by loose-matching trivia.
    # recency decays exponentially with this half-life (hours) from the LAST
    # time the memory was used (a human-like forgetting curve: each recall
    # resets the freshness clock).
    memory_rank_enabled: bool = True
    memory_weight_semantic: float = 0.3
    memory_weight_recency: float = 0.2
    memory_weight_frequency: float = 0.15
    memory_weight_context: float = 0.1
    memory_weight_importance: float = 0.25
    memory_recency_half_life_hours: float = 72.0

    # Critical-facts floor (spec: Memory Ranker, guaranteed recall). Whenever
    # memory is consulted, the user's facts with importance >= this value are
    # always retrieved (up to `memory_critical_top_k`), even when the current
    # query only loosely matches them. This keeps identity/relationship facts
    # (manager, company, contacts, family) available across new conversations.
    memory_critical_importance: float = 0.8
    memory_critical_top_k: int = 3

    # ── Personalization planner ─────────────────────────────────────────────
    # Runs BEFORE generation: decides whether a request depends on the user's
    # circumstances, which context fields it needs, and what is known/missing.
    # The final LLM gets a compact snapshot so it personalises by default and
    # only asks for the minimum genuinely missing information.
    personalization_enabled: bool = True
    personalization_cache_ttl: int = 300
    personalization_max_context: int = 6
    # A field is "reliably known" only when a retrieved memory scores at least
    # this high; below it the snapshot marks the field LOW_CONFIDENCE so the
    # LLM treats the value as a hint, not a fact.
    personalization_known_min_score: float = 0.5
    # How many semantic facts to pull per required-context field.
    personalization_field_top_k: int = 3

    # Write pipeline (spec: Deduplicator + Resolver). Before a new fact is
    # stored its embedding is compared against the user's existing memories;
    # cosine similarity >= ignore → skip (refresh recency), >= merge → update
    # the existing record (keep highest importance), below merge → store new.
    memory_dedupe_ignore: float = 0.9
    memory_dedupe_merge: float = 0.72

    # Consolider (spec: Memory Scorer + Consolider). Facts get a TTL tier from
    # their importance; expired rows are purged by the startup consolidation.
    # Human-like forgetting is layered on top:
    #  - memory_reconsolidation_boost: each recall strengthens a fact's
    #    importance by this much (capped at 1.0) — the more a memory is used,
    #    the more durable it becomes (spaced-repetition effect).
    #  - memory_decay_grace_days / memory_decay_daily: below-critical facts
    #    start losing importance after this many days without recall, at this
    #    rate per day. Critical facts (importance >= memory_critical_importance)
    #    are protected — they are the user's identity/relationships.
    #  - memory_forget_floor: facts that decay below this are forgotten
    #    (deleted). The consolidation also merges near-duplicate facts (same
    #    concept restated) into a single canonical memory.
    memory_consolidate_enabled: bool = True
    memory_episodic_retention_days: int = 180
    memory_reconsolidation_boost: float = 0.01
    memory_decay_grace_days: float = 30.0
    memory_decay_daily: float = 0.002
    memory_forget_floor: float = 0.2

    # ── Relationship memory / Graph DB (Neo4j) ─────────────────────────────
    # The memory agent also stores memories as nodes in a Neo4j graph and links
    # them with typed edges (RELATED_TO, WORKS_WITH, PREFERS, ...). Retrieval
    # can then walk the graph around the semantic hits to surface *connected*
    # memories the query never literally mentions (human association memory).
    # When neo4j_enabled is off the graph layer is skipped entirely — the
    # pgvector memory still works exactly as before.
    neo4j_enabled: bool = False
    neo4j_uri: str = "bolt://localhost:7687"
    neo4j_user: str = "neo4j"
    neo4j_password: str = "neo4j_password"
    # Entity → memory matching: an extracted relationship (subject/object) is
    # linked to an existing memory whose embedding is at least this similar.
    memory_graph_enabled: bool = True
    memory_graph_match_threshold: float = 0.66
    memory_graph_context_depth: int = 1
    memory_graph_context_top_k: int = 6
    memory_relationship_embed_threshold: float = 0.66
    # Neo4j traversal safety: a hostile/deep graph must never burn the query
    # budget. depth is clamped to max_depth and every Cypher run is bounded by
    # max_nodes + query_timeout_s (enforced via asyncio around the result).
    memory_graph_max_depth: int = 3
    memory_graph_max_nodes: int = 50
    memory_graph_query_timeout_s: float = 2.0

    # ── Transactional outbox (cross-store consistency) ──────────────────────
    # Every durable memory write is appended to the Postgres `memory_outbox`
    # table in the same transaction; a relay worker replays those events into
    # the Neo4j graph (and any other downstream store) with retry + backoff,
    # then a dead-letter queue. Postgres stays the source of truth and the
    # graph is eventually consistent without inline coupling.
    memory_outbox_enabled: bool = True
    memory_outbox_batch_size: int = 50
    memory_outbox_poll_interval_s: float = 1.0
    memory_outbox_claim_seconds: int = 60
    memory_outbox_max_attempts: int = 5
    memory_outbox_backoff_base_s: float = 1.0
    memory_outbox_backoff_max_s: float = 300.0

    # ── Scheduler (scheduled intents) ───────────────────────────────────────
    # A background poll loop claims due intents with FOR UPDATE SKIP LOCKED so
    # many scheduler workers never double-dispatch the same intent. Fairness:
    # at most `scheduler_max_per_user_per_cycle` intents are dispatched per
    # user each cycle, and the background observer queue is rate-limited per
    # user per minute so one hot user cannot flood the workers.
    scheduler_enabled: bool = True
    scheduler_poll_interval_s: float = 2.0
    scheduler_claim_batch: int = 100
    scheduler_claim_seconds: int = 120
    scheduler_max_per_user_per_cycle: int = 10
    scheduler_background_max_per_user_per_minute: int = 60
    # Missed-intent policy (replaces the old fixed 24h expiry):
    #   dispatch_late — dispatch when missed by <= missed_dispatch_max_hours,
    #                   otherwise expire the ancient intent.
    #   expire        — any missed intent is expired immediately.
    #   reschedule    — push the trigger forward one interval and try again.
    #   alert         — mark failed and surface on the DLQ/metrics.
    scheduler_missed_policy: str = "dispatch_late"
    scheduler_missed_dispatch_max_hours: int = 24
    # Scheduler-side retry/DLQ: enqueue failures back off and escalate to the
    # intent DLQ after `scheduler_max_attempts`, instead of hot-looping.
    scheduler_max_attempts: int = 5
    scheduler_backoff_base_s: float = 1.0
    scheduler_backoff_max_s: float = 300.0

    # ── Context router budgets (online plane cost control) ──────────────────
    # The router only calls the providers a query actually needs, and the
    # ContextSnapshot is truncated per-section and globally so one rich user
    # cannot blow the LLM context window. Tokens are estimated at len/4.
    context_router_enabled: bool = True
    context_max_tokens: int = 4500
    context_budget_recent: int = 1000
    context_budget_facts: int = 1500
    context_budget_graph: int = 800
    context_budget_tasks: int = 500
    context_budget_prospective: int = 400
    context_budget_personality: int = 300
    context_budget_live: int = 300
    context_compression_enabled: bool = True

    # ── Memory lifecycle (candidate → confirmed → stable → stale → archived) ─
    # New facts start as `candidate`; every re-statement/recall bumps the
    # evidence count until `memory_confirm_accesses` → `confirmed`, then
    # `memory_stable_accesses` accesses at `memory_stable_min_importance` →
    # `stable`. Unused confirmed facts age to `stale` after `memory_stale_days`,
    # and `archived` is the manual/soft-delete terminal state. The confidence
    # column rises with evidence (capped) so durable knowledge is distinct from
    # one-off observations.
    memory_lifecycle_enabled: bool = True
    memory_confirm_accesses: int = 2
    memory_stable_accesses: int = 4
    memory_stable_min_importance: float = 0.6
    memory_stale_days: int = 45
    memory_evidence_boost: float = 0.02
    memory_confidence_floor: float = 0.5

    # ── Context reconstruction / reference resolution ───────────────────────
    # Generic conversational-context layer (spec: "Context Reconstruction Before
    # Memory Operations"). A message is NEVER interpreted in isolation for
    # memory reads or writes: a cheap heuristic gate (self-contained vs
    # context-dependent) decides whether the LLM reconstruction pass is needed,
    # so self-contained queries pay nothing. The reconstructed context (resolved
    # references, active entities/topic, decontextualized query) feeds both the
    # retrieval planner and the write-side extraction/reconciliation.
    memory_context_enabled: bool = True
    # Prompt A (context understanding) only runs when the gate flags the
    # message as context-dependent.
    memory_context_max_history: int = 8
    # Resolutions with confidence below this stay flagged as ambiguous.
    memory_context_min_confidence: float = 0.6
    # Reconstructed-context retrieval: resolved entities reused as query anchors.
    memory_context_retrieval_top_k: int = 3
    # Short-lived per-user conversation state (active entities/topic/references)
    # kept in Redis so context survives across requests without re-analysis.
    memory_context_state_enabled: bool = True
    memory_context_state_ttl_s: int = 7200

    # Reconciliation (spec: Prompt E). Candidate facts are compared against the
    # user's existing memories before being stored; duplicates are skipped,
    # updates/corrections merge into the existing record, supersessions archive
    # the old fact, contradictions keep both sides. Only facts at or above this
    # importance trigger the (LLM) reconciliation pass — trivia never pays it.
    memory_reconcile_enabled: bool = True
    memory_reconcile_min_importance: float = 0.6
    memory_reconcile_top_k: int = 4

    # ── Observability (scheduler metrics, tracing, queue/memory growth) ─────
    # A lightweight in-process metrics registry (no external deps) sampled on a
    # loop: scheduler cycles/dispatches/expiries, queue lag (Redis LLEN), and
    # memory growth (Postgres row counts). When tracing is enabled the same
    # hooks emit OpenTelemetry-style spans through an injectable tracer.
    monitor_enabled: bool = True
    monitor_poll_interval_s: float = 30.0
    monitor_tracing_enabled: bool = False
    monitor_queue_max_lag: int = 1000
    monitor_memory_max_rows: int = 1000000

    # ── Live web context (optional) ─────────────────────────────────────────
    # Multi-provider live search: queries all providers that have a key (user's
    # own saved key wins over the server defaults below) and merges the hits.
    # Free DuckDuckGo (no key) acts as the fallback. Results are cached for
    # `web_search_cache_ttl` seconds so repeat queries don't burn provider quota
    # (Tavily's free tier is ~1k searches/month — keep search depth "basic").
    web_search_enabled: bool = False
    web_search_top_k: int = 5
    web_search_cache_ttl: int = 21600
    web_search_providers: str = "tavily,google,brave,bing,duckduckgo"
    # When true (default) web search additionally requires the per-user opt-in
    # flag set from Settings → Web search. Set false so the server-enabled
    # feature applies to every authenticated user.
    web_search_require_optin: bool = True
    # Server defaults for the keyed providers (user keys always win).
    tavily_api_key: str = ""
    tavily_search_depth: str = "basic"
    google_search_api_key: str = ""
    google_search_cx: str = ""
    brave_api_key: str = ""
    bing_api_key: str = ""

    @property
    def openrouter_embed_input_type(self) -> str | None:
        """Some NVIDIA embedding models need a query/passage hint per call."""
        model = self.openrouter_embed_model.lower()
        return "query" if "nemotron" in model else None

    @property
    def nvidia_embed_input_type(self) -> str | None:
        model = self.nvidia_embed_model.lower()
        return "query" if "nemotron" in model else None

    @property
    def model_catalog(self) -> dict[str, Any]:
        return load_model_catalog(self.model_catalog_path)

    def chat_models_list(self, value: str) -> list[str]:
        """Split a ``*_chat_models`` config string into a clean, de-duped list."""
        seen: list[str] = []
        for item in value.split(","):
            model_id = item.strip()
            if model_id and model_id not in seen:
                seen.append(model_id)
        return seen

    @property
    def free_chat_models(self) -> list[str]:
        """Free models served by the built-in gateway (the free-mode picker)."""
        return self.chat_models_list(self.omniroute_chat_models)

    def rag_mode_params(self, mode: str) -> dict[str, Any]:
        """Resolve per-mode retrieval tuning for `fast | balanced | deep`.

        Latency/quality trade-off ladder:
        - fast:     1 embedding call, no rewriting, no rerank, small topK.
        - balanced: no HyDE (keeps one extra LLM call out of the hot path),
                    rerank on, medium topK. This is the default.
        - deep:     multi-query + HyDE + rerank, largest topK.
        """
        mode = (mode or self.rag_mode).lower().strip()
        table = {
            "fast": {
                "multi_query": False,
                "hyde": False,
                "rerank": False,
                "top_k": 8,
                "rerank_top_n": 0,
                "context_budget": 4000,
            },
            "balanced": {
                "multi_query": self.multi_query_enabled,
                "hyde": False,
                "rerank": self.openrouter_rerank_enabled or self.nvidia_rerank_enabled or self.rerank_enabled,
                "top_k": self.top_k,
                "rerank_top_n": self.rerank_top_n,
                "context_budget": self.context_token_budget,
            },
            "deep": {
                "multi_query": True,
                "hyde": True,
                "rerank": self.openrouter_rerank_enabled or self.nvidia_rerank_enabled or self.rerank_enabled,
                "top_k": max(self.top_k, 20),
                "rerank_top_n": max(self.rerank_top_n, 5),
                "context_budget": self.context_token_budget,
            },
        }
        return table.get(mode, table["balanced"])

    @property
    def postgres_dsn(self) -> str:
        return (
            f"postgresql://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
