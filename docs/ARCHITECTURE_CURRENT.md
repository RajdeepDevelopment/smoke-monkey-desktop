# Smoke Monkey — Current Architecture (Phase 0 audit)

Status: frozen baseline for the desktop migration. Generated from source inspection;
this is the "as-is" contract that must keep working while storage is abstracted.

## 1. Topology

Docker Compose project `smoke-monkey` (`docker-compose.yml`, 11 services) on a single
default network. One shared env anchor `x-app-env` (lines 3–139, ~130 vars) is injected
into the 4 app services. No restart policies, no `container_name`.

| Service | Image / build | Host port | Purpose |
|---------|---------------|-----------|---------|
| postgres | `pgvector/pgvector:pg16`, init `infrastructure/docker/postgres/init` (pgvector ext) | 5432 | relational + vector store |
| redis | `redis:7-alpine --appendonly yes` | 6379 | caches, user keys, telemetry |
| nats | `nats:2.10-alpine -js` | 4222, 8222 | JetStream job/event bus |
| minio | `minio/minio:latest` | 9000, 9001 | S3 document object store (`documents` bucket) |
| minio-init | `minio/mc:latest` | — | bucket provisioning |
| neo4j | `neo4j:5.26` | 7687, 7474 | memory knowledge graph |
| ollama | `ollama/ollama:latest` | 11434 | local LLM + embeddings |
| rag-service | `apps/rag-service/Dockerfile` | 8000 | RAG + memory engine (FastAPI) |
| document-worker | `apps/document-worker/Dockerfile` | — | NATS consumer, PDF → chunks |
| api-gateway | root `/ apps/api-gateway/Dockerfile` | 3000 | NestJS REST + SSE proxy |
| web | `apps/web/Dockerfile` | 3001 → 3000 | Next.js UI |

Deployment env overrides (`x-app-env`): `OLLAMA_BASE_URL=http://ollama:11434`,
`NEO4J_URI=bolt://neo4j:7687`, `NATS_URL=nats://nats:4222`,
`OMNIROUTE_BASE_URL=http://host.docker.internal:20128/v1`.

## 2. Services

### 2.1 rag-service (FastAPI, Python 3.14, port 8000)
- Config: pydantic-settings `Settings`, `env_file=".env"`, case-insensitive uppercase
  mapping, singleton `settings = get_settings()` lru_cache (`src/config.py:532-537`).
- Entry: `src/main.py` — lifespan wires a long-lived `AppContext` (asyncpg pool, Redis,
  Ollama/native embedder, MemoryStore, graph store, router, MemoryAgent, background
  tasks: memory consolidation, memory outbox relay, prospective-memory scheduler,
  memory metrics sampler). Feature flags gate each background task. `feedback` table
  created inline (`main.py:123`).
- API (`src/api/routes.py`):
  - `POST /api/v1/chat/stream` — SSE chat (also `prompt`, `title`; OmniRoute passthrough).
  - `GET /api/v1/chat/history`, `GET /api/v1/memory/...` (facts, recall, relationships,
    prospective, metrics summary), memory mutation/admin endpoints.
- Pipeline (`src/application/pipeline.py`):
  - Router (`src/application/router.py`) classifies query into `simple`/`focused`/`complex`
    (`RouterMode`), falls back on failure; Redis plan cache `router_cache_ttl`.
  - Retrieval: optional Hyde + multi-query expansion, dense `retrieval/dense.py`,
    optional rerank (`rerank_enabled`, hybrid RRF `rrf_k`), hybrid/dense mode by `rag_mode`.
  - Concurrent doc + memory retrieval share a single query vector
    (`_retrieve(base_query_vector=…)`, `_memory_pipeline`).
  - Caches: `rag:embed:v1` (embedding_cache_ttl), query/retrieval cache.
  - Streaming: `llm.chat_stream` yields per-delta, wrapped in `EventSourceResponse`;
    validated `sse_starlette 3.4.8` streams each event incrementally.
- Memory engine (`src/application/memory.py` + `mem/`): see §4.

### 2.2 api-gateway (NestJS, port 3000)
- `app.module.ts`: global `ConfigModule`, `ThrottlerModule` (60s/120), global
  `ThrottlerGuard`, TypeORM (see config below), modules: users, auth, documents,
  conversations, chat, health, models, keys, playground, analytics, settings.
- TypeORM (`config/typeorm.config.ts`): postgres, `SnakeNamingStrategy` (camelCase →
  snake_case so Python services share tables), **`synchronize: true`**.
- Redis via `common/services/redis.service.ts` (REDIS_HOST/PORT/PASSWORD).
- Routes (`@Controller` prefix): `auth` (register/login/logout/me, JWT cookie 7d,
  `JWT_SECRET` fallback `change-me-in-production`), `chat/stream` (SSE proxy),
  `conversations` (list/create/:id/messages/delete), `documents` (upload/list/get/delete),
  `keys` (get/put/:provider/delete/:provider/:provider/test), `models` (+openrouter,
  +omniroute), `playground/retrieve`, `analytics/metrics`, `settings` (+web-search,
  +omniroute), `health`.
- `chat.service.ts`: forwards to rag-service SSE; reads response body with `undici`
  reader, streams each event via `res.write`, client-abort safe.
- API keys: `user_api_keys` table, AES-256-GCM encrypted at rest
  (`api-key-crypto.service.ts`, `API_KEY_ENCRYPTION_SECRET`), plaintext cached in Redis
  `rag:user_key:{userId}:{provider}` TTL 86400; live validation per provider
  (OpenRouter/NVIDIA/OpenAI/xAI/Gemini/OpenCode; web-search providers validated lazily).
- Port 3000; CORS origins default `http://localhost:3001`.

### 2.3 web (Next.js, dev on 3001, container 3001→3000)
- `NEXT_PUBLIC_API_URL=http://localhost:3000`. Pages: `/`, `/chat`, `/dashboard`,
  `/documents`, `/models`, `/playground`, `/analytics`, `/settings`, `/login`,
  `/register`. Key components: `ChatPanel`, `MessageBubble`, `DocumentUpload`,
  `Sidebar`, `AuthProvider`.
- Chat streaming (`components/ChatPanel.tsx`): throttle flush `STREAM_THROTTLE_MS=40`
  plus periodic `setInterval(flushStream, 50)` while `streaming` (fix for stalling).

### 2.4 document-worker (NATS consumer, no port)
- `main.py`: connects NATS JetStream (durable `document-worker`, `ack_wait=180`,
  `max_deliver=5`), ensures stream `documents.>` (file storage, 7d TTL), ensures MinIO
  bucket + vector store schema. Ingest: download from MinIO → `parse_pdf` (OCR opt-in)
  → chunk hierarchy (`chunking/hierarchy.py`, recursive splitter, chunk_size/overlap)
  → embed (provider by `embed_provider`: openrouter/nvidia/ollama) → replace chunks →
  status `ready` → publish `documents.ingested`. Failures → `failed` + `nak`/`term`,
  error truncated 500 chars.

## 3. Databases

### 3.1 Postgres (pgvector) — shared by Python + TypeORM (snake_case)
- **api-gateway entities** (TypeORM, `synchronize`): `users` (id uuid PK, email unique,
  name, passwordHash select:false, createdAt), `conversations` (userId idx, title,
  createdAt), `messages` (conversationId idx, role user|assistant|system, content,
  citations jsonb, webSources jsonb, confidence float, createdAt), `documents`
  (userId, filename, s3Key, status uploading|processing|ready|failed, chunkCount,
  error, metadata jsonb, timestamps), `user_api_keys` (userId, provider len 32,
  encryptedKey select:false, keyPrefix len 16, last4 len 4, unique(userId, provider)).
- **rag-service tables** (raw SQL): `conversation_memory` (id uuid PK, user_id uuid,
  conversation_id, role, content, content_hash, embedding vector(dims), access_count,
  last_accessed_at, expires_at, created_at, UNIQUE(user_id, content_hash)) — HNSW
  `vector_cosine_ops` index; `memories` (id, user_id, type, content, embedding
  vector(dims), importance float default 0.5, source_message, access_count,
  last_accessed_at, expires_at, stage, confidence, evidence_count) — HNSW index;
  `memory_outbox` + `memory_outbox_dlq` (id, event_type, user_id, aggregate_id,
  payload jsonb, idempotency_key unique, status pending, attempt_count, claimed_at,
  next_attempt_at, created_at); `prospective_memories`, `scheduled_intents`,
  `intent_executions`, `intent_dlq` (timezone-aware scheduling, default
  Asia/Kolkata); `feedback` (main.py:123).
- **document-worker**: `chunks` (id uuid PK, document_id, parent_chunk_id, content,
  content_tsv tsvector, section, page_number, token_count, embedding vector(embed_dims),
  metadata jsonb) + `idx_chunks_document`, `idx_chunks_parent`,
  `idx_chunks_hnsw` (HNSW cosine; skipped if dims > 2000).
- HNSW index note: embedding dims are provider-dependent (768 ollama nomic,
  2048 openrouter/nvidia nemotron).

### 3.2 Neo4j — knowledge graph (memory only)
`mem/graph.py` `GraphMemoryStore`: Memory nodes keyed by the same UUID as the pgvector
row, `HAS_MEMORY` edges. Typed edges: RELATED_TO, WORKS_AT, WORKS_WITH, WORKS_FOR,
REPORTS_TO, MANAGES, MENTORS, COLLABORATES_WITH, PREFERS, OWNS, USES, PART_OF,
SIMILAR_TO, DEPENDS_ON, CAUSES, CONTRIBUTES_TO, KNOWS, TEACHES, LEADS, FAMILY_OF,
FRIEND_OF. Guardrails: depth clamp `memory_graph_max_depth` (3), node/top-k bounds,
`asyncio.wait_for` (2s), defensive no-op when Neo4j unreachable; injectable driver
for tests.

### 3.3 Redis keys
`rag:user_key:{userId}:{provider}` (plaintext, 86400 TTL), `rag:telemetry:v1`
(list), `rag:embed:v1:*` (embedding cache), router plan cache, query/retrieval cache,
web-search cache + `rag:user_setting:web_search`, omniroute setting, personalization
profile cache, conversation-state snapshot (`memory_context_state_ttl_s`).

## 4. Memory pipeline

1. **Extract** (`memory.py:_extract_and_store`, `mem/classifier.py`): classify exchange;
   extract facts via LLM with retry; importance score; emit into
   `memory_outbox` (idempotency keys) → `OutboxRelay` writes pgvector + Neo4j
   (graph upserts, relationship links).
2. **Retrieve**: `search_conversation`/`search_facts`/`search_critical_facts` via
   `_MEMORY_QUERY`/`_FACTS_QUERY` (`ORDER BY 1 - (embedding <=> $1::vector)` + LIMIT),
   `_DEDUPE_QUERY`/`_FACT_UPDATE` for merge/boost; `recall_facts`,
   `recall_preferences`; graph context via `mem/graph.py`.
3. **Rank/context** (`mem/context.py`): `ContextRouter` + `AsyncParallelContextProvider`
   assemble budgeted sections (recent/facts/graph/tasks/prospective/personality/live),
   `ContextCompressor`; `ProviderPriority` fallback.
4. **Personalization** (`mem/personalization.py`): profile extraction, Redis-cached,
   injected as system-rule 1b.
5. **Consolidation** (`mem/observation_store.py` `MemoryConsolidator`, `memory.py`
   `consolidate`): dedupe/merge (`memory_dedupe_ignore/merge`), stage lifecycle
   (transient→stable→archived), access/evidence boost, decay/forget, reconcile.
6. **Prospective** (`mem/prospective.py`): scheduled intents dispatched by background
   scheduler (missed-policy `dispatch_late`).
7. **Live signals** (`mem/live_extractor.py`): in-conversation observations → Redis
   state snapshot.
8. **Monitoring** (`mem/monitoring.py`): `MemoryMetrics`, tracing, metrics sampler.

Pgvector query templates live in `memory.py` (`_MEMORY_QUERY` etc., ~lines 54–131)
and `retrieval/dense.py` `QUERY` (chunks JOIN documents, `d.status='ready'`, optional
user/document filters, `ORDER BY c.embedding <=> $1::vector LIMIT $3`).

## 5. Config essentials (rag-service defaults)

Postgres localhost/5432/rag/rag_secret/ragdb; Redis localhost/6379 no pw;
`ollama_base_url http://localhost:11434`, `ollama_chat_model qwen3:8b`,
`ollama_embed_model nomic-embed-text`, `ollama_embed_dims 768`; `llm_provider` default
`ollama` (comment: ollama|openrouter|gemini); chat models: gemini-3.5-flash,
gpt-chat-latest, grok-4.6, nvidia/nemotron-3-nano-30b-a3b, opencode deepseek-v4-flash-free,
OmniRoute `auto` (`omniroute_enabled=False`). `embed_provider` default `openrouter`
(dims 2048; nvidia 2048). Rerank: openrouter rerank on, nvidia off; local rerank off.
RAG defaults: `rag_mode=balanced`, `top_k=20`, `rerank_top_n=5`, `context_token_budget=6000`,
`llm_temperature=0.2`, `llm_max_tokens=1024`, `rrf_k=60`, `hyde_enabled=True`,
`multi_query_enabled=True`. Memory feature flags (all True): memory, extract,
direct_path, rank (semantic .3/recency .2/frequency .15/context .1/importance .25,
half-life 72h), graph (threshold .66, depth 3), outbox, scheduler, consolidation,
lifecycle, context state, reconcile, personalization, monitor. Web search off by
default (`web_search_require_optin=True`). `memory_min_score=0.12`, `memory_top_k=5`.

## 6. Streaming path (chat)

web `ChatPanel` → `POST /api/v1/chat/stream` (api-gateway) → rag-service
`/api/v1/chat/stream` → pipeline → `llm.chat_stream` (per-delta `EventSourceResponse`)
→ gateway undici reader → `res.write` per event → web SSE parse → throttled flush (40ms)
+ 50ms periodic flush.

## 7. Tests / verification

- rag-service: `apps/rag-service/.venv/bin/python -m pytest tests/ -q` = **108 passing**;
  suites: memory, retrieval, router, super-memory, scale-hardening, context/reconstruction.
- `ruff check src/` clean. mypy is broken in the venv (bad interpreter path) — do not rely on it.
- Streaming verified empirically with a local uvicorn probe (`sse_starlette 3.4.8`).

## 8. Migration constraints (from plan)

- Preserve web/server behavior exactly; this document is the equivalence-test baseline.
- Memory engine must depend on ports (GraphStore/VectorStore/DocumentStore/CacheStore),
  not directly on Neo4j/pgvector.
- Desktop edition: zero mandatory cloud DBs; bundled Node/Python; 127.0.0.1 only.

## 9. Storage abstraction (phases 1–3, done)

New package `apps/rag-service/src/storage/` (ports + adapters):

- `interfaces.py` — `typing.Protocol` ports: `VectorStore` (memory + document chunk
  search/lifecycle), `GraphStore` (memory graph), `DocumentStore` (object files),
  `CacheStore` (TTL cache + ordered lists). Result types reuse `src.domain`
  (`MemoryHit`, `MemoryFact`) plus `ChunkHit`.
- `postgres.py` — `PostgresVectorStore` implements `VectorStore`; owns ALL pgvector
  SQL (memory query templates moved here from `memory.py`, dense chunk query moved
  from `retrieval/dense.py`). Includes write ops (insert/upsert/merge/delete/touch/
  consolidate/merge-duplicates, chunk replace/status) faithful to the original SQL.
- `GraphMemoryStore` (mem/graph.py) now explicitly subclasses `GraphStore`.
- The relationship-type registry (`_REL_TYPES`, `sanitize_rel_type`,
  `RELATIONSHIP_TYPES`) lives in `interfaces.py`; `mem/graph.py` imports it
  (still re-exported for existing callers). Avoids a layering inversion: the
  GraphStore port no longer depends on a concrete store to validate types.
- `MemoryStore` (memory.py) keeps its transactional write orchestration (outbox
  atomicity) but its read path delegates to the injected `VectorStore` adapter
  (`vector_store` param; auto-built from `pool`). `retrieval/dense.py` and the
  document-worker keep their own callers unchanged for now (wired to the interface
  when local adapters land).

Behavior unchanged; 112 tests pass, ruff clean.

## 10. Storage abstraction — local graph adapter (phase 4, done)

`apps/rag-service/src/storage/local_graph.py` — `LocalGraphStore(GraphStore)`:
a SQLite-backed memory graph that runs without Neo4j, using only the standard
library (`sqlite3`, `asyncio.to_thread`), so the desktop build needs no graph DB.

- Schema: `graph_nodes` (mirrors Neo4j labels/properties: `type`, `content`,
  `importance`, `source`, `created_at`, `access_count`, `category`, `stage`,
  `confidence`, `evidence_count`) + `graph_edges`
  (`from_id`, `to_id`, `rel_type`, `user_id`, `confidence`, `properties JSON`),
  with indexes on node `user_id` and both edge endpoints.
- API mirrors `GraphMemoryStore`: `connect/close/enabled`, `upsert_user`,
  `upsert_memory` (via `Memory.to_graph_properties()` + a `HAS_MEMORY` edge),
  `delete_memory`, `link_related` (validates via `sanitize_rel_type`),
  `find_related_memories` (one-hop, bidirectional, excludes `user` nodes and
  `HAS_MEMORY` edges, `ORDER BY importance DESC`, capped by
  `memory_graph_max_nodes`/`top_k`, `asyncio.wait_for` timeout → `[]` on
  failure, same best-effort degradation as Neo4j), `find_related_by_content`
  (LIKE containment with `%`/`_` escaping, mirroring Cypher `CONTAINS`),
  `prune_stale_edges`, static `format_relationships`.
- Row dicts use the same keys as the Neo4j projection
  (`id, content, type, importance, rel_type, confidence`).
- Concurrency: single connection in autocommit mode (`isolation_level=None`),
  every public operation holds one `asyncio.Lock` for its whole body.
- `db_path` may be `:memory:` or a file path (persists across reopen).

Tests: `tests/test_local_graph.py` (12 cases) — protocol conformance, round-trip,
bidirectionality, self-seed exclusion, tenant isolation, content match, delete,
prune, formatting, persistence across reopen, disabled-store no-op, concurrent
writes. Total suite now 124 tests, ruff clean, `import src.main` OK.

## 11. Storage abstraction — local vector adapter (phase 5, done)

`apps/rag-service/src/storage/local_vector.py` — `LocalVectorStore(VectorStore)`:
a stdlib SQLite implementation of the full vector-store contract (no
PostgreSQL/pgvector, no external deps) for the desktop build.

- Tables mirror the pgvector schema: `conversation_memory`
  (`UNIQUE (user_id, content_hash)` for message dedupe), `memories`
  (durable facts incl. `stage`/`confidence`/`evidence_count`/`expires_at`),
  `documents`, `chunks` (parent/child rows with `section`, `page_number`,
  `token_count`, JSON `metadata`).
- Embeddings stored as JSON text; cosine similarity computed in Python
  (score = cosine, clamped ≥ 0), matching pgvector's `1 - (<=>)`.
  `LEAST`/`GREATEST` are registered as SQLite scalar functions so the ported
  SQL keeps its PostgreSQL expressions.
- Semantics match `PostgresVectorStore` row-for-row: expiry filtering, archived
  exclusion, `upsert_fact` dedupe ladder (`memory_dedupe_ignore` refresh →
  `memory_dedupe_merge` merge → insert), `_FACT_UPDATE` stage transitions
  (candidate→confirmed→stable, stale rebound), `consolidate`
  (expired purge → episodic retention → stale flag → importance decay →
  forget floor → events `{"id","user_id"}`), `merge_duplicates` (stronger-wins
  neighbor merge), chunk replace/status (status upserts the `documents` row for
  desktop self-containment).
- Concurrency identical to the local graph store: one autocommit connection
  (`isolation_level=None`, `check_same_thread=False`) guarded by an
  `asyncio.Lock` held for the whole body of each operation; internal
  `_fetch` (lock held) vs `_rows` (acquires lock) split avoids lock re-entry.
- `db_path` may be `:memory:` or a file path (persists across reopen).

Note (circular-import fix): `interfaces.py` now imports `Memory` under
`TYPE_CHECKING` only, because importing it at runtime pulled in
`src.application` → pipeline → memory agent → graph → back into the partially
initialized `interfaces`. With `from __future__ import annotations` the
Protocol annotations stay lazy, so nothing is lost.

Tests: `tests/test_local_vector.py` (21 cases) — protocol conformance, message
dedupe, recency ordering, fact lifecycle + dedupe merge, stage transitions,
critical/preferences/relationship queries, entity matching, tenant isolation,
touch decay/boost, delete, consolidation (expiry events), duplicate merging,
chunk round-trip + document status gating, disabled-store no-ops, concurrent
writes, persistence across reopen. Total suite now 145 tests, ruff clean,
`import src.main` OK.

## 12. Storage abstraction — local document & cache stores (phase 6, done)

`apps/rag-service/src/storage/local_document.py` — `LocalDocumentStore(DocumentStore)`:
filesystem-backed object storage replacing MinIO for the desktop build.

- Objects live under a configurable `root` directory; `upload`/`download`
  copy via `shutil` in worker threads, `delete` is best-effort (ignores missing,
  logs on error) exactly like the MinIO adapter.
- `ensure_bucket` creates the root directory.
- Keys are sanitized: `..` segments and absolute paths are rejected
  (`ValueError`), so object keys cannot escape the store root.

`apps/rag-service/src/storage/local_cache.py` — `LocalCacheStore(CacheStore)`:
SQLite-backed TTL cache replacing Redis for the desktop build.

- `cache_entries` (key → value, `expires_at` epoch) + `cache_lists`
  (`key`/`seq`/`value`) + a monotonic `cache_seq` counter.
- Mirrors the exact `redis.asyncio` semantics the app relies on: `get` lazily
  purges expired entries and returns `None`; `set` uses the `ex` convention
  (seconds, `None` = never, `0`/negative = immediately expired); `exists` and
  `delete` cover both key/value and list keys; `push_tail` prepends (like
  `lpush`), `range` returns newest-first (like `lrange`), `trim` keeps the
  `[start, end]` window (like `ltrim`) — negative indices resolved the Redis way.
- Same concurrency pattern as the other local adapters (autocommit connection,
  `asyncio.Lock` per operation, `:memory:` or file path).

Tests: `tests/test_local_document.py` (9) and `tests/test_local_cache.py` (16) —
protocol conformance, round-trips, TTL expiry/zero/None, exists/delete, list
push/range/trim with negative indices, disabled-store no-ops, path-traversal
rejection, persistence across reopen. Total suite now 170 tests, ruff clean,
`import src.main` OK.

## 13. Local memory mode — everything runs on-disk (phase 7, done)

Phase 7 wires the phase 3–6 adapters into the running services so the desktop
edition boots with **zero Postgres/Redis/MinIO**. Set `storage_mode="local"` in
both apps' configs; `local_data_dir` (default `./data`) is the shared data
root. All prior cloud behavior is preserved (the local branch only runs when
`storage_mode == "local"`).

### rag-service

- `src/storage/factory.py` — `build_local_stores(data_dir)` returns a
  `LocalStores` bundle wiring every port to its local adapter: vector+graph on
  one shared `memory.db` (WAL + `busy_timeout`, so the document-worker process
  writes chunks concurrently), `cache.db`, `files/`, and `RedisBridge`.
- `src/storage/redis_bridge.py` — `RedisBridge` + `_BridgePipeline`, a
  `redis.asyncio`-compatible facade over `LocalCacheStore`. Implements only the
  call surface the app uses (`get/set/ex/exists/delete/unlink/expire/incr/
  lpush/lrange/ltrim/llen/scan_iter/pipeline/ping/aclose`); anything else
  raises loudly. The pipeline executes commands eagerly (local ops are atomic)
  and supports both `async with` (telemetry) and bare `pipe.incr/expire`
  + `execute()` (prospective rate limiter).
- `src/storage/local_vector.py` — sparse (keyword) retrieval mirroring
  Postgres `tsvector`: a best-effort FTS5 virtual table over chunk content
  (`chunks_fts`), kept in sync by `replace_document_chunks` and queried with
  `bm25` ranking; falls back to a deterministic token-overlap scorer when the
  runtime SQLite lacks FTS5. `get_parents(parent_ids)` resolves parent chunks
  for RRF parent expansion. `connect()` now sets WAL + busy_timeout.
- `src/application/memory.py` — `MemoryStore` gains a `graph` parameter and a
  `local_mode` flag (`pool is None`): `ensure_schema` no-ops, message writes
  and fact extraction/merge delegate to the `VectorStore` port, `touch` and
  `consolidate` run the adapter's purge/decay/merge pass and mirror deletions
  into the graph.
- `src/application/pipeline.py` — `QueryPipeline` accepts a `vector_store` and
  branches `_retrieve` (dense vs sparse) and `_expand_parents` to it; a new
  `_chunk_hits_to_retrieved` maps `ChunkHit` rows back to `RetrievedChunk`.
- `src/main.py` — `lifespan` builds the local bundle when `storage_mode ==
  "local"` and skips asyncpg/Redis/outbox/prospective/scheduler/relay (the
  local stores own all persistence); teardown closes the stores. `/health`
  reports Postgres healthy when there is no pool.

### document-worker

- `src/storage/local_storage.py` — `LocalVectorStore` writes chunks into the
  **same** `memory.db` schema rag-service reads (documents/chunks/chunks_fts),
  plus `LocalFileStore`, a filesystem `MinioStorage` replacement with the same
  key-safety rules. `build_local_storage()` constructs both under
  `local_data_dir`.
- `src/main.py` — `process_job` and `run` branch on `storage_mode`: local mode
  writes chunks + PDFs locally instead of pgvector/MinIO. NATS transport is
  unchanged (queue replacement is a later phase).

Tests: `tests/test_redis_bridge.py` (9), `tests/test_local_sparse.py` (8),
`tests/test_memory_local.py` (6), `tests/test_factory.py` (5), and
`apps/document-worker/tests/test_local_storage.py` (5) — bridge surface +
pipeline semantics, FTS5/fallback sparse retrieval, parent expansion, local
memory write branches, shared-DB factory bundle, and the worker's chunk/file
stores. rag-service suite: **198 tests**, document-worker suite: **9 tests**,
both ruff clean.

## 14. Cloud-vs-local equivalence tests (phase 8, done)

Phase 8 locks the phase 3–7 swap into a contract: every local adapter must be
observably equivalent to the cloud service it replaces. The equivalence suites
run **the same scenario** against both implementations of each port and assert
identical behavior, so the desktop swap is invisible to the app.

### Approach

- One scenario per behavior, implemented once as `_scenario_*`, exposed as a
  pair of tests (one per implementation) rather than a parametrized fixture
  calling `getfixturevalue` — pytest-asyncio on Python 3.14 rejects nested
  async fixtures, and explicit pairs let the local variant run even when the
  cloud service is down.
- **Graceful skip**: each cloud variant is gated by a *sync* TCP socket probe
  (`_probe_sync`, module-scoped) that decides skip/reach in ~2s and never
  touches an asyncio loop. Connection fixtures are function-scoped, so each
  test creates its own pool/driver/client in its own event loop — no
  cross-loop reuse.
- Env overrides for every endpoint (`SMOKE_EQUIV_PG_*`, `SMOKE_EQUIV_NEO4J_*`,
  `SMOKE_EQUIV_REDIS_*`, `SMOKE_EQUIV_MINIO_*`) let the suites target any
  stack (and simulate outages).

### `apps/rag-service/tests/test_equivalence.py` (34 tests)

- **Vector (pgvector vs sqlite), 9 scenarios × 2**: message round-trip +
  tenant scoping, `ON CONFLICT` content-hash dedupe, fact upsert-merge of
  near-duplicates, orthogonal facts staying separate (and score-0 filtering),
  candidate→stable stage transitions, `consolidate` expiry, weak-copy
  collapsing via monkeypatched dedupe thresholds, chunk lifecycle
  (ready-gated search + `parent_chunk_id`), and `touch` access/importance
  bumps. Runs in a dedicated **`ragdb_test`** database (created on demand) so
  the 3-dim test vectors never collide with the app's 2048-dim schema.
- **Graph (neo4j vs sqlite), 4 scenarios × 2**: `find_related_by_content`,
  link + typed relationship traversal + formatting, idempotent delete, stale
  edge pruning.
- **Cache (redis vs sqlite), 4 scenarios × 2**: get/set/expire (incl. TTL-0),
  delete, list semantics (`lpush`/`lrange` newest-first + negative indices +
  `ltrim`), `incr`. `_RedisLike` normalizes the two call surfaces.

### `apps/document-worker/tests/test_equivalence.py` (6 tests)

- **Object store (MinIO vs `LocalFileStore`), 3 scenarios × 2**: upload →
  download byte round-trip, missing-key raises, best-effort delete. Uses the
  dedicated `equivalence-docs` bucket.

### Divergences fixed while bringing the suites green

- `GraphMemoryStore.format_relationships` was `async` while the interface and
  `LocalGraphStore` declared it sync — and `agent.py`/`context.py` `await`ed
  it, which would raise at runtime in local mode. Made it sync and dropped the
  `await`s (interface already said sync).
- `asyncpg.create_pool(connect_timeout=...)` is not a valid kwarg.
- Local `CacheStore.delete` returns `None` vs redis returning a count — the
  shared contract is effect-only (`exists()` is False after delete).

Suite totals with the stack up: rag-service **232 tests** (198 + 34
equivalence), document-worker **15 tests** (9 + 6 equivalence), both ruff
clean. With services unreachable the cloud scenarios skip and the local
variants still run (rag-service 17 passed / 17 skipped, document-worker 3
passed / 3 skipped).

## 15. Local ingest job queue (phase 10, done)

Phase 10 removes the remaining cloud transport from the desktop path. In
cloud, document ingestion flows api-gateway → NATS JetStream
(`documents.ingest`) → document-worker → MinIO/Postgres, with `documents.*`
events carrying status back to the gateway. The desktop replaces that with a
**shared SQLite job queue** plus the existing local stores, so no NATS,
Postgres or MinIO is involved.

### The queue

- File: `local_data_dir/jobs.db` (WAL + `busy_timeout=5000`, shared between
  the two processes just like `memory.db`).
- Table `ingest_jobs`: `job_id` PK, `document_id`, `user_id`, `filename`,
  `s3_key`, `status` (`pending`|`processing`|`done`|`failed`), `attempts`,
  `error`, `created_at`, `updated_at`, `claimed_at`; index on
  `(status, created_at)`.
- **Producer** (`rag-service/src/storage/local_jobs.py`): `submit`
  (idempotent on `job_id`), `pending_count`, `status_of`, `job_exists`.
- **Consumer** (`document-worker/src/storage/local_jobs.py`): `submit`,
  `next_batch` (atomic claim: `BEGIN IMMEDIATE` → UPDATE to `processing` with
  `attempts+1`/`claimed_at` → SELECT), `complete`, `fail`, `recover_stale`
  (requeues `processing` rows older than `claim_seconds` after a crash),
  `status_of`.

### Desktop upload path

- `POST /api/v1/documents/upload` (rag-service, **local mode only**; HTTP 501
  in cloud so the gateway stays the single upload path): validates
  PDF/10MB, writes the file via `LocalDocumentStore` under
  `files/users/{user_id}/{document_id}.pdf`, registers the row in
  `memory.db.documents` (`status='queued'`), and enqueues the ingest job.
- `GET /api/v1/documents`, `GET/DELETE /api/v1/documents/{id}` read/remove
  the same shared store (delete also clears chunks + FTS rows + the file).
- `document-worker/src/main.py` now has a transport-agnostic `_ingest`
  (key resolution, download, parse, chunk, embed, status lifecycle) shared by
  the cloud `process_job` and the local `process_job_local`; `run_local`
  polls the queue (recovering stale jobs at boot) and never touches
  NATS/Postgres/MinIO. `storage_mode` selects the transport.
- `LocalStores` gained `jobs`; rag-service `main.py` connects/closes it in
  the lifespan and exposes `app.state.vector/documents/jobs` for the API.
- `set_document_status` takes an optional `user_id` and includes it in its
  `INSERT OR IGNORE`, so a status write that creates the row from scratch
  (e.g. the upload error path) keeps the document scoped to its owner instead
  of leaving `user_id` NULL. The cloud `VectorStore` accepts it and ignores
  it for signature parity.

### Tests

- document-worker `tests/test_local_jobs.py` (7): atomic claim + no
  double-claim across two queues, complete/fail, stale recovery, and full
  end-to-end `process_job_local` (real `LocalVectorStore`/`LocalFileStore`,
  monkeypatched parser/chunker/embedder) including the failure path.
- rag-service `tests/test_local_jobs.py` (4): idempotent submit, status
  views, and a schema-contract check that producer and consumer columns
  match.
- rag-service `tests/test_documents_api.py` (5): upload → file-on-disk →
  queued; simulated worker marks it ready and the API reflects it; non-PDF
  rejection; 404; delete removes row + file; cloud mode returns 501.
- `test_factory.py` extended to connect the new `jobs` store.

## 16. Desktop BYOK inference (Phase 11)

Design rule from the desktop port: inference must not *require* local GPU or
Ollama. The desktop talks to the same cloud providers as the web/Node stack
(BYOK — the user brings their own API key, stored locally); Ollama remains an
optional, keyless model-list choice for users who run it. `/api/v1/models`
already lists it ("Local (Ollama)") alongside the cloud providers, so no
model-list change was needed.

### Key store

- `LocalKeyStore` (rag-service `src/storage/local_keys.py`, document-worker
  `src/storage/local_keys.py`) persists keys in `keys.db`
  (`provider_keys(provider, user_id) PK, api_key, key_prefix, last4,
  updated_at`). Keys are stored **plaintext** — same trust boundary as the
  desktop data dir; at-rest encryption is a future phase. `cache_key()` maps
  to `rag:user_key:{user_id}:{provider}`, the same key the worker resolves in
  the cloud, so the desktop mirrors provider keys into the local cache with
  the identical layout.
- `LocalStores.keys` wired through the factory; rag-service connects/closes it
  in the lifespan and exposes `app.state.keys`. The document-worker builds its
  own instance in `run_local` and threads it into
  `process_job_local → _ingest`.

### Keys API (local mode only)

`/api/v1/keys` mirrors the api-gateway contract:

- `GET ""` → `{keys:[{provider,keyPrefix,last4,status,createdAt,updatedAt}]}`
  (masked — full keys never leave the store).
- `PUT /{provider}` body `{apiKey}` → validates the format
  (`assert_key_format`: per-provider prefix + minimum length), runs a live
  `validate_provider_key` probe (openrouter/openai/xai/opencode/nvidia/gemini)
  that is **best-effort**: HTTP errors at the boundary and any network failure
  are logged and still save the key. Persists and mirrors to the cache.
- `DELETE /{provider}` removes both rows.
- `POST /{provider}/test` re-validates and reports `{provider,status,info}`.
- Cloud mode returns 501 so the gateway stays the single key path.

### Local key resolution

- `build_embedder(api_key=None)` / `build_reranker(api_key=None)` take an
  override; the local lifespan reads the user's saved key from
  `app.state.keys` and passes it before falling back to server defaults.
- `_ingest` resolves the embed key the same way: explicit `keys` store when
  present, else the Redis key, else server default. Ollama providers ignore
  the key entirely.
- `settings.local_user_id` (`"default"`) scopes desktop keys and document
  operations; both APIs default to it.

### Tests

- rag-service `tests/test_local_keys.py` (3): set/get/has/delete roundtrip,
  masked list scoped to user, `cache_key` format.
- rag-service `tests/test_keys_api.py` (7): full PUT→GET→DELETE flow with
  sqlite-level assertions on `keys.db` **and** the `rag:user_key:…` mirror in
  `cache.db`; malformed/unsupported provider rejection; save-despite-network-
  failure; invalid-key rejection; test-endpoint 404; cloud 501 via a bare
  router app.
- rag-service `tests/test_inference_builders.py` (3): supplied key wins over
  server default; server default used when no user key; Ollama ignores key.
- document-worker `tests/test_local_keys.py` (4): CRUD roundtrip, user
  scoping, and two `process_job_local` runs proving the saved key (or the
  server default) reaches the embedder.
- `test_factory.py` now connects `stores.keys`.

## 17. Desktop coverage tests (Phase 12)

Per the product direction, the desktop path is exercised end-to-end through the
same cloud APIs the web edition uses — and **no test requires Ollama or a GPU**
(a startup stand-in replaces the `OllamaClient` fallback so it is never even
constructed). The full BYOK chain is now pinned by tests:

### Chat (`tests/test_desktop_chat.py`, 3)

- `test_seeded_key_streams_chat`: seeds `LocalKeyStore` + the
  `rag:user_key:default:openrouter` cache mirror before app startup, then POSTs
  `/api/v1/query` (local mode, `llm_provider="openrouter"`). The router returns
  a "general" plan so the query takes the direct path; asserts the SSE body
  streams `chunk` events and the saved key reached the chat builder. Fake
  providers everywhere — no network.
- `test_no_key_returns_error_event`: nothing saved → `resolve_chat_llm` raises
  → SSE `{"type":"error",…}` naming the missing API key; no chunks, no builder
  call.
- `test_single_desktop_key_serves_any_user_id`: the desktop is a single-user
  install, so the `local_user_id` key is the installation-wide default — a
  request under a different `user_id` still streams (the key is per-machine,
  not per-tenant; web-search key resolution remains strictly per `user_id`).

### Web search (`tests/test_websearch_local.py`, 5)

- Saved `rag:user_key:default:tavily` mirror reaches the provider (key
  captured by a fake Tavily adapter, result returned).
- User key beats the server default.
- No key → provider skipped, empty result.
- Key written through `LocalKeyStore` + mirror is used (keys-API path).
- Second identical search is served from the local `cache.db`
  (`rag:websearch:v2:…`), so the provider is called exactly once.

No source changes were required in this phase — the Phase 11 wiring already
made chat and web search key-aware; this phase locks it down with offline
tests that never touch Ollama or the network.

## 18. Local feedback (Phase 13)

`POST /api/v1/feedback` was the last rag-service route that assumed Postgres:
in local mode `state.pool` is `None`, so the endpoint would crash on
`pool.acquire()`. The desktop now owns the same contract in SQLite:

- `LocalFeedbackStore` (`src/storage/local_feedback.py`) persists ratings in
  `feedback.db` (`feedback(id, message_id, helpful, comment, created_at)`),
  wired through `LocalStores.feedback` in the factory and connected/closed in
  the rag-service lifespan (`app.state.feedback`).
- The endpoint branches on mode: local writes via the store and returns the
  same `{status: "ok"}`; cloud keeps the asyncpg insert unchanged. A missing
  store returns 501.
- Tests (`tests/test_feedback_local.py`, 3): local POST persists the row to
  `feedback.db` (verified at the sqlite level), a comment-less rating works,
  and the cloud path still executes the Postgres `INSERT INTO feedback`
  (verified with a fake pool, no database). `test_factory.py` now connects
  `stores.feedback`.

Totals: rag-service **269 tests**, document-worker **27 tests**, ruff clean in
both apps. Cloud-equivalence suites (17 rag-service, 3 document-worker) skip
when the Docker stack is down.

## 19. Gateway-compatible desktop API (Phase 14)

The desktop edition renders the existing web UI inside a Tauri window, and
that UI talks to the api-gateway contract (`apps/web/lib/api.ts` +
`packages/contracts`). Phase 14 makes rag-service serve that exact surface in
local mode so the bundled app needs no gateway:

- `src/api/desktop.py` exposes `APIRouter(prefix="/api")` with every path the
  UI calls: auth, chat/stream, conversations, settings, documents, keys,
  models, playground/retrieve, analytics/metrics, health. In cloud mode every
  route returns 501 — the gateway stays the single entry point there.
- **Single-user auth**: register/login/me/logout are a no-op returning the
  fixed default user (`settings.local_user_id`, `desktop@local`) with
  `accessToken: "desktop"`. There is no password model on desktop.
- **Chat with persistence**: `/api/chat/stream` accepts the UI payload
  (`message`, `conversationId`, `provider`, `model`, `documentIds`), maps it to
  a `QueryRequest`, streams the same SSE events as `/api/v1/query`, and in the
  generator's `finally` best-effort persists the user + assistant messages into
  `conversations.db` so history survives restarts (a failure can never break
  chat).
- **Conversations**: `LocalConversationStore` (`conversations.db`,
  `conversations` + `messages` tables, ownership-scoped list/create/messages/
  delete) wired through `LocalStores.conversations`, connected/closed in the
  lifespan and reachable at `app.state.conversations`. DTOs match the contract
  `ConversationDto`/`MessageDto` (citations/webSources as JSON columns).
- **Settings**: `GET /api/settings` and the `PUT /api/settings/web-search` /
  `PUT /api/settings/omniroute` toggles write the same cache flags the gateway
  reads — `rag:user_setting:{user_id}:web_search` / `:omniroute` (`"1"`/`"0"`),
  with `serverEnabled` reported from the environment gates
  `settings.web_search_enabled` / `settings.omniroute_enabled`.
- **Aliases**: documents/keys/models/health/metrics/playground-retrieve
  delegate to the existing `/api/v1` handlers (`documents_api.*`,
  `keys_api.*`, `routes.*`) so there is one implementation per endpoint. The
  keys `PUT/POST-test` path also reuses the Phase 11 save-with-best-effort
  validation.
- **CORS**: in local mode a `CORSMiddleware` allows the Tauri webview origin
  (`http://tauri.localhost`, `https://tauri.localhost`) plus localhost dev
  origins (`1420`, `3001`, `8000`), configurable via
  `settings.local_cors_origins`.
- Tests (`tests/test_desktop_api.py`, 8): single-user auth, conversations CRUD
  + 404s, settings round-trip verified at the `cache.db` level, chat streaming
  that persists user+assistant rows (with and without a key), health/models/
  metrics aliases, documents/keys aliases, and a 501 check for cloud mode.
  `test_factory.py` now also connects `stores.conversations`. The suite stays
  hermetic: key validation is stubbed and OpenRouter/OmniRoute model probes
  point at a dead port.

Totals: rag-service **277 tests**, document-worker **27 tests**, ruff clean in
both apps. Cloud-equivalence suites (17 rag-service, 3 document-worker) skip
when the Docker stack is down.

## 20. Tauri desktop shell (Phase 14, UI)

The desktop edition is the existing Next.js UI rendered inside a native Tauri
window. One UI, three OSes — Tauri ships on Windows (NSIS/MSI), macOS (dmg/app)
and Linux (deb/AppImage/RPM), and the rag-service backend is the same Python
codebase everywhere.

- **Static export**: `apps/web` builds with `BUILD_FOR_DESKTOP=1` →
  `output: "export"` + `images.unoptimized`, producing a fully static
  `apps/web/out/` that the Tauri webview serves. The default build (cloud web)
  is unchanged (`standalone`). `/chat` reads its conversation id via
  `useSearchParams` inside a `Suspense` boundary — the documented pattern that
  keeps static export happy.
- **API base URL**: the UI already reads `NEXT_PUBLIC_API_URL`; desktop builds
  set it to `http://localhost:8642` (an uncommon port chosen so the desktop
  backend never collides with the cloud gateway / web stack, which uses
  :8000), so every UI call hits the rag-service gateway-compatible surface
  from §19 (no api-gateway, no auth wall).
- **Tauri shell** (`apps/desktop`): `src-tauri` (Cargo.toml, main/lib.rs,
  tauri.conf.json, capabilities, icons). `frontendDist` is `../../web/out`
  (resolved from `src-tauri/`). `beforeDevCommand` runs Next dev on :3001,
  `beforeBuildCommand` runs the static export. On startup the shell spawns the
  local backend via `scripts/run-backend.sh` / `run-backend.cmd` (health-checks
  :8642 first, runs `STORAGE_MODE=local uvicorn src.main:app`), and tears it
  down when the main window closes. `RAG_BACKEND` overrides the launcher for
  packaged sidecars.
- **Icons**: `apps/desktop/assets/icon-source.png` is the source artwork;
  `tauri icon` regenerates the full set (`src-tauri/icons/*`).
- **macOS .app (no Xcode)**: `tauri build` bundling needs full Xcode, so
  `scripts/bundle-app.sh` assembles a proper `Smoke Monkey.app` by hand
  (binary + `icon.icns` + `Info.plist`, ad-hoc signed) →
  `apps/desktop/src-tauri/target/release/Smoke Monkey.app`; copy it to
  `/Applications` to show the icon in the Dock/Launchpad.
- **Verified on this machine**: `pnpm exec tauri build --no-bundle` compiles
  the release binary; launching it starts rag-service (health ok) and the
  desktop API answers `/api/auth/login`, `/api/conversations`, `/api/settings`,
  `/api/models`.

Build (per OS, must be run on that OS — PyInstaller/Rust cannot cross-compile):
```bash
pnpm install
pnpm --filter desktop build     # builds web export + tauri bundles
# output: apps/desktop/src-tauri/target/release/bundle/{msi,nsis,dmg,app,deb,appimage,rpm}
```
```bash
pnpm --filter desktop dev       # hot-reload shell against Next dev + local backend
```

Next phases: PyInstaller packaging of rag-service/document-worker as Tauri
sidecars, DB/key-store hardening on disk, auto-update, and a CI matrix that
produces installers for Windows/macOS/Linux from one repo.

### §21 Single-BYPOK-key embedding fallback (fix, post-§20)

Desktop users often save **only one** key (e.g. NVIDIA) while embeddings are
configured for a different cloud provider. Previously the keyless embed
provider emitted an empty `Authorization: Bearer ` header, aborting chat with
`Retrieval failed: Illegal header value b'Bearer '`.

`pipeline._resolve_embed_layer()` now resolves `(embed_key, embedder)` per
request: the configured embed provider's saved key wins; otherwise it falls
back to the request's chat-provider key (OpenRouter/NVIDIA) and builds a
temporary OpenAI-compatible embedder for that provider
(`pipeline._temp_embedder()`, cached per `(provider, api_key)`). The resolved
embedder is threaded through `_embed_cached`, `_retrieve`,
`_memory_pipeline`, and `_personalize_targeted` (input_type / cache-hash /
embed calls). A final guard: if **no** key exists for embedding at all,
`_embed_cached` returns `[]` so retrieval degrades to sparse/keyword search
instead of crashing the turn. Regression test:
`tests/test_desktop_api.py::test_nvidia_only_key_streams_chat_and_embeds`.

### §22 SSE CRLF parsing fix (desktop streaming, post-§20)

The desktop backend (sse_starlette `EventSourceResponse`) emits SSE events
with CRLF separators (`\r\n\r\n`), while the cloud gateway emits bare LF
(`\n\n`). `apps/web/lib/sse.ts` split only on `\n\n`, so desktop streams never
parsed during the request — nothing rendered until a page refresh reloaded the
persisted messages. The parser now normalizes `\r\n` → `\n` as chunks arrive
and flushes any trailing block after EOF, so both transports stream
token-by-token. Applies to `/api/chat/stream` (and any future SSE consumer).

### §23 Desktop document-worker + offline indicator (post-§22)

Uploads were stuck at "queued": the desktop shell only spawned rag-service, so
nothing consumed the shared `jobs.db`. Now the Tauri shell spawns **two**
processes (`run-backend.sh` → rag-service on :8642, `run-worker.sh` →
document-worker local mode) and tears both down on window close. Also fixed:
- `IngestJob.user_id` accepts a plain string ("default") instead of requiring
  a UUID (the desktop user id is not a UUID) — the worker crashed with "badly
  formed hexadecimal UUID string".
- The worker falls back across OpenAI-compatible providers when only one BYOK
  key is saved (e.g. `EMBED_PROVIDER=openrouter` but an NVIDIA key is stored),
  so chunk embedding works with a single key.
- `apps/web/components/OfflineIndicator.tsx` (mounted in the root layout)
  shows a slim amber banner when `navigator.onLine` flips to offline, in both
  the browser and the Tauri webview.

### §24 Desktop UX fixes: free mode, auth, titles, rerank (post-§23)

Desktop parity fixes driven by app feedback. No web/tauri rebuild was needed —
the embedded UI already contains the composer options; every change here is
backend-side.

**Free mode without installing OmniRoute.** Users won't install a separate
gateway, and no truly keyless chat upstream exists (OpenCode Zen, OpenRouter
`:free` and NVIDIA all still need a key). So in local mode the rag-service
itself serves the OmniRoute-compatible surface on the same port:
`src/application/freegate.py` mounts `/v1/models` and `/v1/chat/completions`
(`main.py`, local mode only). It proxies the requested free model to whichever
provider the user already holds a BYOK key for — `auto` → first of
NVIDIA/OpenRouter/OpenCode with a key; catalog ids
(`big-pickle`, `deepseek-v4-flash-free`, `nvidia/nemotron-3-nano-30b-a3b`, …)
→ their owning provider; unknown ids / `:free` ids → OpenRouter. Keys resolve
through `resolve_user_api_key` (user key > server default), the same mirror the
Keys UI writes to `cache.db`. Missing key → a friendly 401 naming the free
provider to add. Streaming SSE is passed through verbatim. `run-backend.sh` /
`.cmd` now set `OMNIROUTE_BASE_URL=http://127.0.0.1:8642/v1` (self) plus a
curated `OMNIROUTE_CHAT_MODELS` catalog, and `OMNIROUTE_ENABLED=true` /
`WEB_SEARCH_ENABLED=true` so the composer's "Enable free mode" and "Web Search"
controls render and work.

**Auth is real now.** The desktop backend previously accepted any login and
returned a hardcoded `desktop@local` profile. `src/api/desktop.py` persists the
profile to `data/desktop/profile.json` (email, name, scrypt hash+salt —
`n=2**14,r=8,p=1`, `hmac.compare_digest`): register stores the password, login
returns 401 on mismatch, `/auth/me` returns the stored name/email. A profile
that predates hashing sets its password on first successful login (migration),
so existing installs are never locked out. Register/login now honor the `name`
field.

**Chat titles.** The UI labels chats by title; conversations created by the
pipeline had none. `desktop._derive_title(message)` produces a deterministic,
human-readable title (strips markdown/emoji/URLs and stop-words, title-case,
≤60 chars). `chat_stream` auto-creates the conversation with that title when
no `conversationId` is supplied, threads the id into `QueryRequest` (the meta
event returns it), and persists both messages.

**Rerank key fallback (the second `Illegal header value` fix).** With a single
NVIDIA key the OpenRouter reranker built with an empty key emitted
`Authorization: Bearer ` → httpx `Illegal header value b'Bearer '`, failing
every document chat. Three-part fix:
- `OpenRouterClient._headers()` only adds the bearer header when a key
  actually exists (embeddings/rerank/chat all share it).
- `pipeline._resolve_rerank_layer()` mirrors `_resolve_embed_layer`: the
  reranker's own provider key wins; otherwise it falls back to the request's
  chat-provider key and builds a cached temp reranker for that provider
  (`pipeline._temp_reranker()`, NVIDIA rerank style when NVIDIA).
- The rerank call in `_retrieve` is wrapped so any failure degrades to
  unranked results instead of breaking the turn.

**Bounded composer + model-aware token limits.** The textarea now auto-grows
from 1 line (44 px) and clamps at 220 px on desktop / 35 vh on mobile via a
JS-driven resize effect (measures `scrollHeight`, clamps, sets `height: auto`
then the clamped value, with `overflow-y: auto` as a safety cap). Long pastes
and emoji/unicode are handled correctly. A live token counter in the composer
footer (`apps/web/lib/tokens.ts`) estimates the user's current prompt size
using a 4-char-per-token heuristic with CJK penalty, then computes a
model-aware budget: `contextWindow − maxOutputTokens − systemReserved (2000)
− ragReserve (12 000 when docs selected) − historyReserve`. The counter
displays in normal (green), warning (>80%), critical (>95%), and over (>100%)
states; sending is blocked when over and a "Your text is never truncated"
message is shown. `computeTokenBudget` accepts `historyTokens` and
`ragActive` from `ChatPanel` so the budget accounts for conversation history
and RAG mode. `QueryRequest.message` max_length was raised from 4096 to
1 000 000 — the token budget is the real gate. Switching models in the
ModelPicker updates the limits instantly (no refresh).

**Backend token validation.** `src/application/token_budget.py` provides
`validate_context(messages, model, rag_active)`: estimates total prompt tokens
using `estimate_messages_tokens`, compares against `context_window_for(model)`
minus output reserve (3000) minus system overhead (2000) minus RAG reserve
(12 000 when active). Returns `None` if OK, or a structured error event
(`event.type="token_limit"`) with `estimated_tokens` / `context_window` /
`available_budget` fields. Wired into `pipeline.py` right after message
assembly and before generation — the error is yielded as a final SSE event
and returned early, so the model is never called when the context is over
budget. No truncation, no crash.

**OmniRoute key option in Keys UI.** An "OmniRoute (Free)" entry was added
to both the composer's `KEY_PROVIDERS` (top of the Chat models group, with
a hint: "Built-in — no install needed. Add any free provider key (OpenRouter
`<model>:free`, NVIDIA, OpenCode) to enable free chat.") and the Settings
page `PROVIDERS` array. The KeyManager renders the hint inline. Backend
`keys.py` `SUPPORTED_PROVIDERS` already includes `"omniroute"`; the
`assert_key_format` function returns the key as-is for omniroute (no
prefix validation). The free gateway `_keys()` probe also checks the
`"omniroute"` provider, and the 401 messages now mention the OmniRoute key
option alongside the existing free providers.

Verified live on this machine: wrong-password login → 401; free gateway
`auto` answered via the saved NVIDIA key; document retrieval returns resume
citations and streams an answer (no more `Illegal header value`); new chats
get proper titles (`"List top 3 skills from resume. One line each"`); token
counter present in built web (4 chunk files); composer textarea bounded,
token budget blocks send when over.
