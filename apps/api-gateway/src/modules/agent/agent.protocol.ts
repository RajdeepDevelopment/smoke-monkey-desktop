// Shared Agent Protocol Types
// Used by both backend WebSocket gateway and Code OSS extension

export interface AgentEvent {
  type: string;
  data: Record<string, unknown>;
  sessionId?: string;
  runId?: string;
  timestamp?: number;
}

export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: ToolCall[] | null;
  createdAt: string;
}

export interface ToolCall {
  id: string;
  toolName: string;
  arguments: Record<string, unknown>;
  status: 'running' | 'completed' | 'failed';
  output?: string;
  result?: unknown;
  error?: string;
}

export interface AgentSession {
  id: string;
  userId: string;
  agentId: string;
  status: 'idle' | 'running' | 'waiting_permission' | 'waiting_user_input' | 'interrupted' | 'completed' | 'failed';
  workspacePath?: string;
  title?: string;
  messageCount: number;
  totalTokensInput: number;
  totalTokensOutput: number;
  totalCost: number;
  createdAt: string;
  updatedAt: string;
}

// WebSocket message types from client to server
export interface WsClientMessage {
  type: 'subscribe' | 'unsubscribe' | 'run' | 'interrupt' | 'resolve_permission' | 'resolve_ask_user' | 'get_messages' | 'get_state' | 'create_session';
  data?: Record<string, unknown>;
}

// WebSocket message types from server to client
export interface WsServerMessage {
  type: string;
  data?: Record<string, unknown>;
  sessionId?: string;
  error?: string;
}

// Event types emitted by the agent
export const AGENT_EVENT_TYPES = {
  TEXT_DELTA: 'text.delta',
  TEXT_END: 'text.end',
  TOOL_STARTED: 'tool.started',
  TOOL_OUTPUT: 'tool.output',
  TOOL_COMPLETED: 'tool.completed',
  TOOL_FAILED: 'tool.failed',
  PERMISSION_REQUIRED: 'permission.required',
  RUN_STARTED: 'run.started',
  RUN_COMPLETED: 'run.completed',
  RUN_INTERRUPTED: 'run.interrupted',
  RUN_FAILED: 'run.failed',
  STEP_STARTED: 'step.started',
  STEP_ENDED: 'step.ended',
  LLM_THINKING: 'llm.thinking',
  ASK_USER_REQUIRED: 'ask_user.required',
  ASK_USER_RESPONSE: 'ask_user.response',
  TODO_UPDATED: 'todo.updated',
  PHASE_CHANGED: 'phase.changed',
  STATE_CHANGED: 'state.changed',
  AGENT_STATE: 'agent.state',
} as const;

export type AgentEventType = typeof AGENT_EVENT_TYPES[keyof typeof AGENT_EVENT_TYPES];
