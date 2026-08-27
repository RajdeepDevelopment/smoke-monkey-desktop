# Security Policy

**Smoke Monkey** takes the security of your data and credentials seriously.
This document describes how to report vulnerabilities and the standards we
apply to keep secrets out of the repository.

## Supported versions

| Version | Supported          |
|---------|--------------------|
| latest (`main`) | :white_check_mark: |
| older releases | :x: |

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

- Report privately via GitHub's **Security Advisories** at
  <https://github.com/RajdeepDevelopment/smoke-monkey/security/advisories/new>
- Or email the maintainer: **Rajdeep Sadhu** (see profile link on the GitHub
  account page for the current contact).

You should receive a response within **72 hours**. Please include:

1. Affected component (api-gateway, rag-service, document-worker, web, infra).
2. Steps to reproduce and a minimal proof of concept.
3. Impact and whether any credential/data was exposed.

We operate on **coordinated disclosure**: please give us time to fix and
release before publishing details.

## Secret handling policy

- `.env` files and any local overrides are **never** committed (see
  [`.gitignore`](.gitignore) and [`.pre-commit-config.yaml`](.pre-commit-config.yaml)).
- All API keys, passwords and encryption secrets must come from environment
  variables or a secrets manager — never hardcode them.
- Commits are screened by pre-commit hooks (`gitleaks` + `detect-secrets`).
  If a real secret is ever pushed, **rotate it immediately**, then open a
  private advisory.

## Security best practices

- Rotate `JWT_SECRET`, MinIO credentials, DB passwords and
  `API_KEY_ENCRYPTION_SECRET` before any production deployment.
- Run with `WEB_REQUIRE_OPTIN`-style gates enabled where available; audit user
  API keys are encrypted at rest with AES-256-GCM.
- Use HTTPS/TLS in production; bind services to private networks.
- Review dependency upgrades with `pnpm audit` and `pip-audit` before merging.
