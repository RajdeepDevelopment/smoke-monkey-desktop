import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('conversations')
export class Conversation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'text' })
  userId: string;

  @Column({ default: 'New conversation' })
  title: string;

  @CreateDateColumn()
  createdAt: Date;
}
