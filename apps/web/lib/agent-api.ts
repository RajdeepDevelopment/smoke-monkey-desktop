import { API_URL, getToken, nativeFetch } from './api';

export interface AgentSession {
  id: string;
  userId: string;
  agentId: string;
  title: string;
  status: string;
  workspacePath: string;
  messageCount: number;
  totalTokensInput: number;
  totalTokensOutput: number;
  totalCost: number;
  createdAt: string;
  updatedAt: string;
  /** Compacted-context snapshot persisted with the session. Contains
   *  activeSubContexts / activeContexts so the UI can restore the live
   *  context bar across refresh (ids + titles the FE has no catalog for). */
  contextSnapshot?: {
    activeSubContexts?: string[];
    activeContexts?: Array<{ id: string; title: string }>;
    [key: string]: unknown;
  } | null;
}

export interface AgentMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  /** Model reasoning/thinking stream ("Thought phase") captured during
   *  generation, shown in the UI as a foldable section. Never sent back
   *  to the model on later turns. */
  reasoning?: string | null;
  toolCalls?: Array<{
    id: string;
    toolName: string;
    arguments: unknown;
    status: string;
    output?: string;
    result?: unknown;
    error?: string;
    /** Live progress as streamed via tool.progress while the tool runs. */
    progress?: {
      kind: string;
      path?: string;
      percent?: number;
      bytesWritten?: number;
      bytesTotal?: number;
      lines?: number;
      linesTotal?: number;
      preview?: string;
      detail?: string;
    };
  }> | null;
  parentMessageId?: string | null;
  tokensInput: number;
  tokensOutput: number;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  sessionId: string;
  agentId: string;
  status: string;
  stepCount: number;
  maxSteps: number;
  tokensInput: number;
  tokensOutput: number;
  cost: number;
  durationMs: number;
  error?: string | null;
  checkpoint?: unknown;
  startedAt: string;
  updatedAt: string;
  completedAt?: string | null;
}

export interface AgentEvent {
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface FileTreeEntry {
  name: string;
  type: 'file' | 'directory';
  children?: FileTreeEntry[];
  path: string;
}

/** One chat that matched a content search, with up to 3 matching snippets. */
export interface ChatSearchResult {
  sessionId: string;
  title: string;
  agentId: string;
  updatedAt: string;
  matchCount: number;
  snippets: Array<{ content: string; createdAt: string; role: string }>;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  const token = getToken();
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

async function agentRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await nativeFetch(`${API_URL}${path}`, {
    ...options,
    headers: { ...headers(), ...options?.headers },
    credentials: 'include',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(body.message || res.statusText);
  }
  return res.json();
}

export const agentApi = {
  createSession: (agentId?: string, workspacePath?: string, title?: string) =>
    agentRequest<AgentSession>('/api/agent/sessions', {
      method: 'POST',
      body: JSON.stringify({ agentId, workspacePath, title }),
    }),

  listSessions: () =>
    agentRequest<AgentSession[]>('/api/agent/sessions'),

  getSession: (id: string) =>
    agentRequest<AgentSession>(`/api/agent/sessions/${id}`),

  /** Search the CONTENT of a user's chats (messages), returning the sessions
   *  that discussed the query. `q` can be empty → returns { results: [] }. */
  searchChats: (q: string) =>
    agentRequest<ChatSearchResult[]>(
      `/api/agent/sessions/search?q=${encodeURIComponent(q)}`,
    ),

  deleteSession: (id: string) =>
    agentRequest<{ status: string }>(`/api/agent/sessions/${id}`, { method: 'DELETE' }),

  getMessages: (sessionId: string) =>
    agentRequest<AgentMessage[]>(`/api/agent/sessions/${sessionId}/messages`),

  getOlderMessages: (sessionId: string, beforeCreatedAt: string, beforeId: string) =>
    agentRequest<{ messages: AgentMessage[]; hasMore: boolean }>(
      `/api/agent/sessions/${sessionId}/messages?beforeCreatedAt=${encodeURIComponent(beforeCreatedAt)}&beforeId=${encodeURIComponent(beforeId)}`,
    ),

  getRuns: (sessionId: string) =>
    agentRequest<AgentRun[]>(`/api/agent/sessions/${sessionId}/runs`),

  runAgent: (sessionId: string, message: string, options?: {
    agentId?: string;
    model?: string;
    provider?: string;
    workspacePath?: string;
    remoteProfileId?: string;
  }) =>
    agentRequest<{ status: string; sessionId: string }>(`/api/agent/sessions/${sessionId}/run`, {
      method: 'POST',
      body: JSON.stringify({ message, ...options }),
    }),

  interrupt: (sessionId: string) =>
    agentRequest<{ status: string }>(`/api/agent/sessions/${sessionId}/interrupt`, {
      method: 'POST',
    }),

  continueRun: (sessionId: string) =>
    agentRequest<{ status: string }>(`/api/agent/sessions/${sessionId}/continue`, {
      method: 'POST',
    }),

  streamEvents: async function* (sessionId: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const token = getToken();
    const url = `${API_URL}/api/agent/sessions/${sessionId}/events${token ? `?token=${token}` : ''}`;

    const res = await nativeFetch(url, {
      headers: { Accept: 'text/event-stream' },
      signal,
    });

    if (!res.ok || !res.body) {
      throw new Error(`Failed to connect to agent events: ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          let eventType = '';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) eventType = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (!data) continue;

          try {
            const parsed = JSON.parse(data);
            yield { type: parsed.type || eventType, timestamp: parsed.timestamp, data: parsed.data || parsed } as AgentEvent;
          } catch { /* skip malformed */ }
        }
      }

      // Flush trailing block
      if (buffer.trim()) {
        let eventType = '';
        let data = '';
        for (const line of buffer.trim().split('\n')) {
          if (line.startsWith('event:')) eventType = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (data) {
          try {
            const parsed = JSON.parse(data);
            yield { type: parsed.type || eventType, timestamp: parsed.timestamp, data: parsed.data || parsed } as AgentEvent;
          } catch { /* skip */ }
        }
      }
    } finally {
      reader.releaseLock();
    }
  },

  getTools: () =>
    agentRequest<Array<{ name: string; description: string; parameters: unknown }>>('/api/agent/tools'),

  getWorkspaceIndex: (workspacePath: string) =>
    agentRequest<{
      dbPath: string;
      workspaceId: string;
      files: number;
      symbols: number;
      imports: number;
      exports: number;
      lastBuilt: number;
      ready: boolean;
      error?: string;
    }>(`/api/agent/workspace-index?path=${encodeURIComponent(workspacePath)}`),

  getModels: () =>
    agentRequest<{ providers: Array<{ id: string; label: string; models: string[] }> }>('/api/agent/models'),

  getPermissions: (workspace: string) =>
    agentRequest<Array<{ id: string; tool: string; resource: string; effect: string; scope: string }>>(
      `/api/agent/permissions?workspace=${encodeURIComponent(workspace)}`,
    ),

  savePermission: (tool: string, resource: string, effect: string, scope: string) =>
    agentRequest<{ status: string }>('/api/agent/permissions', {
      method: 'POST',
      body: JSON.stringify({ tool, resource, effect, scope }),
    }),

  resolvePermission: (toolCallId: string, effect: 'allow' | 'deny') =>
    agentRequest<{ status: string }>(`/api/agent/permissions/${toolCallId}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ effect }),
    }),

  resolveAskUser: (toolCallId: string, response: string) =>
    agentRequest<{ status: string }>(`/api/agent/ask-user/${toolCallId}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ response }),
    }),

  resolveMcpDecision: (sessionId: string, toolCallId: string, action: 'enable' | 'add' | 'skip', names: string[]) =>
    agentRequest<{ status: string }>(`/api/agent/sessions/${sessionId}/mcp-resolve`, {
      method: 'POST',
      body: JSON.stringify({ toolCallId, action, names }),
    }),

  execTerminal: (command: string, cwd?: string) =>
    nativeFetch(`${API_URL}/api/agent/terminal/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers() },
      body: JSON.stringify({ command, cwd }),
    }).then((r) => r.json()),

  execDocker: (container: string, command: string, cwd?: string) =>
    nativeFetch(`${API_URL}/api/agent/docker/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers() },
      body: JSON.stringify({ container, command, cwd }),
    }).then((r) => r.json()),

  listDockerContainers: () =>
    nativeFetch(`${API_URL}/api/agent/docker/containers`, {
      headers: headers(),
    }).then((r) => r.json()),
};
