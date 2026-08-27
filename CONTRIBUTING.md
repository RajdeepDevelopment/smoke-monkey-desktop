# Contributing to Smoke Monkey

Thanks for taking the time to contribute! Smoke Monkey is a chat LLM platform
with **super memory** and **dynamic visual** widgets (animated diagrams
rendered live in the chat). Every contribution is welcome — code, docs,
designs, and bug reports.

> Please read [SECURITY.md](SECURITY.md) before reporting vulnerabilities,
> and note that Smoke Monkey is **non-commercial** software (see [LICENSE](LICENSE)).

## Table of contents

1. [Code of conduct](#code-of-conduct)
2. [Getting started](#getting-started)
3. [Project layout](#project-layout)
4. [Branch & Git workflow](#branch--git-workflow)
5. [Development guidelines](#development-guidelines)
6. [Secrets policy](#secrets-policy)
7. [Commit & PR checklist](#commit--pr-checklist)

## Code of conduct

We follow the [Contributor Covenant](CODE_OF_CONDUCT.md). Be kind, be
respectful, and assume good intent.

## Getting started

1. Fork the repository and clone your fork.
2. Install prerequisites: Node ≥ 20, pnpm ≥ 9, Python ≥ 3.12, Docker.
3. Copy the environment template: `cp .env.example .env`
4. Start the stack: `make up`
5. Create the demo user: `make seed-user`

See the [README](README.md#quick-start) for the full quick start.

## Project layout

```
apps/
  api-gateway/        NestJS — auth, uploads, chat SSE proxy, health
  rag-service/        FastAPI — query pipeline, hybrid retrieval, streaming
  document-worker/    async PDF ingestion (parse → chunk → embed → index)
  web/                Next.js — chat UI, canvas (dynamic visual) renderer
packages/             shared TS contracts / config
infrastructure/       docker, k8s, helm, terraform
docs/                 architecture + algorithm documentation (mermaid)
```

## Branch & Git workflow

We use a **protected-branch, PR-based** workflow:

- `main` — production. Direct pushes are blocked; all changes come via PR.
- `develop` — integration branch for feature work.
- `staging` — pre-release QA.
- `release/*` — release preparation.
- `feat/*`, `fix/*`, `docs/*`, `chore/*` — short-lived feature branches.

Every PR must target `develop` (or `main` for hotfixes), be reviewed by at
least one maintainer, and pass CI before merge.

## Development guidelines

- **Python (rag-service, document-worker):** follow `pyproject.toml` (ruff +
  mypy + pytest). Run `make lint-py` and `make test` before pushing.
- **TypeScript (api-gateway, web, packages):** keep types strict; run the
  workspace `build` script (typecheck) before pushing.
- **Docs:** update `docs/` whenever behaviour changes; keep mermaid diagrams
  in sync with the code.
- **Secrets:** never put real credentials in code, tests, or docs. Use
  `.env.example` with placeholder values only.

## Secrets policy

Before you commit, the pre-commit hooks run:

- `gitleaks` — scans for known secret patterns.
- `detect-secrets` — flags high-entropy strings (keys, tokens).
- `ruff` / formatting checks for Python files.

If you do not have pre-commit installed:

```bash
pip install pre-commit
pre-commit install
```

Never commit `.env`, `*.pem`, or any file containing live keys. If you think a
secret slipped through, rotate it immediately and open a private security
advisory (see [SECURITY.md](SECURITY.md)).

## Commit & PR checklist

- [ ] Commits are atomic and messages are descriptive (`fix(worker): …`).
- [ ] No `.env`, keys, or secrets in the diff.
- [ ] `make lint-py` and `make test` pass (Python), typecheck passes (TS).
- [ ] Docs updated if behaviour changed.
- [ ] PR title follows Conventional Commits and links the related issue.

Thank you for contributing to Smoke Monkey!
