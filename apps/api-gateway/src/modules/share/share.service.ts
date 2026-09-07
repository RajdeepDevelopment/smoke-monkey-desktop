import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { ShareConfig } from './share.entity';

const TUNNEL_URL_RE = /(https:\/\/(?:[a-z0-9-]+\.)+trycloudflare\.com)/i;

export interface TunnelStatus {
  running: boolean;
  url: string | null;
  startedAt: string | null;
  hostname: string | null;
  error: string | null;
}

export interface ShareStatus {
  quickTunnel: TunnelStatus;
  persistentTunnel: TunnelStatus;
  cloudflaredAvailable: boolean;
  cloudflaredVersion: string | null;
  wranglerAvailable: boolean;
  wranglerLoggedIn: boolean;
  config: {
    projectName: string;
    accountId: string | null;
    tunnelHostname: string | null;
    pagesProjectName: string | null;
    outputDir: string;
  };
}

export interface QuickTunnelOptions {
  /** Local origin to expose, e.g. http://127.0.0.1:3001. */
  url: string;
}

function resolveCloudflared(): string | null {
  const candidates = [
    'cloudflared',
    path.join(os.homedir(), '.cloudflared', 'cloudflared'),
    '/usr/local/bin/cloudflared',
    '/opt/homebrew/bin/cloudflared',
    '/usr/bin/cloudflared',
  ].filter(Boolean);
  // Prefer PATH-resolved binary via `which`, then fall back to known paths.
  for (const c of candidates) {
    if (c !== 'cloudflared' && existsSync(c)) return c;
  }
  return null; // PATH lookup handled at spawn time.
}

function resolveOutputDir(): string {
  const root = process.env.PROJECT_ROOT || path.resolve(process.cwd());
  const candidates = [
    process.env.SM_WEB_OUT,
    path.join(root, 'apps/web/out'),
    path.join(root, 'out'),
    path.join(os.homedir(), '.smokemonkey/web/out'),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[1] || '';
}

interface RunningTunnel {
  proc: ChildProcessWithoutNullStreams;
  url: string | null;
  hostname: string | null;
  startedAt: number;
  error: string | null;
}

@Injectable()
export class ShareService implements OnModuleDestroy {
  private readonly logger = new Logger(ShareService.name);

  private quickTunnel: RunningTunnel | null = null;
  private persistentTunnel: RunningTunnel | null = null;
  private cloudflaredVersion: string | null = null;
  private wranglerAvailable = false;

  constructor(
    @InjectRepository(ShareConfig)
    private readonly repo: Repository<ShareConfig>,
  ) {
    void this.detectBinaries();
  }

  // ── Toolchain detection ────────────────────────────────────────────────

  private async detectBinaries(): Promise<void> {
    this.cloudflaredVersion = await this.runVersionCheck('cloudflared', '--version').catch((): string | null => null);
    // wrangler runs via npx; resolve once on startup (npx may fetch on first run).
    this.wranglerAvailable = !!(await this.runVersionCheck('npx', 'wrangler', '--version')
      .catch((): string | null => null));
  }

  private runVersionCheck(bin: string, ...args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!['cloudflared', 'wrangler', 'npx'].includes(bin)) return reject(new Error('not found'));
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => (out += String(d)));
      child.stderr.on('data', (d) => (out += String(d)));
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve(out.trim()) : resolve(out.trim() || null),
      );
      setTimeout(() => {
        child.kill();
        reject(new Error('timeout'));
      }, 5000);
    });
  }

  private findBinary(bin: string): string | null {
    if (bin === 'cloudflared') return resolveCloudflared();
    return null; // wrangler runs via npx
  }

  // ── Config CRUD ───────────────────────────────────────────────────────

  async getConfig(userId: string): Promise<ShareConfig> {
    let cfg = await this.repo.findOne({ where: { userId } });
    if (!cfg) {
      cfg = this.repo.create({ userId, outputDir: resolveOutputDir() });
      cfg = await this.repo.save(cfg);
    }
    return cfg;
  }

  async updateConfig(userId: string, dto: {
    projectName?: string;
    accountId?: string;
    apiToken?: string;
    tunnelHostname?: string;
    tunnelId?: string;
    outputDir?: string;
    pagesProjectName?: string;
  }): Promise<ShareConfig> {
    let cfg = await this.getConfig(userId);
    if (dto.projectName !== undefined) cfg.projectName = dto.projectName;
    if (dto.accountId !== undefined) cfg.accountId = dto.accountId || null;
    if (dto.apiToken) cfg.apiTokenEnc = this.encrypt(dto.apiToken);
    if (dto.tunnelHostname !== undefined) cfg.tunnelHostname = dto.tunnelHostname || null;
    if (dto.tunnelId !== undefined) cfg.tunnelId = dto.tunnelId || null;
    if (dto.outputDir !== undefined) cfg.outputDir = dto.outputDir || resolveOutputDir();
    if (dto.pagesProjectName !== undefined) cfg.pagesProjectName = dto.pagesProjectName || null;
    return this.repo.save(cfg);
  }

  // ── Status ────────────────────────────────────────────────────────────

  async status(userId: string): Promise<ShareStatus> {
    const cfg = await this.getConfig(userId);
    return {
      quickTunnel: this.tunnelToStatus(this.quickTunnel),
      persistentTunnel: this.tunnelToStatus(this.persistentTunnel),
      cloudflaredAvailable: this.cloudflaredAvailable(),
      cloudflaredVersion: this.cloudflaredVersion,
      wranglerAvailable: this.wranglerAvailable,
      wranglerLoggedIn: this.wranglerLoggedIn(),
      config: {
        projectName: cfg.projectName,
        accountId: cfg.accountId,
        tunnelHostname: cfg.tunnelHostname,
        pagesProjectName: cfg.pagesProjectName,
        outputDir: cfg.outputDir,
      },
    };
  }

  private tunnelToStatus(t: RunningTunnel | null): TunnelStatus {
    if (!t) {
      return { running: false, url: null, startedAt: null, hostname: null, error: null };
    }
    return {
      running: true,
      url: t.url,
      startedAt: t.startedAt ? new Date(t.startedAt).toISOString() : null,
      hostname: t.hostname,
      error: t.error,
    };
  }

  private cloudflaredAvailable(): boolean {
    const resolved = this.findBinary('cloudflared');
    if (resolved) return true;
    // PATH resolution fallback
    const { env } = process;
    const hasPath = /cloudflared/.test(env.PATH || '');
    return hasPath || this.cloudflaredVersion !== null;
  }

  // ── Quick Tunnel (local hosting → public link) ────────────────────────

  async startQuickTunnel(userId: string, opts?: QuickTunnelOptions): Promise<TunnelStatus> {
    if (this.quickTunnel) {
      // Already running — return its status.
      return this.tunnelToStatus(this.quickTunnel);
    }
    const url = this.normalizeOrigin(opts?.url);
    const proc = spawn('cloudflared', [
      'tunnel',
      '--url',
      url,
      '--no-autoupdate',
      '--accept-quic',
      '--no-chmod',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const tunnel: RunningTunnel = {
      proc,
      url: null,
      hostname: null,
      startedAt: Date.now(),
      error: null,
    };
    this.quickTunnel = tunnel;

    proc.stdout.setEncoding('utf-8');
    proc.stderr.setEncoding('utf-8');
    const onData = (chunk: string) => {
      const m = chunk.match(TUNNEL_URL_RE);
      if (m?.[1] && !tunnel.url) {
        tunnel.url = m[1];
        const u = new URL(m[1]);
        tunnel.hostname = u.hostname;
        this.logger.log(`[share] quick tunnel ready: ${m[1]}`);
      }
      this.logger.debug(`[cloudflared] ${chunk.trim().slice(0, 300)}`);
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('close', (code) => {
      this.logger.log(`[share] quick tunnel exited code=${code}`);
      if (this.quickTunnel === tunnel) this.quickTunnel = null;
    });
    proc.on('error', (err) => {
      tunnel.error = err.message;
      this.logger.warn(`[share] quick tunnel spawn error: ${err.message}`);
    });

    // Wait up to ~20s for the trycloudflare URL to appear.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !tunnel.url && !tunnel.error) {
      await new Promise((r) => setTimeout(r, 250));
      if (proc.exitCode !== null) break;
    }
    if (!tunnel.url) {
      const msg = tunnel.error || 'Tunnel started but no public URL received (is cloudflared installed?)';
      tunnel.error = msg;
      return this.tunnelToStatus(tunnel);
    }
    return this.tunnelToStatus(tunnel);
  }

  async stopQuickTunnel(): Promise<TunnelStatus> {
    const t = this.quickTunnel;
    if (!t) return { running: false, url: null, startedAt: null, hostname: null, error: null };
    try { t.proc.kill(); } catch {}
    this.quickTunnel = null;
    return { running: false, url: null, startedAt: null, hostname: null, error: null };
  }

  // ── Persistent (named) tunnel ─────────────────────────────────────────

  async startPersistentTunnel(userId: string): Promise<TunnelStatus> {
    if (this.persistentTunnel) return this.tunnelToStatus(this.persistentTunnel);
    const cfg = await this.getConfig(userId);
    if (!cfg.tunnelHostname) {
      throw new Error('No tunnel hostname configured — set one in settings to use a persistent tunnel.');
    }
    const url = this.normalizeOrigin();
    const proc = spawn('cloudflared', [
      'tunnel',
      '--url',
      url,
      '--hostname',
      cfg.tunnelHostname,
      '--no-autoupdate',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const tunnel: RunningTunnel = {
      proc,
      url: `https://${cfg.tunnelHostname}`,
      hostname: cfg.tunnelHostname,
      startedAt: Date.now(),
      error: null,
    };
    this.persistentTunnel = tunnel;
    proc.stderr.setEncoding('utf-8');
    proc.stderr.on('data', (d) => this.logger.debug(`[cloudflared persistent] ${String(d).trim().slice(0, 300)}`));
    proc.stdout.on('data', (d) => this.logger.debug(`[cloudflared persistent] ${String(d).trim().slice(0, 300)}`));
    proc.on('close', (code) => {
      this.logger.log(`[share] persistent tunnel exited code=${code}`);
      if (this.persistentTunnel === tunnel) this.persistentTunnel = null;
    });
    proc.on('error', (err) => {
      tunnel.error = err.message;
      this.logger.warn(`[share] persistent tunnel error: ${err.message}`);
    });
    await new Promise((r) => setTimeout(r, 1500));
    // Don't hard-fail on spawn error; DNS propagation may take a moment.
    return this.tunnelToStatus(tunnel);
  }

  async stopPersistentTunnel(): Promise<TunnelStatus> {
    const t = this.persistentTunnel;
    if (!t) return { running: false, url: null, startedAt: null, hostname: null, error: null };
    try { t.proc.kill(); } catch {}
    this.persistentTunnel = null;
    return { running: false, url: null, startedAt: null, hostname: null, error: null };
  }

  // ── Deploy to Cloudflare Pages/Workers ────────────────────────────────

  /**
   * Deploy the built static web output to Cloudflare Pages via wrangler
   * (npx wrangler pages deploy <out> --project-name <name> [--account-id <id>]).
   * Returns the preview/production URL when wrangler prints it.
   */
  async deployPages(userId: string, projectName?: string): Promise<{
    ok: boolean;
    url?: string;
    output?: string;
    error?: string;
  }> {
    const cfg = await this.getConfig(userId);
    const name = projectName || cfg.pagesProjectName || cfg.projectName || 'smoke-monkey';
    const outDir = this.resolveOutDir(cfg);
    if (!outDir) {
      return {
        ok: false,
        error: 'No static build found. Build first with: BUILD_FOR_DESKTOP=1 pnpm --filter web build',
      };
    }
    const hasToken = !!cfg.apiTokenEnc;
    const loggedIn = this.wranglerLoggedIn();
    if (!hasToken && !loggedIn) {
      return {
        ok: false,
        error: 'Missing Cloudflare authorization. Log in with Wrangler (opens a browser to dash.cloudflare.com/oauth2) or provide a CLOUDFLARE_API_TOKEN.',
      };
    }
    return new Promise((resolve) => {
      const args = ['wrangler', 'pages', 'deploy', outDir, '--project-name', name];
      if (cfg.accountId) args.push('--account-id', cfg.accountId);
      const env: NodeJS.ProcessEnv = { ...process.env };
      // Prefer the explicit API token if supplied; otherwise wrangler falls
      // back to the stored `wrangler login` OAuth credential automatically.
      if (cfg.apiTokenEnc) env.CLOUDFLARE_API_TOKEN = this.decrypt(cfg.apiTokenEnc) || undefined;
      // Ensure wrangler runs via npx from the project.
      const child = spawn('npx', args, { stdio: ['ignore', 'pipe', 'pipe'], env });
      let output = '';
      child.stdout.on('data', (d) => (output += String(d)));
      child.stderr.on('data', (d) => (output += String(d)));
      child.on('close', (code) => {
        const deployedUrl = this.findPagesUrl(output);
        if (code === 0 && deployedUrl) {
          resolve({ ok: true, url: deployedUrl, output });
        } else if (code === 0) {
          resolve({ ok: true, output });
        } else {
          resolve({ ok: false, error: output.trim().split('\n').slice(-8).join('\n') || `wrangler exited ${code}`, output });
        }
      });
      child.on('error', (err) => resolve({ ok: false, error: err.message, output }));
    });
  }

  // ── Wrangler OAuth login ─────────────────────────────────────────────

  /**
   * Whether this machine has an active Wrangler login. Wrangler persists a
   * OAuth/API-token credential in ~/.wrangler/config — read directly (fast, no
   * network) instead of shelling out to `wrangler whoami`.
   */
  wranglerLoggedIn(): boolean {
    const dir = path.join(os.homedir(), '.wrangler', 'config');
    const files = [
      path.join(dir, 'default.toml'),
      path.join(dir, 'config.json'),
      path.join(dir, 'default-tokens.json'),
      path.join(dir, 'refresh-token.json'),
    ];
    for (const f of files) {
      try {
        if (!existsSync(f)) continue;
        const content = readFileSync(f, 'utf8');
        if (/oauth_token|refresh_token|api_token/.test(content)) {
          // Ignore files whose every secret is empty.
          if (/=\s*""|:"\s*"/.test(content)) {
            const remaining = content.replace(/=\s*""/g, '').replace(/:\s*""/g, '');
            if (!/oauth_token|refresh_token|api_token/.test(remaining)) continue;
          }
          return true;
        }
      } catch { continue; }
    }
    return false;
  }

  /**
   * Run `wrangler login` to grant OAuth authorization through the browser.
   * Returns once wrangler exits (the flow blocks until the user approves).
   */
  wranglerLogin(): Promise<{ ok: boolean; output?: string; error?: string }> {
    return new Promise((resolve) => {
      const child = spawn('npx', ['wrangler', 'login'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (d) => (output += String(d)));
      child.stderr.on('data', (d) => (output += String(d)));
      child.on('error', (err) => resolve({ ok: false, error: err.message, output }));
      child.on('close', (code) => {
        if (code === 0) {
          resolve({ ok: true, output });
        } else {
          resolve({ ok: false, error: output.trim().split('\n').slice(-5).join('\n') || `wrangler login exited ${code}`, output });
        }
      });
    });
  }

  /** Run `wrangler logout` to revoke the OAuth grant on this machine. */
  wranglerLogout(): Promise<{ ok: boolean; output?: string; error?: string }> {
    return new Promise((resolve) => {
      const child = spawn('npx', ['wrangler', 'logout'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (d) => (output += String(d)));
      child.stderr.on('data', (d) => (output += String(d)));
      child.on('error', (err) => resolve({ ok: false, error: err.message, output }));
      child.on('close', (code) => resolve({ ok: code === 0, output }));
    });
  }

  private resolveOutDir(cfg: ShareConfig): string | null {
    if (cfg.outputDir && existsSync(cfg.outputDir)) return cfg.outputDir;
    const resolved = resolveOutputDir();
    return resolved ? resolved : null;
  }

  private findPagesUrl(output: string): string | null {
    const m = output.match(/(https:\/\/[a-z0-9-]+\.pages\.dev\/?[^\s]*)/i);
    return m?.[1] ?? null;
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private normalizeOrigin(url?: string): string {
    if (url) return url.replace(/\/+$/, '');
    const apiPort = process.env.PORT || process.env.API_PORT || '8642';
    return `http://127.0.0.1:${apiPort}`;
  }

  private encrypt(plain: string): string {
    const { SM_ENCRYPTION_KEY } = process.env;
    const key = SM_ENCRYPTION_KEY || 'sm-share-dev-key-not-secret';
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(key).digest(), iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
  }

  private decrypt(payload: string): string | null {
    try {
      const [ivB64, tagB64, dataB64] = payload.split(':');
      const { SM_ENCRYPTION_KEY } = process.env;
      const key = SM_ENCRYPTION_KEY || 'sm-share-dev-key-not-secret';
      const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(key).digest(), Buffer.from(ivB64, 'base64'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  /** Close all child processes on app shutdown. */
  onModuleDestroy(): void {
    void this.shutdown();
  }

  async shutdown(): Promise<void> {
    if (this.quickTunnel) { try { this.quickTunnel.proc.kill(); } catch {} this.quickTunnel = null; }
    if (this.persistentTunnel) { try { this.persistentTunnel.proc.kill(); } catch {} this.persistentTunnel = null; }
  }
}