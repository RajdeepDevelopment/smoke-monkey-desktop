import { Logger } from '@nestjs/common';
import { ToolDefinition, ToolResult, ToolContext } from './tool-registry';
import { McpService } from '../../mcp/mcp.service';
import { MAX_ACTIVE_MCP, MAX_MCP_RECOMMEND } from '../context/sub-context';

const stockLogger = new Logger('McpStockTool');

/**
 * Recommendation confidence gate. A server only becomes RECOMMENDED
 * (recommended / recommendedToEnable / recommendedToAdd) when its task
 * coverage is >= this fraction — otherwise it would raise the "MCPs for this
 * task" bar / approval popup on a weak (e.g. single-token) match. Weak matches
 * are still listed in the text so the AGENT can judge, but never surfaced to
 * the user.
 */
const MCP_RECOMMEND_THRESHOLD = 0.7;
const MCP_RECOMMEND_PCT = Math.round(MCP_RECOMMEND_THRESHOLD * 100);

import {
  McpStockEntry,
  flattenStock,
  listStockCategories,
  countStock,
  findStockEntry,
} from '../../mcp/mcp-stock';

/**
 * One normalized stock row — either a configured server (`added: true`) or a
 * catalog-only server the user has not connected yet (`added: false`).
 */
interface McpStockRow {
  id: string;
  name: string;
  label: string;
  description: string;
  category: string | null;
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  url: string | null;
  icon: string | null;
  enabled: boolean;
  configured: boolean;
  oauthRegistered: boolean;
  oauthConnected: boolean;
  oauthExpiresAt: number | null;
  oauthExpired: boolean;
  apiTokenSet: boolean;
  envKeys: string[];
  activeInRun: boolean;
  added: boolean;
  keyGetUrl: string | null;
  keyGetLabel: string | null;
  dependency: string;
  remote: boolean;
  manualOAuth: boolean;
  oauthScopes: string | null;
  recommended: boolean;
  recommendedToEnable: boolean;
  recommendedToAdd: boolean;
  matchPercent: number | null;
  tags: string[];
}

/**
 * MCP "stock" inventory tool. Lets the agent review the ENTIRE MCP universe:
 * every configured server (its live status — enabled for this run / active
 * right now / fully configured / needs OAuth or keys) PLUS every server in the
 * stock catalog that is NOT yet added, so the agent always knows what the user
 * COULD connect. When `task` is supplied, computes the best combination of
 * servers for that task (and flags useful disabled / not-yet-added servers).
 * Optional filters:
 *  - `category` — narrow to a single stock category (the catalog's unique
 *    categories are listed in the system prompt; pass "all" to clear).
 *  - `query`    — grep-style regex (case-insensitive) matched against name,
 *    label, description, category, command, args and dependency.
 * The result is streamed to the UI as an `mcp.stock` event so the chat page
 * can render an interactive stock widget alongside the agent's reply.
 *
 * Status semantics (surfaced to both the model and the widget):
 *  - added          — the server is configured in user_mcp_servers (not stock).
 *  - enabled        — the server is on the run's registry; it is listed in the
 *                     MCP SERVERS system-prompt block and CAN be activated this
 *                     run. Disabled servers are NOT on the system prompt and
 *                     only become usable after the user enables them.
 *  - activeInRun    — `mcp_<id>` is currently an open sub-context, so the
 *                     server's tools are exposed to the model RIGHT NOW.
 *  - configured     — transport sanity + credentials sanity (http servers need
 *                     a url and, when OAuth is registered, a valid token;
 *                     stdio servers need a command). `oauthConnected` /
 *                     `oauthExpiresAt` / `envKeys` carry the detail.
 */
export function getMcpStockTool(mcpService: McpService): ToolDefinition {
  return {
    name: 'inspect_mcp_stock',
    description:
      'Inspect the MCP (Model Context Protocol) server stock: read-only inventory of the FULL universe — ' +
      'every configured server with its live status (enabled / disabled, active in THIS run, fully configured ' +
      'vs needing OAuth/keys) AND every stock-catalog server that is NOT yet added (so you know what the user could ' +
      'connect). Constraints: max ' + `${MAX_ACTIVE_MCP} active at once.\n` +
      'Filtering (combine freely):\n' +
      ` - \`category\`: a stock category from: ${listStockCategories()
        .map((c) => JSON.stringify(c))
        .join(', ')} (or "all").\n` +
      ' - `query`: GREP-style regex (case-insensitive), matched against name, label, description, category, command, args, dependency AND tags.\n' +
      'SEARCH CATEGORY-WISE FIRST: the catalog is organized into categories (listed above and in the system prompt). ' +
      'For any task, pick the 1-2 categories the capability belongs to (e.g. UI/browser page → "Web & Scraping" or ' +
      '"Code & Git") and pass \`category\` to narrow, THEN combine with a focused regex \`query\`. This finds the right ' +
      'tools reliably.\n' +
      'BIG/GENERIC TASKS (e.g. "create a restaurant detail/inner page UI"): do NOT dump the whole prompt into `task` — ' +
      'extract the SPECIFIC capability this phase needs (2-5 keywords) and pass it as BOTH a focused `query` (regex, e.g. ' +
      '`browser|playwright|screenshot|html`) and a short `task` (e.g. "render and verify a website page"). A regex `query` finds ' +
      `the servers precisely; a big task blob only dilutes scoring.\n` +
      'CONFIDENCE GATE: recommendations (recommended / recommendedToEnable / recommendedToAdd → user popup) fire ONLY for ' +
      `matches with >=${MCP_RECOMMEND_PCT}% task coverage OR a 100% regex-\`query\` hit on the server's name/label. Weak matches are listed with their % but are NEVER recommended and never ` +
      'raise a popup — if nothing reaches the threshold, narrow the regex/category and retry instead of asking the user to ' +
      'enable/add speculative servers. You decide what is genuinely required: only after a >=threshold match exists (or you ' +
      'independently conclude a server is required) call request_mcp_approval with its id — the run pauses until the user picks ' +
      'Skip or Continue, and their decision is returned to you. Run this at every code-task start and phase boundary; if a server ' +
      'genuinely helps (e.g. a browser MCP to screenshot-verify a built page), activate it. ' +
      'This tool is READ-ONLY (no changes), BUT when it surfaces user-actionable servers (recommendedToEnable / ' +
      'recommendedToAdd) the run PAUSES at the recommendation and waits for the user to pick Skip or Add/Continue before ' +
      'proceeding — so do not call it for purely informational inventory when no decision is needed. ' +
      `The UI shows the user up to ${MAX_MCP_RECOMMEND} required servers to activate/add — only servers you recommend are shown. ` +
      `Only ${MAX_ACTIVE_MCP} can be ACTIVE at once; if more than ${MAX_ACTIVE_MCP} are required, cycle them: keep the ones the ` +
      'CURRENT step uses, deactivate finished ones (context_manage action="deactivate"), and activate the next — never hold all of them open.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional GREP-style regex (case-insensitive). Matched against name, label, description, category, command, args, dependency and tags.',
        },
        category: {
          type: 'string',
          description: `Optional stock category to filter by (search CATEGORY-WISE first). One of: ${listStockCategories().join(', ')}. Use "all" to clear.`,
        },
        task: {
          type: 'string',
          description: 'Optional SHORT task/keyword phrase (2-5 capability keywords — for big tasks pass the extracted capability, NOT the whole prompt). When given, the best server combination for it is computed. Only matches with >=70% coverage are recommended/flagged for the user popup.',
        },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
    },
    execute: async (input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
      const query = input.query ? String(input.query) : '';
      const task = input.task ? String(input.task).trim() : '';
      const categoryInput = input.category ? String(input.category).trim() : '';
      const category =
        !categoryInput || categoryInput.toLowerCase() === 'all' ? null : categoryInput;

      let queryRe: RegExp | null = null;
      if (query) {
        try {
          queryRe = new RegExp(query, 'i');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: 'text', text: `Error: invalid regex for "query": ${message}` }],
            isError: true,
          };
        }
      }

      const categories = listStockCategories();
      const validCategory = category ? categories.some((c) => c.toLowerCase() === category.toLowerCase()) : false;
      if (category && !validCategory) {
        return {
          content: [{
            type: 'text',
            text: `Error: unknown category "${category}". Valid categories: ${categories.join(', ')} — or "all".`,
          }],
          isError: true,
        };
      }

      const servers = await mcpService.listServers(ctx.userId);
      const isActive = (id: string): boolean => !!ctx.contextManager?.isActive(`mcp_${id}`);

      const addedEntries: McpStockRow[] = servers.map((s) => serverToRow(s, findStockEntry(s.name), isActive));

      const addedNames = new Set(addedEntries.map((e) => e.name.trim().toLowerCase()));
      const stockEntries: McpStockRow[] = flattenStock()
        .filter((e) => !addedNames.has(e.name.trim().toLowerCase()))
        .map((e: McpStockEntry) => stockToRow(e));

      const entries = [...addedEntries, ...stockEntries];

      const grep = (e: (typeof entries)[number]): boolean => {
        if (!queryRe) return true;
        const hay = [
          e.name,
          e.label || '',
          e.description || '',
          e.category || '',
          e.command || '',
          e.dependency || '',
          ...e.args,
          ...(e.tags ?? []),
        ].join(' ');
        return queryRe.test(hay);
      };

      const byCategory = (e: (typeof entries)[number]): boolean =>
        !category || (e.category ? e.category.toLowerCase() === category.toLowerCase() : false);

      const filtered = entries.filter((e) => grep(e) && byCategory(e));

      // Task → best-combo recommendation. Enabled servers can be activated this
      // run; disabled added servers are flagged for the user to enable; stock
      // (not-yet-added) servers are flagged for the user to add. Coverage =
      // fraction of the task's token budget matched: name/label tokens weigh 3x
      // (strong), the rest of the row (description/category/command/args/
      // dependency) 1x (weak) — a focused keyword set yields ~100% and a big
      // task dump is always diluted (the agent is told to pass a NARROW
      // task/keyword set + regex query, never the whole prompt).
      // Dedup a recommendation pool keeping STRONG (task-scored / regex-hit)
      // entries first, then any weak-or-unscored entries. Used to combine the
      // task-token `scored` list with regex `query` hits into one `qualified`
      // pool that drives the recommended/recommendedToEnable/recommendedToAdd
      // split below.
      type StockEntry = (typeof entries)[number];
      const qualifyServers = (pool: StockEntry[]): StockEntry[] => {
        const seen = new Set<string>();
        const out: StockEntry[] = [];
        for (const e of pool) {
          if (!seen.has(e.id)) {
            seen.add(e.id);
            out.push(e);
          }
        }
        return out;
      };
      const recommended: string[] = [];
      const recommendedToEnable: string[] = [];
      const recommendedToAdd: string[] = [];
      const matchPercentById = new Map<string, number>();
      // Regex `query` hits feed recommendation too. The agent is told to pass a
      // FOCUSED capability regex (e.g. `browser|playwright|screenshot`) — that
      // IS its own capability claim, so a server matching the regex on strong
      // fields (name/label/tags) is a genuine activation candidate even when
      // the SHORT task phrase shares few literal tokens (e.g. task nouns like
      // "verify/build/render/page" never appear in a browser server's tags).
      const strongHayParts = (e: (typeof entries)[number]): string =>
        `${e.name} ${e.label} ${(e.tags ?? []).join(' ')}`.toLowerCase();
      const weakHayParts = (e: (typeof entries)[number]): string =>
        `${e.description} ${e.category || ''} ${e.command} ${e.args.join(' ')} ${e.dependency}`.toLowerCase();
      const queryMatchPercent = (e: (typeof entries)[number]): number | null => {
        if (!queryRe) return null;
        const base = queryRe.source.replace(/\\b|\\W|\\S|\^|\$/g, '').replace(/\/[a-z]*$/, '');
        const terms = base
          .split('|')
          .map((t) => t.replace(/^[^a-z0-9]+/, '').replace(/[^a-z0-9]+$/, ''))
          .filter((t) => t.length >= 2);
        if (terms.length === 0) return null;
        const hayName = strongHayParts(e);
        const hayRest = weakHayParts(e);
        let strong = 0;
        for (const t of terms) {
          if (hayName.includes(t)) strong += 3;
          else if (hayRest.includes(t)) strong += 1;
        }
        if (strong === 0) return null;
        // A regex term that hits the server's NAME/LABEL is a full capability
        // warrant (e.g. `browser|playwright|puppeteer` → those exact servers).
        // To count, a term must be >=3 chars and match a name/label token by
        // prefix or equality — otherwise generic catch-alls (`ui`, `fe`, `ai`)
        // would 100%-flag every server in a whole category. Substring-only
        // matches stay partial and only feed the task-coverage signal.
        const nameTokens = new Set(
          `${e.name} ${e.label}`.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0),
        );
        const strongMatch = terms.some(
          (t) => t.length >= 3 && [...nameTokens].some((tok) => tok.startsWith(t)),
        );
        return strongMatch ? 100 : Math.round((strong / (terms.length * 3)) * 100);
      };
      if (task) {
        const tokens = new Set(
          task
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter((t) => t.length > 2),
        );
        stockLogger.log(
          `[mcp-stock] inspect task="${task.slice(0, 120)}" tokens=[${[...tokens].join(',')}]`,
        );
        const score = (e: (typeof entries)[number]): number => {
          // name/label/curated tags are STRONG (3x) — they are the intended
          // capability identifiers (incl. aliases like "restaurant, delivery");
          // everything else (description/category/command/args/dependency) is
          // weak (1x).
          const hayName = `${e.name} ${e.label} ${(e.tags ?? []).join(' ')}`.toLowerCase();
          const hayRest = `${e.description} ${e.category || ''} ${e.command} ${e.args.join(' ')} ${e.dependency}`.toLowerCase();
          let strong = 0;
          let weak = 0;
          for (const t of tokens) {
            if (hayName.includes(t)) strong += 3;
            else if (hayRest.includes(t)) weak += 1;
          }
          return strong + weak;
        };
        const coverageOf = (e: (typeof entries)[number]): number => {
          const totalWeight = tokens.size * 3;
          return totalWeight === 0 ? 0 : score(e) / totalWeight;
        };
        const scored = entries
          .map((e) => ({ e, s: score(e), coverage: coverageOf(e) }))
          .filter((x) => x.s >= 2)
          .sort((a, b) => (b.coverage - a.coverage) || (b.s - a.s));
        scored.forEach((x) => matchPercentById.set(x.e.id, Math.round(x.coverage * 100)));
        // Qualified = task-token coverage >= THRESHOLD, PLUS any server the
        // agent's own capability regex `query` flags on STRONG fields (its
        // name/label/tags) — the regex is the agent's declared intent, so a
        // 100% match there is as strong a warrant as a high task coverage.
        // Example: task "verify frontend build and page render" + query
        // "browser|playwright|screenshot" → browserbase/playwright qualify even
        // though the task nouns never appear in their tags.
        const qualifiedInputs = [...scored]
          .map((x) => x.e)
          .filter((e) => matchPercentById.get(e.id)! >= MCP_RECOMMEND_PCT)
          .concat(entries.filter((e) => queryMatchPercent(e) === 100));
        const qualified = qualifyServers(qualifiedInputs);
        if (scored.length > 0 || qualified.length > 0) {
          stockLogger.log(
            `[mcp-stock] matches for task "${task.slice(0, 120)}": ${scored.map((x) => `${x.e.name}=${Math.round(x.coverage * 100)}%`).join(', ')} ` +
              `(>=${MCP_RECOMMEND_PCT}% qualified at ${qualified.filter((e) => matchPercentById.get(e.id)! >= MCP_RECOMMEND_PCT).length}/${scored.length} scored) ` +
              `+ ${qualified.filter((e) => !(matchPercentById.get(e.id)! >= MCP_RECOMMEND_PCT)).length} regex-query hit(s)`,
          );
        } else {
          stockLogger.log(`[mcp-stock] no meaningful match (>=2 tokens) for task "${task.slice(0, 120)}"`);
        }
        // Budget: up to MAX_ACTIVE_MCP enabled servers can be activated right
        // now; up to MAX_MCP_RECOMMEND (5) total may be suggested to the user
        // for the current task (enable disabled + add new stock), which the
        // agent then cycles through the active slots over the run's loops.
        let toUser = 0;
        for (const e of qualified) {
          // AUTO-ACTIVATION (recommended → "BEST FOR TASK") is reserved for
          // servers that are enabled AND fully configured — a server that is
          // still missing credentials/OAuth would fail its first call, so it is
          // never pushed into `recommended`. Everything else must go through
          // request_mcp_approval (disabled/needs-setup) never auto-activates.
          if (e.enabled && e.configured) {
            if (recommended.length < MAX_ACTIVE_MCP) recommended.push(e.id);
          } else if (e.added) {
            if (toUser < MAX_MCP_RECOMMEND) {
              recommendedToEnable.push(e.id);
              toUser++;
            }
          } else {
            if (toUser < MAX_MCP_RECOMMEND) {
              recommendedToAdd.push(e.id);
              toUser++;
            }
          }
        }
        // Regex `query` hits always deserve a visible match % even when the
        // task tokens scored 0 (avoid "weak match (0%)" text on a clearly
        // required server the agent asked for by name).
        for (const e of qualified) {
          const pct = matchPercentById.get(e.id);
          if (pct === undefined || isNaN(pct)) {
            const q = queryMatchPercent(e);
            if (q !== null) matchPercentById.set(e.id, q);
          }
        }
      }

      const byId = new Map(entries.map((e) => [e.id, e]));
      const withFlags = filtered.map((e) => ({
        ...e,
        recommended: recommended.includes(e.id),
        recommendedToEnable: recommendedToEnable.includes(e.id),
        recommendedToAdd: recommendedToAdd.includes(e.id),
        matchPercent: matchPercentById.get(e.id) ?? null,
      }));

      // Sorted inventory: the response always lists servers alphabetically by
      // name so the agent can scan descriptions + ids deterministically.
      withFlags.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));

      // Guarantee the payload always carries every server the recommendation
      // references. The FILTER is independent of the task scoring: the agent can
      // narrow by category/query and still get recommended ids for servers that
      // were filtered OUT — without this, the FE popup (which only sees
      // `servers`) would open with zero candidates and show "no recommended".
      const recIds = new Set([...recommended, ...recommendedToEnable, ...recommendedToAdd]);
      if (recIds.size > 0) {
        const present = new Set(withFlags.map((e) => e.id));
        for (const id of recIds) {
          if (!present.has(id)) {
            const e = byId.get(id);
            if (e) {
              withFlags.push({
                ...e,
                recommended: recommended.includes(id),
                recommendedToEnable: recommendedToEnable.includes(id),
                recommendedToAdd: recommendedToAdd.includes(id),
                matchPercent: matchPercentById.get(id) ?? null,
              });
            }
          }
        }
      }

      const lines = withFlags.map((e) => {
        const status =
          e.activeInRun ? 'ACTIVE in run' :
          e.added && e.enabled ? 'enabled' :
          e.added ? 'disabled' :
          'NOT ADDED (stock)';
        const creds = e.added
          ? e.transport === 'http'
            ? e.oauthConnected
              ? 'oauth connected'
              : e.oauthRegistered
                ? 'NEEDS OAUTH CONNECT'
                : 'no auth required'
            : e.envKeys.length > 0
              ? `env keys: ${e.envKeys.join(', ')}`
              : 'no env/keys required'
          : e.transport === 'http'
            ? e.manualOAuth ? 'needs manual OAuth client' : 'connect via OAuth'
            : e.envKeys.length > 0
              ? `needs keys: ${e.envKeys.join(', ')}`
              : 'no keys required';
        const flags = [
          status,
          e.category ?? '',
          e.configured ? 'configured' : 'INCOMPLETE (needs credentials)',
          creds,
          e.tags?.length ? `tags: ${e.tags.join(', ')}` : '',
        ].filter((f) => f !== '');
        if (e.recommended) flags.push(`RECOMMENDED for task${e.matchPercent != null ? ` (${e.matchPercent}% match)` : ''}`);
        if (e.recommendedToEnable) flags.push(`RECOMMENDED but DISABLED — ask user to enable${e.matchPercent != null ? ` (${e.matchPercent}% match)` : ''}`);
        if (e.recommendedToAdd) flags.push(`RECOMMENDED — NOT ADDED yet, offer to add${e.matchPercent != null ? ` (${e.matchPercent}% match)` : ''}`);
        if (e.matchPercent != null && !e.recommended && !e.recommendedToEnable && !e.recommendedToAdd) {
          flags.push(`weak match (${e.matchPercent}% — below ${MCP_RECOMMEND_PCT}% recommendation threshold)`);
        }
        const install = e.added ? '' : `\n    add: ${e.transport === 'http' ? (e.url ?? '') : `${e.command} ${e.args.join(' ')}`.trim()}${e.envKeys.length > 0 ? ` [expects ${e.envKeys.join(', ')}]` : ''}`;
        return `- ${e.name}${e.icon ? ` (${e.icon})` : ''}: ${e.description || e.label || '(no description)'}\n    ${flags.join(' · ')}${install}`;
      });

      const counts = {
        total: entries.length,
        configured: addedEntries.length,
        added: addedEntries.length,
        enabled: addedEntries.filter((e) => e.enabled).length,
        active: addedEntries.filter((e) => e.activeInRun).length,
        needAttention: addedEntries.filter((e) => !e.configured).length,
        stockNotAdded: stockEntries.length,
        stockAdded: addedEntries.filter((e) => findStockEntry(e.name)).length,
        stockCategories: categories.length,
      };

      let text = `MCP STOCK — ${counts.total} total (${counts.configured} configured, ${counts.stockNotAdded} not yet added from the catalog), ${counts.enabled} enabled (on system prompt), ${counts.active} active in this run${counts.needAttention ? `, ${counts.needAttention} need credentials/connect` : ''}.`;
      if (category) text += `\nCategory: ${category}`;
      if (query) text += `\nFiltered by regex: /${query}/i`;
      text += `\n\n${lines.join('\n') || '(no matches)'}`;
      if (task) {
          const names = (ids: string[]): string => ids.map((id) => byId.get(id)?.name ?? id).join(', ');
          const anyRec = recommended.length > 0 || recommendedToEnable.length > 0 || recommendedToAdd.length > 0;
          if (anyRec) {
            text += `\n\nBest combo for task${recommended.length > 0 ? ` (${recommended.length}/${MAX_ACTIVE_MCP} slots): ${names(recommended)}` : ``}`;
            if (recommended.length === 0 && recommendedToEnable.length > 0) {
              text += `\nNo enabled server scores high — consider enabling ${names(recommendedToEnable)} via request_mcp_approval.`;
            }
            if (recommendedToEnable.length > 0) {
              text += `\nCandidate but DISABLED — if you decide one is genuinely required, call request_mcp_approval to ask the user to enable: ${names(recommendedToEnable)}`;
            }
            if (recommendedToAdd.length > 0) {
              text += `\nCandidate but NOT ADDED — if you decide one is genuinely required, call request_mcp_approval to ask the user to add it: ${names(recommendedToAdd)}`;
            }
          } else {
            text += `\n\nNo server matches the task or your query regex above the ${MCP_RECOMMEND_PCT}% threshold — consider tightening the regex/category, or proceed with local tools.`;
          }
          const weak = matchPercentById.size > 0 &&
            [...matchPercentById.entries()].filter(([, p]) => p < MCP_RECOMMEND_PCT).length;
          text +=
            `\nOnly >=${MCP_RECOMMEND_PCT}% task matches OR regex-query hits are recommended/flagged (user popup opens only for those).` +
            (weak ? ` ${weak} server(s) scored below the threshold and are listed for your judgment only — retry with a tighter regex/category if nothing qualifies.` : '');
      }
      // Stream the structured payload to the chat UI (renders the stock widget).
      ctx.eventEmitter?.emitRun(ctx.sessionId, ctx.runId, 'mcp.stock', {
        query: query || null,
        category: category || null,
        task: task || null,
        categories,
        servers: withFlags,
        recommendedIds: recommended,
        recommendedToEnableIds: recommendedToEnable,
        recommendedToAddIds: recommendedToAdd,
        counts,
      });

      return {
        content: [{ type: 'text', text }],
        summary: `MCP stock: ${counts.configured} configured / ${counts.enabled} enabled / ${counts.active} active / ${counts.stockNotAdded} in catalog`,
        data: {
          query: query || null,
          category: category || null,
          task: task || null,
          categories,
          servers: withFlags,
          recommendedIds: recommended,
          recommendedToEnableIds: recommendedToEnable,
          recommendedToAddIds: recommendedToAdd,
          counts,
        },
      };
    },
  };
}

/**
 * Agent-driven MCP approval tool. inspect_mcp_stock is READ-ONLY — it returns
 * the sorted inventory and scored hints but NEVER pauses the run. When the
 * AGENT concludes a server is genuinely required yet disabled/not-added, it
 * calls request_mcp_approval with that server's id; the agent-loop then emits
 * the MCP approval popup and blocks on waiting_mcp_approval until the user
 * picks Skip or Continue. The user's decision is returned as the tool result.
 */
export function getRequestMcpApprovalTool(mcpService: McpService): ToolDefinition {
  return {
    name: 'request_mcp_approval',
    description:
      'Request the user to ENABLE (activate for this run) or ADD (configure as new) MCP servers you have decided are ' +
      'REQUIRED for the current task. Use ONLY after inspect_mcp_stock showed the server exists but is disabled or not ' +
      'added. The run PAUSES until the user selects Skip or Continue — their choice comes back as this tool\'s result. ' +
'Do NOT call this for servers that are already enabled/active just activate them with context_manage instead.',
        inputSchema: {
      type: 'object',
      properties: {
        serverIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ids of the servers to enable/add. Use the exact `id` values returned by inspect_mcp_stock (e.g. "stock:drawio-mcp" for not-yet-added catalog servers, or a UUID for configured servers).',
        },
        reason: {
          type: 'string',
          description: 'One-line reason each server is required for the current task (shown to the user in the popup).',
        },
      },
      required: ['serverIds', 'reason'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    execute: async (input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
      const rawIds = input.serverIds;
      const ids: string[] = Array.isArray(rawIds) ? rawIds.map(String) : [];
      const reason = input.reason ? String(input.reason).trim() : '';
      if (ids.length === 0) {
        return { content: [{ type: 'text', text: 'Error: serverIds is required.' }], isError: true };
      }

      const servers = await mcpService.listServers(ctx.userId);
      const isActive = (id: string): boolean => !!ctx.contextManager?.isActive(`mcp_${id}`);
      const addedEntries: McpStockRow[] = servers.map((s) => serverToRow(s, findStockEntry(s.name), isActive));
      const addedNames = new Set(addedEntries.map((e) => e.name.trim().toLowerCase()));
      const stockEntries: McpStockRow[] = flattenStock()
        .filter((e) => !addedNames.has(e.name.trim().toLowerCase()))
        .map((e: McpStockEntry) => stockToRow(e));
      const byId = new Map([...addedEntries, ...stockEntries].map((e) => [e.id, e]));

      const found: McpStockRow[] = [];
      const missing: string[] = [];
      for (const id of ids) {
        const row = byId.get(id);
        if (row) {
          found.push({
            ...row,
            recommended: false,
            recommendedToEnable: row.added && !row.enabled,
            recommendedToAdd: !row.added,
            matchPercent: null,
          });
        } else {
          missing.push(id);
        }
      }
      if (found.length === 0) {
        return {
          content: [{ type: 'text', text: `Error: no server matched the requested ids: ${ids.join(', ')}. Run inspect_mcp_stock first and pass exact ids from its output.` }],
          isError: true,
        };
      }

      const toEnable = found.filter((e) => e.added && !e.enabled).map((e) => e.id);
      const toAdd = found.filter((e) => !e.added).map((e) => e.id);

      stockLogger.log(
        `[mcp-approval] request_mcp_approval ids=[${ids.join(',')}] found=${found.map((e) => e.name).join(',')} ` +
          `toEnable=[${toEnable.join(',')}] toAdd=[${toAdd.join(',')}] reason="${reason.slice(0, 120)}" (run pauses for user)`,
      );

      const names = found.map((e) => (toAdd.includes(e.id) ? `${e.name} (ADD)` : toEnable.includes(e.id) ? `${e.name} (ENABLE)` : e.name));

      return {
        content: [{
          type: 'text',
          text: `[MCP APPROVAL REQUESTED] Servers: ${names.join(', ')}\nReason: ${reason || '(none given)'}\n\n` +
            `The user has been asked — the run is paused (waiting_mcp_approval). Their Skip/Continue decision will be ` +
            `returned as this tool's result.`,
        }],
        summary: `MCP approval requested: ${found.length} server(s) (${toEnable.length} enable, ${toAdd.length} add)`,
        data: {
          task: reason || null,
          servers: found,
          requestedIds: ids,
          recommendedToEnableIds: toEnable,
          recommendedToAddIds: toAdd,
        },
      };
    },
  };
}

function stockToRow(e: McpStockEntry): McpStockRow {
  return {
    id: `stock:${e.name}`,
    name: e.name,
    label: e.label,
    description: e.description,
    category: e.category,
    transport: e.transport,
    command: e.command,
    args: e.args,
    url: e.url,
    icon: e.icon,
    enabled: false,
    configured: false,
    oauthRegistered: e.remote || e.manualOAuth,
    oauthConnected: false,
    apiTokenSet: false,
    oauthExpiresAt: null as number | null,
    oauthExpired: false,
    envKeys: e.envKeys,
    activeInRun: false,
    added: false,
    keyGetUrl: e.keyGetUrl,
    keyGetLabel: e.keyGetLabel,
    dependency: e.dependency,
    remote: e.remote,
    manualOAuth: e.manualOAuth,
    oauthScopes: e.oauthScopes,
    recommended: false,
    recommendedToEnable: false,
    recommendedToAdd: false,
    matchPercent: null,
    tags: e.tags ?? [],
  };
}

function serverToRow(
  s: { [k: string]: any },
  stock: McpStockEntry | null,
  isActive: (id: string) => boolean,
): McpStockRow {
  const args: string[] = s.argsJson ? safeParseArray(s.argsJson) : [];
  const envKeys: string[] = s.envJson ? safeKeys(s.envJson) : [];
  const oauthRegistered = s.transport === 'http' ? !!s.oauthClientId : false;
  const hasApiToken = !!s.apiToken;
  const hasOauthToken = oauthRegistered && !!s.oauthAccessToken;
  const oauthExpiresAt = s.oauthExpiresAt ? Number(s.oauthExpiresAt) : null;
  const oauthExpired = hasOauthToken && oauthExpiresAt !== null && oauthExpiresAt <= Date.now();
  const oauthConnected = hasApiToken || (hasOauthToken && !oauthExpired);
  const storedTags = Array.isArray(s.tags) ? (s.tags as string[]) : [];
  const configured =
    s.transport === 'http'
      ? !!s.url && (hasApiToken || !oauthRegistered || oauthConnected)
      : !!s.command;
  return {
    id: s.id,
    name: s.name,
    label: stock?.label ?? s.name,
    description: s.description || stock?.description || '',
    category: s.category ?? stock?.category ?? null,
    transport: s.transport,
    command: s.command ?? '',
    args,
    url: s.url ?? null,
    icon: s.icon ?? null,
    enabled: s.enabled,
    configured,
    oauthRegistered,
    oauthConnected,
    oauthExpiresAt,
    oauthExpired: hasOauthToken && oauthExpired,
    apiTokenSet: hasApiToken,
    envKeys,
    activeInRun: isActive(s.id),
    added: true,
    keyGetUrl: stock?.keyGetUrl ?? null,
    keyGetLabel: stock?.keyGetLabel ?? null,
    dependency: stock?.dependency ?? '',
    remote: stock?.remote ?? s.transport === 'http',
    manualOAuth: stock?.manualOAuth ?? false,
    oauthScopes: stock?.oauthScopes ?? null,
    recommended: false,
    recommendedToEnable: false,
    recommendedToAdd: false,
    matchPercent: null,
    tags: storedTags.length > 0 ? storedTags : (stock?.tags ?? []),
  };
}

function safeParseArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function safeKeys(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : [];
  } catch {
    return [];
  }
}