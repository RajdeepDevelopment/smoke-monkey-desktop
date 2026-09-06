import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  email: string;

  @Column()
  name: string;

  @Column({ select: false })
  passwordHash: string;

  // Per-user feature toggles. In local (SQLite) mode there is no Redis, so these
  // are persisted here (defaults ON — free mode/web search are built-in for
  // desktop). In cloud mode the (ephemeral) equivalents live in Redis.
  @Column({ default: true })
  webSearchEnabled: boolean;

  @Column({ default: true })
  omnirouteEnabled: boolean;

  @Column({ default: false })
  onboardingCompleted: boolean;

  @CreateDateColumn()
  createdAt: Date;
}
