import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import Database from 'better-sqlite3';

/**
 * WorkspaceIndex — SQLite-backed code intelligence for the workspace.
 *
 * Architecture:
 *   Workspace → workspaceId (MD5 of canonical path) → ~/.smoke-agent/workspaces/<id>/index.db
 *
 * The index stores files, symbols, imports, exports in SQLite so queries are
 * instant database lookups instead of linear scans. Incremental re-indexing
 * means only changed files are re-parsed.
 *
 * Query examples:
 *   findSymbol("AgentService")       → [{ file: "agent.service.ts", line: 1838, kind: "class" }]
 *   findReferences("AgentService")   → [{ file: "agent.controller.ts", line: 12 }, ...]
 *   findImporters("./agent.service") → [{ file: "agent.module.ts", ... }]
 *   getDependencyGraph("AgentService") → { dependsOn: [...], dependedBy: [...] }
 */

// ── Storage layout ───────────────────────────────────────────────────────

const AGENT_HOME = path.join(os.homedir(), '.smoke-agent');
const WORKSPACES_DIR = path.join(AGENT_HOME, 'workspaces');

/** MD5 of the canonical (realpath) workspace root → unique workspace ID. */
function workspaceIdFromPath(rootPath: string): string {
  return crypto.createHash('md5').update(rootPath).digest('hex').slice(0, 12);
}

// ── Types ────────────────────────────────────────────────────────────────

export interface FileEntry {
  path: string;
  language: string;
  hash: string;
  size: number;
  lastModified: number;
  symbols: SymbolInfo[];
  imports: string[];
  exports: string[];
  lines: number;
}

export interface SymbolInfo {
  name: string;
  kind: 'class' | 'function' | 'interface' | 'type' | 'enum' | 'const' | 'variable' | 'method';
  line: number;
  endLine?: number;
}

export interface SymbolResult {
  name: string;
  kind: SymbolInfo['kind'];
  file: string;
  line: number;
  endLine?: number;
}

export interface ReferenceResult {
  file: string;
  line: number;
  kind: 'import' | 'export' | 'symbol';
}

export interface DependencyNode {
  file: string;
  imports: string[];
  exportedBy: string[];
  importedBy: string[];
}

export interface IndexStats {
  files: number;
  symbols: number;
  imports: number;
  exports: number;
  lastBuilt: number;
  workspaceId: string;
  dbPath: string;
}

// ── Language detection ───────────────────────────────────────────────────

const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript React',
  '.js': 'JavaScript', '.jsx': 'JavaScript React',
  '.py': 'Python', '.pyw': 'Python',
  '.rs': 'Rust', '.go': 'Go', '.java': 'Java',
  '.rb': 'Ruby', '.php': 'PHP',
  '.c': 'C', '.h': 'C Header', '.cpp': 'C++', '.hpp': 'C++ Header',
  '.cs': 'C#', '.swift': 'Swift', '.kt': 'Kotlin',
  '.sh': 'Shell', '.bash': 'Shell',
  '.css': 'CSS', '.scss': 'SCSS', '.less': 'LESS',
  '.html': 'HTML', '.htm': 'HTML',
  '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML',
  '.toml': 'TOML', '.xml': 'XML',
  '.md': 'Markdown', '.mdx': 'MDX',
  '.sql': 'SQL', '.graphql': 'GraphQL',
  '.vue': 'Vue', '.svelte': 'Svelte',
};

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'target',
  '__pycache__', '.venv', 'venv', '.idea', '.vscode',
  'coverage', '.nyc_output', '.smoke',
]);

const MAX_FILE_SIZE = 512 * 1024;
const DEBOUNCE_MS = 5_000;

// ── WorkspaceIndex ───────────────────────────────────────────────────────

export class WorkspaceIndex {
  private readonly logger = new Logger(WorkspaceIndex.name);
  private db: Database.Database | null = null;
  private rootPath: string = '';
  private workspaceId: string = '';
  private built = false;
  private building = false;
  private lastBuild = 0;
  private watcher: ReturnType<typeof fs.watch> | null = null;
  private watchDebounce: NodeJS.Timeout | null = null;

  // ── Lifecycle ───────────────────────────────────────────────────────

  /**
   * Build or refresh the index for the given workspace root.
   * Uses SQLite for persistence — subsequent opens skip full re-index.
   */
  async build(rootPath: string, force = false): Promise<void> {
    if (this.building) return;
    if (!force && this.built && Date.now() - this.lastBuild < DEBOUNCE_MS) return;

    // Resolve canonical path for consistent workspace IDs.
    const canonical = await fsp.realpath(rootPath).catch(() => path.resolve(rootPath));
    this.rootPath = canonical;
    this.workspaceId = workspaceIdFromPath(canonical);

    this.building = true;
    const start = Date.now();

    try {
      this.ensureDb();
      this.createSchema();

      // Incremental: only re-index files whose hash changed.
      const existingHashes = this.getAllFileHashes();
      const scanned = await this.scanDir(canonical, canonical);
      let indexed = 0;
      let skipped = 0;

      for (const file of scanned) {
        const oldHash = existingHashes.get(file.path);
        if (oldHash === file.hash && !force) {
          skipped++;
          continue;
        }
        this.upsertFile(file);
        indexed++;
      }

      // Remove files that no longer exist on disk.
      const currentPaths = new Set(scanned.map((f) => f.path));
      for (const [relPath] of existingHashes) {
        if (!currentPaths.has(relPath)) {
          this.deleteFile(relPath);
          indexed++; // counts as a change
        }
      }

      this.built = true;
      this.lastBuild = Date.now();
      const stats = this.stats();
      this.logger.log(
        `WorkspaceIndex [${this.workspaceId}]: ${stats.files} files, ${stats.symbols} symbols, ` +
        `${indexed} updated, ${skipped} cached in ${Date.now() - start}ms`,
      );

      // Start incremental watching after build completes.
      this.startWatching();
    } catch (err) {
      this.logger.error(`WorkspaceIndex build failed: ${err}`);
    } finally {
      this.building = false;
    }
  }

  /** Close the SQLite database and stop watching. */
  destroy(): void {
    this.stopWatching();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.built = false;
  }

  // ── Query API ───────────────────────────────────────────────────────

  /** Find a symbol by name. Returns file, line, kind for all matches. */
  findSymbol(name: string): SymbolResult[] {
    this.ensureReady();
    const rows = this.db!.prepare(
      `SELECT s.name, s.kind, s.start_line as line, s.end_line as endLine, f.path as file
       FROM symbols s JOIN files f ON s.file_id = f.id
       WHERE s.name = ?`,
    ).all(name) as SymbolResult[];
    return rows;
  }

  /** Find all references to a symbol name across the codebase. */
  findReferences(name: string): ReferenceResult[] {
    this.ensureReady();
    const results: ReferenceResult[] = [];

    // 1. Symbol definitions.
    const defs = this.db!.prepare(
      `SELECT f.path as file, s.start_line as line, 'symbol' as kind
       FROM symbols s JOIN files f ON s.file_id = f.id WHERE s.name = ?`,
    ).all(name) as ReferenceResult[];
    results.push(...defs);

    // 2. Imports that reference this name.
    const imps = this.db!.prepare(
      `SELECT f.path as file, i.line, 'import' as kind
       FROM imports i JOIN files f ON i.file_id = f.id WHERE i.symbol_name = ? OR i.source LIKE ?`,
    ).all(name, `%${name}%`) as ReferenceResult[];
    results.push(...imps);

    // 3. Exports of this name.
    const exps = this.db!.prepare(
      `SELECT f.path as file, e.line, 'export' as kind
       FROM exports e JOIN files f ON e.file_id = f.id WHERE e.symbol_name = ?`,
    ).all(name) as ReferenceResult[];
    results.push(...exps);

    return results.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }

  /** Find files that import from a given module specifier. */
  findImporters(moduleSpecifier: string): Array<{ file: string; line: number; source: string }> {
    this.ensureReady();
    return this.db!.prepare(
      `SELECT f.path as file, i.line, i.source
       FROM imports i JOIN files f ON i.file_id = f.id
       WHERE i.source LIKE ?`,
    ).all(`%${moduleSpecifier}%`) as Array<{ file: string; line: number; source: string }>;
  }

  /** Find files that export a given name. */
  findExporters(name: string): Array<{ file: string; line: number }> {
    this.ensureReady();
    return this.db!.prepare(
      `SELECT f.path as file, e.line
       FROM exports e JOIN files f ON e.file_id = f.id
       WHERE e.symbol_name = ?`,
    ).all(name) as Array<{ file: string; line: number }>;
  }

  /** Get the full dependency graph for a symbol: what it imports, what imports it. */
  getDependencyGraph(symbolName: string): DependencyNode {
    this.ensureReady();

    // Find the file(s) that define this symbol.
    const defs = this.findSymbol(symbolName);
    if (defs.length === 0) {
      return { file: '', imports: [], exportedBy: [], importedBy: [] };
    }

    const primaryFile = defs[0].file;

    // What does this file import?
    const imports = this.db!.prepare(
      `SELECT i.source FROM imports i JOIN files f ON i.file_id = f.id WHERE f.path = ?`,
    ).all(primaryFile).map((r: any) => r.source);

    // What exports does this file have?
    const exportedBy = this.db!.prepare(
      `SELECT e.symbol_name FROM exports e JOIN files f ON e.file_id = f.id WHERE f.path = ?`,
    ).all(primaryFile).map((r: any) => r.symbol_name);

    // What files import from this file's module path?
    const modulePath = primaryFile.replace(/\.(ts|tsx|js|jsx)$/, '');
    const importedBy = this.findImporters(modulePath).map((r) => r.file);

    return { file: primaryFile, imports, exportedBy, importedBy };
  }

  /** Get file entry by workspace-relative path. */
  getFile(filePath: string): FileEntry | undefined {
    this.ensureReady();
    const row = this.db!.prepare(
      `SELECT path, language, hash, size, last_modified as lastModified, line_count as lines
       FROM files WHERE path = ?`,
    ).get(filePath) as any;
    if (!row) return undefined;

    const symbols = this.db!.prepare(
      `SELECT name, kind, start_line as line, end_line as endLine FROM symbols WHERE file_id = ?`,
    ).all(row.path) as SymbolInfo[];

    const imports = this.db!.prepare(
      `SELECT source FROM imports WHERE file_id = ?`,
    ).all(row.path).map((r: any) => r.source);

    const exports = this.db!.prepare(
      `SELECT symbol_name FROM exports WHERE file_id = ?`,
    ).all(row.path).map((r: any) => r.symbol_name);

    return { ...row, symbols, imports, exports };
  }

  /** Get the language for a file. */
  getLanguage(filePath: string): string {
    this.ensureReady();
    const row = this.db!.prepare(
      `SELECT language FROM files WHERE path = ?`,
    ).get(filePath) as any;
    return row?.language ?? EXT_TO_LANG[path.extname(filePath).toLowerCase()] ?? 'Unknown';
  }

  /** Get content hash for cache validation. */
  getHash(filePath: string): string | undefined {
    this.ensureReady();
    const row = this.db!.prepare(
      `SELECT hash FROM files WHERE path = ?`,
    ).get(filePath) as any;
    return row?.hash;
  }

  /** List all files matching a language. */
  filesByLanguage(lang: string): string[] {
    this.ensureReady();
    return (this.db!.prepare(
      `SELECT path FROM files WHERE language = ?`,
    ).all(lang) as any[]).map((r) => r.path);
  }

  /** List all symbols matching a kind (class, function, etc.). */
  symbolsByKind(kind: SymbolInfo['kind']): SymbolResult[] {
    this.ensureReady();
    return this.db!.prepare(
      `SELECT s.name, s.kind, s.start_line as line, s.end_line as endLine, f.path as file
       FROM symbols s JOIN files f ON s.file_id = f.id
       WHERE s.kind = ?
       ORDER BY f.path, s.start_line`,
    ).all(kind) as SymbolResult[];
  }

  /** Get index statistics. */
  stats(): IndexStats {
    if (!this.db) {
      return { files: 0, symbols: 0, imports: 0, exports: 0, lastBuilt: 0, workspaceId: this.workspaceId, dbPath: '' };
    }
    const files = (this.db.prepare('SELECT COUNT(*) as c FROM files').get() as any).c;
    const symbols = (this.db.prepare('SELECT COUNT(*) as c FROM symbols').get() as any).c;
    const imports = (this.db.prepare('SELECT COUNT(*) as c FROM imports').get() as any).c;
    const exports = (this.db.prepare('SELECT COUNT(*) as c FROM exports').get() as any).c;
    return {
      files, symbols, imports, exports,
      lastBuilt: this.lastBuild,
      workspaceId: this.workspaceId,
      dbPath: this.db.name,
    };
  }

  /** Check if the index needs a refresh. */
  isStale(): boolean {
    if (!this.built) return true;
    if (!this.db) return true;
    const row = this.db.prepare('SELECT MAX(last_modified) as maxMtime FROM files').get() as any;
    return (row?.maxMtime ?? 0) > this.lastBuild;
  }

  // ── File watching ───────────────────────────────────────────────────

  /** Start watching the workspace for changes. Only re-indexes changed files. */
  startWatching(): void {
    if (this.watcher || !this.rootPath) return;

    try {
      const w = fs.watch(this.rootPath, { recursive: true }, (event, filename) => {
        if (!filename || IGNORE_DIRS.has(filename.split(path.sep)[0])) return;
        if (typeof filename !== 'string') return;

        // Debounce rapid-fire events.
        if (this.watchDebounce) clearTimeout(this.watchDebounce);
        this.watchDebounce = setTimeout(() => this.reindexFile(filename), 500);
      });
      w.on('error', () => { /* ignore */ });
      this.watcher = w;
      this.logger.log(`WorkspaceIndex watching ${this.rootPath}`);
    } catch {
      // fs.watch may fail on some platforms/networks — degrade gracefully.
    }
  }

  /** Stop watching. */
  stopWatching(): void {
    if (this.watchDebounce) clearTimeout(this.watchDebounce);
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  // ── SQLite schema ───────────────────────────────────────────────────

  private getDbPath(): string {
    return path.join(WORKSPACES_DIR, this.workspaceId, 'index.db');
  }

  private ensureDb(): void {
    if (this.db) return;
    const dbPath = this.getDbPath();
    fsp.mkdir(path.dirname(dbPath), { recursive: true }).catch(() => {});
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
  }

  private createSchema(): void {
    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE NOT NULL,
        language TEXT NOT NULL DEFAULT 'Unknown',
        hash TEXT NOT NULL DEFAULT '',
        size INTEGER NOT NULL DEFAULT 0,
        last_modified INTEGER NOT NULL DEFAULT 0,
        line_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER
      );

      CREATE TABLE IF NOT EXISTS imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        symbol_name TEXT NOT NULL DEFAULT '',
        line INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS exports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        symbol_name TEXT NOT NULL,
        line INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_imports_source ON imports(source);
      CREATE INDEX IF NOT EXISTS idx_imports_symbol ON imports(symbol_name);
      CREATE INDEX IF NOT EXISTS idx_exports_name ON exports(symbol_name);
      CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
    `);
  }

  // ── Database operations ─────────────────────────────────────────────

  private getAllFileHashes(): Map<string, string> {
    const rows = this.db!.prepare('SELECT path, hash FROM files').all() as any[];
    return new Map(rows.map((r) => [r.path, r.hash]));
  }

  private upsertFile(file: FileEntry): void {
    const db = this.db!;

    // Delete old entries for this file.
    const existing = db.prepare('SELECT id FROM files WHERE path = ?').get(file.path) as any;
    if (existing) {
      db.prepare('DELETE FROM symbols WHERE file_id = ?').run(existing.id);
      db.prepare('DELETE FROM imports WHERE file_id = ?').run(existing.id);
      db.prepare('DELETE FROM exports WHERE file_id = ?').run(existing.id);
      db.prepare('DELETE FROM files WHERE id = ?').run(existing.id);
    }

    // Insert file.
    const result = db.prepare(
      `INSERT INTO files (path, language, hash, size, last_modified, line_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(file.path, file.language, file.hash, file.size, file.lastModified, file.lines);
    const fileId = result.lastInsertRowid;

    // Insert symbols.
    const insertSym = db.prepare(
      'INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, ?, ?)',
    );
    for (const sym of file.symbols) {
      insertSym.run(fileId, sym.name, sym.kind, sym.line, sym.endLine ?? null);
    }

    // Insert imports.
    const insertImp = db.prepare(
      'INSERT INTO imports (file_id, source, symbol_name, line) VALUES (?, ?, ?, ?)',
    );
    for (const source of file.imports) {
      const symbolName = this.inferImportSymbol(source);
      insertImp.run(fileId, source, symbolName, 0);
    }

    // Insert exports.
    const insertExp = db.prepare(
      'INSERT INTO exports (file_id, symbol_name, line) VALUES (?, ?, ?)',
    );
    for (const sym of file.exports) {
      insertExp.run(fileId, sym, 0);
    }
  }

  private deleteFile(relPath: string): void {
    const row = this.db!.prepare('SELECT id FROM files WHERE path = ?').get(relPath) as any;
    if (row) {
      this.db!.prepare('DELETE FROM symbols WHERE file_id = ?').run(row.id);
      this.db!.prepare('DELETE FROM imports WHERE file_id = ?').run(row.id);
      this.db!.prepare('DELETE FROM exports WHERE file_id = ?').run(row.id);
      this.db!.prepare('DELETE FROM files WHERE id = ?').run(row.id);
    }
  }

  private async reindexFile(relativePath: string): Promise<void> {
    if (!this.built || !this.rootPath) return;
    const fullPath = path.join(this.rootPath, relativePath);

    try {
      const stat = await fsp.stat(fullPath);
      if (stat.size > MAX_FILE_SIZE || !stat.isFile()) return;

      const ext = path.extname(fullPath).toLowerCase();
      const language = EXT_TO_LANG[ext] ?? 'Unknown';
      if (language === 'Unknown') return;

      const content = await fsp.readFile(fullPath, 'utf-8');
      const hash = crypto.createHash('md5').update(content).digest('hex');
      const lines = content.split('\n');

      const entry: FileEntry = {
        path: relativePath,
        language,
        hash,
        size: stat.size,
        lastModified: stat.mtimeMs,
        symbols: this.extractSymbols(lines, language),
        imports: this.extractImports(lines, language),
        exports: this.extractExports(lines, language),
        lines: lines.length,
      };

      this.upsertFile(entry);
    } catch {
      // File may have been deleted.
      this.deleteFile(relativePath);
    }
  }

  // ── Scanning ────────────────────────────────────────────────────────

  private async scanDir(dir: string, root: string): Promise<FileEntry[]> {
    const results: FileEntry[] = [];
    let entries: import('fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return results;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      if (IGNORE_DIRS.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        results.push(...await this.scanDir(fullPath, root));
        continue;
      }

      if (!entry.isFile()) continue;

      try {
        const stat = await fsp.stat(fullPath);
        if (stat.size > MAX_FILE_SIZE) continue;

        const rel = path.relative(root, fullPath);
        const ext = path.extname(fullPath).toLowerCase();
        const language = EXT_TO_LANG[ext] ?? 'Unknown';

        const content = await fsp.readFile(fullPath, 'utf-8');
        const hash = crypto.createHash('md5').update(content).digest('hex');
        const lines = content.split('\n');

        results.push({
          path: rel,
          language,
          hash,
          size: stat.size,
          lastModified: stat.mtimeMs,
          symbols: this.extractSymbols(lines, language),
          imports: this.extractImports(lines, language),
          exports: this.extractExports(lines, language),
          lines: lines.length,
        });
      } catch {
        // Skip unreadable files.
      }
    }
    return results;
  }

  // ── Extraction ──────────────────────────────────────────────────────

  private extractSymbols(lines: string[], language: string): SymbolInfo[] {
    const symbols: SymbolInfo[] = [];
    const patterns = this.getSymbolPatterns(language);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const { re, kind } of patterns) {
        const m = re.exec(line);
        if (m) {
          symbols.push({ name: m[1], kind, line: i + 1 });
          break;
        }
      }
    }
    return symbols;
  }

  private getSymbolPatterns(language: string): Array<{ re: RegExp; kind: SymbolInfo['kind'] }> {
    switch (language) {
      case 'TypeScript':
      case 'TypeScript React':
      case 'JavaScript':
      case 'JavaScript React':
        return [
          { re: /\bclass\s+(\w+)/, kind: 'class' },
          { re: /\b(?:export\s+)?(?:async\s+)?function\s+(\w+)/, kind: 'function' },
          { re: /\binterface\s+(\w+)/, kind: 'interface' },
          { re: /\btype\s+(\w+)/, kind: 'type' },
          { re: /\benum\s+(\w+)/, kind: 'enum' },
          { re: /\b(?:export\s+)?const\s+(\w+)\s*[=:]/, kind: 'const' },
          { re: /\b(?:export\s+)?(?:let|var)\s+(\w+)/, kind: 'variable' },
        ];
      case 'Python':
        return [
          { re: /\bclass\s+(\w+)/, kind: 'class' },
          { re: /\bdef\s+(\w+)/, kind: 'function' },
          { re: /^(\w+)\s*=/, kind: 'variable' },
        ];
      case 'Rust':
        return [
          { re: /\b(?:pub\s+)?(?:struct|enum)\s+(\w+)/, kind: 'class' },
          { re: /\b(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/, kind: 'function' },
          { re: /\b(?:pub\s+)?(?:const|static)\s+(\w+)/, kind: 'const' },
          { re: /\btype\s+(\w+)/, kind: 'type' },
        ];
      case 'Go':
        return [
          { re: /\btype\s+(\w+)\s+struct/, kind: 'class' },
          { re: /\bfunc\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/, kind: 'function' },
          { re: /\b(?:const|var)\s+(\w+)/, kind: 'const' },
        ];
      default:
        return [
          { re: /\bclass\s+(\w+)/, kind: 'class' },
          { re: /\bfunction\s+(\w+)/, kind: 'function' },
          { re: /\bconst\s+(\w+)/, kind: 'const' },
        ];
    }
  }

  private extractImports(lines: string[], language: string): string[] {
    const imports: string[] = [];
    const importRe = /(?:import|from|require)\s+.*?['"]([^'"]+)['"]/g;

    for (const line of lines) {
      let m: RegExpExecArray | null;
      importRe.lastIndex = 0;
      while ((m = importRe.exec(line)) !== null) {
        imports.push(m[1]);
      }
    }
    return imports;
  }

  private extractExports(lines: string[], language: string): string[] {
    const exports: string[] = [];
    const exportRe = /export\s+(?:default\s+)?(?:class|function|interface|type|enum|const|let|var)\s+(\w+)/g;

    for (const line of lines) {
      let m: RegExpExecArray | null;
      exportRe.lastIndex = 0;
      while ((m = exportRe.exec(line)) !== null) {
        exports.push(m[1]);
      }
    }
    return exports;
  }

  /** Infer the symbol name from an import source path. */
  private inferImportSymbol(source: string): string {
    // "./agent.service" → "agent.service"
    // "@nestjs/common" → "common"
    const base = source.split('/').pop() ?? source;
    return base.replace(/\.(ts|tsx|js|jsx)$/, '');
  }

  private ensureReady(): void {
    if (!this.db) {
      throw new Error('WorkspaceIndex not initialized — call build() first');
    }
  }
}
