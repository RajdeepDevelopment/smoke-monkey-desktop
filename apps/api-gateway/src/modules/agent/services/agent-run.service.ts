import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentRun, RunStatus, AgentState } from '../entities/agent-run.entity';
import { writeRunJson } from './artifact-store';

@Injectable()
export class AgentRunService {
  private readonly logger = new Logger(AgentRunService.name);

  constructor(
    @InjectRepository(AgentRun)
    private readonly repo: Repository<AgentRun>,
  ) {}

  async create(sessionId: string, agentId: string, maxSteps = 100): Promise<AgentRun> {
    const run = this.repo.create({
      sessionId,
      agentId,
      status: 'queued',
      maxSteps,
    });
    return this.repo.save(run);
  }

  async findOne(id: string): Promise<AgentRun | null> {
    return this.repo.findOne({ where: { id } });
  }

  async findBySession(sessionId: string): Promise<AgentRun[]> {
    return this.repo.find({
      where: { sessionId },
      order: { startedAt: 'DESC' },
    });
  }

  async updateStatus(id: string, status: RunStatus): Promise<void> {
    const update: Partial<AgentRun> = { status };
    if (status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted') {
      update.completedAt = new Date();
    }
    await this.repo.update(id, update);
  }

  async incrementStep(id: string): Promise<number> {
    await this.repo
      .createQueryBuilder()
      .update()
      .set({ stepCount: () => '"step_count" + 1' })
      .where('id = :id', { id })
      .execute();
    const run = await this.repo.findOne({ where: { id } });
    return run?.stepCount || 0;
  }

  async updateTokens(id: string, input: number, output: number): Promise<void> {
    await this.repo
      .createQueryBuilder()
      .update()
      .set({
        tokensInput: () => `"tokens_input" + ${input}`,
        tokensOutput: () => `"tokens_output" + ${output}`,
      })
      .where('id = :id', { id })
      .execute();
  }

  async updateDuration(id: string, ms: number): Promise<void> {
    await this.repo.update(id, { durationMs: ms });
  }

  /**
   * Saves the full AgentState to the DB checkpoint column AND to
   * .smoke/runs/<runId>/state.json for disk-based resumability.
   */
  async saveAgentState(id: string, state: AgentState, workspacePath?: string): Promise<void> {
    await this.repo.update(id, { checkpoint: state });
    if (workspacePath) {
      writeRunJson(workspacePath, id, 'state.json', state).catch((err) =>
        this.logger.warn(`Failed to write state.json for run ${id}: ${err}`),
      );
    }
  }

  async saveCheckpoint(id: string, checkpoint: AgentState): Promise<void> {
    return this.saveAgentState(id, checkpoint);
  }

  async getCheckpoint(id: string): Promise<AgentState | null> {
    const run = await this.repo.findOne({ where: { id } });
    return run?.checkpoint || null;
  }

  async findInterrupted(): Promise<AgentRun[]> {
    return this.repo.find({
      where: [
        { status: 'running' as any },
        { status: 'executing_tool' as any },
        { status: 'thinking' as any },
      ],
      order: { startedAt: 'DESC' },
    });
  }
}
