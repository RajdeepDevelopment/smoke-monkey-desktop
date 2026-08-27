"""Phase 8: cloud-vs-local behavioral equivalence.

The desktop edition swaps Postgres+pgvector, Neo4j, and Redis for local SQLite
adapters. These tests run the SAME scenario against the cloud adapter and its
local substitute and assert identical observable behavior — the contract that
makes the swap invisible to the app.

Live scenarios need the services from the root ``docker-compose.yml``
(postgres/redis/neo4j). When a service is not reachable its scenarios skip
cleanly, so the default suite stays green on machines without the stack.

Each scenario is implemented once (``_scenario_*``) and exposed as a pair of
tests, one per implementation, so the local variant always runs even when the
cloud service is down.
"""
from __future__ import annotations

import asyncio
import os
import uuid

import pytest
from src.application.mem.graph import GraphMemoryStore
from src.application.mem.models import Memory, MemoryType
from src.config import settings
from src.storage import LocalCacheStore, LocalGraphStore, LocalVectorStore
from src.storage.postgres import PostgresVectorStore

# ─────────────────────────────────────────────────────────────────────────────
# Probes / helpers
# ─────────────────────────────────────────────────────────────────────────────


async def _wait_for(coro_factory, attempts: int = 6, delay_s: float = 2.0):
    """Call ``coro_factory()`` until it succeeds or the attempts run out."""
    last: Exception | None = None
    for _ in range(attempts):
        try:
            return await coro_factory()
        except Exception as exc:  # noqa: BLE001 - any connection failure
            last = exc
            await asyncio.sleep(delay_s)
    pytest.skip(f"service not reachable: {last}")


def _probe_sync(host: str, port: int) -> bool:
    """TCP reachability probe. Runs in a sync fixture, so it never touches
    an asyncio loop and stays immune to per-test loop churn."""
    import socket

    try:
        with socket.create_connection((host, port), timeout=2):
            return True
    except OSError:
        return False


class _VectorFixture:
    """Uniform handle over PostgresVectorStore / LocalVectorStore."""

    def __init__(self, store, cleanup, seed_document, fetch) -> None:
        self.store = store
        self._cleanup = cleanup
        self.seed_document = seed_document
        self.fetch = fetch

    def __getattr__(self, name):
        return getattr(self.store, name)

    @property
    def cloud(self) -> bool:
        return hasattr(self.store, "pool")

    async def truncate(self) -> None:
        await self._cleanup()


class _RedisLike:
    """Normalize redis.asyncio vs LocalCacheStore onto one surface."""

    def __init__(self, impl) -> None:
        self._impl = impl

    async def set(self, key, value, ttl=None):
        if hasattr(self._impl, "push_tail"):
            await self._impl.set(key, value, ttl=ttl)
        else:
            await self._impl.set(key, value, ex=ttl)

    async def get(self, key):
        return await self._impl.get(key)

    async def exists(self, key):
        return bool(await self._impl.exists(key))

    async def expire(self, key, ttl):
        return bool(await self._impl.expire(key, ttl))

    async def delete(self, key):
        await self._impl.delete(key)

    async def lpush(self, key, value):
        if hasattr(self._impl, "push_tail"):
            await self._impl.push_tail(key, value)
        else:
            await self._impl.lpush(key, value)

    async def lrange(self, key, start, end):
        if hasattr(self._impl, "range"):
            return await self._impl.range(key, start, end)
        return await self._impl.lrange(key, start, end)

    async def ltrim(self, key, start, end):
        if hasattr(self._impl, "trim"):
            await self._impl.trim(key, start, end)
        else:
            await self._impl.ltrim(key, start, end)

    async def incr(self, key, amount=1):
        return await self._impl.incr(key, amount)


def _vec(*xs: float) -> list[float]:
    return list(xs)


class Child:
    def __init__(self, content, page_number):
        self.content = content
        self.page_number = page_number


class Group:
    def __init__(self, parent_content, section, children):
        self.parent_content = parent_content
        self.section = section
        self.children = children


def _memory(mid: str, user_id: str, content: str, importance: float) -> Memory:
    return Memory(
        id=mid,
        user_id=user_id,
        type=MemoryType.SEMANTIC,
        content=content,
        importance=importance,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Vector store fixtures (pgvector vs sqlite)
# ─────────────────────────────────────────────────────────────────────────────

_PG_DDL = """
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS conversation_memory (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL,
    conversation_id  UUID,
    role             TEXT NOT NULL,
    content          TEXT NOT NULL,
    content_hash     TEXT NOT NULL,
    embedding        vector(3),
    access_count     INTEGER NOT NULL DEFAULT 0,
    last_accessed_at TIMESTAMPTZ,
    expires_at       TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, content_hash)
);
CREATE TABLE IF NOT EXISTS memories (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL,
    type            TEXT NOT NULL,
    content         TEXT NOT NULL,
    embedding       vector(3),
    importance      DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    source_message  TEXT,
    access_count    INTEGER NOT NULL DEFAULT 0,
    last_accessed_at TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,
    stage           VARCHAR(16) NOT NULL DEFAULT 'candidate',
    confidence      DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    evidence_count  INTEGER NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS chunks (
    id              UUID PRIMARY KEY,
    document_id     UUID NOT NULL,
    parent_chunk_id UUID,
    content         TEXT NOT NULL,
    content_tsv     tsvector,
    section         TEXT,
    page_number     INTEGER,
    token_count     INTEGER NOT NULL DEFAULT 1,
    embedding       vector(3),
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS documents (
    id          UUID PRIMARY KEY,
    user_id     UUID,
    filename    TEXT,
    status      TEXT,
    error       TEXT,
    chunk_count INTEGER,
    updated_at  TIMESTAMPTZ
);
"""


@pytest.fixture(scope="module")
def pg_up():
    if not _probe_sync(
        os.environ.get("SMOKE_EQUIV_PG_HOST", "localhost"),
        int(os.environ.get("SMOKE_EQUIV_PG_PORT", "5432")),
    ):
        pytest.skip("postgres not reachable")


@pytest.fixture
async def pg_vector(pg_up):
    import asyncpg

    host = os.environ.get("SMOKE_EQUIV_PG_HOST", "localhost")
    port = int(os.environ.get("SMOKE_EQUIV_PG_PORT", "5432"))
    user = os.environ.get("SMOKE_EQUIV_PG_USER", "rag")
    password = os.environ.get("SMOKE_EQUIV_PG_PASSWORD", "rag_secret")
    # Dedicated database so the equivalence DDL (3-dim vectors) never touches
    # the app's own schema.
    db = os.environ.get("SMOKE_EQUIV_PG_DB", "ragdb_test")
    admin = await asyncpg.connect(
        host=host, port=port, user=user, password=password, database="ragdb"
    )
    try:
        exists = await admin.fetchval("SELECT 1 FROM pg_database WHERE datname = $1", db)
        if not exists:
            await admin.execute(f'CREATE DATABASE "{db}"')
    finally:
        await admin.close()

    pool = await asyncpg.create_pool(
        host=host,
        port=port,
        user=user,
        password=password,
        database=db,
        min_size=1,
        max_size=4,
    )
    async with pool.acquire() as conn:
        for table in ("conversation_memory", "memories", "chunks", "documents"):
            await conn.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
        await conn.execute(_PG_DDL)

    async def _cleanup() -> None:
        async with pool.acquire() as conn:
            for table in ("conversation_memory", "memories", "chunks", "documents"):
                await conn.execute(f"TRUNCATE {table}")

    async def _seed_document(doc_id: str) -> None:
        async with pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO documents (id, status, updated_at) "
                "VALUES ($1::uuid, 'processing', now()) "
                "ON CONFLICT (id) DO NOTHING",
                doc_id,
            )

    async def _fetch(sql: str, *params) -> list[dict]:
        async with pool.acquire() as conn:
            return [dict(r) for r in await conn.fetch(sql, *params)]

    yield _VectorFixture(PostgresVectorStore(pool), _cleanup, _seed_document, _fetch)
    await pool.close()


@pytest.fixture
async def pg_vector_store(pg_vector):
    await pg_vector.truncate()
    yield pg_vector
    await pg_vector.truncate()


@pytest.fixture
async def local_vector():
    s = LocalVectorStore(":memory:")
    await s.connect()

    async def _noop() -> None:
        pass

    async def _seed_document(doc_id: str) -> None:
        await s.set_document_status(doc_id, "processing")

    async def _fetch(sql: str, *params) -> list[dict]:
        return [dict(r) for r in await s._rows(sql, tuple(params))]

    yield _VectorFixture(s, _noop, _seed_document, _fetch)
    await s.close()


@pytest.fixture
async def local_vector_store(local_vector):
    yield local_vector


# ─────────────────────────────────────────────────────────────────────────────
# Graph store fixtures (neo4j vs sqlite)
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def neo4j_up():
    if not _probe_sync(
        os.environ.get("SMOKE_EQUIV_NEO4J_URI", "bolt://localhost:7687")
        .split("://")[1]
        .split(":")[0],
        int(os.environ.get("SMOKE_EQUIV_NEO4J_PORT", "7687")),
    ):
        pytest.skip("neo4j not reachable")


@pytest.fixture
async def neo4j_graph(neo4j_up):
    from neo4j import AsyncGraphDatabase

    uri = os.environ.get("SMOKE_EQUIV_NEO4J_URI", "bolt://localhost:7687")
    user = os.environ.get("SMOKE_EQUIV_NEO4J_USER", "neo4j")
    password = os.environ.get("SMOKE_EQUIV_NEO4J_PASSWORD", "neo4j_password")

    driver = AsyncGraphDatabase.driver(uri, auth=(user, password))
    store = GraphMemoryStore(driver=driver)
    await store.ensure_schema()
    yield store
    await store.close()


async def _neo4j_clear(store) -> None:
    if store.enabled:
        async with store._driver.session() as session:
            await session.run("MATCH (n) DETACH DELETE n")


@pytest.fixture
async def neo4j_graph_store(neo4j_graph):
    await _neo4j_clear(neo4j_graph)
    yield neo4j_graph
    await _neo4j_clear(neo4j_graph)


@pytest.fixture
async def local_graph_store():
    s = LocalGraphStore(":memory:")
    await s.connect()
    yield s
    await s.close()


# ─────────────────────────────────────────────────────────────────────────────
# Cache store fixtures (redis vs sqlite)
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def redis_up():
    if not _probe_sync("localhost", int(os.environ.get("SMOKE_EQUIV_REDIS_PORT", "6379"))):
        pytest.skip("redis not reachable")


@pytest.fixture
async def redis_cache(redis_up):
    import redis.asyncio as aredis

    url = os.environ.get("SMOKE_EQUIV_REDIS_URL", "redis://localhost:6379")
    r = aredis.from_url(url, decode_responses=True)
    yield r
    await r.aclose()


@pytest.fixture
async def redis_cache_store(redis_cache):
    await redis_cache.flushdb()
    yield _RedisLike(redis_cache)
    await redis_cache.flushdb()


@pytest.fixture
async def local_cache_store():
    c = LocalCacheStore(":memory:")
    await c.connect()
    yield _RedisLike(c)
    await c.close()


# ─────────────────────────────────────────────────────────────────────────────
# Vector equivalence scenarios
# ─────────────────────────────────────────────────────────────────────────────


async def _scenario_message_roundtrip_and_tenant_scope(store):
    u1, u2 = str(uuid.uuid4()), str(uuid.uuid4())
    await store.insert_message(
        user_id=u1, conversation_id=str(uuid.uuid4()), role="user",
        content="My dog is named Milo", vector=_vec(1, 0, 0),
    )
    hits = await store.search_conversation(_vec(1, 0, 0), u1, top_k=5)
    assert len(hits) == 1
    assert hits[0].content == "My dog is named Milo"
    assert hits[0].role == "user"
    assert hits[0].score >= 0.999
    assert await store.search_conversation(_vec(0, 1, 0), u1, top_k=5) == []
    assert await store.search_conversation(_vec(1, 0, 0), u2, top_k=5) == []


async def _scenario_message_dedupe(store):
    u1 = str(uuid.uuid4())
    for _ in range(2):
        await store.insert_message(
            user_id=u1, conversation_id=None, role="user",
            content="hello world", vector=_vec(1, 0, 0),
        )
    assert len(await store.search_conversation(_vec(1, 0, 0), u1, top_k=10)) == 1


async def _scenario_fact_upsert_merges_near_duplicates(store):
    u1 = str(uuid.uuid4())
    first = await store.upsert_fact(
        user_id=u1, type_="fact", content="User prefers the dark theme",
        vector=_vec(1, 0, 0), importance=0.8,
    )
    second = await store.upsert_fact(
        user_id=u1, type_="fact", content="User prefers the dark theme",
        vector=_vec(1, 0, 0), importance=0.8,
    )
    assert first == second
    facts = await store.search_facts(_vec(1, 0, 0), u1, top_k=5)
    assert len(facts) == 1
    assert facts[0].content == "User prefers the dark theme"


async def _scenario_fact_distinct_vectors_stay_separate(store):
    u1 = str(uuid.uuid4())
    await store.upsert_fact(user_id=u1, type_="fact", content="likes coffee", vector=_vec(1, 0, 0))
    await store.upsert_fact(user_id=u1, type_="fact", content="likes tea", vector=_vec(0, 1, 0))
    # dedupe must NOT merge orthogonal facts...
    if store.cloud:
        rows = await store.fetch("SELECT id FROM memories WHERE user_id = $1::uuid", u1)
    else:
        rows = await store.fetch("SELECT id FROM memories WHERE user_id = ?", u1)
    assert len(rows) == 2
    # ...and each query returns only its relevant fact (score 0 is filtered)
    assert len(await store.search_facts(_vec(1, 0, 0), u1, top_k=10)) == 1
    assert len(await store.search_facts(_vec(0, 1, 0), u1, top_k=10)) == 1


async def _scenario_stage_transition_to_stable(store):
    u1 = str(uuid.uuid4())
    mid = await store.upsert_fact(
        user_id=u1, type_="fact", content="Ram leads the team",
        vector=_vec(1, 0, 0), importance=0.8, stage="candidate",
    )
    for _ in range(4):
        await store.merge_fact(
            target_id=mid, user_id=u1, importance=0.8, content="Ram leads the team",
            evidence_boost=0.02, confirm_accesses=2, stable_accesses=4,
            stable_min_importance=0.6,
        )
    if store.cloud:
        rows = await store.fetch(
            "SELECT stage, evidence_count FROM memories WHERE id = $1::uuid", mid
        )
    else:
        rows = await store.fetch(
            "SELECT stage, evidence_count FROM memories WHERE id = ?", mid
        )
    assert rows[0]["stage"] == "stable"
    assert rows[0]["evidence_count"] >= 4


async def _scenario_consolidate_expires_facts(store):
    u1 = str(uuid.uuid4())
    expired = await store.upsert_fact(
        user_id=u1, type_="fact", content="ephemeral note",
        vector=_vec(1, 0, 0), importance=0.8, expires_in_days=0,
    )
    events = await store.consolidate()
    assert any(e["id"] == expired for e in events)
    assert await store.search_facts(_vec(1, 0, 0), u1, top_k=5) == []


async def _scenario_merge_duplicates_collapses_weak_copy(store, monkeypatch):
    monkeypatch.setattr(settings, "memory_dedupe_ignore", 1.5)
    monkeypatch.setattr(settings, "memory_dedupe_merge", 1.5)
    u1 = str(uuid.uuid4())
    await store.upsert_fact(
        user_id=u1, type_="fact", content="dup one", vector=_vec(1, 0, 0), importance=0.9
    )
    await store.upsert_fact(
        user_id=u1, type_="fact", content="dup two", vector=_vec(1, 0, 0), importance=0.5
    )
    monkeypatch.setattr(settings, "memory_dedupe_merge", 0.72)
    merged = await store.merge_duplicates()
    assert merged >= 1
    assert len(await store.search_facts(_vec(1, 0, 0), u1, top_k=10)) == 1


async def _scenario_chunk_lifecycle(store):
    doc = str(uuid.uuid4())
    await store.seed_document(doc)
    group = Group(
        "Quantum physics intro", "s1",
        [Child("quantum entanglement explained", 1), Child("tensor algebra basics", 2)],
    )
    count = await store.replace_document_chunks(
        doc, [group],
        {"quantum entanglement explained": _vec(1, 0, 0), "tensor algebra basics": _vec(0, 1, 0)},
    )
    assert count == 2
    assert await store.search_chunks(_vec(1, 0, 0), top_k=5) == []  # not ready yet
    await store.set_document_status(doc, "ready", chunk_count=count)
    hits = await store.search_chunks(_vec(1, 0, 0), top_k=5)
    assert len(hits) == 1
    assert hits[0].content == "quantum entanglement explained"
    assert hits[0].document_id == doc
    assert hits[0].parent_chunk_id is not None
    assert await store.search_chunks(_vec(0, 0, 1), top_k=5) == []  # orthogonal
    await store.set_document_status(doc, "failed", error="boom")
    assert await store.search_chunks(_vec(1, 0, 0), top_k=5) == []


async def _scenario_touch_bumps_access_and_importance(store):
    u1 = str(uuid.uuid4())
    mid = await store.upsert_fact(
        user_id=u1, type_="fact", content="used fact", vector=_vec(1, 0, 0), importance=0.3
    )
    await store.touch(u1, [], [uuid.UUID(mid)])
    if store.cloud:
        rows = await store.fetch(
            "SELECT access_count, importance FROM memories WHERE id = $1::uuid", mid
        )
    else:
        rows = await store.fetch(
            "SELECT access_count, importance FROM memories WHERE id = ?", mid
        )
    assert rows[0]["access_count"] == 1
    assert rows[0]["importance"] > 0.3


# ─────────────────────────────────────────────────────────────────────────────
# Graph equivalence scenarios
# ─────────────────────────────────────────────────────────────────────────────


async def _scenario_graph_upsert_and_find_by_content(store):
    u1 = str(uuid.uuid4())
    await store.upsert_user(u1)
    await store.upsert_memory(_memory("m1", u1, "The user's manager is Ramakrishan", 0.9))
    rows = await store.find_related_by_content(u1, "ramakrishan")
    assert any(r["id"] == "m1" for r in rows)


async def _scenario_graph_link_and_related_traversal(store):
    u1 = str(uuid.uuid4())
    await store.upsert_user(u1)
    await store.upsert_memory(_memory("a", u1, "Ram leads Acme", 0.8))
    await store.upsert_memory(_memory("b", u1, "Ram prefers coffee", 0.6))
    await store.link_related(u1, "a", "b", "RELATED_TO", {"confidence": 0.9})
    related = await store.find_related_memories(u1, ["a"], top_k=10)
    assert any(r["id"] == "b" and r["rel_type"] == "RELATED_TO" for r in related)
    lines = store.format_relationships(related)
    assert lines and lines[0].startswith("[")


async def _scenario_graph_delete_memory_is_idempotent(store):
    u1 = str(uuid.uuid4())
    await store.upsert_user(u1)
    await store.upsert_memory(_memory("gone", u1, "unique disappearing fact", 0.7))
    await store.delete_memory(u1, "gone")
    await store.delete_memory(u1, "gone")  # must not raise
    assert await store.find_related_by_content(u1, "disappearing") == []


async def _scenario_graph_prune_stale_edges(store):
    u1 = str(uuid.uuid4())
    await store.upsert_user(u1)
    await store.upsert_memory(_memory("keep", u1, "keep this memory", 0.6))
    await store.upsert_memory(_memory("drop", u1, "prune this memory", 0.6))
    await store.prune_stale_edges(u1, ["keep"])
    assert await store.find_related_by_content(u1, "prune this") == []
    assert any(r["id"] == "keep" for r in await store.find_related_by_content(u1, "keep this"))


# ─────────────────────────────────────────────────────────────────────────────
# Cache equivalence scenarios
# ─────────────────────────────────────────────────────────────────────────────


async def _scenario_cache_get_set_expire(cache):
    await cache.set("k", "v", ttl=60)
    assert await cache.get("k") == "v"
    assert await cache.exists("k") is True
    assert await cache.expire("k", 0) is True
    assert await cache.get("k") is None
    assert await cache.exists("k") is False


async def _scenario_cache_delete(cache):
    await cache.set("a", "1", ttl=60)
    await cache.delete("a")
    assert await cache.exists("a") is False


async def _scenario_cache_lists_newest_first(cache):
    await cache.lpush("q", "a")
    await cache.lpush("q", "b")
    await cache.lpush("q", "c")
    assert await cache.lrange("q", 0, -1) == ["c", "b", "a"]
    assert await cache.lrange("q", -2, -1) == ["b", "a"]
    await cache.ltrim("q", 0, 0)
    assert await cache.lrange("q", 0, -1) == ["c"]


async def _scenario_cache_incr(cache):
    assert await cache.incr("counter") == 1
    assert await cache.incr("counter") == 2
    assert await cache.incr("counter", 3) == 5


# ─────────────────────────────────────────────────────────────────────────────
# Test pairs — one per implementation per scenario
# ─────────────────────────────────────────────────────────────────────────────


async def test_vector_message_roundtrip_pgvector(pg_vector_store):
    await _scenario_message_roundtrip_and_tenant_scope(pg_vector_store)


async def test_vector_message_roundtrip_sqlite(local_vector_store):
    await _scenario_message_roundtrip_and_tenant_scope(local_vector_store)


async def test_vector_message_dedupe_pgvector(pg_vector_store):
    await _scenario_message_dedupe(pg_vector_store)


async def test_vector_message_dedupe_sqlite(local_vector_store):
    await _scenario_message_dedupe(local_vector_store)


async def test_vector_fact_upsert_merges_pgvector(pg_vector_store):
    await _scenario_fact_upsert_merges_near_duplicates(pg_vector_store)


async def test_vector_fact_upsert_merges_sqlite(local_vector_store):
    await _scenario_fact_upsert_merges_near_duplicates(local_vector_store)


async def test_vector_fact_distinct_pgvector(pg_vector_store):
    await _scenario_fact_distinct_vectors_stay_separate(pg_vector_store)


async def test_vector_fact_distinct_sqlite(local_vector_store):
    await _scenario_fact_distinct_vectors_stay_separate(local_vector_store)


async def test_vector_stage_transition_pgvector(pg_vector_store):
    await _scenario_stage_transition_to_stable(pg_vector_store)


async def test_vector_stage_transition_sqlite(local_vector_store):
    await _scenario_stage_transition_to_stable(local_vector_store)


async def test_vector_consolidate_pgvector(pg_vector_store):
    await _scenario_consolidate_expires_facts(pg_vector_store)


async def test_vector_consolidate_sqlite(local_vector_store):
    await _scenario_consolidate_expires_facts(local_vector_store)


async def test_vector_merge_duplicates_pgvector(pg_vector_store, monkeypatch):
    await _scenario_merge_duplicates_collapses_weak_copy(pg_vector_store, monkeypatch)


async def test_vector_merge_duplicates_sqlite(local_vector_store, monkeypatch):
    await _scenario_merge_duplicates_collapses_weak_copy(local_vector_store, monkeypatch)


async def test_vector_chunk_lifecycle_pgvector(pg_vector_store):
    await _scenario_chunk_lifecycle(pg_vector_store)


async def test_vector_chunk_lifecycle_sqlite(local_vector_store):
    await _scenario_chunk_lifecycle(local_vector_store)


async def test_vector_touch_pgvector(pg_vector_store):
    await _scenario_touch_bumps_access_and_importance(pg_vector_store)


async def test_vector_touch_sqlite(local_vector_store):
    await _scenario_touch_bumps_access_and_importance(local_vector_store)


async def test_graph_upsert_and_find_by_content_neo4j(neo4j_graph_store):
    await _scenario_graph_upsert_and_find_by_content(neo4j_graph_store)


async def test_graph_upsert_and_find_by_content_sqlite(local_graph_store):
    await _scenario_graph_upsert_and_find_by_content(local_graph_store)


async def test_graph_link_and_traversal_neo4j(neo4j_graph_store):
    await _scenario_graph_link_and_related_traversal(neo4j_graph_store)


async def test_graph_link_and_traversal_sqlite(local_graph_store):
    await _scenario_graph_link_and_related_traversal(local_graph_store)


async def test_graph_delete_idempotent_neo4j(neo4j_graph_store):
    await _scenario_graph_delete_memory_is_idempotent(neo4j_graph_store)


async def test_graph_delete_idempotent_sqlite(local_graph_store):
    await _scenario_graph_delete_memory_is_idempotent(local_graph_store)


async def test_graph_prune_stale_edges_neo4j(neo4j_graph_store):
    await _scenario_graph_prune_stale_edges(neo4j_graph_store)


async def test_graph_prune_stale_edges_sqlite(local_graph_store):
    await _scenario_graph_prune_stale_edges(local_graph_store)


async def test_cache_get_set_expire_redis(redis_cache_store):
    await _scenario_cache_get_set_expire(redis_cache_store)


async def test_cache_get_set_expire_sqlite(local_cache_store):
    await _scenario_cache_get_set_expire(local_cache_store)


async def test_cache_delete_redis(redis_cache_store):
    await _scenario_cache_delete(redis_cache_store)


async def test_cache_delete_sqlite(local_cache_store):
    await _scenario_cache_delete(local_cache_store)


async def test_cache_lists_newest_first_redis(redis_cache_store):
    await _scenario_cache_lists_newest_first(redis_cache_store)


async def test_cache_lists_newest_first_sqlite(local_cache_store):
    await _scenario_cache_lists_newest_first(local_cache_store)


async def test_cache_incr_redis(redis_cache_store):
    await _scenario_cache_incr(redis_cache_store)


async def test_cache_incr_sqlite(local_cache_store):
    await _scenario_cache_incr(local_cache_store)
