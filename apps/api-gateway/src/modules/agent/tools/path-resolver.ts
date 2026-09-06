import * as fs from 'fs/promises';
import * as path from 'path';
import { SEARCH_EXCLUDE_DIRS } from '../workspace.service';

/**
 * Bounded path resolution for the agent file tools.
 *
 * The model often passes a path that is close but not exact (a wrong prefix,
 * a project it names by a different root, a file one directory up/down, or
 * just the bare filename). Rather than burning agent tool calls probing `../`,
 * `frontend/`, `src/`, `apps/`, etc. one at a time, this module runs ONE
 * internal `resolve_file_path` pass that turns a requested path into a
 * verified absolute path (or a ranked list of near-miss candidates for the
 * model to choose from).
 *
 * Strategy order (each stage short-circuits once a match is verified):
 *   1. Exact path (resolve from the workspace root).
 *   2. Parent levels — `./path`, `../path`, `../../path`, `../../../path`.
 *   3. Inside project directories — `src/path`, `frontend/path`, `apps/<app>/path`,
 *      `packages/<pkg>/path`, ... up to N layers deep, preserving the filename.
 *   4. Recursive exact-filename search (bounded breadth/depth).
 *   5. Case-insensitive / similar-filename search, returned as candidates for
 *      the model to verify instead of a bare "file not found".
 *
 * DEPTH GUARD: a match is only auto-accepted when it lies no more than a fixed
 * number of directory layers "inside" or "outside" of the requested path.
 * Anything deeper is reported back as candidates/suggestions so the model never
 * silently operates on a file it did not actually mean.
 */

/** Max parent-directory hops to traverse outside the requested path. */
const MAX_PARENT_LEVELS = 3;
/** Max directory layers to walk inward before giving up on the structured path. */
const MAX_INSIDE_DEPTH = 3;
/** Cap on the number of structured candidate paths generated (never blind). */
const MAX_CANDIDATE_PATHS = 200;
/** Cap on similar-filename results returned to the model. */
const MAX_SIMILAR_RESULTS = 10;
/** Max depth for the recursive filename scan (avoids dependency trees). */
const MAX_RECURSE_DEPTH = 8;

export interface ResolveResult {
  /** Absolute verified path when an exact/layered match was auto-accepted. */
  resolved?: string;
  /** Absolute-path near-misses found by filename search (need model choice). */
  candidates: string[];
  /** Whether candidates came from a fuzzy (vs exact) filename match. */
  fuzzy: boolean;
}

const EXCLUDE = new Set(SEARCH_EXCLUDE_DIRS);

/** Directory names that typically nest projects/apps under the workspace root. */
const CONTAINER_DIRS = [
  'src', 'app', 'apps', 'lib', 'services', 'server', 'client',
  'frontend', 'backend', 'packages', 'workspace',
];

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Depth (number of path segments) of a relative path. '' -> 0. */
function depthOf(rel: string): number {
  if (!rel || rel === '.') return 0;
  const clean = rel.replace(/^\.\/+/, '');
  return clean.split(/[\\/]+/).filter(Boolean).length;
}

/**
 * Recursively scan the workspace for files whose basename matches `fileName`.
 * Bounded by depth so it cannot wander into dependency/build trees.
 */
async function findFilesByName(
  root: string,
  fileName: string,
  limit: number,
  caseInsensitive = false,
  similar = false,
): Promise<string[]> {
  const base = fileName.toLowerCase();
  const stem = path.basename(fileName).replace(/\.[^.]+$/, '').toLowerCase();
  const found: string[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (found.length >= limit || depth > MAX_RECURSE_DEPTH) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found.length >= limit) return;
      if (e.name === '.git' || EXCLUDE.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else if (e.isFile()) {
        if (similar) {
          const eStem = e.name.replace(/\.[^.]+$/, '').toLowerCase();
          if (
            stem.length >= 4 &&
            (eStem === stem || eStem.includes(stem) || (stem.includes(eStem) && eStem.length >= 4))
          ) {
            found.push(full);
          }
        } else if (caseInsensitive) {
          if (e.name.toLowerCase() === base) found.push(full);
        } else if (e.name === fileName) {
          found.push(full);
        }
      }
    }
  };

  await walk(root, 0);
  return found.slice(0, limit);
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

/**
 * Generate a bounded set of structured candidate paths. Re-anchors the
 * requested relative path's leading container segment(s) onto likely project
 * directories one or two levels deep (never blind — every candidate preserves
 * the filename so search semantics stay exact). Produces shapes like:
 *   <wellKnown>/<full-rel>
 *   <child-dir>/<full-rel>
 *   <child-dir>/<sub>/<full-rel>              (apps/web/frontend/x.js)
 *   <child-dir>/<first-seg>/<rest>            (apps/frontend/x.js)
 *   <child-dir>/<sub>/<first-seg>/<rest>      (apps/web/frontend/x.js)
 */
async function insideCandidates(
  workspaceDir: string,
  childDirs: string[],
  rel: string,
): Promise<string[]> {
  const candidates: string[] = [];
  const clean = rel.replace(/^\.\/+/, '').replace(/^\.\.(?:\/|$)/, '');
  if (!clean || clean === '.') return candidates;

  const segments = clean.split('/').filter(Boolean);
  const fileName = segments[segments.length - 1];
  const firstSeg = segments[0];
  const restAfterFirst = segments.slice(1);
  const parentSegs = segments.slice(0, -1);

  const pull = (p: string) => {
    if (candidates.length < MAX_CANDIDATE_PATHS) candidates.push(p);
  };

  // Well-known container names: <container>/<full-rel> and <container>/<parent...>/<file>.
  for (const c of CONTAINER_DIRS) {
    pull(path.join(workspaceDir, c, clean));
    if (parentSegs.length > 0 && parentSegs.length <= MAX_INSIDE_DEPTH) {
      pull(path.join(workspaceDir, c, ...parentSegs, fileName));
    }
  }

  // Real root children: <child>/<full-rel> and <child>/<first-seg>/<rest>.
  for (const c of childDirs) {
    pull(path.join(workspaceDir, c, clean));
    if (firstSeg) pull(path.join(workspaceDir, c, firstSeg, ...restAfterFirst));
  }

  // Containers with their own project children (models `apps/*/frontend/x.js`):
  // <child>/<sub>/<full-rel> and <child>/<sub>/<first-seg>/<rest>.
  for (const c of childDirs) {
    if (candidates.length >= MAX_CANDIDATE_PATHS) break;
    let subs: string[] = [];
    try {
      const entries = await fs.readdir(path.join(workspaceDir, c), { withFileTypes: true });
      subs = entries
        .filter((e) => e.isDirectory() && e.name !== '.git' && !EXCLUDE.has(e.name))
        .map((e) => e.name)
        .slice(0, 20);
    } catch { /* not a directory or unreadable */ }
    for (const s of subs) {
      if (candidates.length >= MAX_CANDIDATE_PATHS) break;
      pull(path.join(workspaceDir, c, s, clean));
      if (firstSeg) pull(path.join(workspaceDir, c, s, firstSeg, ...restAfterFirst));
    }
  }

  // Containment guard: never hand a candidate that escapes the workspace, even
  // when the requested path carried leading `../` segments past the strip.
  const contained = (p: string): boolean => {
    const rel = path.relative(workspaceDir, p);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  return dedupe(candidates).filter(contained);
}

/** A single exclusions-aware listing of the workspace root's child dirs. */
async function immediateChildDirs(workspaceDir: string): Promise<string[]> {
  const dirs: string[] = [];
  try {
    const entries = await fs.readdir(workspaceDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && e.name !== '.git' && !EXCLUDE.has(e.name)) dirs.push(e.name);
    }
  } catch { /* noop */ }
  return dirs;
}

/**
 * Main entry point. Resolves `requestedPath` (absolute or workspace-relative)
 * against `workspaceDir` into a verified absolute path or ranked candidates.
 *
 * `forCreate` (write/delete of a new target): a failed lookup falls back to the
 * exact requested path so create operations still work instead of being
 * redirected to a near-miss file.
 */
export async function resolveFilePath(
  workspaceDir: string,
  requestedPath: string,
  forCreate = false,
): Promise<ResolveResult> {
  const result: ResolveResult = { candidates: [], fuzzy: false };
  const trimmed = (requestedPath || '').trim();
  if (!trimmed) return result;

  const isAbsolute = path.isAbsolute(trimmed);

  const safeResolve = (p: string): string => {
    const abs = path.resolve(workspaceDir, p);
    const rel = path.relative(workspaceDir, abs);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return abs;
    return '';
  };

  // 1) Exact path.
  const exact = isAbsolute ? trimmed : safeResolve(trimmed);
  if (exact && await exists(exact)) {
    result.resolved = exact;
    return result;
  }

  // 2) Parent levels: ./path, ../path, ../../path, ... (bounded, cannot exit workspace).
  if (!isAbsolute) {
    for (let hops = 1; hops <= MAX_PARENT_LEVELS; hops++) {
      const up = '../'.repeat(hops) + trimmed;
      const candidate = safeResolve(up);
      if (candidate && await exists(candidate)) {
        result.resolved = candidate;
        return result;
      }
    }
  }

  // 3) Inside project directories (bounded, preserving the filename).
  const relative = isAbsolute ? path.relative(workspaceDir, trimmed) : trimmed;
  const childDirs = await immediateChildDirs(workspaceDir);
  for (const cand of await insideCandidates(workspaceDir, childDirs, relative)) {
    if (await exists(cand)) {
      result.resolved = cand;
      return result;
    }
  }

  // Create operation with no existing target: fall back to the exact requested
  // path (NEW file goes exactly where asked) and skip the recursive scan —
  // there is nothing to find, and we must never silently redirect a create.
  if (forCreate && exact) {
    result.resolved = exact;
    return result;
  }

  // Structured paths exhausted. Only meaningful for a file lookup, not a create.
  const fileName = path.basename(trimmed);
  const requestedDepth = depthOf(isAbsolute ? path.relative(workspaceDir, trimmed) : trimmed);

  /** DEPTH GUARD: an exact-filename match is only auto-accepted when it lies
   * within MAX_PARENT_LEVELS layers inside (deeper) or outside (shallower) of
   * the requested path. Anything far away is returned as a candidate for the
   * model to verify instead of silently operating on the wrong file. */
  const acceptWithinDepth = (match: string): boolean => {
    const matchDepth = depthOf(path.relative(workspaceDir, match));
    return Math.abs(matchDepth - requestedDepth) <= MAX_PARENT_LEVELS;
  };

  if (fileName && !isAbsolute) {
    const exactFileName = path.basename(fileName);

    // 4) Recursive exact-filename search.
    const exactMatches = await findFilesByName(workspaceDir, exactFileName, MAX_SIMILAR_RESULTS + 1);
    const within = exactMatches.filter(acceptWithinDepth);
    if (within.length === 1) {
      result.resolved = within[0];
      return result;
    }
    if (exactMatches.length > 0) {
      result.candidates = (within.length > 0 ? within : exactMatches).slice(0, MAX_SIMILAR_RESULTS);
      result.fuzzy = false;
      return result;
    }

    // 5) Case-insensitive exact filename.
    const ciMatches = await findFilesByName(workspaceDir, exactFileName, MAX_SIMILAR_RESULTS, true);
    const ciWithin = ciMatches.filter(acceptWithinDepth);
    if (ciWithin.length === 1) {
      result.resolved = ciWithin[0];
      return result;
    }
    if (ciMatches.length > 0) {
      result.candidates = (ciWithin.length > 0 ? ciWithin : ciMatches).slice(0, MAX_SIMILAR_RESULTS);
      result.fuzzy = true;
      return result;
    }

    // 6) Similar-filename candidates for the model to verify.
    const similar = await findFilesByName(workspaceDir, exactFileName, MAX_SIMILAR_RESULTS, true, true);
    const similarWithin = similar.filter(acceptWithinDepth);
    if (similarWithin.length > 0) {
      result.candidates = similarWithin.slice(0, MAX_SIMILAR_RESULTS);
      result.fuzzy = true;
    }
  }

  return result;
}

/**
 * Format a resolution outcome into the "File not found" tool fragment. When
 * candidates were found outside the allowed depth, they are surfaced as
 * suggested paths so the model re-issues the tool against the intended file.
 */
export function formatResolutionError(
  requestedPath: string,
  res: ResolveResult,
  purpose: string,
): string {
  if (res.candidates.length > 0) {
    const verb = res.fuzzy ? 'similar to' : 'named';
    return (
      `File not found: ${requestedPath}. I could not auto-resolve it, but I found these files ${verb} ` +
      `it — they are outside the allowed in/out search depth, so re-issue this tool with the intended path:\n` +
      res.candidates.map((c) => `  ${c}`).join('\n')
    );
  }
  return (
    `File not found: ${requestedPath}. I searched up to 3 levels up (../) and inside the workspace project ` +
    `directories (src/, frontend/, apps/*/, packages/*/), then by exact filename, but found nothing. ` +
    `${purpose} To locate it, list the workspace (inspect / list_directory) or run a glob (e.g. "**/${path.basename(requestedPath)}").`
  );
}
