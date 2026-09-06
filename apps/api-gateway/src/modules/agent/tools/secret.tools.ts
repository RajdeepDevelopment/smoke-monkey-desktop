import { SecretsService } from '../../secrets/secrets.service';
import { SECRET_HUGGING_FACE } from '../../secrets/user-secret.entity';
import { ToolContext, ToolDefinition, ToolResult } from './tool-registry';

/**
 * Secret Manager tool — the agent's interface to the user's named secrets
 * (API tokens, keys, credentials). It can list/read/write/delete secrets, but
 * EVERY call first triggers the permission system's always-ask rule
 * (see agent-permission.service.ts) so the user explicitly approves each
 * access. Secrets returned by `read` must never be echoed into the reply,
 * logs, or transcript.
 */
export function getSecretManagerTool(secrets: SecretsService): ToolDefinition {
  return {
    name: 'secret_manager',
    description:
      'Manage the user\'s stored secrets (API tokens / keys / credentials). ' +
      'EVERY call requires the user\'s approval — the run pauses and asks. ' +
      'ACTIONS: "list" (names + validity status, never values) | ' +
      '"read <name>" (value of one secret, e.g. name="huggingface") | ' +
      '"write <name> <value>" (create or update a secret) | ' +
      '"delete <name>" (remove a secret). ' +
      'RULES: never print, echo, or log a secret value — use it only as an ' +
      'environment variable inside a command (e.g. HUGGING_FACE_TOKEN=... curl ...), ' +
      'redact it in any output, and only access the secret the user approved.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'read', 'write', 'delete'],
          description: 'What to do with the secret.',
        },
        name: {
          type: 'string',
          description: 'Secret name, e.g. "huggingface". Required for read/write/delete.',
        },
        value: {
          type: 'string',
          description: 'Secret value. Required for write.',
        },
      },
      required: ['action'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    execute: async (input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
      const action = String(input.action || '').trim();
      const name = String(input.name || '').trim().toLowerCase();
      const value = String(input.value ?? '');
      const userId = ctx.userId;

      if (action === 'list') {
        const rows = await secrets.listSecrets(userId);
        const lines = rows.length
          ? rows.map((s) => `- ${s.name} — status ${s.status}, mask ${s.keyPrefix}${s.last4}`).join('\n')
          : '(no secrets stored)';
        return {
          content: [{ type: 'text', text: `Stored secrets (values hidden — call "read <name>" for a specific one you have approval for):\n${lines}` }],
          summary: `Listed ${rows.length} secrets`,
        };
      }

      if (action === 'read') {
        if (!name) {
          return { content: [{ type: 'text', text: 'Error: name is required for read.' }], isError: true };
        }
        const stored = await secrets.getSecret(userId, name);
        if (stored === null) {
          return {
            content: [{ type: 'text', text: `Error: no secret named "${name}" is stored. Use "list" to see available names or ask the user to save it.` }],
            isError: true,
          };
        }
        return {
          content: [{
            type: 'text',
            text:
              `Secret "${name}" retrieved (user approved). Use it ONLY as an environment variable in commands ` +
              `(e.g. ${envRef(name)}=<value> curl …). Never print, echo, or log this value.\n\n${envRef(name)}=${stored}`,
          }],
          summary: `Read secret "${name}" for approved use`,
        };
      }

      if (action === 'write') {
        if (!name) {
          return { content: [{ type: 'text', text: 'Error: name is required for write.' }], isError: true };
        }
        if (!value) {
          return { content: [{ type: 'text', text: 'Error: value is required for write.' }], isError: true };
        }
        const summary = await secrets.setSecret(userId, name, value);
        return {
          content: [{ type: 'text', text: `Secret "${name}" saved/updated (status ${summary.status}). Its value is redacted from this transcript.` }],
          summary: `Updated secret "${name}"`,
        };
      }

      if (action === 'delete') {
        if (!name) {
          return { content: [{ type: 'text', text: 'Error: name is required for delete.' }], isError: true };
        }
        await secrets.removeSecret(userId, name);
        return {
          content: [{ type: 'text', text: `Secret "${name}" deleted.` }],
          summary: `Deleted secret "${name}"`,
        };
      }

      return {
        content: [{ type: 'text', text: 'Error: action must be "list", "read", "write", or "delete".' }],
        isError: true,
      };
    },
  };
}

export { SECRET_HUGGING_FACE };

function envRef(name: string): string {
  if (name === SECRET_HUGGING_FACE) return 'HUGGING_FACE_TOKEN';
  return `SECRET_${name.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`;
}