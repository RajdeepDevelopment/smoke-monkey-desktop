# Changelog

All notable changes to **Smoke Monkey** are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Public repository scaffolding (initial commit):
  - Community files: `LICENSE` (PolyForm Noncommercial 1.0.0),
    `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`,
    `CHANGELOG.md`, `CITATION.cff`.
  - Developer experience: `.editorconfig`, `.gitattributes`,
    `.pre-commit-config.yaml` (gitleaks + detect-secrets + ruff),
    `.github` CI workflow and PR/issue templates.
  - Documentation suite with mermaid diagrams: `docs/architecture.md`,
    `docs/retrieval-flow.md`, `docs/super-memory.md`, `docs/dynamic-visual.md`.

## [0.1.0] - 2026-08-14

### Added
- Core RAG platform (pre-repo): Next.js web app, NestJS api-gateway,
  FastAPI rag-service, async document-worker.
- Hybrid retrieval: pgvector dense + Postgres FTS sparse, RRF fusion,
  cross-encoder rerank, HyDE + multi-query expansion, parent-child chunks.
- Agentic query router and **super memory** (conversation embeddings +
  durable user-fact extraction).
- Dynamic visual canvas widgets rendered live in chat.
- SSE streaming answers with page-level citations.
- Redis query-answer cache; NATS JetStream ingestion pipeline; MinIO storage.
- Model catalog presets and encrypted per-user provider keys.

[Unreleased]: https://github.com/RajdeepDevelopment/smoke-monkey/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/RajdeepDevelopment/smoke-monkey/releases/tag/v0.1.0
