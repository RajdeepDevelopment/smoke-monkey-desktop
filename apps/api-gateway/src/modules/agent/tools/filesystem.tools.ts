import {
  ToolDefinition,
  ToolResult,
  ToolContext,
  ToolAnnotations,
} from './tool-registry';
import * as fs from 'fs/promises';
import * as path from 'path';
import { FileReadCache } from '../services/file-read-cache';

const MAX_READ_BYTES = 50 * 1024;
const MAX_READ_LINES = 800;
const DEFAULT_READ_WINDOW = 400;
const MAX_LINE_LENGTH = 2000;

/** Shared file read cache — avoids re-reading unchanged files across tool calls. */
const fileReadCache = new FileReadCache();

const BINARY_EXTENSIONS = new Set([
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.class', '.jar', '.war',
  '.o', '.a', '.lib', '.wasm', '.pyc', '.pyo',
  '.bin', '.dat', '.obj', '.pdf',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.svg',
  '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.flac', '.wav',
  '.ttf', '.woff', '.woff2', '.eot', '.otf',
]);

function isBinaryFile(content: Buffer): boolean {
  const sample = content.subarray(0, Math.min(8192, content.length));
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true;
    if (sample[i] > 127 && Math.random() < 0.1) {
      let nonText = 0;
      for (let j = 0; j < Math.min(256, sample.length); j++) {
        if (sample[j] > 127) nonText++;
      }
      if (nonText > 64) return true;
      break;
    }
  }
  return false;
}

function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext);
}

function truncateLine(line: string, maxLen: number): string {
  if (line.length <= maxLen) return line;
  return line.substring(0, maxLen) + '...';
}

// ---------------------------------------------------------------------------
// Observation policy (ported from deepseek-harness FS_NOT_OBSERVED /
// FS_STALE_VERSION): a mutation is only allowed on a file THIS session has
// read, and only while it is unchanged since that read. Failures carry an
// explicit remedy so the model can self-correct instead of retrying blindly.
// ---------------------------------------------------------------------------
const observedFiles = new Map<string, string>();

function observeKey(sessionId: string, resolved: string): string {
  return `${sessionId}::${resolved}`;
}

/** Size + nanosecond mtime fingerprint: detects any change, even same-ms writes. */
async function currentFingerprint(resolved: string): Promise<string | null> {
  try {
    const s = await fs.stat(resolved, { bigint: true });
    return `${s.size}:${s.mtimeNs}`;
  } catch {
    return null;
  }
}

async function observeRead(sessionId: string, resolved: string): Promise<void> {
  const fp = await currentFingerprint(resolved);
  if (fp !== null) observedFiles.set(observeKey(sessionId, resolved), fp);
}

function errResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

async function assertObserved(
  sessionId: string,
  resolved: string,
  displayPath: string,
): Promise<ToolResult | null> {
  const seen = observedFiles.get(observeKey(sessionId, resolved));
  if (seen === undefined) {
    return errResult(
      `Error: ${displayPath} has not been read in this session yet — call read_file on it first, then retry.`,
    );
  }
  const now = await currentFingerprint(resolved);
  if (now !== null && now !== seen) {
    observedFiles.delete(observeKey(sessionId, resolved));
    return errResult(
      `Error: ${displayPath} changed since it was last read — re-read it, then retry against the current content.`,
    );
  }
  return null;
}

/** Models occasionally echo read-style "N: " prefixes inside oldString/newString.
 * Strip a consistent leading line-number prefix when most non-empty lines have one. */
function stripLineNumberPrefixes(text: string): string {
  const lines = text.split('\n');
  const nonEmpty = lines.filter((l) => l.trim() !== '');
  if (nonEmpty.length < 2) return text;
  const prefixed = nonEmpty.filter((l) => /^\s*\d{1,6}[:|]\s/.test(l));
  if (prefixed.length / nonEmpty.length < 0.8) return text;
  return lines.map((l) => l.replace(/^\s*\d{1,6}[:|]\s/, '')).join('\n');
}

/** On oldString-not-found, surface the closest region of the real file so the
 * model can copy exact text instead of guessing again. */
function nearestRegionHint(content: string, needle: string): string {
  const lines = content.split('\n');
  const rawNeedleLines = needle.split('\n');
  const needleLines = rawNeedleLines.map((l) => l.replace(/\s+$/, ''));

  const renderRegion = (center: number, span: number): string => {
    const from = Math.max(0, center - 2);
    const to = Math.min(lines.length, center + span + 2);
    const shown = lines
      .slice(from, to)
      .map((l, k) => `${from + k + 1}| ${truncateLine(l, 300)}`)
      .join('\n');
    return `\n\nClosest matching region (lines ${from + 1}-${to}). Copy your oldString EXACTLY from this text:\n${shown}`;
  };

  if (!needleLines.length || needleLines.length > 80) return '';

  // Pass 1: windowed structural match against the whole needle.
  let bestIdx = -1;
  let bestScore = -1;
  const scanLimit = Math.min(lines.length - needleLines.length, 4000);
  for (let i = 0; i <= scanLimit; i++) {
    let score = 0;
    for (let j = 0; j < needleLines.length; j++) {
      const actual = lines[i + j]?.replace(/\s+$/, '') ?? '';
      if (actual === needleLines[j]) score += 1;
      else if (
        needleLines[j].trim() !== '' &&
        actual.trim().includes(needleLines[j].trim().slice(0, 40))
      ) {
        score += 0.4;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  if (bestIdx !== -1 && bestScore >= Math.max(0.5, needleLines.length * 0.5)) {
    return renderRegion(bestIdx, needleLines.length);
  }

  // Pass 2: closest single line by leading-character similarity.
  const probe = needleLines.map((l) => l.trim()).find((l) => l.length >= 4);
  if (!probe) return '';
  let bi = -1;
  let bs = 0;
  const lineLimit = Math.min(lines.length, 4000);
  for (let i = 0; i < lineLimit; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    let same = 0;
    while (same < t.length && same < probe.length && t[same] === probe[same]) same++;
    const ratio = same / Math.max(t.length, probe.length);
    if (ratio > bs) {
      bs = ratio;
      bi = i;
    }
  }
  if (bi !== -1 && bs >= 0.6) return renderRegion(bi, needleLines.length);
  return '';
}

function formatLineNumbers(
  lines: string[],
  startLine: number,
  opts: { maxLineNum?: number; truncate?: number } = {},
): string {
  const maxLineNum = opts.maxLineNum ?? (startLine + lines.length - 1);
  const width = String(maxLineNum).length;
  return lines
    .map((line, i) => {
      const num = String(startLine + i).padStart(width);
      const truncated = truncateLine(line, opts.truncate ?? MAX_LINE_LENGTH);
      return `${num} | ${truncated}`;
    })
    .join('\n');
}

export function getReadFileTool(): ToolDefinition {
  return {
    name: 'read_file',
    description:
      'Read a text file, view a supported image, or list a directory. ' +
      'Returns line-numbered source code with file hash for safe editing. ' +
      'Use startLine/endLine for targeted reads (e.g., after grep locates a line). ' +
      'For large files do NOT page through: use startLine/endLine to read only the target region. ' +
      'Binary files (executables, archives, images other than jpg/png/gif/webp) are rejected. ' +
      'Files must be read before they can be edited in this session.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'File path or directory path to read. Relative paths resolve from the workspace root.',
        },
        startLine: {
          type: 'number',
          description:
            '1-based line number to start reading from. Default: 1.',
          minimum: 1,
        },
        endLine: {
          type: 'number',
          description:
            '1-based line number to stop reading at (inclusive). Default: end of file. Use with startLine for targeted reads.',
          minimum: 1,
        },
        offset: {
          type: 'number',
          description: 'Alias for startLine (deprecated, use startLine).',
          minimum: 1,
        },
        limit: {
          type: 'number',
          description:
            'Maximum number of lines to read (text) or directory entries to list. Max: 800. Default: 400.',
          minimum: 1,
          maximum: MAX_READ_LINES,
        },
      },
      required: ['path'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
    },
    execute: async (
      input: Record<string, unknown>,
      context: ToolContext
    ): Promise<ToolResult> => {
      const filePath = String(input.path || '');
      // Support both startLine/endLine and legacy offset/limit.
      const startLine = Math.max(1, Number(input.startLine ?? input.offset) || 1);
      const explicitEnd = input.endLine != null ? Number(input.endLine) : undefined;
      const limit = Math.min(MAX_READ_LINES, Math.max(1, Number(input.limit) || MAX_READ_LINES));

      if (!filePath) {
        return { content: [{ type: 'text', text: 'Error: path is required.' }], isError: true };
      }

      const resolved = path.resolve(context.workspaceDir, filePath);

      try {
        const stat = await fs.stat(resolved);

        if (stat.isDirectory()) {
          const entries = await fs.readdir(resolved, { withFileTypes: true });
          const sorted = entries.sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
          });

          const offset = startLine;
          const page = sorted.slice(offset - 1, offset - 1 + limit);
          const lines = page.map((e, i) => {
            const idx = offset + i;
            const prefix = e.isDirectory() ? '/' : '';
            return `${idx}: ${prefix}${e.name}`;
          });

          if (lines.length === 0) {
            return { content: [{ type: 'text', text: '(empty directory)' }] };
          }

          const output = lines.join('\n');
          if (sorted.length > offset - 1 + limit) {
            return {
              content: [{ type: 'text', text: output + `\n\n[Page ${offset}-${offset + page.length - 1} of ${sorted.length}. Use offset=${offset + limit} for more.]` }],
            };
          }
          return { content: [{ type: 'text', text: output }] };
        }

        if (isImageFile(resolved)) {
          const buf = await fs.readFile(resolved);
          return {
            content: [
              { type: 'text', text: `[Image file: ${filePath} (${buf.length} bytes)]` },
              { type: 'image', data: buf.toString('base64'), mimeType: 'image/png' },
            ],
          };
        }

        // Binary check by extension.
        const ext = path.extname(resolved).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) {
          return {
            content: [{ type: 'text', text: `Error: Cannot read binary file: ${filePath} (file extension ${ext} is binary).` }],
            isError: true,
          };
        }

        // Read content (use cache when possible).
        let content: string;
        let fileHash = '';
        const cached = await fileReadCache.read(resolved);
        if (cached) {
          content = cached.content;
          fileHash = cached.hash;
        } else {
          const buf = await fs.readFile(resolved);
          if (isBinaryFile(buf)) {
            return {
              content: [{ type: 'text', text: `Error: Cannot read binary file: ${filePath} (contains binary/null bytes).` }],
              isError: true,
            };
          }
          content = buf.toString('utf-8');
          // Compute a content hash for stale detection.
          const crypto = await import('crypto');
          fileHash = crypto.createHash('md5').update(content).digest('hex').slice(0, 12);
        }
        const allLines = content.split('\n');
        const totalLines = allLines.length;

        // Mark as observed for edit policy.
        await observeRead(context.sessionId, resolved);

        // Compute the window: explicit endLine takes precedence, then limit.
        const endLine = explicitEnd != null
          ? Math.min(totalLines, Math.max(startLine, explicitEnd))
          : Math.min(totalLines, startLine + limit - 1);
        const sliceStart = startLine - 1;
        const sliceEnd = endLine;
        const windowLines = allLines.slice(sliceStart, sliceEnd);
        const hasMore = sliceEnd < totalLines;

        const header = `FILE: ${filePath}`;
        const hashLine = `HASH: ${fileHash}`;
        const rangeLine = `LINES: ${startLine}-${endLine} of ${totalLines}`;
        const numbered = formatLineNumbers(windowLines, startLine);

        let footer = '';
        if (hasMore) {
          footer = `\n\n[Showing lines ${startLine}-${endLine} of ${totalLines}. Use startLine=${endLine + 1} to continue reading.]`;
        }

        const output = `${header}\n${hashLine}\n${rangeLine}\n\n${numbered}${footer}`;
        return { content: [{ type: 'text', text: output }] };
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return { content: [{ type: 'text', text: `Error: File not found: ${filePath}` }], isError: true };
        }
        if (err.code === 'EACCES') {
          return { content: [{ type: 'text', text: `Error: Permission denied: ${filePath}` }], isError: true };
        }
        return { content: [{ type: 'text', text: `Error reading ${filePath}: ${err.message}` }], isError: true };
      }
    },
  };
}

export function getWriteFileTool(): ToolDefinition {
  return {
    name: 'write_file',
    description:
      'Write content to a file, creating it if it does not exist. ' +
      'Overwrites existing content completely. Use apply_patch for surgical edits. ' +
      'Relative paths resolve from the workspace root.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path to write. Relative paths resolve from the workspace root.',
        },
        content: {
          type: 'string',
          description: 'Content to write to the file.',
        },
      },
      required: ['path', 'content'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
    },
    execute: async (
      input: Record<string, unknown>,
      context: ToolContext
    ): Promise<ToolResult> => {
      const filePath = String(input.path || '');
      const content = String(input.content ?? '');

      if (!filePath) {
        return { content: [{ type: 'text', text: 'Error: path is required.' }], isError: true };
      }
      if (!content || content.trim() === '') {
        return { content: [{ type: 'text', text: 'Error: content must not be empty. Use edit_file to modify existing files.' }], isError: true };
      }

      const resolved = path.resolve(context.workspaceDir, filePath);

      try {
        let existed = false;
        try {
          await fs.access(resolved);
          existed = true;
        } catch {}

        // Overwriting an existing file without having read it is how agents
        // blindly clobber code. New-file creation stays unrestricted.
        if (existed) {
          const gate = await assertObserved(context.sessionId, resolved, filePath);
          if (gate) return gate;
        }

        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, content, 'utf-8');
        await observeRead(context.sessionId, resolved);

        const crypto = await import('crypto');
        const fileHash = crypto.createHash('md5').update(content).digest('hex').slice(0, 12);
        const lineCount = content.split('\n').length;
        const verb = existed ? 'Updated' : 'Created';
        return {
          content: [{
            type: 'text',
            text: `${verb} file successfully: ${filePath}\nHASH: ${fileHash}\nLines: ${lineCount}\nBytes: ${Buffer.byteLength(content, 'utf-8')}`,
          }],
        };
      } catch (err: any) {
        if (err.code === 'EACCES') {
          return { content: [{ type: 'text', text: `Error: Permission denied writing to ${filePath}` }], isError: true };
        }
        return { content: [{ type: 'text', text: `Error writing ${filePath}: ${err.message}` }], isError: true };
      }
    },
  };
}

export function getEditFileTool(): ToolDefinition {
  return {
    name: 'edit_file',
    description:
      'Replace exact text in a file using find-and-replace. The oldString must match exactly ' +
      '(including whitespace and indentation). Use this for surgical edits — prefer over write_file ' +
      'for modifying existing files. If oldString is empty, use write_file instead.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path to edit. Relative paths resolve from the workspace root.',
        },
        oldString: {
          type: 'string',
          description: 'Exact text to find and replace. Must match exactly including whitespace.',
        },
        newString: {
          type: 'string',
          description: 'Replacement text. Must differ from oldString.',
        },
        replaceAll: {
          type: 'boolean',
          description: 'Replace all occurrences of oldString (default: false, replaces only first match).',
        },
      },
      required: ['path', 'oldString', 'newString'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    execute: async (
      input: Record<string, unknown>,
      context: ToolContext
    ): Promise<ToolResult> => {
      const filePath = String(input.path || '');
      // Defense-in-depth: models sometimes echo read-style "12: " prefixes into
      // edit arguments; strip them before matching so history-poisoning can't
      // cause a not-found loop.
      const oldString = stripLineNumberPrefixes(String(input.oldString ?? ''));
      const newString = stripLineNumberPrefixes(String(input.newString ?? ''));
      const replaceAll = Boolean(input.replaceAll);

      if (!filePath) {
        return { content: [{ type: 'text', text: 'Error: path is required.' }], isError: true };
      }
      if (!oldString) {
        return {
          content: [{ type: 'text', text: 'Error: oldString must not be empty. Use write_file to create or overwrite a file.' }],
          isError: true,
        };
      }
      if (oldString === newString) {
        return {
          content: [{ type: 'text', text: 'Error: oldString and newString are identical. No changes to apply.' }],
          isError: true,
        };
      }

      const resolved = path.resolve(context.workspaceDir, filePath);

      const gate = await assertObserved(context.sessionId, resolved, filePath);
      if (gate) return gate;

      try {
        const content = await fs.readFile(resolved, 'utf-8');
        const hasCrlf = content.includes('\r\n');
        const normalizedOld = hasCrlf ? oldString.replace(/\n/g, '\r\n') : oldString;
        const normalizedNew = hasCrlf ? newString.replace(/\n/g, '\r\n') : newString;

        if (replaceAll) {
          const count = content.split(normalizedOld).length - 1;
          if (count === 0) {
            return {
              content: [{ type: 'text', text: `Error: Could not find oldString in ${filePath}. It must match exactly, including whitespace and indentation.${nearestRegionHint(content, oldString)}\nIf unsure, read_file the relevant section first.` }],
              isError: true,
            };
          }
          const updated = content.split(normalizedOld).join(normalizedNew);
          await fs.writeFile(resolved, updated, 'utf-8');
          await observeRead(context.sessionId, resolved);
          const crypto = await import('crypto');
          const newHash = crypto.createHash('md5').update(updated).digest('hex').slice(0, 12);
          const diffLines = newString.split('\n').map(l => '+' + l).join('\n');
          return {
            content: [{
              type: 'text',
              text: `Edited file successfully: ${filePath}\nHASH: ${newHash}\nReplacements: ${count}\n\`\`\`diff\n${diffLines}\n\`\`\``,
            }],
          };
        }

        // Idempotency guard: models repeat successful edits ("## Deployment" ⊂
        // "## Deployment Guide" keeps matching its own replacement). Classify
        // every occurrence as already-applied or pending before doing anything.
        const occurrences: number[] = [];
        for (let i = content.indexOf(normalizedOld); i !== -1; i = content.indexOf(normalizedOld, i + normalizedOld.length)) {
          occurrences.push(i);
        }
        // An occurrence counts as "already applied" only when the replacement
        // genuinely sits there WITHOUT the original still being present.
        // Covers: self-referential growth ("X" -> "X Y"), prefix shrinks
        // ("AB" -> "A"), and empty newString (pure deletion).
        const grows = normalizedNew.length > normalizedOld.length;
        const isAppliedAt = (at: number) =>
          content.startsWith(normalizedNew, at) &&
          (grows || !content.startsWith(normalizedOld, at));
        const pendingIdx = occurrences.filter((at) => !isAppliedAt(at));

        if (occurrences.length > 0 && pendingIdx.length === 0) {
          return {
            content: [{
              type: 'text',
              text: `No changes made: ${filePath} already contains the replacement for this exact oldString (the edit was applied earlier). Treat the file as already correct and do NOT call edit_file with these arguments again.`,
            }],
          };
        }

        if (pendingIdx.length === 0) {
          return {
            content: [{ type: 'text', text: `Error: Could not find oldString in ${filePath}. It must match exactly, including whitespace and indentation.${nearestRegionHint(content, oldString)}\nIf unsure, read_file the relevant section first.` }],
            isError: true,
          };
        }

        if (pendingIdx.length > 1) {
          return {
            content: [{
              type: 'text',
              text: `Error: Found ${pendingIdx.length} unmodified matches for oldString in ${filePath}. Provide more surrounding context to make the match unique, or set replaceAll to true.`,
            }],
            isError: true,
          };
        }

        const idx = pendingIdx[0];
        const updated = content.substring(0, idx) + normalizedNew + content.substring(idx + normalizedOld.length);
        await fs.writeFile(resolved, updated, 'utf-8');
        await observeRead(context.sessionId, resolved);

        const crypto = await import('crypto');
        const newHash = crypto.createHash('md5').update(updated).digest('hex').slice(0, 12);
        const oldLines = oldString.split('\n');
        const newLines = newString.split('\n');
        const diffLines = [
          ...oldLines.map(l => '-' + l),
          ...newLines.map(l => '+' + l),
        ].join('\n');

        return {
          content: [{
            type: 'text',
            text: `Edited file successfully: ${filePath}\nHASH: ${newHash}\nReplacements: 1\n\`\`\`diff\n${diffLines}\n\`\`\``,
          }],
        };
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return { content: [{ type: 'text', text: `Error: File not found: ${filePath}. Use write_file to create it.` }], isError: true };
        }
        if (err.code === 'EACCES') {
          return { content: [{ type: 'text', text: `Error: Permission denied: ${filePath}` }], isError: true };
        }
        return { content: [{ type: 'text', text: `Error editing ${filePath}: ${err.message}` }], isError: true };
      }
    },
  };
}

/**
 * A `replacement` may carry the line-number prefixes JSON-serialization can't
 * (e.g. the model pastes read_file output verbatim). Strip them defensively,
 * same as edit_file does for oldString/newString.
 */
function stripLineNumbers(text: string): string {
  return stripLineNumberPrefixes(text);
}

export function getReplaceLinesTool(): ToolDefinition {
  return {
    name: 'replace_lines',
    description:
      'Replace a contiguous line range in a file with new content, using 1-based line numbers ' +
      'straight from read_file output. FASTER and far more token-efficient than edit_file: you do ' +
      'NOT need to reproduce the exact old text — just say which lines to remove (' +
      'startLine..endLine, inclusive) and what to put in their place. Everything outside the range ' +
      'is left untouched. Use startLine=endLine to replace a single line; pass an empty replacement ' +
      'to delete the range. The file must have been read this session before you can replace in it.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path to edit. Relative paths resolve from the workspace root.',
        },
        startLine: {
          type: 'number',
          description: '1-based line number of the first line to replace (inclusive).',
          minimum: 1,
        },
        endLine: {
          type: 'number',
          description:
            '1-based line number of the last line to replace (inclusive). Default: startLine (replace a single line).',
          minimum: 1,
        },
        replacement: {
          type: 'string',
          description:
            'New text to place where the range was. Lines are used as-is; set your own indentation. ' +
            'Use an empty string to delete the range entirely.',
        },
      },
      required: ['path', 'startLine', 'replacement'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    execute: async (
      input: Record<string, unknown>,
      context: ToolContext
    ): Promise<ToolResult> => {
      const filePath = String(input.path || '');
      const startLine = Math.max(1, Math.floor(Number(input.startLine) || 1));
      const rawEnd = input.endLine != null ? Math.floor(Number(input.endLine)) : startLine;
      const endLine = Math.max(startLine, rawEnd);
      const replacement = input.replacement == null ? '' : stripLineNumbers(String(input.replacement));

      if (!filePath) {
        return { content: [{ type: 'text', text: 'Error: path is required.' }], isError: true };
      }

      const resolved = path.resolve(context.workspaceDir, filePath);
      const gate = await assertObserved(context.sessionId, resolved, filePath);
      if (gate) return gate;

      try {
        const content = await fs.readFile(resolved, 'utf-8');
        const hasCrlf = content.includes('\r\n');
        const eol = hasCrlf ? '\r\n' : '\n';
        const lines = content.split(/\r\n|\n/);
        // Drop the final empty element produced by a trailing newline, and track
        // whether the file ended with a newline (we re-add it below).
        const hadTrailingNewline = lines.length > 0 && lines[lines.length - 1] === '';
        if (hadTrailingNewline) lines.pop();
        const totalLines = lines.length;

        if (startLine > totalLines) {
          return {
            content: [{ type: 'text', text: `Error: startLine ${startLine} is past the end of ${filePath} (${totalLines} lines). Adjust the range.` }],
            isError: true,
          };
        }

        const fromIdx = startLine - 1;
        const endIdx = Math.min(endLine, totalLines) - 1; // inclusive index
        const removed = lines.slice(fromIdx, endIdx + 1);
        const replacementLines = replacement === '' ? [] : replacement.split(/\r\n|\n/);
        const updatedLines = [
          ...lines.slice(0, fromIdx),
          ...replacementLines,
          ...lines.slice(endIdx + 1),
        ];
        const updated = updatedLines.join(eol) + (hadTrailingNewline ? eol : '');

        await fs.writeFile(resolved, updated, 'utf-8');
        await observeRead(context.sessionId, resolved);

        const crypto = await import('crypto');
        const newHash = crypto.createHash('md5').update(updated).digest('hex').slice(0, 12);
        const diffLines = [
          ...removed.map((l) => '-' + l),
          ...replacementLines.map((l) => '+' + l),
        ].join('\n');

        return {
          content: [{
            type: 'text',
            text: `Replaced lines ${startLine}-${Math.min(endLine, totalLines)} in ${filePath}\nHASH: ${newHash}\n\`\`\`diff\n${diffLines}\n\`\`\``,
          }],
        };
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return { content: [{ type: 'text', text: `Error: File not found: ${filePath}. Use write_file to create it.` }], isError: true };
        }
        if (err.code === 'EACCES') {
          return { content: [{ type: 'text', text: `Error: Permission denied: ${filePath}` }], isError: true };
        }
        return { content: [{ type: 'text', text: `Error replacing lines in ${filePath}: ${err.message}` }], isError: true };
      }
    },
  };
}

export function getApplyPatchTool(): ToolDefinition {
  return {
    name: 'apply_patch',
    description:
      'Apply a unified diff patch to modify one or more files. Supports add (+), delete (-), and modify operations. ' +
      'Use this for multi-file changes. The patch format uses standard unified diff syntax.',
    inputSchema: {
      type: 'object',
      properties: {
        patchText: {
          type: 'string',
          description:
            'Unified diff patch text. Format:\n' +
            '--- a/path/to/file\n+++ b/path/to/file\n@@ -start,count +start,count @@\n' +
            ' context line\n-removed line\n+added line\n\n' +
            'For new files: use --- /dev/null and +++ b/path/to/file\n' +
            'For deleted files: use --- a/path/to/file and +++ /dev/null',
        },
      },
      required: ['patchText'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
    },
    execute: async (
      input: Record<string, unknown>,
      context: ToolContext
    ): Promise<ToolResult> => {
      let patchText = String(input.patchText || '').trim();

      if (!patchText) {
        return { content: [{ type: 'text', text: 'Error: patchText is required.' }], isError: true };
      }

      patchText = patchText.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\r\n/g, '\n');

      // Parse file sections. Models send both classic `--- a/x\n+++ b/x` and
      // git-style patches with a leading `diff --git` line; accept every shape
      // (a/b/ prefixes optional, /dev/null for create/delete, tab suffixes).
      const stripped = patchText.split('\n').filter((l) => !/^diff --git /.test(l)).join('\n');
      interface PatchSection { targetPath: string; isDelete: boolean; body: string }
      const sections: Array<PatchSection & { oldPath?: string; newPath?: string }> = [];
      const linesAll = stripped.split('\n');
      let cur: (PatchSection & { oldPath?: string; newPath?: string }) | null = null;
      for (let i = 0; i < linesAll.length; i++) {
        const line = linesAll[i];
        if (/^--- (?:a\/)?\S/.test(line)) {
          const oldPath = line.replace(/^--- (?:a\/)?/, '').replace(/\t.*$/, '').trim();
          const nxt = linesAll[i + 1] || '';
          const newPathM = nxt.match(/^\+\+\+ (?:b\/)?(\S+)/);
          cur = { targetPath: oldPath, isDelete: false, body: '', oldPath };
          if (newPathM) {
            const newPath = newPathM[1].replace(/\t.*$/, '');
            cur.newPath = newPath;
            cur.isDelete = newPath === '/dev/null';
            cur.targetPath = cur.isDelete ? oldPath : newPath;
            i++; // consume the +++ line
          } else {
            cur.targetPath = oldPath;
          }
          if (!cur.oldPath || cur.oldPath === '/dev/null') {
            cur.targetPath = cur.newPath || '';
          }
          sections.push(cur);
          continue;
        }
        if (cur) cur.body += line + '\n';
      }

      const fileChunks = sections.filter((s) => s.targetPath && s.targetPath !== '/dev/null');

      if (fileChunks.length === 0) {
        return {
          content: [{ type: 'text', text: 'Error: Invalid patch format. Expected unified diff headers:\n--- a/path/to/file\n+++ b/path/to/file\n@@ -1,4 +1,4 @@\n context\n-old\n+new' }],
          isError: true,
        };
      }

      const applied: string[] = [];
      const results: string[] = [];

      for (const chunk of fileChunks) {
        const targetPath = chunk.targetPath;
        const isDelete = chunk.isDelete;

        if (!targetPath || targetPath === '/dev/null') continue;

        const resolved = path.resolve(context.workspaceDir, targetPath);

        // Observation policy: patching/deleting requires the session to have
        // read the target (unless the file is brand-new for an addition).
        let fileExists = true;
        try {
          await fs.access(resolved);
        } catch {
          fileExists = false;
        }
        if (fileExists) {
          const gate = await assertObserved(context.sessionId, resolved, targetPath);
          if (gate) return gate;
        }

        try {
          if (isDelete) {
            await fs.unlink(resolved);
            observedFiles.delete(observeKey(context.sessionId, resolved));
            applied.push(`D ${targetPath}`);
            results.push(`Deleted: ${targetPath}`);
            continue;
          }

          const hunkRegex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
          let existingContent = '';
          try {
            existingContent = await fs.readFile(resolved, 'utf-8');
          } catch {
            existingContent = '';
          }

          let updatedContent = existingContent;
          let hunkMatch;
          const hunks: Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number; body: string[] }> = [];
          const chunkBody = chunk.body;

          while ((hunkMatch = hunkRegex.exec(chunkBody)) !== null) {
            const oldStart = parseInt(hunkMatch[1]);
            const oldCount = hunkMatch[2] ? parseInt(hunkMatch[2]) : 1;
            const bodyStart = chunkBody.indexOf('\n', hunkMatch.index) + 1;
            const nextHunk = chunkBody.indexOf('\n@@ ', bodyStart);
            const bodyStr = nextHunk === -1 ? chunkBody.substring(bodyStart) : chunkBody.substring(bodyStart, nextHunk);
            hunks.push({
              oldStart,
              oldCount,
              newStart: parseInt(hunkMatch[3]),
              newCount: hunkMatch[4] ? parseInt(hunkMatch[4]) : 1,
              body: bodyStr.split('\n'),
            });
          }

          let changesApplied = 0;
          let alreadyAppliedHunks = 0;
          let contextMismatch = false;
          let mismatchDetail = '';
          const currentLines = (): string[] => updatedContent.split('\n');

          for (const hunk of hunks) {
            // Parse hunk body into ordered ops; tolerate "\ No newline" markers.
            const ops: Array<{ type: 'ctx' | 'del' | 'add'; text: string }> = [];
            for (const raw of hunk.body) {
              if (raw.startsWith('\\')) continue;
              if (raw.startsWith('@@')) break;
              if (raw.startsWith('+')) ops.push({ type: 'add', text: raw.slice(1) });
              else if (raw.startsWith('-')) ops.push({ type: 'del', text: raw.slice(1) });
              else if (raw.startsWith(' ') || raw === '') ops.push({ type: 'ctx', text: raw.startsWith(' ') ? raw.slice(1) : '' });
              else if (raw === '') continue;
            }
            const expected = ops.filter((o) => o.type !== 'add');
            const lines = currentLines();

            // Pure insertion hunk (new file or append): no context to verify.
            if (expected.length === 0) {
              const at = Math.max(0, Math.min(hunk.oldStart > 0 ? hunk.oldStart - 1 : 0, lines.length));
              lines.splice(at, 0, ...ops.filter((o) => o.type === 'add').map((o) => o.text));
              updatedContent = lines.join('\n');
              changesApplied++;
              continue;
            }

            // Re-anchor: try the stated line first, then search outward. Pass 1
            // requires exact equality; pass 2 tolerates trailing-whitespace
            // drift (weak models miscount blank lines). Verifies BOTH context
            // and removal lines — stale patches must be rejected, not spliced.
            const baseIdx = Math.max(0, Math.min(hunk.oldStart - 1, lines.length - expected.length));
            const matchesAt = (cand: number, exact: boolean): boolean => {
              if (cand < 0 || cand + expected.length > lines.length) return false;
              for (let k = 0; k < expected.length; k++) {
                const a = lines[cand + k];
                const b = expected[k].text;
                if (exact ? a !== b : a.replace(/\s+$/, '') !== b.replace(/\s+$/, '')) return false;
              }
              return true;
            };
            // Already-applied probe: same anchor search but expecting the POST
            // state — context lines with del/add pairs collapsed to their add.
            const buildPostExpected = (): string[] => {
              const out: string[] = [];
              for (let i = 0; i < ops.length; i++) {
                const op = ops[i];
                if (op.type === 'ctx') out.push(op.text);
                else if (op.type === 'del') {
                  const nxt = ops[i + 1];
                  out.push(nxt && nxt.type === 'add' ? nxt.text : '');
                  if (nxt && nxt.type === 'add') i++;
                } else continue; // stray adds ignored for matching
              }
              return out.filter((t) => t !== undefined);
            };
            const matchesPostAt = (cand: number): boolean => {
              const want = buildPostExpected();
              if (cand < 0 || cand + want.length > lines.length) return false;
              for (let k = 0; k < want.length; k++) {
                if (lines[cand + k].replace(/\s+$/, '') !== want[k].replace(/\s+$/, '')) return false;
              }
              return true;
            };
            let anchor = -1;
            for (const exact of [true, false]) {
              for (let delta = 0; delta <= 50 && anchor === -1; delta++) {
                for (const cand of [baseIdx + delta, baseIdx - delta]) {
                  if (matchesAt(cand, exact)) { anchor = cand; break; }
                }
              }
              if (anchor !== -1) break;
            }

            if (anchor === -1) {
              // Idempotency: the hunk may already be in place (model re-patches
              // after an earlier successful call). Detect post-state and skip.
              let appliedAnchor = -1;
              for (let delta = 0; delta <= 50 && appliedAnchor === -1; delta++) {
                for (const cand of [baseIdx + delta, baseIdx - delta]) {
                  if (matchesPostAt(cand)) { appliedAnchor = cand; break; }
                }
              }
              if (appliedAnchor !== -1) {
                alreadyAppliedHunks++;
                continue;
              }

              contextMismatch = true;
              // Diagnostic: show where the model's first expected line actually lives.
              const first = (expected[0]?.text || '').trim();
              let hint = '';
              if (first) {
                const at = lines.findIndex((l) => l.trim() === first);
                if (at === -1) {
                  hint = ` The line "${first.slice(0, 50)}" does not exist in ${targetPath} at all.`;
                } else {
                  const from = Math.max(0, at - 3);
                  const window = lines.slice(from, at + 4).map((l, i) => `${from + i + 1}: ${l}`).join('\n');
                  hint = `\nClosest region containing "${first.slice(0, 40)}" is at line ${at + 1}:\n${window}\nRegenerate the patch with these EXACT lines and correct @@ numbers.`;
                }
              }
              mismatchDetail = `hunk @@ -${hunk.oldStart} could not be located (expected ${expected.length} line(s) starting "${(expected[0]?.text || '').slice(0, 60)}").${hint}`;
              break;
            }

            // Rebuild preserving op order: keep ctx, drop del, insert add inline.
            const rebuilt: string[] = [];
            let consumed = 0;
            for (const op of ops) {
              if (op.type === 'add') rebuilt.push(op.text);
              else { rebuilt.push(lines[anchor + consumed]); consumed++; }
            }
            lines.splice(anchor, expected.length, ...rebuilt);
            updatedContent = lines.join('\n');
            changesApplied++;
          }

          if (contextMismatch) {
            return {
              content: [{ type: 'text', text: `Error: Patch hunk did not match file content for ${targetPath}. ${mismatchDetail}\nRe-read the file (windowed around the target region) and regenerate the patch with exact current content.` }],
              isError: true,
            };
          }

          if (changesApplied === 0) {
            if (alreadyAppliedHunks > 0) {
              results.push(`No changes needed for ${targetPath}: all ${alreadyAppliedHunks} hunk(s) already applied. Treat the file as correct and do NOT patch it again.`);
              continue;
            }
            return {
              content: [{ type: 'text', text: `Error: Patch hunk did not match file content for ${targetPath}. The patch format may be incorrect or the file content doesn't match the expected context.` }],
              isError: true,
            };
          }

          await fs.mkdir(path.dirname(resolved), { recursive: true });
          await fs.writeFile(resolved, updatedContent, 'utf-8');
          await observeRead(context.sessionId, resolved);
          const crypto = await import('crypto');
          const newHash = crypto.createHash('md5').update(updatedContent).digest('hex').slice(0, 12);
          const verb = existingContent ? 'M' : 'A';
          applied.push(`${verb} ${targetPath}`);
          results.push(`${verb === 'A' ? 'Created' : 'Modified'}: ${targetPath} (HASH: ${newHash})`);
        } catch (err: any) {
          if (applied.length > 0) {
            return {
              content: [{
                type: 'text',
                text: `Patch partially applied before failing at ${targetPath}.\nApplied: ${applied.join(', ')}\nError: ${err.message}`,
              }],
              isError: true,
            };
          }
          return {
            content: [{ type: 'text', text: `Error applying patch to ${targetPath}: ${err.message}` }],
            isError: true,
          };
        }
      }

      if (applied.length === 0) {
        return {
          content: [{ type: 'text', text: 'Error: No valid file operations found in patch.' }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Patch applied successfully:\n${results.join('\n')}`,
        }],
      };
    },
  };
}

export function getDeleteFileTool(): ToolDefinition {
  return {
    name: 'delete_file',
    description: 'Delete a file or empty directory. The path must exist.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File or directory path to delete.',
        },
      },
      required: ['path'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
    },
    execute: async (
      input: Record<string, unknown>,
      context: ToolContext
    ): Promise<ToolResult> => {
      const filePath = String(input.path || '');
      if (!filePath) {
        return { content: [{ type: 'text', text: 'Error: path is required.' }], isError: true };
      }

      const resolved = path.resolve(context.workspaceDir, filePath);

      try {
        const stat = await fs.stat(resolved);
        const gate = await assertObserved(context.sessionId, resolved, filePath);
        if (gate) return gate;
        if (stat.isDirectory()) {
          const entries = await fs.readdir(resolved);
          if (entries.length > 0) {
            return {
              content: [{ type: 'text', text: `Error: Directory is not empty (${entries.length} entries). Remove contents first.` }],
              isError: true,
            };
          }
          await fs.rmdir(resolved);
        } else {
          await fs.unlink(resolved);
        }
        observedFiles.delete(observeKey(context.sessionId, resolved));
        return { content: [{ type: 'text', text: `Deleted: ${filePath}` }] };
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return { content: [{ type: 'text', text: `Error: File not found: ${filePath}` }], isError: true };
        }
        return { content: [{ type: 'text', text: `Error deleting ${filePath}: ${err.message}` }], isError: true };
      }
    },
  };
}

export function getListDirectoryTool(): ToolDefinition {
  return {
    name: 'list_directory',
    description:
      'List directory contents with file types. Returns sorted entries with / suffix for directories. ' +
      'Use offset/limit for large directories.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path to list. Default: workspace root.',
        },
        offset: {
          type: 'number',
          description: '1-based entry offset for pagination.',
          minimum: 1,
        },
        limit: {
          type: 'number',
          description: 'Max entries to return. Default: 2000.',
          minimum: 1,
          maximum: 2000,
        },
      },
      required: [],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
    },
    execute: async (
      input: Record<string, unknown>,
      context: ToolContext
    ): Promise<ToolResult> => {
      const dirPath = String(input.path || '.');
      const offset = Math.max(1, Number(input.offset) || 1);
      const limit = Math.min(2000, Math.max(1, Number(input.limit) || 2000));
      const resolved = path.resolve(context.workspaceDir, dirPath);

      try {
        const entries = await fs.readdir(resolved, { withFileTypes: true });
        const sorted = entries.sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });

        const page = sorted.slice(offset - 1, offset - 1 + limit);
        const lines = page.map((e, i) => {
          const idx = offset + i;
          return `${idx}: ${e.isDirectory() ? e.name + '/' : e.name}`;
        });

        if (lines.length === 0) {
          return { content: [{ type: 'text', text: '(empty directory)' }] };
        }

        const output = lines.join('\n');
        if (sorted.length > offset - 1 + limit) {
          return {
            content: [{
              type: 'text',
              text: output + `\n\n[Page ${offset}-${offset + page.length - 1} of ${sorted.length}. Use offset=${offset + limit} for more.]`,
            }],
          };
        }
        return { content: [{ type: 'text', text: output }] };
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return { content: [{ type: 'text', text: `Error: Directory not found: ${dirPath}` }], isError: true };
        }
        return { content: [{ type: 'text', text: `Error listing ${dirPath}: ${err.message}` }], isError: true };
      }
    },
  };
}
