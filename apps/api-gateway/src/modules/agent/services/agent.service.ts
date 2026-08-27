import { Injectable, Logger, ConflictException, Inject } from '@nestjs/common';
import * as fsp from 'fs/promises';
import { AgentMessageService } from './agent-message.service';
import { AgentRunService } from './agent-run.service';
import { AgentSessionService } from './agent-session.service';
import { AgentPermissionService } from './agent-permission.service';
import { AgentEventEmitter } from './agent-event.emitter';
import { ToolRegistry } from '../tools/tool-registry';
import { ContextCompactionService } from './compaction.service';
import { enrichToolResult, ensureRunDirs } from './artifact-store';
import { WorkspaceIndex } from './workspace-index';
import { AgentConfigService } from './agent-config.service';
import { ApiKeysService } from '../../keys/api-keys.service';
import { ExplorerService } from './subagent.service';
import {
  AgentPhase,
  CHARS_PER_TOKEN,
  COMPACTION_INTERVAL,
  COMPACTION_THRESHOLD,
  CONTEXT_TOKEN_BUDGET,
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
  safeParseObject,
  snapshotToSystemMessage,
  toProviderMessages,
} from './run-context';
import { AgentMessage, ToolCallJson } from '../entities/agent-message.entity';
import { AgentState } from '../entities/agent-run.entity';
import { PermissionEffect } from '../entities/agent-permission.entity';

export interface AgentRunRequest {
  sessionId: string;
  userId: string;
  message: string;
  workspacePath: string;
  agentId: string;
  model?: string;
  provider?: string;
}

interface LLMToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface LLMResponse {
  content: string | null;
  tool_calls: LLMToolCall[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

const MAX_STEPS = 30;
const MAX_SAME_ERROR = 3;
const MAX_SAME_TOOL_CALLS = 4;

/** Consecutive text-only responses tolerated before ending the run gracefully. */
const MAX_NO_TOOL_STREAK = 3;

/**
 * When this many consecutive tool calls belong to SEARCH_FAMILY_TOOLS,
 * the model is stuck "looking for something" and must be nudged to act.
 * Catches varied args / alternating search tools that the exact-match
 * doom loop guard misses.
 */
const SEARCH_FAMILY_LOOP_THRESHOLD = 4;

/** Transient LLM/provider failures worth an automatic retry. */
const MAX_LLM_RETRIES = 3;
const RETRYABLE_LLM_ERROR =
  /timeout|etimedout|econnreset|econnrefused|socket hang up|rate.?limit|too many requests|bad gateway|service unavailable|internal server error|overloaded|server error|\b5\d\d\b/i;

/** Same tool + same args N times consecutively → doom loop. */
const DOOM_LOOP_THRESHOLD = 2;

/** Per-file mutation cap for the whole run. */
const FILE_MUTATION_LIMIT = 6;

/** Providers that stream deltas through parseStreamingResponse (text already emitted live). */
const STREAMING_PROVIDERS = new Set(['openai', 'openrouter', 'nvidia', 'xai', 'gemini']);

/** Per-turn guard bookkeeping shared by the tool executors. */
interface RunGuards {
  errorHistory: string[];
  toolCallCounts: Map<string, number>;
  recentToolCalls: Array<{ name: string; args: string }>;
  recentToolResults: Array<{ name: string; success: boolean; output: string }>;
  postMutationReads: Map<string, number>;
  fileMutationCounts: Map<string, number>;
  noToolStreak: number;
  /** Consecutive calls to search/list tools — resets on any non-search call. */
  searchFamilyStreak: number;
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
    const { sessionId, userId, message, workspacePath, agentId, model, provider } = request;

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
    this.activeSessionRuns.set(sessionId, run.id);

    this.eventEmitter.emitRunStarted(sessionId, run.id, agentId || 'build');

    await this.messageService.create(sessionId, 'user', message);

    this.executeAgentRun(sessionId, run.id, userId, message, workspacePath, agentId || 'build', model, provider).catch((err) => {
      this.logger.error(`Agent run failed: ${err.message}`);
      this.eventEmitter.emitRunFailed(sessionId, run.id, err.message);
      this.activeRuns.delete(sessionId);
      this.activeSessionRuns.delete(sessionId);
    });

    return { status: 'started', sessionId };
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
      task: message,
      abortController,
    });

    // Create the structured artifact directory tree for this run.
    ensureRunDirs(workspacePath, runId).catch((err) =>
      this.logger.warn(`Failed to create run directories: ${err}`),
    );

    // Build/refresh the workspace index for fast symbol lookup.
    this.workspaceIndex.build(workspacePath).catch((err) =>
      this.logger.warn(`WorkspaceIndex build failed: ${err}`),
    );

    // Emit initial agent state for the UI timeline.
    this.eventEmitter.emitAgentState(sessionId, runId, 'understanding', 'active', phaseDirective('understand') ?? undefined);

    const guards: RunGuards = {
      errorHistory: [],
      toolCallCounts: new Map(),
      recentToolCalls: [],
      recentToolResults: [],
      postMutationReads: new Map(),
      fileMutationCounts: new Map(),
      noToolStreak: 0,
      searchFamilyStreak: 0,
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
        // to this LLM call only and must not leak into future context.
        const extra: LLMMessage[] = [];
        const stepsLeft = MAX_STEPS - step - 1;
        if (stepsLeft === 3 || stepsLeft === 1) {
          extra.push({
            role: 'system',
            content: `STEP BUDGET: only ${stepsLeft} step(s) remain in this run. Do not start new work or modify files again. Output your final summary NOW.`,
          });
        }

        // Phase directive: the runner owns the workflow, so every call tells
        // the model which phase it is in and what that phase expects.
        const directive = phaseDirective(ctx.phase);
        if (directive) extra.push({ role: 'system', content: directive });

        // Tool groups: task classification ∪ current phase — exposure only grows,
        // so a model that needs an "out of phase" tool is never dead-ended.
        for (const toolName of PHASE_TOOLS[ctx.phase]) ctx.exposedTools.add(toolName);
        const tools = this.toolRegistry.getDefinitions(ctx.exposedTools);

        let response: LLMResponse;
        try {
          this.eventEmitter.emitLlmThinking(sessionId, runId, step + 1);
          this.eventEmitter.emitAgentState(sessionId, runId, ctx.phase, 'active', 'Thinking…');
          response = await this.callLLMWithRetry([...ctx.messages, ...extra], tools, provider, model, sessionId, runId, ctx.userId);
          this.logger.debug(`LLM response: content=${(response.content || '').slice(0, 100)} tool_calls=${response.tool_calls?.length || 0} usage=${JSON.stringify(response.usage)}`);
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

        // Parse inline text-format tool calls once (Qwen/GLM/DeepSeek house styles)
        const inlineParsed = response.tool_calls?.length
          ? { calls: [] as Array<{ id: string; function: { name: string; arguments: string } }>, cleaned: response.content || '' }
          : this.extractInlineToolCalls(response.content);

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

          // Emit executing state with tool names for the UI.
          const toolNames = calls.map((c) => c.function.name).join(', ');
          this.eventEmitter.emitAgentState(sessionId, runId, ctx.phase, 'active', `Running ${toolNames}`);

          // ONE assistant message carrying content + all tool calls.
          const assistantMsg = await this.appendAssistantMessage(ctx, response.content || '', calls.map((tc) => ({
            id: tc.id,
            toolName: tc.function.name,
            arguments: safeParseObject(tc.function.arguments),
            status: 'queued' as ToolCallJson['status'],
          })));

          if (sourceIsStructured) {
            if (response.content && !STREAMING_PROVIDERS.has(provider || '')) {
              this.eventEmitter.emitTextDelta(sessionId, runId, assistantMsg.id, response.content);
            }
            this.eventEmitter.emitTextEnd(sessionId, runId, assistantMsg.id, response.content || '', assistantMsg.toolCalls || undefined);
          }

          await this.executeToolCalls(ctx, assistantMsg, calls, guards, { agentId, userId });

          const agentState = buildAgentState(ctx);
          await this.runService.saveAgentState(runId, agentState, ctx.workspacePath);
          this.eventEmitter.emitStepEnded(sessionId, runId, step + 1);
          continue;
        }

        // ── Text-only turn ────────────────────────────────────────────────
        this.eventEmitter.emitStepEnded(sessionId, runId, step + 1);

        if (response.content) {
          const assistantMsg = await this.appendAssistantMessage(ctx, response.content, undefined, response.usage);
          if (!STREAMING_PROVIDERS.has(provider || '')) {
            this.eventEmitter.emitTextDelta(sessionId, runId, assistantMsg.id, response.content);
          }
          this.eventEmitter.emitTextEnd(sessionId, runId, assistantMsg.id, response.content);
        }

        // Completion is detected from VERIFICATION tool results, not agent prose.
        const recentCmdSuccesses = guards.recentToolResults.filter((r) => r.success && r.name === 'run_command');
        const hasText = !!response.content && response.content.trim().length > 20;
        if (step > 2 && recentCmdSuccesses.length >= 1 && hasText) {
          this.logger.log(`Task completion detected at step ${step + 1} (verification-based)`);
          await this.finalizeRunSuccess(ctx, sessionId, runId);
          return;
        }

        guards.noToolStreak++;
        if (step > 0 && step < MAX_STEPS - 1) {
          if (guards.noToolStreak >= MAX_NO_TOOL_STREAK) {
            this.logger.warn(`No-tool streak hit ${guards.noToolStreak} at step ${step + 1} — finalizing run`);
            await this.appendAssistantMessage(ctx,
              (response.content || '') +
              '\n\n---\n*Stopping here: I responded without tool calls several times in a row. Progress so far is preserved above — send a follow-up message to continue.*');
            await this.finalizeRunSuccess(ctx, sessionId, runId);
            return;
          }
          await this.appendSystemNote(ctx,
            'You must use tools to complete the task. Do not just describe what you would do — actually do it. Use read_file, edit_file, write_file, run_command, apply_patch, or other tools to make real changes. Continue with the next tool call now.');
          continue;
        }

        await this.finalizeRunSuccess(ctx, sessionId, runId);
        return;
      }

      await this.finalizeRunSuccess(ctx, sessionId, runId);
    } finally {
      this.activeRuns.delete(sessionId);
      this.activeSessionRuns.delete(sessionId);
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
    task: string;
    abortController: AbortController;
  }): Promise<RunContext> {
    const session = await this.sessionService.findOne(args.sessionId).catch((): null => null);
    const prevSnapshot = ((session?.contextSnapshot ?? null) as unknown as ContextSnapshot | null) || createEmptySnapshot(args.task);

    const rows = await this.messageService.findBySession(args.sessionId, RUN_HISTORY_LIMIT);
    // Rows folded into the snapshot are excluded; everything after them replays.
    const covered = Math.min(prevSnapshot.coveredMessages || 0, Math.max(0, rows.length - 1));
    const replay = covered > 0 ? rows.slice(covered) : rows;

    const messages: LLMMessage[] = [{ role: 'system', content: await this.getSystemPrompt(args.agentId, args.workspacePath) }];
    const snapMsg = snapshotToSystemMessage(prevSnapshot);
    if (snapMsg) messages.push(snapMsg);
    messages.push(...this.replayHistoryToMessages(replay));

    // Warm the permission rules cache so the first tool call never blocks on
    // the DB (evaluate() is otherwise hit once per tool call).
    await this.permissionService.preload(args.userId, args.workspacePath).catch((err) =>
      this.logger.warn(`Permission preload failed (continuing uncached): ${err}`),
    );

    return {
      sessionId: args.sessionId,
      runId: args.runId,
      userId: args.userId,
      workspacePath: args.workspacePath,
      agentId: args.agentId,
      provider: args.provider,
      model: args.model,
      task: args.task,
      snapshot: prevSnapshot,
      messages,
      filesRead: new Set(prevSnapshot.filesRead),
      filesModified: new Set(prevSnapshot.filesModified),
      observations: [],
      plan: [],
      currentStep: 0,
      tokenBudget: CONTEXT_TOKEN_BUDGET,
      inputTokens: 0,
      outputTokens: 0,
      abortController: args.abortController,
      exposedTools: resolveExposedTools(classifyTaskGroups(args.task, args.agentId)),
      phase: initialPhase(),
      lastToolCalls: [],
      lastCompactTokens: estimateTokens(messages),
    };
  }

  /**
   * Converts persisted rows into LLM messages. Every assistant tool_call is
   * guaranteed a matching tool result — dangling calls are synthesized, so
   * providers never reject the transcript and local models never lose the
   * call→result pairing (the root cause of repeated/hallucinated tool calls).
   */
  private replayHistoryToMessages(rows: AgentMessage[]): LLMMessage[] {
    const out: LLMMessage[] = [];
    const toolByParent = new Map<string, AgentMessage[]>();
    for (const msg of rows) {
      if (msg.role === 'tool' && msg.parentMessageId) {
        const list = toolByParent.get(msg.parentMessageId) || [];
        list.push(msg);
        toolByParent.set(msg.parentMessageId, list);
      }
    }

    for (const msg of rows) {
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

    return out;
  }

  private async appendAssistantMessage(
    ctx: RunContext,
    content: string,
    toolCalls?: ToolCallJson[],
    usage?: { prompt_tokens: number; completion_tokens: number },
  ): Promise<AgentMessage> {
    const msg = await this.messageService.create(ctx.sessionId, 'assistant', content, {
      toolCalls,
      tokensInput: usage?.prompt_tokens || 0,
      tokensOutput: usage?.completion_tokens || 0,
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
    ctx.messages.push({ role: 'system', content });
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
    // 2. Absolute per-tool cap.
    if ((guards.toolCallCounts.get(toolName) || 0) + 1 >= MAX_SAME_TOOL_CALLS) {
      return true;
    }
    // 3. Search-family flooding: too many search/list/read tools in a row
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

    const count = (guards.toolCallCounts.get(toolName) || 0) + 1;
    guards.toolCallCounts.set(toolName, count);

    // Search-family streak: increment for search/list/read, reset on anything else.
    if (SEARCH_FAMILY_TOOLS.has(toolName)) {
      guards.searchFamilyStreak++;
    } else {
      guards.searchFamilyStreak = 0;
    }

    // Doom loop detection: same tool + same args N times consecutively.
    const argsKey = JSON.stringify(toolArgs);
    guards.recentToolCalls.push({ name: toolName, args: argsKey });
    if (guards.recentToolCalls.length > 5) guards.recentToolCalls.shift();
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

    if (count >= MAX_SAME_TOOL_CALLS) {
      const otherTools = Array.from(guards.toolCallCounts.keys()).filter(
        (t) => t !== toolName && (guards.toolCallCounts.get(t) || 0) > 0,
      );
      if (otherTools.length > 0) {
        guards.toolCallCounts.set(toolName, 0);
      } else {
        const skipMsg = `SKIPPED ${toolName}: usage cap reached (${MAX_SAME_TOOL_CALLS} calls this run). Switch tools or finalize.`;
        turnNotes.push(`Tool "${toolName}" called ${MAX_SAME_TOOL_CALLS} times consecutively. Try a different tool or approach.`);
        this.eventEmitter.emitToolStarted(sessionId, runId, toolCallId, toolName, toolArgs);
        this.eventEmitter.emitToolFailed(sessionId, runId, toolCallId, skipMsg);
        await this.appendToolResult(ctx, assistantMsg.id, toolCallId, skipMsg);
        await this.persistToolStatus(assistantMsg, toolCallId, 'failed', skipMsg);
        return;
      }
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

    // Deterministic phase advance from the OBSERVED action (skipped calls —
    // doom loop / usage cap above — never reach this, so they don't count).
    this.setPhase(ctx, nextPhaseOnCall(ctx.phase, toolName));

    this.eventEmitter.emitToolStarted(sessionId, runId, toolCallId, toolName, toolArgs);

    if (ctx.abortController.signal.aborted) {
      await this.appendToolResult(ctx, assistantMsg.id, toolCallId, `CANCELLED ${toolName}: the run was interrupted before execution.`);
      this.eventEmitter.emitToolFailed(sessionId, runId, toolCallId, 'Cancelled by user');
      await this.persistToolStatus(assistantMsg, toolCallId, 'failed', 'Cancelled by user');
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
    if (permission === 'deny') {
      const denyMsg = `Tool "${toolName}" was denied by permissions.`;
      await this.appendToolResult(ctx, assistantMsg.id, toolCallId, denyMsg);
      this.eventEmitter.emitToolFailed(sessionId, runId, toolCallId, 'Permission denied');
      await this.persistToolStatus(assistantMsg, toolCallId, 'failed', denyMsg);
      return;
    }

    if (permission === 'ask') {
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
    const toolTimeout = AbortSignal.timeout(60_000);
    const combinedSignal = ctx.abortController.signal.aborted
      ? ctx.abortController.signal
      : AbortSignal.any([ctx.abortController.signal, toolTimeout]);
    const result = await this.toolRegistry.execute(toolName, toolArgs, {
      workspaceDir: ctx.workspacePath,
      workspacePath: ctx.workspacePath,
      sessionId,
      runId,
      userId: ids.userId,
      abortSignal: combinedSignal,
      workspaceIndex: this.workspaceIndex,
    });

    try {
      this.applyMutationBookkeeping(toolName, toolArgs, result, guards.fileMutationCounts);

      // Structured-result contract at the single choke point: duration stamping,
      // oversized-output spill to .smoke/runs/<runId>/ artifacts (works for every
      // tool, converted or not), summary backfill.
      await enrichToolResult(toolName, result, { workspacePath: ctx.workspacePath, runId, startedAt });

      // Phase advance from the RESULT: verification failures demote VERIFY → RECOVER.
      const failed =
        result.isError === true ||
        (typeof result.metadata?.exitCode === 'number' && result.metadata.exitCode !== 0);
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
    }

    if (toolName === 'read_file' && result.metadata?.path) {
      ctx.filesRead.add(String(result.metadata.path));
    }
    if (['write_file', 'apply_patch', 'delete_file'].includes(toolName) && result.metadata?.path) {
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
    await this.runService.updateStatus(runId, 'interrupted');
    await this.sessionService.updateStatus(sessionId, 'interrupted');
    this.eventEmitter.emitRunInterrupted(sessionId, runId, 'user_interrupt');
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
   */
  private async maybeCompact(ctx: RunContext): Promise<void> {
    const est = estimateTokens(ctx.messages);
    const overBudget = est > ctx.tokenBudget * COMPACTION_THRESHOLD;
    const intervalDue = ctx.currentStep > 0 && ctx.currentStep % COMPACTION_INTERVAL === 0;
    if (!overBudget && !intervalDue) return;
    // Don't pay for an LLM summarize when little changed since the last one.
    if (!overBudget && est < Math.max(ctx.lastCompactTokens, 1) * 1.15) return;
    if (ctx.messages.length < KEEP_RECENT_MESSAGES + 6) return;

    this.eventEmitter.emitRun(ctx.sessionId, ctx.runId, 'compacting', {});
    await this.runService.updateStatus(ctx.runId, 'compacting');
    let result;
    try {
      result = await this.compactionService.compactRunContext({
        sessionId: ctx.sessionId,
        messages: ctx.messages,
        provider: ctx.provider,
        model: ctx.model,
        userId: ctx.userId,
      });
    } finally {
      await this.runService.updateStatus(ctx.runId, 'executing_tool');
    }

    ctx.lastCompactTokens = est;
    if (!result) return;

    // Merge what this run learned into the durable snapshot. cutIndex counts
    // synthetic leading entries (system prompt / snapshot block) that have no
    // DB row, so only the delta maps onto persisted-message coverage.
    const snapshot = ctx.snapshot;
    let leadingSynthetic = 0;
    for (const m of ctx.messages) {
      if (m.role === 'system') leadingSynthetic++;
      else break;
    }
    const newlyCoveredRows = Math.max(0, result.cutIndex - leadingSynthetic);
    snapshot.summary = snapshot.summary ? `${snapshot.summary}\n\n---\n\n${result.summary}` : result.summary;
    snapshot.coveredMessages += newlyCoveredRows;
    snapshot.filesRead = [...new Set([...snapshot.filesRead, ...ctx.filesRead])].slice(0, 200);
    snapshot.filesModified = [...new Set([...snapshot.filesModified, ...ctx.filesModified])];
    snapshot.task = ctx.task;

    // Rewrite the live conversation: SYSTEM + SNAPSHOT + kept recent tail.
    const leading = result.kept[0]?.role === 'system' ? result.kept.slice(0, 1) : [];
    const snapMsg = snapshotToSystemMessage(snapshot);
    ctx.messages = [...leading, ...(snapMsg ? [snapMsg] : []), ...result.kept.slice(leading.length)];
    ctx.lastCompactTokens = estimateTokens(ctx.messages);
    ctx.observations.push(`Context compacted: saved ~${result.tokensSaved} tokens`);

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
    const path = typeof toolArgs.path === 'string' ? toolArgs.path : '';
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
  ): void {
    if (result.isError || !result.output || !AgentService.MUTATING_TOOLS.has(toolName)) return;
    const path = typeof toolArgs.path === 'string' ? toolArgs.path : '';
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

  private static readonly MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch']);

  private firstErrorLine(output: string): string {
    const line = output.split('\n').find((l) => l.trim().length > 0) || 'Tool failed';
    return line.slice(0, 200);
  }

  private async getSystemPrompt(agentId: string, workspacePath?: string): Promise<string> {
    const env = `You are powered by an AI coding agent. Here is some useful information about the environment you are running in:
<env>
  Workspace root: ${workspacePath || process.cwd()}
  Platform: darwin
  Today's date: ${new Date().toDateString()}
</env>`;

    const base = `${env}

You are an AI coding agent. You have access to tools for reading/writing files, running commands, and searching code.

## CRITICAL RULES — VIOLATION = IMMEDIATE FAILURE

### 1. NEVER RE-READ — YOU WILL BE BLOCKED
- If you already read a file, you have its content. NEVER call read_file on the same path again unless the file was modified by another tool.
- NEVER read the same file with different line ranges (e.g., lines 1-300 then 301-600). You already have the content — use it.
- If you called read_file on a path, that is your LAST read of that path. Act on the content.
- VIOLATION: Reading the same file 2+ times = loop detected = your tools will be blocked.

### 2. ACT AFTER EVERY READ — NO EXCEPTIONS
- After ANY read_file call, your NEXT tool call MUST be edit_file, write_file, run_command, or a DIFFERENT tool.
- NEVER follow read_file with another read_file. This is the #1 failure mode.
- "Let me check one more thing..." → WRONG. You have enough context. ACT.
- "Now I'll read the other half..." → WRONG. You already read it. Use what you have.

### 3. EVERY RESPONSE MUST USE TOOLS
- NEVER describe what you "would do" or "will do". Actually DO it by calling a tool.
- Every response MUST contain at least one tool_call.
- "Let me read the file..." → WRONG. Instead, call read_file RIGHT NOW.
- "Now I'll fix the bug..." → WRONG. Instead, call edit_file RIGHT NOW.
- If you complete one step, IMMEDIATELY proceed to the next. Do not stop and summarize mid-task.

### 3. BATCH OPERATIONS
- If you need to read 3 files, call read_file 3 times in ONE response (parallel tool calls).
- If you need to create a file and then run a command, do both in sequence without unnecessary reads in between.
- Check the [exit code: N] marker on EVERY run_command result and investigate failures before moving on. Non-zero exits are reported as data, not tool failures.
- Prefer dedicated tools over shell text-mangling: edit_file/write_file instead of sed/awk/echo redirection; grep/glob/find_symbol instead of shelling out to find/rg.

### 4. SEARCH PATTERNS — READ ONCE, THEN ACT
- Use grep to find the line number. Then read_file ONCE at that line range. Then edit.
- If you need context from multiple files, read them ALL in ONE response (parallel calls).
- NEVER read a file "to check" or "to confirm" — you already have the content.
- After 3+ search/read calls with no edit or command, you MUST take action. Stop searching.

### 4. LONG-RUNNING PROCESSES — USE BACKGROUND
- Servers, watchers, dev servers → ALWAYS use run_command with background=true
- NEVER run "node server.js" or "npm run dev" in the foreground — it will timeout and fail.
- Pattern: run_command(command="node server.js", background=true) → returns PID immediately with a log path; check output by reading that log file.
- To pass env vars: use the env parameter, e.g. run_command(command="node server.js", background=true, env={"PORT":"3003"})
- To verify a server started: run_command(command="sleep 2 && curl -s http://localhost:PORT/")
- If a command prints "[timed out after ...]", it was killed at the timeout: captured output is still shown below the marker — read it before retrying differently. Never just increase the timeout blindly; switch long-running processes to background=true.

### 5. UNDERSTAND BEFORE YOU CODE
- Before making changes, read the relevant files to understand the codebase structure.
- Then plan your approach mentally. Then execute.
- Do not blindly edit files without understanding what they contain.

### 6. WHEN TO STOP
- After verifying the task is complete (tests pass, server runs, code is correct), STOP.
- Provide a brief final summary only at the very end.
- DO NOT kill servers or processes you started — leave them running.
- If you see "Tool called N times. Possible loop detected." → STOP and summarize.
- If you see "You must use tools" → you responded with text-only. Call a tool in your NEXT response.
- If you see "SKIPPED" or "loop detected" in a tool result → you are in a loop. STOP searching and take action with a DIFFERENT tool type (edit_file, write_file, run_command).

### 7. FILE EDITING PROTOCOL
- NEVER edit_file, write_file, apply_patch or delete_file on a file you have not read in this session — the harness rejects it ("has not been read in this session yet"). read_file first, always.
- If a result says "changed since it was last read", the file was modified after your read. read_file it again, then retry against the CURRENT content.
- Copy oldString EXACTLY from read_file output — same characters, same indentation, no paraphrasing, no line-number prefixes. The match is literal and byte-exact.
- Use the smallest oldString that is still unique in the file (2–5 lines is usually enough). Add surrounding lines only to disambiguate.
- Multiple matches are rejected: widen the context, or pass replaceAll only when you truly want every occurrence replaced.
- When an error shows "Closest matching region ... copy your oldString EXACTLY from this text", use that text as your next oldString.
- Prefer edit_file over write_file for existing files; write_file replaces the ENTIRE file.
- A successful edit_file result includes a diff — that IS your verification. Do NOT read_file the file again after an accepted edit.

### 8. LARGE FILE EDITS (docs, long sources)
- NEVER scan or page through a large file end-to-end. This is the #1 loop trigger.
- LOCATE first: grep a unique phrase → note the line number → read ONLY that region (50 lines max).
- Complete most changes in ONE locate → targeted-read → edit cycle.
- Repeatedly re-reading the same file = your tools WILL be blocked.
- If an edit fails, fix it from the "Closest matching region" in the error — do NOT re-read the whole file.

### 9. ERROR RECOVERY
- A tool result starting with "Error:" means the operation DID NOT happen. Never treat it as done or continue as if it succeeded.
- Never repeat the exact same tool call with the exact same arguments after a failure — change something first (re-read, adjust arguments).
- If a tool result says "[output truncated ... full output saved to <path>]", use read_file on that path to inspect details you need.
- If a tool call fails, read the error message carefully. Fix the root cause, don't retry blindly.
- If edit_file says "oldString not found", re-read the file to get the current content, then retry with the correct text.
- If run_command times out and the process is a server, re-run with background=true.

## Tool Reference
- read_file: Read file contents or list directories. Use offset/limit for large files.
- edit_file: Find-and-replace in existing files. Requires exact oldString match. Read the file first.
- write_file: Create new files or completely overwrite existing ones.
- apply_patch: Multi-file changes via unified diff.
- run_command: Shell commands. Use background=true for servers. Use env={} for env vars. Default timeout 120s.
- grep: Search file contents with regex. Returns file:lineNum|content format with optional context.
- glob: Find files by pattern (e.g. "**/*.ts").
- find_symbol: Locate class/function/interface definitions. Returns symbol source with line numbers.
- search_code: Code pattern search with context lines.
- todo_write: Track multi-step task progress.

## CODE READING PROTOCOL
All code-reading tools return LINE-NUMBERED output with FILE HASH for safe editing.

### Workflow (MUST follow this order):
1. grep/search_code → find the line number of your target
2. read_file(path, startLine=N-10, endLine=N+20) → load EXACT region with line numbers (ONE read only)
3. edit_file/apply_patch → modify the code (validates file hash hasn't changed)

### STRICT RULES:
- You get ONE read_file per path per task. Make it count.
- After reading, you MUST edit or run a command. NEVER read again.
- If you need multiple regions of the same file, read the LARGEST region first (covers all needed lines).

### Output format:
- read_file returns: FILE, HASH, LINES, then line-numbered content (e.g. "35 | async logout() {...}")
- grep returns: FILE:lineNum|matching line, with optional context lines
- find_symbol returns: Symbol name, FILE, LINES, HASH, then source code
- edit_file/apply_patch return: HASH of the modified file

### Stale detection:
Every read_file includes a HASH. edit_file checks this hash before applying.
If the file changed since you read it, edit_file rejects the edit and asks you to re-read.
Always use the HASH from your most recent read_file when editing.

## AGENTIC MODEL SELECTION
The system supports 15+ models optimized for agentic coding:

### Tier 1 — Best for complex multi-step coding:
- anthropic/claude-sonnet-4.6: Best tool-calling reliability, excellent code quality
- anthropic/claude-opus-4.6: Highest quality, for critical/sensitive code
- openai/gpt-5.6-luna-pro: OpenAI flagship with extended reasoning
- openai/gpt-5.6-luna: Fast, excellent tool-calling and code quality

### Tier 2 — Strong all-round coding:
- google/gemini-3.7-flash: Fastest with solid tool-calling
- x-ai/grok-4.6: Fast, sharp reasoning
- qwen/qwen3-coder: Specialized for code generation
- deepseek/deepseek-v4-pro: Strong coding at lower cost

### Tier 3 — NVIDIA / efficiency:
- nvidia/nemotron-3-ultra-550b-a55b: Maximum quality
- nvidia/nemotron-3-super-120b-a12b: Great quality/cost balance
- nvidia/nemotron-3-nano-30b-a3b: Low latency

### Tier 4 — Free / local:
- deepseek-v4-flash-free: Best free option
- qwen3:32b (local): Best local model (24GB+ VRAM)
- qwen3:8b (local): Fast local, limited reasoning

All models use OpenAI-compatible tool calling format.`;

    // Append project-specific instructions from .agent/ if they exist.
    let projectContext = '';
    if (workspacePath) {
      try {
        const configMsg = await this.agentConfigService.toSystemMessage(workspacePath);
        if (configMsg) projectContext = '\n\n' + configMsg;
      } catch {
        // .agent/ doesn't exist or is malformed — continue without it.
      }
    }

    switch (agentId) {
      case 'build':
        return `${base}${projectContext}

## Mode: Build
You have FULL access to read, write, run commands, and git.
- Read files before editing. Then edit immediately.
- Run tests/verification after changes.
- Make minimal, surgical changes — edit_file over write_file for existing code.
- Complete ALL parts of a task before finishing.
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

    // Tie the request to the run's abort signal so interrupt() cancels an
    // in-flight LLM call immediately instead of waiting for the next step.
    const activeController = sessionId ? this.activeRuns.get(sessionId) : undefined;
    const timeoutSignal = AbortSignal.timeout(120_000);
    const signal = activeController ? AbortSignal.any([activeController.signal, timeoutSignal]) : timeoutSignal;

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => 'Unknown error');
      const err = new Error(`LLM API error (${response.status}): ${errText.slice(0, 500)}`) as Error & { status?: number };
      err.status = response.status;
      throw err;
    }

    // Non-streaming path (ollama or fallback)
    if (!useStreaming) {
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
        return {
          content: msg?.content || null,
          tool_calls,
          usage: data.prompt_eval_count ? {
            prompt_tokens: data.prompt_eval_count || 0,
            completion_tokens: data.eval_count || 0,
          } : undefined,
        };
      }
      const choice = data.choices?.[0];
      return {
        content: choice?.message?.content || null,
        tool_calls: choice?.message?.tool_calls || [],
        usage: data.usage ? {
          prompt_tokens: data.usage.prompt_tokens || 0,
          completion_tokens: data.usage.completion_tokens || 0,
        } : undefined,
      };
    }

    // Streaming path — parse SSE chunks and emit text.delta in real-time
    return this.parseStreamingResponse(response, sessionId, runId);
  }

  private async parseStreamingResponse(
    response: Response,
    sessionId?: string,
    runId?: string,
  ): Promise<LLMResponse> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    const toolCalls: LLMToolCall[] = [];
    let usage: { prompt_tokens: number; completion_tokens: number } | undefined;
    const toolCallBuffers = new Map<number, { id: string; name: string; arguments: string }>();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

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

              // Text content delta
              if (delta.content) {
                content += delta.content;
                if (sessionId && runId) {
                  this.eventEmitter.emitTextDelta(sessionId, runId, 'streaming', delta.content);
                }
              }

              // Tool call deltas (incremental argument building)
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  if (!toolCallBuffers.has(idx)) {
                    toolCallBuffers.set(idx, { id: '', name: '', arguments: '' });
                  }
                  const buf = toolCallBuffers.get(idx)!;
                  if (tc.id) buf.id = tc.id;
                  if (tc.function?.name) buf.name += tc.function.name;
                  if (tc.function?.arguments) buf.arguments += tc.function.arguments;
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
      reader.releaseLock();
    }

    // Convert tool call buffers to final format
    for (const [, buf] of toolCallBuffers) {
      if (buf.name) {
        toolCalls.push({
          id: buf.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          type: 'function',
          function: {
            name: buf.name.trim(),
            arguments: buf.arguments || '{}',
          },
        });
      }
    }

    // Note: text.end is emitted by runAgentLoop after callLLM returns, not here

    return {
      content: content || null,
      tool_calls: toolCalls,
      usage,
    };
  }
}
