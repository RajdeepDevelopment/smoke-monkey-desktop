/**
 * ToolLibrary — centralised tool resolution for the agent loop.
 *
 * Responsibilities:
 *  - Merge registry tools + MCP tools into the LLM-ready definition list
 *  - Resolve which tools are exposed per workflow phase
 *  - Activate MCP servers lazily on first use
 *  - Parse inline tool calls from open-weight model text formats
 *  - Normalise tool call arrays across providers
 *  - Provide metadata helpers (isVerification, isMutating, etc.)
 *
 * All methods are stateless or receive the run context as a parameter,
 * so the library can be reused across runs without side effects.
 */
import { Logger } from '@nestjs/common';
import { ToolRegistry } from '../tools/tool-registry';
import {
  PHASE_TOOLS,
  type AgentPhase,
} from './run-context';
import type { McpRuntime } from '../../mcp/mcp.service';
import type { SubContextManager } from '../context/sub-context';

const logger = new Logger('ToolLibrary');

// ── Types ────────────────────────────────────────────────────────────────────

export interface LLMToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface InlineToolCall {
  id: string;
  function: { name: string; arguments: string };
}

export interface InlineParseResult {
  calls: InlineToolCall[];
  cleaned: string;
}

export interface LLMToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  thought_signature?: string;
}

// ── Verification / mutation classification ────────────────────────────────────

/** Tool names that represent a real verification step. */
const VERIFICATION_TOOL_SET = new Set(['run_test']);

/** Matches a run_command ARGS JSON string whose command is a verification step. */
const VERIFICATION_COMMAND_RE =
  /\b(tsc|typecheck|lint)\b|--noEmit|\b(?:jest|vitest|pytest|mocha|rspec)\b|(?:^|[;&|(){}\[\]:,"\s]+)(?:pnpm|npm|yarn|bun|npx)\s+(?:exec\s+|run\s+)?(?:test|tests|lint|typecheck|build|check)(?:["'`,;{}|)\s]|$)|(?:^|[;&|(){}\[\]:,"\s]+)cargo\s+(?:test|check|build)(?:["'`,;{}|)\s]|$)|(?:^|[;&|(){}\[\]:,"\s]+)(?:go|python|python3)\s+(?:test\b|.*-m\s+test\b)|git\s+diff\s+--check|curl.{0,160}(?:health|ready|api-docs|swagger|\/api[^a-z]|localhost:\d+|127\.0\.0\.1:\d+)|lsof.{0,160}-iTCP|(?:^|[;&|{}\[\]:,"\s]+)(?:ss|netstat)\b|wait-for-it\b[^\n]{0,80}|nc\s+-z[^\n]{0,80}\d{3,5}/i;

/** Prose that reads like an explicit final report. */
const FINAL_REPORT_RE =
  /(^|\n)[ \t]*(?:[-*•][ \t]*)?[*_]*(Changed|Verified|Result|Summary|Done|Status)[*_]*[ \t]*:|TASK (COMPLETE|COMPLETED)|completed successfully|verification (passed|green)|all checks (passed|green)/im;

/** File-mutating tool names. */
const MUTATING_TOOL_SET = new Set(['write_file', 'edit_file', 'line_edit', 'replace_lines', 'apply_patch']);

/** Tool timeout classification. */
const LONG_TOOL_TIMEOUT_MS = 7 * 60_000;
const LONG_TOOL_NAMES = new Set(['write_file', 'edit_file', 'apply_patch', 'replace_lines', 'line_edit']);

// ── Tool resolution ──────────────────────────────────────────────────────────

/**
 * Resolves the full set of LLM-ready tool definitions for the current step.
 * Merges registry tools with active MCP server tools.
 */
export async function resolveToolDefinitions(
  toolRegistry: ToolRegistry,
  exposedTools: Set<string>,
  phase: AgentPhase,
  mcpRuntime?: McpRuntime,
  contextManager?: SubContextManager,
): Promise<LLMToolDef[]> {
  for (const toolName of PHASE_TOOLS[phase]) exposedTools.add(toolName);
  const registryTools = toolRegistry.getDefinitions(exposedTools);

  const mcpTools: LLMToolDef[] = [];
  if (mcpRuntime) {
    for (const cfg of mcpRuntime.configs) {
      const mcpId = `mcp_${cfg.id}`;
      if (!contextManager?.isActive(mcpId)) continue;
      try {
        let handle = mcpRuntime.handles.get(cfg.id);
        if (!handle) {
          handle = await mcpRuntime.activateServer(cfg.id);
        }
        for (const t of handle.tools) {
          mcpTools.push({
            name: `${cfg.name}__${t.name}`,
            description: `[MCP:${cfg.name}] ${t.description}`,
            parameters: t.inputSchema,
          });
        }
      } catch (err) {
        logger.warn(`[MCP] failed to activate ${cfg.name}: ${err}`);
      }
    }
  }

  return [...registryTools, ...mcpTools];
}

// ── Tool metadata helpers ────────────────────────────────────────────────────

export function isMutatingTool(toolName: string): boolean {
  return MUTATING_TOOL_SET.has(toolName);
}

export function isVerificationTool(toolName: string): boolean {
  return VERIFICATION_TOOL_SET.has(toolName);
}

export function isVerificationCommand(argsStr: string): boolean {
  return VERIFICATION_COMMAND_RE.test(argsStr || '');
}

export function isFinalReport(content: string): boolean {
  return FINAL_REPORT_RE.test(content);
}

export function toolTimeoutMs(toolName: string): number {
  return LONG_TOOL_NAMES.has(toolName) ? LONG_TOOL_TIMEOUT_MS : 180_000;
}

// ── Lookup helpers ───────────────────────────────────────────────────────────

/**
 * Fetches a single tool definition by name from the registry (or an MCP tool
 * when `mcpRuntime` is provided). Returns undefined when the tool is unknown
 * to BOTH the registry and the active MCP servers.
 */
export function getToolDefinition(
  toolRegistry: ToolRegistry,
  name: string,
  mcpRuntime?: McpRuntime,
): LLMToolDef | undefined {
  const registryDef = toolRegistry.getDefinitions(new Set([name]))[0];
  if (registryDef) return registryDef;

  const mcpRef = parseMcpToolName(name);
  if (mcpRef && mcpRuntime) {
    for (const cfg of mcpRuntime.configs) {
      if (cfg.name !== mcpRef.serverName) continue;
      const handle = mcpRuntime.handles.get(cfg.id);
      if (!handle) continue;
      const tool = handle.tools.find((t) => t.name === mcpRef.toolName);
      if (tool) {
        return {
          name,
          description: `[MCP:${cfg.name}] ${tool.description}`,
          parameters: tool.inputSchema,
        };
      }
    }
  }
  return undefined;
}

/** Returns all registry tool names (optionally restricted to a set). */
export function listAllToolNames(toolRegistry: ToolRegistry, only?: Set<string>): string[] {
  return toolRegistry.getDefinitions(only).map((t) => t.name);
}

/** Returns true when the tool exists in the registry (or an active MCP server). */
export function toolExists(name: string, toolRegistry: ToolRegistry, mcpRuntime?: McpRuntime): boolean {
  return getToolDefinition(toolRegistry, name, mcpRuntime) !== undefined;
}

/** Compact `name — description` summary for prompts / logs / UIs. */
export function summarizeTools(tools: Array<{ name: string; description?: string }>): string {
  return tools.map((t) => `${t.name} — ${(t.description || '').split('\n')[0]}`).join('\n');
}

// ── MCP tool detection ───────────────────────────────────────────────────────

/** Returns true when the tool name matches the MCP server__tool format. */
export function isMcpToolFormat(toolName: string): boolean {
  const sep = toolName.indexOf('__');
  return sep > 0;
}

/** Extracts { serverName, toolName } from an MCP-format tool name, or null. */
export function parseMcpToolName(toolName: string): { serverName: string; toolName: string } | null {
  const sep = toolName.indexOf('__');
  if (sep <= 0) return null;
  return { serverName: toolName.slice(0, sep), toolName: toolName.slice(sep + 2) };
}

// ── Inline tool call parsing ─────────────────────────────────────────────────

/**
 * Parses inline text-format tool calls from open-weight model output.
 * Supports Qwen <tool_call>, GLM/functionary <function=...>, DeepSeek <start_json>.
 */
export function extractInlineToolCalls(
  content: string | null | undefined,
  knownTools?: Set<string>,
): InlineParseResult {
  const calls: InlineToolCall[] = [];
  if (!content) return { calls, cleaned: content ?? '' };
  const tools = knownTools || new Set<string>();

  const addCall = (name: unknown, argsRaw: unknown): boolean => {
    const fnName = String(name || '').trim();
    if (!fnName) return false;
    if (tools.size > 0 && !tools.has(fnName) && !fnName.includes('__')) return false;
    let argsStr = '{}';
    if (typeof argsRaw === 'string') argsStr = argsRaw.trim() || '{}';
    else if (argsRaw != null) argsStr = JSON.stringify(argsRaw);
    try {
      const probe = JSON.parse(argsStr);
      if (probe && typeof probe === 'object' && !Array.isArray(probe)) argsStr = JSON.stringify(probe);
    } catch { /* leave as-is */ }
    calls.push({
      id: `text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      function: { name: fnName, arguments: argsStr },
    });
    return true;
  };

  let cleaned = content;

  // 1. <start_json>{...}</start_json>
  cleaned = cleaned.replace(/<start_json>([\s\S]*?)<\/start_json>/g, (_m, inner: string) => {
    try {
      const block = JSON.parse(inner.trim());
      addCall(block.name, block.arguments ?? block.parameters ?? {});
    } catch { /* not JSON — drop the markup anyway */ }
    return '';
  });

  // 2. <tool_call>{...}</tool_call> (Qwen style)
  cleaned = cleaned.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (_m, inner: string) => {
    try {
      const block = JSON.parse(inner.trim());
      if (block.function?.name) addCall(block.function.name, block.function.arguments);
      else addCall(block.name, block.arguments ?? block.parameters ?? {});
    } catch { /* fallthrough */ }
    return '';
  });


  // 3. <function=name> <parameter=key>value</parameter> (+ stray </tool_call>)
  cleaned = cleaned.replace(/<function=([A-Za-z0-9_.-]+)>([\s\S]*?)<\/function>/g, (_m, rawName: string, body: string) => {
    const args: Record<string, unknown> = {};
    const paramRe = /<parameter=([A-Za-z0-9_.-]+)>\s*([\s\S]*?)\s*<\/parameter>/g;
    let m: RegExpExecArray | null;
    while ((m = paramRe.exec(body)) !== null) {
      const key = m[1];
      const rawVal = m[2];
      let val: unknown = rawVal.trim();
      try { val = JSON.parse(rawVal.trim()); } catch { /* keep string */ }
      args[key] = val;
    }
    addCall(rawName, args);
    return '';
  });

  // 4. Smoke Monkey XML-style tool calls: <toolName>{...}</toolName>. Open-weight
  //    models frequently emit their ask_user (and other) calls inline this way
  //    instead of structured tool_calls — previously the raw tag was rendered as
  //    text and no ask_user.required event (popup) ever fired. Only complete
  //    JSON bodies become calls; anything else is left untouched.
  cleaned = cleaned.replace(/<([A-Za-z_][A-Za-z0-9_]*)\s*>([\s\S]*?)<\/\1\s*>/g, (_m, name: string, body: string) => {
    const trimmed = String(body ?? '').trim();
    if (!trimmed.startsWith('{')) return _m;
    try {
      const block = JSON.parse(trimmed);
      if (block && typeof block === 'object' && !Array.isArray(block)) {
        // Only consume the markup when the tag resolved to a real tool call —
        // otherwise leave the text intact so legit widget blocks are never lost.
        return addCall(name, block) ? '' : _m;
      }
    } catch { /* not JSON — keep the text as-is */ }
    return _m;
  });

  // Sweep leftover dangling markers
  cleaned = cleaned.replace(/<\/?tool_call>|<\|tool▁calls▁begin\|>[\s\S]*?<\|tool▁calls▁end\|>/g, '').trim();

  return { calls, cleaned };
}

// ── Tool call validation ─────────────────────────────────────────────────────

export interface ValidatedToolCall {
  id: string;
  function: { name: string; arguments: string };
  thought_signature?: string;
}

/**
 * Filters malformed tool calls from the structured response. Returns only
 * calls with a valid name and parseable JSON arguments.
 */
export function validateToolCalls(
  rawCalls: Array<{ id?: string; function?: { name?: string; arguments?: string }; thought_signature?: string }>,
  loggerCtx: { warn: (msg: string) => void },
): ValidatedToolCall[] {
  return rawCalls.filter((tc) => {
    const name = tc.function?.name;
    const args = tc.function?.arguments;
    if (!name || typeof name !== 'string' || name.trim() === '') {
      loggerCtx.warn('Rejecting malformed tool call: empty or missing name');
      return false;
    }
    if (args !== undefined && args !== null && typeof args === 'string' && args.trim() !== '') {
      try { JSON.parse(args); } catch {
        loggerCtx.warn(`Rejecting tool call "${name}": invalid JSON arguments`);
        return false;
      }
    }
    return true;
  }) as ValidatedToolCall[];
}

// ── Tool call normalization ──────────────────────────────────────────────────

/**
 * Normalizes an OpenAI-style tool_calls array (from a non-streaming response)
 * into the internal LLMToolCall shape. Preserves Gemini 3.x thought_signature.
 */
export function normalizeToolCalls(rawCalls: any[]): LLMToolCall[] {
  if (!Array.isArray(rawCalls)) return [];
  return rawCalls
    .map((tc, i) => ({
      id:
        typeof tc?.id === 'string' && tc.id
          ? tc.id
          : `call_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'function' as const,
      function: {
        name: String(tc?.function?.name || ''),
        arguments:
          typeof tc?.function?.arguments === 'string'
            ? tc.function.arguments
            : JSON.stringify(tc?.function?.arguments ?? {}),
      },
      ...(tc?.extra_content?.google?.thought_signature
        ? { thought_signature: String(tc.extra_content.google.thought_signature) }
        : {}),
    }))
    .filter((tc) => tc.function.name.trim() !== '');
}

// ── Thinking / reasoning extraction ──────────────────────────────────────────

/**
 * Extracts reasoning/thinking text from a streaming choice.delta,
 * tolerating field names across providers: reasoning_content, reasoning,
 * thinking, thought, reasoning_text, and nested extra_content.google.thinking.
 */
export function extractThoughtDelta(delta: any): string {
  if (!delta || typeof delta !== 'object') return '';
  const parts: string[] = [];
  for (const key of ['reasoning_content', 'reasoning', 'thinking', 'thought', 'reasoning_text']) {
    const v = delta[key];
    if (typeof v === 'string' && v) parts.push(v);
  }
  const extra = delta.extra_content;
  if (extra && typeof extra === 'object') {
    const gemini = extra.google;
    if (gemini && typeof gemini.thinking === 'string' && gemini.thinking) {
      parts.push(gemini.thinking);
    }
  }
  return parts.join('');
}

// ── Degeneration detection ───────────────────────────────────────────────────

/**
 * Detects degenerate repetition loops — the model stuck re-printing the same
 * block. Returns true when content contains a duplicated ~120-char chunk.
 */
export function isDegenerateRepeat(content: string | null | undefined): boolean {
  if (!content) return false;
  const norm = content.replace(/\s+/g, ' ').trim();
  if (norm.length < 600) return false;
  const half = Math.floor(norm.length / 2);
  const head = norm.slice(0, 120);
  return norm.slice(half, half + 120) === head || norm.slice(half - 120, half) === head;
}

// ── Sensitive file detection ─────────────────────────────────────────────────

const SENSITIVE_RE =
  /(^|\/)(\.env|\.env\.\w+|credentials\.|secret|secrets?[^/]*\.|\.token|tokens?[^/]*\.|\.key|\.pem|\.pfx|id_rsa|id_ed25519|\.aws\/|credentials|api[_-]?key|passwords?\.json|\.npmrc|\.pypirc|\.netrc|config\.json.*(secret|token|key))/i;

const SENSITIVE_TOOLS = new Set([
  'read_file', 'list_directory', 'inspect', 'grep', 'edit_file', 'line_edit',
  'write_file', 'replace_lines', 'apply_patch', 'delete_file', 'run_command', 'search_code',
]);

/**
 * Detects whether a tool call targets a sensitive file (secrets, credentials,
 * keys) that should always require explicit user permission.
 */
export function isSensitiveTarget(
  toolName: string,
  toolArgs: Record<string, unknown>,
  workspacePath: string,
): boolean {
  if (!SENSITIVE_TOOLS.has(toolName)) return false;

  const targets: string[] = [];
  const walk = (args: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(args)) {
      if (typeof v === 'string') targets.push(v);
      else if (Array.isArray(v)) {
        for (const item of v) {
          if (typeof item === 'string') targets.push(item);
          else if (item && typeof item === 'object') walk(item as Record<string, unknown>);
        }
      } else if (v && typeof v === 'object' && k === 'args') walk(v as Record<string, unknown>);
    }
  };
  walk(toolArgs);

  for (const raw of targets) {
    const t = String(raw);
    const abs = t.startsWith('/') ? t : workspacePath ? `${workspacePath}/${t}`.replace(/\/+/g, '/') : t;
    if (SENSITIVE_RE.test(t) || SENSITIVE_RE.test(abs)) return true;
  }
  return false;
}
