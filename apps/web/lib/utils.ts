import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Lightweight number formatter used across metric surfaces. */
export function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

/** Compact formatter: 1284 → "1.28K", 1250000 → "1.25M". */
export function formatCompact(value: number): string {
  if (value < 1000) return value.toLocaleString('en-US');
  const units = ['K', 'M', 'B'];
  let scaled = value;
  let unit = '';
  for (const u of units) {
    scaled /= 1000;
    unit = u;
    if (Math.abs(scaled) < 1000) break;
  }
  const formatted = scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1);
  return `${formatted}${unit}`;
}

/** "2026-08-14T…" → "Aug 14" (same year) or "Aug 14, 2025" otherwise. */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  });
}

/** "2026-08-14T…" → "Aug 14, 2:41 PM" style. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    year: sameYear ? undefined : 'numeric',
  });
}

/** Relative time: "now", "5m ago", "3h ago", "2d ago", else a date. */
export function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return 'now';
  if (diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return formatDate(iso);
}

/** Human file size: 2412345 → "2.3 MB". */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/** File extension from a name: "report.pdf" → "PDF". */
export function fileExtension(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toUpperCase() : 'FILE';
}

/** Extract a domain from a URL: "https://www.openai.com/x" → "openai.com". */
export function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Simple ASCII word count. */
export function countWords(text: string): number {
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
}
