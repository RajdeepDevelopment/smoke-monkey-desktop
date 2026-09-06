/**
 * OpenCode Zen — the recommended coding-agent gateway.
 * See https://opencode.ai/zen for the official catalog and pricing.
 *
 * Model IDs are sent as the `model` field to the Zen OpenAI-compatible
 * endpoint https://opencode.ai/zen/v1/chat/completions (which is route-
 * agnostic and accepts every ID below regardless of the SDK package that
 * OpenCode's docs list for it).
 */

export interface OpenCodeZenModel {
  id: string;
  name: string;
  isFree: boolean;
  group: string;
}

export const OPENCODE_ZEN_MODELS: OpenCodeZenModel[] = [
  // ── GPT (OpenAI) ──────────────────────────────────────────────────────────
  { id: 'gpt-5.6-sol', name: 'GPT 5.6 Sol', isFree: false, group: 'GPT' },
  { id: 'gpt-5.6-terra', name: 'GPT 5.6 Terra', isFree: false, group: 'GPT' },
  { id: 'gpt-5.6-luna', name: 'GPT 5.6 Luna', isFree: false, group: 'GPT' },
  { id: 'gpt-5.5', name: 'GPT 5.5', isFree: false, group: 'GPT' },
  { id: 'gpt-5.5-pro', name: 'GPT 5.5 Pro', isFree: false, group: 'GPT' },
  { id: 'gpt-5.4', name: 'GPT 5.4', isFree: false, group: 'GPT' },
  { id: 'gpt-5.4-pro', name: 'GPT 5.4 Pro', isFree: false, group: 'GPT' },
  { id: 'gpt-5.4-mini', name: 'GPT 5.4 Mini', isFree: false, group: 'GPT' },
  { id: 'gpt-5.4-nano', name: 'GPT 5.4 Nano', isFree: false, group: 'GPT' },
  { id: 'gpt-5.3-codex', name: 'GPT 5.3 Codex', isFree: false, group: 'GPT Codex' },
  { id: 'gpt-5.3-codex-spark', name: 'GPT 5.3 Codex Spark', isFree: false, group: 'GPT Codex' },
  { id: 'gpt-5.2', name: 'GPT 5.2', isFree: false, group: 'GPT' },
  { id: 'gpt-5.2-codex', name: 'GPT 5.2 Codex', isFree: false, group: 'GPT Codex' },
  { id: 'gpt-5.1', name: 'GPT 5.1', isFree: false, group: 'GPT' },
  { id: 'gpt-5.1-codex', name: 'GPT 5.1 Codex', isFree: false, group: 'GPT Codex' },
  { id: 'gpt-5.1-codex-max', name: 'GPT 5.1 Codex Max', isFree: false, group: 'GPT Codex' },
  { id: 'gpt-5.1-codex-mini', name: 'GPT 5.1 Codex Mini', isFree: false, group: 'GPT Codex' },
  { id: 'gpt-5', name: 'GPT 5', isFree: false, group: 'GPT' },
  { id: 'gpt-5-codex', name: 'GPT 5 Codex', isFree: false, group: 'GPT Codex' },
  { id: 'gpt-5-nano', name: 'GPT 5 Nano', isFree: false, group: 'GPT' },

  // ── Claude (Anthropic) ───────────────────────────────────────────────────
  { id: 'claude-fable-5', name: 'Claude Fable 5', isFree: false, group: 'Claude' },
  { id: 'claude-opus-5', name: 'Claude Opus 5', isFree: false, group: 'Claude' },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', isFree: false, group: 'Claude' },
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', isFree: false, group: 'Claude' },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', isFree: false, group: 'Claude' },
  { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', isFree: false, group: 'Claude' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', isFree: false, group: 'Claude' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', isFree: false, group: 'Claude' },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', isFree: false, group: 'Claude' },
  { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', isFree: false, group: 'Claude' },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', isFree: false, group: 'Claude' },

  // ── Gemini (Google) ──────────────────────────────────────────────────────
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', isFree: false, group: 'Gemini' },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', isFree: false, group: 'Gemini' },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', isFree: false, group: 'Gemini' },
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', isFree: false, group: 'Gemini' },
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', isFree: false, group: 'Gemini' },
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash', isFree: false, group: 'Gemini' },

  // ── Grok (xAI) ───────────────────────────────────────────────────────────
  { id: 'grok-4.6', name: 'Grok 4.6', isFree: false, group: 'Grok' },
  { id: 'grok-4.5', name: 'Grok 4.5', isFree: false, group: 'Grok' },
  { id: 'grok-build-0.1', name: 'Grok Build 0.1', isFree: false, group: 'Grok' },

  // ── Muse ─────────────────────────────────────────────────────────────────
  { id: 'muse-spark-1.2', name: 'Muse Spark 1.2', isFree: false, group: 'Muse' },

  // ── Qwen (Alibaba) ───────────────────────────────────────────────────────
  { id: 'qwen3.7-max', name: 'Qwen3.7 Max', isFree: false, group: 'Qwen' },
  { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus', isFree: false, group: 'Qwen' },
  { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus', isFree: false, group: 'Qwen' },
  { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus', isFree: false, group: 'Qwen' },

  // ── DeepSeek ─────────────────────────────────────────────────────────────
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', isFree: false, group: 'DeepSeek' },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', isFree: false, group: 'DeepSeek' },
  { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free', isFree: true, group: 'Free' },

  // ── MiniMax ──────────────────────────────────────────────────────────────
  { id: 'minimax-m3', name: 'MiniMax M3', isFree: false, group: 'MiniMax' },
  { id: 'minimax-m2.7', name: 'MiniMax M2.7', isFree: false, group: 'MiniMax' },
  { id: 'minimax-m2.5', name: 'MiniMax M2.5', isFree: false, group: 'MiniMax' },

  // ── GLM (Z.ai) ───────────────────────────────────────────────────────────
  { id: 'glm-5.2', name: 'GLM 5.2', isFree: false, group: 'GLM' },
  { id: 'glm-5.1', name: 'GLM 5.1', isFree: false, group: 'GLM' },
  { id: 'glm-5', name: 'GLM 5', isFree: false, group: 'GLM' },

  // ── Kimi (Moonshot) ──────────────────────────────────────────────────────
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', isFree: false, group: 'Kimi' },
  { id: 'kimi-k3', name: 'Kimi K3', isFree: false, group: 'Kimi' },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', isFree: false, group: 'Kimi' },
  { id: 'kimi-k2.5', name: 'Kimi K2.5', isFree: false, group: 'Kimi' },

  // ── Free (OpenCode Zen) ──────────────────────────────────────────────────
  { id: 'big-pickle', name: 'Big Pickle', isFree: true, group: 'Free' },
  { id: 'mimo-v2.5-free', name: 'MiMo-V2.5 Free', isFree: true, group: 'Free' },
  { id: 'hy3-free', name: 'Hy3 Free', isFree: true, group: 'Free' },
  { id: 'ling-3.0-flash-fin-free', name: 'Ling 3.0 Flash Fin Free', isFree: true, group: 'Free' },
  { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra Free', isFree: true, group: 'Free' },
  { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning Free', isFree: true, group: 'Free' },
  { id: 'laguna-s-2.1-free', name: 'Laguna S 2.1 Free', isFree: true, group: 'Free' },
  { id: 'muse-spark-1.2-contributor-free', name: 'Muse Spark 1.2 Contributor Free', isFree: true, group: 'Free' },
];

export const OPENCODE_ZEN_MODEL_IDS: string[] = OPENCODE_ZEN_MODELS.map((m) => m.id);

export const OPENCODE_ZEN_ENDPOINT = 'https://opencode.ai/zen/v1/chat/completions';
