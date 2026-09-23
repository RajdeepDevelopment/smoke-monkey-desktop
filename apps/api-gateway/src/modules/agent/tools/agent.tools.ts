import {
  ToolDefinition,
  ToolResult,
  ToolContext,
} from './tool-registry';
import {
  SubContextManager,
  renderContextPanel,
  ALL_SUBCONTEXTS,
  getSubContext,
  MAX_ACTIVE_CONTEXTS,
  MAX_ACTIVE_MCP,
} from '../context/sub-context';

/** Streams the live open/closed state to the UI after any context mutation. */
export function emitContextState(manager: SubContextManager, toolContext: ToolContext): void {
  if (!toolContext.eventEmitter) return;
  const active = manager.activeIds.map((id) => {
    const c = manager.resolve(id);
    return { id, title: c?.title ?? id };
  });
  toolContext.eventEmitter.emitContextUpdated(
    toolContext.sessionId,
    toolContext.runId,
    active,
    manager.activeCount,
    manager.maxActive,
  );
}

export function getContextManageTool(): ToolDefinition {
  return {
    name: 'context_manage',
    description:
      'Open (activate) and close (deactivate) SUB-CONTEXTS of domain guidance ' +
      'for the current work. Use it at SESSION START to pick the initial set ' +
      `(min 0, max ${MAX_ACTIVE_CONTEXTS}) based on the user's request, and DURING the run to open ` +
      'guidance a step needs or close guidance it no longer needs. ' +
      'The SUB-CONTEXT PANEL in the system message always shows you the CURRENT ' +
      `ACTIVE [0/${MAX_ACTIVE_CONTEXTS}]` +
      ' list — CHECK THAT PANEL FIRST. Do not re-activate sub-contexts that are ' +
      'already listed as ACTIVE (activating an already-active id is a harmless no-op, ' +
      'but it wastes a turn). Deactivate sub-contexts the current step no longer uses — ' +
      'active sub-contexts are loaded into every LLM call and cost tokens. ' +
      'Sub-contexts persist across runs on the same session: closing one with ' +
      'deactivate is the only way it is removed. ' +
      'SET (action="set") is the preferred declarative action: pass setIds and the ' +
      'manager activates EXACTLY those ids, deactivating everything else in one call — ' +
      'no manual swap bookkeeping. ' +
      'BATCH: you may activate OR deactivate MANY contexts in a SINGLE call by ' +
      'passing contextIds (array) — never send N separate single-id calls. ' +
      'SWAP (action="swap"): swap multiple old contexts OUT and new ones IN in ' +
      'one call via deactivateIds / activateIds — use it whenever you hit the ' +
      `cap (${MAX_ACTIVE_CONTEXTS}) and the current step needs different contexts. ` +
      'ACTIONS: "set" (exact active set via setIds) | ' +
      '"activate" (open; contextId string or contextIds array) | ' +
      '"deactivate" (close one or more; contextId or contextIds) | ' +
      '"swap" (close deactivateIds and open activateIds in the same call) | ' +
      '"list" (see the current ACTIVE/AVAILABLE panel without changing state). ' +
      `MAX ${MAX_ACTIVE_CONTEXTS} sub-contexts active at once — to open a new one when full, ` +
      'deactivate a no-longer-needed sub-context first (swap). ' +
      `Available ids: ${ALL_SUBCONTEXTS.join(', ')}.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['set', 'activate', 'deactivate', 'swap', 'list'],
          description: 'What to do: set the exact active set, open sub-contexts, close them, swap a batch, or list state.',
        },
        setIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'For action="set": the EXACT list of sub-context ids you want active — everything else is deactivated. Includes mcp_<id> servers.',
        },
        contextId: {
          type: 'string',
          description: 'A single sub-context id (e.g. "backend_scale"). Required for activate/deactivate when contextIds is not given.',
        },
        contextIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'One or more sub-context ids to activate or deactivate in the SAME call (e.g. ["backend_scale", "api_contract"]).',
        },
        activateIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'For action="swap": the sub-context ids to open (can be empty if you only deactivate).',
        },
        deactivateIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'For action="swap": the sub-context ids to close (can be empty if you only activate).',
        },
      },
      required: ['action'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    execute: async (
      input: Record<string, unknown>,
      context: ToolContext
    ): Promise<ToolResult> => {
      const manager = context.contextManager;
      if (!manager) {
        return {
          content: [{ type: 'text', text: 'Error: no context manager is available in this run.' }],
          isError: true,
        };
      }

      const action = String(input.action || '');
      // Normalize ids from a string, array, or JSON-encoded array (models
      // sometimes stringify contextIds into the singular contextId field).
      const normIds = (v: unknown): string[] => {
        const arr = Array.isArray(v) ? (v as unknown[]).map(String) : v ? [String(v)] : [];
        const out: string[] = [];
        for (const id of arr) {
          if (!id) continue;
          if (id.startsWith('[')) {
            try {
              const parsed = JSON.parse(id);
              if (Array.isArray(parsed)) {
                out.push(...parsed.map(String).filter(Boolean));
                continue;
              }
            } catch { /* not JSON — keep as-is */ }
          }
          out.push(id);
        }
        return out;
      };
      const fromContextIds = normIds(input.contextIds);
      const ids = fromContextIds.length > 0 ? fromContextIds : normIds(input.contextId);

      if (action === 'list') {
        emitContextState(manager, context);
        return {
          content: [{
            type: 'text',
            text: `Current sub-context state:\n\n${renderContextPanel(manager)}\n\nTip: activate a sub-context or MCP server (mcp_<name>) the current step needs, deactivate it when done.`,
          }],
        };
      }

      if (action === 'set') {
        const setIds = normIds(input.setIds);
        if (setIds.length === 0) {
          return {
            content: [{ type: 'text', text: 'Error: set needs setIds (an array) listing the EXACT ids you want active.' }],
            isError: true,
          };
        }
        const res = manager.setActive(setIds);
        emitContextState(manager, context);
        if (!res.ok) {
          return {
            content: [{ type: 'text', text: `Error: ${res.error}\n\nCurrent state:\n${renderContextPanel(manager)}` }],
            isError: true,
          };
        }
        const changed = res.changed ?? { opened: [], closed: [] };
        return {
          content: [{
            type: 'text',
            text:
              `Set active set. Activated: ${changed.opened.join(', ') || '(none)'}. Deactivated: ${changed.closed.join(', ') || '(none)'}.\n` +
              `Active [${manager.activeCount}/${manager.maxActive}]: ${manager.activeIds.join(', ') || '(none)'}.\n\n` +
              `Updated sub-context panel:\n${renderContextPanel(manager)}`,
          }],
        };
      }

      if (action === 'swap') {
        const deactIds = normIds(input.deactivateIds);
        const actIds = ids.length > 0 ? ids : normIds(input.activateIds);
        if (deactIds.length === 0 && actIds.length === 0) {
          return {
            content: [{ type: 'text', text: 'Error: swap needs deactivateIds and/or activateIds to change the active set.' }],
            isError: true,
          };
        }
        // Deactivate first so slots free up, then activate the new batch.
        const deactRes = deactIds.map((id) => ({ id, r: manager.deactivate(id) }));
        const actRes = actIds.map((id) => ({ id, r: manager.activate(id) }));
        emitContextState(manager, context);
        const failed = [...deactRes, ...actRes].filter((x) => !x.r.ok);
        if (failed.length > 0) {
          const errors = failed.map((x) => `${x.id}: ${(x.r as { error?: string }).error}`).join('\n');
          return {
            content: [{ type: 'text', text: `Error during swap:\n${errors}\n\nCurrent state:\n${renderContextPanel(manager)}` }],
            isError: true,
          };
        }
        manager.lastDelta = {
          opened: actRes.filter((x) => x.r.ok && !manager.isMcpContext(x.id)).map((x) => x.id),
          closed: deactRes.filter((x) => x.r.ok && !manager.isMcpContext(x.id)).map((x) => x.id),
        };
        return {
          content: [{
            type: 'text',
            text:
              `Swapped sub-contexts. Deactivated: ${deactIds.join(', ') || '(none)'}. Activated: ${actIds.join(', ') || '(none)'}.\n` +
              `Active [${manager.activeCount}/${manager.maxActive}]: ${manager.activeIds.join(', ') || '(none)'}.\n\n` +
              `Updated sub-context panel:\n${renderContextPanel(manager)}`,
          }],
        };
      }

      if (action !== 'activate' && action !== 'deactivate') {
        return {
          content: [{ type: 'text', text: 'Error: action must be "activate", "deactivate", "swap", "set", or "list".' }],
          isError: true,
        };
      }

      if (ids.length === 0) {
        const allIds = [...ALL_SUBCONTEXTS, ...manager.registeredMcpIds].join(', ');
        return {
          content: [{ type: 'text', text: `Error: contextId or contextIds is required for ${action}. Available ids: ${allIds}.` }],
          isError: true,
        };
      }

      const results = ids.map((id) => {
        const r =
          action === 'activate'
            ? manager.activate(id)
            : manager.deactivate(id);
        return {
          ok: r.ok,
          error: r.error,
          alreadyActive: Boolean((r as { alreadyActive?: boolean }).alreadyActive),
          alreadyInactive: Boolean((r as { alreadyInactive?: boolean }).alreadyInactive),
        };
      });

      // Stream state to the UI whether or not the mutations succeeded, so the
      // panel always reflects reality after the agent reaches for a context.
      emitContextState(manager, context);

      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        const errors = results.map((r, i) => (r.ok ? null : `${ids[i]}: ${r.error}`)).filter(Boolean).join('\n');
        return {
          content: [{ type: 'text', text: `Error: ${errors}\n\nCurrent state:\n${renderContextPanel(manager)}` }],
          isError: true,
        };
      }

      const doneIds = ids.filter((_, i) => results[i].ok && !results[i].alreadyActive && !results[i].alreadyInactive && !manager.isMcpContext(ids[i]));
      manager.lastDelta = action === 'activate'
        ? { opened: doneIds, closed: [] }
        : { opened: [], closed: doneIds };

      const verb = action === 'activate' ? 'ACTIVATED (loaded into context)' : 'DEACTIVATED (removed from context)';
      const noOps = ids.filter((_, i) =>
        action === 'activate' ? results[i].alreadyActive : results[i].alreadyInactive,
      );
      const noOpNote = noOps.length > 0
        ? `\nNote: ${noOps.join(', ')} was already in the target state — no change needed.`
        : '';
      return {
        content: [{
          type: 'text',
          text:
            `Sub-context ${verb}: ${ids.join(', ')}.${noOpNote}\nActive [${manager.activeCount}/${manager.maxActive}]: ${manager.activeIds.join(', ') || '(none)'}.\n\n` +
            `Updated sub-context panel:\n${renderContextPanel(manager)}`,
        }],
      };
    },
  };
}

export function getTodoWriteTool(): ToolDefinition {
  return {
    name: 'todo_write',
    description:
      'Record and update a structured task list for the current work. Send the ENTIRE list every call — ' +
      'it REPLACES the previous list (no partial updates, no per-item edits). Add one todo per concrete ' +
      'step BEFORE you start multi-step work. Keep AT MOST ONE todo in_progress at a time; while work ' +
      'remains, exactly one task should be in_progress. Mark a todo completed the moment it is done — ' +
      'do not batch completions. Skip the list for trivial single-step tasks. ' +
      'Statuses: pending (not started) | in_progress (being worked on now) | completed (finished).',
    inputSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The COMPLETE task list, replacing any previous list.',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'What the task is — a short imperative line.' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed', 'cancelled'],
                description: 'Current status.',
              },
              priority: {
                type: 'string',
                enum: ['high', 'medium', 'low'],
                description: 'Priority level.',
              },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    execute: async (
      input: Record<string, unknown>,
      context: ToolContext
    ): Promise<ToolResult> => {
      const raw = input.todos as Array<{
        content: string;
        status: string;
        priority?: string;
      }> | undefined;

      if (!Array.isArray(raw)) {
        return { content: [{ type: 'text', text: 'Error: todos must be an array of {content, status}.' }], isError: true };
      }

      const seen = new Set<string>();
      let activeCount = 0;
      const todos: Array<{ content: string; status: string; priority: string }> = [];
      for (const item of raw) {
        const content = String(item?.content ?? '').trim();
        if (!content) {
          return { content: [{ type: 'text', text: 'Error: every todo needs non-empty content.' }], isError: true };
        }
        if (seen.has(content)) {
          return { content: [{ type: 'text', text: `Error: duplicate todo "${content}". Each task must be unique.` }], isError: true };
        }
        seen.add(content);
        const status = String(item?.status ?? 'pending');
        if (!['pending', 'in_progress', 'completed', 'cancelled'].includes(status)) {
          return { content: [{ type: 'text', text: `Error: invalid status "${status}" (use pending | in_progress | completed | cancelled).` }], isError: true };
        }
        if (status === 'in_progress') activeCount++;
        todos.push({ content, status, priority: item?.priority ? String(item.priority) : 'medium' });
      }

      // Sequential execution model: exactly one active task keeps the model honest.
      if (activeCount > 1) {
        return { content: [{ type: 'text', text: `Error: at most ONE todo may be in_progress (got ${activeCount}). Mark only the task you are working on right now.` }], isError: true };
      }

      if (todos.length === 0) {
        return { content: [{ type: 'text', text: 'Todo list cleared.' }] };
      }

      // Emit structured todo.updated event for UI rendering
      if (context.eventEmitter) {
        context.eventEmitter.emitTodoUpdated(context.sessionId, context.runId, todos);
      }

      const counts = (s: string) => todos.filter(t => t.status === s).length;
      const marker = (s: string) => s === 'completed' ? '[x]' : s === 'in_progress' ? '[>]' : s === 'cancelled' ? '[-]' : '[ ]';
      const formatted = todos
        .map((t) => `${marker(t.status)} [${t.priority}] ${t.content}`)
        .join('\n');

      return {
        content: [{
          type: 'text',
          text: `Updated todo list: ${counts('pending')} pending, ${counts('in_progress')} in progress, ${counts('completed')} completed.\n${formatted}`,
        }],
      };
    },
  };
}

export function getFinishTaskTool(): ToolDefinition {
  return {
    name: 'finish_task',
    description:
      'Explicitly signal that the run is COMPLETE and stop the agent loop. ' +
      'Call this ONCE when the user\'s task is genuinely done — after your final ' +
      'verification passed and there is no further work to do. Include a concise ' +
      '`summary` of what was accomplished. This is the authoritative, structural ' +
      'way to end the run; do not repeat the same final answer in plain text and ' +
      'do not emit more tool calls after calling this. For general chat (no task), ' +
      'just reply in text — do not call this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'A short summary of what was completed (shown to the user).',
        },
      },
      required: ['summary'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    execute: async (input: Record<string, unknown>): Promise<ToolResult> => {
      const summary = String(input.summary || '').trim();
      return {
        content: [{
          type: 'text',
          text: `[TASK COMPLETE] The run will now finalize.${summary ? `\nSummary: ${summary}` : ''}`,
        }],
        summary: summary || 'Task marked complete',
      };
    },
  };
}

export function getAskUserTool(): ToolDefinition {
  return {
    name: 'ask_user',
    description:
      'Ask the user ONE focused question when a decision genuinely blocks progress: ambiguous ' +
      'requirements, destructive-action confirmation, or choosing between real alternatives. ' +
      'The run pauses until the user answers; their response is returned as the tool result. ' +
      'Do NOT use it for information you can find yourself (read the code first) or to ask permission ' +
      'for routine steps. Provide 2-4 concrete options when choices exist.',
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The question or prompt to show the user.',
        },
        options: {
          type: 'array',
          description: 'Optional predefined choices. If omitted, free-form input is accepted.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Display text for this option.' },
              description: { type: 'string', description: 'Brief explanation of what this option means.' },
            },
            required: ['label', 'description'],
          },
        },
        multiple: {
          type: 'boolean',
          description: 'Allow selecting multiple options. Default: false.',
        },
      },
      required: ['question'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
    },
    execute: async (
      input: Record<string, unknown>,
      context: ToolContext
    ): Promise<ToolResult> => {
      const question = String(input.question || '');
      const options = (input.options as Array<{ label: string; description: string }>) || [];
      const multiple = Boolean(input.multiple);

      if (!question) {
        return { content: [{ type: 'text', text: 'Error: question is required.' }], isError: true };
      }

      let prompt = question;
      if (options.length > 0) {
        const choices = options.map((o, i) => `  ${i + 1}. ${o.label} — ${o.description}`).join('\n');
        prompt += `\n\nOptions:\n${choices}`;
      }
      if (multiple) {
        prompt += '\n\n(Select multiple options)';
      }

      return {
        content: [{
          type: 'text',
          text: `[Question delivered to the user — the run pauses here until they respond. Their answer will arrive as this tool's result.]\n\n${prompt}`,
        }],
      };
    },
  };
}
