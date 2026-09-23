import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import {
  isOmniRouteFreeModel,
  omnirouteModelFamily,
  omnirouteNamespace,
  omnirouteProtocol,
  OmniRouteProtocol,
} from './omniroute-models.lib';

const PROBE_TIMEOUT_MS = 20_000;
const IMAGE_PROBE_TIMEOUT_MS = 45_000;
const DEFAULT_CYCLE_MS = 30 * 60_000;
const DEFAULT_IMAGE_REVALIDATE_MS = 24 * 60 * 60_000;
const DEFAULT_CONCURRENCY = 16;

export interface OmniRouteImageHealth {
  capable: boolean;
  available: boolean;
  latencyMs: number | null;
  checkedAt: number | null;
  lastError: string | null;
}

export interface OmniRouteModelEntry {
  id: string;
  name: string;
  provider: string;
  family: string;
  protocol: OmniRouteProtocol;
  isFree: boolean;
  isAvailable: boolean;
  latencyMs: number | null;
  keyRequired: boolean;
  checkedAt: number | null;
  lastError: string | null;
  imageGeneration?: OmniRouteImageHealth;
}

export interface OmniRouteCatalogItem {
  id: string;
  name?: string;
}

@Injectable()
export class OmniRouteModelHealthService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OmniRouteModelHealthService.name);
  private readonly entries = new Map<string, OmniRouteModelEntry>();
  private readonly cycleMs = Number(process.env.OMNIROUTE_HEALTH_INTERVAL_MS) || DEFAULT_CYCLE_MS;
  private readonly imageRevalidateMs =
    Number(process.env.OMNIROUTE_IMAGE_REVALIDATE_MS) || DEFAULT_IMAGE_REVALIDATE_MS;
  private readonly concurrency =
    Number(process.env.OMNIROUTE_PROBE_CONCURRENCY) || DEFAULT_CONCURRENCY;

  private readonly cachePath = path.join(process.cwd(), '.smoke', 'omniroute-model-health.json');

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private gatewayReachable = false;
  private updatedAt: number | null = null;

  async onApplicationBootstrap(): Promise<void> {
    this.loadCache();
    void this.runCycle();
    this.timer = setInterval(() => void this.runCycle(), this.cycleMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Lazy reads of env so the persisted key is picked up even after ConfigModule/OnApplicationBootstrap sets it. */
  private get base(): string {
    return (process.env.OMNIROUTE_BASE_URL || 'http://localhost:20128/v1').replace(/\/+$/, '');
  }
  private get key(): string {
    return process.env.OMNIROUTE_API_KEY || 'omniroute';
  }

  private async runCycle(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const catalog = await this.fetchCatalog();
      if (catalog.length === 0) {
        this.gatewayReachable = false;
        this.logger.warn('[OmniRouteHealth] gateway unreachable — keeping last ranking');
        await this.persist();
        return;
      }
      this.gatewayReachable = true;

      const ids = catalog.map((m) => m.id);
      for (const item of catalog) this.ensureEntry(item);
      const known = new Set(ids);
      for (const id of [...this.entries.keys()]) if (!known.has(id)) this.entries.delete(id);

      const chatIds = ids.filter((id) => omnirouteProtocol(id) === 'chat');
      const imageIds = ids.filter((id) => omnirouteProtocol(id) !== 'chat');
      const dueImageIds = imageIds.filter((id) => this.imageProbeDue(this.entries.get(id)));

      this.logger.log(
        `[OmniRouteHealth] probing ${chatIds.length} chat + ${dueImageIds.length} image models`,
      );

      await mapLimit(chatIds, this.concurrency, async (id) => {
        const entry = this.entries.get(id);
        if (entry) await this.probeChat(entry);
      });

      await mapLimit(dueImageIds, this.concurrency, async (id) => {
        const entry = this.entries.get(id);
        if (entry) await this.probeImage(entry);
      });

      this.updatedAt = Date.now();
      await this.persist();
      const available = [...this.entries.values()].filter((e) => e.isAvailable).length;
      this.logger.log(`[OmniRouteHealth] revalidated ${ids.length} models (${available} available)`);
    } catch (err) {
      this.logger.error(
        `[OmniRouteHealth] cycle failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.running = false;
    }
  }

  private imageProbeDue(entry?: OmniRouteModelEntry): boolean {
    if (!entry) return true;
    const im = entry.imageGeneration;
    if (!im) return true;
    if (!im.available) return true;
    if (!im.checkedAt) return true;
    return Date.now() - im.checkedAt >= this.imageRevalidateMs;
  }

  private async fetchCatalog(): Promise<OmniRouteCatalogItem[]> {
    try {
      const res = await fetch(`${this.base}/models`, {
        signal: AbortSignal.timeout(10_000),
        headers: { accept: 'application/json', authorization: `Bearer ${this.key}` },
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: OmniRouteCatalogItem[] };
      if (!Array.isArray(data.data)) return [];
      return data.data.map((m) => ({ id: String(m.id ?? ''), name: m.name })).filter((m) => m.id);
    } catch {
      return [];
    }
  }

  private ensureEntry(item: OmniRouteCatalogItem): void {
    const existing = this.entries.get(item.id);
    if (!existing) {
      this.entries.set(item.id, {
        id: item.id,
        name: item.name || item.id,
        provider: omnirouteNamespace(item.id),
        family: omnirouteModelFamily(item.id),
        protocol: omnirouteProtocol(item.id),
        isFree: isOmniRouteFreeModel(item.id),
        isAvailable: false,
        latencyMs: null,
        keyRequired: false,
        checkedAt: null,
        lastError: null,
      });
      return;
    }
    existing.name = item.name || existing.name;
    existing.provider = omnirouteNamespace(item.id);
    existing.family = omnirouteModelFamily(item.id);
    existing.protocol = omnirouteProtocol(item.id);
    existing.isFree = isOmniRouteFreeModel(item.id);
  }private async probeChat(entry: OmniRouteModelEntry): Promise<void> {
    const startedAt = Date.now();
    const body = JSON.stringify({
      model: entry.id,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8,
      stream: false,
    });

    let res: Response;
    try {
      res = await fetch(`${this.base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
    } catch {
      entry.isAvailable = false;
      entry.latencyMs = Date.now() - startedAt;
      entry.checkedAt = Date.now();
      entry.lastError = 'timeout';
      return;
    }

    // Keyless attempt rejected → the model needs the manage key on this gateway.
    if (res.status === 401 || res.status === 403) {
      try {
        const keyed = await fetch(`${this.base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}` },
          body,
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (keyed.ok && (await this.isChatResponseOk(keyed))) {
          entry.isAvailable = true;
          entry.latencyMs = Date.now() - startedAt;
          entry.checkedAt = Date.now();
          entry.lastError = null;
          entry.keyRequired = true;
          return;
        }
      } catch {
        /* fall through to failure */
      }
      entry.isAvailable = false;
      entry.latencyMs = Date.now() - startedAt;
      entry.checkedAt = Date.now();
      entry.lastError = `HTTP ${res.status}`;
      entry.keyRequired = true;
      return;
    }

    if (!res.ok) {
      entry.isAvailable = false;
      entry.latencyMs = Date.now() - startedAt;
      entry.checkedAt = Date.now();
      entry.lastError = `HTTP ${res.status}`;
      return;
    }

    const ok = await this.isChatResponseOk(res);
    entry.isAvailable = ok;
    entry.latencyMs = Date.now() - startedAt;
    entry.checkedAt = Date.now();
    entry.lastError = ok ? null : 'empty response';
  }

  private async isChatResponseOk(res: Response): Promise<boolean> {
    try {
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: unknown;
      };
      const content = data.choices?.[0]?.message?.content;
      return Array.isArray(data.choices) && data.choices.length > 0 && (content != null || !!data.usage);
    } catch {
      return false;
    }
  }

  private async probeImage(entry: OmniRouteModelEntry): Promise<void> {
    const startedAt = Date.now();
    const result: OmniRouteImageHealth = {
      capable: true,
      available: false,
      latencyMs: null,
      checkedAt: Date.now(),
      lastError: null,
    };
    const attempt = async (body: string, headers: Record<string, string>): Promise<boolean> => {
      const res = await fetch(`${this.base}/images/generations`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(IMAGE_PROBE_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        data?: Array<{ url?: unknown; b64_json?: unknown }>;
      };
      return (
        Array.isArray(data.data) &&
        data.data.length > 0 &&
        (!!data.data[0].url || !!data.data[0].b64_json)
      );
    };

    try {
      const strictBody = JSON.stringify({
        model: entry.id,
        prompt: 'a tiny red square on white',
        n: 1,
        size: '256x256',
      });
      let available = await attempt(strictBody, { 'content-type': 'application/json' });
      if (!available) {
        const retryBody = JSON.stringify({ model: entry.id, prompt: 'a tiny red square on white' });
        available = await attempt(retryBody, { 'content-type': 'application/json' });
      }
      result.available = available;
      result.latencyMs = Date.now() - startedAt;
      result.lastError = available ? null : 'no image returned';
    } catch (err) {
      result.available = false;
      result.latencyMs = Date.now() - startedAt;
      result.lastError = err instanceof Error ? err.message : String(err);
    }
    entry.imageGeneration = result;
  }/** Ranked snapshot: running models first (available → fastest → free). */
  getRanked(): OmniRouteModelEntry[] {
    return [...this.entries.values()].sort((a, b) => {
      if (a.isAvailable !== b.isAvailable) return a.isAvailable ? -1 : 1;
      const la = a.latencyMs ?? Number.MAX_SAFE_INTEGER;
      const lb = b.latencyMs ?? Number.MAX_SAFE_INTEGER;
      if (la !== lb) return la - lb;
      if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
  }

  getModel(id: string): OmniRouteModelEntry | undefined {
    return this.entries.get(id);
  }

  getGatewayReachable(): boolean {
    return this.gatewayReachable;
  }

  getUpdatedAt(): number | null {
    return this.updatedAt;
  }

  getNextCheckAt(): number | null {
    return this.updatedAt == null ? null : this.updatedAt + this.cycleMs;
  }

  /** Ids in ranked order (available first, then fastest, then free). */
  getRankedIds(): string[] {
    return this.getRanked().map((e) => e.id);
  }

  /**
   * Middleware-style mapper: turns a stored health entry into the additive DTO
   * shape the FE model list consumes, carrying flags + insight. Used by both
   * the /api/models/omniroute controller and agent provider builder so the
   * same ranked/flagged data leaves every OmniRoute surface.
   */
  toModelDto(entry: OmniRouteModelEntry, name?: string): Record<string, unknown> {
    return {
      id: entry.id,
      name: name || entry.name || entry.id,
      provider: entry.provider,
      isFree: entry.isFree,
      family: entry.family,
      protocol: entry.protocol,
      isAvailable: entry.isAvailable,
      latencyMs: entry.latencyMs,
      keyRequired: entry.keyRequired,
      imageGeneration: entry.imageGeneration,
      checkedAt: entry.checkedAt,
      lastError: entry.lastError,
    };
  }

  private async persist(): Promise<void> {
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      fs.writeFileSync(
        this.cachePath,
        JSON.stringify(
          {
            gatewayReachable: this.gatewayReachable,
            updatedAt: this.updatedAt,
            entries: [...this.entries.values()],
          },
          null,
          2,
        ),
      );
    } catch (err) {
      this.logger.warn(`[OmniRouteHealth] cache persist failed: ${err}`);
    }
  }

  private loadCache(): void {
    try {
      if (!fs.existsSync(this.cachePath)) return;
      const data = JSON.parse(fs.readFileSync(this.cachePath, 'utf8')) as {
        gatewayReachable?: boolean;
        updatedAt?: number;
        entries?: OmniRouteModelEntry[];
      };
      if (Array.isArray(data.entries)) {
        for (const e of data.entries) {
          if (e && typeof e.id === 'string') this.entries.set(e.id, e);
        }
      }
      if (typeof data.updatedAt === 'number') this.updatedAt = data.updatedAt;
      this.gatewayReachable = Boolean(data.gatewayReachable);
    } catch (err) {
      this.logger.warn(`[OmniRouteHealth] cache load failed: ${err}`);
    }
  }
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, queue.length)) },
    async () => {
      for (;;) {
        const item = queue.shift();
        if (item === undefined) return;
        try {
          await fn(item);
        } catch {
          /* errors are captured per-item inside fn */
        }
      }
    },
  );
  await Promise.all(workers);
}