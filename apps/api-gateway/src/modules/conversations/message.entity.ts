import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type MessageRole = 'user' | 'assistant' | 'system';

export interface CitationJson {
  documentId: string;
  documentName: string;
  page: number | null;
  text: string;
  score: number;
  url?: string | null;
}

export interface WebSourceJson {
  title: string;
  url: string;
  content: string;
  provider: string;
  score: number;
}

@Entity('messages')
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'text' })
  conversationId: string;

  @Column()
  role: MessageRole;

  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'simple-json', nullable: true })
  citations: CitationJson[] | null;

  @Column({ type: 'simple-json', nullable: true })
  webSources: WebSourceJson[] | null;

  @Column({ type: 'float', nullable: true })
  confidence: number | null;

  @CreateDateColumn()
  createdAt: Date;
}
