import { Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * FileReadCache — avoids re-reading unchanged files from disk.
 *
 * Before every read_file call:
 *   file stat unchanged? → return cached content
 *                changed? → re-read, update cache
 *
 * Especially useful when the agent repeatedly inspects the same files
 * across multiple steps (e.g., re-reading a config, checking types).
 *
 * Cache is per-process (in-memory), scoped to a workspace.
 * Entry limit prevents unbounded growth on large workspaces.
 */

export interface CachedFile {
  path: string;
  /** Size + mtime_ns fingerprint for fast change detection. */
  fingerprint: string;
  content: string;
  lines: number;
  hash: string;
}

interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
}

const MAX_ENTRIES = 500;
const MAX_ENTRY_SIZE = 2 * 1024 * 1024; // 2 MB per file

export class FileReadCache {
  private readonly logger = new Logger(FileReadCache.name);
  private cache = new Map<string, CachedFile>();
  private stats: CacheStats = { hits: 0, misses: 0, evictions: 0 };

  /**
   * Read a file, returning cached content if unchanged.
   * Returns null when the file doesn't exist or is unreadable.
   */
  async read(filePath: string): Promise<CachedFile | null> {
    const resolved = path.resolve(filePath);

    // Fast fingerprint check — stat is much cheaper than a full read.
    const fp = await this.fingerprint(resolved);
    if (fp === null) return null;

    const cached = this.cache.get(resolved);
    if (cached && cached.fingerprint === fp) {
      this.stats.hits++;
      return cached;
    }

    // Cache miss — read from disk.
    this.stats.misses++;
    try {
      const stat = await fs.stat(resolved);
      if (stat.size > MAX_ENTRY_SIZE) {
        // Too large to cache; read directly without caching.
        const content = await fs.readFile(resolved, 'utf-8');
        return {
          path: resolved,
          fingerprint: fp,
          content,
          lines: content.split('\n').length,
          hash: '',
        };
      }

      const content = await fs.readFile(resolved, 'utf-8');
      const entry: CachedFile = {
        path: resolved,
        fingerprint: fp,
        content,
        lines: content.split('\n').length,
        hash: this.computeHash(content),
      };

      this.evictIfNeeded();
      this.cache.set(resolved, entry);
      return entry;
    } catch {
      return null;
    }
  }

  /** Check if a file is cached and unchanged (without reading content). */
  async isCached(filePath: string): Promise<boolean> {
    const resolved = path.resolve(filePath);
    const cached = this.cache.get(resolved);
    if (!cached) return false;
    const fp = await this.fingerprint(resolved);
    return fp !== null && cached.fingerprint === fp;
  }

  /** Invalidate a specific file or the entire cache. */
  invalidate(filePath?: string): void {
    if (filePath) {
      this.cache.delete(path.resolve(filePath));
    } else {
      this.cache.clear();
    }
  }

  /** Returns cache statistics. */
  getStats(): CacheStats & { size: number } {
    return { ...this.stats, size: this.cache.size };
  }

  /** Reset stats counters. */
  resetStats(): void {
    this.stats = { hits: 0, misses: 0, evictions: 0 };
  }

  // ── Private ──────────────────────────────────────────────────────────

  private async fingerprint(resolved: string): Promise<string | null> {
    try {
      const s = await fs.stat(resolved, { bigint: true });
      return `${s.size}:${s.mtimeNs}`;
    } catch {
      return null;
    }
  }

  private computeHash(content: string): string {
    // Fast hash for cache keying — not cryptographic.
    let h = 0;
    for (let i = 0; i < content.length; i++) {
      h = ((h << 5) - h + content.charCodeAt(i)) | 0;
    }
    return h.toString(36);
  }

  private evictIfNeeded(): void {
    if (this.cache.size < MAX_ENTRIES) return;

    // Evict oldest 20% of entries.
    const toEvict = Math.ceil(MAX_ENTRIES * 0.2);
    const keys = [...this.cache.keys()];
    for (let i = 0; i < toEvict && i < keys.length; i++) {
      this.cache.delete(keys[i]);
      this.stats.evictions++;
    }
  }
}
