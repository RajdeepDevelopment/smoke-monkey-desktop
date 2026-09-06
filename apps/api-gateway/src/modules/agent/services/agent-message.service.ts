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
      reasoning?: string | null;
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
      reasoning: opts?.reasoning || null,
    });
    return this.repo.save(msg);
  }

  /** Messages for a session in chronological order.
   *  IMPORTANT: when a session has more rows than `limit`, we must return the
   *  MOST RECENT `limit` messages — a chat's newest exchanges are what the UI
   *  needs to render. Ordering ASC + take would return the OLDEST N and silently
   *  drop everything newer (a session with 361 rows would hide its last 161
   *  messages, making "everything I type next" vanish after a refresh). Fetch
   *  DESC (newest first), take `limit`, then reverse back to chronological. */
  async findBySession(sessionId: string, limit = 200): Promise<AgentMessage[]> {
    const rows = await this.repo.find({
      where: { sessionId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
    return rows.reverse();
  }

  /** Cursor-page of messages strictly OLDER than the given cursor, in
   *  chronological (ascending) order. Used for scroll-up ("load earlier")
   *  pagination so long chats are never truncated at a fixed limit.
   *  `hasMore` is true when older rows exist beyond this page. */
  async findBySessionPage(
    sessionId: string,
    opts: { beforeCreatedAt?: string; beforeId?: string; limit?: number },
  ): Promise<{ messages: AgentMessage[]; hasMore: boolean }> {
    const limit = Math.max(1, opts.limit ?? 50);
    const qb = this.repo
      .createQueryBuilder('m')
      .where('m.sessionId = :sessionId', { sessionId })
      .orderBy('m.createdAt', 'DESC')
      .addOrderBy('m.id', 'DESC');
    if (opts.beforeCreatedAt) {
      const c = new Date(opts.beforeCreatedAt);
      qb.andWhere('(m.createdAt < :c OR (m.createdAt = :c AND m.id < :id))', {
        c,
        id: opts.beforeId ?? '',
      });
    }
    const rows = await qb.take(limit + 1).getMany();
    const hasMore = rows.length > limit;
    return { messages: rows.slice(0, limit).reverse(), hasMore };
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

  /** Case-insensitive content search across the given sessions (user +
   *  assistant messages only, newest first). Feeds the sidebar's "chat
   *  content" search — finding which chat discussed a topic. */
  async searchBySessions(
    sessionIds: string[],
    query: string,
    opts?: { limit?: number },
  ): Promise<AgentMessage[]> {
    if (sessionIds.length === 0 || !query || !query.trim()) return [];
    const escaped = query
      .trim()
      .toLowerCase()
      .replace(/[%_]/g, (m) => `\\${m}`);
    return this.repo
      .createQueryBuilder('m')
      .where('m.sessionId IN (:...ids)', { ids: sessionIds })
      .andWhere('m.role IN (:...roles)', { roles: ['user', 'assistant'] })
      .andWhere("LOWER(m.content) LIKE :like ESCAPE '\\'", { like: `%${escaped}%` })
      .orderBy('m.createdAt', 'DESC')
      .take(opts?.limit ?? 400)
      .getMany();
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
