import { Injectable, Logger, ConflictException, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fsp from 'fs/promises';
import { AgentMessageService } from './agent-message.service';
import { AgentRunService } from './agent-run.service';
import { AgentSessionService } from './agent-session.service';
import { AgentPermissionService } from './agent-permission.service';
import { AgentEventEmitter } from './agent-event.emitter';
import { ToolRegistry } from '../tools/tool-registry';
import { ContextCompactionService } from './compaction.service';
import { WorkspaceIndex } from './workspace-index';
import { AgentConfigService } from './agent-config.service';
import { ApiKeysService } from '../../keys/api-keys.service';
import { SecretsService } from '../../secrets/secrets.service';
import { McpService, McpRuntime } from '../../mcp/mcp.service';
import { listStockCategories, countStock } from '../../mcp/mcp-stock';
import { ExplorerService } from './subagent.service';
import {
  COMPACTION_INTERVAL,
  COMPACTION_THRESHOLD,
  KEEP_RECENT_MESSAGES,
  LLMMessage,
  PHASE_TOOLS,
  RUN_HISTORY_LIMIT,
  RunContext,
  ContextSnapshot,
  classifyTaskGroups,
  createEmptySnapshot,
  estimateTokens,
  initialPhase,
  phaseDirective,
  resolveExposedTools,
  resolveProjectDir,
  resolveTokenBudget,
  snapshotToSystemMessage,
} from './run-context';
import { AgentMessage, ToolCallJson } from '../entities/agent-message.entity';
import { PermissionEffect } from '../entities/agent-permission.entity';
import {
  SubContextManager,
  renderContextPanel,
  recommendSubContextsForTask,
} from '../context/sub-context';
import {
  SmAgent,
  renderPromptTop,
  type BuildSystemPromptOptions,
} from '../lib';
import { sanitizeFileMarkers } from '../lib/sanitize-assets';
import {
  AgentLoop,
  MAX_STEPS,
  type AgentLoopDeps,
  type CreateRunContextArgs,
  type McpApprovalDecision,
} from './agent-loop';
import { LLMClient } from './llm-client';

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

  /** Env-controlled AUTO context activation: the task→regex auto-open of sub-contexts
   *  at run start AND the MCP memory server always-on. Both default OFF — only the
   *  agent activates sub-contexts (via context_manage). Set AUTO_CONTEXT_ACTIVATION=true
   *  in the gateway env to re-enable either. */
  private get autoContextActivation(): boolean {
    const v = this.config.get('AUTO_CONTEXT_ACTIVATION');
    return v === true || v === 'true' || v === '1';
  }

  /** Env-controlled sub-context panel injection (SUB_CONTEXT_PANEL_ENABLED, default true).
   *  When false, the per-call SUB-CONTEXT PANEL and the prompt-top sub-context
   *  activation statements are NOT injected into the system message — the agent
   *  then relies purely on MCP activation (context_manage for mcp_<id>) and the
   *  static system prompt. Set SUB_CONTEXT_PANEL_ENABLED=false to disable. */
  private get subContextPanelEnabled(): boolean {
    const v = this.config.get('SUB_CONTEXT_PANEL_ENABLED');
    return v === undefined || v === true || v === 'true' || v === '1';
  }

  /** All LLM transport (provider routing, keys, streaming, retries) lives behind this client. */
  private readonly llmClient: LLMClient;

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
    private readonly config: ConfigService,
  ) {
    this.llmClient = new LLMClient({
      apiKeyService: this.apiKeyService,
      eventEmitter: this.eventEmitter,
      getActiveRunSignal: (sessionId?: string) =>
        sessionId ? this.activeRuns.get(sessionId)?.signal : undefined,
    });
  }

  private readonly pendingAskUser = new Map<string, { resolve: (response: string) => void }>();

  /** Paused MCP approval decisions, keyed by toolCallId (like pendingAskUser).
   *  resolveMcpDecision() wakes the paused run with the user's choice. */
  private readonly pendingMcpDecisions = new Map<
    string,
    { sessionId: string; resolve: (decision: McpApprovalDecision) => void }
  >();

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

    try {
      // The ENTIRE agentic loop — LLM turns, tool resolution + execution, loop
      // guards, completion detection, and terminal finalization — lives in the
      // AgentLoop library. This service only wires in the loop's plumbing via
      // deps (persistence, context building, LLM transport, events).
      const loop = new AgentLoop(this.buildAgentLoopDeps());
      await loop.execute({
        sessionId,
        runId,
        userId,
        message,
        workspacePath,
        agentId,
        model,
        provider,
        remoteProfileId,
        abortController,
      });
    } finally {
      this.activeRuns.delete(sessionId);
      this.activeSessionRuns.delete(sessionId);
    }
  }

  /**
   * Builds the framework/plumbing hooks the AgentLoop library calls back into.
   * Everything here is bound to this service so the loop stays Nest-free.
   */
  private buildAgentLoopDeps(): AgentLoopDeps {
    return {
      toolRegistry: this.toolRegistry,
      workspaceIndex: this.workspaceIndex,
      eventEmitter: this.eventEmitter,
      permissionService: this.permissionService,
      runService: this.runService,
      sessionService: this.sessionService,
      messageService: this.messageService,
      compactionService: this.compactionService,

      createRunContext: this.createRunContext.bind(this),
      buildLLMMessages: this.buildLLMMessages.bind(this),
      appendAssistantMessage: this.appendAssistantMessage.bind(this),
      appendToolResult: this.appendToolResult.bind(this),
      appendSystemNote: this.appendSystemNote.bind(this),
      compactToolOutput: this.compactToolOutput.bind(this),
      callLLMWithRetry: this.llmClient.callWithRetry.bind(this.llmClient),
      maybeCompact: this.maybeCompact.bind(this),
      persistContext: this.persistContext.bind(this),

      waitForUserResponse: this.waitForUserResponse.bind(this),
      waitForPermission: this.waitForPermission.bind(this),
      waitForMcpDecision: this.waitForMcpDecision.bind(this),
      persistToolStatus: this.persistToolStatus.bind(this),
    };
  }

  // ── RunContext lifecycle ────────────────────────────────────────────────

  /**
   * Builds the run's entire starting context with ONE history read.
   * Layout: SYSTEM PROMPT → SNAPSHOT SUMMARY → REPLAYED RECENT MESSAGES
   * (the current user request arrives as the newest replayed row).
   */
  private async createRunContext(args: CreateRunContextArgs): Promise<RunContext> {
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

    // Auto-provision the bundled keyless skill MCPs (agent-skills-*) BEFORE the
    // MCP listing + system prompt so this run already sees them as configured
    // and enabled — the agent can then start them via context_manage without
    // pausing on request_mcp_approval.
    await this.mcpService.ensureAutoProvisioned(args.userId).catch((err) =>
      this.logger.warn(`MCP auto-provision skipped: ${err instanceof Error ? err.message : err}`),
    );

    // MCP server configs (lightweight DB read, full runtime built later)
    const mcpConfigs = await this.mcpService.listServers(args.userId)
      .then(servers => servers.map(s => ({ name: s.name, description: s.description, enabled: s.enabled })))
      .catch(() => [] as Array<{ name: string; description: string; enabled: boolean }>);
    const mcpConfigured = new Map(mcpConfigs.map(c => [c.name.trim().toLowerCase(), c.enabled]));
    const mcp = {
      configured: mcpConfigs.length > 0,
      servers: mcpConfigs,
      categories: listStockCategories(),
      stockCount: countStock(),
    };

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

    // Sub-context feeder: the initial set (0-4) is AUTO-SELECTED from the
    // task so sub-contexts ALWAYS open and render on every run. The agent then
    // adjusts it mid-run with context_manage as the task's context changes.
    // When the SESSION already has an active set persisted from a previous run,
    // that set WINS — the guidance is not reset between runs; only the LLM
    // removes a sub-context via context_manage(deactivate).
    const recommendedContexts = this.autoContextActivation
      ? recommendSubContextsForTask(args.task, toolGroups)
      : [];
    const persistedActive = (prevSnapshot.activeSubContexts || []).filter((id) => typeof id === 'string');
    // The MCP runtime MUST be built before the SubContextManager so persisted
    // mcp_<id> sub-contexts can be re-activated below — the manager rejects any
    // id that isn't registered yet (constructor runs before servers are known).
    const mcpRuntime = await this.mcpService.buildRuntime(args.userId).catch((): undefined => undefined);

    // Static (non-MCP) persisted contexts feed the constructor safely. MCP ids
    // are separated out and re-opened AFTER registration, so the guidance set
    // from the previous run survives into this one instead of being dropped.
    const staticPersisted = persistedActive.filter((id) => !id.startsWith('mcp_'));
    const persistedMcpIds = persistedActive.filter((id) => id.startsWith('mcp_'));
    const initialContexts = staticPersisted.length > 0 ? staticPersisted : recommendedContexts;
    if (staticPersisted.length > 0) {
      this.logger.log(`Resuming session with previously-active sub-contexts: ${staticPersisted.join(', ')}`);
    } else if (recommendedContexts.length > 0) {
      this.logger.log(`Auto-opened sub-contexts for this run: ${recommendedContexts.join(', ')}`);
    }
    const contextManager = new SubContextManager(initialContexts);

    // MCP runtime: load all enabled servers and register as dynamic sub-contexts
    // the agent can activate/deactivate (max MAX_ACTIVE_MCP at a time). Memory servers are
    // auto-activated on every run so the agent always has persistent memory.
    if (mcpRuntime) {
      for (const cfg of mcpRuntime.configs) {
        contextManager.registerMcpServer(
          `mcp_${cfg.id}`,
          cfg.name,
          cfg.description || `MCP server: ${cfg.name}`,
        );
      }
      // Re-open MCP sub-contexts the previous run left active. They are now
      // registered (unlike when the constructor ran), so the persisted set
      // survives into the next run just like static sub-contexts do.
      for (const id of persistedMcpIds) {
        const reopened = contextManager.activate(id);
        if (reopened.ok) {
          this.logger.log(`Re-opened persisted MCP sub-context: ${id}`);
        }
      }
      if (this.autoContextActivation) {
        for (const cfg of mcpRuntime.configs) {
          const name = cfg.name.toLowerCase();
          if (name === 'memory-mcp' || name.includes('memory') || name.includes('knowledge graph')) {
            const opened = contextManager.activate(`mcp_${cfg.id}`);
            if (opened.ok) {
              this.logger.log(`MCP memory server auto-activated: ${cfg.name}`);
            }
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
      mcpAskedServerIds: new Set<string>(),
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
      mcpConfigured,
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
    // Local (non-remote) runs: reject <file-SM-st> markers that point at files
    // which do not exist on disk, so the UI never shows a downloadable card for
    // a hallucinated path. Remote profiles run server-side — trusted as-is.
    const safeContent = ctx.remoteProfileId
      ? content
      : sanitizeFileMarkers(content, ctx.projectDir || ctx.workspacePath);
    const msg = await this.messageService.create(ctx.sessionId, 'assistant', safeContent, {
      toolCalls,
      tokensInput: usage?.prompt_tokens || 0,
      tokensOutput: usage?.completion_tokens || 0,
      reasoning: reasoning || null,
    });
    ctx.messages.push({
      role: 'assistant',
      content: safeContent,
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
    const sections: string[] = [];

    if (this.subContextPanelEnabled) {
      sections.push(renderPromptTop(ctx.agentId, ctx.contextManager));
    }

    sections.push(ctx.systemPrompt);

    const snapMsg = snapshotToSystemMessage(ctx.snapshot);
    if (snapMsg?.content) sections.push(snapMsg.content);

    const runtimePolicy = this.buildRuntimePolicy(ctx);
    if (runtimePolicy) sections.push(runtimePolicy);

    // Context feeder (optional via SUB_CONTEXT_PANEL_ENABLED): surface the
    // ACTIVE/AVAILABLE panel so the model sees its current sub-context state.
    if (this.subContextPanelEnabled) {
      sections.push(renderContextPanel(ctx.contextManager, ctx.snapshot.task, ctx.mcpConfigured));
    }

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

  private waitForMcpDecision(ctx: RunContext, toolCallId: string): Promise<McpApprovalDecision> {
    return new Promise<McpApprovalDecision>((resolve) => {
      const signal = ctx.abortController.signal;
      const finish = (value: McpApprovalDecision) => {
        signal.removeEventListener('abort', onAbort);
        this.pendingMcpDecisions.delete(toolCallId);
        resolve(value);
      };
      const onAbort = (): void => finish({ action: 'skip', names: [] });
      if (signal.aborted) return resolve({ action: 'skip', names: [] });
      signal.addEventListener('abort', onAbort, { once: true });
      this.pendingMcpDecisions.set(toolCallId, { sessionId: ctx.sessionId, resolve: finish });
    });
  }

  /** Wakes a run paused on an MCP approval decision. Returns false if there was
   *  no pending decision for that toolCallId. */
  resolveMcpDecision(sessionId: string, toolCallId: string, decision: McpApprovalDecision): boolean {
    const pending = this.pendingMcpDecisions.get(toolCallId);
    if (!pending) return false;
    if (pending.sessionId !== sessionId) return false;
    pending.resolve(decision);
    this.pendingMcpDecisions.delete(toolCallId);
    return true;
  }

  /** Whether the given session currently has an unanswered MCP approval pause. */
  hasPendingMcpDecision(sessionId: string): boolean {
    for (const pending of this.pendingMcpDecisions.values()) {
      if (pending.sessionId === sessionId) return true;
    }
    return false;
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
   * Persists the run's durable context snapshot, including the CURRENTLY ACTIVE
   * sub-contexts so the next run on the same session resumes the same guidance
   * set (only the LLM removes a sub-context via context_manage deactivate).
   */
  async persistContext(ctx: RunContext): Promise<void> {
    try {
      const activeIds = [...ctx.contextManager.activeIds];
      ctx.snapshot.activeSubContexts = activeIds;
      ctx.snapshot.activeContexts = activeIds.map((id) => {
        const c = ctx.contextManager.resolve(id);
        return { id, title: c?.title ?? id };
      });
      await this.sessionService.saveContextSnapshot(
        ctx.sessionId,
        ctx.snapshot as unknown as Record<string, unknown>,
      );
    } catch (err) {
      this.logger.warn(`Failed to persist context snapshot for session ${ctx.sessionId}: ${err}`);
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


  private async getSystemPrompt(
    agentId: string,
    workspacePath?: string,
    projectDir?: string,
    opts?: BuildSystemPromptOptions,
  ): Promise<string> {
    const agent = new SmAgent({
      agentId,
      workspacePath,
      projectDir,
      huggingFace: opts?.huggingFace,
      mcp: opts?.mcp,
      deps: {
        loadProjectConfig: (path) => this.agentConfigService.toSystemMessage(path),
        warn: (message: string) => this.logger.warn(message),
      },
    });
    return agent.buildSystemPrompt();
  }
}
