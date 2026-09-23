import {
  ToolDefinition,
  ToolResult,
  ToolContext,
} from './tool-registry';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { ConnectorRegistry } from '../../ssh/connector.registry';

const execAsync = promisify(exec);

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_CAPTURE_BYTES = 1024 * 1024;

/**
 * Exit-as-data rendering (ported from deepseek-harness): a finished command is
 * DATA, not an error — stdout, a marked [stderr] section, then status markers
 * ([timed out after Nms] / [killed by signal: X] / [exit code: N]). Only
 * infrastructure failures (spawn errors) become isError results.
 */
interface ShellOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: string | null;
  timedOut?: boolean;
  timeoutMs?: number;
}

/** Tail-keep capture: keep the LAST bytes (errors/summaries live at the end)
 * and spill the FULL output to a tmp artifact the model can read_file. */
async function collectStream(
  text: string,
): Promise<{ text: string; truncated: boolean; spillPath?: string }> {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= MAX_CAPTURE_BYTES) {
    return { text, truncated: false };
  }
  const spillDir = path.join(os.tmpdir(), 'smoke-agent-output');
  let spillPath: string | undefined;
  try {
    await fs.promises.mkdir(spillDir, { recursive: true });
    spillPath = path.join(spillDir, `out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.log`);
    await fs.promises.writeFile(spillPath, buf);
  } catch {
    spillPath = undefined;
  }
  const keepLast = Math.floor(MAX_CAPTURE_BYTES / 2);
  const tail = buf.subarray(buf.length - keepLast).toString('utf-8');
  return {
    text: tail,
    truncated: true,
    spillPath,
  };
}

function streamText(stream: { text: string; truncated: boolean; spillPath?: string }): string {
  if (!stream.truncated) return stream.text;
  return `${stream.text}\n[output truncated; full output saved to ${stream.spillPath ?? '(unavailable)'} — read_file that path if you need details]`;
}

async function renderShellOutcome(outcome: ShellOutcome, warnings: string[] = []): Promise<ToolResult> {
  const out = await collectStream(outcome.stdout);
  const err = await collectStream(outcome.stderr);

  let body = streamText(out);
  if (err.text.trim().length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n';
    body += `[stderr]\n${streamText(err)}`;
  }
  if (body.trim().length === 0) body = '(no output)';

  const markers: string[] = [];
  if (outcome.timedOut) markers.push(`[timed out after ${outcome.timeoutMs ?? 0}ms]`);
  if (outcome.signal) {
    markers.push(`[killed by signal: ${outcome.signal}]`);
  } else if (outcome.exitCode !== null && outcome.exitCode !== 0) {
    markers.push(`[exit code: ${outcome.exitCode}]`);
  }

  const parts: string[] = [];
  if (warnings.length > 0) {
    parts.push('Warnings:\n' + warnings.map(w => '  ' + w).join('\n'));
  }
  parts.push(body);
  if (markers.length > 0) parts.push(markers.join('\n'));

  // Non-zero exits are reported as data, never as isError — the model reads
  // the [exit code: N] marker and decides how to react. Structured exitCode
  // in metadata lets the runner/phase machine react without parsing text.
  const failed = Boolean(outcome.timedOut) || Boolean(outcome.signal && outcome.signal !== 'SIGTERM') ||
    (outcome.exitCode !== null && outcome.exitCode !== 0);
  return {
    content: [{ type: 'text', text: parts.join('\n') }],
    summary: failed
      ? `Command failed (exit ${outcome.exitCode ?? 'signal:' + (outcome.signal ?? '?')}${outcome.timedOut ? ', timed out' : ''})`
      : 'Command succeeded (exit 0)',
    metadata: {
      exitCode: outcome.exitCode,
      timedOut: Boolean(outcome.timedOut),
      ...(outcome.signal ? { signal: outcome.signal } : {}),
    },
  };
}

const SPAWN_CAPTURE_CAP = 4 * 1024 * 1024;

/**
 * Foreground shell via spawn: output is consumed continuously and capped
 * in-memory (keeping the tail), so huge outputs never kill the process the
 * way exec's maxBuffer does. Timeout sends SIGTERM, then SIGKILL after a
 * 5s grace period.
 *
 * When `onStream` is provided, each accumulated stdout/stderr snapshot is
 * handed to it as it arrives so the frontend can render terminal output
 * LIVE (streaming) instead of only after the process exits. The snapshots
 * are cumulative on PURPOSE — the UI tool card replaces on each tool.output,
 * so a cumulative buffer grows naturally and the final one matches the
 * completion emit exactly (no duplication).
 */
async function runForeground(
  command: string,
  cwd: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
  onStream?: (header: string, stdout: string, stderr: string) => void,
  abortSignal?: AbortSignal,
): Promise<ShellOutcome & { captureTruncated: boolean; spawnError?: string }> {
  const { spawn } = await import('child_process');
  // detached:true makes the shell the leader of its OWN process group (pid ==
  // pgroup). Commands like recursive "pnpm run build" spawn their own children
  // (pnpm → node → pnpm → ...); signaling only the direct shell leaves those
  // grandchildren alive and re-spawning. Detaching lets hardKill kill the WHOLE
  // process group (-pid) so a runaway/recursive command is actually torn down.
  const child = spawn('/bin/sh', ['-c', command], {
    cwd,
    env,
    detached: true,
    // stdin is a PIPE we auto-feed: interactive confirmations (e.g. shadcn's
    // "File already exists. Overwrite? (y/N)" or npx's "Ok to proceed?") are
    // answered with "yes" on an interval so the command proceeds deterministically
    // instead of blocking forever on an open pipe. "y" is fed so overwrite/install
    // prompts default to PROCEED (matching the agent's intent to get the work done).
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Auto-answer stdin prompts until the child exits or its stdin closes.
  // NOTE: the async 'error' event on the piped socket is what actually fires
  // on EPIPE (stream.write() only throws synchronously for sync errors). Without
  // a registered 'error' listener, Node emits an UNHANDLED 'error' event that
  // crashes the ENTIRE process — which manifested as the agent "sticking" (the
  // run coroutine dies) and the Stop button going dead (no server to receive it).
  let stdinFeeder: NodeJS.Timeout | undefined;
  const stopStdinFeeder = () => {
    if (stdinFeeder) {
      clearInterval(stdinFeeder);
      stdinFeeder = undefined;
    }
  };
  // Attach the error listener FIRST so no write can ever surface an unhandled
  // 'error' event on the stdin socket (child exiting, shell closing the pipe,
  // detached grandchild closing stdin, etc.).
  child.stdin?.on('error', stopStdinFeeder);
  stdinFeeder = setInterval(() => {
    if (child.stdin.destroyed || !child.stdin.writable) {
      stopStdinFeeder();
      return;
    }
    try {
      child.stdin.write('y\n');
    } catch {
      stopStdinFeeder();
    }
  }, 150);
  child.once('exit', stopStdinFeeder);
  child.once('error', stopStdinFeeder);

  return new Promise((resolve) => {
    let stdoutBuf = Buffer.alloc(0);
    let stderrBuf = Buffer.alloc(0);
    let captureTruncated = false;
    // Hard cap on how much we push to the live stream at once so a chatty
    // process can't flood the event bus before the model even sees output.
    let streamedSnapshots = 0;
    const STREAM_SNAPSHOT_MAX_CHARS = 8_000;

    const emitStream = () => {
      if (!onStream) return;
      if (streamedSnapshots++ >= 200) return; // don't stream forever
      onStream(
        captureTruncated ? '[output truncated — showing tail]\n' : '',
        stdoutBuf.toString('utf-8'),
        stderrBuf.toString('utf-8'),
      );
    };

    const attach = (stream: NodeJS.ReadableStream | null, isStdout: boolean) => {
      stream?.on('data', (chunk: Buffer) => {
        const target = () => (isStdout ? stdoutBuf : stderrBuf);
        if (target().length >= SPAWN_CAPTURE_CAP) {
          captureTruncated = true;
        } else {
          const merged = Buffer.concat([target(), chunk]);
          if (merged.length > SPAWN_CAPTURE_CAP) {
            captureTruncated = true;
            const kept = merged.subarray(merged.length - SPAWN_CAPTURE_CAP);
            if (isStdout) stdoutBuf = kept; else stderrBuf = kept;
          } else if (isStdout) {
            stdoutBuf = merged;
          } else {
            stderrBuf = merged;
          }
        }
        // Only stream snapshots below the char cap to keep it lightweight.
        if (stdoutBuf.length + stderrBuf.length <= STREAM_SNAPSHOT_MAX_CHARS) {
          emitStream();
        }
      });
    };
    attach(child.stdout, true);
    attach(child.stderr, false);

    let timedOut = false;
    let settled = false;

    // Kill the child AND its whole process group (soft SIGTERM, then SIGKILL
    // after a grace period) so a hung or recursive command never leaks. Because
    // the shell was spawned detached, `process.kill(-child.pid, signal)` tears
    // down every descendant (nested "pnpm run build" loops, node children, etc.)
    // — signaling only the shell would leave them running and re-spawning.
    const hardKill = (signal: NodeJS.Signals) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      // Signal the process group first (negative pid). This is a no-op target if
      // pgroupId isn't the child's own group, but with detached:true it is.
      try { process.kill(-child.pid!, signal); } catch {}
      try { child.kill(signal); } catch {}
      setTimeout(() => {
        try { process.kill(-child.pid!, 'SIGKILL'); } catch {}
        try { child.kill('SIGKILL'); } catch {}
      }, 5_000).unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      hardKill('SIGTERM');
    }, timeoutMs);

    // Honor the run's abort signal: when the user hits Stop (or the per-tool
    // timeout fires), the in-flight foreground command is killed immediately
    // instead of running to completion — this is what actually lets a runaway
    // build be torn down rather than looping/hanging.
    let abortListener: (() => void) | undefined;
    if (abortSignal) {
      if (abortSignal.aborted) {
        timedOut = true;
        hardKill('SIGTERM');
      } else {
        abortListener = () => {
          timedOut = true;
          hardKill('SIGTERM');
        };
        abortSignal.addEventListener('abort', abortListener, { once: true });
      }
    }

    const cleanupAbort = () => {
      if (abortListener && abortSignal) abortSignal.removeEventListener('abort', abortListener);
    };

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupAbort();
      resolve({
        stdout: '',
        stderr: '',
        exitCode: null,
        signal: null,
        timedOut: false,
        timeoutMs,
        captureTruncated: false,
        spawnError: err.message,
      });
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupAbort();
      // Final flush so any trailing buffered output reaches the UI.
      if (onStream && (stdoutBuf.length || stderrBuf.length)) {
        onStream(
          captureTruncated ? '[output truncated — showing tail]\n' : '',
          stdoutBuf.toString('utf-8'),
          stderrBuf.toString('utf-8'),
        );
      }
      resolve({
        stdout: stdoutBuf.toString('utf-8'),
        stderr: stderrBuf.toString('utf-8'),
        exitCode: code,
        signal,
        timedOut,
        timeoutMs,
        captureTruncated,
      });
    });
  });
}

/**
 * Builds the live-streaming callback for the terminal tools. Emits a
 * tool.output for each accumulated snapshot so the frontend terminal card
 * updates in real time while the command is still running.
 */
function buildStreamCallback(context: ToolContext): ((header: string, stdout: string, stderr: string) => void) | undefined {
  if (!context.eventEmitter || !context.toolCallId) return undefined;
  return (header, stdout, stderr) => {
    let body = header;
    if (stdout) body += stdout;
    if (stderr.trim().length > 0) {
      if (body.length > 0 && !body.endsWith('\n')) body += '\n';
      body += `[stderr]\n${stderr}`;
    }
    if (!body.trim()) return;
    context.eventEmitter!.emitToolOutput(
      context.sessionId,
      context.runId,
      context.toolCallId!,
      body,
    );
  };
}

// Ensure nvm/fnm/volta node paths are available in non-interactive shells
function getEnhancedPath(): string {
  const extraPaths: string[] = [];
  const home = process.env.HOME || '';

  // nvm
  const nvmDir = process.env.NVM_DIR || `${home}/.nvm`;
  try {
    const nvmLinks = fs.readdirSync(`${nvmDir}/versions/node`);
    const latest = nvmLinks.sort().pop();
    if (latest) extraPaths.push(`${nvmDir}/versions/node/${latest}/bin`);
  } catch { /* no nvm */ }

  // fnm
  const fnmDir = `${home}/.local/share/fnm`;
  try {
    if (fs.statSync(fnmDir).isDirectory()) extraPaths.push(fnmDir);
  } catch { /* no fnm */ }

  // volta
  const voltaDir = `${home}/.volta/bin`;
  try {
    if (fs.statSync(voltaDir).isDirectory()) extraPaths.push(voltaDir);
  } catch { /* no volta */ }

  const currentPath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
  return [...extraPaths, currentPath].join(':');
}

function buildEnv(userEnv?: Record<string, string>): Record<string, string> {
  const enhancedPath = getEnhancedPath();
  return {
    ...process.env,
    PATH: enhancedPath,
    TERM: 'dumb',
    FORCE_COLOR: '0',
    // Many CLIs (shadcn, npm, npx, create-* scaffolds) drop interactive
    // confirmations when CI is set, so the agent's command proceeds
    // deterministically instead of waiting on an unanswerable prompt. The
    // caller's explicit env still takes precedence if it overrides CI.
    CI: 'true',
    ...(userEnv || {}),
  };
}

const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\s+[\/~]/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /:(){ :\|:& };:/,
  /\bformat\b.*\b[C-C]:/i,
];

function isInteractiveCommand(command: string): boolean {
  const interactivePatterns = [
    /^git\s+rebase\s+-i/,
    /^git\s+add\s+-p/,
    /^git\s+commit\s+-i/,
    /^npm\s+init\b/,
    /^yarn\s+init\b/,
    /^pnpm\s+init\b/,
    /^vim\b/,
    /^vi\b/,
    /^nano\b/,
    /^emacs\b/,
    /^htop\b/,
    /^top\b/,
    /^less\b/,
    /^more\b/,
    /^man\b/,
    /^ssh\b/,
    /^telnet\b/,
    /^ftp\b/,
  ];
  return interactivePatterns.some(p => p.test(command.trim()));
}

/**
 * Detect commands that will hang the foreground shell. Two common anti-patterns:
 *
 *  1. "server_cmd & sleep 2 && tail -30" — the `&` backgrounds server_cmd but the
 *     spawned shell keeps its pipe fds open, so the shell never exits even though
 *     the foreground work (sleep+tail) is done. The timeout fires but the shell
 *     is still alive, and the next command never runs.
 *
 *  2. "nodemon src/index.js" (no &, no background=true) — a long-running server
 *     that never exits, so the shell blocks forever.
 *
 * Returns { risk, restructured, warning } where:
 *  - risk: true if the command matches a hang pattern
 *  - restructured: the fixed command to run instead (or original if no fix needed)
 *  - warning: message to surface to the agent so it learns
 */
function detectHangRisk(command: string): { risk: boolean; restructured?: string; warning?: string } {
  const trimmed = command.trim();

  // ── Pattern 1: backgrounded process + foreground work ──────────────────
  // "server & cmd1 && cmd2" or "server & cmd1 ; cmd2"
  // The `&` puts server in the background but the shell stays alive.
  // Fix: split into two separate calls — background the server via nohup,
  //       run the foreground work in a clean shell.
  const bgWithFollowUp = /^(.+?)\s+&\s+(.+)$/;
  const bgMatch = trimmed.match(bgWithFollowUp);
  if (bgMatch) {
    const bgPart = bgMatch[1].trim();
    const fgPart = bgMatch[2].trim();
    // Only restructure if the background part looks like a long-running process
    const longRunning = /\b(nodemon|pm2|forever|webpack-dev-server|vite\s|next\sdev|react-scripts\sstart|vue-cli-service\sserve|nodemon|concurrently|live-server|browser-sync|chokidar|watchman|jest\s--watch|vitest\s--watch|pnpm\sdev|npm\sdev|yarn\sdev|node\s.*\.js|node\s.*\.ts|python\s.*\.py|ruby\s.*\.rb|java\s|go\srun|cargo\srun|make\swatch|tail\s-f)\b/i;
    if (longRunning.test(bgPart)) {
      return {
        risk: true,
        restructured: fgPart,
        warning: `⚠️ HANG PREVENTION: The backgrounded process (${bgPart.split(/\s+/).slice(0, 3).join(' ')}...) was auto-detached. ` +
          `Foreground work: "${fgPart}". ` +
          `To start a server, use background=true on a SEPARATE call — do NOT combine & with other commands in one call.`,
      };
    }
  }

  // ── Pattern 2: command ending with & (foreground shell hangs) ──────────
  // "node server.js &" or "cd backend && node src/server.js > /tmp/log 2>&1 &"
  // The `&` backgrounds the child but the shell keeps its pipe fds open,
  // so the foreground shell never exits — the timeout fires but can't kill
  // it cleanly, and the next command never runs.
  const endsWithAmpersand = /\s&\s*$/.test(trimmed);
  if (endsWithAmpersand) {
    const longRunning = /\b(nodemon|pm2|forever|webpack-dev-server|vite\s|next\sdev|react-scripts\sstart|vue-cli-service\sserve|nodemon|concurrently|live-server|browser-sync|chokidar|watchman|jest\s--watch|vitest\s--watch|pnpm\sdev|npm\sdev|yarn\sdev|node\s.*\.js|node\s.*\.ts|python\s.*\.py|ruby\s.*\.rb|java\s|go\srun|cargo\srun|make\swatch|tail\s-f)\b/i;
    if (longRunning.test(trimmed.replace(/\s*&\s*$/, ''))) {
      return {
        risk: true,
        restructured: trimmed.replace(/\s*&\s*$/, ''),
        warning: `⚠️ HANG PREVENTION: The backgrounded process was auto-detached. ` +
          `Foreground work will run in a clean shell. ` +
          `To start a server, use background=true on a SEPARATE call — do NOT combine & with other commands in one call.`,
      };
    }
    // Generic case: any command ending with & in foreground hangs the shell
    return {
      risk: true,
      warning: `⚠️ HANG PREVENTION: A command ending with "&" in foreground mode hangs the shell forever (the backgrounded child keeps the pipe open). ` +
        `Remove the "&" and set background=true for a SEPARATE call, or just remove the "&" if you want to wait for completion.`,
    };
  }

  // ── Pattern 3: long-running server without background ──────────────────
  // "nodemon src/index.js" or "pnpm dev" without &
  const longRunningServer = /\b(nodemon|pm2|forever|webpack-dev-server|vite\s(?:dev|serve)|next\sdev|react-scripts\sstart|vue-cli-service\sserve|live-server|browser-sync|jest\s--watch|vitest\s--watch)\b/i;
  if (longRunningServer.test(trimmed) && !trimmed.includes('&&') && !trimmed.includes('; ')) {
    return {
      risk: true,
      warning: `⚠️ HANG PREVENTION: "${trimmed.split(/\s+/).slice(0, 3).join(' ')}..." looks like a long-running server. ` +
        `Set background=true to run it detached — running it in the foreground will block the terminal forever.`,
    };
  }

  return { risk: false };
}

function detectWarnings(command: string, workdir: string): string[] {
  const warnings: string[] = [];
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      warnings.push(`⚠️  Potentially destructive command detected: "${command.split(/\s+/).slice(0, 3).join(' ')}...". Verify before proceeding.`);
    }
  }
  if (isInteractiveCommand(command)) {
    warnings.push(`⚠️  Interactive command detected: "${command.split(/\s+/)[0]}". This command requires user input and may not work correctly in a non-interactive shell.`);
  }
  return warnings;
}

/**
 * Smart process-protection guard. Prevents the agent from killing its own
 * host and critical infrastructure — a `kill -9` on the api-gateway's own
 * PID severs the run mid-flight and leaves the agent stuck in RUNNING (this
 * is exactly what happened when a run issued "kill -9 <api-gateway-pid>"
 * and killed the very server executing it).
 *
 * Returns a hard-block error message (isError) so the run stops gracefully
 * instead of hanging, or `null` if the command is safe to run.
 */
const KILL_CMD_RE = /\b(kill|pkill|killall)\b/;
const KILL_FORCE_RE = /\b(kill\s+-\s*9|pkill\s+-\s*9|killall\s+-\s*9|kill\s+-9)\b/;
const PROTECTED_PROCESS_NAMES = [
  'node', 'npm', 'pnpm', 'yarn', 'bun',
  'postgres', 'redis', 'mysql', 'mariadb', 'mongod', 'sqlite3',
  'nginx', 'supervisord', 'ssh', 'docker', 'containerd',
];

function detectBlockedProcessKill(command: string): string | null {
  const trimmed = command.trim();
  if (!KILL_CMD_RE.test(trimmed)) return null;

  const selfPid = String(process.pid);
  const selfPidRe = new RegExp(`(?:^|\\W)${selfPid}(?:\\W|$)`);

  // 1. The command targets the agent's own server process (api-gateway).
  if (selfPidRe.test(trimmed)) {
    return `Blocked: this command would kill the agent's own server process (PID ${selfPid}). ` +
      'Killing the api-gateway severs the agent mid-run and leaves it stuck in RUNNING. ' +
      'If a service needs restarting, kill only the specific child process you started (use lsof/ps to find it), then relaunch it.';
  }

  // 2. Bulk kills of a protected infrastructure/language runtime name.
  const lower = trimmed.toLowerCase();
  const bulkKill = /\b(pkill|killall)\b/.test(lower);
  if (bulkKill) {
    for (const name of PROTECTED_PROCESS_NAMES) {
      const nameRe = new RegExp(`(?:^|\\W)${name}(?:\\W|$)`, 'i');
      if (nameRe.test(lower)) {
        return `Blocked: refusing to pkill/killall "${name}" — that would take down critical infrastructure ` +
          `(the language runtime, the api-gateway, or a database). Use a targeted PID kill for the specific stray process instead ` +
          `(e.g. lsof -nP -iTCP:<port> to find it, then kill <that-pid>).`;
      }
    }
  }

  // 3. SIGKILL (-9) always — flag a strong warning (soft, not blocked) so the
  //    agent prefers a graceful SIGTERM first.
  if (KILL_FORCE_RE.test(trimmed)) {
    return `Warning: forcing SIGKILL (-9). Prefer a graceful kill (SIGTERM: "kill <pid>") first so the process can clean up, `
      + 'and never apply -9 to the api-gateway or any critical service.';
  }

  return null;
}

export function getRunCommandTool(connectors?: ConnectorRegistry): ToolDefinition {
  return {
    name: 'run_command',
    description:
      'Execute a shell command in the workspace. THIS is your primary engineering tool — use it for discovery, search, scripts, tests, builds, git, logs, processes, and HTTP/API checks. ' +
      'Prefer ONE combined command for related operations instead of many tiny calls: chain related read-only steps with && (or ; for independent checks) in a single execution, e.g. "pwd && git status --short && git diff --stat" or "rg -n \"Auth|login\" src && pnpm exec tsc --noEmit". Use rg/fd for search (if rg is not installed, fall back to grep -rnE), git for repository state, jq for JSON, package-manager commands for validation, and curl/log/process commands for runtime verification. If `pnpm i`/`npm i`/`yarn` fails with `ERR_PNPM_JSON_PARSE`/`EJSONPARSE`/`Unexpected non-whitespace character after JSON`/`Unexpected token` naming a package.json at position N, that file is corrupt JSON — read it, fix the syntax (usually one missing brace/quote or a broken "scripts" block), confirm with `jq empty <file>`, then re-run the install. ' +
      'Each call runs in a fresh shell: no state (cwd, variables) persists between calls — pass workdir instead of using cd. ' +
      'Non-zero exits are reported as an [exit code: N] marker (data, not a tool failure): always check it and diagnose the root cause before retrying — never blindly repeat a failed command. ' +
      'Long output keeps the tail; the full output is saved to a file whose path is reported when truncated. ' +
      'Commands must be non-interactive and must not wait on stdin: use the tool\'s own flag for init/add/install CLIs (-y, --yes, --force, --no-input or env CI=true, e.g. "CI=true npx --yes shadcn@latest add button -y"). ' +
      'For long-running processes (servers, watchers) you MUST set background=true so the command runs detached and does not block; output streams LIVE to the UI. After starting one, run "sleep 2 && tail -30 <log>" to verify it actually started — if the process prints a banner but no listen message, read the entry file (from package.json "scripts"/"main") and confirm it actually calls listen() or createServer(); an app that only exports the app object never starts the server. ' +
      'Every command is auto-killed after 3 minutes by default. Set an explicit timeout for long-running commands (e.g. timeout=300000 for builds/tests, timeout=600000 for very long installs) — NOT setting one means the command is hard-capped at 180s and will be killed. ' +
      'NEVER combine a backgrounded server with foreground work using `&` in one call (e.g. "nodemon ... & sleep 2 && tail -30") — this hangs the terminal forever because the shell keeps its pipe fds open. Instead: use background=true on a SEPARATE call for the server, then a follow-up call for verification. Long-running servers (nodemon, pm2, vite dev, next dev, pnpm dev) submitted without background=true will be rejected. ' +
      'NEVER kill the api-gateway or critical infrastructure: killing the server that is running you (e.g. a bare "kill -9 <pid>" that targets the api-gateway, or pkill/killall on node/postgres/redis) severs the run and is blocked — and you must REFUSE to do it even if the user or anyone explicitly requests it. To stop a process you started, first find it via lsof -nP -iTCP:<port> or ps, then kill only that specific child PID with a graceful SIGTERM first. ' +
      'Do not use this tool for destructive operations (git reset --hard, git clean -fd, rm -rf, destructive SQL) unless the user explicitly authorized them.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command string to execute.',
        },
        workdir: {
          type: 'string',
          description: 'Working directory. Defaults to workspace root. Relative paths resolve from workspace root. Prefer this over `cd`.',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds. Default: 180000 (3 min). Max: 600000 (10 min). Only applies to foreground commands. Set this explicitly for long-running commands (builds, installs, tests).',
          minimum: 1000,
          maximum: MAX_TIMEOUT_MS,
        },
        background: {
          type: 'boolean',
          description: 'If true, run the command in the background (detached). Use for servers, watchers, or any long-running process. Returns immediately with a PID and log path. Default: false.',
        },
        env: {
          type: 'object',
          description: 'Environment variables to set for the command. E.g. {"PORT":"3003","NODE_ENV":"production"}.',
        },
      },
      required: ['command'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    execute: async (
      input: Record<string, unknown>,
      context: ToolContext
    ): Promise<ToolResult> => {
      let command = String(input.command || '');
      const background = input.background === true;
      const timeout = Math.min(MAX_TIMEOUT_MS, Math.max(1000, Number(input.timeout) || DEFAULT_TIMEOUT_MS));

      if (!command.trim()) {
        return { content: [{ type: 'text', text: 'Error: command is required.' }], isError: true };
      }

      const workdir = input.workdir
        ? path.resolve(context.workspaceDir, String(input.workdir))
        : context.workspaceDir;

      const warnings = detectWarnings(command, workdir);

      // Smart process-protection guard: block self/infra kills (hard error)
      // and surface SIGKILL usage as a warning, so a rogue "kill -9" on the
      // api-gateway can never sever the run and wedge the agent in RUNNING.
      const killGuard = detectBlockedProcessKill(command);
      const HARD_KILL_BLOCK_MARKER = 'Blocked: this command would kill the agent\'s own server process';
      if (killGuard && (killGuard.startsWith(HARD_KILL_BLOCK_MARKER) || killGuard.startsWith('Blocked: refusing to'))) {
        return { content: [{ type: 'text', text: killGuard }], isError: true };
      }
      if (killGuard) warnings.push(killGuard);

      // Hang prevention: detect commands that will block the terminal forever
      // and auto-restructure them or warn the agent.
      const hangCheck = detectHangRisk(command);
      if (hangCheck.risk) {
        if (hangCheck.restructured) {
          // Command was restructured — run the fixed version, surface the warning
          warnings.push(hangCheck.warning!);
          command = hangCheck.restructured;
        } else if (!background) {
          // Server detected without background=true — block and tell agent to fix
          return {
            content: [{
              type: 'text',
              text: hangCheck.warning! + ' Resubmit with background=true.',
            }],
            isError: true,
          };
        }
      }

      if (background) {
        const { spawn } = await import('child_process');
        // Keep logs OUT of the workspace: they would pollute search/glob results.
        const bgDir = path.join(os.tmpdir(), 'smoke-agent-bg');
        try { fs.mkdirSync(bgDir, { recursive: true }); } catch {}
        const bgLog = path.join(bgDir, `bg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.log`);

        const mergedEnv = buildEnv(input.env as Record<string, string> | undefined);

        try {
          // Run the user's command via a SCRIPT FILE instead of interpolating it
          // straight into `nohup ${command} ...`. `nohup` can only exec an external
          // command, so a command that starts with a shell builtin like
          // `cd Project && node backend/src/app.js` runs the `cd` in a FORKED child
          // — the cwd change never reaches the rest of the pipeline, and the server
          // starts from the wrong directory (MODULE_NOT_FOUND / wrong relative
          // paths). Wrapping `/bin/sh <script>` keeps the whole command (incl. cds
          // and compound && || ; chains) in ONE shell so it runs exactly like the
          // foreground path. `detached: true` still protects it from SIGHUP.
          const scriptPath = path.join(bgDir, `bg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.sh`);
          fs.writeFileSync(scriptPath, `${command}\n`, { mode: 0o600 });
          const child = spawn('sh', ['-c', `nohup /bin/sh "${scriptPath}" > "${bgLog}" 2>&1 &\necho $!`], {
            cwd: workdir,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: mergedEnv,
          });

          const stdout = await new Promise<string>((resolve) => {
            let data = '';
            // Guard against an unhandled 'error' crashing the process (same EPIPE
            // class of bug as the foreground stdin feeder): the launcher shell can
            // die/fail and its stdio pipes emit errors with no default handling.
            child.on('error', () => resolve(data));
            child.stdout?.on('error', () => resolve(data));
            child.stdout?.on('data', (chunk) => { data += chunk; });
            child.on('close', () => resolve(data));
            setTimeout(() => { child.kill(); resolve(data); }, 5000);
          });

          const pid = stdout.trim().split('\n').pop()?.trim() || 'unknown';

          // Start a background watcher that streams log output to the frontend
          if (context.eventEmitter) {
            const toolCallIdForEvents = context.toolCallId;
            let lastSize = 0;
            const watcher = fs.watch(bgLog, async () => {
              try {
                const stat = fs.statSync(bgLog);
                if (stat.size > lastSize) {
                  const stream = fs.createReadStream(bgLog, { start: lastSize, encoding: 'utf-8' });
                  let newContent = '';
                  for await (const chunk of stream) {
                    newContent += chunk;
                  }
                  lastSize = stat.size;
                  if (newContent.trim() && toolCallIdForEvents) {
                    context.eventEmitter!.emitToolOutput(
                      context.sessionId,
                      context.runId,
                      toolCallIdForEvents,
                      newContent.trim(),
                    );
                  }
                }
              } catch {}
            });
            // Auto-stop watching after 5 minutes
            setTimeout(() => { watcher.close(); }, 5 * 60 * 1000);
          }

          const parts: string[] = [];
          if (warnings.length > 0) {
            parts.push('Warnings:\n' + warnings.map(w => '  ' + w).join('\n'));
          }
          parts.push(`Command started in background (PID: ${pid}).`);
          parts.push(`Output log: ${bgLog}`);
          parts.push(`To check output: read_file on ${bgLog}, or run_command "tail -50 ${bgLog}".`);
          parts.push(`To stop: run_command "kill ${pid}".`);

          return {
            content: [{ type: 'text', text: parts.join('\n') }],
            summary: `Background command started (PID ${pid})`,
            metadata: { background: true, pid, logPath: bgLog },
          };
        } catch (err: any) {
          return {
            content: [{ type: 'text', text: `Error: failed to start background command: ${err.message}\n\nCommand: ${command}` }],
            isError: true,
          };
        }
      }

      // Remote execution over SSH (Remote-SSH mode): the command runs on the
      // remote host's default login shell. Live output streams to the UI.
      if (context.remoteSsh && connectors) {
        const ssh = connectors.get('ssh');
        if (!ssh) {
          return { content: [{ type: 'text', text: 'Error: SSH connector unavailable.' }], isError: true };
        }
        if (background) {
          return {
            content: [{ type: 'text', text: 'Remote execution does not support background mode; re-run without background=true (the command will block like a normal foreground command on the remote host).' }],
            isError: true,
          };
        }
        try {
          const r = await ssh.exec(
            context.remoteSsh.destinationId,
            context.remoteSsh.userId,
            command,
            {
              timeoutMs: timeout,
              onStream: buildStreamCallback(context),
              env: input.env as Record<string, string> | undefined,
            },
          );
          return renderShellOutcome({
            stdout: r.stdout,
            stderr: r.stderr,
            exitCode: r.exitCode,
            timedOut: !!r.timedOut,
            timeoutMs: timeout,
          }, warnings);
        } catch (err: any) {
          return {
            content: [{ type: 'text', text: `[ssh error] ${err?.message || String(err)}\n\nCommand: ${command}` }],
            isError: true,
          };
        }
      }

      // Foreground execution — exit-as-data: only spawn-level failures are isError.
      const streamCb = buildStreamCallback(context);
      const outcome = await runForeground(command, workdir, buildEnv(input.env as Record<string, string> | undefined), timeout, streamCb, context.abortSignal);
      if (outcome.spawnError) {
        return {
          content: [{ type: 'text', text: `Error: could not execute command: ${outcome.spawnError}\n\nCommand: ${command}` }],
          isError: true,
        };
      }
      return renderShellOutcome({
        stdout: outcome.stdout + (outcome.captureTruncated ? '\n[additional output dropped (exceeded capture limit)]' : ''),
        stderr: outcome.stderr,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        timedOut: outcome.timedOut,
        timeoutMs: outcome.timeoutMs,
      }, warnings);
    },
  };
}

export function getRunTestTool(): ToolDefinition {
  return {
    name: 'run_test',
    description:
      'Run a test command (npm test, pytest, jest, go test, cargo test, etc.). ' +
      'Runs with CI=true. A failing test suite is reported as data via the [exit code: N] marker — read the failure output and fix the code.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Test command to run.',
        },
        workdir: {
          type: 'string',
          description: 'Working directory. Defaults to workspace root.',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds. Default and max: 300000 (5 min).',
          minimum: 1000,
          maximum: 300_000,
        },
      },
      required: ['command'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    execute: async (
      input: Record<string, unknown>,
      context: ToolContext
    ): Promise<ToolResult> => {
      const command = String(input.command || '');
      if (!command.trim()) {
        return { content: [{ type: 'text', text: 'Error: command is required.' }], isError: true };
      }

      const workdir = input.workdir
        ? path.resolve(context.workspaceDir, String(input.workdir))
        : context.workspaceDir;
      const timeout = Math.min(300_000, Math.max(1000, Number(input.timeout) || 30_000));

      // Same spawn-based runner as run_command: tail-kept capture, SIGTERM→
      // SIGKILL timeout, no maxBuffer blowups on chatty test suites.
      const outcome = await runForeground(
        command,
        workdir,
        buildEnv({ CI: 'true' }),
        timeout,
        buildStreamCallback(context),
        context.abortSignal,
      );
      if (outcome.spawnError) {
        return {
          content: [{ type: 'text', text: `Error: could not execute test command: ${outcome.spawnError}` }],
          isError: true,
        };
      }
      return renderShellOutcome({
        stdout: outcome.stdout + (outcome.captureTruncated ? '\n[additional output dropped (exceeded capture limit)]' : ''),
        stderr: outcome.stderr,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        timedOut: outcome.timedOut,
        timeoutMs: outcome.timeoutMs,
      });
    },
  };
}

export function getDockerExecTool(): ToolDefinition {
  return {
    name: 'docker_exec',
    description:
      'Execute a command inside a running Docker container. ' +
      'Use docker_list first to find container names/IDs, then execute commands inside them.',
    inputSchema: {
      type: 'object',
      properties: {
        container: {
          type: 'string',
          description: 'Container name or ID.',
        },
        command: {
          type: 'string',
          description: 'Command to execute inside the container.',
        },
        workdir: {
          type: 'string',
          description: 'Working directory inside the container. Defaults to /.',
        },
      },
      required: ['container', 'command'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    execute: async (
      input: Record<string, unknown>,
      context: ToolContext
    ): Promise<ToolResult> => {
      const container = String(input.container || '');
      const command = String(input.command || '');
      const workdir = String(input.workdir || '/');

      if (!container || !command) {
        return { content: [{ type: 'text', text: 'Error: container and command are required.' }], isError: true };
      }

      try {
        const dockerCmd = `docker exec -w "${workdir}" ${container} sh -c ${JSON.stringify(command)}`;
        const result = await execAsync(dockerCmd, {
          timeout: 300_000,
          maxBuffer: MAX_CAPTURE_BYTES,
          env: buildEnv(),
        });
        return renderShellOutcome({
          stdout: result.stdout || '',
          stderr: result.stderr || '',
          exitCode: (result as any).exitCode ?? 0,
        });
      } catch (err: any) {
        // docker exec propagates the container command's non-zero exit — data, not tool error.
        if (typeof err.stdout === 'string' || typeof err.stderr === 'string' || typeof err.exitCode === 'number') {
          return renderShellOutcome({
            stdout: err.stdout || '',
            stderr: err.stderr || '',
            exitCode: err.exitCode ?? 1,
          });
        }
        return {
          content: [{
            type: 'text',
            text: `Error: docker exec failed to run (is the container running? does Docker work?): ${err.stderr || err.message || 'Unknown error'}`,
          }],
          isError: true,
        };
      }
    },
  };
}

export function getDockerListTool(): ToolDefinition {
  return {
    name: 'docker_list',
    description: 'List all Docker containers (running and stopped).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
    },
    execute: async (): Promise<ToolResult> => {
      try {
        const result = await execAsync('docker ps -a --format "{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}"', {
          timeout: 10_000,
        });

        const output = result.stdout || '';
        if (!output.trim()) {
          return { content: [{ type: 'text', text: 'No Docker containers found.' }] };
        }

        const header = 'ID\tNAME\tIMAGE\tSTATUS';
        return { content: [{ type: 'text', text: `${header}\n${output.trim()}` }] };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: `Failed to list containers: ${err.message || 'Docker not available'}` }],
          isError: true,
        };
      }
    },
  };
}
