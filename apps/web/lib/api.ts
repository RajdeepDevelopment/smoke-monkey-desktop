import type {
  AuthResponseDto,
  ConversationDto,
  DocumentDto,
  MessageDto,
  MetricsSummaryDto,
  ModelsResponseDto,
  OmniRouteModelsResponseDto,
  OmniRouteRankedResponseDto,
  OmniRouteStatusDto,
  OnboardingStateDto,
  RetrieveResponseDto,
  UserKeyDto,
  UserKeysResponseDto,
  UserSettingsDto,
  SaveKeyResultDto,
  SecretSummaryDto,
  ListSecretsResponseDto,
  SaveSecretResultDto,
  HuggingFaceStatusDto,
  AgentSessionDto,
  AgentMessageDto,
  AgentRunDto,
  AgentEventDto,
  AgentToolDto,
  McpCreateResultDto,
  McpServersResponseDto,
  McpStockCatalogResponseDto,
  McpTestResultDto,
  McpOAuthStartResultDto,
  McpImportResultDto,
  ShareStatusDto,
  ShareConfigDto,
  TunnelStatusDto,
  DeployPagesResultDto,
} from '@rag/contracts';
import { streamSse } from './sse';

/**
 * API base. When served from the gateway itself (static web build + tunnel
 * sharing, or a Cloudflare Pages deploy proxying /api), a relative base keeps
 * all requests same-origin. The desktop shell overrides this via
 * NEXT_PUBLIC_API_URL when the UI and gateway live on different origins, and
 * its Rust proxy ignores the host anyway.
 */
export const API_URL = process.env.NEXT_PUBLIC_API_URL || '';

const TOKEN_KEY = 'rag_token';

function isTauri(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  );
}

let _invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;
async function getInvoke() {
  if (_invoke) return _invoke;
  const mod = await import('@tauri-apps/api/core');
  _invoke = mod.invoke as (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  return _invoke;
}

export async function nativeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!isTauri()) return fetch(input, init);

  const invoke = await getInvoke();
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const path = url.replace(API_URL, '').replace(/^https?:\/\/[^\/]+/, '');
  const token = getToken();

  const headers: Record<string, string> = {};
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((v, k) => { headers[k] = v; });
    } else if (Array.isArray(init.headers)) {
      init.headers.forEach(([k, v]) => { headers[k] = v; });
    } else {
      Object.assign(headers, init.headers);
    }
  }
  if (token && !headers.authorization) headers.authorization = `Bearer ${token}`;

  let body: string | undefined;
  if (init?.body && typeof init.body === 'string') {
    body = init.body;
  }

  // Check if this is a streaming request (SSE)
  const isStreaming = headers['accept'] === 'text/event-stream' ||
    headers['Accept'] === 'text/event-stream';

  if (isStreaming) {
    return nativeFetchStreaming(invoke, path, init?.method || 'GET', headers, body || null, init?.signal || undefined);
  }

  const result = await invoke('proxy_fetch', {
    req: {
      url: path,
      method: init?.method || 'GET',
      headers,
      body: body || null,
    },
  }) as { status: number; headers: Record<string, string>; body: string };

  return new Response(result.body, {
    status: result.status,
    statusText: result.status >= 400 ? 'Error' : 'OK',
    headers: new Headers(result.headers),
  });
}

async function nativeFetchStreaming(
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
  path: string,
  method: string,
  headers: Record<string, string>,
  body: string | null,
  signal?: AbortSignal,
): Promise<Response> {
  const streamId = `stream_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Set up event listeners BEFORE invoking the Rust command
  const mod = await import('@tauri-apps/api/event');
  const { listen } = mod;

  let headerData: string | null = null;
  const dataChunks: string[] = [];
  let resolveHeaders: (() => void) | null = null;
  let resolveData: (() => void) | null = null;
  let resolveDone: (() => void) | null = null;
  let rejectAll: ((err: Error) => void) | null = null;

  const cleanup = async () => {
    unlistenHeaders();
    unlistenData();
    unlistenDone();
    unlistenError();
  };

  const unlistenHeaders = await listen<{ stream_id: string; data: string }>('proxy-headers', (e) => {
    if (e.payload.stream_id !== streamId) return;
    headerData = e.payload.data;
    resolveHeaders?.();
  });

  const unlistenData = await listen<{ stream_id: string; data: string }>('proxy-data', (e) => {
    if (e.payload.stream_id !== streamId) return;
    dataChunks.push(e.payload.data);
    resolveData?.();
  });

  const unlistenDone = await listen<{ stream_id: string }>('proxy-done', (e) => {
    if (e.payload.stream_id !== streamId) return;
    resolveDone?.();
  });

  const unlistenError = await listen<{ stream_id: string; message: string }>('proxy-error', (e) => {
    if (e.payload.stream_id !== streamId) return;
    rejectAll?.(new Error(e.payload.message));
  });

  // Handle abort
  if (signal) {
    signal.addEventListener('abort', () => {
      rejectAll?.(new Error('Aborted'));
    });
  }

  // Invoke the streaming proxy (returns immediately with headers)
  const resultPromise = invoke('proxy_fetch_streaming', {
    req: { url: path, method, headers, body: body || null },
    // Tauri v2 matches camelCase JS keys to snake_case Rust params
    streamId,
  }) as Promise<{ status: number; headers: Record<string, string> }>;

  // Wait for headers
  await new Promise<void>((resolve, reject) => {
    resolveHeaders = resolve;
    rejectAll = reject;
    // Surface real proxy errors (e.g. gateway down) instead of waiting for the generic header timeout
    resultPromise.catch((err) => reject(err instanceof Error ? err : new Error(String(err))));
    // Timeout fallback — generous enough for a cold-starting local gateway
    setTimeout(() => reject(new Error('Stream header timeout')), 60000);
  });

  const result = await resultPromise;

  // Create a ReadableStream that yields chunks as they arrive
  let dataResolve: (() => void) | null = null;
  const stream = new ReadableStream({
    start(controller) {
      // Push initial header data as the first chunk (for SSE parser)
      if (headerData) {
        controller.enqueue(new TextEncoder().encode(headerData));
      }

      // Continuously drain data chunks
      const drain = () => {
        while (dataChunks.length > 0) {
          const chunk = dataChunks.shift()!;
          controller.enqueue(new TextEncoder().encode(chunk));
        }
      };

      // Poll for data
      const interval = setInterval(() => {
        drain();
      }, 10);

      resolveDone = async () => {
        drain();
        clearInterval(interval);
        try { controller.close(); } catch {}
        await cleanup();
      };

      rejectAll = async (err: Error) => {
        clearInterval(interval);
        try { controller.error(err); } catch {}
        await cleanup();
      };

      // Also listen for data events to drain immediately
      const origResolveData = resolveData;
      resolveData = () => {
        drain();
        origResolveData?.();
      };
    },
  });

  // Parse status from the raw HTTP header string
  let status = result.status || 200;
  const hdr = headerData as string | null;
  if (hdr) {
    const firstLine = hdr.split('\r\n')[0] || '';
    const match = firstLine.match(/HTTP\/\d\.\d\s+(\d+)/);
    if (match) status = parseInt(match[1], 10);
  }

  return new Response(stream, {
    status,
    statusText: status >= 400 ? 'Error' : 'OK',
    headers: new Headers(result.headers),
  });
}

export interface AgentAsset {
  ok: boolean;
  name: string;
  path: string;
  mime: string;
  size: number;
  b64: string;
}

/** Fetch a generated agent asset (PDF/PPT/image/any file) as base64 through the
 *  same transport the rest of the app uses (Tauri proxy in the desktop app,
 *  plain fetch in the browser build) so file cards / image previews / downloads
 *  work in both. */
export async function fetchAgentAsset(filePath: string): Promise<AgentAsset> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await nativeFetch(
    `${API_URL}/api/agent/file/asset?path=${encodeURIComponent(filePath)}`,
    { headers, credentials: 'include' },
  );
  if (!res.ok) throw new ApiError(`Asset load failed (${res.status})`, res.status);
  const body = (await res.json()) as Partial<AgentAsset>;
  if (!body?.ok || !body.b64) throw new Error('Asset not readable');
  return body as AgentAsset;
}

/** Decode an agent asset to a Blob (browser-safe, works off base64). */
export function agentAssetToBlob(asset: AgentAsset): Blob {
  const bin = atob(asset.b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: asset.mime || 'application/octet-stream' });
}

/** Lightweight existence + metadata probe — no base64 payload. */
export interface AgentAssetProbe {
  ok: boolean;
  name: string;
  path: string;
  mime: string;
  size: number;
}

export async function probeAgentAsset(filePath: string): Promise<AgentAssetProbe> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await nativeFetch(
    `${API_URL}/api/agent/file/asset?path=${encodeURIComponent(filePath)}&probe=1`,
    { headers, credentials: 'include' },
  );
  if (!res.ok) throw new ApiError(`Asset probe failed (${res.status})`, res.status);
  const body = (await res.json()) as Partial<AgentAssetProbe>;
  if (!body?.ok) throw new Error('Asset not found');
  return body as AgentAssetProbe;
}

/** Trigger a client-side download of an agent asset. */
export function downloadAgentAsset(asset: AgentAsset): void {
  const blob = agentAssetToBlob(asset);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = asset.name || 'asset';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, options: RequestInit = {}, retries = 2): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await nativeFetch(`${API_URL}${path}`, {
        ...options,
        headers,
        credentials: 'include',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { message?: string };
        throw new ApiError(body.message || res.statusText, res.status);
      }
      return res.json() as Promise<T>;
    } catch (err) {
      lastErr = err;
      if (err instanceof ApiError) throw err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
    }
  }
  if (lastErr instanceof Error && lastErr.message === 'Load failed') {
    throw new ApiError('Cannot reach the API server. Make sure the backend is running.', 0);
  }
  throw lastErr instanceof Error ? lastErr : new ApiError('Unknown network error', 0);
}

export const api = {
  // auth
  register: (email: string, name: string, password: string) =>
    request<AuthResponseDto>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, name, password }),
    }),
  login: (email: string, password: string) =>
    request<AuthResponseDto>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  logout: () =>
    request<{ status: string }>('/api/auth/logout', { method: 'POST' }),
  me: () => request<{ user: { id: string; email: string } }>('/api/auth/me', { method: 'POST' }),

  // documents
  uploadDocument: async (file: File) => {
    const form = new FormData();
    form.append('file', file);
    const headers: Record<string, string> = {};
    const token = getToken();
    if (token) headers.authorization = `Bearer ${token}`;
    try {
      const res = await nativeFetch(`${API_URL}/api/documents/upload`, {
        method: 'POST',
        body: form,
        headers,
        credentials: 'include',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new ApiError(body.message || res.statusText, res.status);
      }
      return res.json() as Promise<DocumentDto>;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError('Cannot reach the API server.', 0);
    }
  },
  listDocuments: () => request<DocumentDto[]>('/api/documents'),
  deleteDocument: (id: string) =>
    request<{ status: string }>(`/api/documents/${id}`, { method: 'DELETE' }),

  // conversations
  listConversations: () => request<ConversationDto[]>('/api/conversations'),
  createConversation: (title?: string) =>
    request<ConversationDto>('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),
  getMessages: (conversationId: string) =>
    request<MessageDto[]>(`/api/conversations/${conversationId}/messages`),
  deleteConversation: (id: string) =>
    request<{ status: string }>(`/api/conversations/${id}`, { method: 'DELETE' }),

  // chat (SSE)
  streamChat: async function* (
    message: string,
    conversationId: string | undefined,
    signal: AbortSignal,
    provider?: string,
    model?: string,
    documentIds?: string[],
  ) {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'accept': 'text/event-stream' };
    const token = getToken();
    if (token) headers.authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await nativeFetch(`${API_URL}/api/chat/stream`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ message, conversationId, provider, model, documentIds }),
        signal,
        credentials: 'include',
      });
    } catch {
      throw new ApiError('Cannot reach the API server.', 0);
    }
    yield* streamSse(res, signal);
  },

  // models
  fetchModels: () => request<ModelsResponseDto>('/api/models'),
  fetchOmniRouteModels: () => request<OmniRouteModelsResponseDto>('/api/models/omniroute'),
  fetchOmniRouteRanked: () => request<OmniRouteRankedResponseDto>('/api/models/omniroute/ranked'),
  fetchOpenRouterModels: () => request<OmniRouteModelsResponseDto>('/api/models/openrouter'),

  // OmniRoute provisioning lifecycle (drives the "Initializing OmniRoute…" UI)
  fetchOmniRouteStatus: () => request<OmniRouteStatusDto>('/api/settings/omniroute/status'),

  // playground (retrieval only, no generation)
  playgroundRetrieve: (payload: {
    message: string;
    mode?: string;
    provider?: string;
    model?: string;
    documentIds?: string[];
  }) =>
    request<RetrieveResponseDto>('/api/playground/retrieve', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // analytics (Redis telemetry summary)
  analyticsMetrics: () => request<MetricsSummaryDto>('/api/analytics/metrics'),

  // system health (public)
  health: () =>
    nativeFetch(`${API_URL}/api/health`, { credentials: 'include' }).then((res) =>
      res.json().catch(() => ({ status: 'unknown' })) as Promise<{
        status: string;
        postgres?: boolean;
        redis?: boolean;
        nats?: boolean;
      }>,
    ).catch(() => ({ status: 'unreachable' } as { status: string })),

  // provider API keys (OpenRouter, NVIDIA, ...) — per user, encrypted on server
  listKeys: () => request<UserKeysResponseDto>('/api/keys'),
  saveKey: (provider: string, apiKey: string) =>
    request<SaveKeyResultDto>(`/api/keys/${provider}`, {
      method: 'PUT',
      body: JSON.stringify({ apiKey }),
    }),
  deleteKey: (provider: string) =>
    request<{ status: string }>(`/api/keys/${provider}`, { method: 'DELETE' }),
  testKey: (provider: string) =>
    request<{ status: string; info: SaveKeyResultDto['info'] }>(`/api/keys/${provider}/test`, {
      method: 'POST',
    }),

  // Secret Manager — named encrypted secrets (Hugging Face token, …).
  // Per user, AES-256-GCM on the server; values are never returned.
  listSecrets: () => request<ListSecretsResponseDto>('/api/secrets'),
  saveSecret: (name: string, value: string) =>
    request<SaveSecretResultDto>(`/api/secrets/${name}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    }),
  deleteSecret: (name: string) =>
    request<{ status: string }>(`/api/secrets/${name}`, { method: 'DELETE' }),
  testSecret: (name: string) =>
    request<{ status: string }>(`/api/secrets/${name}/test`, { method: 'POST' }),
  fetchHuggingFaceStatus: () =>
    request<HuggingFaceStatusDto>('/api/secrets/huggingface/status'),

  // user feature settings (web search + OmniRoute opt-in)
  fetchSettings: () => request<UserSettingsDto>('/api/settings'),
  setWebSearchEnabled: (enabled: boolean) =>
    request<Pick<UserSettingsDto, 'webSearch'>>('/api/settings/web-search', {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),
  setOmniRouteEnabled: (enabled: boolean) =>
    request<Pick<UserSettingsDto, 'omniroute'>>('/api/settings/omniroute', {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),

  // first-run onboarding state
  fetchOnboarding: () => request<OnboardingStateDto>('/api/settings/onboarding'),
  setOnboardingCompleted: () =>
    request<OnboardingStateDto>('/api/settings/onboarding', { method: 'PUT' }),

  // ── Agent ──────────────────────────────────────────────────────────────────
  agentCreateSession: (agentId?: string, workspacePath?: string, title?: string) =>
    request<AgentSessionDto>('/api/agent/sessions', {
      method: 'POST',
      body: JSON.stringify({ agentId, workspacePath, title }),
    }),
  agentListSessions: () => request<AgentSessionDto[]>('/api/agent/sessions'),
  agentGetSession: (id: string) => request<AgentSessionDto>(`/api/agent/sessions/${id}`),
  agentDeleteSession: (id: string) =>
    request<{ status: string }>(`/api/agent/sessions/${id}`, { method: 'DELETE' }),
  agentGetMessages: (sessionId: string) =>
    request<AgentMessageDto[]>(`/api/agent/sessions/${sessionId}/messages`),
  agentGetRuns: (sessionId: string) =>
    request<AgentRunDto[]>(`/api/agent/sessions/${sessionId}/runs`),
  agentRun: (sessionId: string, message: string, opts?: { agentId?: string; model?: string; provider?: string; workspacePath?: string }) =>
    request<{ status: string; sessionId: string }>(`/api/agent/sessions/${sessionId}/run`, {
      method: 'POST',
      body: JSON.stringify({ message, ...opts }),
    }),
  agentInterrupt: (sessionId: string) =>
    request<{ status: string }>(`/api/agent/sessions/${sessionId}/interrupt`, { method: 'POST' }),
  agentContinue: (sessionId: string) =>
    request<{ status: string }>(`/api/agent/sessions/${sessionId}/continue`, { method: 'POST' }),
  agentStreamEvents: (sessionId: string, onEvent: (e: AgentEventDto) => void): EventSource => {
    const token = getToken();
    const url = `${API_URL}/api/agent/sessions/${sessionId}/events${token ? `?token=${token}` : ''}`;
    const es = new EventSource(url);
    es.onmessage = (msg) => {
      try { onEvent(JSON.parse(msg.data) as AgentEventDto); } catch { /* ignore */ }
    };
    return es;
  },
  agentGetTools: () => request<AgentToolDto[]>('/api/agent/tools'),

  // ── MCP Servers ──────────────────────────────────────────────────────────
  listMcpServers: () =>
    request<McpServersResponseDto>('/api/mcp'),
  listMcpStockCatalog: () =>
    request<McpStockCatalogResponseDto>('/api/mcp/stock'),
  createMcpServer: (data: { name: string; description?: string; transport?: 'stdio' | 'http'; command: string; args?: string[]; env?: Record<string, string>; url?: string; enabled?: boolean; oauthClientId?: string; oauthClientSecret?: string; oauthScopes?: string; apiToken?: string; icon?: string; category?: string; tags?: string[] }) =>
    request<McpCreateResultDto>('/api/mcp', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  createMcpServersBatch: (servers: Array<{ name: string; description?: string; transport?: 'stdio' | 'http'; command?: string; args?: string[]; env?: Record<string, string>; url?: string; enabled?: boolean; oauthClientId?: string; oauthClientSecret?: string; oauthScopes?: string; apiToken?: string; icon?: string; category?: string; tags?: string[] }>) =>
    request<{ created: Array<{ id: string; name: string; transport: string; needsSetup: boolean }>; skipped: Array<{ name: string; reason: string }> }>('/api/mcp/create-many', {
      method: 'POST',
      body: JSON.stringify({ servers }),
    }),
  updateMcpServer: (id: string, data: { name?: string; description?: string; transport?: 'stdio' | 'http'; command?: string; args?: string[]; env?: Record<string, string>; url?: string; enabled?: boolean; oauthClientId?: string; oauthClientSecret?: string; oauthScopes?: string; apiToken?: string; icon?: string; category?: string; tags?: string[] }) =>
    request<{ id: string; name: string }>(`/api/mcp/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  importMcpServers: (payload: unknown) =>
    request<McpImportResultDto>('/api/mcp/import', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  deleteMcpServer: (id: string) =>
    request<{ status: string }>(`/api/mcp/${id}`, { method: 'DELETE' }),
  testMcpServer: (id: string) =>
    request<McpTestResultDto>(`/api/mcp/${id}/test`, { method: 'POST' }),
  startMcpOAuth: (id: string) =>
    request<McpOAuthStartResultDto>(`/api/mcp/${id}/oauth/start`, { method: 'POST' }),
  disconnectMcpOAuth: (id: string) =>
    request<{ status: string }>(`/api/mcp/${id}/oauth/disconnect`, { method: 'POST' }),

  // ── Share / Hosting (Cloudflare) ────────────────────────────────────────
  getShareStatus: () =>
    request<ShareStatusDto>('/api/share'),
  getShareConfig: () =>
    request<ShareConfigDto>('/api/share/config'),
  updateShareConfig: (data: {
    projectName?: string;
    accountId?: string;
    apiToken?: string;
    tunnelHostname?: string;
    tunnelId?: string;
    outputDir?: string;
    pagesProjectName?: string;
  }) =>
    request<ShareConfigDto>('/api/share/config', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  startQuickTunnel: (url?: string) =>
    request<TunnelStatusDto>('/api/share/tunnel/start', {
      method: 'POST',
      body: JSON.stringify(url ? { url } : {}),
    }),
  stopQuickTunnel: () =>
    request<TunnelStatusDto>('/api/share/tunnel/stop', { method: 'POST' }),
  startPersistentTunnel: () =>
    request<TunnelStatusDto>('/api/share/tunnel/persistent/start', { method: 'POST' }),
  stopPersistentTunnel: () =>
    request<TunnelStatusDto>('/api/share/tunnel/persistent/stop', { method: 'POST' }),
  deployToPages: (projectName?: string) =>
    request<DeployPagesResultDto>('/api/share/deploy/pages', {
      method: 'POST',
      body: JSON.stringify(projectName ? { projectName } : {}),
    }),
  wranglerLogin: () =>
    request<{ ok: boolean; output?: string; error?: string }>('/api/share/wrangler/login', { method: 'POST' }),
  wranglerLogout: () =>
    request<{ ok: boolean; output?: string; error?: string }>('/api/share/wrangler/logout', { method: 'POST' }),
};
