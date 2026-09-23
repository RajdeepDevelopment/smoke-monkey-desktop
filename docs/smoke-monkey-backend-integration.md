# Smoke Monkey Backend Integration Guide

## Architecture

```
Code OSS Desktop (Electron)
    |
Smoke Monkey Agent Extension (extensions/smoke-monkey-agent/)
    | HTTP/SSE
Smoke Monkey API Gateway (apps/api-gateway/ :3000)
    |
+------------------+
| AgentService     | Main orchestrator (up to 1000 guarded steps, default maxSteps=100)
| LLM Integration  | NVIDIA/OpenAI/OpenRouter/Ollama/Gemini/xAI/OpenCode Zen/OmniRoute
| ToolRegistry     | 29 tools
| PermissionService| allow/deny/ask
| SessionService   | UUID sessions
| Event Emitter    | EventEmitter2
+------------------+
```

## Backend Entry
- File: `apps/api-gateway/src/main.ts`
- Port: 3000 (configurable via PORT env)
- Prefix: `/api`
- WebSocket: `/ws/agent` (via WsAdapter)
- Auth: JWT Bearer (JwtAuthGuard on agent endpoints)

## Key Endpoints

### Sessions
- POST `/api/agent/sessions` - create (body: agentId?, workspacePath?, title?)
- GET `/api/agent/sessions` - list
- GET `/api/agent/sessions/:id` - get
- DELETE `/api/agent/sessions/:id` - delete

### Agent Run
- POST `/api/agent/sessions/:id/run` - start (body: message, agentId?, model?, provider?, workspacePath?)
- POST `/api/agent/sessions/:id/interrupt` - interrupt
- POST `/api/agent/sessions/:id/continue` - resume

### Streaming (SSE)
- GET `/api/agent/sessions/:id/events` - SSE stream, 15s keepalive ping

### History
- GET `/api/agent/sessions/:id/messages`
- GET `/api/agent/sessions/:id/runs`
- GET `/api/agent/sessions/:id/file-changes`

### Permissions
- POST `/api/agent/permissions/:toolCallId/resolve` - body: {effect}
- POST `/api/agent/ask-user/:toolCallId/resolve` - body: {response}

### Metadata
- GET `/api/agent/tools`
- GET `/api/agent/models`
- GET `/api/agent/file-tree?path=`

## Event Protocol (SSE)

Defined in `apps/api-gateway/src/modules/agent/agent.protocol.ts`:

Event types:
- text.delta {messageId, delta} - streaming text token
- text.end {messageId, content, toolCalls?} - complete message
- tool.started {toolCallId, toolName, args} - tool call begins
- tool.output {toolCallId, output} - tool stdout/progress
- tool.completed {toolCallId, result} - tool finished OK
- tool.failed {toolCallId, error} - tool error
- permission.required {toolCallId, toolName, args} - needs user approval
- ask_user.required {toolCallId, question, options, multiple} - needs user input
- run.started {runId, sessionId} - run begins
- run.completed {runId, sessionId, status, tokens?} - run ends
- run.interrupted {runId, sessionId} - user interrupted
- run.failed {runId, sessionId, error} - run error
- step.started {step} - agent loop step
- step.ended {step} - agent loop step end
- llm.thinking {step} - LLM reasoning
- todo.updated {todos} - task list update
- ping {} - keepalive

## Available Tools (29 total)

### Filesystem
- read_file, write_file, edit_file, apply_patch, delete_file, list_directory

### Search
- glob, grep, find_symbol, search_code

### Terminal
- run_command (supports background, env, timeout up to 600s)
- run_test, docker_exec, docker_list

### Git
- git_status, git_diff, git_log

### Agent
- todo_write, ask_user

## Extension Integration (Current)

File: `extensions/smoke-monkey-agent/src/extension.ts`

- API_URL defaults to http://localhost:3000
- Creates session on activate via POST /api/agent/sessions
- Opens SSE stream via GET /api/agent/sessions/{id}/events
- Sends messages via POST /api/agent/sessions/{id}/run
- Handles all event types in _handleEvent()
- Permission/ask_user resolution via REST

## Gotchas
1. Extension currently sends NO JWT auth header (relies on guard bypass)
2. Two parallel transports exist (SSE + WebSocket)
3. ask_user resolution: REST expects {response}, WS expects {answer}
4. Session IDs are bare UUIDs
5. Streaming messageId is 'streaming' during stream, real ID only at text.end
