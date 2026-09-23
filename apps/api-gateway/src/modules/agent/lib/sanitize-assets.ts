/**
 * Guards against the agent announcing a file that does not actually exist.
 *
 * The frontend renders any wrapped <file-SM-st>/abs/path<file-sm-ed> as a
 * downloadable file card, so a hallucinated path looks like a real deliverable.
 * The model is instructed to only wrap files it ACTUALLY created, but when it
 * still reports a bogus path we verify it here before persisting the message:
 * a non-existent path's marker is replaced with an honest inline note instead
 * of a card the user could try to open/download in vain.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Logger } from '@nestjs/common';

const logger = new Logger('SanitizeAssets');

/** Same accept-anything marker grammar as the frontend FileCard. */
const FILE_MARKER_RE =
  /<(?:pdf|file)-sm-st\s*>([\s\S]*?)[\t ]*<\s*\/?\s*(?:pdf|file)-sm-ed\s*>/gi;

/**
 * Replace <file-SM-st> markers whose target does not exist on disk with a
 * textual warning. Relative paths are resolved against `baseDir` (the run's
 * project directory / workspace). Keeps existing markers untouched.
 */
export function sanitizeFileMarkers(content: string, baseDir?: string): string {
  if (!content || !content.includes('-sm-st')) return content;

  return content.replace(FILE_MARKER_RE, (_m, raw: unknown) => {
    const p = String(raw ?? '').trim();
    if (!p) return '';

    const resolved = path.isAbsolute(p) ? path.resolve(p) : path.resolve(baseDir || process.cwd(), p);
    try {
      const st = fs.statSync(resolved);
      if (st.isFile()) return _m; // real file — keep the card
    } catch {
      /* fall through → missing */
    }
    logger.warn(`Stripping <file-SM-st> marker for missing path: ${p}`);
    return `> ⚠ File not found at \`${p}\` — the reported path does not exist on disk.`;
  });
}