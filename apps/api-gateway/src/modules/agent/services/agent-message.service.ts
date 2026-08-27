import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentMessage, ToolCallJson } from '../entities/agent-message.entity';

@Injectable()
export class AgentMessageService {
  private readonly logger = new Logger(AgentMessageService.name);

  constructor(
    @InjectRepository(AgentMessage)
    private readonly repo: Repository<AgentMessage>,
  ) {}

  async create(
    sessionId: string,
    role: AgentMessage['role'],
    content: string,
    opts?: {
      toolCalls?: ToolCallJson[];
      parentMessageId?: string;
      tokensInput?: number;
      tokensOutput?: number;
    },
  ): Promise<AgentMessage> {
    const msg = this.repo.create({
      sessionId,
      role,
      content,
      toolCalls: opts?.toolCalls || null,
      parentMessageId: opts?.parentMessageId || null,
      tokensInput: opts?.tokensInput || 0,
      tokensOutput: opts?.tokensOutput || 0,
    });
    return this.repo.save(msg);
  }

  async findBySession(sessionId: string, limit = 200): Promise<AgentMessage[]> {
    return this.repo.find({
      where: { sessionId },
      order: { createdAt: 'ASC' },
      take: limit,
    });
  }

  /** Actual stored-message counts per session, keyed by sessionId.
   *  Used by the sessions list because the denormalized counter is unreliable. */
  async countBySessions(sessionIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (sessionIds.length === 0) return counts;
    const rows = await this.repo
      .createQueryBuilder('m')
      .select('m.sessionId', 'sessionId')
      .addSelect('COUNT(*)', 'count')
      .where('m.sessionId IN (:...ids)', { ids: sessionIds })
      .groupBy('m.sessionId')
      .getRawMany<{ sessionId: string; count: string }>();
    for (const r of rows) counts.set(r.sessionId, parseInt(r.count, 10) || 0);
    return counts;
  }

  async findOne(id: string): Promise<AgentMessage | null> {
    return this.repo.findOne({ where: { id } });
  }

  async updateToolCalls(id: string, toolCalls: ToolCallJson[]): Promise<void> {
    await this.repo.update(id, { toolCalls });
  }

  async appendContent(id: string, delta: string): Promise<void> {
    await this.repo
      .createQueryBuilder()
      .update()
      .set({ content: () => `content || ${"' || '"}'${delta.replace(/'/g, "''")}'` })
      .where('id = :id', { id })
      .execute();
  }

  async deleteBySession(sessionId: string): Promise<void> {
    await this.repo.delete({ sessionId });
  }

  async getRecentContext(sessionId: string, maxMessages = 50): Promise<AgentMessage[]> {
    const messages = await this.repo.find({
      where: { sessionId },
      order: { createdAt: 'DESC' },
      take: maxMessages,
    });
    return messages.reverse();
  }

  async countBySession(sessionId: string): Promise<number> {
    return this.repo.count({ where: { sessionId } });
  }
}
