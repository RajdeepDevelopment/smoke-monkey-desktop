import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type PermissionEffect = 'allow' | 'deny' | 'ask';
export type PermissionScope = 'once' | 'session' | 'workspace' | 'global';

@Entity('agent_permissions')
export class AgentPermission {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'text' })
  userId: string;

  @Column({ type: 'varchar', length: 255 })
  tool: string;

  @Column({ type: 'varchar', length: 500, default: '*' })
  resource: string;

  @Column({ type: 'varchar', length: 10 })
  effect: PermissionEffect;

  @Column({ type: 'varchar', length: 20, default: 'workspace' })
  scope: PermissionScope;

  @Column({ type: 'varchar', length: 255, nullable: true })
  workspacePath: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
