import { ToolDefinition, ToolResult, ToolContext } from './tool-registry';
import { ConnectorRegistry } from '../../ssh/connector.registry';

const DEFAULT_SSH_TIMEOUT_MS = 120_000;
const MAX_SSH_TIMEOUT_MS = 600_000;

/**
 * `ssh_run` — lets the agent execute a one-shot command on a remote host via a
 * saved SSH profile. Goes through the connector registry so dispatch is uniform
 * and future connectors (docker, kubernetes, local pty) slot in the same way.
 *
 * The profile is referenced by id (returned by profile creation / listing). Read
 * profile ids with the ssh tool scaffolding or the SSH panel; pass one explicitly.
 */
export function getSshRunTool(connectors: ConnectorRegistry): ToolDefinition {
  return {
    name: 'ssh_run',
    description:
      'Execute a shell command on a REMOTE host over SSH and return its stdout/stderr. ' +
      'Requires an SSH profile id (see the SSH panel / connectors list) — pass it as `profile`. ' +
      'Each call runs a fresh remote shell: state does not persist between calls. ' +
      'Non-zero remote exits are data (not a tool failure); check the [exit code: N] marker. ' +
      'Auth comes from the saved profile (key / password / agent). Long output keeps the tail.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: {
          type: 'string',
          description: 'SSH connection profile id (uuid). Required.',
        },
        command: {
          type: 'string',
          description: 'Remote shell command string to execute.',
        },
        cwd: {
          type: 'string',
          description: 'Remote working directory. Defaults to the profile remoteHome.',
        },
        timeout: {
          type: 'number',
          description: `Timeout in milliseconds. Default: ${DEFAULT_SSH_TIMEOUT_MS}.`,
          minimum: 1000,
          maximum: MAX_SSH_TIMEOUT_MS,
        },
      },
      required: ['profile', 'command'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    execute: async (
      input: Record<string, unknown>,
      context: ToolContext,
    ): Promise<ToolResult> => {
      const profile = String(input.profile || '');
      const command = String(input.command || '');
      if (!profile || !command.trim()) {
        return { content: [{ type: 'text', text: 'Error: profile and command are required.' }], isError: true };
      }

      const connector = connectors.get('ssh');
      if (!connector) {
        return { content: [{ type: 'text', text: 'Error: SSH connector is not available.' }], isError: true };
      }

      const userId = context.userId || 'public';
      const timeout = Math.min(MAX_SSH_TIMEOUT_MS, Math.max(1000, Number(input.timeout) || DEFAULT_SSH_TIMEOUT_MS));

      try {
        const out = await connector.exec(profile, userId, command, {
          cwd: input.cwd ? String(input.cwd) : undefined,
          timeoutMs: timeout,
          onStream: (header, stdout, stderr) => {
            if (context.eventEmitter && context.toolCallId) {
              let body = header + stdout;
              if (stderr.trim().length > 0) {
                if (body.length > 0 && !body.endsWith('\n')) body += '\n';
                body += `[stderr]\n${stderr}`;
              }
              if (body.trim()) {
                context.eventEmitter!.emitToolOutput(context.sessionId, context.runId, context.toolCallId!, body);
              }
            }
          },
        });

        let body = out.stdout;
        if (out.stderr.trim().length > 0) {
          if (body.length > 0 && !body.endsWith('\n')) body += '\n';
          body += `[stderr]\n${out.stderr}`;
        }
        if (body.trim().length === 0) body = '(no output)';

        const markers: string[] = [];
        if (out.timedOut) markers.push(`[timed out after ${timeout}ms]`);
        else if (out.exitCode !== null && out.exitCode !== 0) markers.push(`[exit code: ${out.exitCode}]`);
        if (markers.length > 0) body += `\n${markers.join('\n')}`;

        return {
          content: [{ type: 'text', text: body }],
          summary:
            out.exitCode === 0
              ? `Remote command succeeded (exit 0)`
              : `Remote command failed (exit ${out.exitCode ?? '?'})`,
          metadata: { exitCode: out.exitCode, timedOut: !!out.timedOut },
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: `SSH error: ${err.message || String(err)}` }],
          isError: true,
          summary: 'SSH error',
        };
      }
    },
  };
}
