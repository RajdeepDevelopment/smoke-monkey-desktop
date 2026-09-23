import { SEARCH_FAMILY_TOOLS } from './run-context';

// ── Constants ────────────────────────────────────────────────────────────────

/** Same tool + same args N times consecutively → doom loop. */
const DOOM_LOOP_THRESHOLD = 1000;

/**
 * When this many consecutive tool calls belong to SEARCH_FAMILY_TOOLS,
 * the model is stuck "looking for something" and must be nudged to act.
 */
const SEARCH_FAMILY_LOOP_THRESHOLD = 1000;

/** Consecutive identical outputs before flagging no-progress spin. */
const SAME_OUTPUT_THRESHOLD = 101;

/** Consecutive empty LLM responses tolerated with tool progress. */
const MAX_EMPTY_RETRIES_WITH_PROGRESS = 5;

/** Consecutive empty LLM responses tolerated without tool progress. */
const MAX_EMPTY_RETRIES_NO_PROGRESS = 3;

/** Per-file mutation cap for the whole run. */
const FILE_MUTATION_LIMIT = 200;

/**
 * Consecutive verification commands (builds/tests/typecheck) that FAILED without
 * any successful file mutation in between — stop the run.
 */
const MAX_CONSECUTIVE_FAILED_VERIFICATIONS = 5;

// ── RunGuards state ──────────────────────────────────────────────────────────

export interface RunGuards {
  errorHistory: string[];
  toolCallCounts: Map<string, number>;
  recentToolCalls: Array<{ name: string; args: string }>;
  recentToolResults: Array<{ name: string; success: boolean; output: string }>;
  postMutationReads: Map<string, number>;
  fileMutationCounts: Map<string, number>;
  noToolStreak: number;
  searchFamilyStreak: number;
  emptyStreak: number;
  sameOutputStreak: number;
  lastOutputSignature: string;
  consecutiveFinalReports: number;
  consecutiveFailedVerifications: number;
}

export function createRunGuards(): RunGuards {
  return {
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
}

// ── Peek checks (no mutation) ────────────────────────────────────────────────

/**
 * Pure peek used by the parallel gate — returns true if executing this tool
 * call would trip a loop guard. Does NOT mutate guard state.
 */
export function wouldTripLoopGuards(
  toolName: string,
  toolArgs: Record<string, unknown>,
  guards: RunGuards,
): boolean {
  const argsKey = JSON.stringify(toolArgs);
  const window = [...guards.recentToolCalls.slice(-(DOOM_LOOP_THRESHOLD - 1)), { name: toolName, args: argsKey }];
  if (
    window.length >= DOOM_LOOP_THRESHOLD &&
    window.slice(-DOOM_LOOP_THRESHOLD).every((t) => t.name === toolName && t.args === argsKey)
  ) {
    return true;
  }
  if (SEARCH_FAMILY_TOOLS.has(toolName)) {
    if (guards.searchFamilyStreak + 1 >= SEARCH_FAMILY_LOOP_THRESHOLD) {
      return true;
    }
  }
  return false;
}

// ── Doom loop ────────────────────────────────────────────────────────────────

export interface DoomLoopCheckResult {
  blocked: boolean;
  message?: string;
}

/**
 * Checks if the tool call is a doom loop (same tool + same args N times consecutively).
 * Returns { blocked: true, message } when the call should be skipped.
 */
export function checkDoomLoop(
  toolName: string,
  toolArgs: Record<string, unknown>,
  guards: RunGuards,
): DoomLoopCheckResult {
  const argsKey = JSON.stringify(toolArgs);
  guards.recentToolCalls.push({ name: toolName, args: argsKey });
  if (guards.recentToolCalls.length > DOOM_LOOP_THRESHOLD) guards.recentToolCalls.shift();

  if (
    guards.recentToolCalls.length >= DOOM_LOOP_THRESHOLD &&
    guards.recentToolCalls.slice(-DOOM_LOOP_THRESHOLD).every((tc) => tc.name === toolName && tc.args === argsKey)
  ) {
    guards.recentToolCalls.length = 0;
    return {
      blocked: true,
      message: `SKIPPED ${toolName}: doom-loop guard tripped (same tool+args repeated ${DOOM_LOOP_THRESHOLD}× consecutively). Change approach before retrying.`,
    };
  }
  return { blocked: false };
}

// ── Search family loop ───────────────────────────────────────────────────────

export interface SearchLoopCheckResult {
  blocked: boolean;
  message?: string;
}

/**
 * Tracks the search-family streak and returns { blocked: true } when the agent
 * is stuck searching without acting.
 */
export function checkSearchFamilyLoop(
  toolName: string,
  guards: RunGuards,
): SearchLoopCheckResult {
  if (SEARCH_FAMILY_TOOLS.has(toolName)) {
    guards.searchFamilyStreak++;
  } else {
    guards.searchFamilyStreak = 0;
  }

  if (guards.searchFamilyStreak >= SEARCH_FAMILY_LOOP_THRESHOLD) {
    guards.searchFamilyStreak = 0;
    return {
      blocked: true,
      message: `SKIPPED ${toolName}: search-family loop detected (${SEARCH_FAMILY_LOOP_THRESHOLD} consecutive search/list calls). Take action instead of searching more.`,
    };
  }
  return { blocked: false };
}

// ── Same output spin ─────────────────────────────────────────────────────────

export interface SameOutputCheckResult {
  spinDetected: boolean;
  message?: string;
}

/**
 * Checks if the tool output is identical to the previous one (no-progress spin).
 * Updates internal streak state. Returns { spinDetected: true } when the agent
 * should be nudged to change approach.
 */
export function checkSameOutput(
  toolName: string,
  output: string,
  guards: RunGuards,
): SameOutputCheckResult {
  const outputSig = output.slice(0, 200);
  if (outputSig && outputSig === guards.lastOutputSignature) {
    guards.sameOutputStreak++;
    if (guards.sameOutputStreak >= SAME_OUTPUT_THRESHOLD) {
      guards.sameOutputStreak = 0;
      return {
        spinDetected: true,
        message:
          `DUPLICATE OUTPUT DETECTED: Tool "${toolName}" returned the identical output ${SAME_OUTPUT_THRESHOLD}+ times in a row without any change. ` +
          `You are not making progress. STOP repeating this call and change your approach — read a different file, edit code, run a different command, or provide a final answer.`,
      };
    }
  } else {
    guards.sameOutputStreak = 0;
    guards.lastOutputSignature = outputSig;
  }
  return { spinDetected: false };
}

// ── Empty response ───────────────────────────────────────────────────────────

export interface EmptyResponseCheckResult {
  shouldFinalize: boolean;
  retriesLeft: number;
}

/**
 * Determines whether an empty LLM response (no content, no tool calls)
 * should finalize the run or allow retries.
 */
export function checkEmptyResponse(guards: RunGuards): EmptyResponseCheckResult {
  const hasToolProgress = guards.recentToolResults.length > 0;
  const budget = hasToolProgress ? MAX_EMPTY_RETRIES_WITH_PROGRESS : MAX_EMPTY_RETRIES_NO_PROGRESS;
  const shouldFinalize = guards.emptyStreak >= budget;
  const retriesLeft = Math.max(0, budget - guards.emptyStreak);
  return { shouldFinalize, retriesLeft };
}

/**
 * Returns the cooldown delay (ms) before retrying after an empty response.
 * Uses exponential backoff.
 */
export function emptyResponseDelay(streak: number): number {
  return Math.min(6_000, 800 * 2 ** (streak - 1));
}

// ── Failed verification ──────────────────────────────────────────────────────

/**
 * Tracks consecutive failed verification commands (run_command / run_test).
 * Returns true when the hard-stop threshold is reached (the run should be
 * terminated as failed).
 */
export function trackFailedVerification(
  toolName: string,
  isSuccess: boolean,
  guards: RunGuards,
): { hardStop: boolean; reason?: string } {
  if (!isSuccess && (toolName === 'run_command' || toolName === 'run_test')) {
    guards.consecutiveFailedVerifications++;
    if (guards.consecutiveFailedVerifications >= MAX_CONSECUTIVE_FAILED_VERIFICATIONS) {
      return {
        hardStop: true,
        reason: `Stopping: the ${toolName} command has failed ${guards.consecutiveFailedVerifications} times in a row ` +
          `(${MAX_CONSECUTIVE_FAILED_VERIFICATIONS} consecutive verification failures) without a successful fix. ` +
          `The run is finalizing as failed because it is stuck re-running a failing check.`,
      };
    }
  }
  return { hardStop: false };
}

// ── Mutation bookkeeping ─────────────────────────────────────────────────────

const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'line_edit', 'replace_lines', 'apply_patch']);

/** Returns true when the tool is a file-mutating tool. */
export function isMutatingTool(toolName: string): boolean {
  return MUTATING_TOOLS.has(toolName);
}

/** Returns the first file path a mutating tool targets. */
export function mutatingTargetPath(toolName: string, toolArgs: Record<string, unknown>): string {
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

/**
 * Per-file mutation budget: returns true when the file can still be mutated.
 * When false, the mutation has hit FILE_MUTATION_LIMIT.
 */
export function mutationBudgetAllows(
  toolName: string,
  toolArgs: Record<string, unknown>,
  counts: Map<string, number>,
): { allowed: boolean; message?: string } {
  if (!MUTATING_TOOLS.has(toolName)) return { allowed: true };
  const path = mutatingTargetPath(toolName, toolArgs);
  if (!path) return { allowed: true };
  const used = counts.get(path) || 0;
  if (used < FILE_MUTATION_LIMIT) return { allowed: true };
  return {
    allowed: false,
    message:
      `BLOCKED: "${path}" has already been modified ${used} times in this run (limit ${FILE_MUTATION_LIMIT}). ` +
      `The current content stands as final. Do NOT modify this file again — produce your final summary now.`,
  };
}

/**
 * Counts successful mutations and appends anti-loop guidance into the tool output.
 */
export function applyMutationBookkeeping(
  toolName: string,
  toolArgs: Record<string, unknown>,
  result: { isError?: boolean; output?: string },
  counts: Map<string, number>,
  guards?: RunGuards,
): void {
  if (result.isError || !result.output || !MUTATING_TOOLS.has(toolName)) return;
  if (guards) guards.consecutiveFailedVerifications = 0;
  const path = mutatingTargetPath(toolName, toolArgs);
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

// ── Verification read blocking ───────────────────────────────────────────────

/**
 * Caps redundant "verify by re-reading" of files this run already modified:
 * one confirmation read is allowed, further ones get a synthetic answer.
 */
export function verificationReadBlocked(
  toolArgs: Record<string, unknown>,
  mutations: Map<string, number>,
  postMutationReads: Map<string, number>,
): string | null {
  const p = typeof toolArgs.path === 'string' ? toolArgs.path : '';
  if (!p || (mutations.get(p) || 0) === 0) return null;
  const n = postMutationReads.get(p) || 0;
  postMutationReads.set(p, n + 1);
  if (n === 0) return null;
  return (
    `BLOCKED: "${p}" was already read ${n + 1} time(s) after being edited this run. ` +
    `The edit confirmation/diff you received IS the verification. Do not re-read this file — produce your final summary now.`
  );
}
