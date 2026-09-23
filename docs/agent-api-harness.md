# Agent API Harness

Smoke Monkey Desktop ships a production-grade **agent API harness** — the same
runtime that powers autonomous coding agents like OpenAI Codex, Google
Antigravity, and Claude Code's cloud harness. You give it a workspace, a task,
and a model provider; it plans, edits files, runs commands, asks for permission,
verifies its work, and streams everything back in real time.

Two ways to drive it:

1. **REST + Server-Sent Events (SSE)** — stateless, ideal for servers & scripts.
2. **WebSocket** (`/ws/agent`) — the same events, realtime push.

Both are JSON, JWT-authenticated, and share one event schema.

---

## Quick start (HTTP)

```bash
API=http://localhost:8642/api            # desktop (SQLite) | compose mode: :3000
TOKEN=$(curl -s -X POST $API/auth/login -H 'content-type: application/json' \
  -d '{"email":"demo@rag.local","password":"..."}' | jq -r .accessToken)

SESSION=$(curl -s -X POST $API/agent/sessions \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"workspacePath":"/path/to/repo}"' | jq -r .id)

# Start a run — it returns immediately; follow the SSE stream for progress.
curl -N -X POST $API/agent/sessions/$SESSION/run \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"message":"Add a /health endpoint and its test","provider":"nvidia","model":"nvidia/nemotron-3-nano-30b-a3b:free"}'

curl -N $API/agent/sessions/$SESSION/events \
  -H "authorization: Bearer $TOKEN"
# -> event: text.delta / tool.started / tool.completed / run.completed ...
```

---

## Endpoints

Base path `/api/agent`, global JWT prefix `/api`, gateway port `8642`
(desktop) or `3000` (Docker Compose).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/agent/sessions` | create a session (agent, workspace) |
| `GET` | `/agent/sessions` | list my sessions |
| `GET` | `/agent/sessions/search?q=` | full-text search inside messages |
| `GET` / `DELETE` | `/agent/sessions/:id` | fetch / delete a session |
| `POST` | `/agent/sessions/:id/run` | **start a run** `{message, model?, provider?, workspacePath?, remoteProfileId?}` |
| `POST` | `/agent/sessions/:id/interrupt` | abort the active run |
| `POST` | `/agent/sessions/:id/continue` | resume from the last checkpoint |
| `GET` | `/agent/sessions/:id/messages` | message history (paged via `beforeId`/`beforeCreatedAt`) |
| `GET` | `/agent/sessions/:id/runs` | run records for a session |
| `GET` | `/agent/runs/:id/checkpoint` | full persisted agent state |
| `GET` | `/agent/sessions/:id/file-changes` | files the agent wrote/edited |
| `GET` | `/agent/sessions/:id/events` | **SSE stream** (all live events) |
| `POST` | `/agent/sessions/:id/explore` | spawn a disposable sub-agent "explorer" |
| `POST` | `/agent/sessions/:id/compact` | summarize & compact long history |
| `GET` | `/agent/compaction/check/:id` | whether compaction is needed |
| `POST` | `/agent/sessions/:id/mcp-resolve` | resolve MCP approval `enable`/`add`/`skip` |
| `POST` | `/agent/permissions` / `GET` | persist/read allow-deny-ask rules |
| `POST` | `/agent/permissions/:toolCallId/resolve` | approve/deny a pending tool call |
| `POST` | `/agent/ask-user/:toolCallId/resolve` | answer an `ask_user` request |
| `GET` | `/agent/tools` | full tool schemas (29 tools) |
| `GET` | `/agent/models` | providers + model catalog (tiered paid/key/keyless) |
| `GET` | `/agent/workspace-index?path=` | code index stats (files, symbols, imports) |
| `GET` | `/agent/file/read` · `/agent/file/asset` · `POST /agent/file/write` | file IO |
| `GET` | `/agent/git/diff` | `git diff HEAD` for the workspace |
| `POST` | `/agent/search` | ripgrep code search across the repo |
| `POST` | `/agent/terminal/exec` · `/agent/docker/exec` | run shell / container commands |
| `GET` | `/agent/docker/containers` | list docker containers |

### Workspace API (same `/api/agent` prefix)

File tree, read/write/rename/delete, reveal-in-finder, git status/diff/stage/
discard/init/commit/fetch/pull/push/stash/branch — powering the IDE-style
workspace panel and the agent's file operations.

---

## SSE events

`GET /api/agent/sessions/:id/events` streams `event_name` frames every 15 s a
`ping` keepalive. The full catalog:

| Event | When |
|---|---|
| `llm.thinking` | model planning step started |
| `text.delta` / `text.thought` | live streaming output + reasoning ("thought") |
| `text.end` | a completed assistant message |
| `context.updated` | active context groups changed |
| `tool.started` / `tool.output` / `tool.progress` / `tool.completed` / `tool.failed` | tool lifecycle |
| `permission.required` | agent blocked on a rule; resolve via REST |
| `ask_user.required` / `ask_user.response` | agent asked the user a question |
| `mcp.stock` / `mcp.approval_required` / `mcp.resolved` | MCP recommendations & approvals |
| `step.started` / `step.ended` | agent-loop step framing |
| `todo.updated` | plan todo list changed |
| `phase.changed` / `agent.state` | task phase or full state snapshot |
| `run.started` / `run.completed` / `run.interrupted` / `run.failed` | run lifecycle |

---

## WebSocket

`ws://localhost:8642/ws/agent?token=<JWT>`

Client → server messages:

| Type | Payload |
|---|---|
| `subscribe` | `{sessionId}` |
| `unsubscribe` | — |
| `run` | `{sessionId, message, workspacePath?, remoteProfileId?}` |
| `interrupt` | `{sessionId}` |
| `resolve_permission` | `{toolCallId, effect: 'allow'\|'deny'}` |
| `resolve_ask_user` | `{toolCallId, answer}` |
| `get_messages` / `get_state` | message / agent-state replay |
| `create_session` | `{workspacePath?, title?}` |

Server pushes the same event types as SSE (`text.delta`, `tool.*`, `run.*`,
…). Heartbeat ping every 30 s.

---

## The agent loop

A run executes up to **1000 guarded steps** (default `maxSteps` 100):

1. Build run context + conversation; compact history if over budget.
2. Call the LLM with retry/backoff (3x, exponential) for the chosen provider.
3. Parse tool calls → **ToolGate** (phase/task allowlist) → **permissions**.
4. Execute tools (parallel when read-only) and stream progress.
5. Guards: empty-response backoff, degenerate-repeat detection, doom-loop /
   repeated-error stop, no-tool streaks, verification & final-report checks.
6. Persist checkpoint; finish or loop.

Provider errors are normalized to calm, model-named chat cards — e.g. a 429
rate limit renders as *"Model \`nvidia/nemotron-3-nano-30b-a3b\` is rate-limited
(429)"* — not raw JSON.

## Tools

29 built-in tool schemas exposed via `GET /api/agent/tools`:

`read_file`, `write_file`, `edit_file`, `line_edit`, `replace_lines`,
`apply_patch`, `delete_file`, `list_directory`, `inspect`, `glob`, `grep`,
`find_symbol`, `search_code`, `run_command`, `run_test`, `docker_exec`,
`docker_list`, `git_status`, `git_diff`, `git_log`, `ask_user`, `finish_task`,
`todo_write`, `context_manage`, `ssh_run`, `secret_manager`, `add_mcp_server`,
`inspect_mcp_stock`, `request_mcp_approval`.

MCP servers add more as `<server>__<tool>` names at runtime.

## Providers & models

`GET /api/agent/models` returns the tiered catalog the run backend routes to:

| Provider | Tier | Example models |
|---|---|---|
| OpenAI | paid | `gpt-5.6-luna`, `gpt-4o`, `o3`, `o4-mini` |
| OpenRouter | paid + `:free` | `nvidia/nemotron-3-*:free`, `deepseek/deepseek-v4-*` |
| NVIDIA NIM | paid + `:free` | `nvidia/nemotron-3-nano-30b-a3b` |
| xAI (Grok) | paid | `grok-4.6`, `grok-3` |
| Google Gemini | key | `gemini-3.7-flash` … |
| OpenCode Zen | key | curated Zen ids |
| OmniRoute | keyless/free | live free catalog from the local gateway |
| Ollama | local | `qwen3:32b`, `qwen3:8b`, `qwen3:4b` |

User-held API keys are encrypted at rest (AES-256-GCM) and cached in Redis.

## Reliability & state

- **Checkpoints**: every context snapshot persisted; `continue` resumes cleanly.
- **Compaction**: token-budget-triggered LLM summarization of long sessions.
- **Sub-agents**: `/explore` fans out independent "explorer" runs on demand.
- **Permissions**: per-tool/resource allow-deny-ask rules, scoped per workspace.
- **Storage**: SQLite `~/.smokemonkey/smokemonkey.db` (desktop) or PostgreSQL.

## Desktop embedding

The Tauri app (`apps/desktop`) spawns the gateway (`node dist/main.js`,
port 8642) plus the Python RAG service (port 8643), so every feature above is
available locally with a GUI and the same API from the command line.