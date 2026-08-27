# Smoke Monkey — Documentation

Technical documentation for the platform.

## Index

| Doc | What it covers |
|---|---|
| [architecture.md](architecture.md) | System overview (mermaid), data flow, DB schema, NATS contract, SSE contract, security |
| [retrieval-flow.md](retrieval-flow.md) | Hybrid retrieval algorithm: dense + sparse, RRF fusion, rerank; canvas visualization spec |
| [super-memory.md](super-memory.md) | Super memory: write/read paths, ranker, memory mechanics, relationship graph (mermaid) |
| [dynamic-visual.md](dynamic-visual.md) | Dynamic visual widgets: mermaid, canvas, sandboxed HTML add-ons (mermaid) |

## Conventions

- Architecture and algorithm changes MUST be reflected here, including mermaid
  diagrams.
- Keep diagrams small (under ~15 nodes) so they stay legible on GitHub.
- Links between docs use relative paths.

## Quick map of the codebase

```
apps/
  api-gateway/        NestJS — auth, uploads, chat SSE proxy, health
  rag-service/        FastAPI — query router, retrieval, memory, streaming
  document-worker/    async PDF ingestion (parse → chunk → embed → index)
  web/                Next.js — chat UI + dynamic visual renderer
packages/             shared TS contracts / config
infrastructure/       docker, k8s, helm, terraform
```
