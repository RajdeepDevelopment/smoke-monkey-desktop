import {
  ToolDefinition,
  ToolResult,
  ToolContext,
} from './tool-registry';
import * as path from 'path';
import { execFile } from 'child_process';
import { SEARCH_EXCLUDE_DIRS } from '../workspace.service';

const MAX_GREP_MATCHES = 200;
const MAX_LINE_PREVIEW = 200;

/** Run a command as ARGV (no shell) — model-controlled strings can never inject. */
async function runCmd(
  file: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number; maxBuffer?: number },
): Promise<{ ok: boolean; status: number | null; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        encoding: 'utf-8',
        timeout: opts.timeoutMs ?? 30_000,
        maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024,
      },
      (err: any, stdout: string) => {
        // Exit code 1 from grep/rg means "no matches", not failure.
        resolve({ ok: !err || err.status === 1, status: err ? err.status ?? null : 0, stdout: stdout || '' });
      },
    );
  });
}

function truncateLine(line: string, max: number): string {
  if (line.length <= max) return line;
  return line.substring(0, max) + '...';
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Translate PCRE-ish escapes into what macOS BSD grep understands:
 * \b → \< (first occurrence) then \>, \s/\S → POSIX classes. */
function toPosixPattern(p: string): string {
  let b = 0;
  return p
    .replace(/\\b/g, () => (++b === 1 ? '\\<' : '\\>'))
    .replace(/\\s/g, '[[:space:]]')
    .replace(/\\S/g, '[^[:space:]]');
}

/** Run a content search with the available engine. Returns raw stdout lines. */
async function contentSearch(
  cwd: string,
  pattern: string,
  searchPath: string,
  opts: { include?: string; maxCount?: number; contextLines?: number; maxColumns?: number; timeoutMs?: number },
): Promise<string> {
  const include = opts.include || '';
  const maxCount = opts.maxCount ?? 5;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const rgArgs = [
    '--no-heading', '--line-number', '--color=never',
    ...(opts.contextLines ? ['-C', String(opts.contextLines)] : []),
    `--max-count=${maxCount}`, `--max-columns=${opts.maxColumns ?? 400}`,
    ...excludeFlagsRg(),
    ...(include ? ['-g', include] : []),
    '-e', pattern,
    searchPath,
  ];
  const rg = await runCmd('rg', rgArgs, { cwd, timeoutMs });
  if (rg.status === 0 || rg.status === 1) return rg.stdout; // 1 = no matches
  // rg missing (status null) or failed — BSD/GNU grep fallback below.

  const grepArgs = [
    '-rnI', '-E', '--color=never',
    ...(opts.contextLines ? ['-C', String(opts.contextLines)] : []),
    `-m${maxCount}`,
    ...excludeFlagsGrep(),
    ...(include ? [`--include=${include}`] : []),
    '-e', toPosixPattern(pattern),
    searchPath,
  ];
  const res = await runCmd('grep', grepArgs, { cwd, timeoutMs });
  return res.stdout;
}

/** Expand a single-level brace group: "*.{ts,tsx}" → ["*.ts", "*.tsx"]. */
function expandBraces(pattern: string): string[] {
  const m = pattern.match(/\{([^{}]+)\}/);
  if (!m) return [pattern];
  const alternatives = m[1].split(',');
  const results: string[] = [];
  for (const alt of alternatives.map((a) => a.trim())) {
    for (const rest of expandBraces(pattern.substring(0, m.index) + alt + pattern.substring(m.index! + m[0].length))) {
      results.push(rest);
    }
  }
  return results;
}

/** rg/grep exclude flags so agent searches skip dependency/build noise. */
function excludeFlagsRg(): string[] {
  return SEARCH_EXCLUDE_DIRS.flatMap((d) => ['-g', `!${d}/**`]);
}
function excludeFlagsGrep(): string[] {
  return SEARCH_EXCLUDE_DIRS.flatMap((d) => [`--exclude-dir=${d}`]);
}

export function getGlobTool(): ToolDefinition {
  return {
    name: 'glob',
    description:
      'Find files by glob pattern within the workspace. Returns sorted relative file paths. ' +
      'Use a relative path to narrow the search and limit to bound the result count. ' +
      'Brace expansion is supported. Examples: "**/*.ts", "src/**/*.tsx", "*.{config.js,json}", "docker-compose*"',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern to match files against (e.g., "**/*.ts", "src/**/*.tsx").',
        },
        path: {
          type: 'string',
          description: 'Relative directory to search within. Defaults to workspace root.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return. Default: 200.',
          minimum: 1,
        },
      },
      required: ['pattern'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
    },
    execute: async (
      input: Record<string, unknown>,
      context: ToolContext
    ): Promise<ToolResult> => {
      const pattern = String(input.pattern || '');
      const searchPath = String(input.path || '.');
      const limit = Math.min(500, Math.max(1, Number(input.limit) || MAX_GREP_MATCHES));

      if (!pattern) {
        return { content: [{ type: 'text', text: 'Error: pattern is required.' }], isError: true };
      }

      try {
        let findDir = '.';
        let namePatterns: string[] = [pattern];

        if (pattern.includes('**')) {
          const doubleStarIdx = pattern.indexOf('**');
          const prefix = pattern.substring(0, doubleStarIdx).replace(/\/+$/, '');
          const suffix = pattern.substring(doubleStarIdx + 2).replace(/^\/+/, '');
          findDir = prefix || '.';
          namePatterns = expandBraces(suffix || '*');
        } else {
          const lastSlash = pattern.lastIndexOf('/');
          if (lastSlash !== -1) {
            findDir = pattern.substring(0, lastSlash) || '.';
            namePatterns = expandBraces(pattern.substring(lastSlash + 1));
          } else {
            namePatterns = expandBraces(pattern);
          }
        }

        const findArgs = [findDir, '-type', 'f', '(', ...namePatterns.flatMap((np, i) => (
          i === 0 ? ['-name', np] : ['-o', '-name', np]
        )), ')'];
        for (const d of SEARCH_EXCLUDE_DIRS) {
          findArgs.push('-not', '-path', `*/${d}/*`);
        }

        const result = await runCmd('find', findArgs, {
          cwd: context.workspaceDir,
          timeoutMs: 30_000,
        });

        const files = result.stdout
          .split('\n')
          .filter(Boolean)
          .sort()
          .slice(0, limit);

        if (files.length === 0) {
          return { content: [{ type: 'text', text: 'No files found.' }] };
        }

        return {
          content: [{ type: 'text', text: `Found ${files.length} files:\n${files.join('\n')}` }],
        };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error searching: ${err.message}` }], isError: true };
      }
    },
  };
}

export function getGrepTool(): ToolDefinition {
  return {
    name: 'grep',
    description:
      'Search file contents using regular expressions (ripgrep when available). ' +
      'Returns exact file paths, line numbers, and source code with configurable context lines. ' +
      'After finding a match, use read_file(startLine, endLine) to load the target region for editing. ' +
      'Use include to filter by file type (e.g., "*.ts", "*.{ts,tsx}").',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Regex pattern to search for in file contents.',
        },
        path: {
          type: 'string',
          description: 'Relative directory or file to search. Defaults to workspace root.',
        },
        include: {
          type: 'string',
          description: 'File glob to include (e.g., "*.ts", "*.{ts,tsx}", "*.py").',
        },
        context: {
          type: 'number',
          description: 'Number of context lines before and after each match. Default: 0.',
          minimum: 0,
          maximum: 10,
        },
        limit: {
          type: 'number',
          description: 'Maximum number of matching lines to return. Default: 50.',
          minimum: 1,
        },
      },
      required: ['pattern'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
    },
    execute: async (
      input: Record<string, unknown>,
      context: ToolContext
    ): Promise<ToolResult> => {
      const pattern = String(input.pattern || '');
      const searchPath = String(input.path || '.');
      const include = String(input.include || '');
      const contextLines = Math.min(10, Math.max(0, input.context != null ? Number(input.context) : 0));
      const limit = Math.min(200, Math.max(1, Number(input.limit) || 50));

      if (!pattern) {
        return { content: [{ type: 'text', text: 'Error: pattern is required.' }], isError: true };
      }

      try {
        const stdout = await contentSearch(context.workspaceDir, pattern, searchPath, {
          include,
          maxCount: 10,
          contextLines,
          maxColumns: 400,
        });

        const rawLines = stdout.split('\n').filter(Boolean);
        if (rawLines.length === 0) {
          return { content: [{ type: 'text', text: 'No matches found.' }] };
        }

        // Parse rg/grep output into structured matches.
        // rg format with -n: file:line:content
        // rg format with -C: file-line--content (separator lines are "--")
        // grep -n format: file:line:content
        // grep -C format uses "--" separators
        interface GrepMatch {
          file: string;
          line: number;
          content: string;
          isContext: boolean;
        }

        const grouped = new Map<string, GrepMatch[]>();
        let matchCount = 0;

        for (const raw of rawLines) {
          if (raw === '--') continue;

          // Try file:line:content format (most common with -n).
          const colon1 = raw.indexOf(':');
          if (colon1 === -1) continue;
          const potentialFile = raw.substring(0, colon1);
          const rest = raw.substring(colon1 + 1);
          const colon2 = rest.indexOf(':');
          if (colon2 === -1) continue;
          const lineNumStr = rest.substring(0, colon2);
          const lineNum = parseInt(lineNumStr, 10);
          if (isNaN(lineNum)) continue;

          const content = truncateLine(rest.substring(colon2 + 1), 400);
          const isContext = rawLines.indexOf(raw) > 0 && raw.startsWith('-');
          const match: GrepMatch = {
            file: potentialFile,
            line: lineNum,
            content,
            isContext,
          };

          const list = grouped.get(potentialFile) ?? [];
          list.push(match);
          grouped.set(potentialFile, list);
          if (!isContext) matchCount++;
        }

        if (matchCount === 0) {
          return { content: [{ type: 'text', text: 'No matches found.' }] };
        }

        const outputParts: string[] = [];
        for (const [file, matches] of grouped) {
          const lines = matches.map((m) => {
            const lineNum = String(m.line).padStart(4);
            if (m.isContext) {
              return `  ${lineNum} | ${m.content}`;
            }
            return `→ ${lineNum} | ${m.content}`;
          });
          outputParts.push(`FILE: ${file}\n${lines.join('\n')}`);
        }

        const truncNote = matchCount > limit
          ? `\n\n[Showing ${limit} of ${matchCount} matches. Use path or include to narrow.]`
          : '';

        return {
          content: [{ type: 'text', text: `Found ${matchCount} matches:\n\n${outputParts.join('\n\n')}${truncNote}` }],
        };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error searching: ${err.message}` }], isError: true };
      }
    },
  };
}

/** Read a file and extract lines for symbol source display. */
async function readSymbolSource(
  filePath: string,
  workspaceDir: string,
  startLine: number,
  maxLines: number = 30,
): Promise<{ content: string; hash: string } | null> {
  const fs = await import('fs/promises');
  const resolved = path.resolve(workspaceDir, filePath);
  try {
    const content = await fs.readFile(resolved, 'utf-8');
    const allLines = content.split('\n');
    const endLine = Math.min(allLines.length, startLine + maxLines - 1);
    const slice = allLines.slice(startLine - 1, endLine);
    const numbered = slice
      .map((line, i) => {
        const num = String(startLine + i).padStart(4);
        return `${num} | ${line}`;
      })
      .join('\n');
    const crypto = await import('crypto');
    const hash = crypto.createHash('md5').update(content).digest('hex').slice(0, 12);
    return { content: numbered, hash };
  } catch {
    return null;
  }
}

export function getFindSymbolTool(): ToolDefinition {
  return {
    name: 'find_symbol',
    description:
      'Find symbol definitions (class, function, interface, type, enum, const) across the workspace. ' +
      'Returns symbol name, file path, start/end lines, source content, and file hash. ' +
      'Use read_file(startLine, endLine) after this to load the full symbol for editing. ' +
      'Uses the workspace index when available for instant lookups.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Symbol name to search for (exact or partial).',
        },
        type: {
          type: 'string',
          enum: ['all', 'class', 'function', 'interface', 'type', 'enum', 'const', 'variable', 'method'],
          description: 'Filter by symbol type. Default: all.',
        },
        path: {
          type: 'string',
          description: 'Relative directory to search within. Defaults to workspace root.',
        },
        include: {
          type: 'string',
          description: 'File glob to include (e.g., "*.ts", "*.py").',
        },
      },
      required: ['name'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
    },
    execute: async (
      input: Record<string, unknown>,
      context: ToolContext
    ): Promise<ToolResult> => {
      const name = String(input.name || '');
      const type = String(input.type || 'all');
      const searchPath = String(input.path || '.');
      const include = String(input.include || '');

      if (!name) {
        return { content: [{ type: 'text', text: 'Error: name is required.' }], isError: true };
      }

      // Use SQLite-backed workspace index when available (instant lookup).
      if (context.workspaceIndex) {
        try {
          const index = context.workspaceIndex;
          const stats = index.stats();
          if (stats.files > 0) {
            const kindFilter = type === 'all' ? undefined : type as any;
            const results = index.findSymbol(name);
            const filtered = kindFilter
              ? results.filter((r) => r.kind === kindFilter)
              : results;

            const pathFiltered = searchPath === '.'
              ? filtered
              : filtered.filter((r) => r.file.startsWith(searchPath));

            if (pathFiltered.length === 0) {
              return { content: [{ type: 'text', text: `No symbols found matching "${name}".` }] };
            }

            const outputParts: string[] = [];
            const sourceResults = await Promise.all(
              pathFiltered.slice(0, 20).map(async (r) => {
                const source = await readSymbolSource(r.file, context.workspaceDir, r.line, 30);
                const endLine = r.endLine ?? r.line;
                return { r, source, endLine };
              }),
            );
            for (const { r, source, endLine } of sourceResults) {
              const hashLine = source ? `HASH: ${source.hash}` : '';
              const sourceBlock = source ? `\n\n${source.content}` : '';
              outputParts.push(
                `Symbol: ${r.name} (${r.kind})\nFILE: ${r.file}\nLINES: ${r.line}-${endLine}\n${hashLine}${sourceBlock}`,
              );
            }

            return {
              content: [{ type: 'text', text: `Found ${pathFiltered.length} matches for symbol "${name}":\n\n${outputParts.join('\n\n---\n\n')}` }],
            };
          }
        } catch {
          // Fall through to grep-based search.
        }
      }

      // Fallback: grep-based search.
      const safeName = escapeRegex(name);
      const searchPatterns: Record<string, string[]> = {
        class: [
          `\\bclass\\s+${safeName}\\b`,
          `\\bclass\\s+\\w+\\s+extends\\s+${safeName}\\b`,
          `\\bclass\\s+\\w+\\s+implements\\s+${safeName}\\b`,
        ],
        function: [
          `\\bfunction\\s+${safeName}\\b`,
          `\\bconst\\s+${safeName}\\s*=\\s*(async\\s*)?\\(`,
          `\\bdef\\s+${safeName}\\b`,
        ],
        interface: [`\\binterface\\s+${safeName}\\b`],
        type: [`\\btype\\s+${safeName}\\b`],
        enum: [`\\benum\\s+${safeName}\\b`],
        const: [`\\bconst\\s+${safeName}\\b`, `\\blet\\s+${safeName}\\b`],
        variable: [`\\b${safeName}\\b\\s*[=:]`],
        method: [`\\b${safeName}\\s*\\(`],
      };

      const searchPatternsArr: string[] = type === 'all'
        ? [`\\b${safeName}\\b`]
        : (searchPatterns[type] || [`\\b${safeName}\\b`]);

      try {
        const allMatches: Set<string> = new Set();

        const searchResults = await Promise.all(
          searchPatternsArr.map(async (pat) => {
            const stdout = await contentSearch(context.workspaceDir, pat, searchPath, {
              include,
              maxCount: 10,
              maxColumns: 300,
              timeoutMs: 15_000,
            });
            return stdout;
          }),
        );
        for (const stdout of searchResults) {
          for (const l of stdout.split('\n')) {
            if (l.trim()) allMatches.add(l);
          }
        }

        const unique = [...allMatches].slice(0, 50);

        if (unique.length === 0) {
          return { content: [{ type: 'text', text: `No symbols found matching "${name}".` }] };
        }

        const outputParts: string[] = [];
        const sourceResults = await Promise.all(
          unique.map(async (line) => {
            const colonIdx = line.indexOf(':');
            if (colonIdx === -1) return null;
            const filePath = line.substring(0, colonIdx);
            const rest = line.substring(colonIdx + 1);
            const lineNumIdx = rest.indexOf(':');
            if (lineNumIdx === -1) return null;
            const lineNum = parseInt(rest.substring(0, lineNumIdx), 10);
            if (isNaN(lineNum)) return null;
            const source = await readSymbolSource(filePath, context.workspaceDir, lineNum, 15);
            return { filePath, lineNum, source };
          }),
        );
        for (const item of sourceResults) {
          if (!item) continue;
          const hashLine = item.source ? `HASH: ${item.source.hash}` : '';
          const sourceBlock = item.source ? `\n\n${item.source.content}` : '';
          outputParts.push(
            `FILE: ${item.filePath}\nLINE: ${item.lineNum}\n${hashLine}${sourceBlock}`,
          );
        }

        return {
          content: [{ type: 'text', text: `Found ${unique.length} matches for symbol "${name}":\n\n${outputParts.join('\n\n---\n\n')}` }],
        };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error searching for symbol: ${err.message}` }], isError: true };
      }
    },
  };
}

export function getSearchCodeTool(): ToolDefinition {
  return {
    name: 'search_code',
    description:
      'Search for code patterns across the workspace with line numbers and context. ' +
      'Returns file paths, line numbers, and surrounding source code for each match. ' +
      'After finding a match, use read_file(startLine, endLine) to load the exact region for editing.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (regex supported).',
        },
        path: {
          type: 'string',
          description: 'Relative directory to search. Defaults to workspace root.',
        },
        include: {
          type: 'string',
          description: 'File glob to include (e.g., "*.ts").',
        },
        context: {
          type: 'number',
          description: 'Number of context lines before and after each match. Default: 3.',
          minimum: 0,
          maximum: 10,
        },
        limit: {
          type: 'number',
          description: 'Maximum matches to return. Default: 30.',
          minimum: 1,
        },
      },
      required: ['query'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
    },
    execute: async (
      input: Record<string, unknown>,
      context: ToolContext
    ): Promise<ToolResult> => {
      const query = String(input.query || '');
      const searchPath = String(input.path || '.');
      const include = String(input.include || '');
      const contextLines = Math.min(10, Math.max(0, input.context != null ? Number(input.context) : 3));
      const limit = Math.min(50, Math.max(1, Number(input.limit) || 30));

      if (!query) {
        return { content: [{ type: 'text', text: 'Error: query is required.' }], isError: true };
      }

      try {
        const stdout = await contentSearch(context.workspaceDir, query, searchPath, {
          include,
          maxCount: 10,
          contextLines,
          maxColumns: 400,
        });

        const rawLines = stdout.split('\n').filter(Boolean);
        if (rawLines.length === 0) {
          return { content: [{ type: 'text', text: 'No matches found.' }] };
        }

        // Group by file, preserving line numbers and context.
        interface SearchMatch {
          file: string;
          lineNum: number;
          content: string;
          isContext: boolean;
        }

        const grouped = new Map<string, SearchMatch[]>();
        let matchCount = 0;

        for (const raw of rawLines) {
          if (raw === '--') continue;

          const colon1 = raw.indexOf(':');
          if (colon1 === -1) continue;
          const potentialFile = raw.substring(0, colon1);
          const rest = raw.substring(colon1 + 1);
          const colon2 = rest.indexOf(':');
          if (colon2 === -1) continue;
          const lineNum = parseInt(rest.substring(0, colon2), 10);
          if (isNaN(lineNum)) continue;

          const content = truncateLine(rest.substring(colon2 + 1), 400);
          // Context lines in rg output are prefixed with "-"
          const isContext = raw.startsWith(potentialFile + '-') || raw.startsWith(potentialFile + ':');

          const match: SearchMatch = {
            file: potentialFile,
            lineNum,
            content,
            isContext: false, // rg -n always shows line numbers for actual matches
          };

          const list = grouped.get(potentialFile) ?? [];
          list.push(match);
          grouped.set(potentialFile, list);
          matchCount++;
        }

        if (matchCount === 0) {
          return { content: [{ type: 'text', text: 'No matches found.' }] };
        }

        const outputParts: string[] = [];
        let displayed = 0;
        for (const [file, matches] of grouped) {
          if (displayed >= limit) break;
          const matchLines = matches.slice(0, limit - displayed);
          displayed += matchLines.length;

          const numberedLines = matchLines.map((m) => {
            const num = String(m.lineNum).padStart(4);
            return `  ${num} | ${m.content}`;
          });
          outputParts.push(`FILE: ${file}\n${numberedLines.join('\n')}`);
        }

        const truncNote = matchCount > limit
          ? `\n\n[Showing ${limit} of ${matchCount} matches. Use path or include to narrow.]`
          : '';

        return {
          content: [{ type: 'text', text: `Found ${matchCount} matches:\n\n${outputParts.join('\n\n')}${truncNote}` }],
        };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Error searching: ${err.message}` }], isError: true };
      }
    },
  };
}
