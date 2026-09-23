import { Injectable, Logger, Inject } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { buildGitSystemPrompt, type GitAgentKind } from '../lib/git-agent-prompt';
import { LLMClient, type LlmStreamHooks } from './llm-client';
import { AgentEventEmitter } from './agent-event.emitter';
import { ApiKeysService } from '../../keys/api-keys.service';
import type { LLMMessage } from './run-context';

const execFileAsync = promisify(execFile);

/** Hard limits around AI Git operations (env-overridable). */
const MAX_CONTEXT_CHARS = Number(process.env.GIT_AGENT_MAX_CONTEXT_CHARS) || 24_000;
const MAX_STAGED_CHARS = Number(process.env.GIT_AGENT_MAX_STAGED_CHARS) || 16_000;
const MAX_UNSTAGED_CHARS = Number(process.env.GIT_AGENT_MAX_UNSTAGED_CHARS) || 10_000;
const MAX_LOG_SAMPLES = 10;
const GIT_AGENT_MAX_CONCURRENT = Number(process.env.GIT_AGENT_MAX_CONCURRENT) || 3;

export interface GitAgentStreamParams {
  /** Absolute path of the workspace (must be a git repo). */
  cwd: string;
  /** The currently selected model on the Agent page (passed through, never
   *  hardcoded). Falls back to the gateway default when absent. */
  model?: string;
  provider?: string;
  /** The authenticated user id — used for isolated per-user provider keys. */
  userId: string;
  /** Cancellation token used to tie the LLM call to an AbortController. */
  requestId: string;
  /** Max context characters to send to the model. Defaults to MAX_CONTEXT_CHARS. */
  maxContextChars?: number;
}

export interface CommitMessageStreamParams extends GitAgentStreamParams {
  /** Optional user wording instruction. Guidance only — the prompt forbids it
   *  from overriding the actual diff. */
  instruction?: string;
}

export interface ReviewStreamParams extends GitAgentStreamParams {
  instruction?: string;
}

export interface GitAgentContext {
  branch: string | null;
  files: string[];
  stagedDiff: string;
  unstagedDiff: string;
  log: string;
  isRepo: boolean;
  totalFiles: number;
  truncated: boolean;
  /** Combined, already-truncated context blob sent to the model. */
  blob: string;
}

export interface CommitMessageResult {
  subject: string;
  body: string;
  message: string;
  files: string[];
  branch: string | null;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export interface GitReviewResult {
  markdown: string;
  /** Heuristic status derived from the model's own verdict line. */
  status: 'ready' | 'attention';
  files: string[];
  branch: string | null;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

/** Observable stream parts emitted while a Git-agent job runs. */
export interface GitAgentStreamEvent {
  type: 'git.delta' | 'git.thought' | 'git.start' | 'git.done' | 'git.error';
  data: Record<string, unknown>;
}

const GIT_AGENT_BATCH = {
  /** Runs git with an ARGV array — never a shell. */
  git(cwd: string, args: string[], timeoutMs = 15_000): Promise<string> {
    return execFileAsync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    }).then((r) => String(r.stdout || '').trim());
  },
  async gitTry(cwd: string, args: string[], timeoutMs = 8_000): Promise<string | null> {
    try {
      return await this.git(cwd, args, timeoutMs);
    } catch {
      return null;
    }
  },
  async isGitRepo(cwd: string): Promise<boolean> {
    return (await this.gitTry(cwd, ['rev-parse', '--is-inside-work-tree'], 5_000)) === 'true';
  },
};

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n… [truncated ${text.length - max} chars]`;
}

function stripCodeFences(text: string): string {
  const t = text.trim();
  const fenced = /^```(?:markdown|md|text)?\s*([\s\S]*?)```$/i.exec(t);
  return (fenced ? fenced[1] : t).trim();
}

/**
 * GitAgentService — the AI half of the Source Control panel.
 *
 * Wraps the existing LLM transport (provider routing, per-user keys, SSE
 * streaming, retries) behind two focused jobs:
 *
 *   1. Generate a commit message from the REAL staged/unstaged diff.
 *   2. Review the working-tree changes with markdown (status / issues /
 *      suggested message / file table).
 *
 * Deliberately NOT another agent loop: each job is a single, lightweight LLM
 * call with a small Git-specific system prompt (lib/git-agent-prompt.ts),
 * bounded diff context, and a small concurrency cap.
 */
@Injectable()
export class GitAgentService {
  private readonly logger = new Logger(GitAgentService.name);
  private readonly llmClient: LLMClient;

  /** Per-request AbortControllers, keyed by requestId, so unsubscribing from
   *  the SSE stream cancels the in-flight model call immediately. */
  private readonly aborts = new Map<string, AbortController>();
  private active = 0;

  constructor(
    private readonly apiKeyService: ApiKeysService,
    private readonly eventEmitter: AgentEventEmitter,
  ) {
    this.llmClient = new LLMClient({
      apiKeyService: this.apiKeyService,
      eventEmitter: this.eventEmitter,
      getActiveRunSignal: (requestId?: string) =>
        requestId ? this.aborts.get(requestId)?.signal : undefined,
    });
  }

  // ── Public ─────────────────────────────────────────────────────────────

  /** Inspect the workspace and build the bounded context blob. */
  async collectContext(cwd: string, maxContextChars = MAX_CONTEXT_CHARS): Promise<GitAgentContext> {
    if (!(await GIT_AGENT_BATCH.isGitRepo(cwd))) {
      return {
        isRepo: false, branch: null, files: [], stagedDiff: '', unstagedDiff: '', log: '',
        totalFiles: 0, truncated: false, blob: '',
      };
    }

    const [branch, status, stagedDiff, unstagedDiff, log] = await Promise.all([
      GIT_AGENT_BATCH.gitTry(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
      GIT_AGENT_BATCH.gitTry(cwd, ['status', '--porcelain=v1', '--untracked-files=all'], 10_000),
      GIT_AGENT_BATCH.gitTry(cwd, ['diff', '--cached'], 20_000),
      GIT_AGENT_BATCH.gitTry(cwd, ['diff'], 20_000),
      GIT_AGENT_BATCH.gitTry(cwd, ['log', '--oneline', '--decorate', '-n', String(MAX_LOG_SAMPLES)], 10_000),
    ]);

    const files: string[] = [];
    for (const line of (status || '').split('\n')) {
      const f = line.length > 3 ? line.substring(3) : '';
      if (f) files.push(f.includes(' -> ') ? f.split(' -> ').pop()! : f);
    }

    const stagedTrunc = truncate(stagedDiff || '', MAX_STAGED_CHARS);
    const unstagedTrunc = truncate(unstagedDiff || '', MAX_UNSTAGED_CHARS);

    // Assemble the blob, truncating the whole thing to the budget.
    const parts: string[] = [];
    if (branch) parts.push(`Branch: ${branch}\n`);
    parts.push(`CHANGED FILES (${files.length})\n${files.map((f) => `  ${f}`).join('\n') || '  (none)'}`);
    if (stagedTrunc) parts.push(`\nSTAGED DIFF\n${stagedTrunc}`);
    if (unstagedTrunc) parts.push(`\nUNSTAGED DIFF\n${unstagedTrunc}`);
    if (log) parts.push(`\nRECENT COMMITS (style reference, do not repeat)\n${log}`);
    let blob = parts.join('\n');
    let truncated = blob.length > maxContextChars;
    blob = truncate(blob, maxContextChars);

    return {
      isRepo: true,
      branch: branch || null,
      files,
      stagedDiff: stagedTrunc,
      unstagedDiff: unstagedTrunc,
      log: log || '',
      totalFiles: files.length,
      truncated,
      blob,
    };
  }

  /** Grants a concurrency slot. Throws when too many Git-agent jobs run at once. */
  acquire(requestId: string, onAbort?: () => void): void {
    if (this.active >= GIT_AGENT_MAX_CONCURRENT) {
      const err = new Error(`Too many concurrent Git-agent operations (max ${GIT_AGENT_MAX_CONCURRENT}). Try again shortly.`) as Error & { status?: number };
      err.status = 429;
      throw err;
    }
    this.active++;
    const controller = new AbortController();
    controller.signal.addEventListener('abort', () => onAbort?.(), { once: true });
    this.aborts.set(requestId, controller);
  }

  release(requestId: string): void {
    this.aborts.delete(requestId);
    this.active = Math.max(0, this.active - 1);
  }

  /** Generate (and stream) a commit message for the current changes. */
  async streamCommitMessage(
    params: CommitMessageStreamParams,
    hooks: LlmStreamHooks,
    emit?: (event: GitAgentStreamEvent) => void,
  ): Promise<CommitMessageResult> {
    this.acquire(params.requestId);
    try {
      const ctx = await this.collectContext(params.cwd, this.clampBudget(params.maxContextChars));
      if (!ctx.isRepo) throw new Error('Not a git repository.');
      if (ctx.files.length === 0) throw new Error('No changes to commit.');

      emit?.({ type: 'git.start', data: { branch: ctx.branch, files: ctx.files, truncated: ctx.truncated } });

      const instructionBlock = params.instruction?.trim()
        ? `\n\nThe user's requested wording (follow only where it matches the diff):\n${params.instruction.trim().slice(0, 2000)}`
        : '';

      const messages: LLMMessage[] = [
        { role: 'system', content: buildGitSystemPrompt('commit-message') },
        {
          role: 'user',
          content:
            `Write a conventional commit message for the staged/unstaged changes below.\n` +
            `Output ONLY the message: a one-line subject, then optionally a short bullet-point body.\n\n` +
            `---\n${ctx.blob}${instructionBlock}`,
        },
      ];

      const resp = await this.llmClient.callWithRetry(
        messages, [], params.provider, params.model, params.requestId, params.requestId, params.userId, hooks,
      );

      const raw = stripCodeFences(resp.content || '');
      const lines = raw.split('\n').filter((l) => l.trim());
      const subject = (lines[0] || 'chore: update').replace(/^[#\-\s]*/, '').trim();
      const body = lines.slice(1).filter((l) => !/^```/.test(l)).join('\n');

      return {
        subject,
        body,
        message: body ? `${subject}\n\n${body}` : subject,
        files: ctx.files,
        branch: ctx.branch,
        usage: resp.usage,
      };
    } finally {
      this.release(params.requestId);
    }
  }

  /** Review the working-tree changes and stream markdown. */
  async streamReview(
    params: ReviewStreamParams,
    hooks: LlmStreamHooks,
    emit?: (event: GitAgentStreamEvent) => void,
  ): Promise<GitReviewResult> {
    this.acquire(params.requestId);
    try {
      const ctx = await this.collectContext(params.cwd, this.clampBudget(params.maxContextChars));
      if (!ctx.isRepo) throw new Error('Not a git repository.');
      if (ctx.files.length === 0) throw new Error('No changes to review.');

      emit?.({ type: 'git.start', data: { branch: ctx.branch, files: ctx.files, truncated: ctx.truncated } });

      const instructionBlock = params.instruction?.trim()
        ? `\n\nThe user's focus area: ${params.instruction.trim().slice(0, 2000)}`
        : '';

      const messages: LLMMessage[] = [
        { role: 'system', content: buildGitSystemPrompt('review') },
        {
          role: 'user',
          content:
            `Review the working-tree changes below and return your review in markdown.\n\n` +
            `---\n${ctx.blob}${instructionBlock}`,
        },
      ];

      const resp = await this.llmClient.callWithRetry(
        messages, [], params.provider, params.model, params.requestId, params.requestId, params.userId, hooks,
      );

      const markdown = (resp.content || '').trim();
      return {
        markdown,
        status: /review before commit|needs.?attention|blocker|breaking change|red flag/i.test(markdown) ? 'attention' : 'ready',
        files: ctx.files,
        branch: ctx.branch,
        usage: resp.usage,
      };
    } finally {
      this.release(params.requestId);
    }
  }

  /** Abort an in-flight job (e.g. on SSE unsubscribe). */
  abort(requestId: string): void {
    const controller = this.aborts.get(requestId);
    if (controller) controller.abort(new Error('Request aborted'));
  }

  get concurrent(): number {
    return this.active;
  }

  /** Clamp a client-supplied context budget to a sane window so one request
   *  can never push the entire repository into the prompt. */
  private clampBudget(wanted?: number): number {
    if (!wanted || !Number.isFinite(wanted)) return MAX_CONTEXT_CHARS;
    return Math.max(4_000, Math.min(60_000, Math.round(wanted)));
  }

  get maxConcurrent(): number {
    return GIT_AGENT_MAX_CONCURRENT;
  }

  /** Kind-Label used in logs / errors. */
  static kindLabel(kind: GitAgentKind): string {
    return kind === 'commit-message' ? 'commit message' : 'change review';
  }
}