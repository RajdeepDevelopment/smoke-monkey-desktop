import * as React from 'react';

/**
 * Lightweight ANSI escape-sequence → styled spans renderer.
 * Handles SGR (color/bold/underline/dim/etc.) codes, including 256-color and
 * truecolor (24-bit) variants. Unknown/OSC sequences (e.g. cursor control)
 * are dropped so terminal tool output reads cleanly instead of leaking raw
 * escape bytes like `␛[32m`.
 */

const SGR_COLORS: Record<number, string> = {
  30: '#4b5a6b', 31: '#f87171', 32: '#7dcb7d', 33: '#e8b36b',
  34: '#82aaff', 35: '#c792ea', 36: '#5fbfaf', 37: '#d5dee9',
  90: '#6c7a8c', 91: '#ffa198', 92: '#a5e0a5', 93: '#f5ce8e',
  94: '#a3c4ff', 95: '#dfbbff', 96: '#8adfd1', 97: '#f8fafc',
};

const SGR_BG_COLORS: Record<number, string> = {
  40: '#2a333f', 41: '#6e2f2f', 42: '#2f4a2f', 43: '#5a4a2f',
  44: '#2f3d5a', 45: '#472f5a', 46: '#2f4a47', 47: '#4b5663',
  100: '#3a4350', 101: '#6e3a3a', 102: '#3a4a3a', 103: '#5a4a3a',
  104: '#3a475a', 105: '#4a3a5a', 106: '#3a4a47', 107: '#5a6472',
};

interface Chunk { text: string; style: React.CSSProperties }
interface Cursor { fg?: string; bg?: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean }

function applyCodes(cursor: Cursor, codes: number[]): Cursor {
  const next: Cursor = { ...cursor };
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === 0) { delete next.fg; delete next.bg; delete next.bold; delete next.dim; delete next.italic; delete next.underline; }
    else if (c === 1) next.bold = true;
    else if (c === 2) next.dim = true;
    else if (c === 3) next.italic = true;
    else if (c === 4) next.underline = true;
    else if (c === 22) { next.bold = false; next.dim = false; }
    else if (c === 23) next.italic = false;
    else if (c === 24) next.underline = false;
    else if (c >= 30 && c <= 37) next.fg = SGR_COLORS[c];
    else if (c === 39) delete next.fg;
    else if (c >= 40 && c <= 47) next.bg = SGR_BG_COLORS[c];
    else if (c === 49) delete next.bg;
    else if (c >= 90 && c <= 97) next.fg = SGR_COLORS[c];
    else if (c >= 100 && c <= 107) next.bg = SGR_BG_COLORS[c];
    else if (c === 38) {
      // foreground extended
      const kind = codes[i + 1];
      if (kind === 5 && codes[i + 2] !== undefined) { i += 2; const n = codes[i]; next.fg = ansi256(n); }
      else if (kind === 2 && codes[i + 3] !== undefined) { i += 4; next.fg = `rgb(${codes[i - 2]},${codes[i - 1]},${codes[i]})`; }
      else if (kind !== undefined && kind !== 5 && kind !== 2) i += 1;
    }
    else if (c === 48) {
      const kind = codes[i + 1];
      if (kind === 5 && codes[i + 2] !== undefined) { i += 2; const n = codes[i]; next.bg = ansi256(n); }
      else if (kind === 2 && codes[i + 3] !== undefined) { i += 4; next.bg = `rgb(${codes[i - 2]},${codes[i - 1]},${codes[i]})`; }
      else if (kind !== undefined && kind !== 5 && kind !== 2) i += 1;
    }
  }
  return next;
}

function ansi256(n: number): string {
  if (n < 16) {
    const basic = [30, 31, 32, 33, 34, 35, 36, 37, 90, 91, 92, 93, 94, 95, 96, 97];
    return SGR_COLORS[basic[n]] || '#d5dee9';
  }
  if (n < 232) {
    const n2 = n - 16;
    const r = Math.floor(n2 / 36), g = Math.floor((n2 % 36) / 6), b = n2 % 6;
    const conv = [0, 95, 135, 175, 215, 255];
    return `rgb(${conv[r]},${conv[g]},${conv[b]})`;
  }
  const gray = 8 + (n - 232) * 10;
  return `rgb(${gray},${gray},${gray})`;
}

function styleFromCursor(cursor: Cursor): React.CSSProperties {
  const s: React.CSSProperties = {};
  if (cursor.fg) s.color = cursor.fg;
  if (cursor.bg) s.backgroundColor = cursor.bg;
  if (cursor.bold) s.fontWeight = 600;
  if (cursor.dim) s.opacity = 0.65;
  if (cursor.italic) s.fontStyle = 'italic';
  if (cursor.underline) s.textDecoration = 'underline';
  return s;
}

// Matches full escape sequences: CSI (ESC [ ... final byte), and OSC/bell, etc.
// eslint-disable-next-line no-control-regex
const ESC_SEQ = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Z]|\x1b[@-_]|\x1b[>=]/g;

export function splitAnsi(text: string): Chunk[] {
  if (!text || !text.includes('\x1b')) return [{ text, style: {} }];
  const chunks: Chunk[] = [];
  let cursor: Cursor = {};
  let lastIndex = 0;

  ESC_SEQ.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ESC_SEQ.exec(text))) {
    const start = match.index;
    if (start > lastIndex) {
      chunks.push({ text: text.slice(lastIndex, start), style: styleFromCursor(cursor) });
    }
    lastIndex = start + match[0].length;

    const seq = match[0];
    if (seq.startsWith('\x1b[')) {
      const body = seq.slice(2, -1);
      const codes = body.split(';').map((s) => parseInt(s, 10)).filter((n) => !Number.isNaN(n));
      if (codes.length > 0) {
        cursor = applyCodes(cursor, codes);
      }
    }
  }

  if (lastIndex < text.length) {
    chunks.push({ text: text.slice(lastIndex), style: styleFromCursor(cursor) });
  }
  return chunks;
}

/** Render ANSI-colored text into styled spans. */
export function AnsiText({ text, className }: { text: string; className?: string }) {
  const chunks = splitAnsi(text);
  return (
    <span className={className}>
      {chunks.map((c, i) => (
        <span key={i} style={c.style}>{c.text}</span>
      ))}
    </span>
  );
}

/** Strip all ANSI escapes from a string, returning clean plain text. */
export function stripAnsi(text: string): string {
  if (!text || !text.includes('\x1b')) return text;
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Z]|\x1b[@-_]|\x1b[>=]/g, '');
}
