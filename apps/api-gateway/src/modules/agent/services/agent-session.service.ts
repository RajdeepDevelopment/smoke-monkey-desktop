import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentSession, AgentStatus, AgentId } from '../entities/agent-session.entity';
import { AgentMessageService } from './agent-message.service';

@Injectable()
export class AgentSessionService {
  private readonly logger = new Logger(AgentSessionService.name);

  constructor(
    @InjectRepository(AgentSession)
    private readonly repo: Repository<AgentSession>,
    private readonly messages: AgentMessageService,
  ) {}

  async create(userId: string, agentId: AgentId = 'build', workspacePath?: string, title?: string): Promise<AgentSession> {
    const session = this.repo.create({
      userId,
      agentId,
      workspacePath: workspacePath || process.cwd(),
      title: title || 'New session',
      status: 'idle',
    });
    const saved = await this.repo.save(session);
    this.logger.log(`Created session ${saved.id} for user ${userId}`);
    return saved;
  }

  async findOne(id: string): Promise<AgentSession | null> {
    return this.repo.findOne({ where: { id } });
  }

  async findByUser(userId: string): Promise<AgentSession[]> {
    const sessions = await this.repo.find({
      where: { userId },
      order: { updatedAt: 'DESC' },
      take: 50,
    });
    // message_count column was never maintained — derive the real count
    // from stored messages so existing chats show correct numbers.
    try {
      const counts = await this.messages.countBySessions(sessions.map((s) => s.id));
      for (const s of sessions) s.messageCount = counts.get(s.id) ?? 0;
    } catch (err) {
      this.logger.warn(`Failed to compute message counts: ${err}`);
    }
    return sessions;
  }

  async updateStatus(id: string, status: AgentStatus): Promise<void> {
    await this.repo.update(id, { status });
  }

  async saveContextSnapshot(id: string, snapshot: Record<string, unknown>): Promise<void> {
    await this.repo.update(id, { contextSnapshot: snapshot });
  }

  async updateTitle(id: string, title: string): Promise<void> {
    await this.repo.update(id, { title });
  }

  async updateTokens(id: string, input: number, output: number, cost: number): Promise<void> {
    await this.repo
      .createQueryBuilder()
      .update()
      .set({
        totalTokensInput: () => `"total_tokens_input" + ${input}`,
        totalTokensOutput: () => `"total_tokens_output" + ${output}`,
        totalCost: () => `"total_cost" + ${cost}`,
      })
      .where('id = :id', { id })
      .execute();
  }

  async incrementMessages(id: string): Promise<void> {
    await this.repo
      .createQueryBuilder()
      .update()
      .set({ messageCount: () => '"message_count" + 1' })
      .where('id = :id', { id })
      .execute();
  }

  async delete(id: string): Promise<void> {
    await this.repo.delete(id);
  }

  async findInterrupted(userId: string): Promise<AgentSession[]> {
    return this.repo.find({
      where: { userId, status: 'running' as any },
      order: { updatedAt: 'DESC' },
    });
  }
}
