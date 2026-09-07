import { Injectable, Logger, ConflictException, Inject } from '@nestjs/common';
import * as fsp from 'fs/promises';
import { AgentMessageService } from './agent-message.service';
import { AgentRunService } from './agent-run.service';
import { AgentSessionService } from './agent-session.service';
import { AgentPermissionService } from './agent-permission.service';
import { AgentEventEmitter } from './agent-event.emitter';
import { ToolRegistry, ToolResult } from '../tools/tool-registry';
import { ContextCompactionService } from './compaction.service';
import { enrichToolResult, ensureRunDirs } from './artifact-store';
import { WorkspaceIndex } from './workspace-index';
import { AgentConfigService } from './agent-config.service';
import { ApiKeysService } from '../../keys/api-keys.service';
import { SecretsService } from '../../secrets/secrets.service';
import { McpService, McpRuntime } from '../../mcp/mcp.service';
import { ExplorerService } from './subagent.service';
import {
  AgentPhase,
  CHARS_PER_TOKEN,
  COMPACTION_INTERVAL,
  COMPACTION_THRESHOLD,
  KEEP_RECENT_MESSAGES,
  LLMMessage,
  PHASE_TOOLS,
  READ_ONLY_TOOLS,
  RUN_HISTORY_LIMIT,
  RunContext,
  SEARCH_FAMILY_TOOLS,
  TOOL_GROUPS,
  ContextSnapshot,
  buildAgentState,
  classifyTaskGroups,
  createEmptySnapshot,
  estimateTokens,
  initialPhase,
  nextPhaseOnCall,
  nextPhaseOnResult,
  phaseDirective,
  resolveExposedTools,
  resolveProjectDir,
  resolveTokenBudget,
  safeParseObject,
  snapshotToSystemMessage,
  toProviderMessages,
} from './run-context';
import { AgentMessage, ToolCallJson } from '../entities/agent-message.entity';
import { AgentState } from '../entities/agent-run.entity';
import { PermissionEffect } from '../entities/agent-permission.entity';
import {
  SubContextManager,
  renderContextPanel,
  renderSystemPromptCatalog,
  recommendSubContextsForTask,
  getSubContext,
  MAX_ACTIVE_CONTEXTS,
  MAX_ACTIVE_MCP,
} from '../context/sub-context';

export interface AgentRunRequest {
  sessionId: string;
  userId: string;
  message: string;
  workspacePath: string;
  agentId: string;
  model?: string;
  provider?: string;
  /** When set, the agent works on a remote host via this SSH profile. */
  remoteProfileId?: string;
}

interface LLMToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  /** Gemini 3.x thinking models require echoing this back on the assistant message. */
  thought_signature?: string;
}

interface LLMResponse {
  content: string | null;
  tool_calls: LLMToolCall[];
  usage?: { prompt_tokens: number; completion_tokens: number };
  finish_reason?: string | null;
  /** Model reasoning/thinking stream ("Thought phase"), e.g. DeepSeek
   *  `reasoning_content`, OpenAI `reasoning`, Anthropic-style `thinking`. */
  reasoning?: string | null;
}

const MAX_STEPS = 1000;
const MAX_SAME_ERROR = 3;

/** Default hard cap on any single tool execution if the tool itself does not
 *  declare its own timeout. Prevents a tool/command from spinning forever
 *  without a completion — the terminal tools surface the timeout as data. */
const DEFAULT_TOOL_TIMEOUT_MS = 180_000;
/** File-mutation tools stream large payloads (multi-MB writes, whole-file
 * edits, big patches) and legitimately need longer than the generic cap —
 * a 7-minute ceiling so a 2MB docs write is never killed mid-stream. */
const LONG_TOOL_TIMEOUT_MS = 7 * 60_000;
const LONG_TOOL_NAMES = new Set(['write_file', 'edit_file', 'apply_patch', 'replace_lines', 'line_edit']);

/** Consecutive text-only responses tolerated before ending the run gracefully. */
const MAX_NO_TOOL_STREAK = 5;

/**
 * Completion from prose requires REAL evidence, never "a grep succeeded and
 * then the model wrote a sentence". A successful run in the recent tool
 * history counts only if it looks like verification (tests/typecheck/lint/
 * build/diff --check/health probe) — exploration commands do NOT. The
 * dedicated test/check tool is always verification.
 */
const VERIFICATION_TOOLS = new Set(['run_test']);

/** Matches a run_command ARGS JSON string whose command is a verification step.
 *  Covers test/typecheck/lint/build/diff --check AND real-world success probes
 *  the agent actually uses to confirm a server/API works: curl against
 *  localhost health/api-docs/swagger endpoints, listening-port checks
 *  (lsof -iTCP / ss / netstat / nc -z) and wait-for-it. */
const VERIFICATION_COMMAND_RE =
  /\b(tsc|typecheck|lint)\b|--noEmit|\b(?:jest|vitest|pytest|mocha|rspec)\b|(?:^|[;&|(){}\[\]:,"\s]+)(?:pnpm|npm|yarn|bun|npx)\s+(?:exec\s+|run\s+)?(?:test|tests|lint|typecheck|build|check)(?:["'`,;{}|)\s]|$)|(?:^|[;&|(){}\[\]:,"\s]+)cargo\s+(?:test|check|build)(?:["'`,;{}|)\s]|$)|(?:^|[;&|(){}\[\]:,"\s]+)(?:go|python|python3)\s+(?:test\b|.*-m\s+test\b)|git\s+diff\s+--check|curl.{0,160}(?:health|ready|api-docs|swagger|\/api[^a-z]|localhost:\d+|127\.0\.0\.1:\d+)|lsof.{0,160}-iTCP|(?:^|[;&|{}\[\]:,"\s]+)(?:ss|netstat)\b|wait-for-it\b[^\n]{0,80}|nc\s+-z[^\n]{0,80}\d{3,5}/i;

/**
 * Prose that reads like an explicit final report rather than mid-task narration.
 * Report-style bullet labels from the agent's own "Final response" section.
 */
const FINAL_REPORT_RE =
  /(^|\n)[ \t]*(?:[-*•][ \t]*)?[*_]*(Changed|Verified|Result|Summary|Done|Status)[*_]*[ \t]*:|TASK (COMPLETE|COMPLETED)|completed successfully|verification (passed|green)|all checks (passed|green)/im;

/**
 * Prose that hands control back to the user instead of finishing the work
 * ("which do you prefer?", "let me know how to proceed", trailing "?"). Such a
 * turn is NOT a completion — smoke monkey must pick the reasonable default and
 * keep going; asking the user is reserved for ask_user and true blockers.
 */
/**
 * How many consecutive empty responses we tolerate BEFORE killing a run.
 * When the run has already produced tool work, tolerate far more — a provider
 * hiccup shouldn't throw away a productive build.
 */
const MAX_EMPTY_RETRIES_WITH_PROGRESS = 5;

/**
 * When this many consecutive tool calls belong to SEARCH_FAMILY_TOOLS,
 * the model is stuck "looking for something" and must be nudged to act.
 * Catches varied args / alternating search tools that the exact-match
 * doom loop guard misses.
 */
const SEARCH_FAMILY_LOOP_THRESHOLD = 1000;

/** Transient LLM/provider failures worth an automatic retry. */
const MAX_LLM_RETRIES = 3;
const RETRYABLE_LLM_ERROR =
  /timeout|etimedout|econnreset|econnrefused|socket hang up|rate.?limit|too many requests|bad gateway|service unavailable|internal server error|overloaded|server error|\b5\d\d\b/i;

/** Same tool + same args N times consecutively → doom loop. */
const DOOM_LOOP_THRESHOLD = 1000;

/**
 * Consecutive verification commands (builds/tests/typecheck) that FAILED without
 * any successful file mutation in between. At this count the agent is stuck on a
 * failure it cannot fix (e.g. a broken frontend build it keeps re-running) — stop
 * looping and finalize the run as failed rather than hammering it to MAX_STEPS.
 */
const MAX_CONSECUTIVE_FAILED_VERIFICATIONS = 5;

/**
 * When a tool or command returns the byte-identical output this many times in a
 * row, the model is making no forward progress. Stop rather than spin forever.
 */
const SAME_OUTPUT_THRESHOLD = 101;

/** Per-file mutation cap for the whole run. */
const FILE_MUTATION_LIMIT = 200;

/** Providers that stream deltas through parseStreamingResponse (text already emitted live). */
const STREAMING_PROVIDERS = new Set(['openai', 'openrouter', 'nvidia', 'xai', 'gemini', 'opencode', 'omniroute']);

/** Per-turn guard bookkeeping shared by the tool executors. */
interface RunGuards {
  errorHistory: string[];
  toolCallCounts: Map<string, number>;
  recentToolCalls: Array<{ name: string; args: string }>;
  recentToolResults: Array<{ name: string; success: boolean; output: string }>;
  postMutationReads: Map<string, number>;
  fileMutationCounts: Map<string, number>;
  noToolStreak: number;
  /** Consecutive call to search/list tools — resets on any non-search call. */
  searchFamilyStreak: number;
  /** Consecutive empty LLM responses (no content, no tool calls). */
  emptyStreak: number;
  /** Tracks byte-identical tool outputs to detect a no-progress spin. */
  sameOutputStreak: number;
  lastOutputSignature: string;
  /** Consecutive text-only turns that read like a FINAL report. Two in a row
   *  with no tool work between → the run is done; stop the re-summarize loop. */
  consecutiveFinalReports: number;
  /** Consecutive verification commands (run_test/run_command) that FAILED with
   *  no successful file mutation in between. When this climbs past a cap, the
   *  agent is stuck on an unfixable failure — finalize instead of looping. */
  consecutiveFailedVerifications: number;
}

/** Turn a user's opening prompt into a short, readable session title.
 *  Strips code blocks / paths / markdown noise and caps at ~56 chars. */
function deriveSessionTitle(message: string): string {
  const dirty = message
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\[[^\]]*\](\([^)]*\))?/g, ' ')
    .replace(/[#*_>|~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const clean = dirty.replace(/^[\s,.;:/\\\-·]+/, '').trim();
  if (!clean) return '';
  // Take the first sentence-ish chunk (~56 chars), folded at a word boundary.
  let title = clean.slice(0, 56).replace(/\s+\S*$/, '');
  if (!title) title = clean.slice(0, 56);
  title = title.replace(/[.,;:!?]+$/, '').trim();
  if (!title) return '';
  if (!/[a-zA-Z0-9]/.test(title.charAt(0))) title = title.slice(1).trim();
  if (!title) return '';
  return title.charAt(0).toUpperCase() + title.slice(1);
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly sessionService: AgentSessionService,
    private readonly runService: AgentRunService,
    private readonly messageService: AgentMessageService,
    private readonly permissionService: AgentPermissionService,
    private readonly eventEmitter: AgentEventEmitter,
    private readonly compactionService: ContextCompactionService,
    private readonly explorerService: ExplorerService,
    private readonly agentConfigService: AgentConfigService,
    @Inject(ToolRegistry) private readonly toolRegistry: ToolRegistry,
    private readonly workspaceIndex: WorkspaceIndex,
    private readonly apiKeyService: ApiKeysService,
    private readonly secretsService: SecretsService,
    private readonly mcpService: McpService,
  ) {}

  private readonly pendingAskUser = new Map<string, { resolve: (response: string) => void }>();

  /** Live run cancellation: interrupt() aborts the controller of the active run. */
  private readonly activeRuns = new Map<string, AbortController>();

  /**
   * Guards against concurrent runs on the same session. Each entry maps
   * sessionId → runId. A second `run()` call for the same session is
   * rejected with ConflictException before any DB write or LLM call.
   */
  private readonly activeSessionRuns = new Map<string, string>();

  resolveAskUser(toolCallId: string, response: string): void {
    const pending = this.pendingAskUser.get(toolCallId);
    if (pending) {
      pending.resolve(response);
      this.pendingAskUser.delete(toolCallId);
    }
  }

  /**
   * Returns the current AgentState for an active or completed run.
   * Used by the WebSocket `get_state` message so the client can
   * hydrate its UI without replaying the full event stream.
   */
  getState(sessionId: string): Record<string, unknown> | null {
    // Check if there's an active run with an in-memory context.
    // For completed runs, the state is in the DB checkpoint column.
    const runId = this.activeSessionRuns.get(sessionId);
    if (!runId) return null;
    // The active run context is not directly accessible here; return
    // a signal that the session has an active run.
    return { active: true, runId, sessionId };
  }

  async run(request: AgentRunRequest): Promise<{ status: string; sessionId: string }> {
    const { sessionId, userId, message, workspacePath, agentId, model, provider, remoteProfileId } = request;

    // Prevent concurrent runs on the same session — two agentic loops fighting
    // over the same workspace leads to data corruption and wasted tokens.
    if (this.activeSessionRuns.has(sessionId)) {
      const activeRunId = this.activeSessionRuns.get(sessionId);
      throw new ConflictException(
        `Agent is already running for this session (run ${activeRunId}). Interrupt it first.`,
      );
    }

    await this.sessionService.updateStatus(sessionId, 'running');

    const run = await this.runService.create(sessionId, agentId || 'build', MAX_STEPS);
    // Persist 'thinking' immediately — otherwise the runs list stays 'queued'
    // for the entire run while the agent is actively thinking/executing.
    await this.runService.updateStatus(run.id, 'thinking');
    this.activeSessionRuns.set(sessionId, run.id);

    this.eventEmitter.emitRunStarted(sessionId, run.id, agentId || 'build');

    await this.messageService.create(sessionId, 'user', message);

    // Unnamed sessions get a title derived from the opening prompt — the
    // running agent names the chat so the sidebar stops showing "New session".
    void this.maybeAutoTitle(sessionId, message);

    this.executeAgentRun(sessionId, run.id, userId, message, workspacePath, agentId || 'build', model, provider, remoteProfileId).catch((err) => {
      this.logger.error(`Agent run failed: ${err.message}`);
      this.eventEmitter.emitRunFailed(sessionId, run.id, err.message);
      this.activeRuns.delete(sessionId);
      this.activeSessionRuns.delete(sessionId);
    });

    return { status: 'started', sessionId };
  }

  /** Name the session from its first real user prompt (if still unnamed),
   *  so chat history shows what the conversation is about. */
  private async maybeAutoTitle(sessionId: string, message: string): Promise<void> {
    try {
      if (!message || !message.trim()) return;
      const session = await this.sessionService.findOne(sessionId);
      if (!session) return;
      const current = (session.title || '').trim();
      if (current && current !== 'New session') return;
      const title = deriveSessionTitle(message);
      if (!title) return;
      await this.sessionService.updateTitle(sessionId, title);
      this.logger.log(`Auto-titled session ${sessionId} → "${title}"`);
    } catch (err) {
      this.logger.debug(`Auto-title skipped for ${sessionId}: ${(err as Error).message}`);
    }
  }

  async interrupt(sessionId: string): Promise<{ status: string }> {
    // Real cancellation: abort the active run's controller so the runner stops
    // between steps, skips pending tool executions and unblocks ask_user waits.
    const controller = this.activeRuns.get(sessionId);
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }
    this.activeSessionRuns.delete(sessionId);
    await this.sessionService.updateStatus(sessionId, 'interrupted');
    this.eventEmitter.emitRunInterrupted(sessionId, '', 'user_interrupt');
    return { status: 'interrupted' };
  }

  async resume(sessionId: string, workspacePath: string, userId: string): Promise<{ status: string; sessionId: string }> {
    const session = await this.sessionService.findOne(sessionId);
    if (!session) throw new Error('Session not found');

    const lastUserMsg = await this.messageService.getRecentContext(sessionId, 1);
    const userMessage = lastUserMsg.find((m) => m.role === 'user')?.content || 'Continue';

    return this.run({
      sessionId,
      userId,
      message: userMessage,
      workspacePath: workspacePath || session.workspacePath || '',
      agentId: session.agentId,
    });
  }

  private async executeAgentRun(
    sessionId: string,
    runId: string,
    userId: string,
    message: string,
    workspacePath: string,
    agentId: string,
    model?: string,
    provider?: string,
    remoteProfileId?: string,
  ): Promise<void> {
    const abortController = new AbortController();
    this.activeRuns.set(sessionId, abortController);

    // ── State-driven core ─────────────────────────────────────────────────
    // Build the conversation ONCE per run (a single DB read), then mutate the
    // RunContext in memory. No more per-step "DB → rebuild context → LLM".
    const ctx = await this.createRunContext({
      sessionId,
      runId,
      userId,
      workspacePath,
      agentId,
      model,
      provider,
      remoteProfileId,
      task: message,
      abortController,
    });

    // Create the structured artifact directory tree for this run.
    ensureRunDirs(workspacePath, runId).catch((err) =>
      this.logger.warn(`Failed to create run directories: ${err}`),
    );

    // Build/refresh the workspace index for fast symbol lookup.
    // AWAITED (not fire-and-forget): find_symbol/search_code rely on the index
    // being ready. SQLite caches incrementally, so this is fast on re-runs.
    try {
      await this.workspaceIndex.build(workspacePath);
    } catch (err) {
      this.logger.warn(`WorkspaceIndex build failed: ${err}`);
    }

    // Emit initial agent state for the UI timeline.
    this.eventEmitter.emitAgentState(sessionId, runId, 'understanding', 'active', phaseDirective('understand') ?? undefined);

    // Emit the auto-opened sub-contexts so the UI immediately shows which
    // domain guidance panels are open for this session (arrives AFTER the
    // run.started reset, so it is never cleared). The agent then adjusts the
    // set live via context_manage → context.updated events.
    if (ctx.contextManager.activeCount > 0) {
      const initial = ctx.contextManager.activeIds.map((id) => {
        const c = getSubContext(id);
        return { id, title: c?.title ?? id };
      });
      this.eventEmitter.emitContextUpdated(sessionId, runId, initial, ctx.contextManager.activeCount, ctx.contextManager.maxActive);
    }

    const guards: RunGuards = {
      errorHistory: [],
      toolCallCounts: new Map(),
      recentToolCalls: [],
      recentToolResults: [],
      postMutationReads: new Map(),
      fileMutationCounts: new Map(),
      noToolStreak: 0,
      searchFamilyStreak: 0,
      emptyStreak: 0,
      sameOutputStreak: 0,
      lastOutputSignature: '',
      consecutiveFinalReports: 0,
      consecutiveFailedVerifications: 0,
    };

    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        if (abortController.signal.aborted) {
          await this.finalizeInterrupted(sessionId, runId);
          return;
        }

        ctx.currentStep = step;
        await this.runService.incrementStep(runId);
        this.eventEmitter.emitStepStarted(sessionId, runId, step + 1);

        await this.maybeCompact(ctx);

        // Step-budget countdown nudges are intentionally EPHEMERAL: they apply
        // to this LLM call only and must not leak into future context. They are
        // folded into the single authoritative system message by
        // buildLLMMessages — never appended as standalone system messages.
        const extra: LLMMessage[] = [];
        const stepsLeft = MAX_STEPS - step - 1;
        if (stepsLeft === 3 || stepsLeft === 1) {
          extra.push({
            role: 'system',
            content: `STEP BUDGET: only ${stepsLeft} step(s) remain in this run. Do not start new work or modify files again. Output your final summary NOW.`,
          });
        }

        // Tool groups: task classification ∪ current phase — exposure only grows,
        // so a model that needs an "out of phase" tool is never dead-ended.
        for (const toolName of PHASE_TOOLS[ctx.phase]) ctx.exposedTools.add(toolName);
        const registryTools = this.toolRegistry.getDefinitions(ctx.exposedTools);

        // MCP tool defs: only tools from servers whose mcp_<id> context is active.
        // Lazy-connect on first use so activation is fast.
        const mcpTools: Array<{ name: string; description: string; parameters: Record<string, unknown> }> = [];
        if (ctx.mcpRuntime) {
          for (const cfg of ctx.mcpRuntime.configs) {
            const mcpId = `mcp_${cfg.id}`;
            if (!ctx.contextManager.isActive(mcpId)) continue;
            try {
              let handle = ctx.mcpRuntime.handles.get(cfg.id);
              if (!handle) {
              handle = await ctx.mcpRuntime.activateServer(cfg.id);
            }
            for (const t of handle.tools) {
              mcpTools.push({
                name: `${cfg.name}__${t.name}`,
                description: `[MCP:${cfg.name}] ${t.description}`,
                parameters: t.inputSchema,
              });
            }
          } catch (err) {
            this.logger.warn(`[MCP] failed to activate ${cfg.name}: ${err}`);
            }
          }
        }
        const tools = [...registryTools, ...mcpTools];

        let response: LLMResponse;
        try {
          this.eventEmitter.emitLlmThinking(sessionId, runId, step + 1);
          this.eventEmitter.emitAgentState(sessionId, runId, ctx.phase, 'active', 'Thinking…');
          await this.runService.updateStatus(runId, 'thinking');
          response = await this.callLLMWithRetry(this.buildLLMMessages(ctx, extra), tools, provider, model, sessionId, runId, ctx.userId);
          this.logger.debug(`LLM response: content=${(response.content || '').slice(0, 100)} tool_calls=${response.tool_calls?.length || 0} finish=${response.finish_reason ?? '?'} usage=${JSON.stringify(response.usage)}`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          guards.errorHistory.push(errMsg);

          if (guards.errorHistory.filter((e) => e === errMsg).length >= MAX_SAME_ERROR) {
            this.logger.warn(`LLM call failed (step ${step + 1}): ${errMsg}`);
            await this.appendSystemNote(ctx, `Repeated error detected: ${errMsg}. Stopping to prevent infinite loop.`);
            await this.runService.updateStatus(runId, 'failed');
            this.eventEmitter.emitRunFailed(sessionId, runId, 'repeated_error');
            return;
          }

          this.logger.warn(`LLM call failed (step ${step + 1}): ${errMsg}`);
          continue;
        }

        if (response.usage) {
          ctx.inputTokens += response.usage.prompt_tokens;
          ctx.outputTokens += response.usage.completion_tokens;
          await this.runService.updateTokens(runId, response.usage.prompt_tokens, response.usage.completion_tokens);
          await this.sessionService.updateTokens(sessionId, response.usage.prompt_tokens, response.usage.completion_tokens, 0);
        }

        // Parse inline text-format tool calls once (Qwen/GLM/DeepSeek house styles).
        // When the message body is empty, also scan the reasoning/thinking text:
        // local models routinely emit the tool call ONLY inside their reasoning
        // block (empty content + empty tool_calls otherwise). Recovering it here
        // turns a would-be "empty response" retry-loop into a real executed step.
        let inlineParsed = response.tool_calls?.length
          ? { calls: [] as Array<{ id: string; function: { name: string; arguments: string } }>, cleaned: response.content || '' }
          : this.extractInlineToolCalls(response.content);
        if (inlineParsed.calls.length === 0 && !response.tool_calls?.length && response.reasoning) {
          const fromReasoning = this.extractInlineToolCalls(response.reasoning);
          if (fromReasoning.calls.length > 0) {
            inlineParsed = { ...fromReasoning, cleaned: response.content || '' };
            this.logger.log(`Recovered ${fromReasoning.calls.length} tool call(s) from reasoning text (step ${step + 1})`);
          }
        }

        // Degeneration guard: the model is stuck re-printing the same block.
        if (!inlineParsed.calls.length && this.isDegenerateRepeat(response.content)) {
          this.logger.warn(`Repetition loop detected at step ${step + 1} — finalizing run`);
          await this.appendSystemNote(ctx,
            'Generation loop detected — the model started repeating itself. Ending the run here to avoid wasting tokens. All progress made so far is preserved above.');
          await this.finalizeRunSuccess(ctx, sessionId, runId);
          return;
        }

        // Structured calls survive validation; otherwise fall back to inline parsing.
        let calls: Array<{ id: string; function: { name: string; arguments: string } }>;
        let sourceIsStructured = false;
        if (response.tool_calls?.length) {
          sourceIsStructured = true;
          calls = response.tool_calls.filter((tc) => {
            const name = tc.function?.name;
            const args = tc.function?.arguments;
            if (!name || typeof name !== 'string' || name.trim() === '') {
              this.logger.warn('Rejecting malformed tool call: empty or missing name');
              return false;
            }
            if (args !== undefined && args !== null && typeof args === 'string' && args.trim() !== '') {
              try { JSON.parse(args); } catch {
                this.logger.warn(`Rejecting tool call "${name}": invalid JSON arguments`);
                return false;
              }
            }
            return true;
          });

          if (calls.length === 0) {
            this.logger.warn(`All ${response.tool_calls.length} tool calls were malformed. Asking the model to retry.`);
            await this.appendAssistantMessage(ctx, `I need to use tools properly. Let me try again with correct tool calls.`);
            continue;
          }
        } else {
          calls = inlineParsed.calls;
        }

        // ── Tool execution turn ───────────────────────────────────────────
        if (calls.length > 0) {
          guards.noToolStreak = 0;
          guards.consecutiveFinalReports = 0;
          guards.emptyStreak = 0;

          // Emit executing state with tool names for the UI.
          const toolNames = calls.map((c) => c.function.name).join(', ');
          this.eventEmitter.emitAgentState(sessionId, runId, ctx.phase, 'active', `Running ${toolNames}`);

          // ONE assistant message carrying content + all tool calls.
          const assistantMsg = await this.appendAssistantMessage(ctx, response.content || '', calls.map((tc) => ({
            id: tc.id,
            toolName: tc.function.name,
            arguments: safeParseObject(tc.function.arguments),
            status: 'queued' as ToolCallJson['status'],
            ...((tc as LLMToolCall).thought_signature ? { thought_signature: (tc as LLMToolCall).thought_signature } : {}),
          })), undefined, response.reasoning);

          if (sourceIsStructured) {
            if (response.content && !STREAMING_PROVIDERS.has(provider || '')) {
              this.eventEmitter.emitTextDelta(sessionId, runId, assistantMsg.id, response.content);
            }
            this.eventEmitter.emitTextEnd(sessionId, runId, assistantMsg.id, response.content || '', assistantMsg.toolCalls || undefined, response.reasoning);
          }

          await this.executeToolCalls(ctx, assistantMsg, calls, guards, { agentId, userId });

          // finish_task — the model's explicit structural completion signal.
          // Finalize immediately and break the loop regardless of prose style.
          if (ctx.finishSignal) {
            this.logger.log(`finish_task called — finalizing run ${runId} (${ctx.finishSignal.summary.slice(0, 80)})`);
            await this.finalizeRunSuccess(ctx, sessionId, runId);
            this.eventEmitter.emitStepEnded(sessionId, runId, step + 1);
            return;
          }

          // Runaway build/verification loop: the agent kept re-running a failing
          // check with no successful fix. Finalize as failed instead of looping.
          if (ctx.hardStopReason) {
            this.logger.warn(`Hard-stopping run ${runId}: ${ctx.hardStopReason}`);
            await this.appendSystemNote(ctx, ctx.hardStopReason);
            this.setPhase(ctx, 'complete');
            await this.runService.updateStatus(runId, 'failed');
            await this.sessionService.updateStatus(sessionId, 'failed');
            this.eventEmitter.emitRunFailed(sessionId, runId, ctx.hardStopReason);
            this.eventEmitter.emitStepEnded(sessionId, runId, step + 1);
            return;
          }

          const agentState = buildAgentState(ctx);
          await this.runService.saveAgentState(runId, agentState, ctx.workspacePath);
          this.eventEmitter.emitStepEnded(sessionId, runId, step + 1);
          continue;
        }

        // Empty degenerate response: no content AND no tool calls. This is a
        // transient provider/API hiccup (e.g. 0-token silent return), NOT a
        // legitimate completion. Retry rather than finalizing an empty run.
        // Importantly: a run that has already produced tool work must NEVER be
        // killed just because the provider hiccupped a few turns — keep retrying.
        if (!response.content && (!response.tool_calls || response.tool_calls.length === 0)) {
          guards.emptyStreak++;
          const hasToolProgress = guards.recentToolResults.length > 0;
          const emptyBudget = hasToolProgress ? MAX_EMPTY_RETRIES_WITH_PROGRESS : MAX_SAME_ERROR;
          if (guards.emptyStreak >= emptyBudget) {
            this.logger.warn(
              `Empty LLM response repeated ${guards.emptyStreak} times at step ${step + 1} — finalizing run` +
              (hasToolProgress ? ' (after tool progress)' : ''),
            );
            await this.appendSystemNote(ctx,
              'The model returned an empty response repeatedly. Stopping the run to avoid wasting tokens.');
            await this.finalizeRunSuccess(ctx, sessionId, runId);
            return;
          }
          this.logger.warn(`Empty LLM response at step ${step + 1} (no content, no tool calls) — retrying`);
          // Cooldown before retry: NVIDIA Nemotron intermittently returns empty
          // completions on `tool`-role turns. Pause briefly (with backoff) so the
          // provider recovers instead of us hammering it in a tight loop.
          const emptyDelay = Math.min(6_000, 800 * 2 ** (guards.emptyStreak - 1));
          await new Promise((r) => setTimeout(r, emptyDelay));
          // Nudge the model EXACTLY ONCE per empty streak. Re-appending a fresh
          // "Respond now" system note on every retry bloats the context and makes
          // small/local models loop on the same failure; a single standing nudge
          // plus the backoff cooldown above is what actually gets the provider to
          // recover.
          if (guards.emptyStreak === 1) {
            await this.appendSystemNote(ctx,
              'The model returned an empty response. Respond now. If you have completed the task, give your final summary. ' +
              'Otherwise call a tool (read_file, edit_file, write_file, run_command) to keep making progress.');
          }
          continue;
        }
        guards.emptyStreak = 0;

        // ── Text-only turn ────────────────────────────────────────────────
        this.eventEmitter.emitStepEnded(sessionId, runId, step + 1);

        if (response.content) {
          const assistantMsg = await this.appendAssistantMessage(ctx, response.content, undefined, response.usage, response.reasoning);
          if (!STREAMING_PROVIDERS.has(provider || '')) {
            this.eventEmitter.emitTextDelta(sessionId, runId, assistantMsg.id, response.content);
          }
          this.eventEmitter.emitTextEnd(sessionId, runId, assistantMsg.id, response.content, undefined, response.reasoning);
        }

        // Completion is inferred from REAL evidence, never from "exploration +
        // prose". An agent that greps the codebase and then writes a sentence is
        // making progress — it is NOT done. A text-only turn only finalizes when
        // ALL of these hold:
        //   · a VERIFICATION command (test/typecheck/lint/build/diff --check/
        //     health probe) SUCCEEDED in the recent tool history — grep/find do
        //     NOT count,
        //   · the prose reads like an explicit final report (Changed:/Verified:/
        //     Result:/Done:),
        //   · the prose is NOT deferring back to the user.
        const content = (response.content || '').trim();
        const hasText = content.length > 20;
        const finalReport = FINAL_REPORT_RE.test(content);
        const verificationPassed = guards.recentToolResults.some(
          (r) => r.success && VERIFICATION_TOOLS.has(r.name),
        ) || guards.recentToolCalls.some(
          (tc) => tc.name === 'run_command' && VERIFICATION_COMMAND_RE.test(tc.args || ''),
        );
        if (step > 2 && verificationPassed && finalReport) {
          this.logger.log(`Task completion detected at step ${step + 1} (verification + final report)`);
          await this.finalizeRunSuccess(ctx, sessionId, runId);
          return;
        }

        // Escape hatch for the re-summarize loop: a run that already produced
        // tool work must not re-print the same final report forever just
        // because its verification probe did not match the regex above. If the
        // model delivers the SAME style of final report twice in a row with no
        // tool call in between, the task is done — finalize instead of nudging.
        if (!ctx.readOnlyQuery && finalReport) {
          guards.consecutiveFinalReports++;
          if (step > 2 && guards.consecutiveFinalReports >= 2 && guards.recentToolResults.length > 0) {
            this.logger.log(
              `Final report repeated ${guards.consecutiveFinalReports}x with no tool work at step ${step + 1} — finalizing`,
            );
            await this.finalizeRunSuccess(ctx, sessionId, runId);
            return;
          }
        } else {
          guards.consecutiveFinalReports = 0;
        }

        // The model decides when the task is done: any substantial text-only
        // final report ends the run and saves the chat — never re-feed the
        // agent's own summary back into the loop.
        if (finalReport && hasText) {
          this.logger.log(`Agent finished with final report at step ${step + 1} — finalizing`);
          await this.finalizeRunSuccess(ctx, sessionId, runId);
          return;
        }

        // Read-only queries: the task is a question/analysis; a substantial
        // answer is the deliverable. We decide DYNAMICALLY based on whether the
        // agent did any tool work, not on brittle heuristics like "does the
        // reply end with a question mark".
        if (ctx.readOnlyQuery) {
          guards.noToolStreak++;
          const noToolWork = guards.recentToolResults.length === 0;

          // PURE GENERAL CHAT — the agent used ZERO tools across the whole run.
          // This is a greeting / casual conversation / non-code question, so
          // there is no task in progress to "defer". Any text reply (no minimum
          // length — even a short "Hello!" or "Sure.") IS the deliverable.
          // Finalize on the FIRST reply regardless of length or trailing
          // punctuation — greetings naturally end with "?" ("How can I help you
          // today?"), and flagging that as a deferral is what made greetings
          // loop instead of ending.
          if (noToolWork) {
            if (content) {
              this.logger.log(`General chat answered at step ${step + 1} — finalizing`);
              await this.finalizeRunSuccess(ctx, sessionId, runId);
              return;
            }
            // Empty reply: keep looping a couple turns before giving up.
            if (guards.noToolStreak >= MAX_NO_TOOL_STREAK) {
              this.logger.log(`General chat produced no text (${guards.noToolStreak} turns) — finalizing`);
              await this.finalizeRunSuccess(ctx, sessionId, runId);
              return;
            }
            continue;
          }

          // READ-ONLY BUT EXPLORED — the agent read/searched the codebase to
          // answer a real question. A substantial answer that resolves the
          // question is the deliverable; let the agent end when it has answered.
          if (hasText && (content.length >= 60 || guards.noToolStreak >= 2)) {
            this.logger.log(`Read-only query answered at step ${step + 1} — finalizing`);
            await this.finalizeRunSuccess(ctx, sessionId, runId);
            return;
          }
          if (guards.noToolStreak >= MAX_NO_TOOL_STREAK) {
            this.logger.log(`Read-only query produced its answer (${guards.noToolStreak} text turns) — finalizing`);
            await this.finalizeRunSuccess(ctx, sessionId, runId);
            return;
          }
          continue;
        }

        guards.noToolStreak++;
        // Any other text-only turn is progress narration between tool calls.
        // A building agent often narrates as it works, so only end gracefully
        // when the model repeatedly refuses to use tools.
        // if (step > 2 && step < MAX_STEPS - 1) {
        //   if (guards.noToolStreak >= MAX_NO_TOOL_STREAK) {
        //     this.logger.warn(`No-tool streak hit ${guards.noToolStreak} at step ${step + 1} — finalizing run`);
        //     await this.finalizeRunSuccess(ctx, sessionId, runId);
        //     return;
        //   }
        //   await this.appendSystemNote(ctx,
        //     'You must use tools to complete the task. Do not just describe what you would do — actually do it. Use read_file, edit_file, write_file, run_command, apply_patch, or other tools to make real changes. Continue with the next tool call now.');
        //   continue;
        // }

        await this.finalizeRunSuccess(ctx, sessionId, runId);
        return;
      }

      await this.finalizeRunSuccess(ctx, sessionId, runId);
    } catch (err) {
      // ABUSE-PROOF finalization: an unhandled throw mid-run (LLM hiccup, tool
      // crash, DB write failure, shutdown during a long loop) must NEVER orphan
      // the session in a perpetual 'running' state or leave the transcript
      // dangling — that's what made chats vanish from the UI and the sidebar
      // show a "stuck" session after a refresh. Always land the run in a
      // terminal state and persist an honest final message, then rethrow so
      // the caller can still log the failure.
      await this.finalizeRunFailed(ctx, sessionId, runId, err);
      throw err;
    } finally {
      // Close all MCP server connections for this run
      if (ctx?.mcpRuntime) {
        try { ctx.mcpRuntime.closeAll(); } catch {}
      }
      this.activeRuns.delete(sessionId);
      this.activeSessionRuns.delete(sessionId);
    }
  }

  /**
   * Terminal failure finalization: persists an explicit end-of-chat message (so
   * the transcript is never left mid-stream / empty), marks the run and session
   * as failed, and emits the run.failed event the UI listens for. Safe to call
   * from a catch path — the session is always transitioned away from 'running'.
   */
  private async finalizeRunFailed(
    ctx: RunContext,
    sessionId: string,
    runId: string,
    err: unknown,
  ): Promise<void> {
    try {
      this.setPhase(ctx, 'complete');
      const reason = err instanceof Error ? err.message : String(err);
      await this.appendAssistantMessage(
        ctx,
        `⚠️ The run stopped unexpectedly: ${reason}\n\nYour work so far is saved. You can reply below to continue.`,
      );
      await this.runService.updateStatus(runId, 'failed');
      await this.sessionService.updateStatus(sessionId, 'failed');
      this.eventEmitter.emitRunFailed(sessionId, runId, reason);
    } catch (finalizeErr) {
      this.logger.error(`Failed to finalize run as failed: ${finalizeErr}`);
      // Last-resort: still pull the session out of 'running' so it is never
      // left permanently live, even if the message/snapshot write failed.
      try { await this.sessionService.updateStatus(sessionId, 'failed'); } catch { /* ignore */ }
    }
  }

  // ── RunContext lifecycle ────────────────────────────────────────────────

  /**
   * Builds the run's entire starting context with ONE history read.
   * Layout: SYSTEM PROMPT → SNAPSHOT SUMMARY → REPLAYED RECENT MESSAGES
   * (the current user request arrives as the newest replayed row).
   */
  private async createRunContext(args: {
    sessionId: string;
    runId: string;
    userId: string;
    workspacePath: string;
    agentId: string;
    model?: string;
    provider?: string;
    remoteProfileId?: string;
    task: string;
    abortController: AbortController;
  }): Promise<RunContext> {
    const session = await this.sessionService.findOne(args.sessionId).catch((): null => null);
    const prevSnapshot = ((session?.contextSnapshot ?? null) as unknown as ContextSnapshot | null) || createEmptySnapshot(args.task);

    const rows = await this.messageService.findBySession(args.sessionId, RUN_HISTORY_LIMIT);
    // Rows folded into the snapshot are excluded; everything after them replays.
    const covered = Math.min(prevSnapshot.coveredMessages || 0, Math.max(0, rows.length - 1));
    const replay = covered > 0 ? rows.slice(covered) : rows;

    // The system prompt is NOT part of the conversation. It is stored once and
    // re-assembled into the payload's single leading system message on every
    // LLM call, so there is exactly one authoritative system message and zero
    // mid-conversation system pollution.
    // Resolve the effective working directory ONCE: when the user names a
    // specific sub-project under the workspace root, anchor the whole run's tool
    // calls there (see resolveProjectDir). Passed to the system prompt (so the
    // agent knows where commands/reads/writes land) and to the tool executor
    // (so they actually run there).
    const projectDir = resolveProjectDir(args.task, args.workspacePath);
    const huggingFace = await this.secretsService
      .getHuggingFaceStatus(args.userId)
      .catch(() => ({ configured: false, status: 'invalid' as const, envName: 'HUGGING_FACE_TOKEN' }));

    // MCP server configs (lightweight DB read, full runtime built later)
    const mcpConfigs = await this.mcpService.listServers(args.userId)
      .then(servers => servers.filter(s => s.enabled).map(s => ({ name: s.name, description: s.description })))
      .catch(() => [] as Array<{ name: string; description: string }>);
    const mcp = mcpConfigs.length > 0 ? { configured: true, servers: mcpConfigs } : undefined;

    const systemPrompt = await this.getSystemPrompt(args.agentId, args.workspacePath, projectDir, { huggingFace, mcp });

    // Conversation: user/assistant/tool only. Persisted system rows (checkpoint
    // markers, historic notes) are replayed as ephemeral runtime instructions,
    // not as system messages.
    const { conversation, replayedNotes } = this.replayHistoryToMessages(replay);
    const messages: LLMMessage[] = conversation;
    const runtimeInstructions: string[] = [...replayedNotes];

    // Warm the permission rules cache so the first tool call never blocks on
    // the DB (evaluate() is otherwise hit once per tool call).
    await this.permissionService.preload(args.userId, args.workspacePath).catch((err) =>
      this.logger.warn(`Permission preload failed (continuing uncached): ${err}`),
    );

    const toolGroups = classifyTaskGroups(args.task, args.agentId);

    // Sub-context feeder: the initial set (0-4) is auto-selected from the
    // task so sub-contexts ALWAYS open and render on every run. The agent then
    // adjusts it mid-run with context_manage as the task's context changes.
    const recommendedContexts = recommendSubContextsForTask(args.task, toolGroups);
    if (recommendedContexts.length > 0) {
      this.logger.log(`Auto-opened sub-contexts for this run: ${recommendedContexts.join(', ')}`);
    }
    const contextManager = new SubContextManager(recommendedContexts);

    // MCP runtime: load all enabled servers and register as dynamic sub-contexts
    // the agent can activate/deactivate (max 3 at a time). Memory servers are
    // auto-activated on every run so the agent always has persistent memory.
    const mcpRuntime = await this.mcpService.buildRuntime(args.userId).catch((): undefined => undefined);
    if (mcpRuntime) {
      for (const cfg of mcpRuntime.configs) {
        contextManager.registerMcpServer(
          `mcp_${cfg.id}`,
          cfg.name,
          cfg.description || `MCP server: ${cfg.name}`,
        );
      }
      for (const cfg of mcpRuntime.configs) {
        const name = cfg.name.toLowerCase();
        if (name === 'memory-mcp' || name.includes('memory') || name.includes('knowledge graph')) {
          const opened = contextManager.activate(`mcp_${cfg.id}`);
          if (opened.ok) {
            this.logger.log(`MCP memory server auto-activated: ${cfg.name}`);
          }
        }
      }
      if (mcpRuntime.configs.length > 0) {
        this.logger.log(`MCP servers registered: ${mcpRuntime.configs.map((c: { name: string }) => c.name).join(', ')}`);
      }
    }

    return {
      sessionId: args.sessionId,
      runId: args.runId,
      userId: args.userId,
      workspacePath: args.workspacePath,
      projectDir,
      agentId: args.agentId,
      provider: args.provider,
      model: args.model,
      remoteProfileId: args.remoteProfileId,
      task: args.task,
      readOnlyQuery: !toolGroups.has('editing'),
      systemPrompt,
      runtimeInstructions,
      policyViolation: null,
      hardStopReason: null,
      finishSignal: null,
      snapshot: prevSnapshot,
      messages,
      filesRead: new Set(prevSnapshot.filesRead),
      filesModified: new Set(prevSnapshot.filesModified),
      observations: [],
      plan: [],
      currentStep: 0,
      tokenBudget: resolveTokenBudget(args.provider, args.model),
      inputTokens: 0,
      outputTokens: 0,
      abortController: args.abortController,
      exposedTools: resolveExposedTools(toolGroups),
      phase: initialPhase(),
      lastToolCalls: [],
      lastCompactTokens: estimateTokens([{ role: 'system', content: systemPrompt }, ...messages]),
      contextManager,
      mcpRuntime,
    };
  }

  /**
   * Converts persisted rows into the live conversation (user/assistant/tool
   * ONLY) plus a list of historical runtime notes. Every assistant tool_call is
   * guaranteed a matching tool result — dangling calls are synthesized, so
   * providers never reject the transcript and local models never lose the
   * call→result pairing (the root cause of repeated/hallucinated tool calls).
   * System rows (checkpoint markers, historic guard notes) never enter the
   * conversation — they are surfaced as ephemeral runtime instructions that
   * get folded into the single authoritative system message.
   */
  private replayHistoryToMessages(rows: AgentMessage[]): { conversation: LLMMessage[]; replayedNotes: string[] } {
    const out: LLMMessage[] = [];
    const replayedNotes: string[] = [];
    const toolByParent = new Map<string, AgentMessage[]>();
    for (const msg of rows) {
      if (msg.role === 'tool' && msg.parentMessageId) {
        const list = toolByParent.get(msg.parentMessageId) || [];
        list.push(msg);
        toolByParent.set(msg.parentMessageId, list);
      }
    }

    for (const msg of rows) {
      if (msg.role === 'system') {
        // Compaction checkpoints are re-rendered from the durable snapshot via
        // snapshotToSystemMessage — replaying the raw marker text would
        // duplicate the summary in the single system message.
        if (msg.content && !/<conversation-checkpoint>/.test(msg.content)) replayedNotes.push(msg.content);
        continue;
      }
      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        out.push({
          role: 'assistant',
          content: msg.content || '',
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.toolName,
              arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}),
            },
            ...(tc.thought_signature ? { thought_signature: tc.thought_signature } : {}),
          })),
        });

        const children = toolByParent.get(msg.id) || [];
        msg.toolCalls.forEach((tc, idx) => {
          out.push({
            role: 'tool',
            content: children[idx]?.content ?? `(no result recorded for ${tc.toolName} — the call was skipped)`,
            tool_call_id: tc.id,
          });
        });
      } else if (msg.role === 'tool') {
        continue; // already folded into its parent above
      } else {
        out.push({ role: msg.role as LLMMessage['role'], content: msg.content });
      }
    }

    return { conversation: out, replayedNotes };
  }

  private async appendAssistantMessage(
    ctx: RunContext,
    content: string,
    toolCalls?: ToolCallJson[],
    usage?: { prompt_tokens: number; completion_tokens: number },
    reasoning?: string | null,
  ): Promise<AgentMessage> {
    const msg = await this.messageService.create(ctx.sessionId, 'assistant', content, {
      toolCalls,
      tokensInput: usage?.prompt_tokens || 0,
      tokensOutput: usage?.completion_tokens || 0,
      reasoning: reasoning || null,
    });
    ctx.messages.push({
      role: 'assistant',
      content,
      ...(toolCalls?.length
        ? {
            tool_calls: toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.toolName,
                arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}),
              },
              ...(tc.thought_signature ? { thought_signature: tc.thought_signature } : {}),
            })),
          }
        : {}),
    });
    return msg;
  }

  /**
   * Persists a tool result AND appends it to the live context. Every tool_call
   * gets exactly one result — providers require the adjacency and local models
   * hallucinate when the pairing breaks.
   */
  private async appendToolResult(
    ctx: RunContext,
    parentMessageId: string,
    toolCallId: string,
    content: string,
  ): Promise<void> {
    await this.messageService.create(ctx.sessionId, 'tool', content, { parentMessageId });
    ctx.messages.push({ role: 'tool', content, tool_call_id: toolCallId });
  }

  private async appendSystemNote(ctx: RunContext, content: string): Promise<void> {
    await this.messageService.create(ctx.sessionId, 'system', content, {});
    // Runtime guidance lives OUTSIDE the conversation: it is folded into the
    // single authoritative system message on the next LLM call, never appended
    // as a standalone system message mid-stream (which weakens local models).
    ctx.runtimeInstructions.push(content);
    if (AgentService.VIOLATION_RE.test(content)) ctx.policyViolation = content;
  }

  /** Guard-note content heuristic: marks a note as a policy violation. */
  private static readonly VIOLATION_RE =
    /must use tools|loop detected|stop searching|stop re-reading|do not re-read|blocked|usage cap|search-family|duplicate output|repeated error|verification failed|not allowed in the current phase/i;

  /**
   * Assembles the exact payload for one LLM call with EXACTLY ONE authoritative
   * system message: base policy → durable snapshot checkpoint → runtime policy
   * → ephemeral per-call directives. The conversation (user/assistant/tool)
   * follows untouched. No system message ever appears mid-conversation.
   */
  /**
   * Assembles the SINGLE authoritative system message content for each LLM
   * call: base system prompt + snapshot summary + runtime policy + the live
   * sub-context panel (active sub-contexts fed on demand by the model) + the
   * most recent runtime instructions. Everything else is injected here, never
   * appended as standalone system messages mid-conversation.
   */
  private buildSystemPromptContent(ctx: RunContext, extra?: LLMMessage[]): string {
    const sections: string[] = [ctx.systemPrompt];

    const snapMsg = snapshotToSystemMessage(ctx.snapshot);
    if (snapMsg?.content) sections.push(snapMsg.content);

    const runtimePolicy = this.buildRuntimePolicy(ctx);
    if (runtimePolicy) sections.push(runtimePolicy);

    // Context feeder: always surface the ACTIVE/AVAILABLE panel so the model
    // sees its current sub-context state; active sub-context content is fed here.
    sections.push(renderContextPanel(ctx.contextManager));

    const ephemeral: string[] = [];
    if (extra) for (const m of extra) if (m.content) ephemeral.push(m.content);
    // Only the most recent runtime guidance matters; stale notes are dropped
    // instead of letting the system block grow without bound.
    for (const note of ctx.runtimeInstructions.slice(-6)) ephemeral.push(note);
    if (ephemeral.length > 0) sections.push(ephemeral.join('\n'));

    return sections.join('\n\n');
  }

  private buildLLMMessages(ctx: RunContext, extra?: LLMMessage[]): LLMMessage[] {
    return [{ role: 'system', content: this.buildSystemPromptContent(ctx, extra) }, ...ctx.messages];
  }

  /**
   * Compact per-step directive rendered into the single system message. The
   * runner owns the workflow; the model is told its phase, what to do next,
   * what it already touched, which tools are valid this phase, and the last
   * policy violation (instead of ambiguous free-form system nudges).
   */
  private buildRuntimePolicy(ctx: RunContext): string | null {
    const lines: string[] = ['CURRENT EXECUTION STATE'];

    const directive = phaseDirective(ctx.phase);
    lines.push(`Phase: ${ctx.phase.toUpperCase()} — ${directive ?? 'terminal (no further tool work). Provide your final summary.'}`);

    if (!ctx.readOnlyQuery) lines.push(`Task: ${ctx.task}`);
    else lines.push(`Task (READ-ONLY question — never modify files): ${ctx.task}`);

    if (ctx.filesRead.size > 0) {
      const files = [...ctx.filesRead].slice(-6).join(', ');
      lines.push(`Files read: ${files}`);
    }
    if (ctx.filesModified.size > 0) {
      const files = [...ctx.filesModified].slice(-6).join(', ');
      lines.push(`Files modified: ${files}`);
    }
    if (ctx.policyViolation) lines.push(`Last violation: ${ctx.policyViolation}`);

    const phaseTools = [...PHASE_TOOLS[ctx.phase]];
    lines.push(`Tools valid this phase: ${phaseTools.length > 0 ? phaseTools.join(', ') : 'none — finalize'}`);

    lines.push('Policy: if the CURRENT PHASE asks you to act, call a tool this turn. Never narrate a tool call instead of making it. Do NOT verify by re-reading files you edited — the edit diff IS the verification.');

    return lines.join('\n');
  }

  // ── Tool scheduling ─────────────────────────────────────────────────────

  /**
   * Executes one turn's tool calls. READ tools are side-effect free → run
   * concurrently; writes/terminal/ask_user stay sequential in call order.
   */
  private async executeToolCalls(
    ctx: RunContext,
    assistantMsg: AgentMessage,
    calls: Array<{ id: string; function: { name: string; arguments: string } }>,
    guards: RunGuards,
    ids: { agentId: string; userId: string },
  ): Promise<void> {
    const parsed = calls.map((call) => ({ call, args: safeParseObject(call.function.arguments) }));
    const turnNotes: string[] = [];

    // ONE permission evaluation per call (cache-backed), shared by both paths.
    // Read-only tools (READ/SEARCH/GIT-READ) run CONCURRENTLY even inside
    // otherwise-mixed batches; writes/patches/deletes and command-family tools
    // stay strictly sequential.
    const evaluated = await Promise.all(
      parsed.map(async (p) => ({
        ...p,
        permission: await this.permissionService.evaluate(p.call.function.name, '*', ids.agentId, ids.userId, ctx.workspacePath),
      })),
    );
    const isParallelizable = (p: { call: { function: { name: string } }; args: Record<string, unknown>; permission: PermissionEffect }) =>
      p.permission === 'allow' &&
      READ_ONLY_TOOLS.has(p.call.function.name) &&
      !this.wouldTripLoopGuards(p.call.function.name, p.args, guards);

    const parallelBatch = evaluated.filter(isParallelizable);
    const sequentialBatch = evaluated.filter((p) => !isParallelizable(p));

    if (parallelBatch.length >= 1) {
      if (parallelBatch.length >= 2) {
        this.logger.log(`Executing ${parallelBatch.length} read-only tool calls in parallel`);
      }
      await Promise.all(
        parallelBatch.map((p) =>
          this.executeSingleToolCall(ctx, assistantMsg, p.call, p.args, guards, ids, p.permission, turnNotes),
        ),
      );
    }
    for (const p of sequentialBatch) {
      if (ctx.abortController.signal.aborted) break;
      await this.executeSingleToolCall(ctx, assistantMsg, p.call, p.args, guards, ids, p.permission, turnNotes);
      if (ctx.abortController.signal.aborted) break;
    }

    // Guard guidance lands AFTER the whole batch so tool results remain
    // directly adjacent to their assistant tool_calls message (a hard
    // requirement on OpenAI-compatible providers).
    for (const note of turnNotes) {
      await this.appendSystemNote(ctx, note);
    }

    // The model acted — clear any pending violation so a fresh turn starts clean.
    ctx.policyViolation = null;
  }

  /** Pure peek used by the parallel gate — no counter mutation. */
  private wouldTripLoopGuards(toolName: string, toolArgs: Record<string, unknown>, guards: RunGuards): boolean {
    // 1. Exact same tool + same args N times consecutively (classic doom loop).
    const argsKey = JSON.stringify(toolArgs);
    const window = [...guards.recentToolCalls.slice(-(DOOM_LOOP_THRESHOLD - 1)), { name: toolName, args: argsKey }];
    if (
      window.length >= DOOM_LOOP_THRESHOLD &&
      window.slice(-DOOM_LOOP_THRESHOLD).every((t) => t.name === toolName && t.args === argsKey)
    ) {
      return true;
    }
    // 2. Search-family flooding: too many search/list/read tools in a row
    //    without any mutation or verification in between.
    if (SEARCH_FAMILY_TOOLS.has(toolName)) {
      if (guards.searchFamilyStreak + 1 >= SEARCH_FAMILY_LOOP_THRESHOLD) {
        return true;
      }
    }
    return false;
  }

  private async executeSingleToolCall(
    ctx: RunContext,
    assistantMsg: AgentMessage,
    toolCall: { id: string; function: { name: string; arguments: string } },
    toolArgs: Record<string, unknown>,
    guards: RunGuards,
    ids: { agentId: string; userId: string },
    precomputedPermission: PermissionEffect | null,
    turnNotes: string[],
  ): Promise<void> {
    const { sessionId, runId } = ctx;
    const toolName = toolCall.function.name;
    const toolCallId = toolCall.id;

    // ── Deterministic phase advance from the OBSERVED intent. This MUST run
    // BEFORE the ToolGate: a mutating call from explore/plan promotes the run
    // to EDIT and grows exposure to the editing toolset, so the intent becomes
    // execution instead of an impossible skip. Phase transitions are idempotent
    // (edit→edit, verify→verify), so a call that is later sunk by the
    // doom/search guards still leaves the run in the correct state.
    this.setPhase(ctx, nextPhaseOnCall(ctx.phase, toolName));
    for (const exposed of PHASE_TOOLS[ctx.phase]) ctx.exposedTools.add(exposed);

    // ── ToolGate: enforce the phase/task tool policy in CODE. The LLM never
    // gets an "out of policy" tool name past this point (e.g. an 8B local model
    // reaching for edit_file during a read-only/explore phase).
    // MCP tools (format: <serverName>__<toolName>) bypass the gate — their
    // activation is controlled by the sub-context system.
    const toolSep = toolName.indexOf('__');
    const isMcpFormat = toolSep > 0 && ctx.mcpRuntime?.configs.some(c => c.name === toolName.slice(0, toolSep));
    if (toolName !== 'ask_user' && !ctx.exposedTools.has(toolName) && !isMcpFormat) {
      const allowed = [...ctx.exposedTools].sort().join(', ');
      const skipMsg =
        `SKIPPED ${toolName}: not allowed in phase "${ctx.phase}". Allowed tools: ${allowed || 'none (finalize now)'}. ` +
        `Pick an allowed tool or, if the task is done, provide your final summary.`;
      turnNotes.push(skipMsg);
      this.logger.warn(`ToolGate blocked ${toolName} (phase=${ctx.phase}) for run ${runId}`);
      this.eventEmitter.emitToolStarted(sessionId, runId, toolCallId, toolName, toolArgs);
      this.eventEmitter.emitToolFailed(sessionId, runId, toolCallId, 'Tool not allowed in this phase');
      await this.appendToolResult(ctx, assistantMsg.id, toolCallId, skipMsg);
      await this.persistToolStatus(assistantMsg, toolCallId, 'failed', skipMsg);
      return;
    }

    const count = (guards.toolCallCounts.get(toolName) || 0) + 1;
    guards.toolCallCounts.set(toolName, count);

    // Search-family streak: increment for search/list/read, reset on anything else.
    if (SEARCH_FAMILY_TOOLS.has(toolName)) {
      guards.searchFamilyStreak++;
    } else {
      guards.searchFamilyStreak = 0;
    }

    // Doom loop detection: same tool + same args N times consecutively.
    // IMPORTANT: recentToolCalls must be retained long enough to test a full
    // DOOM_LOOP_THRESHOLD window, otherwise the guard below can never trip
    // (it used to be capped at 5 while the threshold was 10 — dead code that
    // let a repeated failing command loop forever).
    const argsKey = JSON.stringify(toolArgs);
    guards.recentToolCalls.push({ name: toolName, args: argsKey });
    if (guards.recentToolCalls.length > DOOM_LOOP_THRESHOLD) guards.recentToolCalls.shift();
    if (
      guards.recentToolCalls.length >= DOOM_LOOP_THRESHOLD &&
      guards.recentToolCalls.slice(-DOOM_LOOP_THRESHOLD).every((tc) => tc.name === toolName && tc.args === argsKey)
    ) {
      guards.recentToolCalls.length = 0;
      const skipMsg = `SKIPPED ${toolName}: doom-loop guard tripped (same tool+args repeated ${DOOM_LOOP_THRESHOLD}× consecutively). Change approach before retrying.`;
      turnNotes.push(
        `DOOM LOOP DETECTED: Tool "${toolName}" with the same arguments has been called ${DOOM_LOOP_THRESHOLD}+ times consecutively. ` +
        `STOP calling this tool. Take a completely different approach, or if the task appears complete, provide a final summary.`,
      );
      this.eventEmitter.emitToolStarted(sessionId, runId, toolCallId, toolName, toolArgs);
      this.eventEmitter.emitToolFailed(sessionId, runId, toolCallId, skipMsg);
      await this.appendToolResult(ctx, assistantMsg.id, toolCallId, skipMsg);
      await this.persistToolStatus(assistantMsg, toolCallId, 'failed', skipMsg);
      return;
    }

    // Search-family loop: the model is stuck "looking for something" with
    // varied args or alternating search tools — reset the streak and nudge.
    if (guards.searchFamilyStreak >= SEARCH_FAMILY_LOOP_THRESHOLD) {
      guards.searchFamilyStreak = 0;
      const skipMsg = `SKIPPED ${toolName}: search-family loop detected (${SEARCH_FAMILY_LOOP_THRESHOLD} consecutive search/list calls). Take action instead of searching more.`;
      turnNotes.push(
        `SEARCH LOOP DETECTED: You have called search/list/read tools ${SEARCH_FAMILY_LOOP_THRESHOLD}+ times consecutively without making progress. ` +
        `STOP searching. You have enough context. Take action: edit a file, run a command, or provide a final answer.`,
      );
      this.eventEmitter.emitToolStarted(sessionId, runId, toolCallId, toolName, toolArgs);
      this.eventEmitter.emitToolFailed(sessionId, runId, toolCallId, skipMsg);
      await this.appendToolResult(ctx, assistantMsg.id, toolCallId, skipMsg);
      await this.persistToolStatus(assistantMsg, toolCallId, 'failed', skipMsg);
      return;
    }

    this.eventEmitter.emitToolStarted(sessionId, runId, toolCallId, toolName, toolArgs);

    if (ctx.abortController.signal.aborted) {
      await this.appendToolResult(ctx, assistantMsg.id, toolCallId, `CANCELLED ${toolName}: the run was interrupted before execution.`);
      this.eventEmitter.emitToolFailed(sessionId, runId, toolCallId, 'Cancelled by user');
      await this.persistToolStatus(assistantMsg, toolCallId, 'failed', 'Cancelled by user');
      return;
    }

    // finish_task — the model's STRUCTURAL completion signal. This sets the
    // finish flag and stops the loop deterministically (no prose regex). The
    // main loop reads ctx.finishSignal after the turn and finalizes.
    if (toolName === 'finish_task') {
      const summary = String(toolArgs.summary || '').trim() || 'Task complete';
      ctx.finishSignal = { summary };
      this.eventEmitter.emitToolOutput(sessionId, runId, toolCallId, summary);
      this.eventEmitter.emitToolCompleted(sessionId, runId, toolCallId, { success: true, output: summary, metadata: {} });
      await this.appendToolResult(ctx, assistantMsg.id, toolCallId, `[TASK COMPLETE] ${summary}`);
      await this.persistToolStatus(assistantMsg, toolCallId, 'completed', summary);
      guards.recentToolResults.push({ name: toolName, success: true, output: summary.slice(0, 200) });
      return;
    }

    // ask_user pauses the run until the user answers (or the run is aborted).
    if (toolName === 'ask_user') {
      const question = String(toolArgs.question || '');
      const options = (toolArgs.options as Array<{ label: string; description: string }>) || [];
      const multiple = Boolean(toolArgs.multiple);

      this.logger.log(`[ask_user] Emitting ask_user.required event for toolCallId=${toolCallId}, question=${question.substring(0, 80)}`);
      this.eventEmitter.emitAskUserRequired(sessionId, runId, toolCallId, question, options, multiple);
      await this.runService.updateStatus(runId, 'waiting_user_input');
      await this.sessionService.updateStatus(sessionId, 'waiting_user_input');

      const userResponse = await this.waitForUserResponse(ctx, toolCallId);

      if (!ctx.abortController.signal.aborted) {
        await this.runService.updateStatus(runId, 'executing_tool');
        await this.sessionService.updateStatus(sessionId, 'running');
      }

      this.eventEmitter.emitToolOutput(sessionId, runId, toolCallId, userResponse.slice(0, 2000));
      this.eventEmitter.emitToolCompleted(sessionId, runId, toolCallId, { success: true, output: userResponse, metadata: {} });
      await this.appendToolResult(ctx, assistantMsg.id, toolCallId, userResponse || '(no response)');
      await this.persistToolStatus(assistantMsg, toolCallId, 'completed', userResponse.slice(0, 5000));

      guards.recentToolResults.push({ name: toolName, success: true, output: userResponse.slice(0, 200) });
      if (guards.recentToolResults.length > 6) guards.recentToolResults.shift();
      return;
    }

    const permission =
      precomputedPermission ?? (await this.permissionService.evaluate(toolName, '*', ids.agentId, ids.userId, ctx.workspacePath));
    // Sensitive-file guard: reading/modifying secrets (env, keys, creds,
    // tokens) always requires the user's explicit OK — even for agents whose
    // rules otherwise auto-allow everything. This turns the resolved effect
    // into an interactive 'ask' so the prompt appears in the chat, and a
    // plain 'deny' blocks the call without touching the file.
    const sensitive = this.sensitveTargetDetected(toolName, toolArgs, ctx.workspacePath);
    const effectivePermission = sensitive && permission === 'allow' ? 'ask' : permission;
    if (sensitive && permission === 'deny') {
      const msg = `Blocked by security policy: accessing a sensitive file (secrets/credentials) requires permission.`;
      this.eventEmitter.emitToolStarted(sessionId, runId, toolCallId, toolName, toolArgs);
      this.eventEmitter.emitToolFailed(sessionId, runId, toolCallId, 'Permission denied (sensitive file)');
      await this.appendToolResult(ctx, assistantMsg.id, toolCallId, msg);
      await this.persistToolStatus(assistantMsg, toolCallId, 'failed', msg);
      return;
    }
    if (effectivePermission === 'deny') {
      const denyMsg = `Tool "${toolName}" was denied by permissions.`;
      await this.appendToolResult(ctx, assistantMsg.id, toolCallId, denyMsg);
      this.eventEmitter.emitToolFailed(sessionId, runId, toolCallId, 'Permission denied');
      await this.persistToolStatus(assistantMsg, toolCallId, 'failed', denyMsg);
      return;
    }

    if (effectivePermission === 'ask') {
      this.eventEmitter.emitPermissionRequired(sessionId, runId, toolCallId, toolName, toolArgs);
      await this.runService.updateStatus(runId, 'waiting_permission');
      await this.sessionService.updateStatus(sessionId, 'waiting_permission');

      const userChoice = await this.waitForPermission(ctx, toolCallId, {
        userId: ids.userId,
        workspacePath: ctx.workspacePath,
        toolName,
      });

      if (!ctx.abortController.signal.aborted) {
        await this.runService.updateStatus(runId, 'executing_tool');
        await this.sessionService.updateStatus(sessionId, 'running');
      }

      if (userChoice === 'deny') {
        const denyMsg = `Tool "${toolName}" was denied by user.`;
        await this.appendToolResult(ctx, assistantMsg.id, toolCallId, denyMsg);
        this.eventEmitter.emitToolFailed(sessionId, runId, toolCallId, 'Permission denied by user');
        await this.persistToolStatus(assistantMsg, toolCallId, 'failed', denyMsg);
        return;
      }
    }

    if (toolName === 'read_file') {
      const blocked = this.verificationReadBlocked(toolArgs, guards.fileMutationCounts, guards.postMutationReads);
      if (blocked) {
        this.eventEmitter.emitToolOutput(sessionId, runId, toolCallId, blocked);
        this.eventEmitter.emitToolCompleted(sessionId, runId, toolCallId, { success: true, output: blocked, isError: false });
        await this.appendToolResult(ctx, assistantMsg.id, toolCallId, blocked);
        return;
      }
    }

    if (!(await this.mutationBudgetAllows(ctx, assistantMsg, toolCallId, toolName, toolArgs, guards.fileMutationCounts))) {
      return;
    }

    const startedAt = Date.now();
    const toolTimeout = AbortSignal.timeout(LONG_TOOL_NAMES.has(toolName) ? LONG_TOOL_TIMEOUT_MS : DEFAULT_TOOL_TIMEOUT_MS);
    const combinedSignal = ctx.abortController.signal.aborted
      ? ctx.abortController.signal
      : AbortSignal.any([ctx.abortController.signal, toolTimeout]);

    // MCP tool dispatch: route <serverName>__<toolName> to the MCP server.
    const mcpSep = toolName.indexOf('__');
    const mcpServerName = mcpSep > 0 ? toolName.slice(0, mcpSep) : null;
    const isMcpTool = mcpServerName && ctx.mcpRuntime?.configs.some(c => c.name === mcpServerName);

    let result: ToolResult;
    if (isMcpTool && ctx.mcpRuntime) {
      const cfg = ctx.mcpRuntime.configs.find(c => c.name === mcpServerName)!;
      const mcpToolName = toolName.slice(mcpSep + 2);
      try {
        let handle = ctx.mcpRuntime.handles.get(cfg.id);
        if (!handle) {
          handle = await ctx.mcpRuntime.activateServer(cfg.id);
        }
        const mcpResult = await handle.callTool(mcpToolName, toolArgs);
        const text = (mcpResult.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n') || '(no output)';
        result = {
          success: !mcpResult.isError,
          output: text,
          isError: mcpResult.isError,
          metadata: { mcpServer: cfg.name, mcpTool: mcpToolName },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result = { success: false, output: `MCP tool error: ${msg}`, isError: true };
      }
    } else {
      // Registry tool dispatch
      result = await this.toolRegistry.execute(toolName, toolArgs, {
        workspaceDir: ctx.projectDir || ctx.workspacePath,
        workspacePath: ctx.workspacePath,
        sessionId,
        runId,
        userId: ids.userId,
        abortSignal: combinedSignal,
        toolCallId,
        workspaceIndex: this.workspaceIndex,
        eventEmitter: this.eventEmitter,
        remoteSsh: ctx.remoteProfileId ? { destinationId: ctx.remoteProfileId, userId: ids.userId } : undefined,
        contextManager: ctx.contextManager,
      });
    }

    try {
      this.applyMutationBookkeeping(toolName, toolArgs, result, guards.fileMutationCounts, guards);

      // Structured-result contract at the single choke point: duration stamping,
      // oversized-output spill to .smoke/runs/<runId>/ artifacts (works for every
      // tool, converted or not), summary backfill.
      await enrichToolResult(toolName, result, { workspacePath: ctx.workspacePath, runId, startedAt });

      // Phase advance from the RESULT: verification failures demote VERIFY → RECOVER.
      // A non-zero exit code is NOT an automatic failure for command-family tools —
      // the tool contract renders it as an "[exit code: N]" marker that is DATA for the
      // agent to interpret (grep/rg pipes legitimately exit 1 for "no match", which is
      // often a clean pass). Only genuine tool-level errors (spawn failure, crash) or a
      // timeout demote the run. The agent reads the marker and decides how to react.
      const commandFamily = toolName === 'run_command' || toolName === 'run_test';
      const failed =
        result.isError === true ||
        result.metadata?.timedOut === true ||
        (!commandFamily && typeof result.metadata?.exitCode === 'number' && result.metadata.exitCode !== 0);
      const prevPhase = ctx.phase;
      this.setPhase(ctx, nextPhaseOnResult(ctx.phase, toolName, failed));
      if (prevPhase === 'verify' && ctx.phase === 'recover') {
        turnNotes.push(
          'VERIFICATION FAILED → RECOVER: read the failure output carefully and identify the ROOT CAUSE before changing more code. ' +
            'Fix the cause (not the symptom), then run the same failing check again. If the failure reveals the task was misunderstood, say so instead of patching blindly.',
        );
      }

      // A returned tool response is NOT automatically a success — isError rules.
      if (result.isError) {
        this.eventEmitter.emitToolFailed(sessionId, runId, toolCallId, this.firstErrorLine(result.output));
      } else {
        // Emit tool.output BEFORE tool.completed so frontend shows output first
        this.eventEmitter.emitToolOutput(sessionId, runId, toolCallId, result.output.slice(0, 2000));
        this.eventEmitter.emitToolCompleted(sessionId, runId, toolCallId, result);
      }

      await this.persistToolStatus(
        assistantMsg,
        toolCallId,
        result.isError ? 'failed' : 'completed',
        result.output.slice(0, 5000),
        result,
      );
    } catch (postErr) {
      this.logger.warn(`Post-execution processing failed for ${toolName}: ${postErr}`);
      // Ensure the frontend is never left with a tool stuck in 'running' state
      this.eventEmitter.emitToolFailed(sessionId, runId, toolCallId, `Tool execution failed: ${postErr}`);
      await this.persistToolStatus(assistantMsg, toolCallId, 'failed', `Tool execution failed: ${postErr}`);
      // The failure reason MUST reach the LLM too — always feed the error
      // back into the tool result the agent sees next.
      result.isError = true;
      result.output = `${result.output || ''}\n[TOOL RESULT PROCESSING ERROR: ${postErr}]`;
    }

    if (toolName === 'read_file' && result.metadata?.path) {
      ctx.filesRead.add(String(result.metadata.path));
    }
    if (['write_file', 'apply_patch', 'delete_file', 'replace_lines', 'line_edit'].includes(toolName) && result.metadata?.path) {
      ctx.filesModified.add(String(result.metadata.path));
      // First mutation ⇒ verification tools become relevant from here on.
      for (const t of TOOL_GROUPS.verification) ctx.exposedTools.add(t);
    }

    const storedOutput = await this.compactToolOutput(ctx.workspacePath, runId, toolCallId, result.output);
    await this.appendToolResult(ctx, assistantMsg.id, toolCallId, storedOutput);

    // Track recent tool results for completion detection. Command-family tools
    // report success structurally via metadata.exitCode (no text sniffing).
    const exitCode = typeof result.metadata?.exitCode === 'number' ? result.metadata.exitCode : undefined;
    const isSuccess = !result.isError && (exitCode === undefined || exitCode === 0) && !result.metadata?.timedOut;
    guards.recentToolResults.push({ name: toolName, success: isSuccess, output: result.output.slice(0, 200) });
    if (guards.recentToolResults.length > 6) guards.recentToolResults.shift();

    // Runaway-build guard: count consecutive FAILED verification commands
    // (build/test/typecheck) with no successful edit between them. A build that
    // keeps failing and that the agent cannot fix must terminate the run rather
    // than being re-run to MAX_STEPS — this is the build-loop protection.
    if (!isSuccess && (toolName === 'run_command' || toolName === 'run_test')) {
      guards.consecutiveFailedVerifications++;
      if (guards.consecutiveFailedVerifications >= MAX_CONSECUTIVE_FAILED_VERIFICATIONS) {
        ctx.hardStopReason =
          `Stopping: the ${toolName} command has failed ${guards.consecutiveFailedVerifications} times in a row ` +
          `(${MAX_CONSECUTIVE_FAILED_VERIFICATIONS} consecutive verification failures) without a successful fix. ` +
          `The run is finalizing as failed because it is stuck re-running a failing check. ` +
          `Output below shows the latest failure.`;
        this.logger.warn(`[run-hard-stop] ${ctx.hardStopReason} (run ${runId})`);
      }
    }

    // No-progress spin guard: the same tool returning the byte-identical output
    // many times means the model isn't moving forward. Nudge it to act instead.
    const outputSig = result.output.slice(0, 200);
    if (outputSig && outputSig === guards.lastOutputSignature) {
      guards.sameOutputStreak++;
      if (guards.sameOutputStreak >= SAME_OUTPUT_THRESHOLD) {
        guards.sameOutputStreak = 0;
        turnNotes.push(
          `DUPLICATE OUTPUT DETECTED: Tool "${toolName}" returned the identical output ${SAME_OUTPUT_THRESHOLD}+ times in a row without any change. ` +
          `You are not making progress. STOP repeating this call and change your approach — read a different file, edit code, run a different command, or provide a final answer.`,
        );
      }
    } else {
      guards.sameOutputStreak = 0;
      guards.lastOutputSignature = outputSig;
    }
  }

  /** Syncs status/output back into the assistant message's toolCalls JSON. */
  private async persistToolStatus(
    assistantMsg: AgentMessage,
    toolCallId: string,
    status: ToolCallJson['status'],
    output: string,
    result?: unknown,
  ): Promise<void> {
    try {
      const freshMsg = await this.messageService.findOne(assistantMsg.id);
      if (!freshMsg?.toolCalls) return;
      const updated = freshMsg.toolCalls.map((tc) =>
        tc.id === toolCallId ? { ...tc, status, output, ...(result !== undefined ? { result } : {}) } : tc,
      );
      await this.messageService.updateToolCalls(assistantMsg.id, updated);
    } catch (err) {
      this.logger.warn(`persistToolStatus failed for ${toolCallId}: ${err}`);
    }
  }

  private waitForUserResponse(ctx: RunContext, toolCallId: string): Promise<string> {
    return new Promise<string>((resolve) => {
      const signal = ctx.abortController.signal;
      const finish = (value: string) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = () => finish('(user interrupted)');
      if (signal.aborted) return resolve('(user interrupted)');
      signal.addEventListener('abort', onAbort, { once: true });
      this.pendingAskUser.set(toolCallId, { resolve: finish });
    });
  }

  private waitForPermission(
    ctx: RunContext,
    toolCallId: string,
    meta: { userId: string; workspacePath: string; toolName: string },
  ): Promise<PermissionEffect> {
    return new Promise<PermissionEffect>((resolve) => {
      const signal = ctx.abortController.signal;
      const finish = (value: PermissionEffect) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = () => finish('deny');
      if (signal.aborted) return resolve('deny');
      signal.addEventListener('abort', onAbort, { once: true });
      this.permissionService.registerPendingRequest(toolCallId, finish, meta);
    });
  }

  private async finalizeInterrupted(sessionId: string, runId: string): Promise<void> {
    try {
      // Persist an explicit end-of-chat marker so an interrupted session never
      // re-opens as a dangling/empty transcript — the chat stays visible and
      // restorable after a refresh.
      await this.messageService.create(sessionId, 'assistant', '✋ Run interrupted by the user. Your work so far is saved — reply below to continue.');
      await this.runService.updateStatus(runId, 'interrupted');
      await this.sessionService.updateStatus(sessionId, 'interrupted');
      this.eventEmitter.emitRunInterrupted(sessionId, runId, 'user_interrupt');
    } catch (err) {
      this.logger.warn(`finalizeInterrupted: ${err}`);
      // Still pull the session out of 'running' so it is never left stuck live.
      try { await this.sessionService.updateStatus(sessionId, 'interrupted'); } catch { /* ignore */ }
    }
  }

  /** Advances the deterministic phase machine; emits phase.changed + agent.state events. */
  private setPhase(ctx: RunContext, next: AgentPhase): void {
    if (next === ctx.phase) return;
    const from = ctx.phase;
    ctx.phase = next;
    this.eventEmitter.emitPhaseChanged(ctx.sessionId, ctx.runId, from, next);

    // Emit structured state events for the UI timeline.
    const { sessionId, runId } = ctx;
    // Mark the previous phase as completed.
    this.eventEmitter.emitAgentState(sessionId, runId, from, 'completed');
    // Mark the new phase as active.
    const detail = phaseDirective(next) ?? undefined;
    this.eventEmitter.emitAgentState(sessionId, runId, next, 'active', detail);
  }

  /** Success finalization: terminal phase + status updates + completion event. */
  private async finalizeRunSuccess(ctx: RunContext, sessionId: string, runId: string): Promise<void> {
    this.setPhase(ctx, 'complete');
    await this.runService.updateStatus(runId, 'completed');
    await this.sessionService.updateStatus(sessionId, 'completed');
    this.eventEmitter.emitRunCompleted(sessionId, runId);
  }

  /**
   * Real compaction: summarizes the OLD portion of the LIVE conversation,
   * replaces it with a snapshot block, and persists the snapshot so future
   * runs also start from SUMMARY + RECENT instead of the full transcript.
   * The system prompt is synthetic (not part of ctx.messages) — compaction
   * sees a leading system view so its cut semantics stay unchanged, and the
   * runner strips it back out of the rewritten conversation.
   */
  private async maybeCompact(ctx: RunContext): Promise<void> {
    const systemView: LLMMessage = { role: 'system', content: this.buildSystemPromptContent(ctx) };
    const fullView: LLMMessage[] = [systemView, ...ctx.messages];
    const estBefore = estimateTokens(fullView);
    const overBudget = estBefore > ctx.tokenBudget * COMPACTION_THRESHOLD;
    const intervalDue = ctx.currentStep > 0 && ctx.currentStep % COMPACTION_INTERVAL === 0;
    if (!overBudget && !intervalDue) return;
    // Don't pay for an LLM summarize when little changed since the last one.
    if (!overBudget && estBefore < Math.max(ctx.lastCompactTokens, 1) * 1.15) return;
    if (ctx.messages.length < KEEP_RECENT_MESSAGES + 6) return;

    this.eventEmitter.emitRun(ctx.sessionId, ctx.runId, 'compacting', {});
    this.eventEmitter.emitCompactionStarted(ctx.sessionId, ctx.runId, estBefore);
    await this.runService.updateStatus(ctx.runId, 'compacting');
    let result;
    try {
      result = await this.compactionService.compactRunContext({
        sessionId: ctx.sessionId,
        messages: fullView,
        provider: ctx.provider,
        model: ctx.model,
        userId: ctx.userId,
      });
    } finally {
      await this.runService.updateStatus(ctx.runId, 'executing_tool');
    }

    ctx.lastCompactTokens = estBefore;
    if (!result) return;

    // Merge what this run learned into the durable snapshot. The leading entry
    // (synthetic system prompt, no DB row)` is the only synthetic element, so
    // the covered delta is cutIndex − 1 conversation rows.
    const snapshot = ctx.snapshot;
    const newlyCoveredRows = Math.max(0, result.cutIndex - 1);
    snapshot.summary = snapshot.summary ? `${snapshot.summary}\n\n---\n\n${result.summary}` : result.summary;
    snapshot.coveredMessages += newlyCoveredRows;
    snapshot.filesRead = [...new Set([...snapshot.filesRead, ...ctx.filesRead])].slice(0, 200);
    snapshot.filesModified = [...new Set([...snapshot.filesModified, ...ctx.filesModified])];
    snapshot.task = ctx.task;

    // Rewrite the live conversation: strip the synthetic leading system view,
    // keep the recent tail. The snapshot checkpoint is rendered per-call into
    // the single authoritative system message, not stored as a history message.
    ctx.messages = result.kept.slice(1);
    ctx.lastCompactTokens = estimateTokens([systemView, ...ctx.messages]);
    ctx.observations.push(`Context compacted: saved ~${result.tokensSaved} tokens`);

    // Compute tokensAfter with the rewritten context and emit the real values.
    const realTokensAfter = estimateTokens([systemView, ...ctx.messages]);
    this.eventEmitter.emitCompactionCompleted(ctx.sessionId, ctx.runId, {
      tokensBefore: estBefore,
      tokensAfter: realTokensAfter,
      tokensSaved: estBefore - realTokensAfter,
      messagesCompacted: Math.max(0, result.cutIndex - 1),
      summary: result.summary,
    });

    try {
      await this.sessionService.saveContextSnapshot(ctx.sessionId, snapshot as unknown as Record<string, unknown>);
    } catch (err) {
      this.logger.warn(`Failed to persist context snapshot: ${err}`);
    }

    this.logger.log(
      `Compacted ${result.tokensSaved} tokens for session ${ctx.sessionId}; live context now ~${ctx.lastCompactTokens} tokens across ${ctx.messages.length} messages`,
    );
  }

  /**
   * Many open-weight models emit tool calls as inline text in one of several
   * house formats instead of the API's structured tool_calls array:
   *   <tool_call>{"name": "...", "arguments": {...}}</tool_call>     (Qwen)
   *   <function=name><parameter=key>value</parameter></function>      (GLM/functionary)
   *   <start_json>{"name": ..., "arguments": ...}</start_json>        (DeepSeek-style)
   * Parse all of them out of assistant content, keep only names that match
   * registered tools, and return the content with those blocks stripped.
   */
  private extractInlineToolCalls(content: string | null | undefined): {
    calls: Array<{ id: string; function: { name: string; arguments: string } }>;
    cleaned: string;
  } {
    const calls: Array<{ id: string; function: { name: string; arguments: string } }> = [];
    if (!content) return { calls, cleaned: content ?? '' };
    let knownTools = new Set<string>();
    try {
      for (const def of this.toolRegistry.getDefinitions()) knownTools.add(def.name);
    } catch { /* registry unavailable — accept all parsed names */ }

    const addCall = (name: unknown, argsRaw: unknown) => {
      const fnName = String(name || '').trim();
      if (!fnName) return;
      if (knownTools.size > 0 && !knownTools.has(fnName)) return;
      let argsStr = '{}';
      if (typeof argsRaw === 'string') argsStr = argsRaw.trim() || '{}';
      else if (argsRaw != null) argsStr = JSON.stringify(argsRaw);
      // arguments may arrive as a JSON-encoded object already
      try {
        const probe = JSON.parse(argsStr);
        if (probe && typeof probe === 'object' && !Array.isArray(probe)) argsStr = JSON.stringify(probe);
      } catch { /* leave as-is; executor tolerates empty */ }
      calls.push({
        id: `text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        function: { name: fnName, arguments: argsStr },
      });
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

    // 2. <tool_call>{...}</tool_call>  (JSON body; Qwen style)
    cleaned = cleaned.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (_m, inner: string) => {
      try {
        const block = JSON.parse(inner.trim());
        if (block.function?.name) addCall(block.function.name, block.function.arguments);
        else addCall(block.name, block.arguments ?? block.parameters ?? {});
      } catch { /* fallthrough: may contain function-markup handled below */ }
      return '';
    });

    // 3. <function=name> <parameter=key>value</parameter>... </function> (+ stray </tool_call>)
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

    // Sweep leftover dangling markers from half-emitted blocks
    cleaned = cleaned.replace(/<\/?tool_call>|<\|tool▁calls▁begin\|>[\s\S]*?<\|tool▁calls▁end\|>/g, '').trim();

    return { calls, cleaned };
  }

  /** Detects degenerate repetition loops (model stuck re-printing the same block). */
  private isDegenerateRepeat(content: string | null | undefined): boolean {
    if (!content) return false;
    const norm = content.replace(/\s+/g, ' ').trim();
    if (norm.length < 600) return false;
    const half = Math.floor(norm.length / 2);
    const head = norm.slice(0, 120);
    return norm.slice(half, half + 120) === head || norm.slice(half - 120, half) === head;
  }

  /**
   * Caps redundant "verify by re-reading" of files this run already modified:
   * one confirmation read is allowed, further ones get a synthetic answer.
   * Returns the blocking message, or null when the read should execute.
   */
  private verificationReadBlocked(
    toolArgs: Record<string, unknown>,
    mutations: Map<string, number>,
    postMutationReads: Map<string, number>,
  ): string | null {
    const p = typeof toolArgs.path === 'string' ? toolArgs.path : '';
    if (!p || (mutations.get(p) || 0) === 0) return null;
    const n = postMutationReads.get(p) || 0;
    postMutationReads.set(p, n + 1);
    if (n === 0) return null; // first verification read is fine
    return (
      `BLOCKED: "${p}" was already read ${n + 1} time(s) after being edited this run. ` +
      `The edit confirmation/diff you received IS the verification. Do not re-read this file — produce your final summary now.`
    );
  }

  /**
   * Detects whether the given tool call targets a sensitive file (secrets,
   * credentials, keys) that should always require explicit user permission:
   * .env / .env.*, files named like credentials/secret/token/key, and
   * well-known secret stores. Returns true for any tool that would read,
   * write, list, or shell into such a path.
   */
  private sensitveTargetDetected(
    toolName: string,
    toolArgs: Record<string, unknown>,
    workspacePath: string,
  ): boolean {
    const SENSITIVE_RE =
      /(^|\/)(\.env|\.env\.\w+|credentials\.|secret|secrets?[^/]*\.|\.token|tokens?[^/]*\.|\.key|\.pem|\.pfx|id_rsa|id_ed25519|\.aws\/|credentials|api[_-]?key|passwords?\.json|\.npmrc|\.pypirc|\.netrc|config\.json.*(secret|token|key))/i;

const collectTargets = (): string[] => {
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
        return targets;
      };

    // Only guard tools that can actually expose or mutate file contents.
    if (!['read_file', 'list_directory', 'inspect', 'grep', 'edit_file', 'line_edit', 'write_file', 'replace_lines', 'apply_patch', 'delete_file', 'run_command', 'search_code'].includes(toolName)) {
      return false;
    }

    for (const raw of collectTargets()) {
      const t = String(raw);
      // Resolve relative to workspace when possible so "backend/.env" matches.
      const abs = t.startsWith('/') ? t : workspacePath ? `${workspacePath}/${t}`.replace(/\/+/g, '/') : t;
      if (SENSITIVE_RE.test(t) || SENSITIVE_RE.test(abs)) return true;
    }
    return false;
  }


  /**
   * Per-file mutation budget: blocks runaway "polish loops" where a weak model
   * keeps rewriting the same file. Returns false (and reports failure to the
   * model + UI) when the file has already been modified FILE_MUTATION_LIMIT times.
   */
  private async mutationBudgetAllows(
    ctx: RunContext,
    assistantMsg: AgentMessage,
    toolCallId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    counts: Map<string, number>,
  ): Promise<boolean> {
    if (!AgentService.MUTATING_TOOLS.has(toolName)) return true;
    const path = AgentService.mutatingTargetPath(toolName, toolArgs);
    if (!path) return true;
    const used = counts.get(path) || 0;
    if (used < FILE_MUTATION_LIMIT) return true;

    const msg =
      `BLOCKED: "${path}" has already been modified ${used} times in this run (limit ${FILE_MUTATION_LIMIT}). ` +
      `The current content stands as final. Do NOT modify this file again — produce your final summary now.`;
    await this.appendToolResult(ctx, assistantMsg.id, toolCallId, msg);
    this.eventEmitter.emitToolFailed(ctx.sessionId, ctx.runId, toolCallId, `mutation limit (${FILE_MUTATION_LIMIT}) reached for ${path}`);
    await this.persistToolStatus(assistantMsg, toolCallId, 'failed', msg);
    return false;
  }

  /** Counts successful mutations and appends anti-loop guidance into the tool output the model sees. */
  private applyMutationBookkeeping(
    toolName: string,
    toolArgs: Record<string, unknown>,
    result: { isError?: boolean; output?: string },
    counts: Map<string, number>,
    guards?: RunGuards,
  ): void {
    if (result.isError || !result.output || !AgentService.MUTATING_TOOLS.has(toolName)) return;
    // A successful edit is real forward progress — reset the consecutive
    // failed-verification counter so a legitimately-fixed build isn't punished.
    if (guards) guards.consecutiveFailedVerifications = 0;
    const path = AgentService.mutatingTargetPath(toolName, toolArgs);
    if (!path) return;

    const used = (counts.get(path) || 0) + 1;
    counts.set(path, used);

    if (toolName !== 'delete_file') {
      result.output += '\n(Do not re-read the file to verify — this confirmation is authoritative.)';
    }
    if (used === FILE_MUTATION_LIMIT - 1) {
      result.output += `\n\nWARNING: this is modification #${used} of "${path}" in this run. If the task is done, finalize now — further edits will be blocked.`;
    }
  }

  /**
   * Large tool output must never flood the LLM context. Everything above the
   * budget is compacted to head + error/warning lines + tail, while the full
   * raw output is archived on disk so the model can read_file it on demand.
   */
  private async compactToolOutput(
    workspacePath: string,
    runId: string,
    toolCallId: string,
    output: string,
  ): Promise<string> {
    const MAX_CHARS = 12_000;
    if (!output || output.length <= MAX_CHARS) return output;

    // 1. Archive the full artifact (best effort — never fail the tool over this)
    let artifactRel = '';
    try {
      const dir = `${workspacePath}/.smoke/runs/${runId}`;
      await fsp.mkdir(dir, { recursive: true });
      const fileName = `${(toolCallId || `out_${Date.now()}`).replace(/[^\w.-]/g, '_')}.log`;
      await fsp.writeFile(`${dir}/${fileName}`, output);
      artifactRel = `.smoke/runs/${runId}/${fileName}`;
    } catch { /* read-only workspace etc. */ }

    // 2. Build the compact view
    const lines = output.split('\n');
    const errRe = /(error|fail(ed|ure)?|exception|traceback|cannot|unable|denied|not found|fatal|✕|✗|exit code: (?!0))/i;
    const errLines = lines.filter((l) => errRe.test(l)).slice(0, 40);
    const parts: string[] = [
      `[output truncated — ${lines.length} lines / ${output.length} chars]`,
      ...lines.slice(0, 40),
    ];
    if (errLines.length > 0) parts.push('[error/warning lines]', ...errLines);
    parts.push('[...]', ...lines.slice(-80));
    if (artifactRel) parts.push(`[full output saved to ${artifactRel} — use read_file to inspect]`);
    return parts.join('\n');
  }

  private static readonly MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'line_edit', 'replace_lines', 'apply_patch']);

  /** Resolves the first file a mutating tool targets. apply_patch has no `path`
   *  arg — it carries target paths inside patchText — so extract the first
   *  `+++ b/<path>` (or `--- a/<path>`) header for per-file budget bookkeeping. */
  private static mutatingTargetPath(toolName: string, toolArgs: Record<string, unknown>): string {
    if (toolName !== 'apply_patch') {
      return typeof toolArgs.path === 'string' ? toolArgs.path : '';
    }
    const patch = typeof toolArgs.patchText === 'string' ? toolArgs.patchText : '';
    if (!patch) return '';
    const m = patch.match(/\+\+\+\s+(?:b\/)?(\S+)/);
    if (m) return m[1].replace(/\t.*$/, '').trim();
    const mOld = patch.match(/^---\s+(?:a\/)?(\S+)/m);
    return mOld ? mOld[1].replace(/\t.*$/, '').trim() : '';
  }

  private firstErrorLine(output: string): string {
    const line = output.split('\n').find((l) => l.trim().length > 0) || 'Tool failed';
    return line.slice(0, 200);
  }

  private async getSystemPrompt(
    agentId: string,
    workspacePath?: string,
    projectDir?: string,
    opts?: {
      huggingFace?: {
        configured: boolean;
        status: 'ok' | 'invalid';
        envName: string;
        tier?: 'free' | 'paid' | null;
      };
      mcp?: {
        configured: boolean;
        servers: Array<{ name: string; description: string }>;
      };
    },
  ): Promise<string> {
    const env = `You are powered by an AI coding agent. Here is some useful information about the environment you are running in:
<env>
  Workspace root: ${workspacePath || process.cwd()}
  Working directory (every tool call DEFAULTS to this): ${projectDir || workspacePath || process.cwd()}
  Platform: darwin
  Today's date: ${new Date().toDateString()}
</env>`;

    const base = `${env}

# SMOKE MONKEY — AUTONOMOUS CODE AGENT

You are Smoke Monkey, an autonomous software-engineering agent operating through a tool harness.

Your job is to COMPLETE the user's task, not to explain how the user could complete it.

==================================================
MANDATORY: FILE ASSET MENTIONS (PDF / PPT / IMAGES / ANY GENERATED FILE)
==================================================

Any file you CREATE that the user needs to see or download — a PDF, PPT/PPTX, Word
document, image (PNG/JPG/JPEG/GIF/WEBP/SVG/AVIF), HTML export, CSV, or any other
generated asset — MUST be announced in your chat response with the EXACT file-mention
tag, on its own line:

  <file-SM-st>/absolute/path/to/report.pdf<file-sm-ed>

Rules (STRICT — a missed mention is a hard failure because the user then has NO way to
see or download the file):
· Wrap the ABSOLUTE path between the two tags verbatim: <file-SM-st>/Users/me/docs/report.pdf<file-sm-ed>.
· Put ONE mention per generated file, in the same response where you describe finishing
  that file. Do not rely on "see the file in the workspace" — the user does not browse
  the workspace.
· PDF/PPT/Word/archive assets render as downloadable file cards. Images (png/jpg/jpeg/
  gif/webp/svg/avif) render as inlined previews the user can also download.
· If you generated an image, still add the mention — the mention IS what renders it.
· Never wrap the tag in a code fence or markdown link; emit it as plain text.

Failure to emit the <file-SM-st>…<file-sm-ed> mention for any created asset means the
file is INVISIBLE to the user. Treat it as a critical requirement, not a suggestion.

==================================================
1. CORE RULE
==================================================

Think → Inspect → Act → Verify → Finish.

When work is required, USE TOOLS.

Do not replace an action with narration.

BAD:
"I will inspect the authentication service."

GOOD:
Call find_symbol, rg, or run_command immediately.

Do not say something was changed unless a mutation tool actually changed it.

Do not say something works unless you verified it.

==================================================
1a. PARALLEL INSPECTION — BATCH READ-ONLY CALLS
==================================================

Inspection is parallel and batched as a FIRST-CLASS primitive, not an optional
good behavior:

- The inspect tool reads MANY files and lists MANY directories in ONE call.
  When you need to see a directory tree AND key files, pass ALL the paths to
  inspect at once (up to 12): inspect(...){paths:[...]} — it executes them all
  concurrently and returns everything in one result. Prefer inspect for any
  bulk orientation; use read_file only for deep/line-targeted reads.
- If you emit separate read-only calls (list_directory, read_file, glob, grep,
  find_symbol, search_code, git_diff) they run CONCURRENTLY in the background
  too — so when you genuinely need >1 of them in one step, emit them TOGETHER
  as MULTIPLE tool calls in ONE response instead of one-at-a-time. Each
  round-trip is a network latency cost; batching makes inspection 2-5x faster.
- Right after a list_directory, do NOT next-turn list/read each child one by
  one. Batch the reads of the relevant files + the greps you already know you
  need in a single turn of several tool calls (or one inspect call).
- Keep batching reads/lists/greps until you understand the shape; a single turn
  may contain 3-6 read-only tool calls.
- Do NOT batch or parallelize anything that WRITES, runs the terminal, asks the
  user, or depends on the result of another call — those stay sequential and
  only ONE is issued per turn.
- Only batch calls that are independent (their inputs do not depend on another
  call's output).

==================================================
1b. GENERAL CHAT vs CODE TASK (DECIDE THE MODE)
==================================================

You are BOTH a friendly conversational assistant AND a coding/editing agent.
Before acting, decide which mode this message needs:

CASUAL / GENERAL CHAT — when the user is just talking to you, greeting you,
making small talk, or asking a general question that has NOTHING to do with
their codebase (e.g. "hi", "hello", "how are you", general advice, thanks,
opinions, casual questions):
- Answer directly, warmly, and in ONE short response.
- DO NOT call any tools. DO NOT read, search, or inspect the project.
- DO NOT open sub-contexts, do not plan, do not start a coding loop.
- End immediately after your reply — one loop, done.
- Reply EXACTLY ONCE. Do not repeat or echo your greeting, do not send a second
  or third "hello" / "how can I help" variant, and do not ask an open-ended
  follow-up question. Your single message is the entire answer, then you stop.
  If you feel the urge to say another greeting, don't — you are already done.

CODE / PROJECT TASK — when the message involves their project, code, files,
build, tests, a feature, a bug, or anything about the workspace:
- Then and only then explore the project, use todo_write for multi-step work,
  and run the full verify-then-fix loop until complete.

If you are unsure, default to a brief friendly reply and ASK what they want —
do NOT start scanning the repository for a casual message.

Rules:
- NEVER run terminal commands, glob, grep, or read files just to answer a
  greeting or a non-code general question.
- A coding loop is for coding tasks only. Casual chat must not trigger the
  tool loop.

==================================================
1c. PATH DISCIPLINE — STAY IN THE RIGHT PROJECT
==================================================

The workspace may hold SEVERAL projects in one folder. When the user names a
specific project (by path or name) at the start of the task, that project IS
your working directory for the whole run:

- WORKING DIRECTORY: every tool call DEFAULTS to the user's named project
  (shown at the top as "Working directory"). run_command, read_file, write_file,
  edit_file, grep, glob and search all anchor there for this run.
- PASS WORKDIR EXPLICITLY: if a command must run inside a subfolder of the named
  project, pass workdir with a path RELATIVE TO the working directory (e.g.
  workdir:"backend"), never an ambiguous absolute path and never the parent root.
- RELATIVE PATHS: prefer relative paths so they resolve against the working
  directory, not the multi-project root.
- STAY CONSISTENT: once you pick the project, keep using the SAME project path for
  every subsequent read/write/run in this task. Do NOT drift back to the parent
  folder or switch to a sibling project unless the user asks.
- HOLD THE CONTEXT: the working directory persists for the entire run. Never
  "reset" to the root between steps.
- If the user did NOT name a project, default to the workspace root.
- Before acting, if the exact target directory is ever unclear, confirm it quickly
  (e.g. run_command "pwd && ls") rather than guessing and hitting the wrong project.

==================================================
2. TOOL PRIORITY
==================================================

Use the cheapest tool that can answer the question.

0. todo_write (BEFORE multipart work)
   → plan the task: write the step list as soon as you understand what a
     multi-step task requires, and keep it updated as you go (see Section 24).

1. WorkspaceIndex / find_symbol
   → locate symbols, definitions, references. PREFERRED over grep for any
     symbol/identifier lookup — it resolves via a local SQLite index in ~1ms
     instead of a full-tree scan. Call find_symbol ({name}) or search_code
     ({query: "ExactIdentifier"}) FIRST; only fall back to rg/grep for
     fuzzy or regex text search that symbol lookup cannot answer.

2. rg / fd
   → search text and locate files (use for fuzzy/regex content search).

3. inspect
   → read MANY files + list MANY directories in ONE concurrent call. Best
     default for orientation (directory trees + their key files together).

4. read_file
   → inspect the exact relevant code (deep/line-targeted reads).

5. run_command
   → terminal investigation, scripts, tests, builds,
     git, logs, processes, HTTP/API checks.

 6. line_edit
   → apply MULTIPLE line-keyed edits in ONE call: pass
     {"<lineNumber>": "code"} for any existing or new lines.
     Most token-efficient targeted editor. Use when you know
     the exact lines to change across a file.

 6. replace_lines
   → fast, token-efficient existing-file edit using read_file
     line numbers (startLine..endLine + replacement text).
     Use for a contiguous range; line_edit for scattered lines.

 7. edit_file
   → focused existing-file modification when you don't have
     exact line numbers.

 8. apply_patch
   → multiple related edits in one atomic change.

 9. write_file
   → create a new file.

 10. git diff
   → inspect the actual change.

 11. tests / typecheck / build
    → verify correctness.

 12. run app + curl + logs
    → prove runtime behavior when required.

Do NOT use a more expensive operation when a cheaper one is sufficient.

==================================================
3. TERMINAL IS A PRIMARY TOOL
==================================================

Use the terminal aggressively for engineering work.

Do not make many tiny terminal calls when one command can answer the same question.

COMBINE RELATED OPERATIONS.

Example:

Instead of:

run_command("pwd")
run_command("git status")
run_command("git branch")
run_command("git diff --stat")

Prefer:

run_command(
  "pwd && " +
  "git status --short && " +
  "git branch --show-current && " +
  "git diff --stat"
)

Example: investigate an authentication bug:

run_command(
  "rg -n \"AuthService|login|JWT|token|timeout\" src test && " +
  "git status --short"
)

Then inspect only the relevant result:

read_file("src/auth/auth.service.ts", relevant lines)

Example: project discovery:

run_command(
  "printf '\\n=== ROOT ===\\n' && pwd && " +
  "printf '\\n=== FILES ===\\n' && tree -L 2 -I 'node_modules|dist|.git' && " +
  "printf '\\n=== PACKAGE ===\\n' && cat package.json | jq '.scripts' && " +
  "printf '\\n=== GIT ===\\n' && git status --short"
)

Example: verify a change:

run_command(
  "git diff --check && " +
  "pnpm exec tsc --noEmit && " +
  "pnpm test"
)

Example: start and verify an application:

run_command(
  "pnpm dev > /tmp/app.log 2>&1 & " +
  "sleep 3 && " +
  "lsof -nP -iTCP:... -sTCP:LISTEN && " +
  "curl -fsS http://.../health && " +
  "tail -n 50 /tmp/app.log"
)

Example: debug a runtime failure:

run_command(
  "git status --short && " +
  "tail -n 200 /tmp/app.log | rg -n -C 8 'ERROR|Exception|FATAL|ECONNREFUSED'"
)

Then use the error to decide the NEXT command.

Never blindly repeat a failed command.

==================================================
4. TERMINAL COMMAND RULES
==================================================

Prefer:

rg over grep
fd over find
jq for JSON
git diff for changes
git status before risky operations
pnpm/npm/yarn according to the project's lockfile
pnpm search / npm search for the CORRECT library name & version (MANDATORY before adding any dependency)

Use pipelines and && when operations depend on each other.

Use ; only when operations are independent.

Keep output focused:

--short
--stat
head
tail
-C
targeted file ranges

Do not dump huge repositories or entire files into context.

Never let a command wait for stdin.

Use non-interactive flags:

--yes
-y
CI=true

Run long-running servers in the background.

Always verify that a background process actually started.

========  COMMON COMMANDS YOU WILL USE  ========

Discovery / search:
  rg -n "PATTERN" <dir>          # content search (use over grep)
  fd -t f -e ts "<name>"        # file search (use over find)
  ls -la / tree -L N            # directory layout
  du -sh * / find . -maxdepth 2 # space / structure

Git:
  git status --short
  git diff --stat / git diff <file>
  git log --oneline -10
  git branch --show-current
  git ls-files

Package / build / test:
  pnpm install (or npm/yarn to match the lockfile)
  pnpm exec tsc --noEmit
  pnpm test / pnpm test -- --run
  pnpm build / next build / vite build
  pnpm lint / pnpm typecheck

FIND THE CORRECT LIBRARY — MUST USE, never guess:
  pnpm search <name>   (or: npm search <name> to match the lockfile)
  ALWAYS search the registry BEFORE adding any dependency to confirm the
  package exists, its exact name, and the latest/appropriate version. Never
  invent a name, version, or API from memory — a wrong guess is a failed
  install and wasted steps. After installing, read its real API from
  node_modules/<pkg>/README / types before using it.

Package manager install errors — READ THE OFFSET AND FIX THE FILE:
  If pnpm i / npm i / yarn fails with
  ERR_PNPM_JSON_PARSE, EJSONPARSE, Unexpected non-whitespace character after JSON,
  Unexpected token at position N, or the path of a package.json — the target package.json
  is corrupt JSON. Do NOT retry blindly. Do NOT probe far. First action:
    1. read_file the failing package.json (the error names it, e.g. backend/package.json).
    2. Read it EXACTLY. A corrupt file usually has ONE missing brace/bracket/quote or a
       broken "scripts" block (e.g. "scripts": { ... } with fields spilled outside the
       braces and a stray closing brace, or dev assigned at the top level). Position N
       points at the first wrong character (column ~= byte offset from the opening brace).
    3. Fix ONLY the syntax. Preserve every key and its value; do not reformat or reword.
       Restore the proper nested shape: { "scripts": { "dev": "...", ... }, ... }.
    4. Confirm it parses with:  jq empty <file>   (or a JSON.parse call in node),
       then re-run the original install.


Processes / ports / HTTP — vital for runtime verification:
  lsof -nP -iTCP:<port> -sTCP:LISTEN   # who owns a port (use before killing)
  lsof -nP -iTCP:<port>                # all conns on a port
  ps -ax | rg "<name>"                # find a process
  ss -tlnp (macOS: use lsof)           # listening sockets
  curl -fsS http://localhost:<port>/... # health/HTTP check
  curl -s -o /dev/null -w "%{http_code}" <url>   # just the status code
  kill <pid>                          # graceful SIGTERM
  pkill -f "<pattern>"                # only for YOUR stray processes

Timeouts (smart, so nothing hangs):
  - Every command is auto-killed at its timeout. The DEFAULT is 3 minutes (180 seconds).
  - ALWAYS pass an explicit timeout= appropriate to the work: quick checks can
    use the default; slow work (builds, installs, watch/test suites, large
    migrations) -> timeout=300000/600000 as needed. Not setting one
    means the command is hard-capped at the 180s default and will be killed.
  - Leave a Server/watcher running by using background=true; never block
    the run on one.
  - If a command is slow but safe, extend its timeout rather than sending
    another command that might race or wedge it.

PROCESS-SAFETY (important):
  - NEVER kill the api-gateway or critical infrastructure. It runs YOU:
    killing it (a bare "kill -9 <pid>" that targets the api-gateway, or
    pkill/killall on node/postgres/redis/mysql/mongo) will sever your own
    run and is blocked by the harness.
  - To stop something you started: first find its PID with
       lsof -nP -iTCP:<port> -sTCP:LISTEN   (or ps -ax | rg "<name>")
    then kill only that specific child PID with a graceful SIGTERM:
       kill <that-pid>
  - Reserve kill -9 (SIGKILL) for processes that ignore SIGTERM — never
    as a first choice, and never on the api-gateway or a database.

HANG PREVENTION (critical — violates = terminal hangs forever):
  - NEVER combine a backgrounded server with foreground work in ONE call:
      BAD:  "nodemon src/index.js & sleep 2 && tail -30 /tmp/log"
      GOOD: Call 1: run_command("nodemon src/index.js", background=true)
            Call 2: run_command("sleep 2 && tail -30 /tmp/log")
  - The '&' operator backgrounds the process but the shell keeps its pipe fds
    open — the shell never exits, the timeout fires but can't kill it, and
    the next command never runs.
  - Long-running servers (nodemon, pm2, vite dev, next dev, pnpm dev, etc.)
    MUST use background=true on a standalone call. The tool will reject them
    if submitted without background=true.
  - If you need to verify a server started, use a SEPARATE follow-up call:
      run_command("sleep 2 && curl -fsS http://localhost:..../health")

==================================================
5. SEARCH → READ → EDIT
==================================================

For existing code, follow:

SEARCH
  ↓
LOCATE
  ↓
READ RELEVANT REGION
  ↓
UNDERSTAND
  ↓
EDIT
  ↓
DIFF
  ↓
VERIFY

Do not repeatedly read the same file.

If search returns:

AuthService → src/auth/auth.service.ts:183

read approximately:

read_file(
  src/auth/auth.service.ts,
  lines 160-220
)

Do not read the entire repository.

==================================================
6. EDITING RULES
==================================================

Before editing existing code:

1. Find the correct implementation.
2. Read enough surrounding code to understand it.
3. Make the smallest safe change.
4. Inspect git diff.
5. Verify the behavior.

Choose the right edit tool for efficiency:

line_edit
→ PREFERRED for multiple targeted edits in one call: pass
  {"<lineNumber>": "code"} for each line (from read_file). Lines
  past the end create new lines; empty string deletes a line.
  All at once, cheaply. Great for scattered changes in one file.
  IMPORTANT: line_edit is a FUNCTION TOOL — call it directly, never
  as a shell/run_command command. Each edits VALUE is the BARE line
  content exactly as it should appear on disk: no JSON wrapping, no
  commas/braces/punctuation beyond the code itself, keep indentation.

replace_lines
→ PREFERRED for a single contiguous existing-file hunk when you
  know the lines (from read_file): pass path + startLine..endLine
  + replacement. Fast and token-efficient.

edit_file
→ one focused change (use when you're unsure of exact line numbers,
  and only against a unique old-string so it replaces the right spot).

apply_patch
→ multiple related hunks across one or more files in a single call.

write_file
→ new files only, or a full rewrite when the file is small and the
  change is pervasive. NEVER use write_file to rewrite a large existing
  file just to change one line.

EFFICIENT-EDIT WORKFLOW:
1. read_file only the relevant region (line ranges from a prior rg/search),
   not the whole file.
2. Extract a precise, unique old-string / line span to target.
3. Apply the smallest surgical change with the cheapest tool that works.
4. Rerun the project's fast validation (tsc --noEmit / lint / the target test)
   and re-read the edited region to confirm it's correct.
5. Iterate on the exact hunk rather than rewriting the file.

NEVER:
- overwrite unrelated user changes;
- perform destructive cleanup to make an edit easier;
- rewrite a whole file to change a single line;
- leave behind debug logs or commented-out dead code after the edit.

TOOL CALL FAILED — REACT AND RETRY (non-negotiable):

Every tool call returns a result. When a call FAILS (edit_file/apply_patch
reports "oldString not found", "hunk did not match", a path error, a 404,
a crash, a "BLOCKED" guard, etc.), the failure is always fed back to you as
the tool result — READ IT. The failure reason is the input to your next
action, never the end of the task:

1. Diagnose the real cause from the error text (oldString mismatch → the file
   content differs from what you assumed; patch hunk drift → line numbers
   shifted; permission/path error → different target).
2. Fix the cause, not the symptom: for edit_file/apply_patch/replace_lines
   failures, read_file the target region FIRST to get the exact current text
   or line numbers, then retry with corrected arguments.
3. Retry the intended change with the corrected call. A failed tool call is
   NOT a reason to stop — keep going until it succeeds or you have rock-solid
   evidence the change is impossible.
4. Only finalize when your requested change is confirmed applied and verified
   (or genuinely blocked by a hard guard you have already tried to maneuver
   around — never write a summary about a change you did not actually make).

==================================================
7. BUILD EXCELLENT UI
==================================================

You are expected to produce polished, production-quality interfaces — not
just "working" ones. The full UI recipe (match the project's stack and look,
shadcn component recipe, mobile-first responsive layout, visual polish /
dark mode / loading-empty-error states, accessibility, verify-your-UI) is
loaded from the sub-context "frontend_ui" on demand:
context_manage(action="activate", contextId="frontend_ui").
ACTIVATE IT for any task that builds or changes frontend/UI code — then
deactivate it when the UI work is done. Core rule right here: new UI must
look native to the app, not bolted on.

==================================================
8. CODE UNDERSTANDING & MAINTENANCE
==================================================

Understand before you change. Read the call paths and data flow around
the code you touch so your change is correct at the boundaries, not just
internally consistent.

UNDERSTAND:
- Trace calls: who calls this function, what passes in, what it must return.
- Read signatures, types, and the surrounding module before editing.
- For an unfamiliar codebase, map the architecture first: entry points,
  router/middleware, data layer, and the file(s) for the feature at hand.
- Use workspace intelligence (find_symbol, rg) to find definitions and
  usages instead of guessing.

MAINTAIN:
- Preserve the existing style, naming conventions, and structure; fit in
  with how the codebase is organized (don't invent a parallel pattern).
- Make the smallest change that fixes or adds the behavior; don't refactor
  unrelated code in the same change.
- Keep functions focused and files cohesive; extract a helper only when it
  genuinely reduces duplication or complexity.
- Don't leave dead code, unused imports, TODOs you didn't create, or debug
  output. Clean up what you introduce.
- Keep public APIs/types stable unless the task explicitly requires
  changing them; update callers when you do.

DRIFT & CONSISTENCY:
- After editing, update related tests, types, and docs only as the change
  requires — keep them in sync so the codebase stays maintainable.
- Re-run the relevant tests/typecheck so you don't leave the project
  broken or "red" as a side effect of your change.

==================================================
9. GIT SAFETY
==================================================

Before significant modifications:

git status --short

Never perform these without explicit user authorization:

git reset --hard
git clean -fd
rm -rf
destructive SQL
destructive infrastructure operations

Preserve existing user changes.

==================================================
10. ERROR HANDLING
==================================================

A failed command is information.

After failure:

1. Read the exact error.
2. Identify the root cause.
3. Inspect the relevant code/config/log.
4. Change the approach.
5. Retry only after understanding why.

NEVER:

run the same failed command repeatedly.

Example:

BAD:
pnpm build
pnpm build
pnpm build

GOOD:

pnpm build
→ read TypeScript error
→ locate offending file
→ inspect code
→ patch
→ pnpm build again

==================================================
11. VERIFICATION
==================================================

"Done" means verified.

Choose verification appropriate to the task.

CODE:
git diff
→ typecheck
→ focused test
→ build when appropriate

API:
build
→ start
→ health
→ endpoint
→ inspect response
→ inspect logs
→ if the process started but port is not bound, read package.json "scripts"/"main" and the entry file — it may export the app without calling listen(); fix the entry or the script, do not keep probing an unbound port

FRONTEND:
build
→ start
→ route
→ perform user workflow
→ check console/network errors

BUG FIX:
reproduce
→ diagnose
→ patch
→ reproduce
→ verify fixed

Do not stop immediately after a successful edit.

Do not tell the user to manually verify something that the agent can verify itself.

==================================================
11b. RUNTIME VERIFY-THEN-FIX LOOP (DO THIS, DO NOT SKIP)
==================================================

After you make changes, your work is NOT done until the project actually runs
and the real errors are gone. Simply running a build once is not enough. Follow
this loop for application/server/frontend tasks:

1. START THE PROJECT
   run_command(command="<start script>", background=true) — use the project's
   own dev/start script (read package.json "scripts" first). Prefer the dev
   server if present (it surfaces TS/build errors live), else the start script.

2. CHECK THE LOGS + ERRORS
   run: sleep 2-4 && tail -n 60 <log>  (or read the streamed output) and read what
   actually happened. Look for: TypeScript/compile errors, missing modules,
   port-not-bound, HTTP failures, runtime exceptions, build-time lint errors.

3. DIAGNOSE + FIX
   For each real error, find the offending file and root cause, read it, and
   patch it (fix the TS/lint/import/port issue properly — do NOT paper over it).

4. RE-RUN / RE-VERIFY
   Re-start the project (or re-run the check) and confirm the error is gone:
   health endpoint responds, or the port is bound, or the dev server compiles
   with no errors, and tests/typecheck pass.

5. ONLY THEN finish.

Hard rule: if a TypeScript error, compile error, runtime error, or failing
check exists, you must FIX it (not just report it) — then re-run until it is
green. Do not stop after editing while the app would still crash or fail to
compile. A stopped/crashing app with errors is an unfinished task.

==================================================
12. USE WORKSPACE INTELLIGENCE
==================================================

Use WorkspaceIndex when available.

Need a symbol?
→ find_symbol

Need references?
→ find references / rg

Need text?
→ rg (or grep -rnE if rg is not installed)

Need a file?
→ fd (or find if fd is not installed)

Need exact implementation?
→ read_file

WorkspaceIndex tells you WHERE to look.

Terminal tells you WHAT is happening.

Use both.

==================================================
13. TASK EXECUTION
==================================================

For every task:

DISCOVER
→ understand project structure and task

SEARCH
→ locate relevant implementation

READ
→ inspect only relevant code

PLAN
→ determine the smallest correct change

ACT
→ edit/run commands

VERIFY
→ diff/tests/typecheck/build/runtime checks

FINISH
→ concise result

Do not get stuck in search loops.

If you already have enough information, ACT.

Do not search merely because searching is available.

==================================================
14. TOOL USAGE DECISION
==================================================

Before every tool call ask internally:

"What information or action do I need NEXT?"

Then call the tool that directly provides it.

Examples:

Need to find a class?
→ find_symbol

Need to find all usages?
→ rg

Need exact code?
→ read_file

Need git state?
→ run_command("git status --short")

Need several related facts?
→ ONE combined run_command

Need to modify existing code?
→ edit_file/apply_patch

Need to prove the change?
→ git diff + test/typecheck/build

Need runtime proof?
→ run app + curl + logs

Never call tools randomly.

==================================================
15. SMALL EXAMPLE
==================================================

User:
"Fix the login timeout bug."

Correct behavior:

1. Search for authentication implementation.

   find_symbol("AuthService")

2. Search related timeout configuration.

   run_command(
     "rg -n \"timeout|JWT|login|AuthService\" src test"
   )

3. Read the relevant implementation.

   read_file("src/auth/auth.service.ts", relevant lines)

4. Understand the root cause.

5. Patch the smallest required section.

   apply_patch(...)

6. Inspect the change.

   run_command(
     "git diff --check && git diff -- src/auth/auth.service.ts"
   )

7. Verify.

   run_command(
     "pnpm exec tsc --noEmit && pnpm test"
   )

8. If tests fail:
   diagnose the failure → patch → verify again.

9. Finish only after the bug is actually verified.

Never respond after step 1 with:
"I found the authentication service. I will now fix it."

Actually continue executing.

==================================================
16. PROJECT INSTRUCTIONS
==================================================

Project instructions from .agent are part of the project policy.

Follow them unless they conflict with this system policy.

System policy controls agent behavior.

Project policy controls project-specific conventions.

User task controls WHAT must be accomplished.

Priority:

SYSTEM POLICY
    ↓
PROJECT POLICY
    ↓
USER TASK
    ↓
RUNTIME STATE

==================================================
17. RUNTIME STATE
==================================================

The runtime may provide:

- current phase
- task
- files already inspected
- files modified
- previous tool results
- errors
- verification status
- allowed tools
- required next action

Treat runtime state as authoritative.

Do not redo completed work unless verification requires it.

If runtime says a required action remains, perform it.

==================================================
18. COMPLETION
==================================================

Do not finish merely because:

- one command succeeded;
- one file was edited;
- the model produced a plausible answer;
- the task sounds complete.

Finish when the requested objective is satisfied and appropriate verification has passed.

If genuinely blocked, clearly state:

BLOCKED:
<exact reason>

NEEDED:
<only information/action that cannot be discovered or performed by the agent>

==================================================
19. FINAL RESPONSE
==================================================

To END the run once your task is genuinely complete and verified, call the
finish_task tool with a short summary of what you did. This is the
authoritative, structural way to finish — it stops the loop immediately.

In the SAME turn as finish_task, also include your final report as plain text
(the UI shows it). Keep it short. Use:

Changed:
- ...

Verified:
- ...

Result:
- ...

Rules:
- Call finish_task exactly ONCE, at the end, when the work is truly done.
- Do NOT keep talking, re-summarize the same results, or emit more tool calls
  after calling it.
- Do NOT call finish_task for casual/general chat — just reply in text.
- Never write a summary about a change you did not actually make and verify.

==================================================
20. PR / CHANGE SUMMARY
==================================================

When asked to "summarize the work", "write a PR description", or summarize
what was done in a conversation or task:

Write like a pull request description.

- 2-3 sentences max.
- Describe the changes made, not the process.
- Do not mention running tests, builds, or other validation steps.
- Do not explain what the user asked for.
- Write in first person (I added..., I fixed...).
- Never ask questions or add new questions.
- If the conversation ends with an unanswered question addressed to the user,
  preserve that exact question.
- If the conversation ends with an imperative statement or request directed at
  the user (e.g. "Now please run the command and paste the console output"),
  always include that exact request in the summary.

==================================================
21. USEFUL LIBRARIES & RESOURCES
==================================================

The full per-domain library catalog (general utilities, backend, microservices/
messaging, frontend, testing, quality) lives in the sub-context "library_guide"
— it is fed into context ONLY when you actually need it:
context_manage(action="activate", contextId="library_guide").
Activate it when picking libraries or adding a dependency, then deactivate it
when that decision is made. Core rule right here: prefer battle-tested
libraries already proven in this project over inventing your own, and verify a
library is actually installed before you rely on it.

MANDATORY before adding any library: run
  pnpm search <name>   (or: npm search <name> to match the project's lockfile)
to confirm the correct package name and current version — then read its real
API from node_modules/<pkg>/README or its type definitions before writing any
code against it. Never guess a library's name, version, or API from memory.
If pnpm/npm is not reachable, inspect the installed registry docs under
node_modules instead — but a fresh search is always required.

==================================================
22. BACKEND SCALE & MICROSERVICES
==================================================

Deep guidance for microservices, gRPC, NATS, Kafka, message queues, the outbox
pattern, job workers, and resilience/observability is loaded from the
sub-context "backend_scale" on demand: context_manage(action="activate",
contextId="backend_scale"). ACTIVATE IT when the task touches backend/server/
API work, services, queues, streaming, or deployments — and deactivate it when
that work is done. Core rules right here: design for scale with clean service
boundaries from the start; never reach into another service's database; make
consumers idempotent.

==================================================
23. EDGE CASES
==================================================

The full edge-case checklist (nulls/empties/concurrency/idempotency/network
failures/timezones/unicode/money/render boundaries) is loaded from the
sub-context "common_edge_cases" on demand: context_manage(action="activate",
contextId="common_edge_cases"). ACTIVATE IT before you implement or review
logic, and deactivate it afterwards. Core rule right here: always think about
the boundaries — never let an edge case silently produce wrong data.

==================================================
24. TODO / TASK LIST MANAGEMENT
==================================================

Call todo_write to record a structured plan BEFORE you begin ANY multi-step,
long-running, or non-trivial task (building/running a project, fixing a failing
build, adding a feature, refactoring, debugging across files, running multiple
verifications). This is MANDATORY for multi-step work, not optional.

- PLAN FIRST: write 3-8 actionable todos covering understand → implement →
  verify. Order them logically.
- One in_progress at a time; exactly one while work remains.
- Mark a todo completed the moment that step is actually done and verified.
- Add or split todos as the task grows — a long task's plan must stay honest.
- ONLY skip todos for genuinely trivial single-step fixes.

The full task-list discipline (mark done only when actually verified, cancel
stale items instead of leaving them, no over-management) is preloaded for every
run via the sub-context "todo_management". Core rule: keep the on-screen task
list honest — never finish with unfinished-looking todos if the work is done.

==================================================
25. CONTEXT MANAGER — SUB-CONTEXT SWITCHING SYSTEM
==================================================

The main system prompt above holds your CORE rules. Deeper, situation-specific
guidance lives in SUB-CONTEXTS that YOU load and unload during the run with
the context_manage tool, so you only pay the context cost for the guidance the
current step actually needs.

HOW TO THINK ABOUT IT (this is the key to working well with a lean prompt):

- This main system prompt is STATIC and LEAN. It does NOT change during the
  run, so do NOT re-read, re-summarize, or quote it back every loop — it is
  always the same knowledge base you already have. The thing that DOES change
  every loop is the SUB-CONTEXT PANEL: that is your LIVE working set, and it is
  what you must actively drive turn to turn.
- The sub-contexts are your on-demand EXTERNAL BRAIN: activate the guidance you
  need for the CURRENT step, deactivate it the moment that step's domain ends.
  Keeping them small is how you keep the effective system prompt small and
  focused while the task gets deep.
- To avoid both forgetting AND overloading: each loop, scan the PANEL once,
  confirm the active set matches what you are doing RIGHT NOW, and adjust with
  context_manage when the work shifts. Do not let stale contexts linger (they
  waste tokens and add noise); do not open context just in case (it bloats the
  prompt). ACTIVATE when a domain is actively relevant, DEACTIVATE when it no
  longer is — reason about the CURRENT step, not the whole history.

HOW TO USE IT:

1) SESSION START — an initial set of sub-contexts (0-${MAX_ACTIVE_CONTEXTS}) is AUTO-SELECTED for you
   from the task's wording and shown in the SUB-CONTEXT PANEL. Check that panel:
   if it already fits the work, start immediately. If it does not, call
   context_manage to open the guidance you need / close anything irrelevant
   BEFORE you start working. Base it on the task the user described, not on
   every sub-context that exists:
   - "create a frontend app / build a page / fix this UI" → activate
     frontend_ui + common_edge_cases + efficient_editing (and api_contract
     if forms/API calls are involved).
   - "backend service / microservices / kafka / grpc / queue" → activate
     backend_scale + common_edge_cases + (api_contract | data_modeling).
   - "this bug keeps failing / 500 error" → debugging + backend_scale (or
     frontend_ui for UI bugs) + common_edge_cases.
   - "pick libraries / set up test runners" → library_guide + verification_rigor.
   - "generate a PDF / export to PDF / create a report" → activate
     pdf_generation + common_edge_cases.
   - "create a presentation / PowerPoint / slide deck" → activate
     ppt_generation + common_edge_cases.
   - "create an Excel file / spreadsheet / export to xlsx" → activate
     excel_generation + common_edge_cases.
   - A short read-only question → open ZERO sub-contexts; stay lean.

2) DURING THE TASK — if you find the current work needs guidance that is not
   yet loaded, call context_manage(action="activate", contextId=...) right
   then and CONTINUE the work as normal (the panel takes effect next loop).
   This includes swap: when already at ${MAX_ACTIVE_CONTEXTS}, deactivate a context you no longer
   need, then activate the new one.

3) CLOSE WHEN DONE — once a sub-context's domain is no longer part of the
   current step, deactivate it to free slots and tokens. You can reopen it
   any time later.

RULES:
- At most ${MAX_ACTIVE_CONTEXTS} sub-contexts are active at once (ACTIVE [n/${MAX_ACTIVE_CONTEXTS}]). Opening a ${MAX_ACTIVE_CONTEXTS + 1}th is
  blocked until you close one (swap one-in, one-out).
- Every turn shows a SUB-CONTEXT PANEL with your ACTIVE list and the AVAILABLE
  catalog. Read it and act on the state it shows — do not guess.
- EVERY LOOP, validate the SUB-CONTEXT PANEL id by id: for each ACTIVE
  sub-context ask "is this required for the CURRENT step?" — if it is NOT
  required at the moment, deactivate it right away; if the current step needs
  guidance that is missing, activate it. Never leave a sub-context hanging
  around "just in case" — keep active exactly what the current step needs.
- Never open sub-contexts "just in case" in bulk — 2-${MAX_ACTIVE_CONTEXTS} well-chosen ones for the
  task, and close the ones you've stopped using.

WHAT TO LOAD WHEN (id — when to activate):
${renderSystemPromptCatalog()}

REMEMBER: This system prompt is your lean, FIXED core — you never re-read it.
The SUB-CONTEXT PANEL is your live, changing working set. Each loop: scan the
panel, keep active contexts matching the CURRENT step, and activate/deactivate
with context_manage as the work shifts. Open what the step needs, close what
it no longer needs, swap one-in / one-out within the ${MAX_ACTIVE_CONTEXTS}-slot limit. A small,
correctly-scoped active set is how you stay focused and avoid both an overloaded
prompt and forgetfulness. Context is a live tool — drive it every step.
${opts?.huggingFace?.configured ? `
==================================================
HUGGING FACE ASSETS (configured — token status: ${opts.huggingFace.status}${opts.huggingFace.tier ? `, tier: ${opts.huggingFace.tier}` : ''})
==================================================
A Hugging Face token is available on this machine. It is referenced by the
environment variable ${opts.huggingFace.envName} and by the secret name
"huggingface" in the Secret Manager.

MODEL TIER RULE:
- Detected token tier: ${opts.huggingFace.tier || 'free'} (from whoami; 'paid' =
  Pro or billing-enabled account, 'free' = Basic account).
- If the token is FREE: use ONLY models marked [FREE] in the hugging_face
  sub-context. Do NOT call paid/credit models (fal-ai/wavespeed/replicate/
  nscale image+video, etc.) — they return "credit depleted" / 402. Pick a FREE
  model and adapt the task to it.
- If the token is PAID: the full model catalog is available; use the best model
  for the task.
- If tier is unknown or blank, assume FREE (be conservative).

RULES:
- To USE the token for a task (generate video/voice/image/audio/text with HF
  models), first call secret_manager(action="read", name="huggingface") — the
  run will pause and ask the user for approval. NEVER access it without that
  approval.
- Treat the retrieved value as the ${opts.huggingFace.envName} env var inside a
  command: export ${opts.huggingFace.envName}=<value>; curl … . Never print,
  echo, or log the raw token, and redact it from every reply and artifact.
- HF lets you call models in ALL categories: text/LLM chat (router
  https://router.huggingface.co/v1/chat/completions), video (Wan2.x,
  HunyuanVideo, LTX-Video, CogVideoX), voice/TTS (Kokoro, XTTS-v2, Bark,
  MeloTTS), image (FLUX.1, SD3.5, SDXL), audio/music (MusicGen, Stable Audio),
  speech-to-text (Whisper), vision (Qwen2.5-VL), embedding (BGE). Open the
  hugging_face sub-context for the full model list + endpoint reference.
  NOTE: always use router.huggingface.co — the old api-inference.huggingface.co
  host is retired and fails DNS on every network. On a 401, re-read the secret
  fresh via secret_manager and retry; do not reuse a stale transcript value.
- Wrap every generated media path in the asset marker so the frontend renders
  a playable/previewable card, on its own line:
    <file-SM-st>/abs/path/clip.mp4<file-sm-ed>
    <file-SM-st>C:\\Users\\me\\assets\\voice.wav<file-sm-ed>
- If the token status is "invalid", tell the user to update it in Settings.
  Do not attempt HF calls with an invalid token.
` : `
==================================================
HUGGING FACE (not configured)
==================================================
No Hugging Face token is saved yet. If the user asks for video/voice/image/
audio assets generated with HF models, tell them they need to add their
Hugging Face token in Settings → Hugging Face first, or ask them to save it
and retry. Do not attempt HF calls without a token.
`}
${opts?.mcp?.configured && opts.mcp.servers.length > 0 ? `
==================================================
MCP SERVERS (configured — ${opts.mcp.servers.length} server${opts.mcp.servers.length > 1 ? 's' : ''})
==================================================
External Model Context Protocol (MCP) servers are connected to this run.
Each server exposes tools prefixed with its name (e.g. "${opts.mcp.servers[0].name}__tool_name").
${opts.mcp.servers.map(s => `- ${s.name}: ${s.description}`).join('\n')}

RULES:
- MCP servers activate/deactivate like sub-contexts via context_manage.
- Use context_manage(action="activate", contextId="mcp_<id>") to load a
  server's tools. Max ${MAX_ACTIVE_MCP} MCP servers active at once.
- When an MCP server's context is active, its tools become available to you.
- Tool calls use the format: <serverName>__<toolName> (double underscore).
- Deactivate an MCP server when its tools are no longer needed to free a slot.
- MCP OVER RAW (CRITICAL PRIORITY): whenever a task can be accomplished through
  an available MCP server's tools, PREFER that MCP tool over raw/manual methods
  (hand-written terminal commands, manual HTTP requests, by-hand SQL, raw file
  scraping). Using the right MCP is the intended way to do the work — it is
  significantly better than doing the equivalent work by hand. Only fall back to
  raw methods when no active MCP tool covers the task.
` : ''}

Remember:

YOU ARE AN EXECUTION AGENT.

SEARCH LESS.
UNDERSTAND MORE.
ACT EARLIER.
COMBINE TERMINAL OPERATIONS.
VERIFY EVERYTHING THAT MATTERS.
NEVER CLAIM WORK YOU DID NOT PERFORM.
`;
    // Append project-specific instructions from .agent/ if they exist.
    let projectContext = '';
    if (workspacePath) {
      try {
        const configMsg = await this.agentConfigService.toSystemMessage(workspacePath);
        if (configMsg) projectContext = '\n\n' + configMsg;
      } catch (err) {
        // Broken/unreadable project instructions are logged, never silent —
        // otherwise the agent silently runs without policy it was told to obey.
        this.logger.warn(`[AGENT_CONFIG] Failed to load .agent instructions for ${workspacePath}: ${err}`);
      }
    }

    switch (agentId) {
      case 'build':
        return `${base}${projectContext}

## Mode: Build
You have FULL access to read, write, run commands, and git.
- Read files before editing. Then edit immediately.
- After editing, START the project, check its logs/errors, FIX any TypeScript or
  runtime errors you find, then re-test until green — do not stop after editing
  while the app would still fail (see Section 11b).
- Run tests/verification after changes.
- Make minimal, surgical changes — replace_lines (or edit_file) over write_file for existing code.
- Complete ALL parts of a task before finishing.
- For multi-step or long-running work (building/fixing a project, a full
  feature, debugging across files), FIRST call todo_write to lay out the steps,
  then keep the list updated (one in_progress, mark done as you verify). Do not
  silently grind through a long task without a visible todo plan.
- For servers: run_command(command="node server.js", background=true), then verify with curl.`;
      case 'plan':
        return `${base}${projectContext}

## Mode: Plan
Read-only access. Analyze the codebase and create a plan. Do NOT write files or run commands.
- Read and understand the code structure.
- Identify issues and propose solutions.
- Create a step-by-step implementation plan.`;
      case 'explore':
        return `${base}${projectContext}

## Mode: Explore
Search-only access. Find files, understand structure, answer questions about the code.
- Use grep, glob, and search_code to find relevant code.
- Summarize findings clearly.`;
      default:
        return `${base}${projectContext}`;
    }
  }

  /** Policy-driven retries for transient provider failures (429/5xx/timeouts). */
  private async callLLMWithRetry(
    messages: LLMMessage[],
    tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
    provider?: string,
    model?: string,
    sessionId?: string,
    runId?: string,
    userId?: string,
  ): Promise<LLMResponse> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.callLLM(messages, tools, provider, model, sessionId, runId, userId);
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
  }

  private async callLLM(
    messages: LLMMessage[],
    tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
    provider?: string,
    model?: string,
    sessionId?: string,
    runId?: string,
    userId?: string,
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
    const userKey = userId ? await this.apiKeyService.getKey(userId, provider || 'ollama') : undefined;

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
    const activeController = sessionId ? this.activeRuns.get(sessionId) : undefined;
    const llmDeadline = this.createLLMTimeoutSignal(activeController?.signal);

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
      return {
        content: msg?.content || null,
        tool_calls: this.normalizeToolCalls(msg?.tool_calls || []),
        reasoning: ['reasoning_content', 'reasoning', 'thinking', 'thought']
          .map((k) => (typeof msg?.[k] === 'string' ? msg[k] : ''))
          .join('') || null,
        usage: data.usage ? {
          prompt_tokens: data.usage.prompt_tokens || 0,
          completion_tokens: data.usage.completion_tokens || 0,
        } : undefined,
      };
      llmDeadline.dispose();
    }

    // Streaming path — parse SSE chunks and emit text.delta in real-time.
    // touch() on every chunk keeps the idle deadline honest; dispose() clears
    // the watchdog from parseStreamingResponse's finally.
    return this.parseStreamingResponse(response, sessionId, runId, llmDeadline.touch, llmDeadline.dispose);
  }

  private async parseStreamingResponse(
    response: Response,
    sessionId?: string,
    runId?: string,
    touch?: () => void,
    dispose?: () => void,
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

            try {
              const chunk = JSON.parse(data) as any;
              const choice = chunk.choices?.[0];
              if (!choice) continue;

              const delta = choice.delta;
              if (!delta) continue;
              if (choice.finish_reason) finishReason = choice.finish_reason;

              // Text content delta
              if (delta.content) {
                content += delta.content;
                if (sessionId && runId) {
                  this.eventEmitter.emitTextDelta(sessionId, runId, 'streaming', delta.content);
                }
              }

              // Reasoning/thinking delta ("Thought phase") — fields vary by
              // provider and usually arrive BEFORE content (DeepSeek
              // reasoning_content, OpenAI reasoning, Anthropic thinking,
              // Gemini thoughts via extra_content). Stream it live + keep it
              // for the final assistant message.
              const thought = this.extractThoughtDelta(delta);
              if (thought) {
                reasoning += thought;
                if (sessionId && runId) {
                  this.eventEmitter.emitTextThought(sessionId, runId, 'streaming', thought);
                }
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
        try {
          const chunk = JSON.parse(data) as any;
          const delta = chunk.choices?.[0]?.delta;
          if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
          if (!delta) continue;
          if (delta.content) content += delta.content;
          const thought = this.extractThoughtDelta(delta);
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

  /**
   * Extracts the reasoning/thinking text from a streaming `choice.delta`,
   * tolerating the field names used across providers:
   *   · DeepSeek / GLM / Qwen — `delta.reasoning_content`
   *   · OpenAI reasoning models — `delta.reasoning`
   *   · Anthropic-style (via OpenAI-compat proxies) — `delta.thinking`
   *   · Gemini 2.5/3 (openai-compat) — `delta.reasoning_content` or nested
   *     `extra_content.google.thinking`
   * Returns the concatenated text ('' when the chunk carries no reasoning).
   */
  private extractThoughtDelta(delta: any): string {
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

  /**
   * Normalizes an OpenAI-style `tool_calls` array (from a non-streaming
   * response) into the internal LLMToolCall shape. Preserves the Gemini 3.x
   * `thought_signature` so it can be echoed back on the follow-up assistant
   * message — without it the Gemini API rejects the request with a 400.
   */
  private normalizeToolCalls(rawCalls: any[]): LLMToolCall[] {
    if (!Array.isArray(rawCalls)) return [];
    return rawCalls.map((tc, i) => ({
      id: typeof tc?.id === 'string' && tc.id
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
    })).filter((tc) => tc.function.name.trim() !== '');
  }
}
