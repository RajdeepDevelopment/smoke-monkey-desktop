import {
  ToolDefinition,
  ToolResult,
  ToolContext,
  ToolAnnotations,
} from './tool-registry';
import * as fs from 'fs/promises';
import * as path from 'path';
import { FileReadCache } from '../services/file-read-cache';
import { applyLineEdits } from './line-edit';
import { resolveFilePath, formatResolutionError } from './path-resolver';

const MAX_READ_BYTES = 50 * 1024;
const MAX_READ_LINES = 800;
const DEFAULT_READ_WINDOW = 400;
const MAX_LINE_LENGTH = 2000;

/** Shared file read cache — avoids re-reading unchanged files across tool calls. */
const fileReadCache = new FileReadCache();

/**
 * Resolution wrapper for the file tools. Every tool hands the requested path
 * (as the model gave it) through `resolveFilePath`, which searches exact /
 * parent / inside-project / recursive-filename in one bounded pass and returns
 * a VERIFIED absolute path. When nothing safe is found, it returns the
 * "File not found" fragment (with suggested candidates for corrective action)
 * that the tool surfaces isError to the model — so the model self-corrects on
 * the next call instead of spending turns probing `../`, `src/`, `apps/`, `packages/`.
 */
async function resolveToolPath(
  workspaceDir: string,
  requestedPath: string,
  opts: { forCreate?: boolean; purpose: string },
): Promise<{ ok: boolean; resolved?: string; error?: string }> {
  const res = await resolveFilePath(workspaceDir, requestedPath, opts.forCreate);
  if (res.resolved) {
    // Report a redirect so the model learns the true location even as the
    // tool succeeds against it.
    return { ok: true, resolved: res.resolved };
  }
  return { ok: false, error: formatResolutionError(requestedPath, res, opts.purpose) };
}

// Chunk size for streaming file writes. Big enough to keep WS/SSE chatter low,
// small enough that a multi-hundred-KB write produces a visible progress pulse.
const WRITE_STREAM_CHUNK = 16 * 1024;

/**
 * Emits a live `tool.progress` event for the currently-executing file tool
 * (no-op when the context has no emitter, e.g. headless/direct invocation).
 * `toolCallId` is merged by the emitter; callers pass everything else flat.
 */
function emitFileProgress(
  context: ToolContext,
  progress: {
    kind: string;
    path?: string;
    percent?: number;
    bytesWritten?: number;
    bytesTotal?: number;
    lines?: number;
    linesTotal?: number;
    preview?: string;
    detail?: string;
  },
): void {
  if (!context.eventEmitter || !context.toolCallId) return;
  context.eventEmitter.emitToolProgress(
    context.sessionId,
    context.runId,
    context.toolCallId,
    progress as unknown as Record<string, unknown>,
  );
}

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

/**
 * Observation policy (softened): the session used to be HARD-BLOCKED from
 * mutating a file it had not read ("call read_file first, then retry"). That
 * wasted turns on perfectly valid edits — the model often already knows the
 * content. Now the mutation still applies, but the tool output gains a note
 * the model can read. The stale-version check is a warning too: the current
 * on-disk content is edited as-is, not whatever version the model saw.
 */
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

/** Returns '' when the file is safe to mutate, or a note the caller should
 * append to its success output (never an error). */
async function observedWarning(
  sessionId: string,
  resolved: string,
  displayPath: string,
): Promise<string> {
  const seen = observedFiles.get(observeKey(sessionId, resolved));
  if (seen === undefined) {
    return `(note: ${displayPath} had not been read this session — the edit was applied directly to the existing file content. Read the file to verify the result if it was out-of-date.)`;
  }
  const now = await currentFingerprint(resolved);
  if (now !== null && now !== seen) {
    observedFiles.delete(observeKey(sessionId, resolved));
    return `(note: ${displayPath} changed since it was last read this session — the edit was applied against the current on-disk content, not the stale version. Re-read if the result is unexpected.)`;
  }
  return '';
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
      'Reading a file before editing it is recommended — an edit on an unread file still applies, ' +
      'but the tool output notes that the content was not verified first.',
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

      const resolvedResult = await resolveToolPath(context.workspaceDir, filePath, {
        purpose: 'Re-check the path or use glob/inspect to find the real file.',
      });
      if (!resolvedResult.ok) {
        return { content: [{ type: 'text', text: resolvedResult.error }], isError: true };
      }
      const resolved = resolvedResult.resolved;

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

      const resolvedResult = await resolveToolPath(context.workspaceDir, filePath, {
        forCreate: true,
        purpose: 'Write a new file at the requested location, or fix the path to an existing file.',
      });
      if (!resolvedResult.ok) {
        return { content: [{ type: 'text', text: resolvedResult.error }], isError: true };
      }
      const resolved = resolvedResult.resolved;

      try {
        let existed = false;
        try {
          await fs.access(resolved);
          existed = true;
        } catch {}

        // Overwriting an existing file without having read it used to be blocked.
        // Now the write just applies and surfaces a note to the model.
        let observedNote = '';
        if (existed) {
          observedNote = await observedWarning(context.sessionId, resolved, filePath);
        }

        await fs.mkdir(path.dirname(resolved), { recursive: true });

        const contentBuffer = Buffer.from(content, 'utf-8');
        const contentBytes = contentBuffer.length;
        const totalLines = content === '' ? 0 : content.split('\n').length;

        // Stream the write chunk-by-chunk, emitting live progress so the UI
        // shows the file actually being written while this tool is still
        // running (a 2000-line file should not be silent for a minute).
        // NOTE: all offsets here are BYTES over a Buffer. The old code mixed a
        // byte cursor with string (.slice() = UTF-16 code units) indexing,
        // which made multi-byte content (e.g. box-drawing chars in generated
        // docs) slice an empty chunk once byteOffset > string.length — the
        // "write made no progress" failure.
        emitFileProgress(context, {
          kind: 'write',
          path: resolved,
          percent: 0,
          bytesWritten: 0,
          bytesTotal: contentBytes,
          lines: 0,
          linesTotal: totalLines,
          detail: existed ? `Updating ${filePath}` : `Creating ${filePath}`,
        });

        const handle = await fs.open(resolved, existed ? 'r+' : 'w');
        try {
          if (existed) {
            // r+ truncates only on demand — wipe old content so a shorter
            // payload cannot leave stale trailing bytes.
            await handle.truncate(0);
          }
          let written = 0;
          let linesWritten = 0;
          while (written < contentBytes) {
            if (context.abortSignal?.aborted) {
              throw Object.assign(new Error('write aborted by user'), { code: 'EABORT' });
            }
            const chunk = contentBuffer.subarray(written, written + WRITE_STREAM_CHUNK);
            const { bytesWritten: n } = await handle.write(chunk, 0, chunk.length, written);
            if (n === 0) throw new Error('write made no progress');
            written += n;
            // Incremental newline count (the chunk decoded is exact — it was
            // sliced on a byte boundary of a finished Buffer).
            linesWritten += (chunk.toString('utf-8').match(/\n/g) || []).length;
            // Preview = the last chunk written (bounded) so the UI streams the
            // code as it lands on disk without replaying the whole file.
            const preview = chunk.toString('utf-8').slice(-1200);
            emitFileProgress(context, {
              kind: 'write',
              path: resolved,
              percent: Math.min(100, Math.round((written / contentBytes) * 100)),
              bytesWritten: written,
              bytesTotal: contentBytes,
              lines: linesWritten,
              linesTotal: totalLines,
              preview,
            });
            // Yield to the event loop so progress events flush promptly
            // instead of batching under a burst of synchronous fs writes.
            await new Promise((r) => setImmediate(r));
          }
        } finally {
          await handle.close();
        }

        emitFileProgress(context, {
          kind: 'write',
          path: resolved,
          percent: 100,
          bytesWritten: contentBytes,
          bytesTotal: contentBytes,
          lines: totalLines,
          linesTotal: totalLines,
          preview: '',
        });
        await observeRead(context.sessionId, resolved);

        const crypto = await import('crypto');
        const fileHash = crypto.createHash('md5').update(content).digest('hex').slice(0, 12);
        const lineCount = content.split('\n').length;
        const verb = existed ? 'Updated' : 'Created';
        return {
          content: [{
            type: 'text',
            text: `${verb} file successfully: ${filePath}\nHASH: ${fileHash}\nLines: ${lineCount}\nBytes: ${Buffer.byteLength(content, 'utf-8')}${observedNote ? '\n\n' + observedNote : ''}`,
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

      const resolvedResult = await resolveToolPath(context.workspaceDir, filePath, {
        purpose: 'Use write_file to create it if the file is new.',
      });
      if (!resolvedResult.ok) {
        return { content: [{ type: 'text', text: resolvedResult.error }], isError: true };
      }
      const resolved = resolvedResult.resolved;

      const observedNote = await observedWarning(context.sessionId, resolved, filePath);

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
              text: `Edited file successfully: ${filePath}\nHASH: ${newHash}\nReplacements: ${count}\n\`\`\`diff\n${diffLines}\n\`\`\`${observedNote ? '\n\n' + observedNote : ''}`,
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
          // Not a wall — a tripwire. Hard-failing here made models retry into
          // the same "provide more context" loop. Instead edit the FIRST
          // occurrence and surface the ambiguity (count + line numbers) in the
          // output so the model can react. replaceAll still covers every match.
          const firstLine = content.substring(0, pendingIdx[0]).split('\n').length;
          const matchLines = pendingIdx.map((at) => content.substring(0, at).split('\n').length).slice(0, 24).join(', ');
          const updated = content.substring(0, pendingIdx[0]) + normalizedNew + content.substring(pendingIdx[0] + normalizedOld.length);
          const note = `(note: oldString matched ${pendingIdx.length} places in ${filePath} (lines ${matchLines}${pendingIdx.length > 24 ? ', …' : ''}) — the FIRST match (line ${firstLine}) was edited. Verify the result; if you wanted all, use replaceAll.)`;
          await fs.writeFile(resolved, updated, 'utf-8');
          await observeRead(context.sessionId, resolved);
          const multiCrypto = await import('crypto');
          const multiNewHash = multiCrypto.createHash('md5').update(updated).digest('hex').slice(0, 12);
          const oldLines2 = oldString.split('\n');
          const newLines2 = newString.split('\n');
          const multiDiff = [
            ...oldLines2.map((l) => '-' + l),
            ...newLines2.map((l) => '+' + l),
          ].join('\n');
          return {
            content: [{
              type: 'text',
              text: `Edited file successfully: ${filePath}\nHASH: ${multiNewHash}\nReplacements: 1 of ${pendingIdx.length}\n\`\`\`diff\n${multiDiff}\n\`\`\`\n\n${note}${observedNote ? '\n\n' + observedNote : ''}`,
            }],
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
            text: `Edited file successfully: ${filePath}\nHASH: ${newHash}\nReplacements: 1\n\`\`\`diff\n${diffLines}\n\`\`\`${observedNote ? '\n\n' + observedNote : ''}`,
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

/**
 * Line-keyed edit tool. `edits` is a plain object mapping 1-based line numbers
 * (straight from read_file output) to replacement code, e.g.
 *   { "23": "const users = [];", "34": "..." }
 * Multiple disjoint edits happen in ONE call (token-efficient like
 * replace_lines). Edits apply bottom-to-top so line numbers always refer to the
 * original file. A line number past the file end creates that line; an empty
 * string deletes the line. The file must have been read this session first.
 */
export function getLineEditTool(): ToolDefinition {
  return {
    name: 'line_edit',
    description:
      'A REGISTERED FUNCTION TOOL you call directly (NOT a shell command — do NOT try to run ' +
      '"line_edit" via run_command/terminal; it is not an executable). Apply multiple line-keyed ' +
      'edits to a file in a single call. Pass args { "path": "...", "edits": { "<1-based line " + ' +
      'number>": "<exact raw code to place at that line>" } }, e.g. edits { "23": "const users = [];" }. ' +
      'The edit values must be the PLAIN code text exactly as it should appear on disk (keep your own ' +
      'indentation). Do NOT wrap them in JSON, do NOT add commas, trailing semicolons, braces, or ' +
      'other punctuation — pass the bare line content. A line that exists is replaced, a line past the ' +
      'end is created (blank lines are padded), and an empty string deletes a line. All edits apply ' +
      'bottom-to-top so line numbers always refer to the ORIGINAL file. Use it for targeted changes ' +
      'across a file in one shot; use replace_lines for removing a contiguous block. The file must have ' +
      'been read this session before you can edit it.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path to edit. Relative paths resolve from the workspace root.',
        },
        edits: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'Object mapping 1-based line numbers to replacement code. Numeric keys as strings, ' +
            'e.g. {"23":"const users = [];"}. Each value is the BARE line content exactly as it ' +
            'should appear on disk — no JSON formatting, no extra braces/commas. Empty string ' +
            'deletes that line.',
        },
      },
      required: ['path', 'edits'],
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
      if (!filePath) {
        return { content: [{ type: 'text', text: 'Error: path is required.' }], isError: true };
      }
      const editsObj = input.edits;
      if (!editsObj || typeof editsObj !== 'object' || Array.isArray(editsObj)) {
        return { content: [{ type: 'text', text: 'Error: edits must be an object mapping line numbers to code.' }], isError: true };
      }

      const resolvedResult = await resolveToolPath(context.workspaceDir, filePath, {
        purpose: 'Use write_file to create it if the file is new.',
      });
      if (!resolvedResult.ok) {
        return { content: [{ type: 'text', text: resolvedResult.error }], isError: true };
      }
      const resolved = resolvedResult.resolved;

      const observedNote = await observedWarning(context.sessionId, resolved, filePath);

      try {
        const original = await fs.readFile(resolved, 'utf-8');
        const result = applyLineEdits(original, editsObj);
        if (!result.ok || result.content == null) {
          return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
        }

        await fs.writeFile(resolved, result.content, 'utf-8');
        await observeRead(context.sessionId, resolved);

        const crypto = await import('crypto');
        const newHash = crypto.createHash('md5').update(result.content).digest('hex').slice(0, 12);
        const lines = result.changedLines.join(', ');
        const diffText = (result.diff || []).join('\n');

        return {
          content: [{
            type: 'text',
            text: `Edited ${filePath} (lines ${lines})\nHASH: ${newHash}\n\`\`\`diff\n${diffText}\n\`\`\`${observedNote ? '\n\n' + observedNote : ''}`,
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

export function getReplaceLinesTool(): ToolDefinition {
  return {
    name: 'replace_lines',
    description:
      'Replace a contiguous line range in a file with new content, using 1-based line numbers ' +
      'straight from read_file output. FASTER and far more token-efficient than edit_file: you do ' +
      'NOT need to reproduce the exact old text — just say which lines to remove (' +
      'startLine..endLine, inclusive) and what to put in their place. Everything outside the range ' +
      'is left untouched. Use startLine=endLine to replace a single line; pass an empty replacement ' +
      'to delete the range. Reading the file first is recommended — an unread replace still applies ' +
      'but flags a note in the output.',
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

      const resolvedResult = await resolveToolPath(context.workspaceDir, filePath, {
        purpose: 'Use write_file to create it if the file is new.',
      });
      if (!resolvedResult.ok) {
        return { content: [{ type: 'text', text: resolvedResult.error }], isError: true };
      }
      const resolved = resolvedResult.resolved;

      const observedNote = await observedWarning(context.sessionId, resolved, filePath);

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
            text: `Replaced lines ${startLine}-${Math.min(endLine, totalLines)} in ${filePath}\nHASH: ${newHash}\n\`\`\`diff\n${diffLines}\n\`\`\`${observedNote ? '\n\n' + observedNote : ''}`,
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

/**
 * Converts Claude-style "edit block" patches into standard unified diff format.
 * Some models (e.g. Claude-derived agents) emit prays like:
 *
 *   *** Begin Patch
 *   *** Update File: src/a.scss
 *   @@
 *   const ctx = "..."
 *   -    background: rgba(...)
 *   +    background: color-mix(...)
 *   @@
 *   *** End Patch
 *
 * The hunks here use `@@` bounds WITHOUT line-number headers (meaning "match
 * this context + change anywhere"), which is incompatible with the tool's
 * unified-diff parser. This converter rewrites each such block into:
 *
 *   --- a/path
 *   +++ b/path
 *   @@ -0,0 +0,0 @@
 *   context lines...
 *   -old
 *   +new
 *
 * using oldStart=0 so the existing fuzzy re-anchor logic locates the hunk by
 * context, exactly like a self-contained context-only patch. Paths pointing at
 * /dev/null are treated as create/delete as in the unified format. Returns the
 * input unchanged when it is not an edit-block patch.
 */
export function normalizeEditBlockPatch(raw: string): string {
  // Convert Claude-style edit blocks (`*** Begin Patch` / `*** Update File:` /
  // `*** Create File:` / `*** Delete File:` with `@@` hunk separators) into
  // standard unified diff. Handle the wrapper when present AND bare `*** ...`
  // file blocks (some models omit the Begin/End wrapper).
  if (!/\*\*\* Begin Patch/.test(raw) && !/^\s*\*\*\* (?:Update|Create|Delete) File:/m.test(raw)) {
    return raw;
  }

  const lines = raw.split('\n');
  const sections: Array<{ path: string; action: 'update' | 'create' | 'delete'; hunks: string[][] }> = [];
  let current: { path: string; action: 'update' | 'create' | 'delete'; hunks: string[][] } | null = null;
  let currentHunk: string[] | null = null;

  // Close the in-progress hunk (if any) and register it on the current file.
  const flushHunk = (): void => {
    if (currentHunk) {
      if (current && currentHunk.length > 0) current.hunks.push(currentHunk);
      currentHunk = null;
    }
  };

  const startSection = (path: string, action: 'update' | 'create' | 'delete'): void => {
    flushHunk();
    current = { path: path.trim(), action, hunks: [] };
    sections.push(current);
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\*\*\* (Begin|End) Patch/.test(trimmed)) {
      flushHunk();
      continue;
    }
    const updateMatch = trimmed.match(/^\*\*\* (Update|Create|Delete) File:\s+(.+)$/i);
    if (updateMatch) {
      startSection(updateMatch[2], (updateMatch[1].toLowerCase() as 'update' | 'create' | 'delete'));
      continue;
    }
    if (trimmed === '@@' || /^@@$/.test(trimmed)) {
      // `@@` opens AND closes a hunk: close any in-progress one, then mark that
      // a new hunk begins. Content accumulates until the next `@@`.
      flushHunk();
      currentHunk = [];
      continue;
    }
    if (currentHunk) currentHunk.push(line);
  }
  flushHunk();

  if (sections.length === 0) return raw;

  const out: string[] = [];
  for (const sec of sections) {
    if (!sec.path) {
      // Orphan hunk without a file header — keep it downstream WITHOUT dropping
      // it; join the hunks so they still get a chance (path resolution later).
      for (const h of sec.hunks) out.push(h.join('\n'));
      continue;
    }
    if (sec.action === 'delete') {
      out.push(`--- a/${sec.path}`);
      out.push('+++ /dev/null');
      for (const hunk of sec.hunks) {
        out.push('@@ -0,0 +0,0 @@');
        const body = hunk.join('\n').trimEnd();
        if (body) out.push(body);
      }
      continue;
    }
    if (sec.action === 'create') {
      out.push('--- /dev/null');
      out.push(`+++ b/${sec.path}`);
      for (const hunk of sec.hunks) {
        out.push('@@ -0,0 +0,0 @@');
        const body = hunk.join('\n').trimEnd();
        if (body) out.push(body);
      }
      continue;
    }
    // update
    out.push(`--- a/${sec.path}`);
    out.push(`+++ b/${sec.path}`);
    for (const hunk of sec.hunks) {
      out.push('@@ -0,0 +0,0 @@');
      const body = hunk.join('\n').trimEnd();
      if (body) out.push(body);
    }
  }
  return out.join('\n');
}

export function getApplyPatchTool(): ToolDefinition {
  return {
    name: 'apply_patch',
    description:
      'Apply a unified diff patch to modify one or more files. Supports add (+), delete (-), and modify operations. ' +
      'Also accepts Claude-style edit-block patches (*** Update File: ... / @@ ... @@). ' +
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

      // Some models emit Claude-style edit blocks (`*** Update File:` / `@@`).
      // Normalize them into standard unified diff before parsing so the rest of
      // this tool (hunk anchoring/verification) works unchanged for both forms.
      patchText = normalizeEditBlockPatch(patchText);

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
      const observedNotes: string[] = [];

      for (const chunk of fileChunks) {
        const targetPath = chunk.targetPath;
        const isDelete = chunk.isDelete;

        if (!targetPath || targetPath === '/dev/null') continue;

        // Resolve the patch target through the same bounded resolver the other
        // file tools use (patch targets may be mis-anchored too). Patches can
        // also CREATE brand-new files, so forCreate=true: a not-yet-existing
        // target falls back to its exact path instead of a filename scan.
        const resolvedResult = await resolveToolPath(context.workspaceDir, targetPath, {
          forCreate: true,
          purpose: 'Creating it here, or correcting the path to the real file.',
        });
        const resolved = resolvedResult.ok ? resolvedResult.resolved : path.resolve(context.workspaceDir, targetPath);

        // Observation policy: patching/deleting requires the session to have
        // read the target (unless the file is brand-new for an addition).
        let fileExists = true;
        try {
          await fs.access(resolved);
        } catch {
          fileExists = false;
        }
        if (fileExists) {
          const warn = await observedWarning(context.sessionId, resolved, targetPath);
          if (warn) observedNotes.push(warn);
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
          const patchedLines = updatedContent.split('\n').length;
          emitFileProgress(context, {
            kind: 'apply',
            path: resolved,
            percent: Math.min(100, Math.round(((fileChunks.indexOf(chunk) + 1) / fileChunks.length) * 100)),
            lines: patchedLines,
            linesTotal: patchedLines,
            detail: `Applying ${changesApplied} change(s) to ${targetPath}`,
          });
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
          text: `Patch applied successfully:\n${results.join('\n')}${observedNotes.length ? '\n\n' + observedNotes.join('\n') : ''}`,
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

      const resolvedResult = await resolveToolPath(context.workspaceDir, filePath, {
        purpose: 'Deletion needs the exact path — check it before retrying.',
      });
      if (!resolvedResult.ok) {
        return { content: [{ type: 'text', text: resolvedResult.error }], isError: true };
      }
      const resolved = resolvedResult.resolved;

      try {
        const stat = await fs.stat(resolved);
        const deleteNote = await observedWarning(context.sessionId, resolved, filePath);
        emitFileProgress(context, {
          kind: 'delete',
          path: resolved,
          percent: 50,
          detail: `Deleting ${filePath}`,
        });
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
        return { content: [{ type: 'text', text: `Deleted: ${filePath}${deleteNote ? '\n\n' + deleteNote : ''}` }] };
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

      const resolvedResult = await resolveToolPath(context.workspaceDir, dirPath, {
        purpose: 'Re-check the directory path.',
      });
      if (!resolvedResult.ok) {
        return { content: [{ type: 'text', text: resolvedResult.error }], isError: true };
      }
      const resolved = resolvedResult.resolved;

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

const MAX_INSPECT_PATHS = 12;
const INSPECT_LIST_LIMIT = 30;
const INSPECT_READ_LINES = 50;

/**
 * `inspect` — read MANY files / list MANY directories in ONE tool call.
 *
 * The whole point is parallelism as a first-class primitive: instead of
 * forcing the model to emit N read_file/list_directory calls across N turns,
 * it lists/reads a batch of paths all at once (executed concurrently
 * server-side) and gets every result back in a single response. This removes
 * the per-turn round-trip latency AND — critically for small/local models that
 * stall on long multi-turn tool histories — collapses N+1 LLM turns into one.
 */
export function getInspectTool(): ToolDefinition {
  return {
    name: 'inspect',
    description:
      'Read multiple files and list multiple directories in ONE call, executed in parallel. ' +
      'Pass up to 12 absolute-or-workspace-relative paths. Directories are listed (first 30 entries each), ' +
      'files are read (first 50 lines each) with a per-file header. ' +
      'BEST TOOL for exploration: when you need to see a directory tree AND the contents of its key files, ' +
      'pass all the paths together instead of doing one read_file/list_directory per turn — this is dramatically faster. ' +
      'Use read_file for deep/line-targeted reads, grep/glob for searching, and this tool for bulk orientation.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Paths to inspect. Each may be a directory (listed) or a file (read, first 50 lines). Max 12.',
          maxItems: MAX_INSPECT_PATHS,
          minItems: 1,
        },
      },
      required: ['paths'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
    },
    execute: async (
      input: Record<string, unknown>,
      context: ToolContext
    ): Promise<ToolResult> => {
      const rawPaths = Array.isArray(input.paths) ? input.paths.map((p) => String(p).trim()).filter(Boolean) : [];
      if (rawPaths.length === 0) {
        return { content: [{ type: 'text', text: 'Error: paths must be a non-empty array of strings.' }], isError: true };
      }
      if (rawPaths.length > MAX_INSPECT_PATHS) {
        return {
          content: [{ type: 'text', text: `Error: inspect accepts at most ${MAX_INSPECT_PATHS} paths at once (got ${rawPaths.length}). Split into batches.` }],
          isError: true,
        };
      }

      const results = await Promise.all(rawPaths.map(async (relPath) => {
        const pathResult = await resolveToolPath(context.workspaceDir, relPath, {
          purpose: 'Re-check the path or use glob to find the real file.',
        });
        if (!pathResult.ok) {
          return `== MISSING: ${relPath} ==\n${pathResult.error}`;
        }
        const resolved = pathResult.resolved;
        try {
          const stat = await fs.stat(resolved);
          if (stat.isDirectory()) {
            const entries = await fs.readdir(resolved, { withFileTypes: true });
            const sorted = entries.sort((a, b) => {
              if (a.isDirectory() && !b.isDirectory()) return -1;
              if (!a.isDirectory() && b.isDirectory()) return 1;
              return a.name.localeCompare(b.name);
            });
            const page = sorted.slice(0, INSPECT_LIST_LIMIT);
            const lines = page.map((e) => `${e.isDirectory() ? e.name + '/' : e.name}`);
            const truncated = sorted.length > page.length;
            const body = lines.length === 0
              ? '(empty directory)'
              : lines.join('\n') + (truncated ? `\n[... ${sorted.length - page.length} more entries — use list_directory to page]` : '');
            return `== DIR: ${relPath} ==\n${body}`;
          }

          const ext = path.extname(resolved).toLowerCase();
          if (BINARY_EXTENSIONS.has(ext) || isImageFile(resolved)) {
            return `== FILE: ${relPath} ==\n[binary/image — use read_file to view]`;
          }

          const cached = await fileReadCache.read(resolved);
          let content: string;
          if (cached) {
            content = cached.content;
          } else {
            const buf = await fs.readFile(resolved);
            if (isBinaryFile(buf)) {
              return `== FILE: ${relPath} ==\n[binary file — use read_file to view]`;
            }
            content = buf.toString('utf-8');
          }
          await observeRead(context.sessionId, resolved);
          const lines = content.split('\n');
          const page = lines.slice(0, INSPECT_READ_LINES);
          const truncated = lines.length > page.length;
          const body = page.join('\n') + (truncated ? `\n[... ${lines.length - page.length} more lines — use read_file startLine/endLine to continue]` : '');
          return `== FILE: ${relPath} ==\n${body}`;
        } catch (err: any) {
          if (err.code === 'ENOENT') return `== MISSING: ${relPath} ==\n(not found)`;
          return `== ERROR: ${relPath} ==\n${err.message || String(err)}`;
        }
      }));

      return { content: [{ type: 'text', text: results.join('\n\n') }] };
    },
  };
}
