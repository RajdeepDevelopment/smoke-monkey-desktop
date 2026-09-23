import { API_URL, getToken, nativeFetch } from './api';

export interface TreeNode {
  name: string;
  type: 'file' | 'directory';
  path: string;
  children?: TreeNode[];
}

export type GitStatusCode = 'M' | 'A' | 'D' | 'U' | 'R' | 'C';

export interface GitStatusEntry {
  path: string;
  origPath?: string;
  x: string;
  y: string;
  status: GitStatusCode;
}

export interface GitStatusResult {
  isRepo: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
  /** Total number of change entries (entries may be just a page). */
  total?: number;
  entries: GitStatusEntry[];
}

/** Accept both the current shape and the legacy `{ repo, changes }` shape
 *  so a stale gateway build can never crash the SCM panel. */
export function normalizeGitStatus(raw: unknown): GitStatusResult {
  if (!raw || typeof raw !== 'object') return { isRepo: false, entries: [] };
  const r = raw as Record<string, any>;
  if (Array.isArray(r.entries)) {
    return { isRepo: r.isRepo !== false, branch: r.branch, ahead: r.ahead, behind: r.behind, total: r.total, entries: r.entries };
  }
  // Legacy gateway shape
  const changes = Array.isArray(r.changes) ? r.changes : [];
  const mapLegacy = (c: any): GitStatusEntry | null => c && typeof c.path === 'string'
    ? { path: c.path, origPath: c.origPath || c.originalPath, x: c.x || 'M', y: c.y || '', status: c.status || 'M' }
    : null;
  return {
    isRepo: r.isRepo ?? r.repo ?? changes.length > 0,
    branch: r.branch,
    ahead: r.ahead,
    behind: r.behind,
    total: r.total ?? r.totalCount,
    entries: changes.map(mapLegacy).filter((e): e is GitStatusEntry => e !== null),
  };
}

export interface ContentMatch {
  path: string;
  line: number;
  text: string;
}

/** Shared visual language for git status decorations (explorer + SCM panel). */
export const GIT_STATUS_META: Record<GitStatusCode, { label: string; color: string; title: string }> = {
  M: { label: 'M', color: '#E8B36B', title: 'Modified' },
  A: { label: 'A', color: '#7DCB7D', title: 'Added' },
  D: { label: 'D', color: '#F87171', title: 'Deleted' },
  U: { label: 'U', color: '#5FBFAF', title: 'Untracked' },
  R: { label: 'R', color: '#8FB8F5', title: 'Renamed' },
  C: { label: 'C', color: '#F87171', title: 'Conflict' },
};

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await nativeFetch(`${API_URL}${path}`, { ...options, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(body.message || `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const ideApi = {
  // ── Filesystem ──────────────────────────────────────────────────────────
  fileTree: (root: string, depth = 2) =>
    request<TreeNode[]>(`/api/agent/file-tree?path=${encodeURIComponent(root)}&depth=${depth}`),

  readFile: (path: string) =>
    request<{ content: string; binary: boolean; truncated: boolean }>(
      `/api/agent/fs/file?path=${encodeURIComponent(path)}`,
    ),

  /** Binary-safe read: base64 payload plus metadata for preview viewers. */
  readRawFile: (path: string) =>
    request<{ base64: string; size: number; truncated: boolean; mime: string }>(
      `/api/agent/fs/raw?path=${encodeURIComponent(path)}`,
    ),

  writeFile: (path: string, content: string) =>
    request<{ status: string }>('/api/agent/fs/write', {
      method: 'POST',
      body: JSON.stringify({ path, content }),
    }),

  createEntry: (path: string, type: 'file' | 'directory') =>
    request<{ status: string }>('/api/agent/fs/create', {
      method: 'POST',
      body: JSON.stringify({ path, type }),
    }),

  renameEntry: (from: string, to: string) =>
    request<{ status: string }>('/api/agent/fs/rename', {
      method: 'POST',
      body: JSON.stringify({ from, to }),
    }),

  deletePath: (path: string) =>
    request<{ status: string }>(`/api/agent/fs/path?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
    }),

  revealInFinder: (path: string) =>
    request<{ status: string }>('/api/agent/fs/reveal', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  /** Open the file with the OS-default application (PDF → Preview/browser,
   *  PPT → PowerPoint, XLSX → Excel/Numbers, etc.). */
  openFile: (path: string) =>
    request<{ status: string }>('/api/agent/fs/open', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  // ── Git ─────────────────────────────────────────────────────────────────
  gitStatus: async (root: string, opts?: { limit?: number; offset?: number }) => {
    const params = new URLSearchParams({ path: root });
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    if (opts?.offset != null) params.set('offset', String(opts.offset));
    return normalizeGitStatus(await request<unknown>(`/api/agent/git/status?${params.toString()}`));
  },

  gitDiffFile: (root: string, file: string) =>
    request<{ original: string; current: string; isBinary: boolean }>(
      `/api/agent/git/diff-file?path=${encodeURIComponent(root)}&file=${encodeURIComponent(file)}`,
    ),

  gitStage: (cwd: string, files: string[], unstage = false, all = false) =>
    request<{ status: string }>('/api/agent/git/stage', {
      method: 'POST',
      body: JSON.stringify({ cwd, files, unstage, all }),
    }),

  gitDiscard: (cwd: string, file: string, untracked = false) =>
    request<{ status: string }>('/api/agent/git/discard', {
      method: 'POST',
      body: JSON.stringify({ cwd, file, untracked }),
    }),

  gitInit: (cwd: string) =>
    request<{ ok: boolean; output?: string; error?: string }>('/api/agent/git/init', {
      method: 'POST',
      body: JSON.stringify({ cwd }),
    }),

  gitCommit: (cwd: string, message: string, stageAll = false) =>
    request<{ ok: boolean; output?: string; error?: string }>('/api/agent/git/commit', {
      method: 'POST',
      body: JSON.stringify({ cwd, message, stageAll }),
    }),

  gitFetch: (cwd: string) =>
    request<{ ok: boolean; output?: string; error?: string }>('/api/agent/git/fetch', {
      method: 'POST',
      body: JSON.stringify({ cwd }),
    }),

  gitPull: (cwd: string) =>
    request<{ ok: boolean; output?: string; error?: string }>('/api/agent/git/pull', {
      method: 'POST',
      body: JSON.stringify({ cwd }),
    }),

  gitPush: (cwd: string, setUpstream = false) =>
    request<{ ok: boolean; output?: string; error?: string }>('/api/agent/git/push', {
      method: 'POST',
      body: JSON.stringify({ cwd, setUpstream }),
    }),

  gitStashes: (cwd: string) =>
    request<{ stashes: string[] }>(`/api/agent/git/stashes?path=${encodeURIComponent(cwd)}`),

  gitStashPush: (cwd: string, message?: string) =>
    request<{ ok: boolean; output?: string; error?: string }>('/api/agent/git/stash/push', {
      method: 'POST',
      body: JSON.stringify({ cwd, ...(message ? { message } : {}) }),
    }),

  gitStashApply: (cwd: string, name?: string) =>
    request<{ ok: boolean; output?: string; error?: string }>('/api/agent/git/stash/apply', {
      method: 'POST',
      body: JSON.stringify({ cwd, ...(name ? { name } : {}) }),
    }),

  gitStashPop: (cwd: string, name?: string) =>
    request<{ ok: boolean; output?: string; error?: string }>('/api/agent/git/stash/pop', {
      method: 'POST',
      body: JSON.stringify({ cwd, ...(name ? { name } : {}) }),
    }),

  gitStashDrop: (cwd: string, name: string) =>
    request<{ ok: boolean; output?: string; error?: string }>('/api/agent/git/stash/drop', {
      method: 'POST',
      body: JSON.stringify({ cwd, name }),
    }),

  gitBranches: (cwd: string) =>
    request<{ branches: string[] }>(`/api/agent/git/branches?path=${encodeURIComponent(cwd)}`),

  gitCreateBranch: (cwd: string, name: string) =>
    request<{ ok: boolean; output?: string; error?: string }>('/api/agent/git/branch/create', {
      method: 'POST',
      body: JSON.stringify({ cwd, name }),
    }),

  gitSwitchBranch: (cwd: string, name: string) =>
    request<{ ok: boolean; output?: string; error?: string }>('/api/agent/git/branch/switch', {
      method: 'POST',
      body: JSON.stringify({ cwd, name }),
    }),

  // ── Search ──────────────────────────────────────────────────────────────
  searchFiles: (root: string, query: string, signal?: AbortSignal) =>
    request<{ files: string[] }>(
      `/api/agent/search/files?root=${encodeURIComponent(root)}&query=${encodeURIComponent(query)}`,
      { signal },
    ),

  searchContent: (root: string, query: string, opts: { caseSensitive?: boolean; include?: string; signal?: AbortSignal } = {}) => {
    const params = new URLSearchParams({ root, query });
    if (opts.caseSensitive) params.set('caseSensitive', 'true');
    if (opts.include) params.set('include', opts.include);
    return request<{ matches: ContentMatch[]; truncated: boolean }>(
      `/api/agent/search/content?${params.toString()}`,
      { signal: opts.signal },
    );
  },

  // ── FS events ───────────────────────────────────────────────────────────
  subscribeFsEvents(root: string, onEvent: () => void): () => void {
    const token = getToken();
    const url = `${API_URL}/api/agent/fs/events?root=${encodeURIComponent(root)}${token ? `&token=${token}` : ''}`;
    let es: EventSource | null = null;
    try {
      es = new EventSource(url);
      es.addEventListener('fs-event', onEvent);
      es.onerror = () => { /* keepalive/reconnect handled by browser */ };
    } catch {
      return () => {};
    }
    return () => {
      es?.close();
      es = null;
    };
  },
};
