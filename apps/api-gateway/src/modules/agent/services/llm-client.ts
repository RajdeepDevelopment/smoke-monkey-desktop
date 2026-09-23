/**
 * LLMClient — library-wrapped LLM transport for the agent.
 *
 * Owns every network/polling concern of calling a chat model:
 *  - provider endpoint + API-key resolution (OpenAI, OpenRouter, NVIDIA, xAI,
 *    Gemini, opencode, OmniRoute, Ollama, custom base URLs)
 *  - OpenAI-compatible streaming (SSE) with real-time text/thought deltas
 *  - an IDLE-BASED deadline watchdog instead of a fixed wall-clock timeout
 *  - transient error retry policy (429/5xx/network blips)
 *
 * The client is framework-agnostic: it receives its collaborators (API keys,
 * event emitter, run abort signal) via a small deps object, so it can be
 * pulled out and reused across hosts.
 */
import { Logger } from '@nestjs/common';
import { AgentEventEmitter } from './agent-event.emitter';
import { ApiKeysService } from '../../keys/api-keys.service';
import {
  extractThoughtDelta,
  normalizeToolCalls,
  type LLMToolCall,
  type LLMToolDef,
} from './tool-library';
import { toProviderMessages, type LLMMessage } from './run-context';

// Transient LLM/provider failures worth an automatic retry.
const MAX_LLM_RETRIES = 3;
const RETRYABLE_LLM_ERROR =
  /timeout|etimedout|econnreset|econnrefused|socket hang up|rate.?limit|too many requests|bad gateway|service unavailable|internal server error|overloaded|server error|\b5\d\d\b/i;

/** OmniRoute ids that route through the Cloudflare-playground / keyless free
 *  tier. Verified empirically: these answer a request carrying `tools` with
 *  plain text (tool call written inline, often mangled) and never a structured
 *  `tool_calls` array, so the agent loop cannot dispatch tools on them. Only
 *  the `cfp/*` namespace and the `auto/*` smart lanes that resolve into it.
 *  OpenCode-tier ids (big-pickle, deepseek-v4-flash-free, …) are excluded on
 *  purpose: they either work (OpenCode's own model) or fail loudly with a
 *  clear provider 403 — never silently — so the retry/repeated-error path
 *  already surfaces them without the guard's help. */
const OMNIROUTE_FREE_TIER_MODEL = /^(cfp|auto)\//;

const OMNIROUTE_AGENTIC_FALLBACK_PROVIDER = process.env.OMNIROUTE_AGENTIC_FALLBACK_PROVIDER || '';
const OMNIROUTE_AGENTIC_FALLBACK_MODEL = process.env.OMNIROUTE_AGENTIC_FALLBACK_MODEL || '';

export function isOmniRouteFreeTierModel(model: string): boolean {
  return OMNIROUTE_FREE_TIER_MODEL.test((model || '').trim());
}

/** Providers that stream deltas through parseStreamingResponse (text already emitted live). */
export const STREAMING_PROVIDERS = new Set(['openai', 'openrouter', 'nvidia', 'xai', 'gemini', 'opencode', 'omniroute']);

export interface LLMResponse {
  content: string | null;
  tool_calls: LLMToolCall[];
  usage?: { prompt_tokens: number; completion_tokens: number };
  finish_reason?: string | null;
  /** Model reasoning/thinking stream ("Thought phase"). */
  reasoning?: string | null;
}

/** Collaborators the client needs to talk to the world. */
export interface LlmClientDeps {
  /** User-key store for provider-specific API keys (isolated per user). */
  apiKeyService: Pick<ApiKeysService, 'getKey'>;
  /** Emits live text/thought deltas while an SSE stream is being parsed. */
  eventEmitter: Pick<AgentEventEmitter, 'emitTextDelta' | 'emitTextThought'>;
  /** Returns the run's AbortSignal (if any) so interrupt() cancels in-flight LLM calls. */
  getActiveRunSignal(sessionId?: string): AbortSignal | undefined;
}

/** Optional per-call streaming hooks. Fired as fast as SSE chunks arrive so a
 *  caller can forward deltas to its own transport (e.g. the Git agent's SSE
 *  stream) without going through the agent session event bus. */
export interface LlmStreamHooks {
  /** Called with every content delta chunk (non-streaming providers never call this). */
  onDelta?: (text: string) => void | Promise<void>;
  /** Called with every reasoning/thinking delta chunk. */
  onThought?: (text: string) => void | Promise<void>;
}

export class LLMClient {
  private readonly logger = new Logger(LLMClient.name);

  constructor(private readonly deps: LlmClientDeps) {}

  /** Policy-driven retries for transient provider failures (429/5xx/timeouts). */
  async callWithRetry(
    messages: LLMMessage[],
    tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
    provider?: string,
    model?: string,
    sessionId?: string,
    runId?: string,
    userId?: string,
    hooks?: LlmStreamHooks,
  ): Promise<LLMResponse> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.callLLM(messages, tools, provider, model, sessionId, runId, userId, hooks);
      } catch (retryErr: any) {
        attempt++;
        const msg = String(retryErr?.message || retryErr);
        const status = Number(retryErr?.status ?? retryErr?.response?.status ?? 0);
        const fatalAuth = status === 401 || status === 403 || /unauthorized|invalid api key|forbidden/i.test(msg);
        const aborted = /abort/i.test(msg) || retryErr?.name === 'AbortError';
        const retriable = !aborted && (RETRYABLE_LLM_ERROR.test(msg) || [408, 429, 500, 502, 503, 504].includes(status));
        if (fatalAuth || aborted || !retriable || attempt > MAX_LLM_RETRIES) throw retryErr;
        const delay = Math.min(8_000, 1_000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
        this.logger.warn(
          `LLM transient failure (attempt ${attempt}/${MAX_LLM_RETRIES}): ${msg.slice(0, 140)} — retrying in ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  /**
   * Idle-reset deadline guard for a single LLM call.
   *
   * A fixed wall-clock timeout (~120s) silently kills slow-deliberation models
   * — e.g. oc/big-pickle on the local OmniRoute gateway — which legitimately
   * stream long reasoning runs for minutes, then flags the run `repeated_error`.
   * This guard instead aborts only when the call makes NO forward progress for
   * `idleMs` (default 90s, env `AGENT_LLM_IDLE_TIMEOUT_MS`) or blows past a
   * generous absolute ceiling (default 15min, env `AGENT_LLM_TIMEOUT_MS`).
   * `touch()` resets the idle clock on every received SSE chunk, so a
   * slow-but-alive model runs to completion; a genuinely dead stream is killed
   * promptly. `dispose()` clears the watchdog once the call settles.
   */
  private createLLMTimeoutSignal(external?: AbortSignal) {
    const idleMs = Number(process.env.AGENT_LLM_IDLE_TIMEOUT_MS) || 90_000;
    const capMs = Number(process.env.AGENT_LLM_TIMEOUT_MS) || 900_000;
    const controller = new AbortController();
    const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal;
    let lastActivity = Date.now();
    const startedAt = lastActivity;
    const timer = setInterval(() => {
      const now = Date.now();
      if (now - lastActivity > idleMs) {
        controller.abort(new Error(`LLM stream stalled (no tokens for ${Math.round(idleMs / 1000)}s)`));
      } else if (now - startedAt > capMs) {
        controller.abort(new Error(`LLM call exceeded ${Math.round(capMs / 1000)}s ceiling`));
      }
    }, 5_000);
    // Never keep the process alive solely for the watchdog.
    if (typeof timer.unref === 'function') timer.unref();
    return {
      signal,
      touch: () => { lastActivity = Date.now(); },
      dispose: () => clearInterval(timer),
    };
  }private async callLLM(
    messages: LLMMessage[],
    tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
    provider?: string,
    model?: string,
    sessionId?: string,
    runId?: string,
    userId?: string,
    hooks?: LlmStreamHooks,
  ): Promise<LLMResponse> {
    const baseUrl = process.env.LLM_BASE_URL || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    const modelName = model || process.env.AGENT_MODEL || 'qwen3:8b';

    const toolDefs = tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    let url = baseUrl;
    const useStreaming = STREAMING_PROVIDERS.has(provider || '');

    // Resolve API key: user's stored key first, then env var fallback.
    // Each user's key is isolated — never shared across users.
    const userKey = userId ? await this.deps.apiKeyService.getKey(userId, provider || 'ollama') : undefined;

    if (provider === 'nvidia') {
      const nvidiaKey = userKey || process.env.NVIDIA_API_KEY || '';
      if (nvidiaKey) headers['Authorization'] = `Bearer ${nvidiaKey}`;
      url = `https://integrate.api.nvidia.com/v1/chat/completions`;
    } else if (provider === 'openai') {
      const apiKey = userKey || process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || '';
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      url = `https://api.openai.com/v1/chat/completions`;
    } else if (provider === 'openrouter') {
      const apiKey = userKey || process.env.OPENROUTER_API_KEY || process.env.LLM_API_KEY || '';
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      url = `https://openrouter.ai/api/v1/chat/completions`;
    } else if (provider === 'xai') {
      const apiKey = userKey || process.env.XAI_API_KEY || '';
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      url = `https://api.x.ai/v1/chat/completions`;
    } else if (provider === 'gemini') {
      const apiKey = userKey || process.env.GEMINI_API_KEY || '';
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      url = `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`;
    } else if (provider === 'opencode') {
      const apiKey = userKey || process.env.OPENCODE_API_KEY || process.env.LLM_API_KEY || '';
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      url = `https://opencode.ai/zen/v1/chat/completions`;
    } else if (provider === 'omniroute') {
      // OmniRoute: local OpenAI-compatible gateway (github.com/diegosouzapw/OmniRoute).
      // Keyless by default; use the user's saved key, else the env/placeholder.
      const omniKey = userKey || process.env.OMNIROUTE_API_KEY || 'omniroute';
      if (omniKey) headers['Authorization'] = `Bearer ${omniKey}`;
      const omniBase = process.env.OMNIROUTE_BASE_URL || 'http://localhost:20128/v1';
      url = `${omniBase.replace(/\/+$/, '')}/chat/completions`;
    } else if (provider === 'ollama' || !provider) {
      url = `${baseUrl}/api/chat`;
    }

    // Provider-specific normalization: assistant tool_calls and tool results
    // MUST survive the trip — stripping them (the old behavior) breaks the
    // call→result pairing and causes repeated/hallucinated tool calls on
    // local models like Qwen.
    const llmMessages = toProviderMessages(messages, provider);

    const body: Record<string, unknown> = {
      model: modelName,
      messages: llmMessages,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      stream: useStreaming,
    };

    this.logger.debug(`LLM call: provider=${provider} model=${modelName} url=${url} msgs=${messages.length} stream=${useStreaming}`);

    // Prompt integrity telemetry: pin down whether the system prompt survived
    // assembly + normalization, and confirm no system message drifted into the
    // conversation body (single-authoritative-system invariant).
    try {
      const systemMsgs = llmMessages.filter((m: any) => m.role === 'system');
      const firstUserIdx = llmMessages.findIndex((m: any) => m.role !== 'system');
      const polluted = llmMessages.some(
        (m: any, i: number) => m.role === 'system' && i > firstUserIdx,
      );
      const systemChars = systemMsgs.reduce((n: number, m: any) => n + String(m.content || '').length, 0);
      this.logger.debug(
        `[PROMPT] provider=${provider} model=${modelName} systemMessages=${systemMsgs.length} ` +
        `systemChars=${systemChars} conversationMsgs=${llmMessages.length - systemMsgs.length} ` +
        `conversationPolluted=${polluted}`,
      );
    } catch { /* telemetry is best-effort */ }

    // Tie the request to the run's abort signal so interrupt() cancels an
    // in-flight LLM call immediately instead of waiting for the next step.
    // The LLM deadline itself is IDLE-based (see createLLMTimeoutSignal): a
    // fixed 120s wall-clock cap used to abort slow-deliberation models (e.g.
    // oc/big-pickle on the local OmniRoute gateway) mid-thought and then flag
    // the run `repeated_error`. Now only a genuinely silent stream is killed —
    // a slow-but-alive reasoning stream runs to completion.
    const activeController = this.deps.getActiveRunSignal(sessionId);
    const llmDeadline = this.createLLMTimeoutSignal(activeController);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: llmDeadline.signal,
      });
    } catch (err) {
      llmDeadline.dispose();
      throw err;
    }
    llmDeadline.touch(); // headers arrived — reset the idle clock

    if (!response.ok) {
      llmDeadline.dispose();
      const errText = await response.text().catch(() => 'Unknown error');
      const err = new Error(`LLM API error (${response.status}): ${errText.slice(0, 500)}`) as Error & { status?: number };
      err.status = response.status;
      throw err;
    }

    // Non-streaming path (ollama or fallback)
    if (!useStreaming) {
      llmDeadline.touch();
      const data = await response.json() as any;
      // Some providers (NVIDIA free tier, proxies like OmniRoute) return HTTP
      // 200 with an `error` object in the body when the upstream model is rate
      // limited / out of quota. Without this check that payload silently
      // becomes an "empty response" and the run dies with a generic message
      // instead of the real reason (e.g. 429).
      const bodyErr = data?.error;
      if (bodyErr) {
        llmDeadline.dispose();
        const code = Number(bodyErr?.code ?? bodyErr?.status ?? response.status ?? 0);
        const text = typeof bodyErr === 'string' ? bodyErr : (bodyErr?.message || JSON.stringify(bodyErr).slice(0, 300));
        const err = new Error(`LLM API error (${code}): ${String(text).slice(0, 500)}`) as Error & { status?: number };
        if (code) err.status = code;
        throw err;
      }
      if (provider === 'ollama' || !provider) {
        const msg = data.message;
        // Ollama emits tool_calls as { function: { name, arguments: OBJECT } }
        // with no id field — normalize to the internal shape so downstream
        // argument handling and history replay work unchanged.
        const rawCalls: any[] = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
        const tool_calls: LLMToolCall[] = rawCalls
          .map((tc, i) => ({
            id: typeof tc?.id === 'string' && tc.id
              ? tc.id
              : `ollama_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`,
            type: 'function' as const,
            function: {
              name: String(tc?.function?.name || ''),
              arguments:
                typeof tc?.function?.arguments === 'string'
                  ? tc.function.arguments
                  : JSON.stringify(tc?.function?.arguments ?? {}),
            },
          }))
          .filter((tc) => tc.function.name.trim() !== '');
        llmDeadline.dispose();
        return {
          content: msg?.content || null,
          tool_calls,
          reasoning: (typeof msg?.reasoning === 'string' && msg.reasoning) || (typeof msg?.thinking === 'string' && msg.thinking) ? (msg.reasoning ?? msg.thinking) : null,
          usage: data.prompt_eval_count ? {
            prompt_tokens: data.prompt_eval_count || 0,
            completion_tokens: data.eval_count || 0,
          } : undefined,
        };
      }
      const choice = data.choices?.[0];
      const msg = choice?.message;
      llmDeadline.dispose();
      return {
        content: msg?.content || null,
        tool_calls: normalizeToolCalls(msg?.tool_calls || []),
        reasoning: ['reasoning_content', 'reasoning', 'thinking', 'thought']
          .map((k) => (typeof msg?.[k] === 'string' ? msg[k] : ''))
          .join('') || null,
        usage: data.usage ? {
          prompt_tokens: data.usage.prompt_tokens || 0,
          completion_tokens: data.usage.completion_tokens || 0,
        } : undefined,
      };
    }

    // Streaming path — parse SSE chunks and emit text.delta in real-time.
    // touch() on every chunk keeps the idle deadline honest; dispose() clears
    // the watchdog from parseStreamingResponse's finally.
    return this.parseStreamingResponse(response, sessionId, runId, llmDeadline.touch, llmDeadline.dispose, hooks);
  }private async parseStreamingResponse(
    response: Response,
    sessionId?: string,
    runId?: string,
    touch?: () => void,
    dispose?: () => void,
    hooks?: LlmStreamHooks,
  ): Promise<LLMResponse> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoning = '';
    const toolCalls: LLMToolCall[] = [];
    let usage: { prompt_tokens: number; completion_tokens: number } | undefined;
    let finishReason: string | null = null;
    const toolCallBuffers = new Map<number, { id: string; name: string; arguments: string; signature: string }>();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        touch?.(); // any progress on the wire = the model is alive

        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;

            let chunk: any;
            try { chunk = JSON.parse(data) as any; } catch { continue; }
            // Providers surface upstream failures (429 rate limit, quota, auth)
            // as a top-level `error` chunk in a 200 SSE stream. Fail loudly so
            // the agent loop shows the real reason instead of "empty response".
            if (chunk?.error) {
              const code = Number(chunk.error?.code ?? chunk.error?.status ?? 0);
              const text = typeof chunk.error === 'string' ? chunk.error : (chunk.error?.message || JSON.stringify(chunk.error).slice(0, 300));
              const err = new Error(`LLM API error (${code}): ${String(text).slice(0, 500)}`) as Error & { status?: number };
              if (code) err.status = code;
              throw err;
            }
            try {
              const choice = chunk.choices?.[0];
              if (!choice) continue;

              const delta = choice.delta;
              if (!delta) continue;
              if (choice.finish_reason) finishReason = choice.finish_reason;

              // Text content delta
              if (delta.content) {
                content += delta.content;
                if (sessionId && runId) {
                  this.deps.eventEmitter.emitTextDelta(sessionId, runId, 'streaming', delta.content);
                }
                void hooks?.onDelta?.(delta.content);
              }

              // Reasoning/thinking delta ("Thought phase") — fields vary by
              // provider and usually arrive BEFORE content (DeepSeek
              // reasoning_content, OpenAI reasoning, Anthropic thinking,
              // Gemini thoughts via extra_content). Stream it live + keep it
              // for the final assistant message.
              const thought = extractThoughtDelta(delta);
              if (thought) {
                reasoning += thought;
                if (sessionId && runId) {
                  this.deps.eventEmitter.emitTextThought(sessionId, runId, 'streaming', thought);
                }
                void hooks?.onThought?.(thought);
              }

              // Tool call deltas (incremental argument building)
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  if (!toolCallBuffers.has(idx)) {
                    toolCallBuffers.set(idx, { id: '', name: '', arguments: '', signature: '' });
                  }
                  const buf = toolCallBuffers.get(idx)!;
                  if (tc.id) buf.id = tc.id;
                  if (tc.function?.name) buf.name += tc.function.name;
                  if (tc.function?.arguments) buf.arguments += tc.function.arguments;
                  const sig = tc.extra_content?.google?.thought_signature;
                  if (typeof sig === 'string' && sig) buf.signature += sig;
                }
              }

              // Usage info (some providers send it in the last chunk)
              if (chunk.usage) {
                usage = {
                  prompt_tokens: chunk.usage.prompt_tokens || 0,
                  completion_tokens: chunk.usage.completion_tokens || 0,
                };
              }
            } catch { /* skip malformed chunk */ }
          }
        }
      }
    } finally {
      dispose?.();
      reader.releaseLock();
    }

    // Flush any trailing partial SSE block that was never terminated by "\n\n".
    // Without this, a stream ending with data followed by only "\n" (or with
    // no trailing blank line) would silently drop that final chunk — a source
    // of "empty response" / truncated tool arguments.
    if (buffer.trim()) {
      for (const line of buffer.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let chunk: any;
        try { chunk = JSON.parse(data) as any; } catch { continue; }
        if (chunk?.error) {
          const code = Number(chunk.error?.code ?? chunk.error?.status ?? 0);
          const text = typeof chunk.error === 'string' ? chunk.error : (chunk.error?.message || JSON.stringify(chunk.error).slice(0, 300));
          const err = new Error(`LLM API error (${code}): ${String(text).slice(0, 500)}`) as Error & { status?: number };
          if (code) err.status = code;
          throw err;
        }
        try {
          const delta = chunk.choices?.[0]?.delta;
          if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
          if (!delta) continue;
          if (delta.content) content += delta.content;
          const thought = extractThoughtDelta(delta);
          if (thought) reasoning += thought;
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallBuffers.has(idx)) toolCallBuffers.set(idx, { id: '', name: '', arguments: '', signature: '' });
              const b = toolCallBuffers.get(idx)!;
              if (tc.id) b.id = tc.id;
              if (tc.function?.name) b.name += tc.function.name;
              if (tc.function?.arguments) b.arguments += tc.function.arguments;
              const sig = tc.extra_content?.google?.thought_signature;
              if (typeof sig === 'string' && sig) b.signature += sig;
            }
          }
          if (chunk.usage) {
            usage = {
              prompt_tokens: chunk.usage.prompt_tokens || 0,
              completion_tokens: chunk.usage.completion_tokens || 0,
            };
          }
        } catch { /* skip malformed chunk */ }
      }
    }

    // Convert tool call buffers to final format
    for (const [, buf] of toolCallBuffers) {
      if (buf.name) {
        const call: LLMToolCall = {
          id: buf.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          type: 'function',
          function: {
            name: buf.name.trim(),
            arguments: buf.arguments || '{}',
          },
        };
        if (buf.signature) call.thought_signature = buf.signature;
        toolCalls.push(call);
      }
    }

    // Note: text.end is emitted by runAgentLoop after callLLM returns, not here

    return {
      content: content || null,
      tool_calls: toolCalls,
      usage,
      finish_reason: finishReason,
      reasoning: reasoning || null,
    };
  }
}