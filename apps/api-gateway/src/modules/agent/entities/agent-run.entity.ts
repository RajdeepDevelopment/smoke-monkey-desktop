import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type RunStatus =
  | 'queued'
  | 'thinking'
  | 'executing_tool'
  | 'waiting_permission'
  | 'waiting_user_input'
  | 'waiting_mcp_approval'
  | 'recovering'
  | 'compacting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

@Entity('agent_runs')
export class AgentRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'text' })
  sessionId: string;

  @Column({ type: 'varchar', length: 50, default: 'build' })
  agentId: string;

  @Column({ type: 'varchar', length: 30, default: 'queued' })
  status: RunStatus;

  @Column({ type: 'int', default: 0 })
  stepCount: number;

  @Column({ type: 'int', default: 100 })
  maxSteps: number;

  @Column({ type: 'int', default: 0 })
  tokensInput: number;

  @Column({ type: 'int', default: 0 })
  tokensOutput: number;

  @Column({ type: 'float', default: 0 })
  cost: number;

  @Column({ type: 'int', default: 0 })
  durationMs: number;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ type: 'simple-json', nullable: true })
  checkpoint: AgentState | null;

  @CreateDateColumn()
  startedAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ type: 'text', nullable: true })
  completedAt: Date | null;
}

/**
 * Full agent state snapshot — the source of truth for resumability.
 * Saved to the DB checkpoint column AND to .smoke/runs/<runId>/state.json.
 */
export interface AgentState {
  phase: string;
  task: string;
  plan: TodoItem[];
  currentStep: number;
  currentObjective: string;
  files: {
    read: string[];
    modified: string[];
  };
  facts: string[];
  decisions: string[];
  errors: {
    message: string;
    count: number;
  }[];
  pendingToolCalls: string[];
  verification: {
    testsRun: string[];
    passed: boolean;
  };
  tokenUsage: {
    input: number;
    output: number;
  };
}

export interface TodoItem {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  dependencies: string[];
}
