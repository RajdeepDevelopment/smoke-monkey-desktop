/**
 * Shared API contracts between the web app and the api-gateway.
 * Type-only package — no runtime code.
 */

export type Role = 'user' | 'assistant' | 'system';

export type DocumentStatus = 'uploading' | 'processing' | 'ready' | 'failed';

export interface UserDto {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface AuthResponseDto {
  accessToken: string;
  user: UserDto;
}

export interface DocumentDto {
  id: string;
  userId: string;
  filename: string;
  status: DocumentStatus;
  chunkCount: number;
  error?: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationDto {
  id: string;
  userId: string;
  title: string;
  createdAt: string;
}

export interface CitationDto {
  documentId: string;
  documentName: string;
  page?: number | null;
  text: string;
  score: number;
  /** Optional source URL (web citations carry one; knowledge chunks don't). */
  url?: string | null;
}

/** One live web result surfaced alongside an answer (from Tavily/Brave/Bing/DDG). */
export interface WebSourceDto {
  title: string;
  url: string;
  content: string;
  provider: string;
  score: number;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  citations?: CitationDto[] | null;
  webSources?: WebSourceDto[] | null;
  confidence?: number | null;
  createdAt: string;
}

/** RAG retrieval depth: trade speed against recall/precision. */
export type RagMode = 'fast' | 'balanced' | 'deep';

/** Stage-level latency breakdown for a single query (ms). */
export interface QueryTimings {
  embedding_ms: number;
  retrieval_ms: number;
  reranker_ms: number;
  llm_ttft_ms: number;
  llm_generation_ms: number;
  total_ms: number;
}

/** SSE event types emitted by the chat stream. */
export type ChatStreamEvent =
  | { type: 'meta'; conversationId: string; provider?: string }
  | { type: 'status'; stage: string; label: string }
  | { type: 'sources'; citations: CitationDto[] }
  | { type: 'web_sources'; sources: WebSourceDto[] }
  | { type: 'chunk'; text: string }
  | { type: 'timings'; timings: QueryTimings }
  | { type: 'done'; messageId: string; citations: CitationDto[]; confidence: number; cached?: boolean; timings?: QueryTimings; webSources?: WebSourceDto[] }
  | { type: 'error'; message: string }
  | { type: 'notice'; message: string };

/** An LLM provider and its selectable models. */
export interface ModelProvider {
  id: string;
  label: string;
  models: string[];
}

/** A model listed in the reference catalog (embedding / rerank / chat). */
export interface CatalogModel {
  id: string;
  name: string;
  provider: string;
  dims?: number;
  isFree?: boolean;
  notes?: string;
}

/** The currently active embedding layer configuration. */
export interface EmbeddingConfig {
  provider: 'openrouter' | 'nvidia' | 'ollama';
  model: string;
  dims: number;
}

/** The currently active rerank layer configuration. */
export interface RerankConfig {
  enabled: boolean;
  provider: 'openrouter' | 'nvidia' | 'ollama' | 'local';
  model: string;
}

/** A single retrieval result as surfaced by the Playground. */
export interface RetrievedChunkDto {
  id: string;
  documentId: string;
  documentName: string;
  page?: number | null;
  section?: string | null;
  content: string;
  score: number;
  denseScore?: number;
  sparseScore?: number;
  rank: number;
}

/** Response from POST /api/playground/retrieve (retrieval-only, no generation). */
export interface RetrieveResponseDto {
  query: string;
  mode: string;
  retrievalCacheHit: boolean;
  timings: QueryTimings;
  chunks: RetrievedChunkDto[];
}

/** Latency percentile bucket (ms). */
export interface LatencyPercentiles {
  p50: number;
  p90: number;
  p95: number;
  p99: number;
}

/** Per-stage average latency (ms). */
export interface StageAverages {
  embeddingMs: number;
  retrievalMs: number;
  rerankerMs: number;
  llmTtftMs: number;
  llmGenerationMs: number;
}

/** Response from GET /api/analytics/metrics (Redis telemetry summary). */
export interface MetricsSummaryDto {
  windowSeconds: number;
  requests: number;
  errors: number;
  errorRate: number;
  totalMsPercentiles: LatencyPercentiles;
  averageMs: number;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;
  byStage: StageAverages;
  byType: Record<string, number>;
  byMode: Record<string, number>;
  byProvider: Record<string, number>;
  recentErrors: string[];
}

/** A recommended model in the dynamic preset catalog (data-driven). */
export interface ModelPreset {
  role: string;
  label: string;
  provider: string;
  providerLabel: string;
  model: string;
  dims?: number;
  rating: number;
  isFree?: boolean;
  notes?: string;
}

/** Response from GET /api/models. */
export interface ModelsResponseDto {
  providers: ModelProvider[];
  defaultProvider: string;
  embedding: EmbeddingConfig;
  rerank: RerankConfig;
  catalog: {
    chatModels: CatalogModel[];
    embeddingModels: CatalogModel[];
    rerankModels: CatalogModel[];
  };
  presets: ModelPreset[];
}

/** A saved user provider key (never contains the raw key). */
export interface UserKeyDto {
  provider: string;
  keyPrefix: string;
  last4: string;
  status: 'ok' | 'invalid';
  createdAt: string;
  updatedAt: string;
}

export interface OpenRouterKeyInfoDto {
  label: string;
  isFreeTier: boolean;
  limit: number | null;
  usage: number | null;
  remaining: number | null;
  rateLimited: boolean;
}
export interface SaveKeyResultDto extends UserKeyDto {
  info: OpenRouterKeyInfoDto | null;
}

export interface UserKeysResponseDto {
  keys: UserKeyDto[];
}

/** Per-user feature settings (stored as Redis flags by the api-gateway). */
export interface UserSettingsDto {
  webSearch: {
    /** Server-level gate (WEB_SEARCH_ENABLED env) — locked when false. */
    serverEnabled: boolean;
    /** The user's own opt-in toggle. */
    enabled: boolean;
  };
  /** Free OmniRoute gateway (local OpenAI-compatible proxy, keyless models). */
  omniroute: {
    /** Server-level gate (OMNIROUTE_ENABLED env) — locked when false. */
    serverEnabled: boolean;
    /** The user's own opt-in toggle. */
    enabled: boolean;
  };
}

/** One model exposed by the local OmniRoute gateway (free/keyless). */
export interface OmniRouteModelDto {
  id: string;
  name: string;
  provider: string;
  isFree: boolean;
}

/** Response from GET /api/models/omniroute (live list from the OmniRoute proxy). */
export interface OmniRouteModelsResponseDto {
  reachable: boolean;
  models: OmniRouteModelDto[];
}

// ── Agent contracts ──────────────────────────────────────────────────────────

export type AgentId = 'build' | 'plan' | 'explore' | 'general';
export type AgentStatus = 'idle' | 'running' | 'waiting_permission' | 'interrupted' | 'completed' | 'failed';

export interface AgentSessionDto {
  id: string;
  userId: string;
  agentId: AgentId;
  title: string;
  status: AgentStatus;
  workspacePath: string;
  messageCount: number;
  totalTokensInput: number;
  totalTokensOutput: number;
  totalCost: number;
  createdAt: string;
  updatedAt: string;
}

export type AgentMessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface AgentToolCallDto {
  id: string;
  toolName: string;
  arguments: unknown;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  result?: unknown;
  error?: string;
}

export interface AgentMessageDto {
  id: string;
  sessionId: string;
  role: AgentMessageRole;
  content: string;
  toolCalls?: AgentToolCallDto[] | null;
  parentMessageId?: string | null;
  tokensInput: number;
  tokensOutput: number;
  createdAt: string;
}

export type AgentRunStatus =
  | 'queued' | 'thinking' | 'executing_tool' | 'waiting_permission'
  | 'recovering' | 'compacting' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface AgentRunDto {
  id: string;
  sessionId: string;
  agentId: string;
  status: AgentRunStatus;
  stepCount: number;
  maxSteps: number;
  tokensInput: number;
  tokensOutput: number;
  cost: number;
  durationMs: number;
  error?: string | null;
  startedAt: string;
  updatedAt: string;
  completedAt?: string | null;
}

export type AgentEventType =
  | 'text.delta' | 'text.end'
  | 'tool.started' | 'tool.output' | 'tool.completed' | 'tool.failed'
  | 'permission.required'
  | 'run.started' | 'run.completed' | 'run.interrupted' | 'run.failed'
  | 'step.started' | 'step.ended'
  | 'todo.updated';

export interface AgentEventDto {
  type: AgentEventType;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface AgentToolDto {
  name: string;
  description: string;
  parameters: unknown;
}

export interface AgentPermissionDto {
  id: string;
  tool: string;
  resource: string;
  effect: 'allow' | 'deny' | 'ask';
  scope: 'once' | 'session' | 'workspace' | 'global';
}
