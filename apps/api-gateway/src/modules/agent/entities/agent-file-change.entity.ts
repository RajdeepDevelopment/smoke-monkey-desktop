import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('agent_file_changes')
export class AgentFileChange {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'text' })
  runId: string;

  @Column({ type: 'varchar', length: 1000 })
  filePath: string;

  @Column({ type: 'varchar', length: 64 })
  beforeHash: string;

  @Column({ type: 'varchar', length: 64 })
  afterHash: string;

  @Column({ type: 'text' })
  patch: string;

  @Column({ type: 'varchar', length: 20, default: 'edit' })
  operation: 'create' | 'edit' | 'delete' | 'rename';

  @CreateDateColumn()
  createdAt: Date;
}
