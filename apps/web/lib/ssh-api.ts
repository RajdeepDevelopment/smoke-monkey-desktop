import { API_URL, getToken, nativeFetch } from './api';

export type SshAuthMethod = 'key' | 'password' | 'agent';

export interface SshProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  remoteHome: string | null;
  strictHostKey: boolean;
  keyFingerprint: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SshExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface RemoteFileInfo {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size?: number;
  mtime?: string;
}

export interface ConnectorInfo {
  connector: string;
  label: string;
  destinations: { id: string; label: string; root?: string }[];
  error?: string;
}

export interface RemoteTreeNode {
  name: string;
  type: 'file' | 'directory';
  path: string;
  children?: RemoteTreeNode[];
}

export interface CreateSshProfileInput {
  name: string;
  host: string;
  port?: number;
  username?: string;
  authMethod?: SshAuthMethod;
  privateKey?: string;
  password?: string;
  remoteHome?: string;
  strictHostKey?: boolean;
}

async function request<T>(path: string, options: RequestInit = {}, timeoutMs = 20_000): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;

  // Hard client-side timeout so a slow/busy backend can never leave the UI
  // stuck on the "Connecting…" spinner. Uses Promise.race so it rejects in
  // both browser and Tauri (nativeFetch) transports even if abort is ignored.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const timeout = new Promise<Response>((_, reject) =>
    setTimeout(() => reject(new Error('Request timed out — the SSH host may be unreachable or too slow')), timeoutMs),
  );
  try {
    const res = await Promise.race([
      nativeFetch(`${API_URL}${path}`, { ...options, headers, signal: controller.signal }),
      timeout,
    ]);
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { message?: string };
      throw new Error(body.message || `Request failed (${res.status})`);
    }
    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timer);
  }
}

export const sshApi = {
  // ── Connector registry ──────────────────────────────────────────────────
  connectors: () => request<{ id: string; label: string }[]>('/api/ssh/connectors'),
  destinations: () => request<ConnectorInfo[]>('/api/ssh/destinations'),

  // ── Profiles ────────────────────────────────────────────────────────────
  listProfiles: () => request<SshProfile[]>('/api/ssh/profiles'),

  createProfile: (input: CreateSshProfileInput) =>
    request<{ id: string; name: string; host: string; port: number; username: string; authMethod: string }>(
      '/api/ssh/profiles',
      { method: 'POST', body: JSON.stringify(input) },
    ),

  deleteProfile: (id: string) =>
    request<{ status: string }>(`/api/ssh/profiles/${id}`, { method: 'DELETE' }),

  testProfile: (id: string) =>
    request<{ ok: boolean; detail?: string }>(`/api/ssh/profiles/${id}/test`, { method: 'POST' }),

  // ── Exec / terminal ─────────────────────────────────────────────────────
  exec: (id: string, command: string, cwd?: string) =>
    request<SshExecResult>('/api/ssh/exec', {
      method: 'POST',
      body: JSON.stringify({ id, command, cwd }),
    }),

  /**
   * Streams a remote command's output live over SSE, mirroring the agent/editor
   * event-stream pattern. Yields cumulative output snapshots as they arrive.
   */
  streamExec: async function* (id: string, command: string, signal?: AbortSignal): AsyncGenerator<{ type: 'output' | 'done' | 'error'; data: string }, void, unknown> {
    const token = getToken();
    const url = `${API_URL}/api/ssh/exec/stream?id=${encodeURIComponent(id)}&command=${encodeURIComponent(command)}${token ? `&token=${token}` : ''}`;
    const res = await nativeFetch(url, {
      headers: { Accept: 'text/event-stream' },
      signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`Failed to connect to SSH exec stream: ${res.status}`);
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
          if (!data || eventType === 'ping') continue;
          yield { type: (eventType === 'output' || eventType === 'done' || eventType === 'error') ? eventType : 'output', data } as const;
        }
      }
      if (buffer.trim()) {
        let eventType = '';
        let data = '';
        for (const line of buffer.trim().split('\n')) {
          if (line.startsWith('event:')) eventType = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (data && eventType !== 'ping') {
          yield { type: (eventType === 'output' || eventType === 'done' || eventType === 'error') ? eventType : 'output', data } as const;
        }
      }
    } finally {
      reader.releaseLock();
    }
  },

  // ── Remote file ops ─────────────────────────────────────────────────────
  fileTree: (id: string, remotePath = '~', depth = 2) =>
    request<RemoteTreeNode[]>(
      `/api/ssh/file-tree?id=${encodeURIComponent(id)}&path=${encodeURIComponent(remotePath)}&depth=${depth}`,
    ),

  listRemote: (id: string, remotePath = '~') =>
    request<RemoteFileInfo[]>(`/api/ssh/ls?id=${encodeURIComponent(id)}&path=${encodeURIComponent(remotePath)}`),

  readRemote: (id: string, remotePath: string) =>
    request<{ content: string; size: number; truncated: boolean }>(
      `/api/ssh/read?id=${encodeURIComponent(id)}&path=${encodeURIComponent(remotePath)}`,
    ),

  writeRemote: (id: string, remotePath: string, content: string) =>
    request<{ status: string }>('/api/ssh/write', {
      method: 'POST',
      body: JSON.stringify({ id, path: remotePath, content }),
    }),

  createRemote: (id: string, remotePath: string, type: 'file' | 'directory') =>
    request<{ status: string }>('/api/ssh/create', {
      method: 'POST',
      body: JSON.stringify({ id, path: remotePath, type }),
    }),

  renameRemote: (id: string, from: string, to: string) =>
    request<{ status: string }>('/api/ssh/rename', {
      method: 'POST',
      body: JSON.stringify({ id, from, to }),
    }),

  deleteRemote: (id: string, remotePath: string) =>
    request<{ status: string }>(`/api/ssh/path?id=${encodeURIComponent(id)}&path=${encodeURIComponent(remotePath)}`, {
      method: 'DELETE',
    }),

  gitStatus: (id: string, remotePath = '~') =>
    request<{
      isRepo: boolean;
      branch?: string;
      ahead?: number;
      behind?: number;
      entries: { path: string; origPath?: string; x: string; y: string; status: 'M' | 'A' | 'D' | 'U' | 'R' | 'C' }[];
    }>(`/api/ssh/git-status?id=${encodeURIComponent(id)}&path=${encodeURIComponent(remotePath)}`),
};
