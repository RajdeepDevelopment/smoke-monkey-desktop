import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const OMNI_BASE_URL = 'http://localhost:20128';
const KEY_NAME = 'sm-monkey';

/** Reactive lifecycle used to drive the "Initializing OmniRoute…" UI. */
export type OmniRouteStatus = 'unknown' | 'idle' | 'installing' | 'starting' | 'syncing' | 'ready' | 'error';

interface OmniKeyInfo {
  id?: string;
  name?: string;
  key?: string;
  scopes?: string[];
}

export interface OmniRouteStatusInfo {
  status: OmniRouteStatus;
  /** true when a gateway is healthy right now (mirrors reachability). */
  reachable: boolean;
  installing: boolean;
  starting: boolean;
  syncing: boolean;
  ready: boolean;
  error: string | null;
}

@Injectable()
export class OmniRouteService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OmniRouteService.name);
  private readonly envPath: string;
  private running = false;
  private pending: Promise<void> | null = null;
  private status: OmniRouteStatus = 'unknown';
  private statusError: string | null = null;

  constructor() {
    const projectRoot = this.findProjectRoot();
    this.envPath = path.join(projectRoot, 'apps/api-gateway/.env');
  }

  async onApplicationBootstrap(): Promise<void> {
    // Passive provisioning: make sure OmniRoute is installed + running and that
    // we can reuse a previously-persisted manage key. No password sync here
    // (the SM password is only known at login/register time).
    try {
      await this.ensureRunning();
      this.reusePersistedKey();
      this.status = 'ready';
    } catch (err) {
      this.setError('error', err);
      this.logger.warn(
        `OmniRoute passive provisioning skipped (will retry on login): ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Full provisioning, called on a successful SM login/register so that the
   * OmniRoute admin password matches the SM password and the real gateway is
   * wired up for the agent/chat.
   */
  async syncForUser(password: string): Promise<{ apiKey: string; baseUrl: string }> {
    // Serialize concurrent syncs to avoid racing each other (login storms).
    if (this.pending) {
      this.status = 'syncing';
      await this.pending;
    }
    let resolve!: () => void;
    this.pending = new Promise((r) => (resolve = r));
    try {
      const healthy = await this.isHealthy();
      const persisted = this.readEnvValue('OMNIROUTE_API_KEY');
      if (
        healthy &&
        persisted &&
        (await this.isKeyValid(persisted))
      ) {
        // OmniRoute is already running with a valid, persisted key — reuse it
        // as-is. No spawn (no browser tab), no password reset, no re-provision.
        process.env.OMNIROUTE_API_KEY = persisted;
        process.env.OMNIROUTE_BASE_URL = this.baseUrl;
        this.status = 'ready';
        this.logger.log(
          `Reusing healthy OmniRoute + persisted key ${this.mask(persisted)}`,
        );
        return { apiKey: persisted, baseUrl: this.baseUrl };
      }
      await this.ensureRunning();
      this.status = 'syncing';
      await this.setAdminPassword(password);
      const apiKey = await this.provisionManageKey(password);
      this.persistEnv(apiKey);
      // Reflect immediately in this process so the agent/chat can use it
      // without a restart.
      process.env.OMNIROUTE_API_KEY = apiKey;
      process.env.OMNIROUTE_BASE_URL = this.baseUrl;
      this.status = 'ready';
      return { apiKey, baseUrl: this.baseUrl };
    } catch (err) {
      this.setError('error', err);
      throw err;
    } finally {
      resolve();
    }
  }

  get apiKey(): string {
    return process.env.OMNIROUTE_API_KEY || '';
  }

  get baseUrl(): string {
    return `${OMNI_BASE_URL}/v1`;
  }

  /** Current lifecycle + reachability snapshot for the UI's init banner. */
  get statusInfo(): OmniRouteStatusInfo {
    const healthy = this.running;
    const installing = this.status === 'installing';
    const starting = this.status === 'starting';
    const syncing = this.status === 'syncing';
    const ready = this.status === 'ready' || healthy;
    return {
      status: this.status,
      reachable: this.isHealthySync(),
      installing,
      starting,
      syncing,
      ready,
      error: this.statusError,
    };
  }

  private setError(next: OmniRouteStatus, err: unknown): void {
    this.status = next;
    this.statusError = err instanceof Error ? err.message : String(err);
  }

  // ── bootstrap / reuse ────────────────────────────────────────────────────

  private reusePersistedKey(): void {
    const key = this.readEnvValue('OMNIROUTE_API_KEY');
    if (key) {
      process.env.OMNIROUTE_API_KEY = key;
      process.env.OMNIROUTE_BASE_URL = this.baseUrl;
      this.logger.log(
        `Reusing persisted OmniRoute key ${this.mask(key)} (${this.baseUrl})`,
      );
    }
  }

  // ── install / start / health ─────────────────────────────────────────────

  private async ensureRunning(): Promise<void> {
    if (await this.isHealthy()) {
      this.running = true;
      return;
    }
    if (!this.isInstalled()) {
      this.status = 'installing';
      this.statusError = null;
      this.logger.log('OmniRoute not installed; installing globally…');
      await this.install();
    }
    this.status = 'starting';
    this.statusError = null;
    this.logger.log('Starting OmniRoute gateway…');
    this.start();
    await this.waitUntilHealthy(30_000);
    this.running = true;
  }

  private async isHealthy(): Promise<boolean> {
    try {
      // OmniRoute's admin API lives at the root (not under /v1). Any HTTP
      // response — even a 401/404 — proves the server is up and reusable, so
      // avoid spawning a duplicate gateway (and its auto-opened browser tab).
      const res = await fetch(`${OMNI_BASE_URL}/api/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000),
      });
      return res.status > 0;
    } catch {
      return false;
    }
  }

  /** Synchronous best-effort reachability probe (used by the status endpoint). */
  private isHealthySync(): boolean {
    try {
      execFileSync('which', ['curl'], { stdio: 'ignore' });
      const out = execFileSync(
        'curl',
        ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '1', `${OMNI_BASE_URL}/api/health`],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const code = Number(String(out).trim());
      return code > 0;
    } catch {
      return false;
    }
  }

  /** Clear lifecycle state (used on logout). */
  reset(): void {
    this.status = 'unknown';
    this.statusError = null;
    this.running = false;
  }

  /**
   * Resolve the omniroute executable. An explicitly-provided OMNIROUTE_BIN
   * (desktop launcher) wins; otherwise check the known macOS install dirs
   * (Homebrew, /usr/local, nvm global bin, ~/.local) before falling back to
   * `omniroute` on PATH. GUI-launched apps inherit a minimal PATH that often
   * omits /opt/homebrew/bin, so a bare `which` is not enough.
   */
  private binaryPath(): string | null {
    if (process.env.OMNIROUTE_BIN && existsSync(process.env.OMNIROUTE_BIN)) {
      return process.env.OMNIROUTE_BIN;
    }
    const home = process.env.HOME || '';
    const candidates = [
      '/opt/homebrew/bin/omniroute',
      '/usr/local/bin/omniroute',
      path.join(home, '.local/bin/omniroute'),
    ];
    // npm global bins for nvm-style multi-version layouts (newest first).
    if (home) {
      const nvmRoot = path.join(home, '.nvm/versions/node');
      try {
        const versions = readdirSync(nvmRoot).sort().reverse();
        for (const v of versions) {
          candidates.push(path.join(nvmRoot, v, 'bin/omniroute'));
        }
      } catch {
        // ignore — no nvm install
      }
    }
    for (const candidate of candidates) {
      if (candidate && existsSync(candidate)) return candidate;
    }
    try {
      execFileSync('which', ['omniroute'], { stdio: 'ignore' });
      return 'omniroute';
    } catch {
      return null;
    }
  }

  /** PATH that also carries Homebrew/usr-local/nvm bins, for spawned children. */
  private toolPath(): string {
    const home = process.env.HOME || '';
    const dirs = [
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      path.join(home, '.local/bin'),
    ];
    const existing = (process.env.PATH || '').split(':').filter(Boolean);
    return [...new Set([...dirs, ...existing])].join(':');
  }

  private isInstalled(): boolean {
    return this.binaryPath() !== null;
  }

  private async install(): Promise<void> {
    // If an omniroute already resolves on PATH there's nothing to fetch.
    // Otherwise install the CLI via npm — pinned so it can never drift.
    if (this.binaryPath()) return;
    return new Promise((resolve, reject) => {
      execFile(
        'npm',
        ['install', '-g', 'omniroute@3.8.50'],
        { env: { ...process.env, PATH: this.toolPath() } },
        (err) => {
          if (err) return reject(err);
          resolve();
        },
      );
    });
  }

  private start(): void {
    // OmniRoute defaults to port 20128. The gateway process carries PORT=8642
    // (set by the launcher), which the spawned child would otherwise inherit,
    // causing OmniRoute to bind 8642 and collide with the gateway. Force a
    // clean, port-pinned env for the child while still passing through the
    // gateway's own OmniRoute key (env-bootstrap for a manage-scoped key).
    //
    // REQUIRE_API_KEY=false puts OmniRoute in keyless mode: the OpenAI-compatible
    // endpoints (/v1/models, /v1/chat/completions, …) accept anonymous requests
    // instead of demanding a bearer token (feature-flag, DB override > env >
    // default). The manage-key provisioning + password sync still run so the
    // agent/admin flows keep working.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: '20128',
      HOST: '127.0.0.1',
      OMNIROUTE_PORT: '20128',
      REQUIRE_API_KEY: 'false',
      PATH: this.toolPath(),
    };
    const bin = this.binaryPath() || 'omniroute';
    const child = spawn(bin, [], {
      env,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  }

  private async waitUntilHealthy(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isHealthy()) return;
      await sleep(500);
    }
    throw new Error('OmniRoute did not become healthy in time');
  }

  // ── admin password sync (same password as SM login) ─────────────────────

  private async setAdminPassword(password: string): Promise<void> {
    if (!password || password.length < 8) {
      this.logger.warn(
        'OmniRoute admin password requires >= 8 chars; skipping sync for shorter SM password',
      );
      return;
    }
    try {
      await runCommand(this.binaryPath() || 'omniroute', ['reset-password', '--password-stdin'], {
        input: password,
      });
      this.logger.log('OmniRoute admin password synced to SM password');
    } catch (err) {
      this.logger.error(
        `Failed to set OmniRoute admin password: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // ── manage key provisioning ──────────────────────────────────────────────

  private async provisionManageKey(password: string): Promise<string> {
    // Reuse a persisted key if still valid, before minting a new one.
    const persisted = process.env.OMNIROUTE_API_KEY;
    if (persisted && (await this.isKeyValid(persisted))) {
      this.logger.log(`Reusing valid OmniRoute manage key ${this.mask(persisted)}`);
      return persisted;
    }

    const session = await this.login(password);
    const created = await this.createManageKey(session, KEY_NAME);
    this.logger.log(
      `Provisioned OmniRoute manage key ${this.mask(created.key || '')} (${created.id || ''})`,
    );
    return created.key || '';
  }

  private async isKeyValid(key: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async login(password: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      throw new Error(`OmniRoute login failed (${res.status})`);
    }
    const setCookie = res.headers.get('set-cookie') || '';
    const match = setCookie.match(/auth_token=([^;]+)/);
    if (!match) {
      throw new Error('No auth_token returned by OmniRoute login');
    }
    return match[1];
  }

  private async findManageKey(
    session: string,
    name: string,
  ): Promise<OmniKeyInfo | null> {
    try {
      const res = await fetch(`${this.baseUrl}/api/keys`, {
        headers: { Cookie: `auth_token=${session}` },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { keys?: OmniKeyInfo[] };
      const found = (data.keys || []).find((k) => k.name === name);
      return found || null;
    } catch {
      return null;
    }
  }

  private async createManageKey(session: string, name: string): Promise<OmniKeyInfo> {
    const res = await fetch(`${this.baseUrl}/api/keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `auth_token=${session}`,
      },
      body: JSON.stringify({ name, scopes: ['manage'] }),
    });
    if (!res.ok) {
      throw new Error(`Failed to create OmniRoute key (${res.status})`);
    }
    return (await res.json()) as OmniKeyInfo;
  }

  // ── env persistence (apps/api-gateway/.env) ──────────────────────────────

  private persistEnv(apiKey: string): void {
    if (!existsSync(this.envPath)) {
      writeFileSync(this.envPath, '', 'utf8');
    }
    let lines: string[] = [];
    try {
      lines = readFileSync(this.envPath, 'utf8').split('\n');
    } catch {
      lines = [];
    }
    lines = setEnvLine(lines, 'OMNIROUTE_API_KEY', apiKey);
    lines = setEnvLine(lines, 'OMNIROUTE_BASE_URL', this.baseUrl);
    lines = setEnvLine(lines, 'OMNIROUTE_ENABLED', 'true');
    try {
      writeFileSync(this.envPath, lines.join('\n'), 'utf8');
      this.logger.log(
        `Persisted OmniRoute env to ${this.envPath} (key ${this.mask(apiKey)})`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to persist OmniRoute env: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private readEnvValue(key: string): string | undefined {
    if (!existsSync(this.envPath)) return undefined;
    for (const line of readFileSync(this.envPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const [k, v] = trimmed.split('=');
      if (k.trim() === key) return v.trim().replace(/^["']|["']$/g, '');
    }
    return undefined;
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private mask(key: string): string {
    if (!key) return '';
    if (key.length <= 12) return '***';
    return `${key.slice(0, 8)}…${key.slice(-6)}`;
  }

  private findProjectRoot(): string {
    // __dirname ~ .../apps/api-gateway/dist/modules/omniroute (prod)
    // or       ~ .../apps/api-gateway/src/modules/omniroute (dev/ts-node)
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
      if (existsSync(path.join(dir, 'apps/api-gateway'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return path.join(os.homedir(), 'smoke-monkey-desktop');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function setEnvLine(lines: string[], key: string, value: string): string[] {
  const prefix = `${key}=`;
  const idx = lines.findIndex((l) => l.trim().startsWith(prefix));
  if (idx >= 0) {
    lines[idx] = `${key}=${value}`;
  } else {
    lines.push(`${key}=${value}`);
  }
  return lines;
}

function runCommand(
  cmd: string,
  args: string[],
  opts: { input?: string } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited ${code}: ${stderr}`));
    });
    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });
}
