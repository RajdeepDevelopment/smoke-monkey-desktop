import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type AgentStatus = 'idle' | 'running' | 'waiting_permission' | 'waiting_user_input' | 'waiting_mcp_approval' | 'interrupted' | 'completed' | 'failed';
export type AgentId = 'build' | 'plan' | 'explore' | 'general';

@Entity('agent_sessions')
export class AgentSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'text' })
  userId: string;

  @Column({ type: 'varchar', length: 50, default: 'build' })
  agentId: AgentId;

  @Column({ default: 'New session' })
  title: string;

  @Column({ type: 'varchar', length: 30, default: 'idle' })
  status: AgentStatus;

  @Column({ type: 'varchar', length: 255, nullable: true })
  workspacePath: string;

  @Column({ type: 'int', default: 0 })
  messageCount: number;

  @Column({ type: 'int', default: 0 })
  totalTokensInput: number;

  @Column({ type: 'int', default: 0 })
  totalTokensOutput: number;

  @Column({ type: 'float', default: 0 })
  totalCost: number;

  /**
   * Compacted-context snapshot (summary + files + decisions). When present,
   * new runs start from SUMMARY + RECENT instead of replaying full history.
   */
  @Column({ type: 'simple-json', nullable: true })
  contextSnapshot: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
