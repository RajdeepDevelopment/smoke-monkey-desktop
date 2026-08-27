import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type DocumentStatus = 'uploading' | 'processing' | 'ready' | 'failed';

@Entity('documents')
export class DocumentEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'text' })
  userId: string;

  @Column()
  filename: string;

  @Column()
  s3Key: string;

  @Column({ default: 'uploading' })
  status: DocumentStatus;

  @Column({ default: 0 })
  chunkCount: number;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ type: 'simple-json', default: '{}' })
  metadata: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
