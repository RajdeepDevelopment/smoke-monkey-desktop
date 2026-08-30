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
}

export interface AgentMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: Array<{
    id: string;
    toolName: string;
    arguments: unknown;
    status: string;
    output?: string;
    result?: unknown;
    error?: string;
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

  deleteSession: (id: string) =>
    agentRequest<{ status: string }>(`/api/agent/sessions/${id}`, { method: 'DELETE' }),

  getMessages: (sessionId: string) =>
    agentRequest<AgentMessage[]>(`/api/agent/sessions/${sessionId}/messages`),

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

  getModels: () =>
    nativeFetch(`${API_URL}/api/models`).then(r => r.json()) as Promise<{ providers: Array<{ id: string; label: string; models: string[] }> }>,

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
