import { ToolDefinition, ToolContext, ToolResult } from './tool-registry';
import { McpService } from '../../mcp/mcp.service';
import { MCP_SAFE_RUNNERS, McpImportEntry, toMcpImportEntry } from '../../mcp/mcp-security';

/**
 * Lets the agent REGISTER a new MCP server mid-run so its tools become
 * available on the next run (and immediately to other sessions). The LLM
 * supplies name/description/transport and either a command (+args/env) or a
 * url. Validation mirrors the JSON-import path (mcp-security.ts): safe runners
 * only, no shell metacharacters, http(s) urls. An optional `icon` (brand hint
 * or emoji) is persisted for the UI.
 */
export function getAddMcpServerTool(mcpService: McpService): ToolDefinition {
  return {
    name: 'add_mcp_server',
    description:
      'Register a NEW Model Context Protocol (MCP) server so its tools become ' +
      'available to this agent. Use this when an external service (database, ' +
      'API, internal tool, file system) is NOT yet connected and you need its ' +
      'capabilities for the task. Provide `transport`="stdio" with a `command` ' +
      `from this allowlist: ${Array.from(MCP_SAFE_RUNNERS).join(', ')} (plus args/env), ` +
      'or transport="http" with a `url`. Optionally give a short `icon` (brand name ' +
      'like "github" or a single emoji) to badge it in the UI, a concise ' +
      'one-line `description`, a `category` (from the stock category list in the ' +
      'system prompt) and `tags` (short aliases/keywords so this server can be ' +
      'found later by capability search). The new server starts DISABLED for tool ' +
      'exposure until activated — after adding it you may activate it for THIS ' +
      'run when the task needs it. Do NOT duplicate a server that already exists.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Short unique name (≤ 120 chars, no "mcp_" prefix).',
        },
        description: {
          type: 'string',
          description: 'One-line description of what this server exposes.',
        },
        transport: {
          type: 'string',
          enum: ['stdio', 'http'],
          description: 'stdio = spawn a local command; http = remote streamable HTTP endpoint.',
        },
        command: {
          type: 'string',
          description: 'Executable to run for stdio (allowlisted).',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Command arguments (no shell metacharacters).',
        },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Environment variables (API keys/tokens) for the stdio process.',
        },
        url: {
          type: 'string',
          description: 'Endpoint URL for http transport.',
        },
        icon: {
          type: 'string',
          description: 'Optional brand hint (e.g. "github", "slack") or a single emoji.',
        },
        category: {
          type: 'string',
          description: 'Optional stock category from the category list in the system prompt (e.g. "Databases & Storage").',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional lowercase search tags/aliases (2-5 keywords, e.g. ["restaurant","menu","delivery"]) so this server is findable by capability search.',
        },
      },
      required: ['name'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    execute: async (input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
      const name = String(input.name ?? '').trim();
      if (!name) {
        return { content: [{ type: 'text', text: 'Error: name is required.' }], isError: true };
      }
      const transport = input.transport === 'http' ? 'http' : 'stdio';

      const raw: Record<string, unknown> = { name, transport };
      if (input.description !== undefined) raw.description = String(input.description);
      if (input.command !== undefined) raw.command = String(input.command);
      if (Array.isArray(input.args)) raw.args = input.args.map(String);
      if (input.env && typeof input.env === 'object') {
        const cleanEnv: Record<string, string> = {};
        for (const [k, v] of Object.entries(input.env as Record<string, unknown>)) {
          cleanEnv[k] = String(v);
        }
        raw.env = cleanEnv;
      }
      if (input.url !== undefined) raw.url = String(input.url);
      if (input.icon !== undefined) raw.icon = String(input.icon);
      if (input.category !== undefined) raw.category = String(input.category);
      if (Array.isArray(input.tags)) raw.tags = input.tags.map(String);

      let entry: McpImportEntry;
      try {
        entry = toMcpImportEntry(raw);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Rejected (security validation): ${message}` }],
          isError: true,
        };
      }

      const existing = await mcpService.listServers(ctx.userId);
      if (existing.some((s) => s.name.trim().toLowerCase() === entry.name.trim().toLowerCase())) {
        return {
          content: [{
            type: 'text',
            text: `Server "${entry.name}" already exists. Reuse it — do not create a duplicate.`,
          }],
          isError: true,
        };
      }

      const server = await mcpService.createServer(ctx.userId, {
        ...entry,
        transport: entry.transport,
        enabled: false,
      });

      const config = server.transport === 'http' ? `url=${entry.url}` : `${entry.command ?? ''} ${(entry.args ?? []).join(' ')}`.trim();
      return {
        content: [{
          type: 'text',
          text:
            `Added MCP server "${server.name}" (id ${server.id}).\n` +
            'It is registered and disabled, and will appear in the MCP SERVERS list from the next run ' +
            '(the system prompt refreshes automatically). To expose its tools, the user enables it in ' +
            `the MCP page, or you activate "mcp_${server.id}" via context_manage.\n` +
            `Config: ${config}`,
        }],
        summary: `Added MCP server "${server.name}"`,
        data: { id: server.id, name: server.name, icon: server.icon, transport: server.transport },
      };
    },
  };
}