import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

export interface AgentEvent {
  type: string;
  sessionId: string;
  runId?: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export class AgentEventEmitter {
  private readonly logger = new Logger('AgentEventEmitter');

  constructor(private readonly eventEmitter: EventEmitter2) {}

  emit(sessionId: string, event: Omit<AgentEvent, 'timestamp'>): void {
    const full: AgentEvent = { ...event, timestamp: Date.now() };
    this.eventEmitter.emit(`agent.${event.type}`, full);
    this.eventEmitter.emit(`agent.session.${sessionId}.${event.type}`, full);
  }

  emitRun(sessionId: string, runId: string, type: string, data: Record<string, unknown> = {}): void {
    this.emit(sessionId, { type, sessionId, runId, data });
  }

  emitTextDelta(sessionId: string, runId: string, messageId: string, delta: string): void {
    this.emitRun(sessionId, runId, 'text.delta', { messageId, delta });
  }

  /**
   * Streams the model's internal reasoning/thinking ("Thought phase") as it
   * arrives, so the UI can render a live foldable section while the model is
   * still deliberating. Mirrors text.delta but carries reasoning content.
   */
  emitTextThought(sessionId: string, runId: string, messageId: string, delta: string): void {
    this.emitRun(sessionId, runId, 'text.thought', { messageId, delta });
  }

  emitTextEnd(
    sessionId: string,
    runId: string,
    messageId: string,
    content: string,
    toolCalls?: unknown[],
    reasoning?: string | null,
  ): void {
    this.emitRun(sessionId, runId, 'text.end', { messageId, content, toolCalls, reasoning });
  }

  emitToolStarted(sessionId: string, runId: string, toolCallId: string, toolName: string, args: unknown): void {
    this.emitRun(sessionId, runId, 'tool.started', { toolCallId, toolName, args });
  }

  emitToolOutput(sessionId: string, runId: string, toolCallId: string, output: string): void {
    this.emitRun(sessionId, runId, 'tool.output', { toolCallId, output });
  }

  /**
   * Streams live execution detail for a long-running tool (e.g. write_file
   * writing content chunk-by-chunk, apply_patch applying hunks file-by-file)
   * so the UI can show real progress + a streaming preview while the tool is
   * still running — not just a spinner that stays silent until completion.
   *
   * @param progress - Flat payload (toolName, path, percent, bytes, lines,
   *                   preview, …). The `toolCallId` is merged in automatically.
   */
  emitToolProgress(sessionId: string, runId: string, toolCallId: string, progress: Record<string, unknown>): void {
    this.emitRun(sessionId, runId, 'tool.progress', { toolCallId, ...progress });
  }

  emitToolCompleted(sessionId: string, runId: string, toolCallId: string, result: unknown): void {
    this.emitRun(sessionId, runId, 'tool.completed', { toolCallId, result });
  }

  emitToolFailed(sessionId: string, runId: string, toolCallId: string, error: string): void {
    this.emitRun(sessionId, runId, 'tool.failed', { toolCallId, error });
  }

  emitPermissionRequired(sessionId: string, runId: string, toolCallId: string, toolName: string, args: unknown): void {
    this.emitRun(sessionId, runId, 'permission.required', { toolCallId, toolName, args });
  }

  emitRunStarted(sessionId: string, runId: string, agentId: string): void {
    this.emitRun(sessionId, runId, 'run.started', { agentId });
  }

  emitRunCompleted(sessionId: string, runId: string): void {
    this.emitRun(sessionId, runId, 'run.completed');
  }

  emitRunInterrupted(sessionId: string, runId: string, reason: string): void {
    this.emitRun(sessionId, runId, 'run.interrupted', { reason });
  }

  emitRunFailed(sessionId: string, runId: string, error: string): void {
    this.emitRun(sessionId, runId, 'run.failed', { error });
  }

  emitStepStarted(sessionId: string, runId: string, step: number): void {
    this.emitRun(sessionId, runId, 'step.started', { step });
  }

  emitPhaseChanged(sessionId: string, runId: string, from: string, to: string): void {
    this.emitRun(sessionId, runId, 'phase.changed', { from, to });
  }

  emitStepEnded(sessionId: string, runId: string, step: number): void {
    this.emitRun(sessionId, runId, 'step.ended', { step });
  }

  emitLlmThinking(sessionId: string, runId: string, step: number): void {
    this.emitRun(sessionId, runId, 'llm.thinking', { step });
  }

  emitCompactionStarted(sessionId: string, runId: string, tokensBefore: number): void {
    this.emitRun(sessionId, runId, 'compaction.started', { tokensBefore });
  }

  emitCompactionCompleted(
    sessionId: string,
    runId: string,
    metrics: { tokensBefore: number; tokensAfter: number; tokensSaved: number; messagesCompacted: number; summary?: string },
  ) {
    this.emitRun(sessionId, runId, 'compaction.completed', metrics);
  }

  emitAskUserRequired(sessionId: string, runId: string, toolCallId: string, question: string, options: unknown[], multiple: boolean): void {
    this.emitRun(sessionId, runId, 'ask_user.required', { toolCallId, question, options, multiple });
  }

  emitAskUserResponse(sessionId: string, runId: string, toolCallId: string, response: string): void {
    this.emitRun(sessionId, runId, 'ask_user.response', { toolCallId, response });
  }

  emitTodoUpdated(sessionId: string, runId: string, todos: unknown[]): void {
    this.emitRun(sessionId, runId, 'todo.updated', { todos });
  }

  /**
   * Emits the run's live sub-context state every time the agent opens/closes
   * a context, so the UI streams "frontend_ui opened · backend_scale closed"
   * in real time (same channel as todo.updated).
   */
  emitContextUpdated(
    sessionId: string,
    runId: string,
    active: Array<{ id: string; title: string }>,
    count: number,
    maxActive: number,
  ): void {
    // TEMP DEBUG: verify sub-context switching is emitted (remove after triage).
    this.logger.log(
      `[context.updated] run=${runId} active=[${active.map((a) => a.id).join(', ')}] count=${count}/${maxActive}`,
    );
    this.emitRun(sessionId, runId, 'context.updated', { active, count, maxActive });
  }

  /**
   * Emits a structured agent state event for the UI. Unlike phase.changed
   * (which only fires on transitions), this fires at every meaningful point
   * so the UI can always show the current activity:
   *
   *   ● Understanding task
   *   ✓ Searching codebase
   *   ✓ Reading AuthService
   *   ● Editing files
   *   ○ Running tests
   *   ○ Complete
   *
   * @param status - 'active' (●), 'completed' (✓), 'pending' (○)
   */
  emitAgentState(
    sessionId: string,
    runId: string,
    phase: string,
    status: 'active' | 'completed' | 'pending',
    detail?: string,
  ): void {
    this.emitRun(sessionId, runId, 'agent.state', { phase, status, detail });
  }
}
