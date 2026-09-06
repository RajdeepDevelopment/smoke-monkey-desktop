import * as path from 'path';
import * as fs from 'fs';
import { ToolResult } from '../tools/tool-registry';

/**
 * Run artifacts: oversized tool output is spilled to disk under
 * `<workspace>/.smoke/runs/<runId>/` and the LLM receives a compact summary
 * plus the artifact path. It can `read_file` the artifact only if it truly
 * needs details — instead of every tool dumping thousands of lines into
 * conversation context.
 *
 * Directory layout per run:
 *   .smoke/runs/<runId>/
 *     state.json          — full AgentState snapshot (resumability)
 *     plan.json           — structured plan
 *     stdout/             — command stdout logs
 *     stderr/             — command stderr logs
 *     patches/            — generated patches / diffs
 *     test-results/       — test output logs
 *     checkpoints/        — step checkpoints
 *     artifacts/          — generic oversized tool output
 */
export const ARTIFACTS_ROOT = path.join('.smoke', 'runs');

/** Subdirectories inside a run's artifact folder. */
export const ARTIFACT_DIRS = {
  stdout: 'stdout',
  stderr: 'stderr',
  patches: 'patches',
  testResults: 'test-results',
  checkpoints: 'checkpoints',
  artifacts: 'artifacts',
} as const;

/** Context-size threshold (chars ≈ tokens*4): beyond this, spill to disk. */
const SPILL_THRESHOLD_CHARS = 8_000;
const SPILL_HEAD_CHARS = 1_200;
const SPILL_TAIL_CHARS = 3_000; // errors/summaries live at the end
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

/**
 * Writes an artifact file for this run. Returns the workspace-RELATIVE path,
 * or null when writing fails (artifact support degrades gracefully).
 */
export async function writeArtifact(
  workspacePath: string,
  runId: string,
  name: string,
  content: string,
): Promise<string | null> {
  return writeArtifactToDir(workspacePath, runId, ARTIFACT_DIRS.artifacts, name, content);
}

/**
 * Writes an artifact into a specific subdirectory of the run folder.
 * Returns the workspace-RELATIVE path, or null on failure.
 */
export async function writeArtifactToDir(
  workspacePath: string,
  runId: string,
  subDir: string,
  name: string,
  content: string,
): Promise<string | null> {
  try {
    const dir = path.join(workspacePath, ARTIFACTS_ROOT, runId, subDir);
    await fs.promises.mkdir(dir, { recursive: true });
    const safeName = `${Date.now()}_${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    let buf = Buffer.from(content, 'utf-8');
    if (buf.length > MAX_ARTIFACT_BYTES) {
      buf = Buffer.concat([buf.subarray(0, MAX_ARTIFACT_BYTES), Buffer.from('\n[artifact truncated]\n', 'utf-8')]);
    }
    const rel = path.join(ARTIFACTS_ROOT, runId, subDir, safeName);
    await fs.promises.writeFile(path.join(workspacePath, rel), buf);
    return rel;
  } catch {
    return null;
  }
}

/**
 * Writes a JSON-serializable value to the run's root directory
 * (state.json, plan.json, etc.). Returns the relative path or null.
 */
export async function writeRunJson(
  workspacePath: string,
  runId: string,
  filename: string,
  data: unknown,
): Promise<string | null> {
  try {
    const dir = path.join(workspacePath, ARTIFACTS_ROOT, runId);
    await fs.promises.mkdir(dir, { recursive: true });
    const content = JSON.stringify(data, null, 2);
    const rel = path.join(ARTIFACTS_ROOT, runId, filename);
    await fs.promises.writeFile(path.join(workspacePath, rel), content, 'utf-8');
    return rel;
  } catch {
    return null;
  }
}

/**
 * Creates the standard subdirectory structure for a new run.
 * Called once at run start; idempotent.
 */
export async function ensureRunDirs(workspacePath: string, runId: string): Promise<void> {
  const base = path.join(workspacePath, ARTIFACTS_ROOT, runId);
  await Promise.all(
    Object.values(ARTIFACT_DIRS).map((d) => fs.promises.mkdir(path.join(base, d), { recursive: true })),
  );
}

/**
 * Keeps head+tail of oversized tool output and points at the full artifact.
 * Pure string shaping — the caller persists the artifact.
 */
export function shapeSpilledOutput(fullOutput: string, artifactPath: string | null): string {
  if (fullOutput.length <= SPILL_THRESHOLD_CHARS) return fullOutput;
  const head = fullOutput.slice(0, SPILL_HEAD_CHARS).trimEnd();
  const tail = fullOutput.slice(-SPILL_TAIL_CHARS).trimStart();
  const pointer = artifactPath
    ? `full output saved to ${artifactPath} — read_file that path if you need details`
    : 'output truncated (artifact unavailable)';
  return `${head}\n\n[… ${fullOutput.length - SPILL_HEAD_CHARS - SPILL_TAIL_CHARS} chars omitted — ${pointer} …]\n\n${tail}`;
}

/**
 * Single choke point used by the executor after EVERY tool call:
 * - stamps durationMs,
 * - spills oversized outputs to a run artifact and rewrites `output` to the
 *   compact head+tail form (works for ALL tools, converted or not),
 * - backfills a one-line summary when the tool didn't provide one.
 *
 * Routes tool output to the correct structured subdirectory:
 *   run_command stdout       → stdout/
 *   run_command stderr       → stderr/
 *   run_test output          → test-results/
 *   edit_file / apply_patch  → patches/
 *   everything else          → artifacts/
 */
export async function enrichToolResult(
  toolName: string,
  result: ToolResult,
  opts: { workspacePath: string; runId: string; startedAt: number },
): Promise<void> {
  result.metadata = { ...result.metadata, durationMs: Date.now() - opts.startedAt };

  const output = result.output ?? '';
  if (!result.artifact && output.length > SPILL_THRESHOLD_CHARS) {
    const subDir = resolveArtifactDir(toolName);
    const artifactPath = await writeArtifactToDir(opts.workspacePath, opts.runId, subDir, `${toolName}.log`, output);
    result.output = shapeSpilledOutput(output, artifactPath);
    if (artifactPath) result.artifact = { path: artifactPath };
  }

  if (!result.summary && !result.isError) {
    const firstLine = output.split('\n').find((l) => l.trim().length > 0) ?? '(no output)';
    const lineCount = output.length === 0 ? 0 : output.split('\n').length;
    result.summary =
      lineCount > 1
        ? `${toolName}: ${firstLine.slice(0, 120)} (+${lineCount - 1} more lines)`
        : `${toolName}: ${firstLine.slice(0, 120)}`;
  }
}

/** Maps tool names to their artifact subdirectory. */
function resolveArtifactDir(toolName: string): string {
  switch (toolName) {
    case 'run_command':
      return ARTIFACT_DIRS.stdout;
    case 'run_test':
      return ARTIFACT_DIRS.testResults;
    case 'edit_file':
    case 'apply_patch':
    case 'line_edit':
      return ARTIFACT_DIRS.patches;
    default:
      return ARTIFACT_DIRS.artifacts;
  }
}
