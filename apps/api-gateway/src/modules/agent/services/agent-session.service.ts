import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentSession, AgentStatus, AgentId } from '../entities/agent-session.entity';
import { AgentMessage } from '../entities/agent-message.entity';
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

  /** Full-text search over a user's chat MESSAGES (not just titles).
   *  Returns matching sessions, newest first, each with highlighted
   *  snippets so the sidebar can show where the topic was discussed. */
  async searchChats(
    userId: string,
    query: string,
  ): Promise<
    Array<{
      sessionId: string;
      title: string;
      agentId: string;
      updatedAt: string;
      matchCount: number;
      snippets: Array<{ content: string; createdAt: string; role: string }>;
    }>
  > {
    const q = (query || '').trim();
    if (!q) return [];
    const sessions = await this.repo.find({
      where: { userId },
      order: { updatedAt: 'DESC' },
      take: 200,
    });
    if (sessions.length === 0) return [];

    const msgs = await this.messages.searchBySessions(
      sessions.map((s) => s.id),
      q,
    );

    const byId = new Map(sessions.map((s) => [s.id, s]));
    const grouped = new Map<string, AgentMessage[]>();
    for (const m of msgs) {
      const arr = grouped.get(m.sessionId) ?? [];
      arr.push(m);
      grouped.set(m.sessionId, arr);
    }

    return [...grouped.entries()]
      .map(([sessionId, list]) => {
        const session = byId.get(sessionId);
        if (!session) return null;
        return {
          sessionId,
          title: session.title,
          agentId: session.agentId,
          updatedAt: session.updatedAt.toISOString(),
          matchCount: list.length,
          snippets: list.slice(0, 3).map((m) => ({
            content: m.content,
            createdAt: m.createdAt.toISOString(),
            role: m.role,
          })),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
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
