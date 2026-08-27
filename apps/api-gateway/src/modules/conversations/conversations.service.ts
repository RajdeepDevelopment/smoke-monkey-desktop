import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Conversation } from './conversation.entity';
import { CitationJson, Message, MessageRole, WebSourceJson } from './message.entity';

@Injectable()
export class ConversationsService {
  constructor(
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    @InjectRepository(Message)
    private readonly messages: Repository<Message>,
  ) {}

  async listForUser(userId: string): Promise<Conversation[]> {
    return this.conversations.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }

  async create(userId: string, title?: string): Promise<Conversation> {
    return this.conversations.save(
      this.conversations.create({
        userId,
        title: title || 'New conversation',
      }),
    );
  }

  async getOwned(userId: string, conversationId: string): Promise<Conversation> {
    const conversation = await this.conversations.findOneBy({
      id: conversationId,
    });
    if (!conversation) throw new NotFoundException('conversation not found');
    if (conversation.userId !== userId) throw new ForbiddenException();
    return conversation;
  }

  async getMessages(userId: string, conversationId: string): Promise<Message[]> {
    await this.getOwned(userId, conversationId);
    return this.messages.find({
      where: { conversationId },
      order: { createdAt: 'ASC' },
    });
  }

  async getHistory(conversationId: string, limit = 10): Promise<Message[]> {
    return this.messages.find({
      where: { conversationId },
      order: { createdAt: 'ASC' },
      take: limit,
    });
  }

  async addMessage(
    conversationId: string,
    role: MessageRole,
    content: string,
    citations?: CitationJson[] | null,
    confidence?: number | null,
    webSources?: WebSourceJson[] | null,
  ): Promise<Message> {
    return this.messages.save(
      this.messages.create({
        conversationId,
        role,
        content,
        citations: citations ?? null,
        confidence: confidence ?? null,
        webSources: webSources ?? null,
      }),
    );
  }

  async remove(userId: string, conversationId: string): Promise<void> {
    const conversation = await this.getOwned(userId, conversationId);
    await this.messages.delete({ conversationId });
    await this.conversations.delete({ id: conversation.id });
  }
}
