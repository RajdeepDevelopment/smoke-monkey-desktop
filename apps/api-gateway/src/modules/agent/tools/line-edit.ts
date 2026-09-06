/**
 * Pure line-keyed file-edit logic.
 *
 * This module contains NO NestJS / tool-harness dependencies on purpose — it is
 * a single testable function that applies a set of 1-based line-number edits to
 * a file's text content. The tool wrapper (getLineEditTool in filesystem.tools.ts)
 * handles path resolution, the read-observation gate, and file I/O; this module
 * stays a pure string transform so edge cases can be unit-tested in isolation.
 *
 * Input format: `edits` is an object mapping 1-based line numbers to the code to
 * place at that line, e.g.
 *   { "23": "import { Search } from \"lucide-react\";", "34": "const users = [];" }
 *
 * Rules:
 *  - Multiple edits are applied from BOTTOM to TOP so line numbers always refer
 *    to the ORIGINAL file (editing the top first would shift the rest).
 *  - A line number pointing at an existing line REPLACES it.
 *  - A line number past the end CREATES the line, padding with blank lines.
 *  - An EMPTY code string deletes that line.
 *  - CRLF line endings are preserved; a trailing newline is preserved.
 */

export interface LineEditResult {
  ok: boolean;
  /** Final file content, or null when ok=false. */
  content: string | null;
  /** 1-based line numbers that were changed, ascending. */
  changedLines: number[];
  /** Human-readable issue when ok=false. */
  error?: string;
  /** Simple unified-ish diff of removed/added lines for tool feedback. */
  diff?: string[];
}

export interface NormalizeResult {
  eol: '\n' | '\r\n';
  hadTrailingNewline: boolean;
  /** All lines including any final empty trailing element. */
  lines: string[];
}

/** Detect line-ending convention and whether the text ends with a newline. */
export function normalizeText(text: string): NormalizeResult {
  const eol: '\n' | '\r\n' = text.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingNewline = text.endsWith('\n');
  // Split on any of \n, \r\n; keep the trailing '' element if the text ends
  // with a newline so we can reconstruct it exactly later.
  const lines = text.split(/\r\n|\n/);
  return { eol, hadTrailingNewline, lines };
}

/**
 * Parse and validate an `edits` map into ordered {line, code} entries.
 * Returns null on error (with a reason) so the caller can surface it cleanly.
 */
export function parseEdits(raw: unknown): { ok: true; edits: Array<{ line: number; code: string; key: string }> } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'edits must be an object mapping line numbers to code.' };
  }
  const seenLine = new Set<number>();
  const entries: Array<{ line: number; code: string; key: string }> = [];
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const trimmed = key.trim();
    if (!/^[+]?\d+$/.test(trimmed)) {
      return { ok: false, error: `Invalid line key "${key}" — must be a positive integer.` };
    }
    const line = Number(trimmed);
    if (!Number.isInteger(line) || line < 1) {
      return { ok: false, error: `Invalid line number "${key}" — must be >= 1.` };
    }
    if (seenLine.has(line)) {
      return { ok: false, error: `Duplicate line number ${line} in edits.` };
    }
    seenLine.add(line);
    entries.push({ line, code: typeof val === 'string' ? val : String(val ?? ''), key });
  }
  return { ok: true, edits: entries };
}

export function applyLineEdits(
  originalText: string,
  editsRaw: unknown,
): LineEditResult {
  const parsed = parseEdits(editsRaw);
  if ('error' in parsed) return { ok: false, content: null, changedLines: [], error: parsed.error };
  const editEntries = parsed.edits;

  const { eol, hadTrailingNewline, lines } = normalizeText(originalText);
  // Treat the trailing '' from a final newline as "not a real line" for editing.
  const hasTrailingEmpty = hadTrailingNewline && lines[lines.length - 1] === '';
  const working = hasTrailingEmpty ? lines.slice(0, -1) : lines.slice();

  // Apply bottom → top so indices stay stable relative to the original file.
  const ordered = [...editEntries].sort((a, b) => b.line - a.line);
  const changedLines: number[] = [];
  const diff: string[] = [];

  for (const edit of ordered) {
    const idx = edit.line - 1;
    if (idx < working.length) {
      // Empty code deletes the line entirely (splice removes the element so no
      // blank line is left behind). Non-empty replaces in place.
      if (edit.code === '') {
        const removed = working.splice(idx, 1)[0] ?? '';
        changedLines.push(edit.line);
        diff.push(`-${removed}`);
      } else {
        const removed = working[idx];
        working[idx] = edit.code;
        changedLines.push(edit.line);
        for (const r of removed.split(/[\r\n]+/)) diff.push(`-${r}`);
        for (const a of edit.code.split(/[\r\n]+/)) diff.push(`+${a}`);
      }
    } else if (edit.code !== '') {
      // Past end → create, padding with blank lines up to line-1.
      while (working.length < idx) working.push('');
      working.push(edit.code);
      changedLines.push(edit.line);
      for (const a of edit.code.split(/[\r\n]+/)) diff.push(`+${a}`);
    }
  }

  // Preserve the file's original trailing-newline convention exactly: copy the
  // original content's ending rather than always appending one.
  let content = working.join(eol);
  if (hadTrailingNewline) content += eol;

  changedLines.sort((a, b) => a - b);
  return { ok: true, content, changedLines, diff };
}
