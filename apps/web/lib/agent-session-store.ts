/**
 * Module-level "live agent session" store + stream keeper.
 *
 * The chat panel (AgentChat) previously owned both the run loop and every
 * piece of live run state in component-local `useState`. That made the SSE
 * connection live and die with the component — navigating to another page
 * unmounted the panel, aborted the fetch, and threw away the in-progress
 * stream while the backend kept working.
 *
 * This store flips that: the stream loop lives at module scope and is only
 * torn down by an explicit stop. All live run state (streaming text, todos,
 * active contexts, tool activity, permissions, …) is recorded here keyed by
 * session, then *mirrored* into whichever panel is current. Unmounting or
 * switching sessions no longer kills the connection; the panel re-attaches on
 * mount and replays the buffered message events of the active run.
 *
 * Todos and active-contexts are also persisted to localStorage (per session)
 * so they "hold" across full page reloads the way the sub-context does.
 */

import { agentApi, type AgentEvent } from './agent-api';
import { notifyIfBackgrounded } from './notifications';
import { refreshMcpList } from './mcp-store';

export type TodoItem = { content: string; status: string; priority: string };
export type LiveContext = { id: string; title: string };
export type LivePermission = { toolCallId: string; toolName: string; args: unknown };
export type LiveAskUser = {
  toolCallId: string;
  question: string;
  options: Array<{ label: string; description: string }>;
  multiple: boolean;
};
/** A paused MCP approval decision — the run is blocked until the user answers. */
export type LiveMcpDecision = {
  toolCallId: string;
  task: string | null;
  servers: unknown[];
  recommendedToEnableIds: string[];
  recommendedToAddIds: string[];
};
export type LiveCompaction = {
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  messagesCompacted: number;
  summary?: string;
};

export interface SessionLiveState {
  sessionId: string;
  /** True while a run is actively streaming for this session. */
  isRunning: boolean;
  running: boolean;
  /** Epoch ms when the current run started (for the duration ticker). */
  startedAt: number | null;
  streamingText: string;
  streamingThought: string;
  stepCount: number;
  todos: TodoItem[] | null;
  activeContexts: LiveContext[] | null;
  isThinking: boolean;
  isCompacting: boolean;
  lastCompaction: LiveCompaction | null;
  pendingPermission: LivePermission | null;
  pendingAskUser: LiveAskUser | null;
  /** Paused MCP approval decision (run is waiting_mcp_approval). */
  pendingMcpDecision: LiveMcpDecision | null;
  /** Raw payload of the last `mcp.stock` event (typed by the consumer). */
  mcpStock: Record<string, unknown> | null;
  /** Monotonic counter bumped on every `mcp.stock` event. */
  mcpStockSeq: number;
  freeSuggestion: string | null;
  error: string | null;
}

/** Messages that can be rebuilt deterministically from raw events alone. */
function isMessageEvent(e: AgentEvent): boolean {
  const t = e.type;
  return (
    t === 'text.end' ||
    t === 'tool.started' ||
    t === 'tool.output' ||
    t === 'tool.progress' ||
    t === 'tool.completed' ||
    t === 'tool.failed'
  );
}

function looksLikeExhaustion(text: string): boolean {
  const t = (text || '').toLowerCase();
  return /(?:token|credit|quota|credit|balance|limit).*(?:exhaust|insufficient|ran out|run out|depleted|expired|out of)|(?:free).*(?:limit|exhausted|reached)|429|402|insufficient_quota|out of (?:free )?tokens|rate limit|quota exceeded|payment required|no (?:more )?credits/i.test(
    t,
  );
}

function normalizeAskUserOptions(raw: unknown): Array<{ label: string; description: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ label: string; description: string }> = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item.trim()) out.push({ label: item.trim(), description: '' });
    } else if (item && typeof item === 'object') {
      const label = String((item as any).label ?? (item as any).name ?? '').trim();
      if (label) {
        out.push({
          label,
          description: String((item as any).description ?? (item as any).desc ?? '') || '',
        });
      }
    }
  }
  return out;
}

// ── Persistence (per-session, survives a page reload) ────────────────────

const TODOS_KEY = (id: string) => `sm_agent_todos:${id}`;
const CONTEXTS_KEY = (id: string) => `sm_agent_contexts:${id}`;
const PERM_KEY = (id: string) => `sm_agent_perm:${id}`;
const ASK_KEY = (id: string) => `sm_agent_ask:${id}`;
const MCPDEC_KEY = (id: string) => `sm_agent_mcpdec:${id}`;
const MCPSTOCK_KEY = (id: string) => `sm_agent_mcpstock:${id}`;

function readPersisted<T>(key: string): T | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writePersisted(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full / private mode — ignore */
  }
}

// ── Store ────────────────────────────────────────────────────────────────

const MAX_BUFFER = 3000;

const live: Record<string, SessionLiveState> = {};
const controllers: Record<string, AbortController | null> = {};
const buffers: Record<string, AgentEvent[]> = {};
const eventListeners: Record<string, Set<(e: AgentEvent) => void>> = {};

let rev = 0;
const storeListeners = new Set<() => void>();

function defaultState(sessionId: string): SessionLiveState {
  return {
    sessionId,
    isRunning: false,
    running: false,
    startedAt: null,
    streamingText: '',
    streamingThought: '',
    stepCount: 0,
    todos: null,
    activeContexts: null,
    isThinking: false,
    isCompacting: false,
    lastCompaction: null,
    pendingPermission: null,
    pendingAskUser: null,
    mcpStock: null,
    mcpStockSeq: 0,
    freeSuggestion: null,
    error: null,
    pendingMcpDecision: null,
  };
}

function ensureState(sessionId: string): SessionLiveState {
  if (!live[sessionId]) {
    live[sessionId] = {
      ...defaultState(sessionId),
      todos: readPersisted<TodoItem[] | null>(TODOS_KEY(sessionId)) ?? null,
      activeContexts: readPersisted<LiveContext[] | null>(CONTEXTS_KEY(sessionId)) ?? null,
      pendingPermission: readPersisted<LivePermission | null>(PERM_KEY(sessionId)) ?? null,
      pendingAskUser: readPersisted<LiveAskUser | null>(ASK_KEY(sessionId)) ?? null,
      pendingMcpDecision: readPersisted<LiveMcpDecision | null>(MCPDEC_KEY(sessionId)) ?? null,
      mcpStock: readPersisted<Record<string, unknown> | null>(MCPSTOCK_KEY(sessionId)) ?? null,
    };
  }
  return live[sessionId];
}

function bump(): void {
  rev += 1;
  for (const l of storeListeners) l();
}

function bufferPush(sessionId: string, event: AgentEvent): void {
  const buf = buffers[sessionId] ?? (buffers[sessionId] = []);
  buf.push(event);
  if (buf.length > MAX_BUFFER) buf.splice(0, buf.length - MAX_BUFFER);
}

function deliverLive(sessionId: string, event: AgentEvent): void {
  const set = eventListeners[sessionId];
  if (set) {
    for (const cb of Array.from(set)) cb(event);
  }
}

function finalize(
  sessionId: string,
  failed: boolean,
  error: string | null,
  notify: boolean,
): void {
  const st = ensureState(sessionId);
  const controller = controllers[sessionId];

  st.isRunning = false;
  st.running = false;
  st.startedAt = null;
  st.streamingText = '';
  st.streamingThought = '';
  st.isThinking = false;
  st.isCompacting = false;
  st.error = failed ? error : null;
  st.freeSuggestion = failed && error ? (looksLikeExhaustion(error) ? error : null) : null;
  st.pendingPermission = null;
  st.pendingAskUser = null;
  st.pendingMcpDecision = null;
  writePersisted(PERM_KEY(sessionId), null);
  writePersisted(ASK_KEY(sessionId), null);
  writePersisted(MCPDEC_KEY(sessionId), null);
  writePersisted(MCPSTOCK_KEY(sessionId), null);
  if (buffers[sessionId]) buffers[sessionId] = [];

  if (notify) {
    notifyIfBackgrounded(
      failed ? 'Agent failed' : 'Agent finished',
      failed ? 'The agent run failed.' : 'The agent run completed successfully.',
      failed ? 'run-fail' : 'run-done',
    );
  }
  void refreshMcpList();

  // Close the now-idle SSE tail a few moments later so a finished run does not
  // keep a keepalive connection open forever.
  if (controller) {
    setTimeout(() => {
      if (controllers[sessionId] === controller) {
        try {
          controller.abort();
        } catch {
          /* noop */
        }
        controllers[sessionId] = null;
      }
    }, 5000);
  }

  bump();
}

function feed(sessionId: string, event: AgentEvent): void {
  const st = ensureState(sessionId);
  const { type, data } = event;

  switch (type) {
    case 'ping':
      return; // keepalive — nothing to do, don't re-render

    case 'run.started':
      st.isRunning = true;
      st.running = true;
      st.startedAt = st.startedAt ?? Date.now();
      st.stepCount = 0;
      st.isThinking = true;
      st.isCompacting = false;
      st.lastCompaction = null;
      st.streamingThought = '';
      st.streamingText = '';
      st.pendingPermission = null;
      st.pendingAskUser = null;
      st.pendingMcpDecision = null;
      st.mcpStock = null;
      st.error = null;
      st.freeSuggestion = null;
      writePersisted(PERM_KEY(sessionId), null);
      writePersisted(ASK_KEY(sessionId), null);
      writePersisted(MCPDEC_KEY(sessionId), null);
      writePersisted(MCPSTOCK_KEY(sessionId), null);
      buffers[sessionId] = [];
      break;

    case 'step.started':
      st.stepCount = (data.step as number) ?? st.stepCount;
      st.isThinking = true;
      break;

    case 'llm.thinking':
      st.isThinking = true;
      break;

    case 'text.delta':
      st.isThinking = false;
      st.streamingText += (data.delta as string) ?? '';
      break;

    case 'text.thought':
      st.isThinking = false;
      st.streamingThought += (data.delta as string) ?? '';
      break;

    case 'text.end':
      st.isThinking = false;
      st.streamingText = '';
      st.streamingThought = '';
      break;

    case 'compaction.started':
      st.isCompacting = true;
      break;

    case 'compaction.completed':
      st.isCompacting = false;
      st.lastCompaction = {
        tokensBefore: data.tokensBefore as number,
        tokensAfter: data.tokensAfter as number,
        tokensSaved: data.tokensSaved as number,
        messagesCompacted: data.messagesCompacted as number,
        summary: data.summary as string | undefined,
      };
      break;

    case 'context.updated':
      st.activeContexts = Array.isArray(data.active)
        ? (data.active as LiveContext[])
        : [];
      writePersisted(CONTEXTS_KEY(sessionId), st.activeContexts);
      break;

    case 'todo.updated':
      st.todos = Array.isArray(data.todos) ? (data.todos as TodoItem[]) : null;
      writePersisted(TODOS_KEY(sessionId), st.todos);
      break;

    case 'permission.required':
      st.pendingPermission = {
        toolCallId: data.toolCallId as string,
        toolName: data.toolName as string,
        args: data.args,
      };
      writePersisted(PERM_KEY(sessionId), st.pendingPermission);
      notifyIfBackgrounded(
        'Agent needs permission',
        `Allow ${String(data.toolName ?? 'tool')}?`,
        `perm-${String(data.toolCallId ?? '')}`,
      );
      break;

    case 'ask_user.required':
      st.pendingAskUser = {
        toolCallId: data.toolCallId as string,
        question: data.question as string,
        options: normalizeAskUserOptions(data.options),
        multiple: Boolean(data.multiple),
      };
      writePersisted(ASK_KEY(sessionId), st.pendingAskUser);
      notifyIfBackgrounded(
        'Agent needs your input',
        String(data.question ?? '').slice(0, 120),
        `ask-${String(data.toolCallId ?? '')}`,
      );
      break;

    case 'mcp.stock':
      st.mcpStock = (data as unknown as Record<string, unknown>) ?? null;
      st.mcpStockSeq += 1;
      writePersisted(MCPSTOCK_KEY(sessionId), st.mcpStock);
      void refreshMcpList();
      break;

    case 'mcp.approval_required': {
      const payload = ((data.payload as Record<string, unknown>) ?? {}) as Record<string, unknown>;
      st.pendingMcpDecision = {
        toolCallId: data.toolCallId as string,
        task: (payload.task as string | null) ?? null,
        servers: Array.isArray(payload.servers) ? payload.servers : [],
        recommendedToEnableIds: Array.isArray(payload.recommendedToEnableIds)
          ? (payload.recommendedToEnableIds as string[])
          : [],
        recommendedToAddIds: Array.isArray(payload.recommendedToAddIds)
          ? (payload.recommendedToAddIds as string[])
          : [],
      };
      writePersisted(MCPDEC_KEY(sessionId), st.pendingMcpDecision);
      if (st.mcpStock) writePersisted(MCPSTOCK_KEY(sessionId), st.mcpStock);
      notifyIfBackgrounded(
        'Agent needs MCP approval',
        'Enable or add the recommended MCP servers?',
        `mcp-${String(data.toolCallId ?? '')}`,
      );
      void refreshMcpList();
      break;
    }

    case 'mcp.resolved':
      if (st.pendingMcpDecision) {
        st.pendingMcpDecision = null;
        writePersisted(MCPDEC_KEY(sessionId), null);
      }
      break;

    case 'run.completed':
      finalize(sessionId, false, null, true);
      return;

    case 'run.interrupted':
      finalize(sessionId, false, null, false);
      return;

    case 'run.failed':
      finalize(sessionId, true, (data.error as string) ?? 'Agent run failed', true);
      return;

    default:
      break;
  }

  if (isMessageEvent(event)) bufferPush(sessionId, event);
  deliverLive(sessionId, event);
  bump();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Reads a session's event stream until it ends or the run finishes. If the
 * stream drops while the backend still reports running, it probes the session
 * and rejoins (with backoff) instead of orphaning the live state.
 */
async function keepReadingUntilDone(sessionId: string, controller: AbortController): Promise<void> {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    if (controllers[sessionId] !== controller) return;
    try {
      for await (const event of agentApi.streamEvents(sessionId, controller.signal)) {
        if (controllers[sessionId] !== controller) return;
        feed(sessionId, event);
      }
      // Stream closed without a terminal event. If the agent still reports an
      // active run, probe the session and rejoin instead of orphaning it.
      if (!ensureState(sessionId).isRunning) return;
      const session = await agentApi.getSession(sessionId).catch(() => null);
      if (
        session &&
        (session.status === 'completed' ||
          session.status === 'failed' ||
          session.status === 'interrupted' ||
          session.status === 'cancelled')
      ) {
        finalize(
          sessionId,
          session.status === 'failed',
          session.status === 'failed' ? 'Agent run failed' : null,
          session.status !== 'interrupted',
        );
        return;
      }
      await sleep(Math.min(1000 * attempt, 8000));
    } catch (err) {
      if ((err as any)?.name === 'AbortError') return;
      if (controllers[sessionId] !== controller) return;
      await sleep(Math.min(1000 * attempt, 8000));
    }
  }
}

/**
 * Re-attach to a run that a previously-unmounted page missed (e.g. after a
 * full page refresh while the backend is still processing). Joins passively —
 * it never posts a new run, just listens until the run ends.
 */
export async function rejoinRun(sessionId: string): Promise<boolean> {
  const st = ensureState(sessionId);
  if (controllers[sessionId] || st.isRunning) return false;
  if (typeof window === 'undefined') return false;

  const session = await agentApi.getSession(sessionId).catch(() => null);
  if (!session) return false;
  const active =
    session.status === 'running' ||
    session.status === 'waiting_permission' ||
    session.status === 'waiting_user_input' ||
    session.status === 'waiting_mcp_approval';
  if (!active) return false;

  const controller = new AbortController();
  controllers[sessionId] = controller;
  st.isRunning = true;
  st.running = true;
  st.startedAt = Date.now();
  st.isThinking = true;
  bump();

  void keepReadingUntilDone(sessionId, controller).catch(() => {
    /* stream is best-effort */
  });
  return true;
}

// ── Public API ───────────────────────────────────────────────────────────

/** React `useSyncExternalStore` subscription (any session changes re-render). */
export function subscribeAgentStore(listener: () => void): () => void {
  storeListeners.add(listener);
  return () => {
    storeListeners.delete(listener);
  };
}

/** `useSyncExternalStore` snapshot selector. */
export function getAgentStoreRev(): number {
  return rev;
}

/** Immutable snapshot of a session's live state (fresh object each call). */
export function getSessionLive(sessionId: string): SessionLiveState {
  return { ...ensureState(sessionId) };
}

/**
 * Subscribe to a session's stream. The callback is invoked for every event
 * while mounted; on registration the buffered message events of the active
 * run are replayed so a re-attached panel rebuilds mid-run tool cards.
 */
export function subscribeSessionEvents(sessionId: string, cb: (e: AgentEvent) => void): () => void {
  const set = eventListeners[sessionId] ?? (eventListeners[sessionId] = new Set());
  set.add(cb);
  const buffered = buffers[sessionId] ?? [];
  for (const e of buffered) cb(e);
  return () => {
    set.delete(cb);
    if (set.size === 0) delete eventListeners[sessionId];
  };
}

export interface StartRunOptions {
  workspacePath?: string;
  model?: string;
  provider?: string;
  remoteProfileId?: string;
}

/**
 * Start (or rejoin) the live stream + run for a session.
 *
 * The loop is deliberately kept independent of any React component: it keeps
 * reading events until the run finishes or `stopRun` is called, even while no
 * chat panel is mounted.
 */
export async function startRun(
  sessionId: string,
  text: string,
  options?: StartRunOptions,
): Promise<{ started: boolean }> {
  const st = ensureState(sessionId);

  let controller = controllers[sessionId];
  if (controller) {
    if (st.isRunning) return { started: false };
    // Stale idle tail-stream from a finished run — close and reuse the slot.
    try {
      controller.abort();
    } catch {
      /* noop */
    }
  }

  controller = new AbortController();
  controllers[sessionId] = controller;

  Object.assign(st, {
    isRunning: true,
    running: true,
    startedAt: Date.now(),
    streamingText: '',
    streamingThought: '',
    stepCount: 0,
    isThinking: true,
    isCompacting: false,
    lastCompaction: null,
    pendingPermission: null,
    pendingAskUser: null,
    pendingMcpDecision: null,
    mcpStock: null,
    freeSuggestion: null,
    error: null,
  });
  buffers[sessionId] = [];
  writePersisted(PERM_KEY(sessionId), null);
  writePersisted(ASK_KEY(sessionId), null);
  writePersisted(MCPDEC_KEY(sessionId), null);
  writePersisted(MCPSTOCK_KEY(sessionId), null);
  bump();

  const keepReading = () => keepReadingUntilDone(sessionId, controller);

  // Open the connection BEFORE posting the run so no early events are missed.
  void keepReading().catch(() => {
    /* stream is best-effort */
  });

  await sleep(50);
  try {
    await agentApi.runAgent(sessionId, text, options);
  } catch (err: any) {
    if (err?.name !== 'AbortError' && controllers[sessionId] === controller) {
      st.isRunning = false;
      st.running = false;
      st.startedAt = null;
      st.error = err instanceof Error ? err.message : 'Failed to start agent';
      bump();
    }
  }
  return { started: true };
}

/**
 * Explicit stop (Stop button). The only thing that tears down the stream —
 * unmounting or switching sessions never does.
 */
export async function stopRun(sessionId: string): Promise<void> {
  const st = ensureState(sessionId);
  const c = controllers[sessionId];
  if (c) {
    try {
      c.abort();
    } catch {
      /* noop */
    }
  }
  controllers[sessionId] = null;
  try {
    await agentApi.interrupt(sessionId);
  } catch {
    /* run may have already finished */
  }
  st.isRunning = false;
  st.running = false;
  st.startedAt = null;
  st.streamingText = '';
  st.streamingThought = '';
  st.isThinking = false;
  bump();
}

export function clearLivePermission(sessionId: string): void {
  const st = ensureState(sessionId);
  if (st.pendingPermission || st.pendingAskUser) {
    st.pendingPermission = null;
    st.pendingAskUser = null;
    writePersisted(PERM_KEY(sessionId), null);
    writePersisted(ASK_KEY(sessionId), null);
    bump();
  }
}

export function clearLiveAskUser(sessionId: string): void {
  const st = ensureState(sessionId);
  if (st.pendingAskUser) {
    st.pendingAskUser = null;
    writePersisted(ASK_KEY(sessionId), null);
    bump();
  }
}

export function clearLiveMcpDecision(sessionId: string): void {
  const st = ensureState(sessionId);
  if (st.pendingMcpDecision) {
    st.pendingMcpDecision = null;
    writePersisted(MCPDEC_KEY(sessionId), null);
    bump();
  }
}

export function clearLiveFreeSuggestion(sessionId: string): void {
  const st = ensureState(sessionId);
  if (st.freeSuggestion) {
    st.freeSuggestion = null;
    bump();
  }
}

export function clearLiveMcpStock(sessionId: string): void {
  const st = ensureState(sessionId);
  if (st.mcpStock) {
    st.mcpStock = null;
    writePersisted(MCPSTOCK_KEY(sessionId), null);
    bump();
  }
}