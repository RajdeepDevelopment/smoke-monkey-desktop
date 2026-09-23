import { Controller, Post, Body, Req, Sse, UseGuards, MessageEvent, Logger } from '@nestjs/common';
import { Observable } from 'rxjs';
import { randomUUID } from 'crypto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  GitAgentService,
  type CommitMessageStreamParams,
  type ReviewStreamParams,
  type GitAgentStreamEvent,
} from './services/git-agent.service';

export interface CommitMessageStreamBody {
  /** Absolute workspace path (must be a git repository). */
  cwd: string;
  /** Optional user wording instruction (guidance only, never overrides the diff). */
  instruction?: string;
  /** Currently selected model on the Agent page — passed straight through. */
  model?: string;
  provider?: string;
  /** Upper bound on diff context sent to the model (bytes of text). */
  maxContextChars?: number;
}

export interface ReviewStreamBody extends CommitMessageStreamBody {}

// Helper type so the controller stays dependency-light while giving explicit
// streaming hooks to the service.
export type GitStreamHooks = {
  onDelta?: (text: string) => void;
  onThought?: (text: string) => void;
};

/**
 * Git-agent streaming endpoints.
 *
 * Every route is JWT-guarded (same guard as the rest of the agent module). The
 * model used is the caller-supplied `model`/`provider`, which the frontend fills
 * from the currently selected model on the Agent page — there is NO hardcoded
 * model here.
 *
 * Each POST returns an SSE stream:
 *   git.start   → { branch, files, truncated }
 *   git.delta   → { delta }            (live text chunks)
 *   git.thought → { delta }            (live reasoning chunks)
 *   git.done    → final structured payload
 *   git.error   → { error }
 */
@UseGuards(JwtAuthGuard)
@Controller('agent/git')
export class GitAgentController {
  private readonly logger = new Logger(GitAgentController.name);

  constructor(private readonly gitAgent: GitAgentService) {}

  @Post('commit-message/stream')
  @Sse()
  commitMessageStream(@Body() body: CommitMessageStreamBody, @Req() req: any): Observable<MessageEvent> {
    const userId = req.user?.id || req.userId;
    const requestId = this.nextRequestId();
    const params: CommitMessageStreamParams = {
      cwd: body?.cwd || process.cwd(),
      instruction: body?.instruction,
      model: body?.model,
      provider: body?.provider,
      userId,
      requestId,
      maxContextChars: body?.maxContextChars,
    };
    return this.runStream('commit-message', (hooks, emitEvent) => this.gitAgent.streamCommitMessage(params, hooks, emitEvent), requestId);
  }

  @Post('review/stream')
  @Sse()
  reviewStream(@Body() body: ReviewStreamBody, @Req() req: any): Observable<MessageEvent> {
    const userId = req.user?.id || req.userId;
    const requestId = this.nextRequestId();
    const params: ReviewStreamParams = {
      cwd: body?.cwd || process.cwd(),
      instruction: body?.instruction,
      model: body?.model,
      provider: body?.provider,
      userId,
      requestId,
      maxContextChars: body?.maxContextChars,
    };
    return this.runStream('review', (hooks, emitEvent) => this.gitAgent.streamReview(params, hooks, emitEvent), requestId);
  }

  @Post('limit')
  async concurrent() {
    return { active: this.gitAgent.concurrent, max: this.gitAgent.maxConcurrent };
  }

  private nextRequestId(): string {
    return `git_${randomUUID().slice(0, 8)}`;
  }

  /** Runs a Git-agent job as an SSE stream with keepalive + client-abort wiring. */
  private runStream(
    kind: 'commit-message' | 'review',
    run: (hooks: GitStreamHooks, emitEvent: (event: GitAgentStreamEvent) => void) => Promise<any>,
    requestId: string,
  ): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      const toClient = (event: GitAgentStreamEvent) => {
        if (subscriber.closed) return;
        subscriber.next({ type: event.type, data: JSON.stringify(event.data ?? {}) } as MessageEvent);
      };

      const hooks: GitStreamHooks = {
        onDelta: (text) => toClient({ type: 'git.delta', data: { delta: text } }),
        onThought: (text) => toClient({ type: 'git.thought', data: { delta: text } }),
      };

      const keepalive = setInterval(() => {
        if (subscriber.closed) return;
        subscriber.next({ type: 'ping', data: '{}' } as MessageEvent);
      }, 15_000);

      const startedAt = Date.now();

      run(hooks, toClient)
        .then((result) => {
          if (!subscriber.closed) {
            subscriber.next({ type: 'git.done', data: JSON.stringify({ ...result, requestId }) } as MessageEvent);
          }
          subscriber.complete();
        })
        .catch((err) => {
          this.logger.warn(`Git-agent ${kind} failed (${requestId}): ${String(err?.message || err).slice(0, 200)}`);
          if (!subscriber.closed) {
            const status = Number(err?.status) === 429 ? 429 : 500;
            subscriber.next({
              type: 'git.error',
              data: JSON.stringify({ error: String(err?.message || err), requestId, status }),
            } as MessageEvent);
          }
          subscriber.complete();
        })
        .finally(() => {
          clearInterval(keepalive);
          const ms = Date.now() - startedAt;
          this.logger.log(`Git-agent ${kind} finished (${requestId}) in ${ms}ms`);
        });

      return () => {
        clearInterval(keepalive);
        this.gitAgent.abort(requestId);
      };
    });
  }
}