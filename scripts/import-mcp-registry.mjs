#!/usr/bin/env node
/**
 * import-mcp-registry.mjs — pull the official MCP registry and normalize
 * servers into candidate "stock" entries for `mcp-stock.ts`.
 *
 * The registry API (https://registry.modelcontextprotocol.io) exposes
 *   GET /v0.1/servers?limit=100&version=latest   (cursor-paginated)
 *
 * Each server is normalized into a flattened candidate object holding only
 * the fields the Smoke Monkey stock catalog cares about:
 *   - name            : stable slug (from the registry name/short name)
 *   - label           : pretty title
 *   - description     : short use-case line (curated later)
 *   - category        : guessed bucket (curated later)
 *   - transport       : 'stdio' | 'http'
 *   - command + args  : stdio launcher (npx / uvx / uv) from the published package
 *   - url             : remote endpoint when the server is streamable-HTTP
 *   - remote          : true for http remotes
 *   - package         : raw package identifier (registry name)
 *
 * Output: prints JSON lines to stdout (machine readable) and writes a
 *   `scripts/.mcp-registry-candidates.json` file for curation.
 *
 * Usage:
 *   node scripts/import-mcp-registry.mjs                 # full scrape
 *   node scripts/import-mcp-registry.mjs --limit 300     # cap the scrape
 */

const REGISTRY_BASE = 'https://registry.modelcontextprotocol.io';
const SAFE_NAME = /^[a-z0-9][a-z0-9-]*$/;

function pickPackage(packages = [], remotes = []) {
  const byid = (id) => String(id || '').toLowerCase();

  const npm = packages.find((p) => p && byid(p.registryType) === 'npm');
  if (npm?.identifier) {
    return {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', npm.identifier],
      remote: false,
    };
  }

  const pypi = packages.find((p) => p && (byid(p.registryType) === 'pypi' || byid(p.registryType) === 'python'));
  if (pypi?.identifier) {
    return {
      transport: 'stdio',
      command: 'uvx',
      args: [pypi.identifier.trim().toLowerCase()],
      remote: false,
    };
  }

  const docker = packages.find((p) => p && byid(p.registryType) === 'docker');
  if (docker?.identifier) {
    return {
      transport: 'stdio',
      command: 'docker',
      args: ['run', '--rm', '-i', docker.identifier],
      remote: false,
    };
  }

  const httpremote = remotes.find((r) => r && byid(r.type) === 'http' && r.url);
  if (httpremote?.url) {
    return {
      transport: 'http',
      command: '',
      args: [],
      url: httpremote.url,
      remote: true,
    };
  }

  const anyremote = remotes.find((r) => r?.url);
  if (anyremote?.url) {
    return {
      transport: 'http',
      command: '',
      args: [],
      url: anyremote.url,
      remote: true,
    };
  }

  return null;
}

function slug(name) {
  const short = String(name || '')
    .split('/')
    .pop()
    .replace(/^[^a-z0-9]+/i, '')
    .replace(/[^a-z0-9-]+/gi, '-')
    .replace(/-+/g, '-')
    .toLowerCase();
  return short.length ? short : null;
}

export async function fetchRegistry({ limit = Infinity } = {}) {
  const servers = [];
  let cursor = null;
  let pages = 0;

  while (servers.length < limit) {
    const params = new URLSearchParams({ limit: '100', version: 'latest' });
    if (cursor) params.set('cursor', cursor);
    const url = `${REGISTRY_BASE}/v0.1/servers?${params}`;

    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      throw new Error(`registry GET failed (${res.status}): ${await res.text()}`);
    }
    const data = await res.json();
    const batch = data.servers || [];
    servers.push(...batch);
    pages += 1;
    console.error(`  page ${pages}: +${batch.length} (total ${servers.length})`);
    await new Promise((r) => setTimeout(r, 250));

    cursor = data.metadata?.nextCursor || null;
    if (!cursor || batch.length === 0) break;
  }

  return { servers, pages };
}

export function normalize(serverList) {
  const seen = new Set();
  const out = [];
  for (const item of serverList) {
    const server = item?.server;
    if (!server?.name) continue;

    const name = slug(server.name);
    if (!name || !SAFE_NAME.test(name) || !server.description) continue;
    if (seen.has(name)) continue;

    const install = pickPackage(server.packages, server.remotes);
    if (!install) continue;

    seen.add(name);
    out.push({
      name,
      registry: server.name,
      label: server.title || server.name.split('/').pop(),
      description: server.description
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 220),
      transport: install.transport,
      command: install.command,
      args: install.args,
      url: install.url || null,
      remote: install.remote,
      package: install.command === 'npx'
        ? install.args.at(-1)
        : install.command === 'uvx'
          ? install.args[0]
          : null,
      repository: server.repository?.url || null,
    });
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const limitIdx = args.findIndex((a) => a === '--limit');
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) || Infinity : Infinity;

  console.error(`[import-mcp-registry] scraping ${REGISTRY_BASE} (limit=${limit === Infinity ? 'all' : limit})...`);
  const { servers, pages } = await fetchRegistry({ limit });
  console.error(`[import-mcp-registry] fetched ${servers.length} server records across ${pages} page(s)`);

  const candidates = normalize(servers);
  candidates.sort((a, b) => a.name.localeCompare(b.name));

  for (const c of candidates) {
    console.log(JSON.stringify(c));
  }

  const outFile = new URL('./.mcp-registry-candidates.json', import.meta.url);
  await import('node:fs/promises').then((fs) =>
    fs.writeFile(outFile, JSON.stringify(candidates, null, 2)),
  );
  console.error(`[import-mcp-registry] wrote ${candidates.length} candidates -> ${outFile.pathname}`);
  console.error(`[import-mcp-registry] done`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[import-mcp-registry] ERROR: ${err.message}`);
    process.exit(1);
  });
}