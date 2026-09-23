import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { McpServer } from './mcp-server.entity';
import {
  findStockEntry,
  AUTO_PROVISIONED_STOCK_SERVERS,
} from './mcp-stock';

/**
 * Repository root marker. The bundled agent-skills MCP server lives at
 * `<repo>/server/agent-skills/mcp/server.mjs`, so stdio stock entries may use
 * the `{SM_REPO_ROOT}` token in command/args; it is expanded at spawn time.
 */
function findRepoRoot(): string {
  let dir = resolve(__dirname);
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

let SM_REPO_ROOT: string | null = null;
function repoRoot(): string {
  if (!SM_REPO_ROOT) {
    // Desktop launcher sets SM_REPO_ROOT explicitly (packaged installs have no
    // pnpm-workspace.yaml to walk up to and cwd is the app bundle).
    SM_REPO_ROOT =
      (process.env.SM_REPO_ROOT && process.env.SM_REPO_ROOT.trim() ? process.env.SM_REPO_ROOT.trim() : null) ||
      findRepoRoot();
  }
  return SM_REPO_ROOT;
}

function expandStdioTokens(command: string, args: string[]): { command: string; args: string[] } {
  if (!command.includes('{SM_REPO_ROOT}') && !args.some((a) => a.includes('{SM_REPO_ROOT}'))) {
    return { command, args };
  }
  const root = repoRoot();
  return { command: command.replaceAll('{SM_REPO_ROOT}', root), args: args.map((a) => a.replaceAll('{SM_REPO_ROOT}', root)) };
}

/**
 * Known-deprecated stock recipes. Rows saved under these (command, args) pairs
 * are silently upgraded to the current stock-catalog recipe before they are
 * tested or activated, so servers added under an older config keep working
 * without requiring the user to re-add them.
 */
const LEGACY_STOCK_CONFIGS: Record<string, Array<{ command: string; args: string[] }>> = {
  amazon: [{ command: 'uvx', args: ['amazon-mcp'] }],
};

// ── MCP JSON-RPC client ────────────────────────────────────────────────────

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
}

export interface McpServerHandle {
  serverId: string;
  name: string;
  tools: McpToolDef[];
  callTool(toolName: string, args: Record<string, unknown>): Promise<McpToolResult>;
  close(): void;
  closed: boolean;
}

let rpcId = 0;

// ── Streamable-HTTP transport (for "http" MCP servers, e.g. Miro) ──────────

export interface McpOAuthMetadata {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
  /** Scopes advertised by the protected resource (not the auth server). */
  resourceScopes?: string[];
  tokenEndpointAuthMethods?: string[];
}

const HTTP_ACCEPT = 'application/json, text/event-stream';

async function parseMcpResponse(res: Response): Promise<Record<string, unknown>> {
  const ct = res.headers.get('content-type') ?? 'application/json';
  if (ct.includes('text/event-stream')) {
    const text = await res.text();
    let lastData: string | null = null;
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) lastData = line.slice(5).trim();
    }
    if (lastData) {
      try {
        return JSON.parse(lastData) as Record<string, unknown>;
      } catch {}
    }
    throw new Error(`Empty or unparseable SSE response from MCP server`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const msg = (json.error as Record<string, unknown> | undefined)?.message ?? String(json);
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  return json;
}

function createHttpClient(
  url: string,
  opts: {
    authToken?: string | null;
    onRefresh?: () => Promise<string>;
  },
  logger: Logger,
): Promise<McpServerHandle> {
  let sessionId: string | null = null;
  let closed = false;

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const handle: McpServerHandle = {
    serverId: '',
    name: '',
    tools: [],
    closed: false,
    async callTool(toolName: string, toolArgs: Record<string, unknown>): Promise<McpToolResult> {
      return sendRequest('tools/call', { name: toolName, arguments: toolArgs }) as Promise<McpToolResult>;
    },
    close() {
      if (closed) return;
      closed = true;
      handle.closed = true;
      for (const p of pending.values()) p.reject(new Error('client closed'));
      pending.clear();
    },
  };

  async function sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++rpcId;
    const msg = { jsonrpc: '2.0', id, method, params };
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: HTTP_ACCEPT,
      };
      if (sessionId) headers['mcp-session-id'] = sessionId;
      if (opts.authToken) headers.authorization = `Bearer ${opts.authToken}`;
      try {
        const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(msg) });
        if (res.status === 401 && attempt === 0 && opts.onRefresh) {
          opts.authToken = await opts.onRefresh();
          continue;
        }
        const json = await parseMcpResponse(res);
        if ('error' in json && json.error) {
          const e = json.error as Record<string, unknown>;
          throw new Error(`MCP error ${e.code}: ${e.message}`);
        }
        const sid = res.headers.get('mcp-session-id');
        if (sid) sessionId = sid;
        return json.result;
      } catch (err) {
        lastErr = err;
        if (err instanceof Error && err.message.includes('HTTP 401') && attempt === 0 && opts.onRefresh) {
          opts.authToken = await opts.onRefresh();
          continue;
        }
        throw err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async function sendNotification(method: string, params?: Record<string, unknown>): Promise<void> {
    const msg = { jsonrpc: '2.0', method, params: params ?? {} };
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: HTTP_ACCEPT,
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    if (opts.authToken) headers.authorization = `Bearer ${opts.authToken}`;
    await fetch(url, { method: 'POST', headers, body: JSON.stringify(msg) }).catch((): undefined => undefined);
  }

  return (async () => {
    try {
      await sendRequest('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'smoke-monkey', version: '0.1.0' },
      });
      await sendNotification('notifications/initialized');
      const toolsResult = (await sendRequest('tools/list', {})) as Record<string, unknown>;
      const toolsList = (toolsResult.tools ?? []) as Array<Record<string, unknown>>;
      handle.tools = toolsList.map((t) => ({
        name: String(t.name ?? ''),
        description: String(t.description ?? ''),
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object' },
      }));
      return handle;
    } catch (err) {
      handle.close();
      throw err;
    }
  })();
}

// ── OAuth for remote MCP servers ───────────────────────────────────────────

/**
 * Discover OAuth metadata for a remote MCP endpoint. Tries the well-known
 * resource-metadata document at several candidate locations:
 *   1. {url}/.well-known/oauth-protected-resource
 *   2. progressively strip path segments down to the host root
 *   3. the `resource_metadata` URL advertised in a 401 WWW-Authenticate header
 *      returned by the endpoint itself
 * Returns the authorization-server endpoints for the DCR + PKCE flow.
 */
/**
 * Discovery fallback for Google's hosted MCP servers (Drive, Docs, Gmail,
 * Calendar, Tasks, ...). Google does not publish oauth-protected-resource
 * metadata that is reachable anonymously, so the standard discovery always
 * fails. These endpoints are served behind Google's OAuth 2.0 server, whose
 * authorization-server metadata IS publicly fetchable via the OIDC discovery
 * document. Returns null for non-Google hosts so other providers keep their
 * regular well-known/401 discovery.
 */
export async function discoverGoogleMcpMetadata(url: string): Promise<McpOAuthMetadata | null> {
  let host: string;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
  const isGoogleMcp = host === 'googleapis.com' || host.endsWith('.googleapis.com');
  if (!isGoogleMcp) return null;

  const fallback: McpOAuthMetadata = {
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    registrationEndpoint: undefined,
    scopesSupported: ['openid'],
  };
  try {
    const res = await fetch('https://accounts.google.com/.well-known/openid-configuration', {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return fallback;
    const oidc = (await res.json()) as { authorization_endpoint?: string; token_endpoint?: string };
    return {
      authorizationEndpoint: oidc.authorization_endpoint ?? fallback.authorizationEndpoint,
      tokenEndpoint: oidc.token_endpoint ?? fallback.tokenEndpoint,
      registrationEndpoint: undefined, // Google has no DCR for personal accounts — user supplies client id/secret.
      scopesSupported: ['openid'],
    };
  } catch {
    return fallback;
  }
}

export async function discoverOAuthMetadata(url: string, logger: Logger): Promise<McpOAuthMetadata> {
  const normalized = url.replace(/\/+$/, '');
  const urlObj = new URL(normalized);
  const candidates: string[] = [];

  // 1) Full URL as-is: {url}/.well-known/oauth-protected-resource
  candidates.push(`${normalized}/.well-known/oauth-protected-resource`);

  // 2) Strip path segments one at a time down to origin.
  const segments = urlObj.pathname.split('/').filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const partial = segments.slice(0, i).join('/');
    const root = partial ? `${urlObj.origin}/${partial}` : urlObj.origin;
    candidates.push(`${root}/.well-known/oauth-protected-resource`);
  }
  // Host-root well-known (segments=0 case covered above via origin).

  let resourceUrl: string | null = null;
  for (const c of Array.from(new Set(candidates))) {
    try {
      const res = await fetch(c, { headers: { accept: 'application/json' }, redirect: 'follow' });
      if (!res.ok) continue;
      const body = (await res.json().catch((): unknown => null)) as
        | { authorization_servers?: string[]; scopes_supported?: string[]; resource?: string }
        | null;
      if (body && body.authorization_servers?.length) {
        resourceUrl = c;
        break;
      }
    } catch { continue; }
  }

  // 3) Fallback: probe the endpoint itself; read resource_metadata from 401.
  if (!resourceUrl && normalized.startsWith('http')) {
    try {
      const probe = await fetch(normalized, {
        method: 'POST',
        headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
          protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke-monkey', version: '0.1.0' },
        } }),
      });
      if (probe.status === 401) {
        const hint = probe.headers.get('www-authenticate') ?? '';
        const m = hint.match(/resource_metadata="([^"]+)"/);
        if (m?.[1]) {
          try {
            const res = await fetch(m[1], { headers: { accept: 'application/json' } });
            const body = await res.json() as { authorization_servers?: string[]; scopes_supported?: string[] };
            if (res.ok && body.authorization_servers?.length) resourceUrl = m[1];
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }

  if (!resourceUrl) {
    // Google's hosted MCP endpoints are not discoverable anonymously — use
    // their public OIDC authorization-server metadata instead.
    const googleMeta = await discoverGoogleMcpMetadata(url);
    if (googleMeta) return googleMeta;
    throw new Error(`OAuth not supported by ${url} (no resource metadata)`);
  }
  const resourceMeta = await fetch(resourceUrl, { headers: { accept: 'application/json' } });
  const resource = (await resourceMeta.json()) as { authorization_servers?: string[]; scopes_supported?: string[] };
  const authServer = resource.authorization_servers?.[0] ?? urlObj.origin;
  const authMeta = await fetch(`${authServer.replace(/\/+$/, '')}/.well-known/oauth-authorization-server`, {
    headers: { accept: 'application/json' },
  });
  if (!authMeta.ok) throw new Error(`No authorization server metadata at ${authServer}`);
  const meta = (await authMeta.json()) as Omit<McpOAuthMetadata, 'authorizationEndpoint' | 'tokenEndpoint'> & {
    authorization_endpoint?: string;
    token_endpoint?: string;
    registration_endpoint?: string;
    scopes_supported?: string[];
    token_endpoint_auth_methods_supported?: string[];
  };
  if (!meta.authorization_endpoint || !meta.token_endpoint) {
    throw new Error(`Authorization server ${authServer} missing endpoints`);
  }
  return {
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    registrationEndpoint: meta.registration_endpoint,
    scopesSupported: meta.scopes_supported,
    // Prefer the protected-resource scope list: providers such as Supabase and
    // Railway only accept their resource's scopes (not the auth server's).
    resourceScopes: resource.scopes_supported,
    tokenEndpointAuthMethods: meta.token_endpoint_auth_methods_supported,
  };
}

export async function registerOAuthClient(
  metadata: McpOAuthMetadata,
  redirectUri: string,
  logger: Logger,
): Promise<{ clientId: string; clientSecret: string }> {
  if (!metadata.registrationEndpoint) {
    throw new Error('Server does not support dynamic client registration');
  }
  const body = {
    client_name: 'smoke-monkey',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_post',
    scope: (metadata.resourceScopes ?? metadata.scopesSupported ?? []).filter((s) => !s.startsWith('openid')).join(' '),
  };
  const res = await fetch(metadata.registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as {
    client_id?: string;
    client_secret?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.client_id) {
    throw new Error(`DCR failed: ${json.error_description ?? json.error ?? `HTTP ${res.status}`}`);
  }
  return { clientId: json.client_id, clientSecret: json.client_secret ?? '' };
}

export function buildOAuthAuthorizeUrl(metadata: McpOAuthMetadata, opts: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scope?: string;
  pkceMethod?: string;
}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    code_challenge: opts.codeChallenge,
    code_challenge_method: opts.pkceMethod ?? 'S256',
    state: opts.state,
  });
  if (opts.scope) params.set('scope', opts.scope);
  const parts = metadata.authorizationEndpoint.split('?');
  const existing = new URLSearchParams(parts[1] ?? '');
  for (const [k, v] of params.entries()) existing.set(k, v);
  return `${parts[0]}?${existing.toString()}`;
}

export function generatePkce(): { verifier: string; challenge: string } {
  const { randomBytes, createHash } = require('crypto') as typeof import('crypto');
  const verifier = randomBytes(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export async function exchangeOAuthCode(metadata: McpOAuthMetadata, opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  verifier: string;
}): Promise<{ accessToken: string; refreshToken: string | null; expiresIn: number }> {
  const attempt = async (useSecret: boolean): Promise<Response> => {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: opts.code,
      redirect_uri: opts.redirectUri,
      client_id: opts.clientId,
      code_verifier: opts.verifier,
    });
    if (useSecret && opts.clientSecret) params.set('client_secret', opts.clientSecret);
    return fetch(metadata.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: params.toString(),
    });
  };
  const json = await postWithConfidentialFallback(attempt, (b) => b.access_token, 'Token exchange failed');
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresIn: json.expires_in ?? 3600,
  };
}

export async function refreshOAuthAccessTokenV2(metadata: McpOAuthMetadata, opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<{ accessToken: string; refreshToken: string | null; expiresIn: number }> {
  const attempt = async (useSecret: boolean): Promise<Response> => {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: opts.refreshToken,
      client_id: opts.clientId,
    });
    if (useSecret && opts.clientSecret) params.set('client_secret', opts.clientSecret);
    return fetch(metadata.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: params.toString(),
    });
  };
  const json = await postWithConfidentialFallback(attempt, (b) => b.access_token, 'Token refresh failed');
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? opts.refreshToken,
    expiresIn: json.expires_in ?? 3600,
  };
}

/**
 * POST to the token endpoint, first as a confidential client (secret in body).
 * Some providers (e.g. Railway) silently register DCR clients as PUBLIC
 * (`token_endpoint_auth_method: none`), so a `401 invalid_client` means we
 * must retry once without the secret (PKCE-only).
 */
async function postWithConfidentialFallback(
  attempt: (useSecret: boolean) => Promise<Response>,
  access: (b: any) => string | undefined,
  label: string,
): Promise<{ access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }> {
  let res = await attempt(true);
  if (res.status === 401) {
    const first = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
    const clientAuthFailed = /invalid_client/i.test(`${first.error ?? ''} ${first.error_description ?? ''}`);
    if (clientAuthFailed) {
      res = await attempt(false);
    } else {
      throw new Error(`${label}: ${first.error_description ?? first.error ?? `HTTP ${res.status}`}`);
    }
  }
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !access(json)) {
    throw new Error(`${label}: ${json.error_description ?? json.error ?? `HTTP ${res.status}`}`);
  }
  return json;
}

/**
 * Expand the child process PATH so spawned MCP executables (npx, uvx, docker…)
 * resolve even when the gateway was launched from a shell whose PATH omits the
 * user's local bin dirs (e.g. ~/.local/bin installed by `curl | sh`, or nvm).
 */
function buildChildEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const candidates = [
    '$HOME/.local/bin',
    '$HOME/.cargo/bin',
    '$HOME/bin',
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ]
    .map((p) => p.replace('$HOME', home))
    .filter(Boolean);

  const existing = (process.env.PATH || '').split(':').filter(Boolean);
  const merged = [...candidates, ...existing];
  const path = Array.from(new Set(merged)).join(':');

  return { ...process.env, ...env, PATH: path };
}

function createStdioClient(
  command: string,
  args: string[],
  env: Record<string, string>,
  logger: Logger,
): Promise<McpServerHandle> {
  const { command: cmd, args: argList } = expandStdioTokens(command, args);
  const fullEnv = buildChildEnv(env);
  const child = spawn(cmd, argList, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: fullEnv,
    shell: false,
  });

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let buffer = '';
  let closed = false;

  const handle: McpServerHandle = {
    serverId: '',
    name: '',
    tools: [],
    closed: false,
    async callTool(toolName: string, toolArgs: Record<string, unknown>): Promise<McpToolResult> {
      return sendRequest('tools/call', { name: toolName, arguments: toolArgs }) as Promise<McpToolResult>;
    },
    close() {
      if (closed) return;
      closed = true;
      handle.closed = true;
      try { child.kill(); } catch {}
      for (const p of pending.values()) p.reject(new Error('client closed'));
      pending.clear();
    },
  };

  function sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++rpcId;
      pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      try {
        child.stdin.write(msg + '\n');
      } catch (err) {
        pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  function sendNotification(method: string, params?: Record<string, unknown>): void {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} });
    try { child.stdin.write(msg + '\n'); } catch {}
  }

  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let nlIdx: number;
    while ((nlIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nlIdx).trim();
      buffer = buffer.slice(nlIdx + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if ('id' in parsed && parsed.id != null) {
          const id = Number(parsed.id);
          const p = pending.get(id);
          if (p) {
            pending.delete(id);
            if (parsed.error) {
              const errObj = parsed.error as Record<string, unknown>;
              p.reject(new Error(`MCP error ${errObj.code}: ${errObj.message}`));
            } else {
              p.resolve(parsed.result);
            }
          }
        }
      } catch {}
    }
  });

  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', (d: string) => {
    logger.debug(`[MCP stderr] ${d.slice(0, 300)}`);
  });

  child.on('close', (code) => {
    closed = true;
    handle.closed = true;
    logger.debug(`[MCP] process exited code=${code}`);
    for (const p of pending.values()) p.reject(new Error(`MCP process exited (${code})`));
    pending.clear();
  });

  child.on('error', (err) => {
    closed = true;
    handle.closed = true;
    logger.warn(`[MCP] spawn error: ${err.message}`);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  });

  // Initialize and list tools, then return the connected handle.
  return (async () => {
    try {
      await sendRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'smoke-monkey', version: '0.1.0' },
      });
      sendNotification('notifications/initialized');
      const toolsResult = (await sendRequest('tools/list', {})) as Record<string, unknown>;
      const toolsList = (toolsResult.tools ?? []) as Array<Record<string, unknown>>;
      handle.tools = toolsList.map((t) => ({
        name: String(t.name ?? ''),
        description: String(t.description ?? ''),
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object' },
      }));
      return handle;
    } catch (err) {
      handle.close();
      throw err;
    }
  })();
}

// ── Service ────────────────────────────────────────────────────────────────

const MAX_ACTIVE_MCP = 3;

export interface McpRuntime {
  /** Server id → handle map (populated lazily on activation). */
  handles: Map<string, McpServerHandle>;
  /** Tool name → server id lookup. */
  toolServerMap: Map<string, string>;
  /** All enabled server configs (name, description, id). */
  configs: Array<{ id: string; name: string; description: string; icon: string | null }>;
  /** Lazy-connect a server (spawn + init + tools/list). Returns existing handle if already connected. */
  activateServer(serverId: string): Promise<McpServerHandle>;
  /** Close all open handles. */
  closeAll(): void;
}

@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);

  /** In-memory PKCE/state registry for in-flight OAuth authorization flows. */
  private readonly pendingOAuth = new Map<string, {
    serverId: string;
    userId: string;
    metadata: McpOAuthMetadata;
    clientId: string;
    clientSecret: string;
    verifier: string;
    redirectUri: string;
    expiresAt: number;
  }>();

  constructor(
    @InjectRepository(McpServer)
    private readonly repo: Repository<McpServer>,
  ) {}

  // ── CRUD ────────────────────────────────────────────────────────────────

  async listServers(userId: string): Promise<McpServer[]> {
    return this.repo.find({ where: { userId }, order: { name: 'ASC' } });
  }

  async getServer(id: string, userId: string): Promise<McpServer | null> {
    return this.repo.findOne({ where: { id, userId } });
  }

  async createServer(userId: string, dto: {
    name: string;
    description?: string;
    transport?: 'stdio' | 'http';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    enabled?: boolean;
    oauthClientId?: string;
    oauthClientSecret?: string;
    oauthScopes?: string;
    apiToken?: string;
    icon?: string;
    category?: string;
    tags?: string[];
  }): Promise<McpServer> {
    const entity = this.repo.create({
      userId,
      name: dto.name,
      description: dto.description ?? '',
      transport: dto.transport ?? 'stdio',
      command: dto.command ?? '',
      argsJson: dto.args ? JSON.stringify(dto.args) : null,
      envJson: dto.env ? JSON.stringify(dto.env) : null,
url: dto.transport === 'http' ? (dto.url ?? null) : null,
    oauthClientId: dto.oauthClientId ?? null,
    oauthClientSecret: dto.oauthClientSecret ?? null,
    oauthScopes: dto.oauthScopes ?? null,
    apiToken: dto.transport === 'http' ? (dto.apiToken ?? null) : null,
    enabled: dto.enabled ?? true,
    icon: dto.icon ?? null,
    category: dto.category ?? null,
    tags: dto.tags?.length ? dto.tags : null,
    });
    return this.repo.save(entity);
  }

  async updateServer(id: string, userId: string, dto: {
    name?: string;
    description?: string;
    transport?: 'stdio' | 'http';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    enabled?: boolean;
    oauthClientId?: string;
    oauthClientSecret?: string;
    oauthScopes?: string;
    oauthAccessToken?: string;
    oauthRefreshToken?: string;
    oauthExpiresAt?: number;
    apiToken?: string;
    icon?: string;
    category?: string;
    tags?: string[];
  }): Promise<McpServer> {
    const entity = await this.repo.findOne({ where: { id, userId } });
    if (!entity) throw new Error(`MCP server ${id} not found`);
    if (dto.name !== undefined) entity.name = dto.name;
    if (dto.description !== undefined) entity.description = dto.description;
    if (dto.transport !== undefined) entity.transport = dto.transport;
    if (dto.command !== undefined) entity.command = dto.command;
    if (dto.args !== undefined) entity.argsJson = JSON.stringify(dto.args);
    if (dto.env !== undefined) entity.envJson = JSON.stringify(dto.env);
    if (dto.url !== undefined) entity.url = dto.transport === 'http' ? dto.url ?? null : entity.url;
    if (dto.enabled !== undefined) entity.enabled = dto.enabled;
    if (dto.oauthClientId !== undefined) entity.oauthClientId = dto.oauthClientId;
    if (dto.oauthClientSecret !== undefined) entity.oauthClientSecret = dto.oauthClientSecret;
    if (dto.oauthScopes !== undefined) entity.oauthScopes = dto.oauthScopes;
    if (dto.oauthAccessToken !== undefined) entity.oauthAccessToken = dto.oauthAccessToken;
    if (dto.oauthRefreshToken !== undefined) entity.oauthRefreshToken = dto.oauthRefreshToken;
    if (dto.oauthExpiresAt !== undefined) entity.oauthExpiresAt = dto.oauthExpiresAt ? String(dto.oauthExpiresAt) : null;
    if (dto.apiToken !== undefined) entity.apiToken = dto.apiToken?.trim() ? dto.apiToken.trim() : null;
    if (dto.icon !== undefined) entity.icon = dto.icon ?? null;
    if (dto.category !== undefined) entity.category = dto.category ?? null;
    if (dto.tags !== undefined) entity.tags = dto.tags?.length ? dto.tags : null;
    return this.repo.save(entity);
  }

  async deleteServer(id: string, userId: string): Promise<void> {
    await this.repo.delete({ id, userId });
  }

  /**
   * Bulk-imports validated MCP entries. Duplicate names are skipped, not
   * overwritten. Returns per-name results so the caller can surface them.
   */
  async importServers(userId: string, entries: Array<{
    name: string;
    description?: string;
    transport?: 'stdio' | 'http';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    icon?: string;
    oauthClientId?: string;
    oauthClientSecret?: string;
    oauthScopes?: string;
    apiToken?: string;
    category?: string;
    tags?: string[];
  }>): Promise<{ created: Array<{ id: string; name: string }>; skipped: Array<{ name: string; reason: string }> }> {
    const existing = await this.listServers(userId);
    const seen = new Set(existing.map((s) => s.name.trim().toLowerCase()));
    const created: Array<{ id: string; name: string }> = [];
    const skipped: Array<{ name: string; reason: string }> = [];
    for (const entry of entries) {
      if (seen.has(entry.name.trim().toLowerCase())) {
        skipped.push({ name: entry.name, reason: 'Already exists — skipped (no overwrite)' });
        continue;
      }
      const entity = await this.createServer(userId, entry);
      seen.add(entity.name.trim().toLowerCase());
      created.push({ id: entity.id, name: entity.name });
    }
    return { created, skipped };
  }

  /**
   * Batch-create servers (used by the agent's "add MCP" popup). Rejects items
   * that are missing required credentials when the server needs them (enabling
   * a server without keys/OAuth would brick it at activation time).
   */
  async createManyServers(
    userId: string,
    entries: Array<{
      name: string;
      description?: string;
      transport?: 'stdio' | 'http';
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      url?: string;
      enabled?: boolean;
      oauthClientId?: string;
      oauthClientSecret?: string;
      oauthScopes?: string;
      apiToken?: string;
      icon?: string;
      category?: string;
      tags?: string[];
    }>,
  ): Promise<{
    created: Array<{ id: string; name: string; transport: string; needsSetup: boolean }>;
    skipped: Array<{ name: string; reason: string }>;
  }> {
    const existing = await this.listServers(userId);
    const seen = new Set(existing.map((s) => s.name.trim().toLowerCase()));
    const created: Array<{ id: string; name: string; transport: string; needsSetup: boolean }> = [];
    const skipped: Array<{ name: string; reason: string }> = [];

    for (const entry of entries) {
      const lowerName = entry.name.trim().toLowerCase();
      if (seen.has(lowerName)) {
        skipped.push({ name: entry.name, reason: 'Already exists — skipped (no overwrite)' });
        continue;
      }
      const env = entry.env ?? {};
      const needsKeys = Object.values(env).some((v) => v === undefined || v === '');
      if (entry.enabled && needsKeys) {
        skipped.push({ name: entry.name, reason: 'Missing required credentials — fill in the keys before enabling.' });
        continue;
      }
      const entity = await this.createServer(userId, entry);
      seen.add(entity.name.trim().toLowerCase());
      const transport = entry.transport ?? 'stdio';
      created.push({ id: entity.id, name: entity.name, transport, needsSetup: needsKeys || transport === 'http' || !entry.enabled });
    }
    return { created, skipped };
  }

  // ── MCP runtime lifecycle (called by agent) ─────────────────────────────

  /**
   * Create + enable the bundled, keyless stock servers the agent is expected to
   * use during runs (agent-skills-*). Idempotent: existing rows (enabled or
   * disabled) are left untouched — a user's explicit disable is respected —
   * so it only fills the gap on fresh installs / empty stores.
   */
  async ensureAutoProvisioned(userId: string): Promise<void> {
    const existing = await this.listServers(userId);
    const existingNames = new Set(existing.map((s) => s.name.trim().toLowerCase()));
    for (const name of AUTO_PROVISIONED_STOCK_SERVERS) {
      if (existingNames.has(name)) continue;
      const stock = findStockEntry(name);
      if (!stock) continue;
      await this.createServer(userId, {
        name: stock.name,
        description: stock.description,
        transport: stock.transport,
        command: stock.command,
        args: stock.args,
        url: stock.url ?? undefined,
        icon: stock.icon ?? undefined,
        category: stock.category,
        tags: stock.tags,
        enabled: true,
      }).catch((err) =>
        this.logger.warn(`[MCP] auto-provision "${name}" failed: ${err instanceof Error ? err.message : err}`),
      );
      existingNames.add(name);
    }
  }

  /**
   * Build the McpRuntime for a run: loads all enabled servers and their configs.
   * Clients are NOT connected yet — they are lazy-activated via activateServer().
   */
  async buildRuntime(userId: string): Promise<McpRuntime> {
    const servers = await this.repo.find({ where: { userId, enabled: true } });
    const configs = servers.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      icon: s.icon,
    }));
    const handles = new Map<string, McpServerHandle>();
    const toolServerMap = new Map<string, string>();
    let closed = false;

    const connect = async (srv: McpServer): Promise<McpServerHandle> => {
      srv = await this.maybeUpgradeStockConfig(srv);
      if (srv.transport === 'http') {
        return this.connectHttpClient(srv);
      }
      const mcpArgs = srv.argsJson ? JSON.parse(srv.argsJson) as string[] : [];
      const mcpEnv = srv.envJson ? JSON.parse(srv.envJson) as Record<string, string> : {};
      return createStdioClient(srv.command, mcpArgs, mcpEnv, this.logger);
    };

    const activateServer = async (serverId: string): Promise<McpServerHandle> => {
      if (closed) throw new Error('MCP runtime already closed');
      if (handles.has(serverId)) return handles.get(serverId)!;
      const srv = servers.find((s) => s.id === serverId);
      if (!srv) throw new Error(`MCP server ${serverId} not found or not enabled`);
      const handle = await connect(srv);
      handle.serverId = srv.id;
      handle.name = srv.name;
      handles.set(serverId, handle);
      for (const t of handle.tools) {
        toolServerMap.set(`${srv.name}/${t.name}`, serverId);
        toolServerMap.set(t.name, serverId);
      }
      this.logger.log(`[MCP] activated server ${srv.name} (${handle.tools.length} tools)`);
      return handle;
    };

    return {
      handles,
      toolServerMap,
      configs,
      activateServer,
      closeAll() {
        if (closed) return;
        closed = true;
        for (const h of handles.values()) h.close();
        handles.clear();
        toolServerMap.clear();
      },
    };
  }

  /**
   * If the stored server config matches a known-deprecated stock recipe (e.g.
   * the old `uvx amazon-mcp` amazon entry that crashes under mcp SDK 2.x),
   * rewrite the row to the current stock-catalog command/args and persist it.
   * Returns the (possibly upgraded) server entity.
   */
  private async maybeUpgradeStockConfig(srv: McpServer): Promise<McpServer> {
    const stock = findStockEntry(srv.name);
    if (!stock?.command) return srv;
    const key = srv.name.trim().toLowerCase();
    const currentArgs = srv.argsJson ? (JSON.parse(srv.argsJson) as string[]) : [];
    const legacy = LEGACY_STOCK_CONFIGS[key];
    const isLegacy = Array.isArray(legacy)
      ? legacy.some(
          (l) => srv.command === l.command && JSON.stringify(currentArgs) === JSON.stringify(l.args),
        )
      : false;
    if (!isLegacy) return srv;
    const args = stock.args ?? [];
    this.logger.log(`[MCP] upgrading legacy "${srv.name}" config to stock recipe: ${stock.command} ${args.join(' ')}`);
    return this.updateServer(srv.id, srv.userId, { command: stock.command, args });
  }

  /**
   * Test connectivity: connect to a server, list tools, close.
   */
  async testConnection(serverId: string, userId: string): Promise<{
    ok: boolean;
    tools?: McpToolDef[];
    error?: string;
    needsOAuth?: boolean;
  }> {
    const srv = await this.repo.findOne({ where: { id: serverId, userId } });
    if (!srv) return { ok: false, error: 'Server not found' };
    try {
      const handle = await this.connectServer(srv);
      const tools = handle.tools;
      handle.close();
      return { ok: true, tools };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (srv.transport === 'http') {
        if (msg.includes('not authorized') || msg.includes('HTTP 401')) {
          return { ok: false, needsOAuth: true, error: msg };
        }
        const hasOAuth = await discoverOAuthMetadata(srv.url ?? '', this.logger)
          .then(() => true)
          .catch(() => false);
        if (hasOAuth) {
          return { ok: false, needsOAuth: true, error: msg };
        }
      }
      return { ok: false, error: msg };
    }
  }

  private async connectServer(srv: McpServer): Promise<McpServerHandle> {
    srv = await this.maybeUpgradeStockConfig(srv);
    if (srv.transport === 'http') {
      return this.connectHttpClient(srv);
    }
    const mcpArgs = srv.argsJson ? JSON.parse(srv.argsJson) as string[] : [];
    const mcpEnv = srv.envJson ? JSON.parse(srv.envJson) as Record<string, string> : {};
    return createStdioClient(srv.command, mcpArgs, mcpEnv, this.logger);
  }

  private connectHttpClient(srv: McpServer): Promise<McpServerHandle> {
    if (!srv.url) throw new Error(`MCP server ${srv.name} missing URL`);
    const oauth = !!srv.oauthAccessToken;
    const token = srv.apiToken ?? srv.oauthAccessToken;
    const opts =
      token && token.length > 0
        ? {
            authToken: token,
            ...(oauth ? { onRefresh: async () => this.refreshHttpToken(srv) } : {}),
          }
        : {};
    return createHttpClient(srv.url, opts, this.logger);
  }

  // ── OAuth for remote (http) MCP servers ─────────────────────────────────

  /**
   * Ensure the server has a registered OAuth client (DCR), then produce the
   * authorization URL the user opens in a browser. The pending PKCE state is
   * kept in memory keyed by `state` until the callback arrives.
   */
  async startOAuthFlow(serverId: string, userId: string, redirectUri: string): Promise<{
    authUrl: string;
    state: string;
  }> {
    const srv = await this.repo.findOne({ where: { id: serverId, userId } });
    if (!srv) throw new Error(`MCP server ${serverId} not found`);
    if (srv.transport !== 'http' || !srv.url) {
      throw new Error('OAuth flow only supported for HTTP transport servers');
    }
    const meta = await discoverOAuthMetadata(srv.url, this.logger);

    let clientId = srv.oauthClientId;
    let clientSecret = srv.oauthClientSecret;
    if (!clientId) {
      if (!meta.registrationEndpoint) {
        const host = srv.url ? new URL(srv.url).host : 'this server';
        const isGoogle = !!srv.url && /googleapis\.com$/i.test(new URL(srv.url).host);
        throw new Error(
          isGoogle
            ? `OAuth needs your own Google Cloud client for ${host}. Create one at ` +
              `https://console.cloud.google.com/apis/credentials (Basics → Consent screen → Credentials → ` +
              `Create Credentials → OAuth client ID). Choose "Web application" and add redirect URI ` +
              `${redirectUri}, then paste the Client ID and Secret below. ` +
              `A "Desktop app" client works with only the Client ID (no secret).`
            : `OAuth needs your own consumer credentials for ${host} — this server does not support ` +
              `automatic client registration. Fill in the OAuth Client ID (and Secret if your client provides one) first.`,
        );
      }
      const reg = await registerOAuthClient(meta, redirectUri, this.logger);
      clientId = reg.clientId;
      clientSecret = reg.clientSecret;
      await this.repo.save({ ...srv, oauthClientId: clientId, oauthClientSecret: clientSecret });
    }

    const { verifier, challenge } = generatePkce();
    const state = require('crypto').randomBytes(24).toString('base64url');
    const scope = srv.oauthScopes || (meta.resourceScopes ?? meta.scopesSupported ?? []).filter((s) => !s.startsWith('openid')).join(' ');
    const authUrl = buildOAuthAuthorizeUrl(meta, {
      clientId,
      redirectUri,
      codeChallenge: challenge,
      state,
      scope,
    });

    this.pendingOAuth.set(state, {
      serverId,
      userId,
      metadata: meta,
      clientId,
      clientSecret,
      verifier,
      redirectUri,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    return { authUrl, state };
  }

  /**
   * Handle the OAuth callback: exchange the code for tokens and persist them
   * on the McpServer row. Returns the updated server on success.
   */
  async completeOAuthFlow(code: string, state: string): Promise<McpServer | null> {
    const entry = this.pendingOAuth.get(state);
    if (!entry) return null;
    this.pendingOAuth.delete(state);
    const tokens = await exchangeOAuthCode(entry.metadata, {
      clientId: entry.clientId,
      clientSecret: entry.clientSecret,
      code,
      redirectUri: entry.redirectUri,
      verifier: entry.verifier,
    });
    const srv = await this.repo.findOne({ where: { id: entry.serverId, userId: entry.userId } });
    if (!srv) {
      throw new Error(`MCP server ${entry.serverId} not found`);
    }
    await this.repo.save({
      ...srv,
      oauthAccessToken: tokens.accessToken,
      oauthRefreshToken: tokens.refreshToken,
      oauthExpiresAt: tokens.expiresIn ? String(Date.now() + tokens.expiresIn * 1000) : null,
      oauthClientId: entry.clientId,
      oauthClientSecret: entry.clientSecret,
      apiToken: null,
    });
    const updated = await this.repo.findOne({ where: { id: entry.serverId, userId: entry.userId } });
    return updated;
  }

  async disconnectOAuth(serverId: string, userId: string): Promise<void> {
    const srv = await this.repo.findOne({ where: { id: serverId, userId } });
    if (!srv) throw new Error(`MCP server ${serverId} not found`);
    await this.repo.save({
      ...srv,
      oauthAccessToken: null,
      oauthRefreshToken: null,
      oauthExpiresAt: null,
      apiToken: null,
    });
  }

  /**
   * Refresh this server's access token, persist it, and return the new token.
   */
  private async refreshHttpToken(srv: McpServer): Promise<string> {
    const current = await this.repo.findOne({ where: { id: srv.id, userId: srv.userId } });
    const live = current ?? srv;
    if (!live.url) throw new Error('refresh: no url');
    if (!live.oauthRefreshToken) throw new Error('refresh: no refresh token');
    const meta = await discoverOAuthMetadata(live.url, this.logger);
    const tokens = await refreshOAuthAccessTokenV2(meta, {
      clientId: live.oauthClientId ?? '',
      clientSecret: live.oauthClientSecret ?? '',
      refreshToken: live.oauthRefreshToken,
    });
    await this.repo.save({
      ...live,
      oauthAccessToken: tokens.accessToken,
      oauthRefreshToken: tokens.refreshToken,
      oauthExpiresAt: tokens.expiresIn ? String(Date.now() + tokens.expiresIn * 1000) : live.oauthExpiresAt,
    });
    return tokens.accessToken ?? '';
  }
}
