import { API_URL, getToken, nativeFetch } from './api';
import { streamSse } from './sse';

/** Stream events emitted by the Git-agent SSE endpoints. */
export interface GitAgentStreamEvent {
  type: 'git.start' | 'git.delta' | 'git.thought' | 'git.done' | 'git.error' | 'ping' | string;
  branch?: string | null;
  files?: string[];
  truncated?: boolean;
  delta?: string;
  error?: string;
  status?: number;
  requestId?: string;
  subject?: string;
  body?: string;
  message?: string;
  markdown?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface GitAgentOptions {
  cwd: string;
  instruction?: string;
  model?: string;
  provider?: string;
  maxContextChars?: number;
}

async function* gitStreamPost(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): AsyncGenerator<GitAgentStreamEvent> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
  };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await nativeFetch(`${API_URL}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
      credentials: 'include',
    });
  } catch {
    throw new Error('Cannot reach the API server.');
  }

  if (!res.ok || !res.body) {
    const msg = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(msg.message || `Git-agent request failed (${res.status})`);
  }

  for await (const ev of streamSse(res, signal)) {
    yield ev as GitAgentStreamEvent;
  }
}

/**
 * Streaming Git-agent client.
 *
 * The `model`/`provider` fields MUST come from the currently selected model on
 * the Agent page — the backend uses exactly what the frontend sends and never
 * hardcodes an AI model for Git operations.
 */
export const gitApi = {
  /** Generate a commit message from the real staged/unstaged diff (streams). */
  streamCommitMessage: (opts: GitAgentOptions, signal?: AbortSignal) =>
    gitStreamPost('/api/agent/git/commit-message/stream', { ...opts }, signal),

  /** Review working-tree changes and stream a markdown report. */
  streamReview: (opts: GitAgentOptions, signal?: AbortSignal) =>
    gitStreamPost('/api/agent/git/review/stream', { ...opts }, signal),
};