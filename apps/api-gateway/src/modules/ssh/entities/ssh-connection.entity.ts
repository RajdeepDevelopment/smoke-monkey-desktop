import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type SshAuthMethod = 'key' | 'password' | 'agent';

/**
 * A saved SSH connection profile. Secrets (encrypted private key / password)
 * are stored at-rest via ApiKeyCryptoService(AES-256-GCM). Key auth uses the
 * provided private key; agent auth forwards to the user's local ssh-agent, so
 * no secret is stored in that case.
 */
@Entity('ssh_connections')
export class SshConnection {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'text' })
  userId: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'varchar', length: 255 })
  host: string;

  @Column({ type: 'int', default: 22 })
  port: number;

  @Column({ type: 'varchar', length: 255, default: 'root' })
  username: string;

  @Column({ type: 'varchar', length: 20, default: 'key' })
  authMethod: SshAuthMethod;

  /** AES-256-GCM "iv:tag:data" payload for a key/password secret. */
  @Column({ type: 'text', nullable: true })
  encryptedSecret: string | null;

  /** Fingerprint (e.g. sha256:…) of the stored key, for display only. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  keyFingerprint: string | null;

  /** Remote working directory used for tool/file operations. */
  @Column({ type: 'text', default: '~', nullable: true })
  remoteHome: string | null;

  /** Skip host key verification prompts (still records the host key). */
  @Column({ type: 'boolean', default: false })
  strictHostKey: boolean;

  @Column({ type: 'varchar', length: 128, nullable: true })
  lastError: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
