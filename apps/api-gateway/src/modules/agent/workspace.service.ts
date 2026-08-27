import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.cache',
  '__pycache__', 'target', 'coverage', '.venv', 'venv',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.gradle',
]);
const IGNORE_FILES = new Set(['.DS_Store']);

/** Directories that must never be scanned by search (with or without .gitignore). */
export const SEARCH_EXCLUDE_DIRS = [
  'node_modules', '.git', 'dist', 'build', '.next', 'target', 'coverage',
  '.cache', '.turbo', 'vendor', '.venv', 'venv', '__pycache__', '.gradle',
  '.pytest_cache', '.mypy_cache', '.ruff_cache',
];

export interface TreeNode {
  name: string;
  type: 'file' | 'directory';
  path: string;
  children?: TreeNode[];
}

export interface GitStatusEntry {
  path: string;
  origPath?: string;
  x: string;
  y: string;
  status: 'M' | 'A' | 'D' | 'U' | 'R' | 'C';
}

export interface GitStatusResult {
  isRepo: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
  entries: GitStatusEntry[];
}

export interface ContentMatch {
  path: string;
  line: number;
  text: string;
}

export interface FsEvent {
  kind: 'change';
  at: number;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_RAW_BYTES = 20 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
  pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm',
  mp3: 'audio/mpeg', wav: 'audio/wav', woff: 'font/woff', woff2: 'font/woff2',
  ttf: 'font/ttf', otf: 'font/otf', zip: 'application/zip',
  gz: 'application/gzip', json: 'application/json', wasm: 'application/wasm',
};

function detectMime(p: string): string {
  const ext = p.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

@Injectable()
export class WorkspaceService {
  private watchers = new Map<string, {
    watcher: fs.FSWatcher;
    subjects: Set<Subject<FsEvent>>;
    timer: NodeJS.Timeout | null;
    pending: boolean;
  }>();

  // ── File tree ────────────────────────────────────────────────────────────

  async listTree(root: string, maxDepth = 2): Promise<TreeNode[]> {
    return this.buildTree(root, 0, Math.max(1, Math.min(8, maxDepth)));
  }

  private async buildTree(dirPath: string, depth: number, maxDepth: number): Promise<TreeNode[]> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dirPath, { withFileTypes: true });
    } catch {
      return [];
    }
    const filtered = entries.filter((e) => {
      if (e.isDirectory()) return !IGNORE_DIRS.has(e.name) && !e.name.startsWith('.');
      if (e.isFile()) return !IGNORE_FILES.has(e.name);
      return false;
    });
    filtered.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });
    const nodes: TreeNode[] = [];
    for (const e of filtered.slice(0, 300)) {
      const fullPath = dirPath.replace(/\/$/, '') + '/' + e.name;
      if (e.isDirectory()) {
        nodes.push({
          name: e.name,
          type: 'directory',
          path: fullPath,
          children: depth < maxDepth ? await this.buildTree(fullPath, depth + 1, maxDepth) : undefined,
        });
      } else {
        nodes.push({ name: e.name, type: 'file', path: fullPath });
      }
    }
    return nodes;
  }

  // ── File CRUD ────────────────────────────────────────────────────────────

  async readFile(p: string): Promise<{ content: string; binary: boolean; truncated: boolean }> {
    const stat = await fsp.stat(p).catch((): fs.Stats | null => null);
    if (!stat || stat.isDirectory()) throw new Error('File not found');
    const size = Math.min(stat.size, MAX_FILE_BYTES);
    const fh = await fsp.open(p, 'r');
    try {
      const buf = Buffer.alloc(size);
      await fh.read(buf, 0, size, 0);
      const sample = buf.subarray(0, Math.min(buf.length, 8192));
      const binary = sample.includes(0);
      return { content: binary ? '' : buf.toString('utf-8'), binary, truncated: stat.size > MAX_FILE_BYTES };
    } finally {
      await fh.close();
    }
  }

  async writeFile(p: string, content: string): Promise<void> {
    await fsp.mkdir(p.split('/').slice(0, -1).join('/'), { recursive: true });
    await fsp.writeFile(p, content, 'utf-8');
  }

  /** Binary-safe read returning base64 + metadata for preview viewers. */
  async readRaw(p: string): Promise<{ base64: string; size: number; truncated: boolean; mime: string }> {
    const stat = await fsp.stat(p).catch((): fs.Stats | null => null);
    if (!stat || stat.isDirectory()) throw new Error('File not found');
    const size = Math.min(stat.size, MAX_RAW_BYTES);
    const fh = await fsp.open(p, 'r');
    try {
      const buf = Buffer.alloc(size);
      if (size > 0) await fh.read(buf, 0, size, 0);
      return {
        base64: buf.toString('base64'),
        size: stat.size,
        truncated: stat.size > MAX_RAW_BYTES,
        mime: detectMime(p),
      };
    } finally {
      await fh.close();
    }
  }

  async createEntry(p: string, type: 'file' | 'directory'): Promise<void> {
    if (fs.existsSync(p)) throw new Error('Already exists');
    if (type === 'directory') {
      await fsp.mkdir(p, { recursive: true });
    } else {
      await fsp.mkdir(p.split('/').slice(0, -1).join('/'), { recursive: true });
      await fsp.writeFile(p, '', 'utf-8');
    }
  }

  async renameEntry(from: string, to: string): Promise<void> {
    await fsp.mkdir(to.split('/').slice(0, -1).join('/'), { recursive: true });
    await fsp.rename(from, to);
  }

  async deleteEntry(p: string): Promise<void> {
    await fsp.rm(p, { recursive: true, force: true });
  }

  async revealInFinder(p: string): Promise<void> {
    if (process.platform === 'darwin') {
      await execFileAsync('open', ['-R', p]).catch(() => execFileAsync('open', [p]));
    } else if (process.platform === 'win32') {
      await execFileAsync('explorer', ['/select,', p]).catch(() => {});
    } else {
      await execFileAsync('xdg-open', [p]).catch(() => {});
    }
  }

  // ── Git ──────────────────────────────────────────────────────────────────

  private async git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  }

  private async gitTry(cwd: string, args: string[]): Promise<string | null> {
    try {
      return await this.git(cwd, args);
    } catch {
      return null;
    }
  }

  async isGitRepo(cwd: string): Promise<boolean> {
    return (await this.gitTry(cwd, ['rev-parse', '--is-inside-work-tree'])) === 'true\n' ||
      (await this.gitTry(cwd, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  }

  async gitStatus(cwd: string): Promise<GitStatusResult> {
    const isRepo = await this.isGitRepo(cwd);
    if (!isRepo) return { isRepo: false, entries: [] };

    const [branch, aheadBehind, status] = await Promise.all([
      this.gitTry(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
      this.gitTry(cwd, ['rev-parse', '--left-right', '--count', 'HEAD...@{upstream}']),
      this.gitTry(cwd, ['status', '--porcelain=v1']),
    ]);

    const entries: GitStatusEntry[] = [];
    for (const line of (status || '').split('\n')) {
      if (!line) continue;
      const x = line[0];
      const y = line[1];
      let filePart = line.substring(3);
      let origPath: string | undefined;
      if (filePart.startsWith('"') && filePart.endsWith('"')) {
        filePart = filePart.slice(1, -1);
      }
      if (x === 'R' || y === 'R') {
        const arrowIdx = filePart.indexOf(' -> ');
        if (arrowIdx !== -1) {
          origPath = filePart.substring(0, arrowIdx);
          filePart = filePart.substring(arrowIdx + 4);
        }
      }
      let status_code: GitStatusEntry['status'];
      if (x === '?' && y === '?') status_code = 'U';
      else if (x === 'A' || y === 'A') status_code = 'A';
      else if (x === 'D' || y === 'D') status_code = 'D';
      else if (x === 'R' || y === 'R') status_code = 'R';
      else if (x === 'U' || y === 'U' || x === 'A' && y === 'A') status_code = 'C';
      else status_code = 'M';
      entries.push({ path: filePart, origPath, x, y, status: status_code });
    }

    let ahead: number | undefined;
    let behind: number | undefined;
    if (aheadBehind) {
      const [l, r] = aheadBehind.trim().split(/\s+/).map(Number);
      if (!Number.isNaN(l)) ahead = l;
      if (!Number.isNaN(r)) behind = r;
    }

    return {
      isRepo: true,
      branch: branch ? branch.trim() : undefined,
      ahead,
      behind,
      entries,
    };
  }

  async gitDiffFile(cwd: string, file: string): Promise<{ original: string; current: string; isBinary: boolean }> {
    const read = await this.readFile(`${cwd}/${file}`).catch(() => ({ content: '', binary: false }));
    const headVersion = await this.gitTry(cwd, ['show', `HEAD:${file}`]);
    const indexVersion = await this.gitTry(cwd, ['show', `:${file}`]);
    return {
      original: headVersion ?? '',
      current: read.binary ? '(binary file)' : read.content,
      isBinary: read.binary,
    };
  }

  async gitStage(cwd: string, files: string[], unstage = false): Promise<void> {
    if (unstage) {
      await this.git(cwd, ['reset', 'HEAD', '--', ...files]);
    } else {
      await this.git(cwd, ['add', '--', ...files]);
    }
  }

  async gitDiscard(cwd: string, file: string, untracked: boolean): Promise<void> {
    if (untracked) {
      await fsp.rm(`${cwd}/${file}`, { force: true });
    } else {
      await this.git(cwd, ['checkout', 'HEAD', '--', file]);
    }
  }

  // ── Search ───────────────────────────────────────────────────────────────

  async searchFiles(root: string, query: string, limit = 200, signal?: AbortSignal): Promise<string[]> {
    const q = query.toLowerCase();
    if (!q) return [];
    const results: string[] = [];
    const stack: string[] = [root];
    let scanned = 0;
    while (stack.length > 0 && results.length < limit && scanned < 30_000) {
      if (signal?.aborted) break;
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      scanned += entries.length;
      for (const e of entries) {
        if (results.length >= limit) break;
        if (signal?.aborted) break;
        const full = dir + '/' + e.name;
        if (e.isDirectory()) {
          if (!IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(full);
        } else if (e.isFile() && !IGNORE_FILES.has(e.name)) {
          if (e.name.toLowerCase().includes(q)) results.push(full);
        }
      }
    }
    return results.sort();
  }

  private rgCache: boolean | null = null;
  private async hasRipgrep(): Promise<boolean> {
    if (this.rgCache !== null) return this.rgCache;
    try {
      await execFileAsync('which', ['rg'], { timeout: 5000 });
      this.rgCache = true;
    } catch {
      this.rgCache = false;
    }
    return this.rgCache;
  }

  async searchContent(
    root: string,
    query: string,
    opts: { caseSensitive?: boolean; include?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<{ matches: ContentMatch[]; truncated: boolean }> {
    if (!query) return { matches: [], truncated: false };
    const limit = Math.min(500, Math.max(10, opts.limit ?? 200));
    const useRg = await this.hasRipgrep();

    // Never let the searcher descend into dependency/build directories,
    // even when the project has no .gitignore for them.
    const excludeArgs = useRg
      ? SEARCH_EXCLUDE_DIRS.flatMap((d) => ['-g', `!${d}/**`])
      : SEARCH_EXCLUDE_DIRS.flatMap((d) => [`--exclude-dir=${d}`]);

    const args: string[] = useRg
      ? [
          '--no-heading', '--line-number', '--color', 'never', '--smart-case',
          '--max-filesize', '512K',
          '-m', '20',
          ...excludeArgs,
          ...(opts.include ? ['-g', opts.include] : []),
          query,
          root,
        ]
      : [
          '-rnI',
          ...(opts.caseSensitive ? [] : ['-i']),
          ...excludeArgs,
          ...(opts.include ? [`--include=${opts.include}`] : []),
          query,
          root,
        ];

    let stdout = '';
    try {
      const res = await execFileAsync(useRg ? 'rg' : 'grep', args, {
        cwd: root,
        timeout: 12_000,
        maxBuffer: 8 * 1024 * 1024,
        signal: opts.signal as any,
      });
      stdout = res.stdout;
    } catch (err: any) {
      if (err?.name === 'AbortError' || opts.signal?.aborted) return { matches: [], truncated: false };
      if (err.status === 1 || err.code === 1) return { matches: [], truncated: false };
      if (err.killed) return { matches: [], truncated: true };
      stdout = err.stdout || '';
      if (!stdout) return { matches: [], truncated: false };
    }

    const prefix = root.endsWith('/') ? root : root + '/';
    const matches: ContentMatch[] = [];
    let truncated = false;
    for (const line of stdout.split('\n')) {
      if (!line) continue;
      const sep = useRg ? ':' : ':';
      const firstColon = line.indexOf(sep);
      if (firstColon === -1) continue;
      const file = line.slice(0, firstColon);
      const rest = line.slice(firstColon + 1);
      const secondColon = rest.indexOf(sep);
      if (secondColon === -1) continue;
      const lineNum = parseInt(rest.slice(0, secondColon), 10);
      if (Number.isNaN(lineNum)) continue;
      const text = rest.slice(secondColon + 1).slice(0, 300);
      if (matches.length >= limit) {
        truncated = true;
        break;
      }
      matches.push({ path: file.startsWith('/') ? file : `${root}/${file}`.replace(prefix + prefix, prefix), line: lineNum, text });
    }
    return { matches, truncated };
  }

  // ── FS watcher ───────────────────────────────────────────────────────────

  watchFs(root: string): Observable<FsEvent> {
    return new Observable<FsEvent>((subscriber) => {
      const key = root;

      const emit = () => {
        for (const s of entry.subjects) {
          try { s.next({ kind: 'change', at: Date.now() }); } catch { /* closed */ }
        }
      };

      let entry = this.watchers.get(key);
      if (!entry) {
        let watcher: fs.FSWatcher;
        try {
          watcher = fs.watch(root, { recursive: true }, () => {
            const e = this.watchers.get(key);
            if (!e || e.pending) return;
            e.pending = true;
            setTimeout(() => {
              const cur = this.watchers.get(key);
              if (cur) {
                cur.pending = false;
                if (cur.subjects.size > 0) emit();
              }
            }, 300);
          });
          watcher.on('error', () => { /* ignore */ });
        } catch {
          subscriber.complete();
          return;
        }
        entry = { watcher, subjects: new Set(), timer: null, pending: false };
        this.watchers.set(key, entry);
      }

      const subject = new Subject<FsEvent>();
      entry.subjects.add(subject);
      const sub = subject.subscribe(subscriber);

      const keepalive = setInterval(() => {
        try { subscriber.next({ kind: 'change', at: Date.now() }); } catch { /* closed */ }
      }, 25_000);

      return () => {
        sub.unsubscribe();
        clearInterval(keepalive);
        const cur = this.watchers.get(key);
        if (cur) {
          cur.subjects.delete(subject);
          if (cur.subjects.size === 0) {
            cur.timer = setTimeout(() => {
              const late = this.watchers.get(key);
              if (late && late.subjects.size === 0) {
                late.watcher.close();
                this.watchers.delete(key);
              }
            }, 5_000);
          }
        }
      };
    });
  }
}
