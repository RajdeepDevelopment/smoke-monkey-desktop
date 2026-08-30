/**
 * Lightweight, model-aware token budgeting for the chat composer.
 *
 * The backend is the final authority — everything here is an *estimate* used
 * for UX (grow a counter, warn before the provider rejects the request). No
 * silent truncation ever happens; the composer only prevents sending when the
 * estimated budget is exceeded.
 */

/** Model capability record used to size the input budget. */
export interface ModelCapabilities {
  /** Full context window (input + output) in tokens. */
  contextWindow: number;
  /** Tokens reserved for the model's reply. */
  maxOutputTokens: number;
}

/** Best-known capabilities for the models this app exposes. All estimates. */
const MODEL_CAPS: Record<string, ModelCapabilities> = {
  // NVIDIA NIM / Nemotron 3 family
  'nvidia/nemotron-3-nano-30b-a3b': { contextWindow: 131072, maxOutputTokens: 16384 },
  'nvidia/nemotron-3-super-120b-a12b': { contextWindow: 131072, maxOutputTokens: 16384 },
  'nvidia/nemotron-3-ultra-550b-a55b': { contextWindow: 131072, maxOutputTokens: 32768 },
  'nvidia/llama-nemotron-ultra-8b': { contextWindow: 131072, maxOutputTokens: 16384 },
  'nvidia/llama-nemotron-super-27b': { contextWindow: 131072, maxOutputTokens: 16384 },
  'nvidia/nemotron-3-ultra-550b-a55b:free': { contextWindow: 131072, maxOutputTokens: 16384 },
  // OpenCode Zen free tier
  'big-pickle': { contextWindow: 131072, maxOutputTokens: 16384 },
  'deepseek-v4-flash-free': { contextWindow: 131072, maxOutputTokens: 16384 },
  'mimo-v2.5-free': { contextWindow: 131072, maxOutputTokens: 16384 },
  'nemotron-3-ultra-free': { contextWindow: 131072, maxOutputTokens: 32768 },
  'laguna-s-2.1-free': { contextWindow: 131072, maxOutputTokens: 16384 },
  'hy3-free': { contextWindow: 131072, maxOutputTokens: 16384 },
  'ling-3.0-flash-fin-free': { contextWindow: 131072, maxOutputTokens: 16384 },
  'nemotron-3.5-lightning-free': { contextWindow: 131072, maxOutputTokens: 16384 },
  'muse-spark-1.2-contributor-free': { contextWindow: 131072, maxOutputTokens: 16384 },
  // OpenCode Zen recommended models
  'gpt-5.6-sol': { contextWindow: 131072, maxOutputTokens: 32768 },
  'gpt-5.6-terra': { contextWindow: 131072, maxOutputTokens: 32768 },
  'gpt-5.6-luna': { contextWindow: 131072, maxOutputTokens: 16384 },
  'gpt-5.4-mini': { contextWindow: 131072, maxOutputTokens: 16384 },
  'gpt-5.4-nano': { contextWindow: 131072, maxOutputTokens: 16384 },
  'claude-opus-4-6': { contextWindow: 200000, maxOutputTokens: 32768 },
  'claude-sonnet-4-6': { contextWindow: 200000, maxOutputTokens: 32768 },
  'claude-sonnet-4': { contextWindow: 200000, maxOutputTokens: 32768 },
  'claude-haiku-4-5': { contextWindow: 200000, maxOutputTokens: 16384 },
  'gemini-3.1-pro': { contextWindow: 1048576, maxOutputTokens: 65536 },
  'gemini-3-flash': { contextWindow: 1048576, maxOutputTokens: 65536 },
  'grok-4.6': { contextWindow: 131072, maxOutputTokens: 16384 },
  'grok-4.5': { contextWindow: 131072, maxOutputTokens: 16384 },
  'grok-build-0.1': { contextWindow: 131072, maxOutputTokens: 16384 },
  'deepseek-v4-pro': { contextWindow: 131072, maxOutputTokens: 16384 },
  'deepseek-v4-flash': { contextWindow: 131072, maxOutputTokens: 16384 },
  'glm-5.2': { contextWindow: 131072, maxOutputTokens: 16384 },
  'glm-5.1': { contextWindow: 131072, maxOutputTokens: 16384 },
  'glm-5': { contextWindow: 131072, maxOutputTokens: 16384 },
  'qwen3.7-max': { contextWindow: 131072, maxOutputTokens: 16384 },
  'qwen3.7-plus': { contextWindow: 131072, maxOutputTokens: 16384 },
  'qwen3.6-plus': { contextWindow: 131072, maxOutputTokens: 16384 },
  'qwen3.5-plus': { contextWindow: 131072, maxOutputTokens: 16384 },
  'minimax-m3': { contextWindow: 131072, maxOutputTokens: 16384 },
  'minimax-m2.7': { contextWindow: 131072, maxOutputTokens: 16384 },
  'minimax-m2.5': { contextWindow: 131072, maxOutputTokens: 16384 },
  'kimi-k2.7-code': { contextWindow: 131072, maxOutputTokens: 16384 },
  'kimi-k3': { contextWindow: 131072, maxOutputTokens: 16384 },
  'kimi-k2.6': { contextWindow: 131072, maxOutputTokens: 16384 },
  'kimi-k2.5': { contextWindow: 131072, maxOutputTokens: 16384 },
  // Popular OpenRouter :free models
  'deepseek/deepseek-v4-flash:free': { contextWindow: 131072, maxOutputTokens: 16384 },
  'google/gemini-3.5-flash-lite': { contextWindow: 1048576, maxOutputTokens: 65536 },
  'google/gemini-3.5-flash': { contextWindow: 1048576, maxOutputTokens: 65536 },
  'google/gemini-3.6-flash': { contextWindow: 1048576, maxOutputTokens: 65536 },
  'google/gemini-3.7-flash': { contextWindow: 1048576, maxOutputTokens: 65536 },
  'meta-llama/llama-4-scout-17b-16e:free': { contextWindow: 131072, maxOutputTokens: 16384 },
  'mistralai/mistral-small-3.2:free': { contextWindow: 131072, maxOutputTokens: 32768 },
};

/** Provider-level defaults (used when the exact model id is unknown). */
const PROVIDER_CAPS: Record<string, ModelCapabilities> = {
  nvidia: { contextWindow: 131072, maxOutputTokens: 16384 },
  opencode: { contextWindow: 131072, maxOutputTokens: 16384 },
  openrouter: { contextWindow: 131072, maxOutputTokens: 16384 },
  omniroute: { contextWindow: 131072, maxOutputTokens: 16384 },
  gemini: { contextWindow: 1048576, maxOutputTokens: 65536 },
  openai: { contextWindow: 131072, maxOutputTokens: 16384 },
  xai: { contextWindow: 131072, maxOutputTokens: 16384 },
  ollama: { contextWindow: 32768, maxOutputTokens: 4096 },
};

/** Fallback for providers/models we have no data for. */
export const FALLBACK_CAPS: ModelCapabilities = {
  contextWindow: 32768,
  maxOutputTokens: 4096,
};

/** Fixed per-request overhead the user never types: system + developer +
 *  tool definitions + prompt templates. */
const SYSTEM_OVERHEAD_TOKENS = 2000;
/** Extra budget reserved when RAG knowledge retrieval is active (retrieved
 *  chunks + memory can be large). */
const RAG_RESERVE_TOKENS = 12000;

export function getModelCapabilities(provider: string, model: string): ModelCapabilities {
  const exact = MODEL_CAPS[model];
  if (exact) return exact;
  const normalized = model.split('/').pop() ?? model;
  for (const [key, caps] of Object.entries(MODEL_CAPS)) {
    if (key.split('/').pop() === normalized) return caps;
  }
  return PROVIDER_CAPS[provider] ?? FALLBACK_CAPS;
}

const CJK_RE = /[\u3000-\u303f\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af\ud800-\udfff\u{1f300}-\u{1faff}]/gu;

/**
 * Approximate token count. Latin/ASCII ≈ 4 chars/token; CJK + emoji consume
 * more tokens per character. Marked an estimate — the backend counts exactly.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(other / 4) + Math.ceil(cjk / 1.5);
}

export interface TokenBudgetInput {
  provider: string;
  model: string;
  /** Tokens already consumed by the conversation history. */
  historyTokens: number;
  /** Retrieved-document / RAG context is expected in the request. */
  ragActive: boolean;
  /** Current composer text (excludes history). */
  inputTokens: number;
}

export interface TokenBudget {
  /** Input tokens the current request is expected to consume. */
  used: number;
  /** Available input budget after reserving output, system and context. */
  limit: number;
  /** 0 normal · 1 warning · 2 critical · 3 over (sending blocked). */
  state: 0 | 1 | 2 | 3;
  /** True when the model id/provider was matched exactly. */
  known: boolean;
}

export function computeTokenBudget(input: TokenBudgetInput): TokenBudget {
  const caps = getModelCapabilities(input.provider, input.model);
  const known = MODEL_CAPS[input.model] !== undefined;
  const reservedOutput = caps.maxOutputTokens;
  const contextReserve = input.ragActive ? RAG_RESERVE_TOKENS : 0;
  const limit = Math.max(
    1,
    caps.contextWindow - reservedOutput - SYSTEM_OVERHEAD_TOKENS - contextReserve,
  );
  const used = input.inputTokens + input.historyTokens + SYSTEM_OVERHEAD_TOKENS + contextReserve;

  let state: TokenBudget['state'];
  if (used >= limit) state = 3;
  else if (used >= limit * 0.95) state = 2;
  else if (used >= limit * 0.8) state = 1;
  else state = 0;
  return { used, limit, state, known };
}

export function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return String(n);
}

/** Estimated tokens for a list of {role, content} history messages. */
export function estimateHistoryTokens(messages: { role: string; content: string }[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content) + 4; // per-message role/format overhead
  }
  return total;
}
