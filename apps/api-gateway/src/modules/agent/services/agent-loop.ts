/**
 * AgentLoop — parameterised agentic loop library.
 *
 * Owns the ENTIRE agent step loop: LLM turn orchestration, tool resolution and
 * execution, loop guards, completion detection, and terminal finalization.
 * The concrete NestJS service supplies persistence/context/LLM plumbing via
 * the `deps` object, so the loop itself is framework-agnostic and reusable
 * across run hosts.
 *
 *   const loop = new AgentLoop(deps);
 *   await loop.execute({
 *     sessionId, runId, userId, message, workspacePath,
 *     agentId, model, provider, remoteProfileId, abortController,
 *   });
 */
import { Logger } from '@nestjs/common';
import { AgentMessageService } from './agent-message.service';
import { AgentRunService } from './agent-run.service';
import { AgentSessionService } from './agent-session.service';
import { AgentPermissionService } from './agent-permission.service';
import { AgentEventEmitter } from './agent-event.emitter';
import { ContextCompactionService } from './compaction.service';
import { ToolRegistry, ToolResult } from '../tools/tool-registry';
import { WorkspaceIndex } from './workspace-index';
import { enrichToolResult, ensureRunDirs } from './artifact-store';
import {
  AgentPhase,
  LLMMessage,
  PHASE_TOOLS,
  READ_ONLY_TOOLS,
  RunContext,
  TOOL_GROUPS,
  buildAgentState,
  nextPhaseOnCall,
  nextPhaseOnResult,
  phaseDirective,
  safeParseObject,
} from './run-context';
import { AgentMessage, ToolCallJson } from '../entities/agent-message.entity';
import { PermissionEffect } from '../entities/agent-permission.entity';
import { getSubContext } from '../context/sub-context';
import {
  createRunGuards,
  applyMutationBookkeeping,
  checkDoomLoop,
  checkEmptyResponse,
  checkSameOutput,
  checkSearchFamilyLoop,
  emptyResponseDelay,
  mutationBudgetAllows,
  trackFailedVerification,
  verificationReadBlocked,
  wouldTripLoopGuards,
  type RunGuards,
} from './agent-guards';
import {
  extractInlineToolCalls,
  isDegenerateRepeat,
  isSensitiveTarget,
  isVerificationCommand,
  isVerificationTool,
  parseMcpToolName,
  resolveToolDefinitions,
  toolTimeoutMs,
  validateToolCalls,
  type LLMToolDef,
} from './tool-library';
import { type LLMResponse, STREAMING_PROVIDERS } from './llm-client';
export type { LLMResponse };

// ── Constants ────────────────────────────────────────────────────────────────

export const MAX_STEPS = 1000;
const MAX_SAME_ERROR = 3;

/** Consecutive text-only responses tolerated before ending the run gracefully. */
const MAX_NO_TOOL_STREAK = 5;

/** Raw inputs the caller passes when starting (or resuming) one agent run. */
export interface CreateRunContextArgs {
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
}

/**
 * Turn a raw provider error string into one calm, human-facing line for the
 * chat card — e.g. a `429 (rate limited)` JSON blob from an OmniRoute free-tier
 * model like `oc/big-pickle` becomes "Model `oc/big-pickle` is rate-limited
 * (429); wait a moment and try again." Picks out the status, the model id, and
 * the provider's own wording, dropping the surrounding noise. Fallbacks cover
 * unrelated one-line errors (timeout, auth, corrupt-stream) so the card stays
 * calm no matter what the API actually threw.
 */
export function formatProviderError(raw: string, modelName?: string): string {
  const msg = (raw || '').trim();
  if (!msg) return 'The model returned an empty error from the provider.';
  const status = /\b(429|403|401|408|500|502|503|504|520|529)\b/.exec(msg)?.[1];
  const model =
    /(?:^|[/\s])(oc|cfp|auto|openpipe|omniroute)\/([A-Za-z0-9._-]+)/i.exec(msg)?.[2] ||
    /model\s*[:=]\s*["']?([A-Za-z0-9._/-]+)["']?/i.exec(msg)?.[1] ||
    /([A-Za-z0-9_.-]+\/[A-Za-z0-9_.:-]+)/i.exec(msg)?.[1];
  const isRate = /rate.?limit|too many|overloaded|429|quota|insufficient_quota/i.test(msg);
  const isAuth = /403|forbidden|unauthorized|invalid (?:api|access) key|permission|free ?tier/i.test(msg);
  const isTimeout = /timeout|timed out|stalled|no tokens|etimedout|idle/i.test(msg);
  const tail = isRate
    ? 'is rate-limited (429); wait a moment and try again.'
    : isAuth
      ? 'refused the request (403 — free-tier/permission); pick a different provider or retry later.'
      : isTimeout
        ? 'timed out (no tokens for a while); try again.'
        : `returned an error from the provider ${status ? `(${status})` : ''}: ${msg.slice(0, 120)}`;
  return `Model \`${modelName || model || 'your selected model'}\` ${tail}`.replace(/\s+/g, ' ').trim();
}


export interface AgentLoopParams {
  sessionId: string;
  runId: string;
  userId: string;
  message: string;
  workspacePath: string;
  agentId: string;
  model?: string;
  provider?: string;
  remoteProfileId?: string;
  abortController: AbortController;
}

/** The user's answer to an MCP approval pause. */
export interface McpApprovalDecision {
  action: 'enable' | 'add' | 'skip';
  names: string[];
}

/**
 * All framework/plumbing hooks the loop needs. The loop calls these to persist
 * messages, emit events, call the model, and finalize — it never touches
 * NestJS services directly, keeping the loop testable in isolation.
 */
export interface AgentLoopDeps {
  toolRegistry: ToolRegistry;
  workspaceIndex: WorkspaceIndex;
  eventEmitter: AgentEventEmitter;
  permissionService: Pick<AgentPermissionService, 'evaluate'>;
  runService: Pick<AgentRunService, 'incrementStep' | 'updateStatus' | 'updateTokens' | 'saveAgentState'>;
  sessionService: Pick<AgentSessionService, 'updateStatus' | 'updateTokens'>;
  messageService: Pick<AgentMessageService, 'create'>;
  compactionService: ContextCompactionService;

  createRunContext(args: CreateRunContextArgs): Promise<RunContext>;
  buildLLMMessages(ctx: RunContext, extra?: LLMMessage[]): LLMMessage[];
  appendAssistantMessage(ctx: RunContext, content: string, toolCalls?: ToolCallJson[], usage?: { prompt_tokens: number; completion_tokens: number }, reasoning?: string | null): Promise<AgentMessage>;
  appendToolResult(ctx: RunContext, parentMessageId: string, toolCallId: string, content: string): Promise<void>;
  appendSystemNote(ctx: RunContext, content: string): Promise<void>;
  /** Persists the run's durable context snapshot (incl. active sub-contexts). */
  persistContext(ctx: RunContext): Promise<void>;
  compactToolOutput(workspacePath: string, runId: string, toolCallId: string, output: string): Promise<string>;
  callLLMWithRetry(messages: LLMMessage[], tools: LLMToolDef[], provider?: string, model?: string, sessionId?: string, runId?: string, userId?: string): Promise<LLMResponse>;
  maybeCompact(ctx: RunContext): Promise<void>;
  waitForUserResponse(ctx: RunContext, toolCallId: string): Promise<string>;
  waitForPermission(ctx: RunContext, toolCallId: string, meta: { userId: string; workspacePath: string; toolName: string }): Promise<PermissionEffect>;
  waitForMcpDecision(ctx: RunContext, toolCallId: string): Promise<McpApprovalDecision>;
  persistToolStatus(assistantMsg: AgentMessage, toolCallId: string, status: ToolCallJson['status'], output: string, result?: unknown): Promise<void>;
}

// ── AgentLoop ────────────────────────────────────────────────────────────────

export class AgentLoop {
  private readonly logger = new Logger(AgentLoop.name);

  constructor(private readonly deps: AgentLoopDeps) {}

  /**
   * Runs the full agentic loop for one session run. Returns when the run
   * reaches a terminal state (completed / failed / interrupted).
   */
  async execute(params: AgentLoopParams): Promise<void> {
    const { sessionId, runId, userId, message, workspacePath, agentId, model, provider, remoteProfileId, abortController } = params;

    // ── State-driven core ─────────────────────────────────────────────────
    // Build the conversation ONCE per run (a single DB read), then mutate the
    // RunContext in memory. No more per-step "DB → rebuild context → LLM".
    const ctx = await this.deps.createRunContext({
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

    ensureRunDirs(workspacePath, runId).catch((err) =>
      this.logger.warn(`Failed to create run directories: ${err}`),
    );

    try {
      await this.deps.workspaceIndex.build(workspacePath);
    } catch (err) {
      this.logger.warn(`WorkspaceIndex build failed: ${err}`);
    }

    this.deps.eventEmitter.emitAgentState(sessionId, runId, 'understanding', 'active', phaseDirective('understand') ?? undefined);

    if (ctx.contextManager.activeCount > 0) {
      const initial = ctx.contextManager.activeIds.map((id) => {
        const c = getSubContext(id);
        return { id, title: c?.title ?? id };
      });
      this.deps.eventEmitter.emitContextUpdated(sessionId, runId, initial, ctx.contextManager.activeCount, ctx.contextManager.maxActive);
    }

    const guards: RunGuards = createRunGuards();

    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        if (abortController.signal.aborted) {
          await this.deps.persistContext(ctx);
          await this.finalizeInterrupted(sessionId, runId);
          return;
        }

        ctx.currentStep = step;
        await this.deps.runService.incrementStep(runId);
        this.deps.eventEmitter.emitStepStarted(sessionId, runId, step + 1);

        await this.deps.maybeCompact(ctx);

        // Step-budget countdown nudges are intentionally EPHEMERAL.
        const extra: LLMMessage[] = [];
        const stepsLeft = MAX_STEPS - step - 1;
        if (stepsLeft === 3 || stepsLeft === 1) {
          extra.push({
            role: 'system',
            content: `STEP BUDGET: only ${stepsLeft} step(s) remain in this run. Do not start new work or modify files again. Output your final summary NOW.`,
          });
        }

        // Tool groups merge via the tool library — exposure only grows.
        const tools = await resolveToolDefinitions(
          this.deps.toolRegistry,
          ctx.exposedTools,
          ctx.phase,
          ctx.mcpRuntime,
          ctx.contextManager,
        );

        let response: LLMResponse;
        try {
          this.deps.eventEmitter.emitLlmThinking(sessionId, runId, step + 1);
          this.deps.eventEmitter.emitAgentState(sessionId, runId, ctx.phase, 'active', 'Thinking…');
          await this.deps.runService.updateStatus(runId, 'thinking');
          response = await this.deps.callLLMWithRetry(
            this.deps.buildLLMMessages(ctx, extra),
            tools,
            provider,
            model,
            sessionId,
            runId,
            ctx.userId,
          );
          this.logger.debug(`LLM response: content=${(response.content || '').slice(0, 100)} tool_calls=${response.tool_calls?.length || 0} finish=${response.finish_reason ?? '?'} usage=${JSON.stringify(response.usage)}`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const friendly = formatProviderError(errMsg, model);
          // Surface the FIRST occurrence of each distinct provider error to the
          // chat immediately as a small card, so the user sees e.g. "429 (rate
          // limited)" or a 403 while the run is still retrying — not only after
          // the 3× repeated-error threshold turns it into a failure. Each
          // message is noted once; the transient-retry path keeps running.
          const seenBefore = guards.errorHistory.includes(friendly);
          guards.errorHistory.push(friendly);
          if (!seenBefore) {
            await this.deps.appendSystemNote(ctx, friendly);
          }
          if (guards.errorHistory.filter((e) => e === friendly).length >= MAX_SAME_ERROR) {
            this.logger.warn(`LLM call failed (step ${step + 1}): ${errMsg}`);
            await this.deps.appendSystemNote(ctx, `Repeated error detected: ${friendly}. Stopping to prevent an infinite loop.`);
            await this.deps.persistContext(ctx);
            await this.deps.runService.updateStatus(runId, 'failed');
            this.deps.eventEmitter.emitRunFailed(sessionId, runId, 'repeated_error');
            return;
          }

          this.logger.warn(`LLM call failed (step ${step + 1}): ${errMsg}`);
          continue;
        }

        if (response.usage) {
          ctx.inputTokens += response.usage.prompt_tokens;
          ctx.outputTokens += response.usage.completion_tokens;
          await this.deps.runService.updateTokens(runId, response.usage.prompt_tokens, response.usage.completion_tokens);
          await this.deps.sessionService.updateTokens(sessionId, response.usage.prompt_tokens, response.usage.completion_tokens, 0);
        }

        // Inline text-format tool calls (Qwen/GLM/DeepSeek/Smoke Monkey XML) +
        // reasoning recovery. The exposed-tool set filters the XML-style parser so
        // prose that merely looks like <tag>{json}</tag> is never turned into a
        // phantom tool call, while recognisable calls (ask_user, MCP, ...) land.
        let inlineParsed = response.tool_calls?.length
          ? { calls: [] as Array<{ id: string; function: { name: string; arguments: string } }>, cleaned: response.content || '' }
          : extractInlineToolCalls(response.content, ctx.exposedTools);
        if (inlineParsed.calls.length === 0 && !response.tool_calls?.length && response.reasoning) {
          const fromReasoning = extractInlineToolCalls(response.reasoning, ctx.exposedTools);
          if (fromReasoning.calls.length > 0) {
            inlineParsed = { ...fromReasoning, cleaned: response.content || '' };
            this.logger.log(`Recovered ${fromReasoning.calls.length} tool call(s) from reasoning text (step ${step + 1})`);
          }
        }

        // Degeneration guard: the model is stuck re-printing the same block.
        if (!inlineParsed.calls.length && isDegenerateRepeat(response.content)) {
          this.logger.warn(`Repetition loop detected at step ${step + 1} — finalizing run`);
          await this.deps.appendSystemNote(ctx,
            'Generation loop detected — the model started repeating itself. Ending the run here to avoid wasting tokens. All progress made so far is preserved above.');
          await this.finalizeRunSuccess(ctx, sessionId, runId);
          return;
        }

        // Structured calls survive validation; otherwise fall back to inline parsing.
        let calls: Array<{ id: string; function: { name: string; arguments: string }; thought_signature?: string }>;
        let sourceIsStructured = false;
        if (response.tool_calls?.length) {
          sourceIsStructured = true;
          calls = validateToolCalls(response.tool_calls as any, { warn: (m) => this.logger.warn(m) });

          if (calls.length === 0) {
            this.logger.warn(`All ${response.tool_calls.length} tool calls were malformed. Asking the model to retry.`);
            await this.deps.appendAssistantMessage(ctx, `I need to use tools properly. Let me try again with correct tool calls.`);
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

          const toolNames = calls.map((c) => c.function.name).join(', ');
          this.deps.eventEmitter.emitAgentState(sessionId, runId, ctx.phase, 'active', `Running ${toolNames}`);

          // Inline XML-style calls (e.g. <ask_user>…</ask_user>) carry the tool
          // markup in the text itself — persist the CLEANED transcript so the raw
          // tags never render as chat text.
          const assistantContent = sourceIsStructured
            ? (response.content || '')
            : (inlineParsed.cleaned || '');

          const assistantMsg = await this.deps.appendAssistantMessage(ctx, assistantContent, calls.map((tc) => ({
            id: tc.id,
            toolName: tc.function.name,
            arguments: safeParseObject(tc.function.arguments),
            status: 'queued' as ToolCallJson['status'],
            ...(tc.thought_signature ? { thought_signature: tc.thought_signature } : {}),
          })), undefined, response.reasoning);

          // Structured calls stream their content live; inline-parsed ones may
          // have leaked the raw tool tags into the stream — settle both with a
          // final text snapshot (end event) built from the cleaned content.
          if (sourceIsStructured || assistantContent !== (response.content || '')) {
            if (assistantContent && !STREAMING_PROVIDERS.has(provider || '')) {
              this.deps.eventEmitter.emitTextDelta(sessionId, runId, assistantMsg.id, assistantContent);
            }
            this.deps.eventEmitter.emitTextEnd(sessionId, runId, assistantMsg.id, assistantContent, assistantMsg.toolCalls || undefined, response.reasoning);
          }

          await this.executeToolCalls(ctx, assistantMsg, calls, guards, { agentId, userId });

          // finish_task — the model's explicit structural completion signal.
          if (ctx.finishSignal) {
            this.logger.log(`finish_task called — finalizing run ${runId} (${ctx.finishSignal.summary.slice(0, 80)})`);
            await this.finalizeRunSuccess(ctx, sessionId, runId);
            this.deps.eventEmitter.emitStepEnded(sessionId, runId, step + 1);
            return;
          }

          // Runaway build/verification loop — finalize as failed.
          if (ctx.hardStopReason) {
            this.logger.warn(`Hard-stopping run ${runId}: ${ctx.hardStopReason}`);
            await this.deps.appendSystemNote(ctx, ctx.hardStopReason);
            this.setPhase(ctx, 'complete');
            await this.deps.persistContext(ctx);
            await this.deps.runService.updateStatus(runId, 'failed');
            await this.deps.sessionService.updateStatus(sessionId, 'failed');
            this.deps.eventEmitter.emitRunFailed(sessionId, runId, ctx.hardStopReason);
            this.deps.eventEmitter.emitStepEnded(sessionId, runId, step + 1);
            return;
          }

          const agentState = buildAgentState(ctx);
          await this.deps.runService.saveAgentState(runId, agentState, ctx.workspacePath);
          this.deps.eventEmitter.emitStepEnded(sessionId, runId, step + 1);
          continue;
        }

        // Empty degenerate response: no content AND no tool calls.
        if (!response.content && (!response.tool_calls || response.tool_calls.length === 0)) {
          this.logger.warn(
            `Empty LLM response step ${step + 1}: provider=${provider} model=${model} ` +
              `finish=${response.finish_reason ?? 'n/a'} reasoningChars=${(response.reasoning || '').length} ` +
              `usage=${JSON.stringify(response.usage)} toolsExposed=${tools.length}`,
          );
          guards.emptyStreak++;
          const { shouldFinalize } = checkEmptyResponse(guards);
          if (shouldFinalize) {
            const hasToolProgress = guards.recentToolResults.length > 0;
            this.logger.warn(
              `Empty LLM response repeated ${guards.emptyStreak} times at step ${step + 1} — finalizing run` +
              (hasToolProgress ? ' (after tool progress)' : ''),
            );
            const modelLabel = model ? `Model \`${model}\`` : (provider ? `Model \`${provider}\`` : 'The model');
            await this.deps.appendSystemNote(ctx,
              `${modelLabel} returned an empty response repeatedly — most often a provider rate limit / exhausted quota ` +
              '(HTTP 429). Stopping the run to avoid wasting tokens. You can reply below to retry in a moment.');
            await this.deps.runService.updateStatus(runId, 'failed');
            await this.deps.sessionService.updateStatus(sessionId, 'failed');
            this.deps.eventEmitter.emitRunFailed(sessionId, runId,
              `model \`${model || provider || 'selected model'}\` returned empty responses repeatedly`);
            this.deps.eventEmitter.emitStepEnded(sessionId, runId, step + 1);
            return;
          }
          this.logger.warn(`Empty LLM response at step ${step + 1} (no content, no tool calls) — retrying`);
          const emptyDelay = emptyResponseDelay(guards.emptyStreak);
          await new Promise((r) => setTimeout(r, emptyDelay));
          if (guards.emptyStreak === 1) {
            const modelLabel = model ? `Model \`${model}\`` : (provider ? `Model \`${provider}\`` : 'The model');
            await this.deps.appendSystemNote(ctx,
              `${modelLabel} returned an empty response. Respond now. If you have completed the task, give your final summary. ` +
              'Otherwise call a tool (read_file, edit_file, write_file, run_command) to keep making progress.');
          }
          continue;
        }
        guards.emptyStreak = 0;

        // ── Text-only turn ────────────────────────────────────────────────
        this.deps.eventEmitter.emitStepEnded(sessionId, runId, step + 1);

        if (response.content) {
          const assistantMsg = await this.deps.appendAssistantMessage(ctx, response.content, undefined, response.usage, response.reasoning);
          if (!STREAMING_PROVIDERS.has(provider || '')) {
            this.deps.eventEmitter.emitTextDelta(sessionId, runId, assistantMsg.id, response.content);
          }
          this.deps.eventEmitter.emitTextEnd(sessionId, runId, assistantMsg.id, response.content, undefined, response.reasoning);
        }

        const content = (response.content || '').trim();
        const hasText = content.length > 20;
        const finalReport = this.isFinalReport(content);
        const verificationPassed = guards.recentToolResults.some(
          (r) => r.success && isVerificationTool(r.name),
        ) || guards.recentToolCalls.some(
          (tc) => tc.name === 'run_command' && isVerificationCommand(tc.args || ''),
        );
        if (step > 2 && verificationPassed && finalReport) {
          this.logger.log(`Task completion detected at step ${step + 1} (verification + final report)`);
          await this.finalizeRunSuccess(ctx, sessionId, runId);
          return;
        }

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

        if (finalReport && hasText) {
          this.logger.log(`Agent finished with final report at step ${step + 1} — finalizing`);
          await this.finalizeRunSuccess(ctx, sessionId, runId);
          return;
        }

        // Read-only queries can finalize with a plain text answer.
        if (ctx.readOnlyQuery) {
          guards.noToolStreak++;
          const noToolWork = guards.recentToolResults.length === 0;

          // If the model asks the user a follow-up question (e.g. after an
          // ask_user was answered) without calling ask_user itself, keep the
          // run alive so the user can still interact. The system-note nudge
          // pushes the model to call ask_user on the next step.
          const trimmedContent = (response.content || '').trim();
          const isUserFollowUpQuestion =
            /[?？]\s*$/.test(trimmedContent) &&
            !noToolWork &&
            guards.recentToolResults.some((r) => r.name === 'ask_user');

          if (isUserFollowUpQuestion) {
            this.logger.log(`Agent asked a follow-up question at step ${step + 1} without calling ask_user — nudging next turn`);
            await this.deps.appendSystemNote(ctx,
              'You asked the user a follow-up question but did NOT call the ask_user tool. ' +
              'You MUST call ask_user next turn so the user can respond via the popup dialog. ' +
              'Do NOT end your response with a question unless you invoke ask_user.');
            this.deps.eventEmitter.emitStepEnded(sessionId, runId, step + 1);
            continue;
          }

          if (noToolWork) {
            if (content) {
              this.logger.log(`General chat answered at step ${step + 1} — finalizing`);
              await this.finalizeRunSuccess(ctx, sessionId, runId);
              return;
            }
            if (guards.noToolStreak >= MAX_NO_TOOL_STREAK) {
              this.logger.log(`General chat produced no text (${guards.noToolStreak} turns) — finalizing`);
              await this.finalizeRunSuccess(ctx, sessionId, runId);
              return;
            }
            continue;
          }

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
        await this.finalizeRunSuccess(ctx, sessionId, runId);
        return;
      }

      await this.finalizeRunSuccess(ctx, sessionId, runId);
    } catch (err) {
      // ABUSE-PROOF finalization: never orphan a session in 'running'.
      await this.finalizeRunFailed(ctx, sessionId, runId, err);
      throw err;
    } finally {
      if (ctx?.mcpRuntime) {
        try { ctx.mcpRuntime.closeAll(); } catch {}
      }
    }
  }

  private isFinalReport(content: string): boolean {
    const FINAL_REPORT_RE =
      /(^|\n)[ \t]*(?:[-*•][ \t]*)?[*_]*(Changed|Verified|Result|Summary|Done|Status)[*_]*[ \t]*:|TASK (COMPLETE|COMPLETED)|completed successfully|verification (passed|green)|all checks (passed|green)/im;
    return FINAL_REPORT_RE.test(content);
  }

  /** Returns the first non-empty line of a tool output. */
  private firstErrorLine(output: string): string {
    const line = output.split('\n').find((l) => l.trim().length > 0) || 'Tool failed';
    return line.slice(0, 200);
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
    const evaluated = await Promise.all(
      parsed.map(async (p) => ({
        ...p,
        permission: await this.deps.permissionService.evaluate(p.call.function.name, '*', ids.agentId, ids.userId, ctx.workspacePath),
      })),
    );
    const isParallelizable = (p: { call: { function: { name: string } }; args: Record<string, unknown>; permission: PermissionEffect }) =>
      p.permission === 'allow' &&
      READ_ONLY_TOOLS.has(p.call.function.name) &&
      !wouldTripLoopGuards(p.call.function.name, p.args, guards);

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

    // Guard guidance lands AFTER the whole batch so tool results stay adjacent
    // to their assistant tool_calls message (required by OpenAI-compatible providers).
    for (const note of turnNotes) {
      await this.deps.appendSystemNote(ctx, note);
    }

    ctx.policyViolation = null;
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

    // ── Deterministic phase advance from the OBSERVED intent. ─────────────
    this.setPhase(ctx, nextPhaseOnCall(ctx.phase, toolName));
    for (const exposed of PHASE_TOOLS[ctx.phase]) ctx.exposedTools.add(exposed);

    // ── ToolGate: enforce the phase/task tool policy in CODE. ─────────────
    const mcpRef = parseMcpToolName(toolName);
    const isMcpFormat = !!mcpRef && !!ctx.mcpRuntime?.configs.some((c) => c.name === mcpRef.serverName);
    if (toolName !== 'ask_user' && !ctx.exposedTools.has(toolName) && !isMcpFormat) {
      const allowed = [...ctx.exposedTools].sort().join(', ');
      const skipMsg =
        `SKIPPED ${toolName}: not allowed in phase "${ctx.phase}". Allowed tools: ${allowed || 'none (finalize now)'}. ` +
        `Pick an allowed tool or, if the task is done, provide your final summary.`;
      turnNotes.push(skipMsg);
      this.logger.warn(`ToolGate blocked ${toolName} (phase=${ctx.phase}) for run ${runId}`);
      this.deps.eventEmitter.emitToolStarted(sessionId, runId, toolCallId, toolName, toolArgs);
      this.deps.eventEmitter.emitToolFailed(sessionId, runId, toolCallId, 'Tool not allowed in this phase');
      await this.deps.appendToolResult(ctx, assistantMsg.id, toolCallId, skipMsg);
      await this.deps.persistToolStatus(assistantMsg, toolCallId, 'failed', skipMsg);
      return;
    }

    const count = (guards.toolCallCounts.get(toolName) || 0) + 1;
    guards.toolCallCounts.set(toolName, count);

    // Doom loop detection: same tool + same args N times consecutively.
    const doom = checkDoomLoop(toolName, toolArgs, guards);
    if (doom.blocked) {
      turnNotes.push(
        `DOOM LOOP DETECTED: Tool "${toolName}" with the same arguments has been called 1000+ times consecutively. ` +
        `STOP calling this tool. Take a completely different approach, or if the task appears complete, provide a final summary.`,
      );
      this.deps.eventEmitter.emitToolStarted(sessionId, runId, toolCallId, toolName, toolArgs);
      this.deps.eventEmitter.emitToolFailed(sessionId, runId, toolCallId, doom.message!);
      await this.deps.appendToolResult(ctx, assistantMsg.id, toolCallId, doom.message!);
      await this.deps.persistToolStatus(assistantMsg, toolCallId, 'failed', doom.message!);
      return;
    }

    // Search-family loop: the model is stuck "looking for something".
    const search = checkSearchFamilyLoop(toolName, guards);
    if (search.blocked) {
      turnNotes.push(
        `SEARCH LOOP DETECTED: You have called search/list/read tools 1000+ times consecutively without making progress. ` +
        `STOP searching. You have enough context. Take action: edit a file, run a command, or provide a final answer.`,
      );
      this.deps.eventEmitter.emitToolStarted(sessionId, runId, toolCallId, toolName, toolArgs);
      this.deps.eventEmitter.emitToolFailed(sessionId, runId, toolCallId, search.message!);
      await this.deps.appendToolResult(ctx, assistantMsg.id, toolCallId, search.message!);
      await this.deps.persistToolStatus(assistantMsg, toolCallId, 'failed', search.message!);
      return;
    }

    this.deps.eventEmitter.emitToolStarted(sessionId, runId, toolCallId, toolName, toolArgs);

    if (ctx.abortController.signal.aborted) {
      await this.deps.appendToolResult(ctx, assistantMsg.id, toolCallId, `CANCELLED ${toolName}: the run was interrupted before execution.`);
      this.deps.eventEmitter.emitToolFailed(sessionId, runId, toolCallId, 'Cancelled by user');
      await this.deps.persistToolStatus(assistantMsg, toolCallId, 'failed', 'Cancelled by user');
      return;
    }

    // finish_task — the model's STRUCTURAL completion signal.
    if (toolName === 'finish_task') {
      const summary = String(toolArgs.summary || '').trim() || 'Task complete';
      ctx.finishSignal = { summary };
      this.deps.eventEmitter.emitToolOutput(sessionId, runId, toolCallId, summary);
      this.deps.eventEmitter.emitToolCompleted(sessionId, runId, toolCallId, { success: true, output: summary, metadata: {} });
      await this.deps.appendToolResult(ctx, assistantMsg.id, toolCallId, `[TASK COMPLETE] ${summary}`);
      await this.deps.persistToolStatus(assistantMsg, toolCallId, 'completed', summary);
      guards.recentToolResults.push({ name: toolName, success: true, output: summary.slice(0, 200) });
      return;
    }

    // ask_user pauses the run until the user answers (or the run is aborted).
    if (toolName === 'ask_user') {
      const question = String(toolArgs.question || '');
      const options = (toolArgs.options as Array<{ label: string; description: string }>) || [];
      const multiple = Boolean(toolArgs.multiple);

      this.logger.log(`[ask_user] Emitting ask_user.required event for toolCallId=${toolCallId}, question=${question.substring(0, 80)}`);
      this.deps.eventEmitter.emitAskUserRequired(sessionId, runId, toolCallId, question, options, multiple);
      await this.deps.runService.updateStatus(runId, 'waiting_user_input');
      await this.deps.sessionService.updateStatus(sessionId, 'waiting_user_input');

      const userResponse = await this.deps.waitForUserResponse(ctx, toolCallId);

      if (!ctx.abortController.signal.aborted) {
        await this.deps.runService.updateStatus(runId, 'executing_tool');
        await this.deps.sessionService.updateStatus(sessionId, 'running');
      }

      this.deps.eventEmitter.emitToolOutput(sessionId, runId, toolCallId, userResponse.slice(0, 2000));
      this.deps.eventEmitter.emitToolCompleted(sessionId, runId, toolCallId, { success: true, output: userResponse, metadata: {} });
      await this.deps.appendToolResult(ctx, assistantMsg.id, toolCallId, userResponse || '(no response)');
      await this.deps.persistToolStatus(assistantMsg, toolCallId, 'completed', userResponse.slice(0, 5000));

      guards.recentToolResults.push({ name: toolName, success: true, output: userResponse.slice(0, 200) });
      if (guards.recentToolResults.length > 6) guards.recentToolResults.shift();
      return;
    }

    const permission =
      precomputedPermission ?? (await this.deps.permissionService.evaluate(toolName, '*', ids.agentId, ids.userId, ctx.workspacePath));
    // Sensitive-file guard: secrets always require the user's explicit OK.
    const sensitive = isSensitiveTarget(toolName, toolArgs, ctx.workspacePath);
    const effectivePermission = sensitive && permission === 'allow' ? 'ask' : permission;
    if (sensitive && permission === 'deny') {
      const msg = `Blocked by security policy: accessing a sensitive file (secrets/credentials) requires permission.`;
      this.deps.eventEmitter.emitToolStarted(sessionId, runId, toolCallId, toolName, toolArgs);
      this.deps.eventEmitter.emitToolFailed(sessionId, runId, toolCallId, 'Permission denied (sensitive file)');
      await this.deps.appendToolResult(ctx, assistantMsg.id, toolCallId, msg);
      await this.deps.persistToolStatus(assistantMsg, toolCallId, 'failed', msg);
      return;
    }
    if (effectivePermission === 'deny') {
      const denyMsg = `Tool "${toolName}" was denied by permissions.`;
      await this.deps.appendToolResult(ctx, assistantMsg.id, toolCallId, denyMsg);
      this.deps.eventEmitter.emitToolFailed(sessionId, runId, toolCallId, 'Permission denied');
      await this.deps.persistToolStatus(assistantMsg, toolCallId, 'failed', denyMsg);
      return;
    }

    if (effectivePermission === 'ask') {
      this.deps.eventEmitter.emitPermissionRequired(sessionId, runId, toolCallId, toolName, toolArgs);
      await this.deps.runService.updateStatus(runId, 'waiting_permission');
      await this.deps.sessionService.updateStatus(sessionId, 'waiting_permission');

      const userChoice = await this.deps.waitForPermission(ctx, toolCallId, {
        userId: ids.userId,
        workspacePath: ctx.workspacePath,
        toolName,
      });

      if (!ctx.abortController.signal.aborted) {
        await this.deps.runService.updateStatus(runId, 'executing_tool');
        await this.deps.sessionService.updateStatus(sessionId, 'running');
      }

      if (userChoice === 'deny') {
        const denyMsg = `Tool "${toolName}" was denied by user.`;
        await this.deps.appendToolResult(ctx, assistantMsg.id, toolCallId, denyMsg);
        this.deps.eventEmitter.emitToolFailed(sessionId, runId, toolCallId, 'Permission denied by user');
        await this.deps.persistToolStatus(assistantMsg, toolCallId, 'failed', denyMsg);
        return;
      }
    }

    if (toolName === 'read_file') {
      const blocked = verificationReadBlocked(toolArgs, guards.fileMutationCounts, guards.postMutationReads);
      if (blocked) {
        this.deps.eventEmitter.emitToolOutput(sessionId, runId, toolCallId, blocked);
        this.deps.eventEmitter.emitToolCompleted(sessionId, runId, toolCallId, { success: true, output: blocked, isError: false });
        await this.deps.appendToolResult(ctx, assistantMsg.id, toolCallId, blocked);
        return;
      }
    }

    const budget = mutationBudgetAllows(toolName, toolArgs, guards.fileMutationCounts);
    if (!budget.allowed) {
      const msg = budget.message!;
      await this.deps.appendToolResult(ctx, assistantMsg.id, toolCallId, msg);
      this.deps.eventEmitter.emitToolFailed(sessionId, runId, toolCallId, `mutation limit reached for ${toolName}`);
      await this.deps.persistToolStatus(assistantMsg, toolCallId, 'failed', msg);
      return;
    }

    const startedAt = Date.now();
    const toolTimeout = AbortSignal.timeout(toolTimeoutMs(toolName));
    const combinedSignal = ctx.abortController.signal.aborted
      ? ctx.abortController.signal
      : AbortSignal.any([ctx.abortController.signal, toolTimeout]);

    // MCP tool dispatch: route <serverName>__<toolName> to the MCP server.
    const mcpServerRef = parseMcpToolName(toolName);
    const isMcpTool = !!mcpServerRef && !!ctx.mcpRuntime?.configs.some((c) => c.name === mcpServerRef.serverName);

    let result: ToolResult;
    if (isMcpTool && ctx.mcpRuntime) {
      const cfg = ctx.mcpRuntime.configs.find((c) => c.name === mcpServerRef!.serverName)!;
      const mcpToolName = mcpServerRef!.toolName;
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
          metadata: { mcpServer: cfg.name, mcpTool: mcpToolName, mcpIcon: cfg.icon ?? null },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result = { success: false, output: `MCP tool error: ${msg}`, isError: true };
      }
    } else {
      // Registry tool dispatch
      result = await this.deps.toolRegistry.execute(toolName, toolArgs, {
        workspaceDir: ctx.projectDir || ctx.workspacePath,
        workspacePath: ctx.workspacePath,
        sessionId,
        runId,
        userId: ids.userId,
        abortSignal: combinedSignal,
        toolCallId,
        workspaceIndex: this.deps.workspaceIndex,
        eventEmitter: this.deps.eventEmitter,
        remoteSsh: ctx.remoteProfileId ? { destinationId: ctx.remoteProfileId, userId: ids.userId } : undefined,
        contextManager: ctx.contextManager,
      });
    }

    try {
      applyMutationBookkeeping(toolName, toolArgs, result, guards.fileMutationCounts, guards);

      await enrichToolResult(toolName, result, { workspacePath: ctx.workspacePath, runId, startedAt });

      // Phase advance from the RESULT: verification failures demote VERIFY → RECOVER.
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

      if (result.isError) {
        this.deps.eventEmitter.emitToolFailed(sessionId, runId, toolCallId, this.firstErrorLine(result.output));
      } else {
        this.deps.eventEmitter.emitToolOutput(sessionId, runId, toolCallId, result.output.slice(0, 2000));
        this.deps.eventEmitter.emitToolCompleted(sessionId, runId, toolCallId, result);
      }

      await this.deps.persistToolStatus(
        assistantMsg,
        toolCallId,
        result.isError ? 'failed' : 'completed',
        result.output.slice(0, 5000),
        result,
      );
    } catch (postErr) {
      this.logger.warn(`Post-execution processing failed for ${toolName}: ${postErr}`);
      this.deps.eventEmitter.emitToolFailed(sessionId, runId, toolCallId, `Tool execution failed: ${postErr}`);
      await this.deps.persistToolStatus(assistantMsg, toolCallId, 'failed', `Tool execution failed: ${postErr}`);
      result.isError = true;
      result.output = `${result.output || ''}\n[TOOL RESULT PROCESSING ERROR: ${postErr}]`;
    }

    if (toolName === 'read_file' && result.metadata?.path) {
      ctx.filesRead.add(String(result.metadata.path));
    }
    if (['write_file', 'apply_patch', 'delete_file', 'replace_lines', 'line_edit'].includes(toolName) && result.metadata?.path) {
      ctx.filesModified.add(String(result.metadata.path));
      for (const t of TOOL_GROUPS.verification) ctx.exposedTools.add(t);
    }

    const storedOutput = await this.deps.compactToolOutput(ctx.workspacePath, runId, toolCallId, result.output);
    await this.deps.appendToolResult(ctx, assistantMsg.id, toolCallId, storedOutput);

    // ── MCP approval pause (USER-ACTIONABLE RECOMMENDATIONS) ───────────────
    // The run PAUSES (status waiting_mcp_approval) until the user enables,
    // adds, or skips via the resolve endpoint — exactly like ask_user. Two
    // triggers:
    //   1. request_mcp_approval — the agent explicitly decided a server is
    //      required and asks the user (always pauses when there is something to
    //      enable/add).
    //   2. inspect_mcp_stock — the suggestion widget surfaces user-actionable
    //      candidates (recommendedToEnable / recommendedToAdd). Previously this
    //      raced ahead while the card sat in the chat asking the user; now the
    //      loop STOPS until the user picks Skip or Add/Continue. Servers the
    //      user already decided about this run (ctx.mcpAskedServerIds) are
    //      filtered out first, so a resolved/skipped server is never re-asked
    //      and this cannot turn into a popup loop across phase boundaries.
    if (
      (toolName === 'request_mcp_approval' || toolName === 'inspect_mcp_stock') &&
      !ctx.abortController.signal.aborted
    ) {
      const stockData = (result.data ?? {}) as {
        task?: string | null;
        servers?: unknown[];
        requestedIds?: string[];
        recommendedToEnableIds?: string[];
        recommendedToAddIds?: string[];
      };
      let toEnable = stockData.recommendedToEnableIds ?? [];
      let toAdd = stockData.recommendedToAddIds ?? [];
      if (toolName === 'inspect_mcp_stock') {
        toEnable = toEnable.filter((id) => !ctx.mcpAskedServerIds.has(id));
        toAdd = toAdd.filter((id) => !ctx.mcpAskedServerIds.has(id));
      }
      const needsDecision = toEnable.length > 0 || toAdd.length > 0;
      if (needsDecision && !result.isError) {
        this.logger.log(
          `[mcp-approval] Pausing run ${runId} (user decision) for task "${String(stockData.task ?? ctx.task ?? '-').slice(0, 160)}" — ` +
            `${toEnable.length} to enable [${toEnable.join(', ')}], ${toAdd.length} to add [${toAdd.join(', ')}]`,
        );
        await this.deps.runService.updateStatus(runId, 'waiting_mcp_approval');
        await this.deps.sessionService.updateStatus(sessionId, 'waiting_mcp_approval');
        this.deps.eventEmitter.emitMcpApprovalRequired(sessionId, runId, toolCallId, {
          task: stockData.task ?? ctx.task ?? null,
          servers: stockData.servers ?? [],
          recommendedToEnableIds: toEnable,
          recommendedToAddIds: toAdd,
        });
        try {
          const decision = await this.deps.waitForMcpDecision(ctx, toolCallId);
          for (const id of [...toEnable, ...toAdd]) ctx.mcpAskedServerIds.add(id);
          if (!ctx.abortController.signal.aborted) {
            await this.deps.runService.updateStatus(runId, 'executing_tool');
            await this.deps.sessionService.updateStatus(sessionId, 'running');
          }
          await this.deps.appendSystemNote(ctx, buildMcpDecisionNote(ctx.task, decision));
          this.deps.eventEmitter.emitMcpResolved(sessionId, runId, toolCallId, decision);
        } catch (pauseErr) {
          this.logger.warn(`[mcp-approval] pause/resume failure for run ${runId}: ${pauseErr}`);
        }
      } else if (toolName === 'request_mcp_approval' && !result.isError) {
        this.logger.log(
          `[mcp-approval] request_mcp_approval requested but nothing to enable/add for run ${runId} — not pausing`,
        );
      }
    }

    const exitCode = typeof result.metadata?.exitCode === 'number' ? result.metadata.exitCode : undefined;
    const isSuccess = !result.isError && (exitCode === undefined || exitCode === 0) && !result.metadata?.timedOut;
    guards.recentToolResults.push({ name: toolName, success: isSuccess, output: result.output.slice(0, 200) });
    if (guards.recentToolResults.length > 6) guards.recentToolResults.shift();

    // Runaway-build guard: consecutive FAILED verification commands.
    const { hardStop, reason } = trackFailedVerification(toolName, isSuccess, guards);
    if (hardStop) {
      ctx.hardStopReason = reason!;
      this.logger.warn(`[run-hard-stop] ${ctx.hardStopReason} (run ${runId})`);
    }

    // No-progress spin guard: byte-identical output means no forward progress.
    const spin = checkSameOutput(toolName, result.output, guards);
    if (spin.spinDetected) {
      turnNotes.push(spin.message!);
    }
  }

  // ── Finalization & phase machine ────────────────────────────────────────
  //
  // Terminal transitions live WITH the loop so finalization stays a run
  // concern (what happens when the run ends), not service glue.

  /**
   * Advances the deterministic phase machine; emits phase.changed + agent.state events.
   */
  private setPhase(ctx: RunContext, next: AgentPhase): void {
    if (next === ctx.phase) return;
    const from = ctx.phase;
    ctx.phase = next;
    this.deps.eventEmitter.emitPhaseChanged(ctx.sessionId, ctx.runId, from, next);

    // Emit structured state events for the UI timeline.
    const { sessionId, runId } = ctx;
    // Mark the previous phase as completed.
    this.deps.eventEmitter.emitAgentState(sessionId, runId, from, 'completed');
    // Mark the new phase as active.
    const detail = phaseDirective(next) ?? undefined;
    this.deps.eventEmitter.emitAgentState(sessionId, runId, next, 'active', detail);
  }

  /** Success finalization: terminal phase + status updates + completion event. */
  private async finalizeRunSuccess(ctx: RunContext, sessionId: string, runId: string): Promise<void> {
    this.setPhase(ctx, 'complete');
    await this.deps.persistContext(ctx);
    await this.deps.runService.updateStatus(runId, 'completed');
    await this.deps.sessionService.updateStatus(sessionId, 'completed');
    this.deps.eventEmitter.emitRunCompleted(sessionId, runId);
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
      await this.deps.persistContext(ctx);
      const reason = err instanceof Error ? err.message : String(err);
      await this.deps.appendAssistantMessage(
        ctx,
        `⚠️ The run stopped unexpectedly: ${reason}\n\nYour work so far is saved. You can reply below to continue.`,
      );
      await this.deps.runService.updateStatus(runId, 'failed');
      await this.deps.sessionService.updateStatus(sessionId, 'failed');
      this.deps.eventEmitter.emitRunFailed(sessionId, runId, reason);
    } catch (finalizeErr) {
      this.logger.error(`Failed to finalize run as failed: ${finalizeErr}`);
      // Last-resort: still pull the session out of 'running' so it is never
      // left permanently live, even if the message/snapshot write failed.
      try { await this.deps.sessionService.updateStatus(sessionId, 'failed'); } catch { /* ignore */ }
    }
  }

  private async finalizeInterrupted(sessionId: string, runId: string): Promise<void> {
    try {
      // Persist an explicit end-of-chat marker so an interrupted session never
      // re-opens as a dangling/empty transcript — the chat stays visible and
      // restorable after a refresh.
      await this.deps.messageService.create(sessionId, 'assistant', '✋ Run interrupted by the user. Your work so far is saved — reply below to continue.');
      await this.deps.runService.updateStatus(runId, 'interrupted');
      await this.deps.sessionService.updateStatus(sessionId, 'interrupted');
      this.deps.eventEmitter.emitRunInterrupted(sessionId, runId, 'user_interrupt');
    } catch (err) {
      this.logger.warn(`finalizeInterrupted: ${err}`);
      // Still pull the session out of 'running' so it is never left stuck live.
      try { await this.deps.sessionService.updateStatus(sessionId, 'interrupted'); } catch { /* ignore */ }
    }
  }
}

/** Builds the system note appended after the user answers an MCP approval
 *  pause, so the agent knows exactly what was enabled / added / skipped. */
function buildMcpDecisionNote(task: string, decision: McpApprovalDecision): string {
  const names = decision.names.length > 0 ? decision.names.join(', ') : '(none)';
  switch (decision.action) {
    case 'enable':
      return `[USER MCP DECISION] The user ENABLED these MCP servers for this task: ${names}. Activate their mcp_<id> sub-contexts (via context_manage) when the step needs them — never rely on tools that aren't in their context yet.`;
    case 'add':
      return `[USER MCP DECISION] The user ADDED these MCP servers: ${names}. Servers created enabled are usable now (activate mcp_<id> sub-contexts as needed); servers created disabled (needing OAuth/keys) are NOT usable until configured on the MCP page.`;
    default:
      return `[USER MCP DECISION] The user SKIPPED the recommended MCP servers${names && names !== '(none)' ? ` (${names} were not enabled/added)` : ''}. Proceed using only the tools already available.`;
  }
}
