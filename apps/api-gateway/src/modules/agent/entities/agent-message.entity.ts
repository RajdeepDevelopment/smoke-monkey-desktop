import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

@Entity('agent_messages')
export class AgentMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'text' })
  sessionId: string;

  @Column({ type: 'varchar', length: 20 })
  role: MessageRole;

  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'simple-json', nullable: true })
  toolCalls: ToolCallJson[] | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  parentMessageId: string | null;

  @Column({ type: 'int', default: 0 })
  tokensInput: number;

  @Column({ type: 'int', default: 0 })
  tokensOutput: number;

  @CreateDateColumn()
  createdAt: Date;
}

export interface ToolCallJson {
  id: string;
  toolName: string;
  arguments: unknown;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  output?: string;
  result?: unknown;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}
