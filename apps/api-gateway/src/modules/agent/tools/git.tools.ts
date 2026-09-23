import {
  ToolDefinition,
  ToolResult,
  ToolContext,
} from './tool-registry';
import { execFile } from 'child_process';

/** Run git with an ARGV array — no shell interpolation of model input. */
async function git(cwd: string, args: string[], timeoutMs = 15_000): Promise<string> {
  const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          (err as any).stdout = stdout;
          (err as any).stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
  return result.stdout.trim();
}

function gitError(err: any): ToolResult {
  const detail = String(err.stdout || err.stderr || err.message || 'git failed').trim();
  return { content: [{ type: 'text', text: `Error: git ${detail}` }], isError: true };
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ['rev-parse', '--is-inside-work-tree'], 5_000);
    return true;
  } catch {
    return false;
  }
}

/** Split a free-form argument string into safe argv tokens (whitespace-split;
 * shell metacharacters inside a token are passed verbatim to git, never to a shell). */
function tokenizeArgs(raw: string): string[] {
  return raw.split(/\s+/).filter(Boolean);
}

export function getGitStatusTool(): ToolDefinition {
  return {
    name: 'git_status',
    description:
      'Show working tree status: current branch plus staged, modified, deleted, renamed, and untracked files.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
    },
    execute: async (
      _input: Record<string, unknown>,
      context: ToolContext
    ): Promise<ToolResult> => {
      if (!(await isGitRepo(context.workspaceDir))) {
        return { content: [{ type: 'text', text: 'Error: Not a git repository.' }], isError: true };
      }

      try {
        const status = await git(context.workspaceDir, ['status', '--porcelain=v1', '-b']);
        const lines = status.split('\n');
        const branchLine = lines[0]?.startsWith('##') ? lines.shift() : undefined;

        if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
          return {
            content: [{ type: 'text', text: `${branchLine ? branchLine + '\n' : ''}Working tree clean. No changes.` }],
          };
        }

        const summary: Record<string, string[]> = {
          staged: [],
          modified: [],
          untracked: [],
          deleted: [],
          renamed: [],
        };

        for (const line of lines.filter((l) => l.length > 2)) {
          const indexStatus = line[0];
          const workStatus = line[1];
          const file = line.substring(3);

          // Hide Smoke Monkey's own runtime artifacts (<workspace>/.smoke/...) so
          // the agent never treats generated runs/cache as the user's work.
          const smoke = (p?: string) => !!p && (p === '.smoke' || p.startsWith('.smoke/'));
          if (file.split(' -> ').some(smoke)) continue;

          if ('AMDR'.includes(indexStatus)) {
            if (indexStatus === 'R' || indexStatus === 'D') summary.renamed.push(`  ${line[0]}${line[1]} ${file}`);
            else summary.staged.push(`  ${line[0]}${line[1]} ${file}`);
          } else if (workStatus === 'D') {
            summary.deleted.push(`  ${line[0]}${line[1]} ${file}`);
          } else if (indexStatus === '?' && workStatus === '?') {
            summary.untracked.push(`  ${file}`);
          } else {
            summary.modified.push(`  ${line[0]}${line[1]} ${file}`);
          }
        }

        const parts: string[] = [];
        if (summary.staged.length) parts.push(`Staged (${summary.staged.length}):\n${summary.staged.join('\n')}`);
        if (summary.modified.length) parts.push(`Modified (${summary.modified.length}):\n${summary.modified.join('\n')}`);
        if (summary.renamed.length) parts.push(`Renamed/Deleted-staged (${summary.renamed.length}):\n${summary.renamed.join('\n')}`);
        if (summary.deleted.length) parts.push(`Deleted (${summary.deleted.length}):\n${summary.deleted.join('\n')}`);
        if (summary.untracked.length) parts.push(`Untracked (${summary.untracked.length}):\n${summary.untracked.join('\n')}`);

        return {
          content: [{
            type: 'text',
            text: `Git status${branchLine ? ` — ${branchLine.replace('## ', '')}` : ''} — ${lines.length} changed files:\n\n${parts.join('\n\n')}`,
          }],
        };
      } catch (err: any) {
        return gitError(err);
      }
    },
  };
}

export function getGitDiffTool(): ToolDefinition {
  return {
    name: 'git_diff',
    description:
      'Show file differences. Without args: unstaged changes. --cached: staged changes. --name-only: file list. ' +
      'Accepts optional file path to diff a single file.',
    inputSchema: {
      type: 'object',
      properties: {
        args: {
          type: 'string',
          description: 'Diff arguments (e.g., "--cached", "--name-only", "HEAD~3"). Default: unstaged changes.',
        },
        file: {
          type: 'string',
          description: 'Specific file to diff.',
        },
      },
      required: [],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
    },
    execute: async (
      input: Record<string, unknown>,
      context: ToolContext
    ): Promise<ToolResult> => {
      if (!(await isGitRepo(context.workspaceDir))) {
        return { content: [{ type: 'text', text: 'Error: Not a git repository.' }], isError: true };
      }

      const file = String(input.file || '');
      const argv = ['diff', ...tokenizeArgs(String(input.args || ''))];
      if (file) argv.push('--', file);

      try {
        const result = await git(context.workspaceDir, argv);

        if (!result) {
          return { content: [{ type: 'text', text: 'No differences.' }] };
        }

        const truncated = result.length > 50000
          ? result.substring(0, 50000) + '\n\n[Truncated at 50KB. Use --name-only for an overview, or diff a single file.]'
          : result;

        return { content: [{ type: 'text', text: truncated }] };
      } catch (err: any) {
        return gitError(err);
      }
    },
  };
}

export function getGitLogTool(): ToolDefinition {
  return {
    name: 'git_log',
    description: 'Show recent git commit history. Returns formatted log entries.',
    inputSchema: {
      type: 'object',
      properties: {
        count: {
          type: 'number',
          description: 'Number of recent commits to show. Default: 10.',
          minimum: 1,
          maximum: 50,
        },
        file: {
          type: 'string',
          description: 'Filter log to a specific file.',
        },
      },
      required: [],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
    },
    execute: async (
      input: Record<string, unknown>,
      context: ToolContext
    ): Promise<ToolResult> => {
      if (!(await isGitRepo(context.workspaceDir))) {
        return { content: [{ type: 'text', text: 'Error: Not a git repository.' }], isError: true };
      }

      const count = Math.min(50, Math.max(1, Number(input.count) || 10));
      const file = String(input.file || '');

      try {
        const argv = ['log', '--oneline', '--decorate', '-n', String(count)];
        if (file) argv.push('--', file);
        const log = await git(context.workspaceDir, argv).catch((err) => {
          const detail = String(err?.stdout || err?.stderr || err?.message || '');
          if (/does not have any commits yet|bad revision|unknown revision/i.test(detail)) {
            return 'NO_COMMITS';
          }
          throw err;
        });

        if (log === 'NO_COMMITS' || !log) {
          return { content: [{ type: 'text', text: 'No commits yet — this repository has no history.' }] };
        }

        return { content: [{ type: 'text', text: `Recent ${count} commits:\n\n${log}` }] };
      } catch (err: any) {
        return gitError(err);
      }
    },
  };
}
