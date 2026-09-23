import { Logger } from '@nestjs/common';

export type PermissionEffect = 'allow' | 'deny' | 'ask';

export interface ToolContext {
  sessionId: string;
  runId: string;
  workspaceDir: string;
  workspacePath: string;
  userId: string;
  abortSignal: AbortSignal;
  /** The ID of the specific tool call being executed (for event routing). */
  toolCallId?: string;
  /** SQLite-backed workspace index for fast symbol/reference lookups. */
  workspaceIndex?: import('../services/workspace-index').WorkspaceIndex;
  /** Event emitter for real-time UI updates (tool.output, context.updated, etc.). */
  eventEmitter?: import('../services/agent-event.emitter').AgentEventEmitter;
  /** When set, commands should execute on the remote host (SSH profile). */
  remoteSsh?: { destinationId: string; userId: string };
  /**
   * The run's live sub-context manager. context_manage mutates it in place;
   * the next loop iteration re-renders the panel and feeds new guidance.
   */
  contextManager?: import('../context/sub-context').SubContextManager;
}

export interface ToolContent {
  type: 'text' | 'image';
  text?: string;
  data?: string;
  mimeType?: string;
}

/** Pointer to on-disk output the LLM can read_file when it needs details. */
export interface ToolArtifact {
  path: string;
}

export interface ToolMetadata {
  durationMs?: number;
  exitCode?: number | null;
  timedOut?: boolean;
  files?: string[];
  [key: string]: unknown;
}

export interface ToolResult {
  success?: boolean;
  /** Full tool payload for the LLM — kept compact; oversized output spills to `artifact`. */
  output?: string;
  /** One-line human/LLM-facing summary (UI, events, snapshot notes). */
  summary?: string;
  /** Structured payload for UI/future consumers — never sent to the LLM verbatim. */
  data?: unknown;
  artifact?: ToolArtifact;
  metadata?: ToolMetadata;
  content?: ToolContent[];
  isError?: boolean;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | {
    content: ToolContent[];
    isError?: boolean;
  }>;
}

export interface AgentTool {
  name: string;
  description: string;
  parameterSchema: Record<string, unknown>;
  permissionAction: string;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

function definitionToAgentTool(def: ToolDefinition): AgentTool {
  return {
    name: def.name,
    description: def.description,
    parameterSchema: def.inputSchema,
    permissionAction: def.annotations?.destructiveHint ? 'ask' : 'allow',
    execute: async (input, ctx) => {
      // Both union members are ToolResult-compatible; unify for field access.
      const result = (await def.execute(input, ctx)) as ToolResult;
      const textParts = (result.content ?? [])
        .filter(c => c.type === 'text' && c.text)
        .map(c => c.text);
      const output = textParts.join('\n') || '(no output)';
      return {
        success: !result.isError,
        output,
        summary: result.summary,
        data: result.data,
        artifact: result.artifact,
        metadata: result.metadata ?? {},
        content: result.content,
        isError: result.isError,
      };
    },
  };
}

export class ToolRegistry {
  private readonly logger = new Logger(ToolRegistry.name);
  private readonly tools = new Map<string, AgentTool>();

  register(toolOrDef: AgentTool | ToolDefinition): void {
    const tool = 'inputSchema' in toolOrDef ? definitionToAgentTool(toolOrDef as ToolDefinition) : toolOrDef as AgentTool;
    this.tools.set(tool.name, tool);
    this.logger.debug(`Registered tool: ${tool.name}`);
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  getAll(): AgentTool[] {
    return Array.from(this.tools.values());
  }

  getDefinitions(only?: Set<string>): Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }> {
    return Array.from(this.tools.values())
      .filter((t: AgentTool) => !only || only.has(t.name))
      .map((t: AgentTool) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameterSchema,
      }));
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, output: `Unknown tool: ${name}` };
    }

    if (ctx.abortSignal.aborted) {
      return { success: false, output: 'Tool execution cancelled' };
    }

    try {
      const result = await tool.execute(input, ctx);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Tool ${name} failed: ${message}`);
      // isError MUST be set: downstream treats thrown failures as real
      // failures (ToolFailed event, 'failed' status, phase demotion to
      // RECOVER, completion detection). Without it a crashed tool would be
      // disguised as a success.
      return { success: false, output: `Error: ${message}`, isError: true };
    }
  }
}
