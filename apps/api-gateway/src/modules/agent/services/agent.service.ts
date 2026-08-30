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
  resolveTokenBudget,
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
}

const MAX_STEPS = 1000;
const MAX_SAME_ERROR = 3;
const MAX_SAME_TOOL_CALLS = 10;

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

/** Matches a run_command ARGS JSON string whose command is a verification step. */
const VERIFICATION_COMMAND_RE =
  /\b(tsc|typecheck|lint)\b|--noEmit|\b(?:jest|vitest|pytest|mocha|rspec)\b|(?:^|[;&|(){}\[\]:,"\s]+)(?:pnpm|npm|yarn|bun|npx)\s+(?:exec\s+|run\s+)?(?:test|tests|lint|typecheck|build|check)(?:["'`,;{}|)\s]|$)|(?:^|[;&|(){}\[\]:,"\s]+)cargo\s+(?:test|check|build)(?:["'`,;{}|)\s]|$)|(?:^|[;&|(){}\[\]:,"\s]+)(?:go|python|python3)\s+(?:test\b|.*-m\s+test\b)|git\s+diff\s+--check|curl.{0,120}\b(?:health|ready)\b/i;

/**
 * Prose that reads like an explicit final report rather than mid-task narration.
 * Report-style bullet labels from the agent's own "Final response" section.
 */
const FINAL_REPORT_RE =
  /(^|\n)[ \t]*[-*•]?[ \t]*(Changed|Verified|Result|Summary|Done|Status)[ \t]*:|TASK (COMPLETE|COMPLETED)|completed successfully|verification (passed|green)|all checks (passed|green)/im;

/**
 * Prose that hands control back to the user instead of finishing the work
 * ("which do you prefer?", "let me know how to proceed", trailing "?"). Such a
 * turn is NOT a completion — smoke monkey must pick the reasonable default and
 * keep going; asking the user is reserved for ask_user and true blockers.
 */
const USER_DEFER_RE =
  /\b(let me know|which (one|option|approach)[^.\n]{0,60}prefer|do you want (me|us)|would you like (me|us)|should i\b|want me to|prefer that i|shall i\b|can you please|please (confirm|advise|tell me|let me know)|how (should|would|do) you (like|want) ?(me|us) to)\b|\?{1,3}[ \t]*$/im;

/**
 * How many consecutive empty responses we tolerate BEFORE killing a run.
 * When the run has already produced tool work, tolerate far more — a provider
 * hiccup shouldn't throw away a productive build.
 */
const MAX_EMPTY_RETRIES_WITH_PROGRESS = 10;

/**
 * When this many consecutive tool calls belong to SEARCH_FAMILY_TOOLS,
 * the model is stuck "looking for something" and must be nudged to act.
 * Catches varied args / alternating search tools that the exact-match
 * doom loop guard misses.
 */
const SEARCH_FAMILY_LOOP_THRESHOLD = 10;

/** Transient LLM/provider failures worth an automatic retry. */
const MAX_LLM_RETRIES = 3;
const RETRYABLE_LLM_ERROR =
  /timeout|etimedout|econnreset|econnrefused|socket hang up|rate.?limit|too many requests|bad gateway|service unavailable|internal server error|overloaded|server error|\b5\d\d\b/i;

/** Same tool + same args N times consecutively → doom loop. */
const DOOM_LOOP_THRESHOLD = 10;

/**
 * When a tool or command returns the byte-identical output this many times in a
 * row, the model is making no forward progress. Stop rather than spin forever.
 */
const SAME_OUTPUT_THRESHOLD = 10;

/** Per-file mutation cap for the whole run. */
const FILE_MUTATION_LIMIT = 20;

/** Providers that stream deltas through parseStreamingResponse (text already emitted live). */
const STREAMING_PROVIDERS = new Set(['openai', 'openrouter', 'nvidia', 'xai', 'gemini', 'opencode']);

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
    this.activeSessionRuns.set(sessionId, run.id);

    this.eventEmitter.emitRunStarted(sessionId, run.id, agentId || 'build');

    await this.messageService.create(sessionId, 'user', message);

    this.executeAgentRun(sessionId, run.id, userId, message, workspacePath, agentId || 'build', model, provider, remoteProfileId).catch((err) => {
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
        const tools = this.toolRegistry.getDefinitions(ctx.exposedTools);

        let response: LLMResponse;
        try {
          this.eventEmitter.emitLlmThinking(sessionId, runId, step + 1);
          this.eventEmitter.emitAgentState(sessionId, runId, ctx.phase, 'active', 'Thinking…');
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
            ...((tc as LLMToolCall).thought_signature ? { thought_signature: (tc as LLMToolCall).thought_signature } : {}),
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
          await this.appendSystemNote(ctx,
            'The model returned an empty response. Respond now. If you have completed the task, give your final summary. ' +
            'Otherwise call a tool (read_file, edit_file, write_file, run_command) to keep making progress.');
          continue;
        }
        guards.emptyStreak = 0;

        // ── Text-only turn ────────────────────────────────────────────────
        this.eventEmitter.emitStepEnded(sessionId, runId, step + 1);

        if (response.content) {
          const assistantMsg = await this.appendAssistantMessage(ctx, response.content, undefined, response.usage);
          if (!STREAMING_PROVIDERS.has(provider || '')) {
            this.eventEmitter.emitTextDelta(sessionId, runId, assistantMsg.id, response.content);
          }
          this.eventEmitter.emitTextEnd(sessionId, runId, assistantMsg.id, response.content);
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
        const deferredToUser = USER_DEFER_RE.test(content);
        const finalReport = FINAL_REPORT_RE.test(content);
        const verificationPassed = guards.recentToolResults.some(
          (r) => r.success && VERIFICATION_TOOLS.has(r.name),
        ) || guards.recentToolCalls.some(
          (tc) => tc.name === 'run_command' && VERIFICATION_COMMAND_RE.test(tc.args || ''),
        );
        if (step > 2 && verificationPassed && finalReport && !deferredToUser) {
          this.logger.log(`Task completion detected at step ${step + 1} (verification + final report)`);
          await this.finalizeRunSuccess(ctx, sessionId, runId);
          return;
        }

        // Deferral guard: if the agent tries to hand control back to the user
        // ("which do you prefer?", "let me know how to proceed", a bare "?")
        // instead of completing the requested work, keep the run alive and push
        // it to pick the reasonable default and continue. This is the runaway
        // cause of "agent stops early" — the model narrates progress, then asks
        // instead of acting.
        if (deferredToUser) {
          guards.noToolStreak++;
          if (step > 2 && step < MAX_STEPS - 1) {
            if (guards.noToolStreak >= MAX_NO_TOOL_STREAK) {
              this.logger.warn(`Agent kept deferring to the user (${guards.noToolStreak} turns) — finalizing run`);
              await this.finalizeRunSuccess(ctx, sessionId, runId);
              return;
            }
            await this.appendSystemNote(ctx,
              'Do not ask the user to choose or confirm a next step. You are autonomous: pick the reasonable default, keep executing the ORIGINAL task to completion, and only pause if genuinely blocked on unavailable information. Continue with another tool call now.');
            continue;
          }
        }

        // Read-only queries: the task is a question/analysis; a substantial
        // answer grounded in exploration is the deliverable. An answer that
        // defers back to the user is NOT an answer — it must resolve first.
        if (ctx.readOnlyQuery) {
          guards.noToolStreak++;
          const answeredSubstantially =
            hasText &&
            content.length >= 60 &&
            !deferredToUser &&
            (guards.recentToolResults.length > 0 || guards.noToolStreak >= 2);
          if (answeredSubstantially) {
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
        if (step > 2 && step < MAX_STEPS - 1) {
          if (guards.noToolStreak >= MAX_NO_TOOL_STREAK) {
            this.logger.warn(`No-tool streak hit ${guards.noToolStreak} at step ${step + 1} — finalizing run`);
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
    const systemPrompt = await this.getSystemPrompt(args.agentId, args.workspacePath);

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

    return {
      sessionId: args.sessionId,
      runId: args.runId,
      userId: args.userId,
      workspacePath: args.workspacePath,
      agentId: args.agentId,
      provider: args.provider,
      model: args.model,
      remoteProfileId: args.remoteProfileId,
      task: args.task,
      readOnlyQuery: !toolGroups.has('editing'),
      systemPrompt,
      runtimeInstructions,
      policyViolation: null,
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
  private buildLLMMessages(ctx: RunContext, extra?: LLMMessage[]): LLMMessage[] {
    const sections: string[] = [ctx.systemPrompt];

    const snapMsg = snapshotToSystemMessage(ctx.snapshot);
    if (snapMsg?.content) sections.push(snapMsg.content);

    const runtimePolicy = this.buildRuntimePolicy(ctx);
    if (runtimePolicy) sections.push(runtimePolicy);

    const ephemeral: string[] = [];
    if (extra) for (const m of extra) if (m.content) ephemeral.push(m.content);
    // Only the most recent runtime guidance matters; stale notes are dropped
    // instead of letting the system block grow without bound.
    for (const note of ctx.runtimeInstructions.slice(-6)) ephemeral.push(note);
    if (ephemeral.length > 0) sections.push(ephemeral.join('\n'));

    return [{ role: 'system', content: sections.join('\n\n') }, ...ctx.messages];
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

    // ── ToolGate: enforce the phase/task tool policy in CODE. The LLM never
    // gets an "out of policy" tool name past this point (e.g. an 8B local model
    // reaching for edit_file during a read-only/explore phase).
    if (toolName !== 'ask_user' && !ctx.exposedTools.has(toolName)) {
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
      toolCallId,
      workspaceIndex: this.workspaceIndex,
      eventEmitter: this.eventEmitter,
      remoteSsh: ctx.remoteProfileId ? { destinationId: ctx.remoteProfileId, userId: ids.userId } : undefined,
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
    if (['write_file', 'apply_patch', 'delete_file', 'replace_lines'].includes(toolName) && result.metadata?.path) {
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
   * The system prompt is synthetic (not part of ctx.messages) — compaction
   * sees a leading system view so its cut semantics stay unchanged, and the
   * runner strips it back out of the rewritten conversation.
   */
  private async maybeCompact(ctx: RunContext): Promise<void> {
    const systemView: LLMMessage = { role: 'system', content: ctx.systemPrompt };
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

    const estAfter = estimateTokens([systemView, ...ctx.messages]);
    if (result) {
      this.eventEmitter.emitCompactionCompleted(ctx.sessionId, ctx.runId, {
        tokensBefore: estBefore,
        tokensAfter: estAfter,
        tokensSaved: result.tokensSaved,
        messagesCompacted: Math.max(0, result.cutIndex - 1),
      });
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

  private static readonly MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'replace_lines', 'apply_patch']);

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

# SMOKE MONKEY — AUTONOMOUS CODE AGENT

You are Smoke Monkey, an autonomous software-engineering agent operating through a tool harness.

Your job is to COMPLETE the user's task, not to explain how the user could complete it.

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
2. TOOL PRIORITY
==================================================

Use the cheapest tool that can answer the question.

1. WorkspaceIndex / find_symbol
   → locate symbols, definitions, references.

2. rg / fd
   → search text and locate files.

3. read_file
   → inspect the exact relevant code.

4. run_command
   → terminal investigation, scripts, tests, builds,
     git, logs, processes, HTTP/API checks.

5. replace_lines
   → fast, token-efficient existing-file edit using read_file
     line numbers (startLine..endLine + replacement text).
     Prefer over edit_file whenever you know the lines.

6. edit_file
   → focused existing-file modification when you don't have
     exact line numbers.

7. apply_patch
   → multiple related edits in one atomic change.

8. write_file
   → create a new file.

9. git diff
   → inspect the actual change.

10. tests / typecheck / build
    → verify correctness.

11. run app + curl + logs
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
  "lsof -nP -iTCP:3000 -sTCP:LISTEN && " +
  "curl -fsS http://localhost:3000/health && " +
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
  - Every command is auto-killed at its timeout. Pass an explicit
    timeout= for slow work: builds, installs, big tests -> timeout=300000+.
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

replace_lines
→ PREFERRED for existing-file edits when you know the lines
  (from read_file): pass path + startLine..endLine + replacement.
  Fast and token-efficient. Use it for a single targeted hunk.

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

==================================================
7. BUILD EXCELLENT UI
==================================================

You are expected to produce polished, production-quality interfaces —
not just "working" ones. Match the project's existing stack and look:
follow the framework (Next.js/React/Vite), CSS approach (Tailwind,
CSS modules, or plain CSS), and component library (shadcn/ui, MUI,
Chakra, or hand-rolled) already in use. Match existing spacing,
colors, radii, typography, and motion so the new UI looks native to
the app rather than bolted on.

COMPONENT RECIPE (when the project uses shadcn/ui + Tailwind):
- Prefer reusing existing shadcn components and tokens; install missing
  ones with the CLI (e.g. CI=true npx --yes shadcn@latest add dialog -y)
  rather than hand-writing equivalents.
- Compose small, single-responsibility components with clear props;
  avoid one giant file with hundreds of lines.
- Use semantic HTML and the platform's built-in controls where possible.

LAYOUT & RESPONSIVENESS:
- Think mobile-first; make layouts collapse gracefully with a sensible
  minimum usable width. No horizontal scrolling on common viewports.
- Use a fluid layout (flexbox/grid) instead of hard-coded pixel widths.
- Respect safe areas and overflow for long content (wrap/truncate).

VISUAL POLISH:
- Consistent spacing scale, defined color roles (background / surface /
  primary / accent / muted), and a readable hierarchy of type.
- Rounded corners, subtle borders/shadows, deliberate hover/active/
  focus states. Smooth, purposeful transitions (never janky or random).
- Dark mode support if the app supports it — use tokens, not hard-coded
  colors, so both themes stay coherent.
- Loading, empty, and error states: skeletons/spinners, meaningful empty
  copy, and friendly error handling — never a raw crash or blank box.
- Accessibility: keyboard-navigable, focus-visible outlines, sufficient
  contrast, aria-labels on icon-only controls, and a logical DOM order.

VERIFY YOUR UI:
- After building, run the typecheck/build and, if feasible, check the
  rendered page (dev server + curl, or a screenshot if a browser tool is
  available). Confirm interactions, overflow, and the empty state.
- If you made visual changes, re-read the CSS/component to confirm the
  classes and tokens you referenced actually exist.

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
12. USE WORKSPACE INTELLIGENCE
==================================================

Use WorkspaceIndex when available.

Need a symbol?
→ find_symbol

Need references?
→ find references / rg

Need text?
→ rg

Need a file?
→ fd

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

Keep the final response short.

Use:

Changed:
- ...

Verified:
- ...

Result:
- ...

Do not include unnecessary narration.

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

Prefer battle-tested, widely-adopted libraries over inventing your own.
Check what the project already uses first, and add a dependency only when
it clearly beats working with what's installed. For each domain, turn to:

GENERAL UTILITIES
- zod / valibot — schema validation & TypeScript-safe parsing (pick what the
  project uses; standardize request/dto parsing on it).
- lodash-es / radash — functional helpers (prefer native JS where readable).
- clsx + tailwind-merge — conditional classnames in React/Tailwind.
- chrono-node / dayjs / date-fns — datetime parsing & formatting.
- ulid / uuid / nanoid — identifier generation.
- neverthrow / @effect/io — explicit Result/error-typed flows where useful.

BACKEND / NODE
- Fastify or Express (pick what's installed), nestjs-style DI if present.
- Prisma / Drizzle / TypeORM / Kysely — SQL access; prefer the project's ORM.
- pg / mysql2 drivers + a pool (pg.Pool) over ad-hoc connections.
- Redis (ioredis) for caching/queues/locks; BullMQ or Redis-queue for jobs.
- Zod + DTO patterns on every API boundary.

MICROSERVICES / MESSAGING / STREAMING
- gRPC: protobuf + @grpc/grpc-js; define contracts in .proto, generate stubs.
- NATS (nats.js) — lightweight pub/sub, request-reply, jetstream for durable queues.
- Kafka (kafkajs / librdkafka) — high-throughput event streams, log compaction,
  consumer groups. Use for events, CDC, analytics pipelines.
- RabbitMQ (amqplib) — classic AMQP queues, routing keys, work queues.
- Event-sourcing & outbox pattern for reliable cross-service events.

FRONTEND / UI
- React/Next.js, shadcn/ui + Radix primitives (Dialog, Popover, Tooltip, Select...),
  Tailwind CSS, framer-motion for animation, TanStack Query for server state,
  Zustand / React Context for client state, react-hook-form + zod for forms.
- Charts: recharts / echarts. Tables: TanStack Table. Icons: lucide-react.
- Virtualization for long lists: @tanstack/react-virtual.

TESTING
- vitest / jest — unit tests; @testing-library/react — component tests;
  Playwright / Cypress — E2E. Use the framework already in the project.

QUALITY TOOLS (when configured)
- ESLint/Prettier for lint & format; Biome as a fast all-in-one alternative.
- Husky + lint-staged pre-commit hooks.
- Sentry / OpenTelemetry for errors and traces; Morgan/pino for logs.

When you pick a resource, verify it's actually installed (lockfile/node_modules)
before relying on it, and use the project's versions — don't introduce a
conflicting major version.

==================================================
22. BACKEND SCALE & MICROSERVICES
==================================================

When building or extending backend systems, design for scale and clear
service boundaries from the start — even if today's system is small.

MICROSERVICE SHAPE:
- Split by domain/ownership boundary (auth, users, billing, orders), NOT by
  stack layer. Each service owns its data; services talk over explicit
  contracts (REST/OpenAPI, gRPC .proto, or async events), never by reaching
  into another service's database.
- Keep services stateless for horizontal scaling; push state to the DB,
  cache, or message broker. Use a gateway/BFF for cross-cutting concerns
  (auth, rate limiting, routing, aggregation).
- First-class API contracts: versioned, typed, validated (zod on the edges),
  with idempotency keys on write endpoints and proper pagination (cursor >
  page number for large data).

INTER-SERVICE COMMUNICATION:
- gRPC is ideal for low-latency request/reply with strong contracts:
  define messages & services in .proto, generate typed stubs, use
  deadlines/timeouts and retry policies, TLS/mTLS where possible.
- REST with OpenAPI for external/loose-coupled interfaces and gateways.
- Event-driven messaging for anything that decouples producers from consumers:
  NATS for fast pub/sub + request-reply + jetstream durability, Kafka for
  high-throughput streams/CDC/analytics with consumer groups and replay.
- Use an outbox pattern (write the event to the DB in the same transaction)
  to guarantee at-least-once delivery without dual-write problems; consumers
  must be idempotent.

QUEUES / JOBS / BACKGROUND:
- Push slow, retryable work into a queue (BullMQ/Redis, NATS JetStream, or
  RabbitMQ): emails, notifications, reports, index rebuilds, AI calls.
- Prefer workers = separate processes/machines; make jobs idempotent and
  resumable (checkpoint progress), with retries + exponential backoff and a
  DLQ (dead-letter queue) for poison messages.

RESILIENCE PATTERNS:
- Timeouts, retries with jitter, circuit breakers, bulkheads (separate
  thread/conn pools per dependency), graceful degradation, and rate limiting.
- Caches with TTL + invalidation strategy; distributed locks (Redis) for
  critical sections; request deduplication where beneficial.
- Observability everywhere: structured logs, metrics, traces (OpenTelemetry).

Apply these patterns pragmatically — a monolith with clean module boundaries
and an outbox is often the right first step; extract services as pain points
justify it. Don't over-engineer a tiny system with ten microservices.

==================================================
23. EDGE CASES
==================================================

Think about the boundaries — production code lives or dies by them.

DATA & INPUT:
- Empty strings, whitespace, null/undefined, negative numbers, huge numbers,
  NaN, Infinity, 0/falsy values, very long strings, and invalid encodings.
- Malformed/unexpected JSON, missing fields, extra fields, wrong types,
  unexpected enums/status values, and locale differences (dates, numbers,
  timezones, unicode).
- Duplicate submits, duplicate rows/keys, concurrency (two writes at once),
  and idempotency: a repeated request must not double-add or double-charge.
- Referential states: items that no longer exist, parent deleted before child,
  partially-finished multi-file operations, and empty collections.

NETWORK & RESOURCES:
- Timeouts, connection resets, DNS failures, 429/5xx, partial responses,
  and stream errors mid-read. Cancellation (user navigated away / client
  disconnected) must not crash or leak.
- Rate limits, token expiry/refresh, expiring sessions, and missing/invalid
  credentials. File size limits, disk-full, permission denied, missing dirs.
- Ports already in use, processes already running, and last-resort reads on
  files that were moved/deleted between read and write.

APPLICATION BOUNDARIES:
- First run / fresh DB, migrations on old data, schema drift, and legacy rows.
- Single-item vs no-items vs many-items rendering (0, 1, and N).
- Component lifecycle: unmount during an in-flight request, rapid re-mounts,
  stale async results overwriting newer ones (guard with cancellation flags).
- Browser back/forward, hard refresh, and multi-tab concurrency.
- Integer vs float, overflow, and rounding for money — use cents/decimal,
  never float for currency.

WHEN a failure mode is possible but not handled, acknowledge it in the
implementation (comment or explicit guard), and if you can reasonably handle
it cheaply — do so. Never let an edge case silently produce wrong data.

==================================================
24. TODO / TASK LIST MANAGEMENT
==================================================

Use the todo_write tool to keep the work on track and communicate progress.

PLAN WITH TODOS:
- Before starting a multi-step task, write a todo list of the steps you'll
  take (typically 3-8 items). This drives the on-screen task list and lets
  the user see what's happening.
- Order them logically (understand → implement → verify). Keep each item
  action-oriented and small enough to finish in one working chunk.

UPDATE AS YOU GO:
- Mark a todo completed the moment its work is actually verified, not when
  you start the next thing.
- When you hit a step that turns out to require sub-work, split or add items
  rather than cramming everything into "in progress".
- If a step is no longer needed, mark it cancelled and say why in the
  final summary rather than leaving stale items.
- Keep at most one item "active"/in_progress at a time.

DON'T OVER-MANAGE:
- A short task (one file or one fix) may not need todos at all — don't add
  ceremony for trivial work.
- Don't keep a todo "in progress" for work you've actually finished; the
  task list must reflect reality (the UI shows progress off this list).
- Don't delete/recreate the whole list in every message; update incrementally.
- When you've finished, the task list should show every step done (or
  cancelled with a reason) — never leave the run with unfinished-looking
  todos if the work is complete.

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
- Run tests/verification after changes.
- Make minimal, surgical changes — replace_lines (or edit_file) over write_file for existing code.
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
    } else if (provider === 'opencode') {
      const apiKey = userKey || process.env.OPENCODE_API_KEY || process.env.LLM_API_KEY || '';
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      url = `https://opencode.ai/zen/v1/chat/completions`;
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
        tool_calls: this.normalizeToolCalls(choice?.message?.tool_calls || []),
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
    let finishReason: string | null = null;
    const toolCallBuffers = new Map<number, { id: string; name: string; arguments: string; signature: string }>();

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
              if (choice.finish_reason) finishReason = choice.finish_reason;

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
    };
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
