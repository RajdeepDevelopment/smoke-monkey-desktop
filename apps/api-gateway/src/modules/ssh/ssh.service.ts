import { Injectable, Logger, NotFoundException, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Client, type ConnectConfig } from 'ssh2';
import { SshConnection, SshAuthMethod } from './entities/ssh-connection.entity';
import {
  Connector,
  ConnectorDestination,
  ConnectorExecOptions,
  ConnectorExecResult,
  ConnectorFileInfo,
} from './connector.registry';

export interface CreateSshConnectionInput {
  name: string;
  host: string;
  port?: number;
  username?: string;
  authMethod?: SshAuthMethod;
  /** Raw private key (PEM) for key auth. */
  privateKey?: string;
  /** Plain text password for password auth. */
  password?: string;
  remoteHome?: string;
  strictHostKey?: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

export interface RemoteTreeNode {
  name: string;
  type: 'file' | 'directory';
  path: string;
  children?: RemoteTreeNode[];
}

/**
 * SSH connector. Shells out to the system `ssh` binary (zero new deps),
 * reusing the existing spawn-based pattern from terminal.tools. Auth:
 *   - key   → private key stored at-rest (AES-256-GCM) via ApiKeyCryptoService,
 *   - agent → forwards to the user's local ssh-agent (no secret stored),
 *   - password → sshpass into the local ssh process (stored at-rest).
 */
@Injectable()
export class SshService implements Connector {
  readonly id = 'ssh';
  readonly label = 'SSH';

  private readonly logger = new Logger(SshService.name);

  constructor(
    @InjectRepository(SshConnection)
    private readonly connections: Repository<SshConnection>,
    @Inject('SshCrypto') private readonly crypto: { encrypt(plaintext: string): string; decrypt(payload: string): string | null },
  ) {}

  // ── CRUD ────────────────────────────────────────────────────────────────

  async create(userId: string, input: CreateSshConnectionInput): Promise<SshConnection> {
    if (!input.host || !input.name) {
      throw new Error('name and host are required');
    }
    const authMethod: SshAuthMethod = input.authMethod || 'key';
    let encryptedSecret: string | null = null;
    let keyFingerprint: string | null = null;

    if (authMethod === 'password' && input.password) {
      encryptedSecret = this.encryptSafe(input.password);
    } else if (authMethod === 'key' && input.privateKey) {
      encryptedSecret = this.encryptSafe(input.privateKey);
      keyFingerprint = this.fingerprintKey(input.privateKey);
    }

    const row = this.connections.create({
      userId,
      name: input.name,
      host: input.host,
      port: input.port ?? 22,
      username: input.username || 'root',
      authMethod,
      encryptedSecret,
      keyFingerprint,
      remoteHome: input.remoteHome || '~',
      strictHostKey: !!input.strictHostKey,
    });
    return this.connections.save(row);
  }

  async findAll(userId: string): Promise<SshConnection[]> {
    return this.connections.find({ where: { userId }, order: { updatedAt: 'DESC' } });
  }

  async remove(userId: string, id: string): Promise<void> {
    const row = await this.connections.findOne({ where: { id, userId } });
    if (!row) throw new NotFoundException('SSH connection not found');
    await this.connections.remove(row);
  }

  async getOrFail(userId: string, id: string): Promise<SshConnection> {
    const row = await this.connections.findOne({ where: { id, userId } });
    if (!row) throw new NotFoundException('SSH connection not found');
    return row;
  }

  private encryptSafe(plain: string): string | null {
    try {
      return this.crypto.encrypt(plain);
    } catch {
      this.logger.warn('SSH secret encryption unavailable (missing API_KEY_ENCRYPTION_SECRET)');
      return null;
    }
  }

  private decryptSecret(row: SshConnection): string | null {
    if (!row.encryptedSecret) return null;
    try {
      return this.crypto.decrypt(row.encryptedSecret);
    } catch {
      return null;
    }
  }

  private fingerprintKey(privateKey: string): string | null {
    try {
      const hash = crypto.createHash('sha256');
      const pemBody = privateKey.trim().split('\n').slice(1, -1).join('');
      const der = Buffer.from(pemBody, 'base64');
      // ssh fingerprint is over the base64 body digest
      const digest = hash.update(der).digest('base64');
      return 'SHA256:' + digest.replace(/=+$/, '');
    } catch {
      return null;
    }
  }

  // ── Connector interface ─────────────────────────────────────────────────

  async listDestinations(userId: string): Promise<ConnectorDestination[]> {
    const rows = await this.findAll(userId);
    return rows.map((r) => ({
      id: r.id,
      label: `${r.name} (${r.username}@${r.host}:${r.port})`,
      root: r.remoteHome || '~',
    }));
  }

  async test(destinationId: string, userId: string): Promise<{ ok: boolean; detail?: string }> {
    const row = await this.getOrFail(userId, destinationId);
    try {
      const res = await this.execOn(row, 'true', { timeoutMs: 15_000 });
      return { ok: res.exitCode === 0, detail: res.exitCode === 0 ? 'connected' : res.stderr.trim() || `exit ${res.exitCode}` };
    } catch (err: any) {
      return { ok: false, detail: err.message };
    }
  }

  async exec(destinationId: string, userId: string, command: string, options?: ConnectorExecOptions): Promise<ConnectorExecResult> {
    const row = await this.getOrFail(userId, destinationId);
    return this.execOn(row, command, options);
  }

  async list(destinationId: string, userId: string, dir: string): Promise<ConnectorFileInfo[]> {
    const row = await this.getOrFail(userId, destinationId);
    const targetDir = dir || row.remoteHome || '~';
    // Emit a machine-readable format that works with both GNU and BSD ls:
    //   type size "name"   (type: d | f | l)
    const script =
      `cd ${quote(targetDir)} 2>/dev/null && ` +
      `ls -1A 2>/dev/null | while IFS= read -r f; do ` +
      `if [ -d "$f" ]; then t=d; elif [ -L "$f" ]; then t=l; else t=f; fi; ` +
      `s=$( [ -f "$f" ] && stat -c%s "$f" 2>/dev/null || stat -f%z "$f" 2>/dev/null || echo 0 ); ` +
      `printf '%s %s %s\\n' "$t" "\${s:-0}" "$f"; done`;
    const out = await this.execOn(row, script, { timeoutMs: 30_000 });
    if (out.exitCode !== 0 && !out.stdout) return [];
    return parseLs(out.stdout);
  }

  async read(destinationId: string, userId: string, filePath: string): Promise<{ content: string; size: number; truncated: boolean }> {
    const row = await this.getOrFail(userId, destinationId);
    const out = await this.execOn(row, `cat ${quote(filePath)}`, { timeoutMs: 60_000 });
    let content = out.stdout;
    let truncated = false;
    if (Buffer.byteLength(content, 'utf-8') > MAX_CAPTURE_BYTES) {
      content = content.slice(content.length - MAX_CAPTURE_BYTES);
      truncated = true;
    }
    return { content, size: Buffer.byteLength(content, 'utf-8'), truncated };
  }

  /** Writes a file on the remote host. Content is base64-encoded to avoid any
   *  shell quoting / newline issues. Creates parent dirs as needed. */
  async write(destinationId: string, userId: string, filePath: string, content: string): Promise<void> {
    const row = await this.getOrFail(userId, destinationId);
    const b64 = Buffer.from(content, 'utf-8').toString('base64');
    const dir = dirnameOf(filePath);
    const mkdir = dir ? `mkdir -p ${quote(dir)}; ` : '';
    await this.execOn(row, `${mkdir}printf '%s' '${b64}' | base64 -d > ${quote(filePath)}`, { timeoutMs: 60_000 });
  }

  async createEntry(destinationId: string, userId: string, remotePath: string, type: 'file' | 'directory'): Promise<void> {
    const row = await this.getOrFail(userId, destinationId);
    if (type === 'directory') {
      await this.execOn(row, `mkdir -p ${quote(remotePath)}`, { timeoutMs: 30_000 });
    } else {
      const dir = dirnameOf(remotePath);
      const mkdir = dir ? `mkdir -p ${quote(dir)}; ` : '';
      await this.execOn(row, `${mkdir}touch ${quote(remotePath)}`, { timeoutMs: 30_000 });
    }
  }

  async renameEntry(destinationId: string, userId: string, from: string, to: string): Promise<void> {
    const row = await this.getOrFail(userId, destinationId);
    await this.execOn(row, `mv ${quote(from)} ${quote(to)}`, { timeoutMs: 30_000 });
  }

  async deleteEntry(destinationId: string, userId: string, remotePath: string): Promise<void> {
    const row = await this.getOrFail(userId, destinationId);
    // `rm -rf` a regular file is safe; `rm -r` handles dirs. Path is absolute remote.
    await this.execOn(row, `rm -rf -- ${quote(remotePath)}`, { timeoutMs: 30_000 });
  }

  /** Resolves a possibly-relative remote path against the profile's remoteHome. */
  async resolve(destinationId: string, userId: string, remotePath: string): Promise<string> {
    const row = await this.getOrFail(userId, destinationId);
    const root = row.remoteHome || '~';
    if (!remotePath || remotePath === '~' || remotePath.startsWith('~')) return remotePath;
    if (remotePath.startsWith('/')) return remotePath;
    return `${root === '~' ? '~' : root}/${remotePath}`;
  }

  private readonly IGNORE_DIRS = new Set([
    '.git', '.next', 'dist', 'build', '.cache',
    '__pycache__', 'target', 'coverage', '.venv', 'venv',
    '.pytest_cache', '.mypy_cache', '.ruff_cache', '.gradle',
  ]);

  /** Recursive remote file tree mirroring WorkspaceService.listTree shape. */
  async listTree(destinationId: string, userId: string, rootDir: string, maxDepth = 2): Promise<RemoteTreeNode[]> {
    const row = await this.getOrFail(userId, destinationId);
    const root = rootDir || row.remoteHome || '~';
    const effectiveDepth = Math.max(1, Math.min(8, maxDepth));
    let nodeCount = 0;
    const MAX_NODES = 4000;

    // Build a fresh array per directory (NOT a shared outer array). The old
    // implementation returned the same `nodes` array from every level, so a
    // directory's `children` referenced the same array that later contained
    // the parent — producing a circular structure that crashed JSON.stringify
    // and made the remote explorer appear empty (500 -> []).
    const build = async (dir: string, depth: number): Promise<RemoteTreeNode[]> => {
      if (nodeCount >= MAX_NODES) return [];
      const entries = await this.list(destinationId, userId, dir);
      const seen = new Set<string>();
      const sorted = entries.filter((e) => {
        if (e.type === 'directory' && this.IGNORE_DIRS.has(e.name)) return false;
        return !seen.has(e.name);
      });
      const out: RemoteTreeNode[] = [];
      for (const e of sorted) {
        seen.add(e.name);
        const full = joinRemote(dir, e.name);
        const isDir = e.type === 'directory';
        let children: RemoteTreeNode[] | undefined = undefined;
        if (isDir && depth < effectiveDepth && nodeCount < MAX_NODES) {
          children = await build(full, depth + 1);
        }
        out.push({ name: e.name, type: isDir ? 'directory' : 'file', path: full, children });
        nodeCount++;
      }
      return out;
    };
    return build(root, 0);
  }

  /**
   * Remote git status, mirroring WorkspaceService.gitStatus's parsing so the
   * SCM panel works unchanged in Remote-SSH mode.
   */
  async gitStatusRemote(
    destinationId: string,
    userId: string,
    dir: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<{ isRepo: boolean; branch?: string; ahead?: number; behind?: number; total: number; entries: { path: string; origPath?: string; x: string; y: string; status: 'M' | 'A' | 'D' | 'U' | 'R' | 'C' }[] }> {
    const row = await this.getOrFail(userId, destinationId);
    const target = dir || row.remoteHome || '~';
    const runGit = (cmd: string) => this.execOn(row, cmd, { timeoutMs: 30_000 }).catch((): null => null);
    const out = await runGit(`cd ${quote(target)} 2>/dev/null && git rev-parse --is-inside-work-tree 2>/dev/null`);
    const isRepo = !!(out && out.exitCode === 0 && out.stdout.trim() === 'true');
    if (!isRepo) return { isRepo: false, entries: [], total: 0 };

    const [bOut, abOut, stOut] = await Promise.all([
      runGit(`cd ${quote(target)} && git rev-parse --abbrev-ref HEAD 2>/dev/null`),
      runGit(`cd ${quote(target)} && git rev-parse --left-right --count HEAD...@{upstream} 2>/dev/null`),
      runGit(`cd ${quote(target)} && git status --porcelain=v1 --untracked-files=all 2>/dev/null`),
    ]);

    const entries: { path: string; origPath?: string; x: string; y: string; status: 'M' | 'A' | 'D' | 'U' | 'R' | 'C' }[] = [];
    const status = stOut?.stdout ?? '';
    for (const line of status.split('\n')) {
      if (!line) continue;
      const x = line[0];
      const y = line[1];
      let filePart = line.substring(3);
      let origPath: string | undefined;
      if (filePart.startsWith('"') && filePart.endsWith('"')) filePart = filePart.slice(1, -1);
      if (x === 'R' || y === 'R') {
        const arrowIdx = filePart.indexOf(' -> ');
        if (arrowIdx !== -1) {
          origPath = filePart.substring(0, arrowIdx);
          filePart = filePart.substring(arrowIdx + 4);
        }
      }
      let status_code: 'M' | 'A' | 'D' | 'U' | 'R' | 'C';
      if (x === '?' && y === '?') status_code = 'U';
      else if (x === 'A' || y === 'A') status_code = 'A';
      else if (x === 'D' || y === 'D') status_code = 'D';
      else if (x === 'R' || y === 'R') status_code = 'R';
      else if (x === 'U' || y === 'U') status_code = 'C';
      else status_code = 'M';
      entries.push({ path: filePart, origPath, x, y, status: status_code });
    }

    let ahead: number | undefined;
    let behind: number | undefined;
    if (abOut?.stdout) {
      const [l, r] = abOut.stdout.trim().split(/\s+/).map(Number);
      if (!Number.isNaN(l)) ahead = l;
      if (!Number.isNaN(r)) behind = r;
    }

    const total = entries.length;
    const scope = opts?.limit != null;
    const start = scope ? (opts.offset ?? 0) : 0;
    const end = scope ? start + Math.max(opts.limit ?? 0, 1) : entries.length;
    const page = scope ? entries.slice(start, end) : entries;

    return {
      isRepo: true,
      branch: bOut?.stdout ? bOut.stdout.trim() : undefined,
      ahead,
      behind,
      total,
      entries: page,
    };
  }

  /**
   * Streams a remote command's output live. Each snapshot is pushed through
   * `onChunk` as it arrives so an SSE/WebSocket endpoint can relay it to the
   * FE terminal in real time (same REST+SSE pattern as the editor/agent).
   */
  async streamExec(
    destinationId: string,
    userId: string,
    command: string,
    onChunk: (data: string) => void,
    options: ConnectorExecOptions = {},
  ): Promise<ConnectorExecResult> {
    const row = await this.getOrFail(userId, destinationId);
    let last: { header: string; out: string; err: string } | null = null;
    const result = await this.execOn(row, command, {
      ...options,
      onStream: (header, stdout, stderr) => {
        last = { header, out: stdout, err: stderr };
        let body = header + stdout;
        if (stderr.trim().length > 0) {
          if (body.length > 0 && !body.endsWith('\n')) body += '\n';
          body += `[stderr]\n${stderr}`;
        }
        if (body.trim()) onChunk(body);
      },
    });
    // Ensure a final flush so trailing buffered output reaches the client.
    if (last && (last.out.length || last.err.length)) {
      let body = last.header + last.out;
      if (last.err.trim().length > 0) {
        if (body.length > 0 && !body.endsWith('\n')) body += '\n';
        body += `[stderr]\n${last.err}`;
      }
      if (body.trim()) onChunk(body);
    }
    return result;
  }

  // ── Core exec helpers ───────────────────────────────────────────────────

  /** Builds an ssh2 connection config from a saved profile. No system `ssh` or
   *  `sshpass` binary is required — key, password, and agent auth are handled
   *  natively by the pure-JS ssh2 client (the same approach Remote-SSH uses),
   *  which fixes password connections that previously failed because sshpass
   *  was not installed. */
  private toConnectConfig(row: SshConnection): ConnectConfig {
    const cfg: ConnectConfig = {
      host: row.host,
      port: row.port ?? 22,
      username: row.username,
      // Fail fast on an unreachable/slow host so the UI never hangs on connect.
      readyTimeout: 8_000,
      keepaliveInterval: 30_000,
      keepaliveCountMax: 3,
      algorithms: { serverHostKey: ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ssh-rsa'] },
    };

    if (!row.strictHostKey) {
      // Accept any host key on first connect (VS Code Remote-SSH's default
      // "not trusted" flow relaxed for the agent): avoid blocking on a prompt.
      cfg.hostVerifier = () => true;
    }

    if (row.authMethod === 'password') {
      cfg.password = this.decryptSecret(row) ?? undefined;
    } else if (row.authMethod === 'key') {
      cfg.privateKey = this.decryptSecret(row) ?? undefined;
    } else if (row.authMethod === 'agent') {
      // Forward to the user's local ssh-agent. Resolve the agent socket from
      // the environment (and common OpenSSH locations) rather than assuming
      // SSH_AUTH_SOCK is set — GUI-launched apps often miss it. Only fall back
      // to 'pageant' on Windows, where that is the agent transport.
      const sock = resolveAgentSocket();
      if (sock) cfg.agent = sock;
    }
    return cfg;
  }

  /** Runs `command` over a fresh ssh2 session. `options.env` is intentionally
   *  not applied (ssh2 has no remote env injection for exec) — higher-level
   *  callers that need env pass it inline in the command instead. */
  async execOn(
    row: SshConnection,
    command: string,
    options: ConnectorExecOptions = {},
  ): Promise<ConnectorExecResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const cfg = this.toConnectConfig(row);
    return new Promise((resolve) => {
      const client = new Client();
      let settled = false;
      let stdoutBuf = Buffer.alloc(0);
      let stderrBuf = Buffer.alloc(0);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { client.end(); } catch {}
      }, timeoutMs);

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (options.onStream) options.onStream('', stdoutBuf.toString('utf-8'), stderrBuf.toString('utf-8'));
        resolve({ stdout: stdoutBuf.toString('utf-8'), stderr: stderrBuf.toString('utf-8'), exitCode: null, timedOut });
      };

      client.on('ready', () => {
        client.exec(command, { pty: false }, (err, stream): void => {
          if (err || !stream) {
            client.end();
            if (err) {
              settled = true; clearTimeout(timer);
              resolve({ stdout: '', stderr: `[ssh] exec failed: ${err.message}`, exitCode: null, timedOut: false });
            }
            return;
          }
          const push = (buf: Buffer, isStdout: boolean) => {
            const target = isStdout ? stdoutBuf : stderrBuf;
            const merged = Buffer.concat([target, buf]);
            const kept = merged.length > MAX_CAPTURE_BYTES ? merged.subarray(merged.length - MAX_CAPTURE_BYTES) : merged;
            if (isStdout) stdoutBuf = kept; else stderrBuf = kept;
            if (options.onStream) options.onStream('', stdoutBuf.toString('utf-8'), stderrBuf.toString('utf-8'));
          };
          stream.on('data', (d: Buffer) => push(d, true));
          stream.stderr.on('data', (d: Buffer) => push(d, false));
          stream.on('exit', (code: number | null) => {
            settled = true; clearTimeout(timer);
            if (options.onStream) options.onStream('', stdoutBuf.toString('utf-8'), stderrBuf.toString('utf-8'));
            resolve({ stdout: stdoutBuf.toString('utf-8'), stderr: stderrBuf.toString('utf-8'), exitCode: code, timedOut });
            client.end();
          });
          stream.on('close', () => { try { client.end(); } catch {} });
        });
      });

      client.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout: '', stderr: `[ssh] connection failed: ${err.message}`, exitCode: null, timedOut: false });
      });
      client.on('close', () => {
        // If we never settled (e.g. remote closed after command), finalize.
        if (!settled) finish();
      });

      client.connect(cfg);
    });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Resolves the local ssh-agent socket for agent auth. Prefers $SSH_AUTH_SOCK,
 * then scans the common OpenSSH locations (TMPDIR/`/tmp` and the macOS per-user
 * socket). Returns undefined if no agent socket is found so ssh2 can fall back
 * to its default auth order instead of pointing at a bogus path.
 */
function resolveAgentSocket(): string | undefined {
  const fromEnv = process.env.SSH_AUTH_SOCK;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const candidates: string[] = [];
  const tmp =
    process.env.TMPDIR ||
    process.env.TMP ||
    process.env.TEMP ||
    (process.platform === 'darwin' ? '/tmp' : '/tmp/ssh-XXXXXX');
  // Common non-deterministic OpenSSH locations: ssh-agent creates a socket
  // under $TMPDIR/ssh-*/agent.PID.
  try {
    for (const name of fs.readdirSync(tmp)) {
      if (name.startsWith('ssh-')) {
        const dir = path.join(tmp, name);
        for (const file of fs.readdirSync(dir)) {
          if (file.startsWith('agent.')) {
            candidates.push(path.join(dir, file));
          }
        }
      }
    }
  } catch {
    /* ignore — scanning may fail if the dir is absent */
  }

  if (process.platform === 'darwin') {
    const home = process.env.HOME || '';
    if (home) candidates.push(path.join(home, '.ssh', 'agent.sock'));
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}

/**
 * Quotes a remote path for a shell command. Paths are single-quoted so spaces
 * and metacharacters are safe, EXCEPT a leading `~`/`~/` which bash does not
 * expand inside single quotes — that is rewritten to "$HOME" (double-quoted)
 * so default home-relative remote paths (`~`, `~/src`) resolve correctly.
 */
function quote(s: string): string {
  let expanded = '';
  let rest = s;
  if (s === '~') {
    expanded = '$HOME';
    rest = '';
  } else if (s.startsWith('~/')) {
    expanded = '$HOME';
    rest = s.slice(1); // "/sub/path"
  }
  if (expanded) {
    const safe = rest.replace(/(["\\$`])/g, '\\$1');
    return `"${expanded}${safe}"`;
  }
  return `'` + s.replace(/'/g, `'\\''`) + `'`;
}

function dirnameOf(p: string): string {
  const idx = p.lastIndexOf('/');
  if (idx <= 0) return '';
  return p.slice(0, idx);
}

function joinRemote(base: string, name: string): string {
  if (base === '~') return `~/${name}`;
  return `${base.replace(/\/$/, '')}/${name}`;
}

/** Parses the machine-readable `type size name` output from lightList(). */
function parseLs(stdout: string): ConnectorFileInfo[] {
  const files: ConnectorFileInfo[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    // type size name  (name may contain spaces)
    const m = line.match(/^([dfl])\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const [, typeCh, sizeStr, name] = m;
    const nameClean = name.trim();
    if (!nameClean || nameClean === '.' || nameClean === '..') continue;
    files.push({
      name: nameClean,
      type: typeCh === 'd' ? 'directory' : typeCh === 'l' ? 'symlink' : 'file',
      size: parseInt(sizeStr, 10) || 0,
    });
  }
  return files.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1,
  );
}
