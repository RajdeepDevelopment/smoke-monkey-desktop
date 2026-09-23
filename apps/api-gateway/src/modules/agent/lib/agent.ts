/**
 * Smoke Monkey agent library — configurable agent facade.
 *
 * Construct an agent once with the pieces that define it — the system prompt
 * (or its parts), the sub-contexts/sub-system prompts to feed, the external
 * model to target, and the MCP servers to list on the context — then build the
 * final system prompt that is sent to the model on every run.
 *
 *   const agent = new SmAgent({
 *     agentId: 'build',
 *     subSystemPrompt: ['General', 'Frontend'],
 *     model: { provider: 'openai', model: 'gpt-4o' },
 *     mcp: { configured: true, servers: [...] },
 *   });
 *   const prompt = await agent.buildSystemPrompt();
 */
import {
  buildSystemPrompt,
  type BuildSystemPromptDeps,
  type BuildSystemPromptOptions,
} from './system-prompt';
import { MAX_ACTIVE_MCP } from '../context/sub-context';

export interface SmAgentModel {
  provider: string;
  model: string;
}

/** MCP servers listed on the agent's context (rendered into the system prompt). */
export type SmAgentMcpConfig = BuildSystemPromptOptions['mcp'];

/** Minimal chat message shape understood by external model providers. */
export interface SmAgentLLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface SmAgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface SmAgentLLMResponse {
  content: string | null;
  tool_calls: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
  finish_reason?: string | null;
}

export interface SmAgentModelCallOptions {
  provider?: string;
  model?: string;
  sessionId?: string;
  runId?: string;
  userId?: string;
}

export interface SmAgentRunOptions extends SmAgentModelCallOptions {
  /** Tools exposed to the model for this run. */
  tools?: SmAgentTool[];
}

/** Hooks: prompt-side hooks plus the external-model dispatcher. */
export interface SmAgentRunDeps extends BuildSystemPromptDeps {
  /**
   * Sends the (already-prompted) conversation to the external model provider.
   * The caller owns the implementation (retries, OAuth, streaming, key store);
   * the library only composes the prompt and orchestrates.
   */
  callModel?: (
    messages: SmAgentLLMMessage[],
    tools: SmAgentTool[],
    opts: SmAgentModelCallOptions,
  ) => Promise<SmAgentLLMResponse>;
}

export interface SmAgentConfig {
  /** Agent variant: 'build' | 'plan' | 'explore' | 'general'. */
  agentId?: string;
  /** Custom core system prompt. When set, it replaces the built-in core rules. */
  systemPrompt?: string;
  /** Sub-context(s) / sub-system prompt(s) fed alongside the core prompt. */
  subSystemPrompt?: string | string[];
  /** External model this agent targets (provider + model id). */
  model?: SmAgentModel;
  /** Hugging Face runtime status injected into the prompt. */
  huggingFace?: BuildSystemPromptOptions['huggingFace'];
  /** MCP servers to list on the context. */
  mcp?: SmAgentMcpConfig;
  /** Working directory shown in the env block. */
  workspacePath?: string;
  /** Project root (every tool call defaults to this). */
  projectDir?: string;
  /** Hooks: per-project instruction loader + warn callback + model dispatcher. */
  deps?: SmAgentRunDeps;
}

/**
 * A configured Smoke Monkey agent. `buildSystemPrompt()` returns the exact
 * prompt the external model receives; when no custom `systemPrompt` /
 * `subSystemPrompt` are given it is byte-for-byte identical to the legacy
 * inline composer in agent.service.ts.
 */
export class SmAgent {
  constructor(readonly config: SmAgentConfig) {}

  get agentId(): string {
    return this.config.agentId ?? 'general';
  }

  get model(): SmAgentModel | undefined {
    return this.config.model;
  }

  get mcp(): SmAgentMcpConfig | undefined {
    return this.config.mcp;
  }

  /** Compose the full system prompt fed to the external model. */
  async buildSystemPrompt(): Promise<string> {
    const { systemPrompt, subSystemPrompt } = this.config;
    if (systemPrompt != null || subSystemPrompt != null) {
      return this.buildCustomPrompt();
    }
    return buildSystemPrompt(this.agentId, this.config.workspacePath, this.config.projectDir, {
      huggingFace: this.config.huggingFace,
      mcp: this.config.mcp,
    }, this.config.deps);
  }

  /**
   * Config-driven composition: assemble the caller's pieces instead of the
   * built-ins. Only exercised when `systemPrompt`/`subSystemPrompt` are set —
   * the default path above is unchanged.
   */
  private async buildCustomPrompt(): Promise<string> {
    const { systemPrompt, subSystemPrompt, workspacePath, deps } = this.config;
    const sub = Array.isArray(subSystemPrompt)
      ? subSystemPrompt.join('\n\n')
      : subSystemPrompt;

    const parts: string[] = [];
    if (systemPrompt) parts.push(systemPrompt);
    if (sub) parts.push(`## Sub-context\n\n${sub}`);

    if (this.config.mcp?.configured && this.config.mcp.servers.length) {
      const servers = this.config.mcp.servers
        .map((s) => `- ${s.name}: ${s.description}`)
        .join('\n');
      parts.push(
        `## MCP Servers\n\nAvailable MCP servers on the context:\n${servers}\n\nMax ${MAX_ACTIVE_MCP} MCP servers active at once.`,
      );
    }

    if (workspacePath) {
      try {
        const configMsg = await deps?.loadProjectConfig?.(workspacePath);
        if (configMsg) parts.push(configMsg);
      } catch (err) {
        deps?.warn?.(`[AGENT_CONFIG] Failed to load .agent instructions for ${workspacePath}: ${err}`);
      }
    }

    return parts.filter((p): p is string => !!p).join('\n\n');
  }

  /**
   * Execute one turn against the configured external model: compose the system
   * prompt (core + sub-context feed + MCP listing), prepend it to the
   * conversation, and dispatch through `deps.callModel`.
   */
  async run(
    messages: SmAgentLLMMessage[],
    opts: SmAgentRunOptions = {},
  ): Promise<SmAgentLLMResponse> {
    const { provider, model, tools, sessionId, runId, userId } = opts;
    if (!this.config.deps?.callModel) {
      throw new Error(
        'SmAgent.run() requires deps.callModel — provide the external-model dispatcher (retries/OAuth/streaming are caller-owned).',
      );
    }

    const systemPrompt = await this.buildSystemPrompt();
    const fullMessages: SmAgentLLMMessage[] = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    return this.config.deps.callModel(fullMessages, tools ?? [], {
      provider: provider ?? this.config.model?.provider,
      model: model ?? this.config.model?.model,
      sessionId,
      runId,
      userId,
    });
  }

  /** Alias for `run()` when you prefer a send/channel-style name. */
  send(messages: SmAgentLLMMessage[], opts?: SmAgentRunOptions): Promise<SmAgentLLMResponse> {
    return this.run(messages, opts);
  }
}