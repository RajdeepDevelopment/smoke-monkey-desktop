import {
  ToolDefinition,
  ToolResult,
  ToolContext,
} from './tool-registry';

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
      _context: ToolContext
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
