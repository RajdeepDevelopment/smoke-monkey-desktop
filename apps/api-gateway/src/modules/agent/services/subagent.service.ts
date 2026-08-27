import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentSession, AgentId } from '../entities/agent-session.entity';
import { AgentMessage } from '../entities/agent-message.entity';
import { ToolRegistry, ToolContext } from '../tools/tool-registry';
import { WorkspaceIndex } from './workspace-index';

interface ExploreResult {
  summary: string;
  files: string[];
  evidence: string[];
  recommendation: string;
  sessionId: string;
  durationMs: number;
  toolCalls: number;
}

/**
 * Explorer — a deterministic, tool-only agent that gathers workspace context.
 *
 * This is NOT an autonomous LLM subagent. It extracts search terms from the
 * task, runs grep/read/list in sequence, and returns structured findings.
 *
 * Future agents (Debugger, Test, Reviewer) will follow the same pattern:
 * return structured findings, not entire conversations.
 */
@Injectable()
export class ExplorerService {
  private readonly logger = new Logger(ExplorerService.name);

  constructor(
    @InjectRepository(AgentSession)
    private readonly sessionRepo: Repository<AgentSession>,
    @InjectRepository(AgentMessage)
    private readonly messageRepo: Repository<AgentMessage>,
    private readonly toolRegistry: ToolRegistry,
    private readonly workspaceIndex: WorkspaceIndex,
  ) {}

  async spawnExplore(
    parentSessionId: string,
    task: string,
    workspacePath: string,
    userId: string,
    abortSignal: AbortSignal,
  ): Promise<ExploreResult> {
    const startTime = Date.now();
    this.logger.log(`Spawning Explore subagent for session ${parentSessionId}: ${task}`);

    const childSession = this.sessionRepo.create({
      userId,
      agentId: 'explore',
      workspacePath,
      title: `Explore: ${task.slice(0, 50)}`,
      status: 'running',
    });
    const saved = await this.sessionRepo.save(childSession);

    const ctx: ToolContext = {
      sessionId: saved.id,
      runId: 'explore-' + Date.now(),
      workspaceDir: workspacePath,
      workspacePath,
      userId,
      abortSignal,
      workspaceIndex: this.workspaceIndex,
    };

    const findings: string[] = [];
    const files: string[] = [];
    const evidence: string[] = [];
    let toolCallCount = 0;

    try {
      const searchTerms = this.extractSearchTerms(task);
      this.logger.log(`Explore searching for: ${searchTerms.join(', ')}`);

      for (const term of searchTerms.slice(0, 5)) {
        if (abortSignal.aborted) break;

        const grepResult = await this.toolRegistry.execute('grep', {
          pattern: term,
          maxResults: 20,
        }, ctx);
        toolCallCount++;

        if (grepResult.success && grepResult.output !== '(no matches)') {
          findings.push(`Search "${term}":\n${grepResult.output.slice(0, 500)}`);
          const fileMatches = grepResult.output.match(/^([^:]+):\d+:/gm);
          if (fileMatches) {
            for (const match of fileMatches) {
              const filePath = match.split(':')[0];
              if (!files.includes(filePath)) files.push(filePath);
            }
          }
        }
      }

      for (const file of files.slice(0, 10)) {
        if (abortSignal.aborted) break;

        const readResult = await this.toolRegistry.execute('read_file', {
          path: file,
          startLine: 1,
          endLine: 50,
        }, ctx);
        toolCallCount++;

        if (readResult.success) {
          evidence.push(`${file}: ${readResult.output.slice(0, 200)}`);
        }
      }

      const structureResult = await this.toolRegistry.execute('list_directory', { path: '.' }, ctx);
      toolCallCount++;
      if (structureResult.success) {
        findings.push(`Project structure:\n${structureResult.output.slice(0, 500)}`);
      }

      const recommendation = this.generateRecommendation(task, findings, files);

      await this.sessionRepo.update(saved.id, { status: 'completed' });

      return {
        summary: findings.join('\n\n'),
        files: [...new Set(files)],
        evidence,
        recommendation,
        sessionId: saved.id,
        durationMs: Date.now() - startTime,
        toolCalls: toolCallCount,
      };
    } catch (err) {
      await this.sessionRepo.update(saved.id, { status: 'failed' });
      this.logger.error(`Explore subagent failed: ${err}`);
      return {
        summary: `Explore failed: ${err instanceof Error ? err.message : err}`,
        files: [],
        evidence: [],
        recommendation: 'Retry with different search terms or manually explore.',
        sessionId: saved.id,
        durationMs: Date.now() - startTime,
        toolCalls: toolCallCount,
      };
    }
  }

  async spawnBuild(
    parentSessionId: string,
    task: string,
    workspacePath: string,
    userId: string,
    abortSignal: AbortSignal,
  ): Promise<ExploreResult> {
    const startTime = Date.now();
    this.logger.log(`Spawning Build subagent for session ${parentSessionId}: ${task}`);

    const childSession = this.sessionRepo.create({
      userId,
      agentId: 'build',
      workspacePath,
      title: `Build: ${task.slice(0, 50)}`,
      status: 'running',
    });
    const saved = await this.sessionRepo.save(childSession);

    const ctx: ToolContext = {
      sessionId: saved.id,
      runId: 'build-' + Date.now(),
      workspaceDir: workspacePath,
      workspacePath,
      userId,
      abortSignal,
      workspaceIndex: this.workspaceIndex,
    };

    const findings: string[] = [];
    const files: string[] = [];
    const evidence: string[] = [];
    let toolCallCount = 0;

    try {
      const listResult = await this.toolRegistry.execute('list_directory', { path: '.' }, ctx);
      toolCallCount++;
      if (listResult.success) {
        findings.push(`Project root:\n${listResult.output.slice(0, 500)}`);
      }

      const statusResult = await this.toolRegistry.execute('git_status', {}, ctx);
      toolCallCount++;
      if (statusResult.success) {
        findings.push(`Git status:\n${statusResult.output}`);
      }

      await this.sessionRepo.update(saved.id, { status: 'completed' });

      return {
        summary: findings.join('\n\n'),
        files: [...new Set(files)],
        evidence,
        recommendation: findings.join('\n'),
        sessionId: saved.id,
        durationMs: Date.now() - startTime,
        toolCalls: toolCallCount,
      };
    } catch (err) {
      await this.sessionRepo.update(saved.id, { status: 'failed' });
      return {
        summary: `Build failed: ${err instanceof Error ? err.message : err}`,
        files: [],
        evidence: [],
        recommendation: 'Retry or check workspace.',
        sessionId: saved.id,
        durationMs: Date.now() - startTime,
        toolCalls: toolCallCount,
      };
    }
  }

  private extractSearchTerms(task: string): string[] {
    const keywords = task
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w.toLowerCase()));

    const terms: string[] = [];

    const camelMatches = task.match(/[a-z][A-Z][a-zA-Z]*/g);
    if (camelMatches) terms.push(...camelMatches.slice(0, 5));

    const snakeMatches = task.match(/[a-z]+_[a-z]+/g);
    if (snakeMatches) terms.push(...snakeMatches.slice(0, 5));

    if (terms.length === 0) {
      terms.push(...keywords.slice(0, 5));
    }

    return [...new Set(terms)];
  }

  private generateRecommendation(task: string, findings: string[], files: string[]): string {
    if (files.length === 0) {
      return `No relevant files found for: ${task}. Try different search terms or broaden the scope.`;
    }

    const fileTypes = new Set(files.map((f) => f.split('.').pop()));
    const mainFiles = files.slice(0, 5);

    let rec = `Based on exploration of ${files.length} files:\n`;
    rec += `- Key files: ${mainFiles.join(', ')}\n`;
    rec += `- File types: ${Array.from(fileTypes).join(', ')}\n`;

    if (findings.length > 0) {
      rec += `- Found ${findings.length} relevant sections\n`;
    }

    return rec;
  }
}

const STOP_WORDS = new Set([
  'the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'but', 'in',
  'with', 'to', 'for', 'of', 'not', 'no', 'can', 'had', 'has', 'have',
  'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did', 'will',
  'would', 'could', 'should', 'may', 'might', 'shall', 'this', 'that',
  'these', 'those', 'it', 'its', 'from', 'by', 'as', 'are', 'what',
  'how', 'when', 'where', 'who', 'why', 'all', 'each', 'every', 'both',
  'few', 'more', 'most', 'other', 'some', 'such', 'than', 'too', 'very',
]);

/** @deprecated Use ExplorerService instead. */
export const SubagentService = ExplorerService;
