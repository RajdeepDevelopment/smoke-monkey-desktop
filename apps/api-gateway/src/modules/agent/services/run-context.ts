import { TodoItem } from '../entities/agent-run.entity';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
    /** Gemini 3.x thinking models: echoed back via extra_content. */
    thought_signature?: string;
  }>;
}

/**
 * Durable summary of everything the conversation covered up to a point.
 * Stored on the session so subsequent runs start from SUMMARY + RECENT
 * instead of replaying the full history.
 */
export interface ContextSnapshot {
  task: string;
  summary: string | null;
  /** Number of persisted session messages already folded into `summary`. */
  coveredMessages: number;
  filesRead: string[];
  filesModified: string[];
  decisions: string[];
  errors: string[];
  plan: TodoItem[];
}

/**
 * In-memory orchestrator state for one agent run. Built ONCE at run start,
 * mutated in place as messages/tools/observations happen, and only flushed
 * to PostgreSQL at meaningful checkpoints. This removes the per-step
 * "DB → rebuild context → LLM" round trip.
 */
export interface RunContext {
  sessionId: string;
  runId: string;
  userId: string;
  workspacePath: string;
  agentId: string;
  provider?: string;
  model?: string;
  /** When set, the agent runs on a remote host via this SSH profile. */
  remoteProfileId?: string;

  task: string;

  /** True when the task is read-only (a question / analysis), so the agent may
   *  finalize with a plain text answer instead of being forced to keep using
   *  tools. Derived from the task's tool-group classification. */
  readOnlyQuery: boolean;

  /**
   * The single authoritative system prompt (base policy + project policy +
   * mode suffix). NEVER pushed into `messages` — it is re-assembled into the
   * payload's leading system message on every LLM call so one system message
   * governs the whole conversation.
   */
  systemPrompt: string;

  /**
   * Ephemeral per-run guidance accumulated as the run progresses (phase nudges,
   * guard notes, policy violations). Injected into the leading system message
   * each call — never appended as standalone system messages mid-conversation.
   */
  runtimeInstructions: string[];

  /** Most recent policy violation (search loop, doom loop, blocked tool, ...).
   *  Surfaced in the runtime policy block and cleared once the model acts. */
  policyViolation: string | null;

  /** Durable cross-run summary state; merged on every compaction. */
  snapshot: ContextSnapshot;

  /**
   * The live LLM conversation — user/assistant/tool ONLY. System policy never
   * lives here; it is rebuilt per call via `buildLLMMessages`. The single
   * source of truth for the run.
   */
  messages: LLMMessage[];

  filesRead: Set<string>;
  filesModified: Set<string>;
  observations: string[];
  plan: TodoItem[];
  currentStep: number;

  tokenBudget: number;
  inputTokens: number;
  outputTokens: number;

  abortController: AbortController;

  /** Tool names currently exposed to the model; widened dynamically. */
  exposedTools: Set<string>;

  /** Deterministic workflow phase — advanced by OBSERVED actions, never asked of the LLM. */
  phase: AgentPhase;

  lastToolCalls: Array<{ name: string; args: string; success: boolean }>;

  /** Estimated tokens at the last compaction — avoids re-summarizing every check. */
  lastCompactTokens: number;
}

export const CHARS_PER_TOKEN = 4;
/** Default context budget when the model's real window is unknown. */
export const CONTEXT_TOKEN_BUDGET = 100_000;
/** Fraction of the context budget at which live compaction fires (70%). */
export const COMPACTION_THRESHOLD = 0.7;
/** Tokens reserved for the model's reply — never counted as compactable history. */
export const MAX_OUTPUT_RESERVE = 16_384;
/** Fixed overhead (system prompt + tool definitions) not available for history. */
export const SYSTEM_OVERHEAD_TOKENS = 2_000;
export const KEEP_RECENT_MESSAGES = 10;
/** Compaction eligibility is re-checked every N steps (token threshold can trigger earlier). */
export const COMPACTION_INTERVAL = 3;
/** Max persisted messages replayed when seeding a run's context. */
export const RUN_HISTORY_LIMIT = 2000;

/**
 * Best-known context windows for the models this app exposes, keyed by the
 * full model id and (via the fallback in getModelContextWindow) by suffix.
 * Mirrors the frontend budget table so the backend compacts at the SAME 70%
 * of the REAL window instead of a flat 100k.
 */
export interface ModelCaps {
  /** Full context window (input + output) in tokens. */
  contextWindow: number;
  /** Reserve for the model's response. */
  maxOutputTokens: number;
}

const MODEL_CAPS: Record<string, ModelCaps> = {
  'nvidia/nemotron-3-nano-30b-a3b': { contextWindow: 131072, maxOutputTokens: 16384 },
  'nvidia/nemotron-3-super-120b-a12b': { contextWindow: 131072, maxOutputTokens: 16384 },
  'nvidia/nemotron-3-ultra-550b-a55b': { contextWindow: 131072, maxOutputTokens: 32768 },
  'nvidia/llama-nemotron-ultra-8b': { contextWindow: 131072, maxOutputTokens: 16384 },
  'nvidia/llama-nemotron-super-27b': { contextWindow: 131072, maxOutputTokens: 16384 },
  'nvidia/nemotron-3-ultra-550b-a55b:free': { contextWindow: 131072, maxOutputTokens: 16384 },
  'big-pickle': { contextWindow: 131072, maxOutputTokens: 16384 },
  'deepseek-v4-flash-free': { contextWindow: 131072, maxOutputTokens: 16384 },
  'mimo-v2.5-free': { contextWindow: 131072, maxOutputTokens: 16384 },
  'nemotron-3-ultra-free': { contextWindow: 131072, maxOutputTokens: 32768 },
  'laguna-s-2.1-free': { contextWindow: 131072, maxOutputTokens: 16384 },
  'deepseek/deepseek-v4-flash:free': { contextWindow: 131072, maxOutputTokens: 16384 },
  'deepseek/deepseek-v4-flash': { contextWindow: 131072, maxOutputTokens: 16384 },
  'deepseek/deepseek-v4-pro': { contextWindow: 131072, maxOutputTokens: 16384 },
  'z-ai/glm-5.2': { contextWindow: 131072, maxOutputTokens: 16384 },
  'google/gemini-3.7-flash': { contextWindow: 1048576, maxOutputTokens: 65536 },
  'google/gemini-3.6-flash': { contextWindow: 1048576, maxOutputTokens: 65536 },
  'google/gemini-3.5-flash': { contextWindow: 1048576, maxOutputTokens: 65536 },
  'google/gemini-3.5-flash-lite': { contextWindow: 1048576, maxOutputTokens: 65536 },
  'x-ai/grok-4.6': { contextWindow: 131072, maxOutputTokens: 16384 },
  'anthropic/claude-sonnet-4': { contextWindow: 200000, maxOutputTokens: 32768 },
  'anthropic/claude-opus-4': { contextWindow: 200000, maxOutputTokens: 32768 },
  'meta-llama/llama-4-maverick': { contextWindow: 131072, maxOutputTokens: 16384 },
  'qwen/qwen3-coder': { contextWindow: 131072, maxOutputTokens: 16384 },
  'mistralai/mistral-large-2501': { contextWindow: 131072, maxOutputTokens: 16384 },
  'grok-4.6': { contextWindow: 131072, maxOutputTokens: 16384 },
  'gemini-3.7-flash': { contextWindow: 1048576, maxOutputTokens: 65536 },
  'gemini-3.6-flash': { contextWindow: 1048576, maxOutputTokens: 65536 },
  'gemini-3.5-flash': { contextWindow: 1048576, maxOutputTokens: 65536 },
  'gemini-3.5-flash-lite': { contextWindow: 1048576, maxOutputTokens: 65536 },
  'gemini-3.1-pro': { contextWindow: 1048576, maxOutputTokens: 65536 },
  'gemini-3-flash': { contextWindow: 1048576, maxOutputTokens: 65536 },
  'gpt-5.6-luna': { contextWindow: 131072, maxOutputTokens: 16384 },
  'gpt-5.6-sol': { contextWindow: 131072, maxOutputTokens: 32768 },
  'gpt-5.6-terra': { contextWindow: 131072, maxOutputTokens: 32768 },
  'gpt-5.3-codex': { contextWindow: 131072, maxOutputTokens: 16384 },
  'gpt-5.3-codex-spark': { contextWindow: 131072, maxOutputTokens: 16384 },
  'claude-opus-4-6': { contextWindow: 200000, maxOutputTokens: 32768 },
  'claude-sonnet-4-6': { contextWindow: 200000, maxOutputTokens: 32768 },
  'deepseek-v4-flash': { contextWindow: 131072, maxOutputTokens: 16384 },
  'deepseek-v4-pro': { contextWindow: 131072, maxOutputTokens: 16384 },
  'glm-5.2': { contextWindow: 131072, maxOutputTokens: 16384 },
  'grok-4.5': { contextWindow: 131072, maxOutputTokens: 16384 },
  'qwen3.7-plus': { contextWindow: 131072, maxOutputTokens: 16384 },
};

const PROVIDER_CAPS: Record<string, ModelCaps> = {
  nvidia: { contextWindow: 131072, maxOutputTokens: 16384 },
  opencode: { contextWindow: 131072, maxOutputTokens: 16384 },
  openrouter: { contextWindow: 131072, maxOutputTokens: 16384 },
  omniroute: { contextWindow: 131072, maxOutputTokens: 16384 },
  gemini: { contextWindow: 1048576, maxOutputTokens: 65536 },
  openai: { contextWindow: 131072, maxOutputTokens: 16384 },
  xai: { contextWindow: 131072, maxOutputTokens: 16384 },
  anthropic: { contextWindow: 200000, maxOutputTokens: 32768 },
  ollama: { contextWindow: 32768, maxOutputTokens: 4096 },
};

export const FALLBACK_CAPS: ModelCaps = {
  contextWindow: 32768,
  maxOutputTokens: 4096,
};

export function getModelCaps(provider?: string, model?: string): ModelCaps {
  if (model && MODEL_CAPS[model]) return MODEL_CAPS[model];
  if (model) {
    const normalized = model.split('/').pop() ?? model;
    for (const [key, caps] of Object.entries(MODEL_CAPS)) {
      if (key.split('/').pop() === normalized) return caps;
    }
  }
  if (provider && PROVIDER_CAPS[provider]) return PROVIDER_CAPS[provider];
  return FALLBACK_CAPS;
}

/**
 * History-only token budget for a model: full context minus the output
 * reserve minus the fixed system/tool overhead. Compaction fires at 70% of
 * THIS — so a 32k local model compacts well before a 131k one.
 */
export function resolveTokenBudget(provider?: string, model?: string): number {
  const caps = getModelCaps(provider, model);
  return Math.max(
    1,
    caps.contextWindow - caps.maxOutputTokens - SYSTEM_OVERHEAD_TOKENS,
  );
}

export function estimateTokens(messages: LLMMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += (m.content?.length ?? 0) + (m.tool_call_id?.length ?? 0);
    if (m.tool_calls) {
      for (const tc of m.tool_calls) chars += tc.function.name.length + tc.function.arguments.length + 24;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function createEmptySnapshot(task: string): ContextSnapshot {
  return {
    task,
    summary: null,
    coveredMessages: 0,
    filesRead: [],
    filesModified: [],
    decisions: [],
    errors: [],
    plan: [],
  };
}

// ---------------------------------------------------------------------------
// System prompt tiers
//
// The system prompt is built as a single system message whose sections are
// wrapped in machine-readable markers. Tiers let the runner (a) identify which
// parts are extraction-blocking invariants vs cosmetic guidance, (b) drop
// low-priority guidance under token pressure, and (c) strip all markers before
// the transcript reaches the provider.
// ---------------------------------------------------------------------------

export const SYS_MARKERS = {
  high: 'smoke-high-priority',
  core: 'smoke-core-guidance',
  mode: 'smoke-agent-mode',
  archive: 'smoke-archived-guidance',
} as const;

/** Wraps a system-prompt section in its tier marker. */
function wrapTier(marker: string, body: string): string {
  return `<system-${marker}>\n${body}\n</system-${marker}>`;
}

/**
 * Strips internal system-prompt tier markers. Applied in toProviderMessages so
 * providers never see our private delimiters (they carry no meaning for the
 * model and could confuse weak tokenizers).
 */
export function stripSystemMarkers(content: string): string {
  const inner = (m: string): string => (content = content.replace(new RegExp(`<system-${m}>\\n?`, 'g'), '').replace(new RegExp(`\\n?</system-${m}>`, 'g'), ''));
  inner(SYS_MARKERS.high);
  inner(SYS_MARKERS.core);
  inner(SYS_MARKERS.mode);
  inner(SYS_MARKERS.archive);
  return content;
}

/** Extracts the inner body of a single tier section (or '' when absent). */
export function extractSystemTier(content: string, marker: string): string {
  const re = new RegExp(`<system-${marker}>([\\s\\S]*?)(?:</system-${marker}>)`);
  const m = content.match(re);
  return m ? m[1] : '';
}

/**
 * Rebuilds a single system prompt string from the selected tier bodies, in
 * canonical order (HIGH → CORE → MODE). Each present tier is re-wrapped in its
 * marker. Lets the runner drop low-priority guidance under token pressure
 * without touching the persistent RunContext (a fresh array is returned).
 */
export function rebuildSystemPrompt(keep: Partial<Record<'high' | 'core' | 'mode', string>>): string {
  const wrap = (marker: string, body: string): string =>
    body.trim() ? `<system-${marker}>\n${body.trim()}\n</system-${marker}>` : '';
  const block = (key: 'high' | 'core' | 'mode', marker: string): string =>
    keep[key] ? wrap(marker, keep[key]) : '';
  const high = block('high', SYS_MARKERS.high);
  const core = block('core', SYS_MARKERS.core);
  const mode = block('mode', SYS_MARKERS.mode);
  return [high, core, mode].filter(Boolean).join('\n\n');
}

/**
 * Checks the assembled context array that will be sent to the LLM:
 *  - it must lead with a system message
 *  - the high-priority tier must still be present (never trimmed/compacted away)
 *  - no tier markers may survive in non-system history
 * Returns a list of problems; an empty array means compliant.
 */
export function validateSystemPromptCompliance(messages: LLMMessage[]): string[] {
  const problems: string[] = [];
  if (messages.length === 0 || messages[0].role !== 'system') {
    problems.push('context does not start with a system prompt');
    return problems;
  }
  const first = messages[0].content || '';
  const hasHigh = new RegExp(`<system-${SYS_MARKERS.high}>`).test(first);
  if (!hasHigh) problems.push('leading system prompt lost its HIGH_PRIORITY tier');
  for (const m of messages) {
    if (m.role !== 'system' && m.content && /<system-(smoke-[a-z-]+)>/.test(m.content)) {
      problems.push(`history message carries a system tier marker (role=${m.role})`);
    }
  }
  return problems;
}

/** Renders the snapshot as the leading system block: SUMMARY + RECENT replaces full history. */
export function snapshotToSystemMessage(snapshot: ContextSnapshot): LLMMessage | null {
  if (!snapshot.summary) return null;
  const parts = [`<conversation-checkpoint>`, '## Summary of previous work', snapshot.summary.trim()];
  if (snapshot.filesModified.length > 0) {
    parts.push('', '## Files modified earlier', ...snapshot.filesModified.map((f) => `- ${f}`));
  }
  if (snapshot.filesRead.length > 0) {
    parts.push('', '## Files read earlier', ...snapshot.filesRead.slice(0, 40).map((f) => `- ${f}`));
  }
  if (snapshot.decisions.length > 0) {
    parts.push('', '## Decisions made', ...snapshot.decisions.map((d) => `- ${d}`));
  }
  if (snapshot.errors.length > 0) {
    parts.push('', '## Errors encountered (resolved or avoided)', ...snapshot.errors.slice(-10).map((e) => `- ${e}`));
  }
  parts.push('', 'Everything above is historical context. Older messages were compacted into this summary — do NOT assume the raw transcript exists.', `</conversation-checkpoint>`);
  return { role: 'system', content: parts.join('\n') };
}

/**
 * Provider-specific message normalization.
 *
 * CRITICAL: never reduce history to {role, content}. Assistant tool_calls and
 * tool results must survive, otherwise local models lose the call→result
 * relationship and loop / hallucinate results.
 *
 * - OpenAI-compatible: pass tool_calls + tool_call_id through untouched.
 * - Ollama (/api/chat): assistant tool_calls use `{ function: { name, arguments } }`
 *   with arguments as an OBJECT; tool results are plain role:'tool' messages
 *   paired positionally with the preceding tool_calls.
 */
export function toProviderMessages(messages: LLMMessage[], provider?: string): Record<string, unknown>[] {
  const isOllama = provider === 'ollama' || !provider;
  return messages.map((m) => {
    // System prompts carry internal tier markers; strip them so providers only
    // ever see clean instructions (markers are bookkeeping, not content).
    const content = m.role === 'system' ? stripSystemMarkers(m.content ?? '') : m.content ?? '';
    const out: Record<string, unknown> = { role: m.role, content };

    if (m.role === 'assistant' && m.tool_calls?.length) {
      out.tool_calls = m.tool_calls.map((tc) =>
        isOllama
          ? { function: { name: tc.function.name, arguments: safeParseObject(tc.function.arguments) } }
          : {
              id: tc.id,
              type: 'function',
              function: { name: tc.function.name, arguments: tc.function.arguments },
              // Gemini 3.x thinking models require the model's own encrypted
              // thought_signature to be echoed back on this assistant turn.
              ...(tc.thought_signature
                ? { extra_content: { google: { thought_signature: tc.thought_signature } } }
                : {}),
            },
      );
    }

    if (!isOllama && m.role === 'tool' && m.tool_call_id) {
      out.tool_call_id = m.tool_call_id;
    }

    return out;
  });
}

export function safeParseObject(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Tool groups — expose only relevant tools per step instead of all ~20 schemas.
// ---------------------------------------------------------------------------

export type ToolGroupName = 'core' | 'exploration' | 'editing' | 'verification' | 'git' | 'docker';

export const TOOL_GROUPS: Record<ToolGroupName, string[]> = {
  core: ['read_file', 'list_directory', 'todo_write', 'ask_user'],
  exploration: ['glob', 'grep', 'find_symbol', 'search_code', 'run_command'],
  editing: ['edit_file', 'replace_lines', 'write_file', 'apply_patch', 'delete_file'],
  verification: ['run_command', 'run_test'],
  git: ['git_status', 'git_diff', 'git_log'],
  docker: ['docker_exec', 'docker_list'],
};

/** Tools that never mutate anything — safe to execute concurrently. */
export const READ_ONLY_TOOLS = new Set([
  'read_file',
  'list_directory',
  'glob',
  'grep',
  'find_symbol',
  'search_code',
  'git_status',
  'git_diff',
  'git_log',
  'docker_list',
]);

/**
 * Tools that SEARCH or EXPLORE the workspace. When many of these fire in
 * sequence without any mutation or verification, the model is likely stuck
 * in a "looking for something" loop. Used by the doom-loop guard to detect
 * search-family flooding even when the individual tool names/args vary.
 */
export const SEARCH_FAMILY_TOOLS = new Set([
  'glob',
  'grep',
  'find_symbol',
  'search_code',
  'list_directory',
  'read_file',
]);

const INTENT_PATTERNS: Array<{ group: ToolGroupName; re: RegExp }> = [
  { group: 'verification', re: /\b(test|tests|run|execute|compile|build|lint|typecheck|verify|start|launch|serve|install|benchmark)\b/i },
  { group: 'git', re: /\b(commit|push|pull|branch|merge|rebase|stash|tag\b|git\s+(status|diff|log))\b/i },
  { group: 'docker', re: /\bdocker\b|\bcontainer(s)?\b/i },
];

/** Pure questions → exploration only. Anything that changes code → editing too. */
const EXPLORATION_RE =
  /\b(find|where|search|locate|explain|how (does|do|to)|what|why|which|show|list|understand|analyze|review|audit|trace|explore|look|read|summar\w*|document\w*)\b/i;
// Strong build/edit verbs only — generic words like "change"/"make" live in the
// ambiguity fallback instead, so intent-specific asks ("commit this") stay narrow.
const EDIT_RE =
  /\b(fix|bug|add|implement|create|write|refactor|update|modify|remove|delete|replace|rename|extract|introduce|patch|edit|migrate|optimi[sz]e|improve|support|feature)\b/i;

/**
 * Classifies the user's task into the set of tool groups to expose.
 * Read-only requests get a small schema; coding requests get read+write;
 * explicit intents pull in verification/git/docker. Ambiguous tasks default
 * to read+write so the agent can always act.
 */
export function classifyTaskGroups(task: string, agentId: string): Set<ToolGroupName> {
  const groups = new Set<ToolGroupName>(['core']);

  if (agentId === 'plan' || agentId === 'explore') {
    groups.add('exploration');
    return groups;
  }

  const wantsEdit = EDIT_RE.test(task);
  const wantsExplore = EXPLORATION_RE.test(task);
  const matchedGroups = INTENT_PATTERNS.filter((p) => p.re.test(task)).map((p) => p.group);

  groups.add('exploration');

  const ambiguous = !wantsExplore && matchedGroups.length === 0;
  if (wantsEdit || ambiguous) {
    groups.add('editing');
  }

  for (const g of matchedGroups) groups.add(g);

  return groups;
}

export function resolveExposedTools(groups: Set<ToolGroupName>): Set<string> {
  const names = new Set<string>();
  for (const g of groups) for (const n of TOOL_GROUPS[g]) names.add(n);
  return names;
}

// ---------------------------------------------------------------------------
// Task phase state machine
//
// The RUNNER owns the phase; the LLM never has to figure out the workflow on
// its own. Transitions are deterministic reactions to observed tool calls and
// results (an 8B model cannot be trusted to self-declare phases):
//
//   UNDERSTAND → EXPLORE → PLAN? → EDIT ⇄ VERIFY → COMPLETE
//                              ▲         │ fail
//                              └────── RECOVER
// ---------------------------------------------------------------------------

export type AgentPhase =
  | 'understand'
  | 'explore'
  | 'plan'
  | 'edit'
  | 'verify'
  | 'recover'
  | 'complete';

/** Tools that change files — entering one of these means the run is EDITing. */
export const FILE_MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'replace_lines', 'apply_patch', 'delete_file']);
/** Command-family tools double as verification triggers once editing started. */
const VERIFY_TRIGGER_TOOLS = new Set(['run_test', 'run_command']);

export function initialPhase(): AgentPhase {
  return 'understand';
}

/**
 * Phase transition when a tool call is ABOUT to execute (observed intent).
 * Skipped calls (doom-loop/cap/cancelled) never reach this.
 */
export function nextPhaseOnCall(phase: AgentPhase, toolName: string): AgentPhase {
  switch (phase) {
    case 'understand':
    case 'explore':
      if (toolName === 'todo_write') return 'plan';
      if (FILE_MUTATING_TOOLS.has(toolName)) return 'edit';
      if (phase === 'understand') return 'explore';
      return phase;
    case 'plan':
      if (FILE_MUTATING_TOOLS.has(toolName)) return 'edit';
      return phase;
    case 'edit':
      if (VERIFY_TRIGGER_TOOLS.has(toolName)) return 'verify';
      return phase;
    case 'recover':
      // A fix attempt re-enters EDIT; a direct re-check jumps to VERIFY.
      if (FILE_MUTATING_TOOLS.has(toolName)) return 'edit';
      if (VERIFY_TRIGGER_TOOLS.has(toolName)) return 'verify';
      return phase;
    default:
      // verify waits for its result; complete is terminal.
      return phase;
  }
}

/**
 * Phase transition after a tool RESULT arrives. Verification failures in the
 * VERIFY phase demote the run to RECOVER; success keeps it in VERIFY until
 * the model finalizes.
 */
export function nextPhaseOnResult(phase: AgentPhase, toolName: string, failed: boolean): AgentPhase {
  if (!failed) return phase;
  if ((phase === 'verify' || phase === 'recover') && VERIFY_TRIGGER_TOOLS.has(toolName)) return 'recover';
  return phase;
}

/** Tool names each phase makes available — exposure only ever GROWS. */
const phaseTools = (...names: ToolGroupName[]): Set<string> => resolveExposedTools(new Set(names));
export const PHASE_TOOLS: Record<AgentPhase, Set<string>> = {
  understand: phaseTools('core', 'exploration'),
  explore: phaseTools('core', 'exploration'),
  plan: phaseTools('core', 'exploration'),
  edit: phaseTools('core', 'editing'),
  verify: phaseTools('core', 'verification'),
  recover: phaseTools('core', 'editing', 'verification'),
  complete: new Set(),
};

/**
 * Ephemeral per-step directive injected before the LLM call. Short and
 * imperative — the model should always know which phase it is in and what
 * behavior that phase expects.
 */
export function phaseDirective(phase: AgentPhase): string | null {
  switch (phase) {
    case 'understand':
      return 'CURRENT PHASE: UNDERSTAND — Confirm what the task requires. If anything essential is ambiguous, use ask_user. Otherwise start exploring the relevant code.';
    case 'explore':
      return 'CURRENT PHASE: EXPLORE — Gather the minimum context needed using read/search tools. Base every claim on actual file contents, not guesses.';
    case 'plan':
      return 'CURRENT PHASE: PLAN — Record concrete steps with todo_write, then immediately begin executing them.';
    case 'edit':
      return 'CURRENT PHASE: EDIT — Make the smallest correct changes, one logical change at a time. Do not start verifying until edits are coherent.';
    case 'verify':
      return 'CURRENT PHASE: VERIFY — Prove the changes work: run tests/builds/checks. If verification fails you will enter RECOVER: diagnose the root cause first.';
    case 'recover':
      return 'CURRENT PHASE: RECOVER — A check failed. Read the failure carefully, find the ROOT CAUSE, fix it, then run the failing check again to return to VERIFY.';
    case 'complete':
      return null;
  }
}

// ---------------------------------------------------------------------------
// AgentState snapshot — full resumable state built from RunContext.
// ---------------------------------------------------------------------------

/**
 * Builds a serializable AgentState from the live RunContext.
 * This is the source of truth persisted to DB + disk at every checkpoint.
 */
export function buildAgentState(ctx: RunContext): import('../entities/agent-run.entity').AgentState {
  // Deduplicate error messages with counts.
  const errorMap = new Map<string, number>();
  for (const e of ctx.observations.filter((o) => /error|fail/i.test(o))) {
    errorMap.set(e, (errorMap.get(e) || 0) + 1);
  }
  const errors = [...errorMap.entries()].map(([message, count]) => ({ message, count }));

  // Collect test-run artifacts from recent tool results (last 10).
  const testsRun: string[] = [];
  for (const r of ctx.lastToolCalls.slice(-10)) {
    if (r.name === 'run_test') testsRun.push(r.args);
  }

  return {
    phase: ctx.phase,
    task: ctx.task,
    plan: ctx.plan,
    currentStep: ctx.currentStep,
    currentObjective: phaseDirective(ctx.phase) ?? ctx.task,
    files: {
      read: [...ctx.filesRead],
      modified: [...ctx.filesModified],
    },
    facts: ctx.observations,
    decisions: ctx.observations.filter((o) => /decision|chose| decided|approach/i.test(o)),
    errors,
    pendingToolCalls: [],
    verification: {
      testsRun,
      passed: ctx.phase === 'complete',
    },
    tokenUsage: {
      input: ctx.inputTokens,
      output: ctx.outputTokens,
    },
  };
}
