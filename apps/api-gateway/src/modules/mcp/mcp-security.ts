/**
 * mcp-security.ts — validation & sanitisation for custom MCP JSON imports and
 * LLM-created MCP servers.
 *
 * Security posture (defense-in-depth on top of `spawn(..., { shell:false })`):
 *  - stdio `command` must be a bare executable on a SAFE_RUNNERS allowlist
 *    (package runners / interpreters). Arbitrary system binaries, paths and
 *    shells are rejected.
 *  - `args` may not contain shell metacharacters, NUL bytes or newlines —
 *    even though spawn(2) passes them verbatim, this keeps configs clean.
 *  - `env` may only contain plain `KEY`/`value` strings; control characters
 *    and NUL are rejected.
 *  - http servers must expose a plain http(s) URL without embedded
 *    credentials.
 *  - Batch imports are capped, and duplicate names are skipped.
 */

import { McpSecurityError } from './mcp-security-error';

export const MCP_SAFE_RUNNERS = new Set([
  'npx',
  'npm',
  'yarn',
  'pnpm',
  'bun',
  'deno',
  'uvx',
  'uv',
  'python3',
  'python',
  'node',
  'go',
  'cargo',
  'java',
  'docker',
  'docker-compose',
  'podman',
]);

export const MCP_MAX_BATCH_IMPORT = 50;

/** Characters that can never appear in an arg/env-key/env-value for a stdio MCP. */
const FORBIDDEN_ARG_RE = /[;&|`$<>\\\n\r\u0000]/;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface McpImportEntry {
  name: string;
  description?: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  icon?: string;
  category?: string;
  tags?: string[];
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthScopes?: string;
}

export interface McpImportParseResult {
  servers: McpImportEntry[];
  errors: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, max = 120): string | null {
  if (typeof v !== 'string') return null;
  if (v.length > max) return null;
  if (CONTROL_CHAR_RE.test(v)) return null;
  return v;
}

/** Validates + normalises a single raw server dict. Returns errors when invalid. */
export function validateMcpEntry(raw: unknown, index: number): { entry?: McpImportEntry; errors: string[] } {
  const errors: string[] = [];
  if (!isPlainObject(raw)) {
    return { errors: [`Server ${index + 1}: must be an object`] };
  }

  const name = str(raw.name, 120)?.trim() ?? '';
  if (!name) {
    errors.push(`Server ${index + 1}: missing or invalid "name" (string, ≤ 120 chars, no control characters)`);
  } else if (/^mcp_/i.test(name)) {
    errors.push(`Server ${index + 1}: "${name}" — the "mcp_" prefix is reserved for internal runtime ids`);
  }

  const transport = raw.transport === 'http' ? 'http' : 'stdio';
  const description = typeof raw.description === 'string' ? raw.description.slice(0, 512) : '';

  const iconRaw = raw.icon;
  let icon: string | undefined;
  if (iconRaw !== undefined && iconRaw !== null && iconRaw !== '') {
    if (typeof iconRaw !== 'string' || iconRaw.length > 64 || CONTROL_CHAR_RE.test(iconRaw)) {
      errors.push(`Server ${index + 1} ("${name || '?'}"): invalid "icon" (string, ≤ 64 chars, no control characters)`);
    } else {
      icon = iconRaw.trim();
    }
  }

  const oauthClientId = raw.oauthClientId == null ? undefined : String(raw.oauthClientId).slice(0, 512);
  const oauthClientSecret = raw.oauthClientSecret == null ? undefined : String(raw.oauthClientSecret).slice(0, 512);
  const oauthScopes = raw.oauthScopes == null ? undefined : String(raw.oauthScopes).slice(0, 512);

  let category: string | undefined;
  if (raw.category != null && raw.category !== '') {
    if (typeof raw.category !== 'string' || raw.category.length > 120 || CONTROL_CHAR_RE.test(raw.category)) {
      errors.push(`Server ${index + 1} ("${name || '?'}"): invalid "category" (string, ≤ 120 chars, no control characters)`);
    } else {
      category = raw.category.trim();
    }
  }

  const rawTags = raw.tags;
  let tags: string[] | undefined;
  if (rawTags !== undefined && rawTags !== null) {
    if (!Array.isArray(rawTags) || rawTags.length > 20) {
      errors.push(`Server ${index + 1} ("${name || '?'}"): "tags" must be an array of up to 20 strings`);
    } else {
      const clean: string[] = [];
      for (const t of rawTags) {
        if (typeof t !== 'string' || t.length > 40 || CONTROL_CHAR_RE.test(t)) {
          errors.push(`Server ${index + 1} ("${name || '?'}"): invalid tag (string, ≤ 40 chars, no control characters)`);
          break;
        }
        const trimmed = t.trim();
        if (trimmed) clean.push(trimmed.toLowerCase());
      }
      if (errors.length === 0 && clean.length > 0) tags = clean;
    }
  }

  let url: string | undefined;
  let command: string | undefined;
  let args: string[] | undefined;
  let env: Record<string, string> | undefined;

  if (transport === 'http') {
    if (typeof raw.url !== 'string' || !raw.url.trim()) {
      errors.push(`Server ${index + 1} ("${name || '?'}"): http transport requires "url"`);
    } else {
      url = raw.url.trim().slice(0, 2048);
      try {
        const u = new URL(url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          errors.push(`Server ${index + 1} ("${name || '?'}"): url must be http(s)`);
        }
        if (u.username || u.password) {
          errors.push(`Server ${index + 1} ("${name || '?'}"): url must not embed credentials`);
        }
      } catch {
        errors.push(`Server ${index + 1} ("${name || '?'}"): "${url}" is not a valid URL`);
      }
    }
  } else {
    if (typeof raw.command !== 'string' || !raw.command.trim()) {
      errors.push(`Server ${index + 1} ("${name || '?'}"): stdio transport requires "command"`);
    } else {
      const cmdRaw = raw.command.trim().split(/\s+/)[0];
      command = cmdRaw;
      if (!command || !MCP_SAFE_RUNNERS.has(command)) {
        errors.push(
          `Server ${index + 1} ("${name || '?'}"): command "${command}" is not allowed. ` +
            `Use one of: ${Array.from(MCP_SAFE_RUNNERS).join(', ')}`,
        );
      }
    }

    if (raw.args !== undefined && raw.args !== null) {
      if (!Array.isArray(raw.args)) {
        errors.push(`Server ${index + 1} ("${name || '?'}"): "args" must be an array of strings`);
      } else if (raw.args.length > 100) {
        errors.push(`Server ${index + 1} ("${name || '?'}"): too many args (max 100)`);
      } else {
        for (const a of raw.args) {
          if (typeof a !== 'string' || a.length > 200 || FORBIDDEN_ARG_RE.test(a)) {
            errors.push(
              `Server ${index + 1} ("${name || '?'}"): arg "${String(a).slice(0, 40)}" rejected ` +
                `(must be a plain string ≤ 200 chars with no shell metacharacters)`,
            );
          }
        }
        if (errors.length === 0) args = raw.args.map(String);
      }
    }

    if (raw.env !== undefined && raw.env !== null) {
      if (!isPlainObject(raw.env)) {
        errors.push(`Server ${index + 1} ("${name || '?'}"): "env" must be an object of key → value strings`);
      } else {
        const keys = Object.keys(raw.env);
        if (keys.length > 100) {
          errors.push(`Server ${index + 1} ("${name || '?'}"): too many env vars (max 100)`);
        } else {
          const clean: Record<string, string> = {};
          for (const k of keys) {
            const v = raw.env[k];
            if (k.length > 64 || !ENV_KEY_RE.test(k)) {
              errors.push(`Server ${index + 1} ("${name || '?'}"): env key "${k.slice(0, 40)}" is invalid`);
            } else if (typeof v !== 'string' || v.length > 4096 || CONTROL_CHAR_RE.test(v)) {
              errors.push(`Server ${index + 1} ("${name || '?'}"): env value for "${k}" must be a plain string (≤ 4096 chars)`);
            } else {
              clean[k] = v;
            }
          }
          if (errors.length === 0) env = clean;
        }
      }
    }
  }

  if (errors.length > 0) return { errors };

  return {
    entry: {
      name,
      description,
      transport,
      ...(command !== undefined ? { command } : {}),
      ...(args !== undefined ? { args } : {}),
      ...(env !== undefined ? { env } : {}),
      ...(url !== undefined ? { url } : {}),
      ...(icon !== undefined ? { icon } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(tags !== undefined ? { tags } : {}),
      ...(oauthClientId !== undefined ? { oauthClientId } : {}),
      ...(oauthClientSecret !== undefined ? { oauthClientSecret } : {}),
      ...(oauthScopes !== undefined ? { oauthScopes } : {}),
    },
    errors,
  };
}

/** Forms a single, complete, validatable proto from one server dict (for the
 *  LLM `add_mcp_server` tool where a flat object arrives). */
export function toMcpImportEntry(raw: Record<string, unknown>): McpImportEntry {
  const { entry, errors } = validateMcpEntry(raw, 0);
  if (!entry) throw new McpSecurityError(errors.join('; ') || 'Invalid MCP server config');
  return entry;
}

/**
 * Parses a custom MCP JSON payload into validated import entries.
 * Accepts Claude-Desktop style `{ mcpServers: { name: def } }`, an array of
 * servers, or a single server object. Never throws for per-server issues —
 * they are collected into `errors`.
 */
export function parseCustomMcpJson(input: unknown): McpImportParseResult {
  const result: McpImportParseResult = { servers: [], errors: [] };

  let list: Array<Record<string, unknown>> = [];
  if (Array.isArray(input)) {
    list = input.filter(isPlainObject) as Array<Record<string, unknown>>;
  } else if (isPlainObject(input)) {
    if (isPlainObject(input.mcpServers)) {
      for (const [rawName, def] of Object.entries(input.mcpServers)) {
        if (!isPlainObject(def)) {
          result.errors.push(`${rawName}: expected an object config`);
          continue;
        }
        const withName = { name: rawName, ...def } as Record<string, unknown>;
        const label = withName.name ?? rawName;
        const { entry, errors } = validateMcpEntry({ ...withName, name: label }, list.length);
        if (entry) result.servers.push(entry);
        else result.errors.push(...errors);
      }
      return result;
    }
    if (isPlainObject(input.servers)) {
      for (const [rawName, def] of Object.entries(input.servers)) {
        if (!isPlainObject(def)) {
          result.errors.push(`${rawName}: expected an object config`);
          continue;
        }
        const withName = { name: rawName, ...def } as Record<string, unknown>;
        const label = withName.name ?? rawName;
        const { entry, errors } = validateMcpEntry({ ...withName, name: label }, list.length);
        if (entry) result.servers.push(entry);
        else result.errors.push(...errors);
      }
      return result;
    }
    if (Array.isArray(input.mcpServers)) {
      list = (input.mcpServers as unknown[]).filter(isPlainObject) as Array<Record<string, unknown>>;
    } else if (Array.isArray(input.servers)) {
      list = (input.servers as unknown[]).filter(isPlainObject) as Array<Record<string, unknown>>;
    } else if (input.name || input.command || input.url) {
      list = [input];
    } else if (!input.mcpServers) {
      result.errors.push('Unrecognised JSON: expected { mcpServers: {...} }, { servers: [...] }, an array, or a single-server object');
      return result;
    }
  } else {
    result.errors.push('Payload must be a JSON object or array');
    return result;
  }

  if (list.length > MCP_MAX_BATCH_IMPORT) {
    result.errors.push(`Import too large: cap is ${MCP_MAX_BATCH_IMPORT} servers per batch`);
    list = list.slice(0, MCP_MAX_BATCH_IMPORT);
  }

  for (let i = 0; i < list.length; i++) {
    const { entry, errors } = validateMcpEntry(list[i], i);
    if (entry) result.servers.push(entry);
    else result.errors.push(...errors);
  }

  return result;
}

/** True when an entry is a plausible duplicate of an existing server name. */
export function isDuplicateName(name: string, existing: Array<{ name: string }>): boolean {
  const lower = name.trim().toLowerCase();
  return existing.some((s) => s.name.trim().toLowerCase() === lower);
}