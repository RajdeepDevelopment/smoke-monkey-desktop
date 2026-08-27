import { Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * AgentConfig — reads project-specific configuration from `.agent/` inside
 * the workspace root.
 *
 * Directory layout:
 *   <project>/
 *     .agent/
 *       config.json      — project metadata (language, test command, etc.)
 *       instructions.md  — project-specific instructions for the LLM
 *       ignore            — files/patterns the agent should skip
 *
 * `.agent/` contains things the user/project intentionally defines.
 * `~/.smoke-agent/workspaces/<id>/index.db` contains generated intelligence.
 */

export interface ProjectConfig {
  /** Detected or declared primary language. */
  language?: string;
  /** Package manager: npm, pnpm, yarn, bun, cargo, etc. */
  packageManager?: string;
  /** Command to run tests. */
  testCommand?: string;
  /** Command to build/lint. */
  buildCommand?: string;
  /** Additional ignore patterns beyond defaults. */
  ignorePatterns?: string[];
  /** Custom metadata. */
  [key: string]: unknown;
}

export interface AgentConfigData {
  config: ProjectConfig;
  instructions: string;
  ignorePatterns: string[];
}

const AGENT_DIR = '.agent';
const CONFIG_FILE = 'config.json';
const INSTRUCTIONS_FILE = 'instructions.md';
const IGNORE_FILE = 'ignore';

export class AgentConfigService {
  private readonly logger = new Logger(AgentConfigService.name);
  private cache = new Map<string, AgentConfigData>();

  /**
   * Load the .agent/ config for a workspace. Returns defaults if .agent/ doesn't exist.
   * Results are cached — call `invalidate()` to refresh.
   */
  async load(workspacePath: string): Promise<AgentConfigData> {
    const cached = this.cache.get(workspacePath);
    if (cached) return cached;

    const agentDir = path.join(workspacePath, AGENT_DIR);
    const result: AgentConfigData = {
      config: {},
      instructions: '',
      ignorePatterns: [],
    };

    try {
      // config.json
      const configPath = path.join(agentDir, CONFIG_FILE);
      const configRaw = await fs.readFile(configPath, 'utf-8').catch((): string | null => null);
      if (configRaw) {
        try {
          result.config = JSON.parse(configRaw);
        } catch {
          this.logger.warn(`Failed to parse ${configPath}`);
        }
      }

      // instructions.md
      const instructionsPath = path.join(agentDir, INSTRUCTIONS_FILE);
      result.instructions = await fs.readFile(instructionsPath, 'utf-8').catch(() => '');

      // ignore
      const ignorePath = path.join(agentDir, IGNORE_FILE);
      const ignoreRaw = await fs.readFile(ignorePath, 'utf-8').catch(() => '');
      if (ignoreRaw) {
        result.ignorePatterns = ignoreRaw
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'));
      }
    } catch {
      // .agent/ directory doesn't exist — that's fine.
    }

    this.cache.set(workspacePath, result);
    return result;
  }

  /**
   * Renders the project config as a system message block for the LLM.
   * Returns null if no config exists.
   */
  async toSystemMessage(workspacePath: string): Promise<string | null> {
    const data = await this.load(workspacePath);
    const parts: string[] = [];

    if (data.instructions.trim()) {
      parts.push(`## Project Instructions\n${data.instructions.trim()}`);
    }

    const configEntries = Object.entries(data.config).filter(([k]) =>
      !['ignorePatterns'].includes(k),
    );
    if (configEntries.length > 0) {
      const lines = configEntries.map(([k, v]) => `- ${k}: ${v}`);
      parts.push(`## Project Config\n${lines.join('\n')}`);
    }

    if (parts.length === 0) return null;
    return `<project-context>\n${parts.join('\n\n')}\n</project-context>`;
  }

  /** Invalidate cached config for a workspace. */
  invalidate(workspacePath?: string): void {
    if (workspacePath) {
      this.cache.delete(workspacePath);
    } else {
      this.cache.clear();
    }
  }
}
