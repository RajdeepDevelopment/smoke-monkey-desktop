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

  /** Model reasoning/thinking stream ("Thought phase"), persisted so the
   *  session chat can replay it. Never re-sent to the model on later turns. */
  @Column({ type: 'text', nullable: true })
  reasoning: string | null;

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
  /** Gemini 3.x thinking models: echoed back on the assistant tool_call. */
  thought_signature?: string;
  output?: string;
  result?: unknown;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}
